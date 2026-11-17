import { describe, expect, it } from "vitest";
import { monitorAt, monitorsOf } from "./snipGeo";

// Two screens in one picture: 1920×1080 lower left, 1280×1024 higher right
// (black above the left one and below the right one).
const L = { x: 0, y: 200, w: 1920, h: 1080 };
const R = { x: 1920, y: 0, w: 1280, h: 1024 };

describe("snip screens", () => {
  it("a capture without monitors is one screen", () => {
    expect(monitorsOf({ width: 800, height: 600 })).toEqual([{ x: 0, y: 0, w: 800, h: 600 }]);
    expect(monitorsOf({ width: 3200, height: 1280, monitors: [L, R] })).toEqual([L, R]);
    expect(monitorsOf(null)).toEqual([]);
  });
  it("finds the screen under a point, or the nearest from the black between", () => {
    expect(monitorAt([L, R], 100, 300)).toBe(0);
    expect(monitorAt([L, R], 1919, 1279)).toBe(0);
    expect(monitorAt([L, R], 1920, 10)).toBe(1);
    // Above the left screen (black): still the left one.
    expect(monitorAt([L, R], 500, 50)).toBe(0);
    // Below the right screen, near its corner: the right one.
    expect(monitorAt([L, R], 2500, 1200)).toBe(1);
  });
});
