import type {
  PluginContext,
  PluginOperationContext,
} from "@termix-ssh/plugin-sdk/backend";
import { parseSessions } from "./monitor-helpers.js";
import {
  killSessionAndViews,
  LIST_SESSIONS,
  runTmuxList,
  tmuxAvailable,
  withHostConnection,
} from "./routes.js";
import type { SummaryCache } from "./summary.js";

async function hostOf(ctx: PluginContext, context: PluginOperationContext) {
  if (context.hostId === undefined) throw new Error("This needs a host");
  const host = await ctx.hosts.get(context.hostId);
  if (!host) throw new Error("Host not found");
  return host;
}

/** Everything Tmux Monitor offers to the rest of Termix. */
export function registerOperations(
  ctx: PluginContext,
  forgetTags: (hostId: number, session: string) => Promise<unknown>,
  summary: SummaryCache,
): void {
  if (typeof ctx.operations?.register !== "function") return;

  ctx.operations.register("tmux-monitor.list-sessions", {
    run: async (_input, context) => {
      const host = await hostOf(ctx, context);
      const sessions = await withHostConnection(ctx, host, async (conn) =>
        (await tmuxAvailable(conn))
          ? parseSessions(await runTmuxList(conn, LIST_SESSIONS))
          : [],
      );
      const rows = sessions
        .filter((session) => !session.isView)
        .map((session) => ({
          name: session.name,
          state: session.attachedClients > 0 ? "attached" : "detached",
          clients: session.attachedClients,
          lastActivity: new Date(session.lastActivity * 1000).toISOString(),
        }));
      return { summary: `${rows.length} sessions`, data: { rows } };
    },
  });

  ctx.operations.register("tmux-monitor.session-count", {
    run: async (_input, context) => {
      if (context.hostId === undefined) throw new Error("This needs a host");
      const result = await summary.check(context.hostId);
      if (result.error) throw new Error(result.error);
      return {
        summary: `${result.sessions} sessions`,
        data: {
          value: result.sessions,
          label: result.available ? `${result.attached} attached` : "No tmux",
        },
      };
    },
  });

  ctx.operations.register("tmux-monitor.kill-session", {
    describe: (_input, context) =>
      `Would end the tmux session ${context.resourceKey}`,
    run: async (_input, context) => {
      const name = String(context.resourceKey ?? "").trim();
      if (!name || /[:.\n]/.test(name)) throw new Error("Invalid session name");
      const host = await hostOf(ctx, context);
      await withHostConnection(ctx, host, (conn) =>
        killSessionAndViews(conn, name),
      );
      await forgetTags(host.id, name);
      return { summary: `Ended ${name}`, changed: true };
    },
  });
}
