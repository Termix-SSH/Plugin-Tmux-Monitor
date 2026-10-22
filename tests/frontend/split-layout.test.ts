import { describe, expect, it } from "vitest";
import {
  EMPTY_LAYOUT,
  MAIN,
  MAX_VIEWERS,
  PRIMARY,
  addSplit,
  parseLayout,
  parseSessionDrop,
  pruneLayout,
  removeSplit,
  type SplitLayout,
} from "../../src/frontend/split-layout";

const primary = { hostId: 1, sessionName: "a" };
function add(
  layout: SplitLayout,
  target: string,
  direction: "right" | "down",
  hostId: number,
  sessionName: string,
  id: string,
) {
  const result = addSplit(
    layout,
    target,
    direction,
    { hostId, sessionName },
    id,
    primary,
  );
  if ("error" in result) throw new Error(result.error);
  return result.layout;
}

describe("split layout", () => {
  it("splits right into a new column after the target and down under it", () => {
    let l = add(EMPTY_LAYOUT, PRIMARY, "right", 2, "b", "v1");
    l = add(l, PRIMARY, "down", 3, "c", "v2");
    expect(l.columns).toEqual([MAIN, "col-v1"]);
    expect(l.views.filter((v) => v.column === MAIN).map((v) => v.id)).toEqual([
      "v2",
    ]);
    expect(
      l.views.filter((v) => v.column === "col-v1").map((v) => v.id),
    ).toEqual(["v1"]);
    l = add(l, "v1", "down", 4, "d", "v3");
    expect(l.views.find((v) => v.id === "v3")!.column).toBe("col-v1");
  });

  it("treats the same session on different hosts as different, rejects true duplicates and the cap", () => {
    const l = add(EMPTY_LAYOUT, PRIMARY, "right", 2, "a", "v1");
    expect(
      addSplit(
        l,
        PRIMARY,
        "down",
        { hostId: "2", sessionName: "a" },
        "x",
        primary,
      ),
    ).toEqual({ error: "duplicate" });
    expect(addSplit(l, PRIMARY, "down", primary, "x", primary)).toEqual({
      error: "duplicate",
    });
    let full = l;
    for (let i = 0; i < MAX_VIEWERS - 2; i++)
      full = add(full, PRIMARY, "down", 5, `s${i}`, `f${i}`);
    expect(
      addSplit(
        full,
        PRIMARY,
        "down",
        { hostId: 9, sessionName: "z" },
        "x",
        primary,
      ),
    ).toEqual({ error: "full" });
  });

  it("removing the last viewer in a column removes the column", () => {
    const l = add(EMPTY_LAYOUT, PRIMARY, "right", 2, "b", "v1");
    expect(removeSplit(l, "v1")).toEqual(EMPTY_LAYOUT);
    expect(removeSplit(l, "missing")).toBe(l);
  });

  it("prunes viewers on missing hosts", () => {
    const l = add(EMPTY_LAYOUT, PRIMARY, "right", 2, "b", "v1");
    expect(pruneLayout(l, () => true)).toBe(l);
    expect(pruneLayout(l, (id) => id === 1)).toEqual(EMPTY_LAYOUT);
  });

  it("round-trips stored layouts and rejects malformed ones", () => {
    const l = add(EMPTY_LAYOUT, PRIMARY, "right", 2, "b", "v1");
    expect(parseLayout(JSON.parse(JSON.stringify(l)))).toEqual(l);
    expect(parseLayout("nope")).toEqual(EMPTY_LAYOUT);
    expect(
      parseLayout({
        columns: [MAIN],
        views: [
          { id: 1 },
          { id: "x", hostId: 1, sessionName: "s", column: "gone" },
        ],
      }),
    ).toEqual(EMPTY_LAYOUT);
  });

  it("only accepts well-formed session drops", () => {
    expect(parseSessionDrop('{"hostId":2,"sessionName":"s"}')).toEqual({
      hostId: 2,
      sessionName: "s",
    });
    expect(parseSessionDrop("{")).toBeNull();
    expect(parseSessionDrop('{"hostId":{},"sessionName":"s"}')).toBeNull();
    expect(parseSessionDrop('{"hostId":1,"sessionName":""}')).toBeNull();
  });

  it("keeps window/pane targets, drops malformed ones, and treats them as distinct views", () => {
    expect(
      parseSessionDrop(
        '{"hostId":1,"sessionName":"s","windowIndex":2,"paneId":"%4"}',
      ),
    ).toEqual({ hostId: 1, sessionName: "s", windowIndex: 2, paneId: "%4" });
    expect(
      parseSessionDrop('{"hostId":1,"sessionName":"s","windowIndex":-1}'),
    ).toEqual({ hostId: 1, sessionName: "s" });
    expect(
      parseSessionDrop(
        '{"hostId":1,"sessionName":"s","windowIndex":0,"paneId":"x"}',
      ),
    ).toEqual({ hostId: 1, sessionName: "s", windowIndex: 0 });
    const ref = { hostId: 1, sessionName: "s" };
    const first = addSplit(EMPTY_LAYOUT, PRIMARY, "right", ref, "a", null);
    if (!("layout" in first)) throw new Error("expected layout");
    const second = addSplit(
      first.layout,
      PRIMARY,
      "right",
      { ...ref, windowIndex: 1 },
      "b",
      null,
    );
    expect("layout" in second).toBe(true);
  });
});
