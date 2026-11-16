import { describe, expect, it } from "vitest";
import { type Item, type Timeline, editPoints, emptyTimeline, end, gapAt, itemsAt, trackItems, withLinked } from "./model";
import {
  addMarker,
  addTrack,
  audible,
  clearRange,
  closeAllGaps,
  closeGap,
  itemsInBox,
  moveItems,
  nextPoint,
  pasteItems,
  patchTrack,
  place,
  removeItems,
  removeTrack,
  rippleTrimToPlayhead,
  shiftItems,
  splitAt,
  trimItem,
} from "./ops";
import { nearest, snapPoints, snapSpan } from "./snap";
import { History } from "./history";
import { fitView, parseTime, reveal, tickStep, timeToX, timecode, xToTime, zoomAt } from "./view";

const it2 = (id: string, track: string, start: number, duration: number, extra: Partial<Item> = {}): Item => ({
  id,
  track,
  start,
  duration,
  srcIn: 0,
  srcDuration: 100,
  ...extra,
});

function tl(items: Item[]): Timeline {
  return {
    ...emptyTimeline([
      { id: "v1", kind: "video", name: "V1" },
      { id: "v2", kind: "video", name: "V2" },
      { id: "a1", kind: "audio", name: "A1" },
    ]),
    items,
  };
}

const spans = (t: Timeline, track: string) => trackItems(t, track).map((i) => [i.start, end(i)]);

describe("model", () => {
  it("finds items, gaps and edit points", () => {
    const t = tl([it2("a", "v1", 0, 2), it2("b", "v1", 5, 1)]);
    expect(itemsAt(t, 1).map((i) => i.id)).toEqual(["a"]);
    expect(itemsAt(t, 2)).toEqual([]);
    expect(gapAt(t, "v1", 3)).toEqual({ start: 2, end: 5 });
    expect(gapAt(t, "v1", 1)).toBeNull();
    expect(gapAt(t, "v1", 7)).toBeNull();
    expect(editPoints(t)).toEqual([0, 2, 5, 6]);
  });

  it("expands links", () => {
    const t = tl([it2("a", "v1", 0, 2, { link: "L" }), it2("b", "a1", 0, 2, { link: "L" }), it2("c", "v1", 3, 1)]);
    expect([...withLinked(t, ["a"])].sort()).toEqual(["a", "b"]);
  });
});

describe("overwrite and insert", () => {
  it("clears a range by trimming, splitting and removing", () => {
    const items = clearRange([it2("a", "v1", 0, 10), it2("b", "v1", 12, 2)], "v1", 3, 13);
    const a = items.find((i) => i.id === "a")!;
    expect(a.duration).toBe(3);
    const b = items.find((i) => i.id === "b")!;
    expect([b.start, b.duration, b.srcIn]).toEqual([13, 1, 1]);
    const mid = clearRange([it2("a", "v1", 0, 10)], "v1", 4, 6);
    expect(mid.map((i) => [i.start, i.duration, i.srcIn])).toEqual([
      [0, 4, 0],
      [6, 4, 6],
    ]);
  });

  it("moves a clip onto another and overwrites it", () => {
    const t = tl([it2("a", "v1", 0, 4), it2("b", "v1", 10, 4)]);
    const out = moveItems(t, [{ id: "b", start: 2, track: "v1" }]);
    expect(spans(out, "v1")).toEqual([
      [0, 2],
      [2, 6],
    ]);
  });

  it("insert pushes later clips right and splits the one under the drop", () => {
    const t = tl([it2("a", "v1", 0, 4), it2("b", "v1", 4, 4)]);
    const out = place(t, [it2("n", "v1", 2, 1)], "insert");
    expect(spans(out, "v1")).toEqual([
      [0, 2],
      [2, 3],
      [3, 5],
      [5, 9],
    ]);
  });

  it("moves to another track and keeps the old track untouched", () => {
    const t = tl([it2("a", "v1", 0, 4), it2("b", "v2", 0, 4)]);
    const out = moveItems(t, [{ id: "a", start: 1, track: "v2" }]);
    expect(spans(out, "v1")).toEqual([]);
    expect(spans(out, "v2")).toEqual([
      [0, 1],
      [1, 5],
    ]);
  });

  it("refuses locked tracks", () => {
    let t = tl([it2("a", "v1", 0, 4)]);
    t = patchTrack(t, "v2", { locked: true });
    expect(moveItems(t, [{ id: "a", start: 0, track: "v2" }])).toBe(t);
  });

  it("magnetic track packs back to back", () => {
    const t = tl([it2("a", "v1", 0, 2), it2("b", "v1", 2, 2), it2("c", "v1", 4, 2)]);
    // Drag c to 1.2 s (past the middle of a): it goes between a and b.
    const out = moveItems(t, [{ id: "c", start: 1.2, track: "v1" }], "insert", { magnet: "v1" });
    expect(trackItems(out, "v1").map((i) => [i.id, i.start])).toEqual([
      ["a", 0],
      ["c", 2],
      ["b", 4],
    ]);
    // Everything is back to back with no gaps or overlaps.
    const s = spans(out, "v1");
    for (let k = 1; k < s.length; k++) expect(s[k][0]).toBeCloseTo(s[k - 1][1]);
    expect(s[0][0]).toBe(0);
  });

  it("shifts a group but never before 0", () => {
    const t = tl([it2("a", "v1", 1, 2), it2("b", "v2", 3, 2)]);
    const out = shiftItems(t, ["a", "b"], -5);
    expect(out.items.map((i) => i.start).sort()).toEqual([0, 2]);
  });
});

describe("trim", () => {
  it("stops at the neighbour and the source", () => {
    const t = tl([it2("a", "v1", 0, 4, { srcIn: 1, srcDuration: 10 }), it2("b", "v1", 6, 2)]);
    expect(end(trimItem(t, "a", "right", 9).items.find((i) => i.id === "a")!)).toBe(6);
    const left = trimItem(t, "a", "left", -5).items.find((i) => i.id === "a")!;
    expect([left.start, left.srcIn, left.duration]).toEqual([0, 1, 4]);
    const l2 = trimItem(t, "a", "left", 1).items.find((i) => i.id === "a")!;
    expect([l2.start, l2.srcIn, l2.duration]).toEqual([1, 2, 3]);
  });

  it("ripple trims move the rest of the track", () => {
    const t = tl([it2("a", "v1", 0, 4), it2("b", "v1", 4, 2)]);
    const r = trimItem(t, "a", "right", 3, { ripple: true });
    expect(spans(r, "v1")).toEqual([
      [0, 3],
      [3, 5],
    ]);
    const l = trimItem(t, "a", "left", 1, { ripple: true });
    expect(spans(l, "v1")).toEqual([
      [0, 3],
      [3, 5],
    ]);
    expect(l.items.find((i) => i.id === "a")!.srcIn).toBe(1);
  });

  it("trims linked items with the same edge", () => {
    const t = tl([it2("a", "v1", 0, 4, { link: "L" }), it2("b", "a1", 0, 4, { link: "L" })]);
    const r = trimItem(t, "a", "right", 2);
    expect(r.items.map((i) => i.duration)).toEqual([2, 2]);
  });

  it("unbounded items (pictures) can grow", () => {
    const t = tl([{ id: "p", track: "v1", start: 0, duration: 5, srcIn: 0 }]);
    expect(trimItem(t, "p", "right", 60).items[0].duration).toBe(60);
  });
});

describe("split, delete, gaps", () => {
  it("splits everything under the playhead, or only the selection", () => {
    const t = tl([it2("a", "v1", 0, 4), it2("b", "a1", 0, 4)]);
    const all = splitAt(t, 1);
    expect(all.created.length).toBe(2);
    expect(spans(all.tl, "v1")).toEqual([
      [0, 1],
      [1, 4],
    ]);
    const right = all.tl.items.find((i) => i.id === all.created[0])!;
    expect(right.srcIn).toBe(1);
    const sel = splitAt(t, 1, ["a"]);
    expect(sel.created.length).toBe(1);
  });

  it("split keeps links in pairs", () => {
    const t = tl([it2("a", "v1", 0, 4, { link: "L" }), it2("b", "a1", 0, 4, { link: "L" })]);
    const s = splitAt(t, 2, ["a"]);
    const right = s.tl.items.filter((i) => s.created.includes(i.id));
    expect(right.length).toBe(2);
    expect(right[0].link).toBe(right[1].link);
    expect(right[0].link).not.toBe("L");
  });

  it("skips locked tracks", () => {
    const t = patchTrack(tl([it2("a", "v1", 0, 4)]), "v1", { locked: true });
    expect(splitAt(t, 1).created).toEqual([]);
    expect(removeItems(t, ["a"])).toBe(t);
  });

  it("delete leaves a gap, ripple delete closes it", () => {
    const t = tl([it2("a", "v1", 0, 2), it2("b", "v1", 2, 2), it2("c", "v1", 4, 2)]);
    expect(spans(removeItems(t, ["b"]), "v1")).toEqual([
      [0, 2],
      [4, 6],
    ]);
    expect(spans(removeItems(t, ["b"], true), "v1")).toEqual([
      [0, 2],
      [2, 4],
    ]);
    expect(spans(removeItems(t, ["a", "b"], true), "v1")).toEqual([[0, 2]]);
  });

  it("closes one gap or all gaps", () => {
    const t = tl([it2("a", "v1", 1, 2), it2("b", "v1", 5, 2)]);
    expect(spans(closeGap(t, "v1", 4), "v1")).toEqual([
      [1, 3],
      [3, 5],
    ]);
    expect(spans(closeAllGaps(t), "v1")).toEqual([
      [0, 2],
      [2, 4],
    ]);
  });

  it("Q and W ripple to the playhead", () => {
    const t = tl([it2("a", "v1", 0, 4), it2("b", "v1", 4, 2)]);
    expect(spans(rippleTrimToPlayhead(t, 1, "left"), "v1")).toEqual([
      [0, 3],
      [3, 5],
    ]);
    expect(spans(rippleTrimToPlayhead(t, 1, "right"), "v1")).toEqual([
      [0, 1],
      [1, 3],
    ]);
  });

  it("pastes at the playhead with new ids", () => {
    const t = tl([it2("a", "v1", 0, 2)]);
    const p = pasteItems(t, [t.items[0]], 5, () => "v2");
    expect(p.created.length).toBe(1);
    expect(spans(p.tl, "v1")).toEqual([
      [0, 2],
      [5, 7],
    ]);
  });

  it("tracks: add, remove, solo", () => {
    let t = tl([it2("a", "a1", 0, 2)]);
    t = addTrack(t, { id: "a2", kind: "audio", name: "A2" });
    expect(t.tracks.length).toBe(4);
    t = patchTrack(t, "a2", { solo: true });
    expect(audible(t, "a1")).toBe(false);
    expect(audible(t, "a2")).toBe(true);
    t = removeTrack(t, "a1");
    expect(t.items).toEqual([]);
  });

  it("markers and next/prev", () => {
    let t = tl([]);
    t = addMarker(t, 3).tl;
    t = addMarker(t, 1).tl;
    expect(t.markers.map((m) => m.t)).toEqual([1, 3]);
    expect(addMarker(t, 1).tl).toBe(t);
    expect(nextPoint([1, 3], 1, 1)).toBe(3);
    expect(nextPoint([1, 3], 1, -1)).toBeNull();
  });

  it("marquee", () => {
    const t = tl([it2("a", "v1", 0, 2), it2("b", "v1", 3, 2), it2("c", "v2", 0, 2)]);
    expect(itemsInBox(t, new Set(["v1"]), 1.5, 3.5).sort()).toEqual(["a", "b"]);
  });
});

describe("snap", () => {
  it("collects and finds points", () => {
    const t = tl([it2("a", "v1", 1, 2), it2("b", "v1", 5, 2)]);
    t.markers.push({ id: "m", t: 4 });
    const pts = snapPoints(t, { playhead: 2.5, exclude: new Set(["b"]) });
    expect(pts).toEqual([0, 1, 2.5, 3, 4]);
    expect(nearest(pts, 3.1, 0.2)).toBe(3);
    expect(nearest(pts, 3.5, 0.2)).toBeNull();
    expect(snapSpan(pts, 3.9, 5.9, 0.2)).toEqual({ shift: expect.closeTo(0.1, 5), at: 4 });
  });
});

describe("history", () => {
  it("undo and redo", () => {
    const h = new History<number>(3);
    h.push(1, "a");
    h.push(2, "b");
    expect(h.undoLabel).toBe("b");
    expect(h.undo(3)).toBe(2);
    expect(h.redo(2)).toBe(3);
    h.push(3);
    h.push(4);
    h.push(5);
    expect(h.past.length).toBe(3);
  });
});

describe("view", () => {
  it("maps and zooms around the mouse", () => {
    const v = { pxPerSec: 10, scroll: 5 };
    expect(timeToX(v, 6)).toBe(10);
    expect(xToTime(v, 10)).toBe(6);
    const z = zoomAt(v, 2, 10);
    expect(xToTime(z, 10)).toBeCloseTo(6);
    expect(fitView(100, 1040).pxPerSec).toBeCloseTo(10);
    expect(tickStep(10)).toBe(10);
    expect(reveal(v, 200, 500).scroll).toBeGreaterThan(100);
  });

  it("timecodes and typed times", () => {
    expect(timecode(61.5, 60)).toBe("1:01.30");
    expect(parseTime("1:30", 0)).toBe(90);
    expect(parseTime("+5", 10)).toBe(15);
    expect(parseTime("-20", 10)).toBe(0);
    expect(parseTime("abc", 0)).toBeNull();
  });
});

import { extractRange } from "./ops";
describe("extract range", () => {
  it("cuts out in→out and closes the hole, or keeps only it", () => {
    const t = tl([it2("a", "v1", 0, 10), it2("b", "a1", 2, 4)]);
    const cut = extractRange(t, 3, 5);
    expect(spans(cut, "v1")).toEqual([
      [0, 3],
      [3, 8],
    ]);
    expect(spans(cut, "a1")).toEqual([
      [2, 3],
      [3, 4],
    ]);
    const keep = extractRange(t, 3, 5, true);
    expect(spans(keep, "v1")).toEqual([[0, 2]]);
    expect(keep.items.find((i) => i.track === "v1")!.srcIn).toBe(3);
  });
});

import { rollEdit, slipItem } from "./ops";
describe("slip and roll", () => {
  it("slip moves what the clip shows, not where it is, within the source", () => {
    const t = tl([it2("a", "v1", 2, 4, { srcIn: 3, srcDuration: 10 }), it2("s", "a1", 2, 4, { srcIn: 3, srcDuration: 10, link: "L" }), it2("x", "v1", 6, 2)]);
    t.items[0] = { ...t.items[0], link: "L" };
    const r = slipItem(t, "a", 2);
    expect(r.items.find((i) => i.id === "a")).toMatchObject({ start: 2, duration: 4, srcIn: 5 });
    expect(r.items.find((i) => i.id === "s")?.srcIn).toBe(5);
    expect(slipItem(t, "a", 50).items[0].srcIn).toBe(6);
    expect(slipItem(t, "a", -50).items[0].srcIn).toBe(0);
  });
  it("roll moves the cut between two touching clips", () => {
    const t = tl([it2("a", "v1", 0, 4, { srcIn: 0, srcDuration: 10 }), it2("b", "v1", 4, 4, { srcIn: 2, srcDuration: 10 })]);
    const r = rollEdit(t, "a", "right", 5);
    expect(spans(r, "v1")).toEqual([
      [0, 5],
      [5, 8],
    ]);
    expect(r.items.find((i) => i.id === "b")?.srcIn).toBe(3);
    // The right clip cannot show source before 0: the cut stops at 2.
    expect(spans(rollEdit(t, "b", "left", 0), "v1")[0]).toEqual([0, 2]);
    // Nothing touching: no change.
    expect(rollEdit(tl([it2("a", "v1", 0, 4)]), "a", "right", 6).items[0].duration).toBe(4);
  });
});
