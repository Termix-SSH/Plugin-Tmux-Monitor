import type { Request, Response, Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { parseSessions } from "./monitor-helpers.js";
import {
  LIST_SESSIONS,
  runTmuxList,
  tmuxAvailable,
  withHostConnection,
} from "./routes.js";

const CACHE_MS = 60_000;
const SUMMARY_CONCURRENCY = 4;

export interface HostSummary {
  hostId: number;
  checkedAt: string;
  available: boolean;
  sessions: number;
  attached: number;
  error?: string;
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

export interface SummaryCache {
  check: (hostId: number, refresh?: boolean) => Promise<HostSummary>;
}

/** Session counts per host, cached for a minute. */
export function createSummaryCache(ctx: PluginContext): SummaryCache {
  const cache = new Map<string, HostSummary>();
  const key = (hostId: number) => `${ctx.currentActor() ?? ""}:${hostId}`;

  return {
    check: async (hostId, refresh = false) => {
      const cached = cache.get(key(hostId));
      if (
        !refresh &&
        cached &&
        Date.now() - Date.parse(cached.checkedAt) < CACHE_MS
      ) {
        return cached;
      }
      const checkedAt = new Date().toISOString();
      let fresh: HostSummary;
      try {
        const host = await ctx.hosts.get(hostId);
        if (!host) throw new Error("Host not found");
        const sessions = await withHostConnection(ctx, host, async (conn) =>
          (await tmuxAvailable(conn))
            ? parseSessions(await runTmuxList(conn, LIST_SESSIONS)).filter(
                (s) => !s.isView,
              )
            : null,
        );
        fresh = {
          hostId,
          checkedAt,
          available: sessions !== null,
          sessions: sessions?.length ?? 0,
          attached: sessions?.filter((s) => s.attachedClients > 0).length ?? 0,
        };
      } catch (error) {
        fresh = {
          hostId,
          checkedAt,
          available: false,
          sessions: 0,
          attached: 0,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      cache.set(key(hostId), fresh);
      return fresh;
    },
  };
}

export function registerSummary(
  router: Router,
  ctx: PluginContext,
  summary: SummaryCache,
): void {
  router.use("/summary", ctx.rbac.require("use") as never);

  /**
   * @openapi
   * /plugin-api/tmux-monitor/summary:
   *   get:
   *     summary: Tmux session counts on every host
   *     description: One entry per host with Tmux Monitor turned on, checked as the caller and cached for a minute unless refresh=1.
   *     tags:
   *       - Tmux Monitor
   *     parameters:
   *       - in: query
   *         name: refresh
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: One entry per host.
   */
  router.get("/summary", async (req: Request, res: Response) => {
    try {
      const refresh = req.query.refresh === "1";
      const enabled: number[] = [];
      for (const host of await ctx.hosts.list()) {
        if (await ctx.settings.getHost<boolean>(host.id, "enableTmuxMonitor")) {
          enabled.push(host.id);
        }
      }
      res.json(
        await mapLimit(enabled, SUMMARY_CONCURRENCY, (hostId) =>
          summary.check(hostId, refresh),
        ),
      );
    } catch (error) {
      ctx.log.error(
        "Failed to build the tmux summary",
        error instanceof Error ? error : undefined,
      );
      res.status(500).json({ error: "Failed to build the tmux summary" });
    }
  });
}
