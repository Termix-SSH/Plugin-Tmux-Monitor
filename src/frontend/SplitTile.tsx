import { useState, type DragEvent, type ReactNode } from "react";
import { SESSION_DRAG_TYPE, type SplitDirection } from "./split-layout";

/** One viewer cell. While a session is being dragged it shows an overlay
 * (the terminal surface would swallow drag events) with a right/bottom drop
 * hint; dropping splits this cell in that direction. */
export function SplitTile({
  dragging,
  onDropSession,
  children,
}: {
  dragging: boolean;
  onDropSession: (raw: string, direction: SplitDirection) => void;
  children: ReactNode;
}) {
  const [zone, setZone] = useState<SplitDirection | null>(null);

  function zoneAt(e: DragEvent<HTMLDivElement>): SplitDirection {
    const rect = e.currentTarget.getBoundingClientRect();
    const dx = (e.clientX - rect.left) / (rect.width || 1) - 0.5;
    const dy = (e.clientY - rect.top) / (rect.height || 1) - 0.5;
    return dx >= dy ? "right" : "down";
  }

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      {children}
      {dragging && (
        <div
          className="absolute inset-0 z-20"
          data-testid="split-drop-overlay"
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(SESSION_DRAG_TYPE)) return;
            e.preventDefault();
            setZone(zoneAt(e));
          }}
          onDragLeave={() => setZone(null)}
          onDrop={(e) => {
            e.preventDefault();
            const direction = zoneAt(e);
            setZone(null);
            onDropSession(e.dataTransfer.getData(SESSION_DRAG_TYPE), direction);
          }}
        >
          {zone && (
            <div
              className={`pointer-events-none absolute border-2 border-accent-brand bg-accent-brand/20 ${zone === "right" ? "right-0 top-0 h-full w-1/2" : "bottom-0 left-0 h-1/2 w-full"}`}
            />
          )}
        </div>
      )}
    </div>
  );
}
