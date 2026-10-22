import { useCallback, useEffect, useState } from "react";
import {
  AppWindow,
  ExternalLink,
  Plus,
  RefreshCw,
  SquareTerminal,
} from "lucide-react";
import {
  invokeAction,
  useSettings,
  useTabs,
  useToast,
  useTranslation,
  type CompanionDefaults,
  type CompanionProps,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  ListBadge,
  ListRow,
  ListRowAction,
  PanelList,
} from "@termix-ssh/plugin-sdk/ui";
import {
  createTmuxSession,
  focusTmuxPane,
  getTmuxOverview,
  type TmuxOverview,
} from "./api";
import { formatRelativeTime } from "./format";

const POLL_MS = 5000;

/** Starting state of the panel, from the user's settings. */
export function useTmuxCompanionDefaults(): CompanionDefaults {
  const { values } = useSettings("user");
  const side = values.companionSide;
  return {
    open: values.companionAutoOpen === true,
    side: side === "left" || side === "bottom" ? side : "right",
    size: typeof values.companionSize === "number" ? values.companionSize : 300,
    edgeButton: values.companionEdgeButton !== false,
  };
}

/** Single quotes a name for the remote shell. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Switches to the session when the terminal is already in tmux, else attaches. */
export function attachCommand(session: string): string {
  const name = shellQuote(session);
  return `tmux switch-client -t ${name} 2>/dev/null || tmux attach -t ${name}\r`;
}

/** This host's tmux sessions beside its terminal. */
export function TmuxCompanion({ host, getHandle, isVisible }: CompanionProps) {
  const { t } = useTranslation();
  const tabs = useTabs();
  const toast = useToast();
  const hostId = host ? Number(host.id) : 0;
  const [overview, setOverview] = useState<TmuxOverview | null>(null);
  const [failed, setFailed] = useState("");
  const [open, setOpen] = useState<Set<string>>(() => new Set());

  const load = useCallback(async () => {
    if (!hostId) return;
    try {
      setOverview(await getTmuxOverview(hostId));
      setFailed("");
    } catch {
      setFailed(t("tmuxMonitor.failedToLoad"));
    }
  }, [hostId, t]);

  useEffect(() => {
    if (!isVisible) return;
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [isVisible, load]);

  const send = (text: string) => {
    const handle = getHandle() as { sendInput?: (data: string) => void } | null;
    if (!handle?.sendInput) {
      toast.error(t("tmuxMonitor.attachFailed"));
      return;
    }
    handle.sendInput(text);
  };

  const openInNewTab = (session: string) => {
    if (!host) return;
    void invokeAction("terminal.open", host, {
      tmuxSession: session,
      label: session,
    }).catch(() => toast.error(t("tmuxMonitor.attachFailed")));
  };

  const focusWindow = (paneId: string | undefined) => {
    if (!paneId) return;
    void focusTmuxPane(hostId, paneId)
      .then(() => load())
      .catch(() => toast.error(t("tmuxMonitor.refreshFailed")));
  };

  const newSession = async () => {
    const name = `termix-${Date.now().toString(36)}`;
    try {
      await createTmuxSession(hostId, name);
      toast.success(t("tmuxMonitor.sessionCreated"));
      send(attachCommand(name));
      await load();
    } catch {
      toast.error(t("tmuxMonitor.sessionCreateFailed"));
    }
  };

  const toggle = (name: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const sessions = overview?.sessions ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 p-1.5">
      <div className="flex items-center gap-1">
        <span className="flex-1 truncate px-1 text-xs text-muted-foreground">
          {t("companion.sessions", { count: sessions.length })}
        </span>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => void newSession()}
          title={t("tmuxMonitor.newSession")}
          disabled={!overview?.available}
        >
          <Plus className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => void load()}
          title={t("tmuxMonitor.refresh")}
          className="text-accent-brand"
        >
          <RefreshCw className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={() =>
            tabs.openSingletonTab("tmux_monitor", {
              data: { hostId, hostRequest: Date.now() },
            })
          }
          title={t("companion.openTab")}
        >
          <ExternalLink className="size-4" />
        </Button>
      </div>
      {failed ? (
        <p className="p-2 text-xs text-destructive">{failed}</p>
      ) : !overview ? (
        <p className="p-2 text-xs text-muted-foreground">
          {t("companion.loading")}
        </p>
      ) : !overview.available ? (
        <p className="p-2 text-xs text-muted-foreground">
          {t("tmuxMonitor.tmuxUnavailable")}
        </p>
      ) : (
        <PanelList
          empty={
            <p className="p-2 text-xs text-muted-foreground">
              {t("tmuxMonitor.noSessions")}
            </p>
          }
        >
          {sessions.map((session, index) => (
            <ListRow
              key={session.name}
              stripe={index}
              tone={session.attachedClients > 0 ? "success" : "muted"}
              title={<span className="font-mono text-xs">{session.name}</span>}
              badges={
                session.attachedClients > 0 ? (
                  <ListBadge tone="success">
                    {t("tmuxMonitor.attached")}
                  </ListBadge>
                ) : undefined
              }
              meta={formatRelativeTime(session.lastActivity, Date.now(), t)}
              onClick={() => toggle(session.name)}
              actions={
                <>
                  <ListRowAction
                    label={t("tmuxMonitor.attach")}
                    tone="brand"
                    onClick={() => send(attachCommand(session.name))}
                  >
                    <SquareTerminal />
                  </ListRowAction>
                  <ListRowAction
                    label={t("tmuxMonitor.attachNewTab")}
                    onClick={() => openInNewTab(session.name)}
                  >
                    <ExternalLink />
                  </ListRowAction>
                </>
              }
            >
              {open.has(session.name) && (
                <div className="mt-1 flex flex-col">
                  {session.windows.map((window) => {
                    const pane =
                      window.panes.find((p) => p.active) ?? window.panes[0];
                    return (
                      <button
                        key={window.index}
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          focusWindow(pane?.id);
                        }}
                        className={`flex items-center gap-1.5 px-1 py-0.5 text-left text-xs hover:bg-muted ${
                          window.active
                            ? "text-foreground"
                            : "text-muted-foreground"
                        }`}
                      >
                        <AppWindow className="size-3 shrink-0" />
                        <span className="truncate">
                          {window.index}: {window.name}
                        </span>
                        {pane?.command && (
                          <span className="ml-auto truncate font-mono text-[10px] text-muted-foreground">
                            {pane.command}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </ListRow>
          ))}
        </PanelList>
      )}
    </div>
  );
}
