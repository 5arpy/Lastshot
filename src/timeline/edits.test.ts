import { describe, expect, it } from "vitest";
import { type Item, type Timeline, EPS, MIN_LEN, emptyTimeline, end, trackItems, withLinked } from "./model";
import { clearRange, extractRange, moveItems, pasteItems, place, removeItems, rippleTrimToPlayhead, rollEdit, shiftItems, slipItem, splitAt, trimItem } from "./ops";

const it2 = (id: string, track: string, start: number, duration: number, extra: Partial<Item> = {}): Item => ({
  id,
  track,
  start,
  duration,
  srcIn: 0,
  srcDuration: 100,
  ...extra,
});

function tl(items: Item[], locked: string[] = []): Timeline {
  return {
    ...emptyTimeline(
      [
        { id: "o1", kind: "overlay", name: "O1" },
        { id: "v1", kind: "video", name: "V1" },
        { id: "a1", kind: "audio", name: "A1" },
      ].map((tr) => ({ ...tr, locked: locked.includes(tr.id) })),
    ),
    items,
  };
}

/** The engine's rules: no overlaps on a track, nothing shorter than MIN_LEN, nothing before 0, unique ids. */
export function expectValid(t: Timeline): void {
  expect(new Set(t.items.map((i) => i.id)).size).toBe(t.items.length);
  for (const tr of t.tracks) {
    const on = trackItems(t, tr.id);
    for (let k = 0; k < on.length; k++) {
      expect(on[k].start).toBeGreaterThanOrEqual(-EPS);
      expect(on[k].duration).toBeGreaterThanOrEqual(MIN_LEN - EPS);
      if (k > 0) expect(on[k].start, `overlap on ${tr.id}: ${on[k - 1].id} and ${on[k].id}`).toBeGreaterThanOrEqual(end(on[k - 1]) - 1e-4);
    }
  }
}

const startOf = (t: Timeline, id: string) => t.items.find((i) => i.id === id)?.start;

describe("ripple delete", () => {
  it("moves later items left by exactly the deleted length", () => {
    const t = tl([it2("b", "v1", 4, 2), it2("c", "v1", 6, 2)]);
    const out = removeItems(t, ["b"], true);
    expect(startOf(out, "c")).toBe(4);
    expectValid(out);
  });
  it("keeps linked sound in step with the clip it belongs to", () => {
    const t = tl([it2("b", "v1", 4, 2), it2("c", "v1", 6, 2, { link: "L" }), it2("ca", "a1", 6, 2, { link: "L" }), it2("m", "a1", 0, 3)]);
    const out = removeItems(t, ["b"], true);
    expect(startOf(out, "c")).toBe(4);
    expect(startOf(out, "ca")).toBe(4);
    expect(startOf(out, "m")).toBe(0);
    expectValid(out);
  });
  it("deleting a clip with its sound closes up once", () => {
    const t = tl([it2("b", "v1", 0, 2, { link: "L" }), it2("ba", "a1", 0, 2, { link: "L" }), it2("c", "v1", 2, 2, { link: "M" }), it2("ca", "a1", 2, 2, { link: "M" })]);
    const out = removeItems(t, ["b", "ba"], true);
    expect(startOf(out, "c")).toBe(0);
    expect(startOf(out, "ca")).toBe(0);
    expectValid(out);
  });
  it("never pushes a linked item into one before it", () => {
    const t = tl([it2("b", "v1", 4, 2), it2("c", "v1", 6, 2, { link: "L" }), it2("ca", "a1", 6, 2, { link: "L" }), it2("m", "a1", 3, 2.5)]);
    const out = removeItems(t, ["b"], true);
    expect(startOf(out, "ca")).toBe(5.5);
    expectValid(out);
  });
});

describe("extract (X)", () => {
  it("drops slivers instead of leaving overlaps", () => {
    const t = tl([it2("x", "v1", 2, 3.03), it2("y", "v1", 5.03, 2)]);
    const out = extractRange(t, 2, 5);
    expectValid(out);
    // The 0.03 s tail of x goes; y closes up behind it.
    expect(trackItems(out, "v1").map((i) => i.id)).toEqual(["y"]);
    expect(startOf(out, "y")).toBeCloseTo(2.03);
  });
  it("keeps only the range, trimmed, with keep", () => {
    const t = tl([it2("x", "v1", 0, 2.02), it2("y", "v1", 2.02, 4)]);
    const out = extractRange(t, 2, 4, true);
    expectValid(out);
    expect(trackItems(out, "v1").map((i) => [i.id, i.start, i.duration])).toEqual([["y", 0.02, 1.98]]);
  });
  it("cut pieces get their own link, shared by the linked pieces", () => {
    const t = tl([it2("v", "v1", 0, 10, { link: "L" }), it2("a", "a1", 0, 10, { link: "L" })]);
    const out = extractRange(t, 3, 5);
    const right = out.items.filter((i) => i.start === 3);
    expect(right.length).toBe(2);
    expect(right[0].link).toBe(right[1].link);
    expect(right[0].link).not.toBe("L");
  });
});

describe("overwrite and insert keep links and sync", () => {
  it("overwrite gives the right-hand piece a new link", () => {
    const items = clearRange([it2("v", "v1", 0, 10, { link: "L" })], "v1", 4, 6);
    expect(items.map((i) => i.link)[0]).toBe("L");
    expect(items[1].link).not.toBe("L");
  });
  it("insert splits a clip and its sound and moves what comes after on every track", () => {
    const t = tl([it2("v", "v1", 0, 10, { link: "L" }), it2("a", "a1", 0, 10, { link: "L" }), it2("t", "o1", 6, 2)]);
    const out = place(t, [it2("n", "v1", 4, 2)], "insert");
    expectValid(out);
    const right = out.items.filter((i) => i.start === 6 && i.id !== "t");
    expect(right.map((i) => i.track).sort()).toEqual(["a1", "v1"]);
    expect(right[0].link).toBe(right[1].link);
    expect(right[0].link).not.toBe("L");
    expect(withLinked(out, ["v"]).size).toBe(2);
    expect(startOf(out, "t")).toBe(8);
  });
  it("a locked track stays put on insert", () => {
    const t = tl([it2("v", "v1", 0, 4), it2("m", "a1", 5, 2)], ["a1"]);
    const out = place(t, [it2("n", "v1", 0, 2)], "insert");
    expect(startOf(out, "m")).toBe(5);
    expect(startOf(out, "v")).toBe(2);
  });
  it("the magnetic track carries its sound and titles when it packs", () => {
    const t = tl([it2("a", "v1", 0, 2), it2("b", "v1", 2, 2, { link: "L" }), it2("ba", "a1", 2, 2, { link: "L" }), it2("t", "o1", 2.5, 1)]);
    const out = removeItems(t, ["a"], false, { magnet: "v1" });
    expect(startOf(out, "b")).toBe(0);
    expect(startOf(out, "ba")).toBe(0);
    expect(startOf(out, "t")).toBe(0.5);
    expectValid(out);
  });
});

describe("every edit keeps the rules", () => {
  it("holds over a long run of random edits", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)];
    const tracks = ["o1", "v1", "a1"];
    let t = tl([it2("a", "v1", 0, 5, { link: "L" }), it2("aa", "a1", 0, 5, { link: "L" }), it2("b", "v1", 5, 3), it2("c", "o1", 1, 2)]);
    let n = 0;
    for (let step = 0; step < 600; step++) {
      const ids = t.items.map((i) => i.id);
      const id = ids.length ? pick(ids) : "";
      const x = Math.round(rnd() * 1200) / 100;
      const op = Math.floor(rnd() * 12);
      switch (op) {
        case 0:
          t = place(t, [it2(`n${n++}`, pick(tracks), x, 0.03 + rnd() * 3)], rnd() < 0.5 ? "insert" : "overwrite", { magnet: rnd() < 0.3 ? "v1" : null });
          break;
        case 1:
          if (id) t = moveItems(t, [{ id, start: x, track: pick(tracks) }], rnd() < 0.5 ? "insert" : "overwrite");
          break;
        case 2:
          if (id) t = removeItems(t, [id], rnd() < 0.7, { magnet: rnd() < 0.3 ? "v1" : null });
          break;
        case 3:
          t = splitAt(t, x).tl;
          break;
        case 4:
          t = extractRange(t, x, x + rnd() * 3, rnd() < 0.2);
          break;
        case 5:
          if (id) t = trimItem(t, id, rnd() < 0.5 ? "left" : "right", x, { ripple: rnd() < 0.5 });
          break;
        case 6:
          if (id) t = rollEdit(t, id, rnd() < 0.5 ? "left" : "right", x);
          break;
        case 7:
          if (id) t = slipItem(t, id, rnd() * 4 - 2);
          break;
        case 8:
          if (id) t = pasteItems(t, t.items.filter((i) => i.id === id), x, () => "v1").tl;
          break;
        case 9:
          if (id) t = shiftItems(t, [id], rnd() * 4 - 2);
          break;
        case 10:
          t = rippleTrimToPlayhead(t, x, rnd() < 0.5 ? "left" : "right");
          break;
        default:
          if (id) t = removeItems(t, [...withLinked(t, [id])], true);
      }
      try {
        expectValid(t);
      } catch (e) {
        throw new Error(`step ${step}, op ${op}: ${(e as Error).message}`);
      }
      if (t.items.length > 40) t = { ...t, items: t.items.slice(0, 20) };
      if (!t.items.length) t = tl([it2(`r${n++}`, "v1", 0, 4)]);
    }
  });
});
