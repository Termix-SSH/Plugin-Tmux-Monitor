// Layout of the extra terminal viewers shown beside the main preview.
// The main preview (PRIMARY) always sits at the top of the MAIN column.
// "Split right" opens a new column after the target's column; "split down"
// stacks a viewer under the target. Each viewer is bound to its own host.

export const MAIN = "main";
export const PRIMARY = "primary";
export const MAX_VIEWERS = 4; // main preview + extras, one SSH terminal each
export const SESSION_DRAG_TYPE = "application/x-tmux-monitor-session";

export type SplitDirection = "right" | "down";

export interface SplitView {
  id: string;
  hostId: string | number;
  sessionName: string;
  /** Set when the viewer shows one window (and optionally pane) of the session. */
  windowIndex?: number;
  paneId?: string;
  column: string;
}

export interface SplitLayout {
  columns: string[];
  views: SplitView[];
}

export interface SessionRef {
  hostId: string | number;
  sessionName: string;
  windowIndex?: number;
  paneId?: string;
}

export const EMPTY_LAYOUT: SplitLayout = { columns: [MAIN], views: [] };

export function newViewId(): string {
  return typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

const same = (a: SessionRef, b: SessionRef) =>
  String(a.hostId) === String(b.hostId) &&
  a.sessionName === b.sessionName &&
  a.windowIndex === b.windowIndex &&
  a.paneId === b.paneId;

/** Keeps only well-formed optional window/pane fields. */
function viewTarget(v: { windowIndex?: unknown; paneId?: unknown }) {
  if (
    typeof v.windowIndex !== "number" ||
    !Number.isInteger(v.windowIndex) ||
    v.windowIndex < 0
  )
    return {};
  return {
    windowIndex: v.windowIndex,
    ...(typeof v.paneId === "string" && /^%\d+$/.test(v.paneId)
      ? { paneId: v.paneId }
      : {}),
  };
}

/**
 * Adds a viewer next to `target` (a view id or PRIMARY). `primary` is the
 * session the main preview shows, or null when it is closed.
 */
export function addSplit(
  layout: SplitLayout,
  target: string,
  direction: SplitDirection,
  session: SessionRef,
  id: string,
  primary: SessionRef | null,
): { layout: SplitLayout } | { error: "duplicate" | "full" } {
  if (
    (primary && same(primary, session)) ||
    layout.views.some((view) => same(view, session))
  )
    return { error: "duplicate" };
  if (layout.views.length + (primary ? 1 : 0) >= MAX_VIEWERS)
    return { error: "full" };

  const targetIndex = layout.views.findIndex((view) => view.id === target);
  const targetColumn =
    targetIndex >= 0 ? layout.views[targetIndex]!.column : MAIN;

  if (direction === "right") {
    const column = `col-${id}`;
    const columns = [...layout.columns];
    columns.splice(columns.indexOf(targetColumn) + 1, 0, column);
    return {
      layout: { columns, views: [...layout.views, { id, ...session, column }] },
    };
  }

  // Down: directly under the target. Under PRIMARY that is the top of the
  // main column's extras.
  const views = [...layout.views];
  let at = targetIndex + 1;
  if (targetIndex < 0) {
    const first = views.findIndex((view) => view.column === MAIN);
    at = first < 0 ? views.length : first;
  }
  views.splice(at, 0, { id, ...session, column: targetColumn });
  return { layout: { columns: layout.columns, views } };
}

function compact(layout: SplitLayout): SplitLayout {
  const used = new Set(layout.views.map((view) => view.column));
  return {
    columns: layout.columns.filter((c) => c === MAIN || used.has(c)),
    views: layout.views,
  };
}

export function removeSplit(layout: SplitLayout, id: string): SplitLayout {
  if (!layout.views.some((view) => view.id === id)) return layout;
  return compact({
    columns: layout.columns,
    views: layout.views.filter((view) => view.id !== id),
  });
}

/** Drops viewers whose host is gone; returns the same object if none were. */
export function pruneLayout(
  layout: SplitLayout,
  hostExists: (hostId: string | number) => boolean,
): SplitLayout {
  const views = layout.views.filter((view) => hostExists(view.hostId));
  return views.length === layout.views.length
    ? layout
    : compact({ columns: layout.columns, views });
}

/** Validates stored layout JSON; anything malformed becomes an empty layout. */
export function parseLayout(value: unknown): SplitLayout {
  if (!value || typeof value !== "object") return EMPTY_LAYOUT;
  const { columns, views } = value as Partial<SplitLayout>;
  if (!Array.isArray(columns) || !Array.isArray(views)) return EMPTY_LAYOUT;
  const known = new Set<string>([MAIN]);
  for (const c of columns) if (typeof c === "string") known.add(c);
  const seen = new Set<string>();
  const valid: SplitView[] = [];
  for (const view of views as Partial<SplitView>[]) {
    if (
      view &&
      typeof view.id === "string" &&
      !seen.has(view.id) &&
      (typeof view.hostId === "string" || typeof view.hostId === "number") &&
      typeof view.sessionName === "string" &&
      view.sessionName !== "" &&
      typeof view.column === "string" &&
      known.has(view.column) &&
      valid.length < MAX_VIEWERS - 1
    ) {
      seen.add(view.id);
      valid.push({
        id: view.id,
        hostId: view.hostId,
        sessionName: view.sessionName,
        ...viewTarget(view),
        column: view.column,
      });
    }
  }
  return compact({
    columns: [
      MAIN,
      ...columns.filter(
        (c): c is string => typeof c === "string" && c !== MAIN,
      ),
    ],
    views: valid,
  });
}

/** Reads a dragged session payload; null unless it is well-formed. */
export function parseSessionDrop(raw: string): SessionRef | null {
  try {
    const value = JSON.parse(raw) as Partial<SessionRef> | null;
    if (
      value &&
      (typeof value.hostId === "string" || typeof value.hostId === "number") &&
      typeof value.sessionName === "string" &&
      value.sessionName !== "" &&
      value.sessionName.length <= 200
    )
      return {
        hostId: value.hostId,
        sessionName: value.sessionName,
        ...viewTarget(value),
      };
  } catch {
    // not ours
  }
  return null;
}
