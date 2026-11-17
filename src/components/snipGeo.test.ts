import { describe, expect, it } from "vitest";
import { dragBox, lastAreaIn, monitorAt, monitorsOf, moveBox, resizeBox, sizeBox } from "./snipGeo";

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

describe("the picked area", () => {
  const pic = { x: 0, y: 0, w: 3200, h: 1280 };
  const b = { x: 100, y: 100, w: 200, h: 100 };
  it("resizes from any handle and stays in the picture", () => {
    expect(resizeBox(b, "se", 50, 20, pic)).toEqual({ x: 100, y: 100, w: 250, h: 120 });
    expect(resizeBox(b, "nw", -50, -20, pic)).toEqual({ x: 50, y: 80, w: 250, h: 120 });
    expect(resizeBox(b, "e", 10, 99, pic)).toEqual({ x: 100, y: 100, w: 210, h: 100 });
    expect(resizeBox(b, "w", -500, 0, pic)).toEqual({ x: 0, y: 100, w: 300, h: 100 });
    // Dragged past the other edge: flips over.
    expect(resizeBox(b, "e", -300, 0, pic)).toEqual({ x: 0, y: 100, w: 100, h: 100 });
    expect(resizeBox(b, "s", 0, -100, pic, 4)).toEqual({ x: 100, y: 100, w: 200, h: 4 });
  });
  it("moves whole inside the picture (the second screen too)", () => {
    expect(moveBox(b, 10, -5, pic)).toEqual({ x: 110, y: 95, w: 200, h: 100 });
    expect(moveBox(b, -500, 0, pic)).toEqual({ x: 0, y: 100, w: 200, h: 100 });
    expect(moveBox(b, 5000, 5000, pic)).toEqual({ x: 3000, y: 1180, w: 200, h: 100 });
  });
  it("takes a typed size, shifting back into the picture", () => {
    expect(sizeBox(b, 1920, 1080, pic)).toEqual({ x: 100, y: 100, w: 1920, h: 1080 });
    expect(sizeBox({ x: 3000, y: 1000, w: 10, h: 10 }, 1280, 720, pic)).toEqual({ x: 1920, y: 560, w: 1280, h: 720 });
    expect(sizeBox(b, 99999, 0, pic)).toEqual({ x: 0, y: 100, w: 3200, h: 1 });
  });
  it("drags a box; Shift makes a square in the drag's direction", () => {
    expect(dragBox(10, 10, 50, 30, false)).toEqual({ x: 10, y: 10, w: 40, h: 20 });
    expect(dragBox(10, 10, 50, 30, true)).toEqual({ x: 10, y: 10, w: 40, h: 40 });
    expect(dragBox(50, 50, 20, 40, true)).toEqual({ x: 20, y: 20, w: 30, h: 30 });
  });
  it("finds the last area (desktop px) in this picture, or not", () => {
    // The picture starts at the left screen's corner of a desktop at (-1920, -200).
    expect(lastAreaIn({ x: -1820, y: -100, w: 200, h: 100 }, [-1920, -200], { width: 3200, height: 1280 })).toEqual({ x: 100, y: 100, w: 200, h: 100 });
    expect(lastAreaIn({ x: 3000, y: 0, w: 400, h: 100 }, [0, 0], { width: 3200, height: 1280 })).toBeNull();
    expect(lastAreaIn(null, [0, 0], { width: 10, height: 10 })).toBeNull();
  });
});
