import { describe, expect, it } from "vitest";
import { addCut, cropRect, isFullFrame, keptRanges, skipCuts, totalLength } from "./edit";

describe("cuts", () => {
  it("merges overlapping cuts and sorts them", () => {
    let c = addCut([], 10, 12);
    c = addCut(c, 2, 4);
    c = addCut(c, 11, 15);
    expect(c).toEqual([
      { start: 2, end: 4 },
      { start: 10, end: 15 },
    ]);
  });

  it("keeps what is between the cuts inside the selection", () => {
    const cuts = [
      { start: 2, end: 4 },
      { start: 10, end: 15 },
    ];
    expect(keptRanges(0, 30, cuts)).toEqual([
      { start: 0, end: 2 },
      { start: 4, end: 10 },
      { start: 15, end: 30 },
    ]);
    expect(keptRanges(3, 12, cuts)).toEqual([{ start: 4, end: 10 }]);
    expect(totalLength(keptRanges(0, 30, cuts))).toBe(23);
  });

  it("drops slivers and handles a cut at the very start", () => {
    expect(keptRanges(0, 10, [{ start: 0, end: 9.95 }])).toEqual([]);
    expect(keptRanges(0, 10, [{ start: 0, end: 3 }])).toEqual([{ start: 3, end: 10 }]);
  });

  it("jumps playback over a cut", () => {
    const cuts = [{ start: 5, end: 8 }];
    expect(skipCuts(6, cuts)).toBe(8);
    expect(skipCuts(4.9, cuts)).toBe(4.9);
    expect(skipCuts(8, cuts)).toBe(8);
  });
});

describe("crop", () => {
  it("fits 9:16 into a 16:9 frame at full height, centred", () => {
    const r = cropRect(1920, 1080, { aspect: "9:16", scale: 1, cx: 0.5, cy: 0.5 });
    expect(r.h).toBeCloseTo(1);
    expect(r.w * 1920).toBeCloseTo(607.5, 0);
    expect(r.x).toBeCloseTo((1 - r.w) / 2);
  });

  it("keeps the box inside the frame when dragged past the edge", () => {
    const r = cropRect(1920, 1080, { aspect: "1:1", scale: 0.5, cx: 0.99, cy: 0.01 });
    expect(r.x + r.w).toBeCloseTo(1);
    expect(r.y).toBe(0);
  });

  it("16:9 on a 16:9 clip at full size is no crop", () => {
    expect(isFullFrame(cropRect(1920, 1080, { aspect: "16:9", scale: 1, cx: 0.5, cy: 0.5 }))).toBe(
      true,
    );
  });
});
