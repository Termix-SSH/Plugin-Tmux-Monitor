import { useCallback, useEffect, useState } from "react";
import { Layers, RefreshCw } from "lucide-react";
import {
  useHosts,
  usePermission,
  usePluginApi,
  useTranslation,
  type DashboardCardProps,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  ListBadge,
  ListRow,
  PanelList,
  LoadingState,
} from "@termix-ssh/plugin-sdk/ui";

interface HostSummary {
  hostId: number;
  available: boolean;
  sessions: number;
  attached: number;
  error?: string;
}

const POLL_MS = 5 * 60_000;

/** Dashboard card: tmux session counts on each host with Tmux Monitor on. */
export function TmuxHostsCard({ isVisible, shell }: DashboardCardProps) {
  const { t } = useTranslation();
  const allowed = usePermission("use");
  const api = usePluginApi();
  const { hosts } = useHosts();
  const [rows, setRows] = useState<HostSummary[] | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (refresh = false) => {
      setLoading(true);
      try {
        const { data } = await api.get<HostSummary[]>("/summary", {
          params: refresh ? { refresh: "1" } : undefined,
        });
        setRows(data);
      } catch {
        setRows([]);
      } finally {
        setLoading(false);
      }
    },
    [api],
  );

  useEffect(() => {
    if (!isVisible || !allowed) return;
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [isVisible, allowed, load]);

  if (!allowed) return null;
  if (!rows) {
    return <LoadingState compact label={t("card.loading")} />;
  }

  const sorted = [...rows].sort(
    (a, b) => Number(!!b.error) - Number(!!a.error) || b.sessions - a.sessions,
  );
  const total = rows.reduce((sum, row) => sum + row.sessions, 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 px-3 pt-1">
        <span className="flex-1 text-xs text-muted-foreground">
          {t("card.summary", { count: total, hosts: rows.length })}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          disabled={loading}
          onClick={() => void load(true)}
          title={t("card.refresh")}
        >
          <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>
      <PanelList
        empty={
          <p className="p-3 text-xs text-muted-foreground">{t("card.empty")}</p>
        }
      >
        {sorted.map((row, index) => {
          const host = hosts.find((h) => Number(h.id) === row.hostId);
          return (
            <ListRow
              key={row.hostId}
              stripe={index}
              tone={
                row.error ? "destructive" : row.available ? "success" : "brand"
              }
              icon={<Layers className="size-3.5" />}
              title={host?.name || host?.ip || `#${row.hostId}`}
              badges={
                !row.available && !row.error ? (
                  <ListBadge>{t("card.missing")}</ListBadge>
                ) : undefined
              }
              meta={
                row.error ??
                t("card.sessions", {
                  count: row.sessions,
                  attached: row.attached,
                })
              }
              onClick={() =>
                shell.openSingletonTab("tmux_monitor", {
                  data: { hostId: row.hostId, hostRequest: Date.now() },
                })
              }
            />
          );
        })}
      </PanelList>
    </div>
  );
}
