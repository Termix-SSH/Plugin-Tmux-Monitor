import { useEffect, useState } from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import type { PluginHostRecord } from "@termix-ssh/plugin-sdk/frontend";
import { createTmuxView, releaseTmuxView } from "./api";
import { PanePreview } from "./PanePreview";
import { tmuxPersistentSelection } from "./host-tmux-monitor";
import type { SplitView } from "./split-layout";

/** An extra viewer. A whole session attaches directly; a window or pane gets
 * its own grouped session first so it does not move anyone else's view. */
export function SplitViewer({
  host,
  view,
  isVisible,
  onClose,
}: {
  host: PluginHostRecord;
  view: SplitView;
  isVisible: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const pinned = view.windowIndex !== undefined;
  const [attachName, setAttachName] = useState<string | null>(
    pinned ? null : view.sessionName,
  );
  const [failed, setFailed] = useState(false);
  // Bumped on reattach: the old helper session may already be gone.
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (view.windowIndex === undefined) return;
    let cancelled = false;
    let created: string | null = null;
    setAttachName(null);
    setFailed(false);
    createTmuxView(
      Number(host.id),
      view.sessionName,
      view.windowIndex,
      view.paneId,
    )
      .then((name) => {
        created = name;
        if (cancelled)
          void releaseTmuxView(Number(host.id), name).catch(() => {});
        else setAttachName(name);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      // Closed or replaced: free the helper session. The server only removes
      // it if nobody is attached; an attached one ends with its client.
      if (created)
        void releaseTmuxView(Number(host.id), created).catch(() => {});
    };
  }, [host.id, view.sessionName, view.windowIndex, view.paneId, generation]);

  const label = pinned
    ? `${view.sessionName}:${view.windowIndex}${view.paneId ? ` ${view.paneId}` : ""}`
    : view.sessionName;

  if (!attachName) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
        <span>{failed ? t("tmuxMonitor.splitViewFailed") : label}</span>
        {failed && (
          <button onClick={onClose}>{t("tmuxMonitor.splitViewClose")}</button>
        )}
      </div>
    );
  }
  return (
    <PanePreview
      key={attachName}
      host={host}
      keepsSelection={tmuxPersistentSelection(host)}
      label={label}
      pane={{ paneId: "", sessionName: attachName, windowIndex: 0 }}
      isVisible={isVisible}
      onClose={onClose}
      onReattach={pinned ? () => setGeneration((n) => n + 1) : undefined}
    />
  );
}
