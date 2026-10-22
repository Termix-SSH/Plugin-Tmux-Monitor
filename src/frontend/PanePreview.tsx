// Interactive view of a tmux pane. Embeds the real SSH terminal (through the
// terminal.view component ssh-terminal registers) and attaches to the
// selected session via the native tmux_attach flow, so the pane is fully
// usable: typing, mouse scrolling and tmux copy-mode all behave exactly like
// a normal terminal tab.

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  Activity,
  Cpu,
  MemoryStick,
  RotateCw,
  SquareSplitHorizontal,
  SquareSplitVertical,
  Trash2,
  X,
} from "lucide-react";
import { PluginComponent } from "@termix-ssh/plugin-sdk/ui";
import type {
  PluginHostRecord,
  TabHandle,
} from "@termix-ssh/plugin-sdk/frontend";
import type { TmuxPaneMetrics } from "./api";
import { formatMem } from "./format";
import type { SelectedPane } from "./types";

interface PanePreviewProps {
  host: PluginHostRecord;
  pane: SelectedPane;
  /** Header text when it should differ from the (view) session name. */
  label?: string;
  metrics?: TmuxPaneMetrics;
  /** Imperative handle of the embedded terminal, used by the parent to nudge
   * a refit/redraw after layout-changing tmux actions. */
  terminalRef?: React.RefObject<TabHandle | null>;
  /** Split the window containing this pane ("h" = new pane to the right,
   * "v" = below, tmux -h/-v semantics). */
  onSplit?: (direction: "h" | "v") => void;
  /** Ask for confirmation and kill this pane. */
  onKillPane?: () => void;
  onClose: () => void;
  /** Called when the user reattaches. A parent that owns a temporary session
   * recreates it here, since the old one may be gone. */
  onReattach?: () => void;
  /** A kept tmux selection can exist here. Right-clicking it must reach tmux
   * (which clears it) instead of the terminal's right-click paste. */
  keepsSelection?: boolean;
  /** False while the monitor tab is hidden. */
  isVisible?: boolean;
}

function newInstanceId(): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function PanePreview({
  host,
  pane,
  label,
  metrics,
  terminalRef,
  onSplit,
  onKillPane,
  onClose,
  onReattach,
  keepsSelection = false,
  isVisible = true,
}: PanePreviewProps) {
  const { t } = useTranslation();
  // One PTY per mount; the parent remounts this component (via key) when the
  // host or session changes. Pane switches within a session go through the
  // focus endpoint instead, so the connection is reused.
  const instanceIdRef = useRef<string>(newInstanceId());
  // Bumping this remounts the embedded terminal with a fresh PTY, the rescue
  // hatch when the attached client's rendering gets out of sync.
  const [attachNonce, setAttachNonce] = useState(0);

  function reattach() {
    if (onReattach) return onReattach();
    instanceIdRef.current = newInstanceId();
    setAttachNonce((n) => n + 1);
  }

  // The host's own authType travels in the spread, so a Tailscale host still
  // gets the Tailscale-aware PTY path. The SSH port may be non-standard.
  const resolvedPort = host.sshPort ?? host.port;
  // Stable between renders so a poll re-render cannot make the embedded
  // terminal think its connection settings changed.
  const terminalHostConfig = useMemo(
    () => ({
      ...host,
      port: resolvedPort,
      sshPort: resolvedPort,
      instanceId: instanceIdRef.current,
    }),
    // attachNonce changes together with instanceIdRef
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [host, resolvedPort, attachNonce],
  );

  const terminalWrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = terminalWrapRef.current;
    if (!el || !keepsSelection) return;
    // With tmux owning the mouse, xterm never has a selection, so the
    // terminal's own right-click handler would always paste. Swallow the
    // browser context menu here instead: tmux still gets the mouse event and
    // clears its kept selection. Ctrl+right-click stays with the terminal.
    const onContext = (e: MouseEvent) => {
      if (e.ctrlKey) return;
      e.preventDefault();
      e.stopPropagation();
    };
    el.addEventListener("contextmenu", onContext, true);
    return () => {
      el.removeEventListener("contextmenu", onContext, true);
    };
  }, [keepsSelection]);

  return (
    <>
      <div className="flex items-center gap-3 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
        <span className="flex gap-2 font-medium text-foreground">
          <span>{label ?? pane.sessionName}</span>
          {pane.paneId && (
            <span className="text-muted-foreground">{pane.paneId}</span>
          )}
        </span>
        {metrics && (
          <>
            <span className="flex items-center gap-1">
              <Cpu className="size-3" />
              {metrics.cpuPercent.toFixed(1)}%
            </span>
            <span className="flex items-center gap-1">
              <MemoryStick className="size-3" />
              {formatMem(metrics.memRssKb)}
            </span>
            {metrics.gpuMemMb > 0 && (
              <span className="flex items-center gap-1">
                <Activity className="size-3" />
                {metrics.gpuMemMb} MB GPU
              </span>
            )}
            {metrics.topCommand && (
              <span className="truncate">
                {metrics.topCommand} ({metrics.processCount})
              </span>
            )}
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          {onSplit && (
            <>
              <button
                className="text-muted-foreground hover:text-foreground"
                title={t("tmuxMonitor.splitRight")}
                aria-label={t("tmuxMonitor.splitRight")}
                onClick={() => onSplit("h")}
              >
                <SquareSplitHorizontal className="size-3.5" />
              </button>
              <button
                className="text-muted-foreground hover:text-foreground"
                title={t("tmuxMonitor.splitDown")}
                aria-label={t("tmuxMonitor.splitDown")}
                onClick={() => onSplit("v")}
              >
                <SquareSplitVertical className="size-3.5" />
              </button>
            </>
          )}
          {onKillPane && (
            <button
              className="text-muted-foreground hover:text-destructive"
              title={t("tmuxMonitor.killPane")}
              aria-label={t("tmuxMonitor.killPane")}
              onClick={onKillPane}
            >
              <Trash2 className="size-3.5" />
            </button>
          )}
          {(onSplit || onKillPane) && (
            <div className="h-3.5 border-l border-border" />
          )}
          <button
            className="text-muted-foreground hover:text-foreground"
            title={t("tmuxMonitor.reattach")}
            aria-label={t("tmuxMonitor.reattach")}
            onClick={reattach}
          >
            <RotateCw className="size-3.5" />
          </button>
          <button
            className="text-muted-foreground hover:text-foreground"
            title={t("tmuxMonitor.closePreview")}
            aria-label={t("tmuxMonitor.closePreview")}
            onClick={onClose}
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>
      <div ref={terminalWrapRef} className="min-h-0 flex-1 overflow-hidden">
        <PluginComponent
          id="terminal.view"
          key={attachNonce}
          handleRef={terminalRef}
          hostConfig={terminalHostConfig}
          isVisible={isVisible}
          title={pane.sessionName}
          showTitle={false}
          splitScreen={false}
          tmuxAttachSession={pane.sessionName}
          onClose={onClose}
        />
      </div>
    </>
  );
}
