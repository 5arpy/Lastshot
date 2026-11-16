import { describe, expect, it } from "vitest";
import { dragRect, snapRect, snapTargets, MIN_W } from "./snap";
import { frameIdOf, isPictureType } from "./frames";

const start = { x: 100, y: 100, w: 400, h: 200 };

describe("dragging edges", () => {
  it("moves without resizing", () => {
    expect(dragRect(start, "move", 30, -20, { aspect: null })).toEqual({ x: 130, y: 80, w: 400, h: 200 });
  });
  it("free resize from the left edge keeps the right edge", () => {
    expect(dragRect(start, "w", 50, 0, { aspect: null })).toEqual({ x: 150, y: 100, w: 350, h: 200 });
  });
  it("aspect lock: a side handle grows around the middle", () => {
    const r = dragRect(start, "e", 200, 0, { aspect: 2 });
    expect(r).toEqual({ x: 100, y: 50, w: 600, h: 300 });
  });
  it("aspect lock: a corner keeps the opposite corner", () => {
    const r = dragRect(start, "nw", -100, -10, { aspect: 2 });
    expect(r.w / r.h).toBeCloseTo(2, 2);
    expect(r.x + r.w).toBe(500);
    expect(r.y + r.h).toBe(300);
  });
  it("never shrinks below the minimum", () => {
    const r = dragRect(start, "se", -1000, -1000, { aspect: null });
    expect(r.w).toBe(MIN_W);
    expect(r.h).toBeGreaterThanOrEqual(50);
    const a = dragRect(start, "se", -1000, -1000, { aspect: 2 });
    expect(a.w / a.h).toBeCloseTo(2, 1);
    expect(a.w).toBeGreaterThanOrEqual(MIN_W);
  });
});

describe("snapping", () => {
  const t = snapTargets([[0, 0, 1920, 1040]], [{ x: 1000, y: 300, w: 200, h: 200 }]);
  it("snaps a moved frame to a screen edge", () => {
    expect(snapRect({ x: 8, y: 500, w: 300, h: 100 }, "move", t, 12)).toEqual({ x: 0, y: 500, w: 300, h: 100 });
  });
  it("snaps the right edge to another frame's left edge", () => {
    expect(snapRect({ x: 690, y: 600, w: 300, h: 100 }, "move", t, 12)).toEqual({ x: 700, y: 600, w: 300, h: 100 });
  });
  it("snaps only the dragged edge when resizing", () => {
    expect(snapRect({ x: 600, y: 600, w: 395, h: 100 }, "e", t, 12)).toEqual({ x: 600, y: 600, w: 400, h: 100 });
    expect(snapRect({ x: 1210, y: 600, w: 100, h: 100 }, "w", t, 12)).toEqual({ x: 1200, y: 600, w: 110, h: 100 });
  });
  it("leaves far-away frames alone", () => {
    const r = { x: 500, y: 500, w: 100, h: 100 };
    expect(snapRect(r, "move", t, 12)).toEqual(r);
  });
});

describe("frame windows", () => {
  it("finds the frame id from the window label or the URL", () => {
    expect(frameIdOf("frame-abc1", "")).toBe("abc1");
    expect(frameIdOf("main", "?frame=x9")).toBe("x9");
    expect(frameIdOf("main", "")).toBeNull();
    expect(frameIdOf("frame-", "")).toBeNull();
  });
  it("accepts only pictures it can show", () => {
    expect(isPictureType("image/png")).toBe(true);
    expect(isPictureType("image/jpeg")).toBe(true);
    expect(isPictureType("image/svg+xml")).toBe(false);
    expect(isPictureType("video/mp4")).toBe(false);
  });
});
