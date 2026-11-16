import { describe, expect, it } from "vitest";
import {
  IDENTITY,
  actualView,
  clampCrop,
  clampPan,
  fillScale,
  filterString,
  fitScale,
  fitView,
  followStage,
  flipScreenH,
  flipScreenV,
  frameIndex,
  gridLines,
  hex,
  hsl,
  loopJump,
  luma,
  matrix,
  measure,
  nextSpeed,
  normAngle,
  NO_ADJUST,
  pixelAt,
  pixelated,
  rotateBy,
  rotatedBox,
  snapAngle,
  stepTime,
  toContent,
  toStage,
  viewForRect,
  wheelFactor,
  zoomAt,
  zoomPercent,
  DEFAULT_GRID,
  MAX_ZOOM,
  type View,
} from "./math";

const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);
const content = { w: 3840, h: 2160 };
const stage = { w: 1280, h: 720 };

describe("fit, fill, 100 %", () => {
  it("fits a 4K frame into a 720p stage at one third", () => {
    close(fitScale(content, stage), 1 / 3);
    const v = fitView(content, stage);
    expect(v.x).toBe(640);
    expect(v.y).toBe(360);
  });
  it("fits a rotated picture by its rotated box", () => {
    const b = rotatedBox({ w: 400, h: 100 }, 90);
    close(b.w, 100);
    close(b.h, 400);
    close(fitScale({ w: 400, h: 100 }, { w: 1000, h: 200 }, 90), 0.5);
  });
  it("fill covers the stage", () => {
    close(fillScale({ w: 100, h: 100 }, { w: 400, h: 200 }), 4);
  });
  it("100 % means one picture pixel per device pixel", () => {
    const v = actualView(stage, IDENTITY, 1.5);
    close(v.scale, 1 / 1.5);
    close(zoomPercent(v, 1.5), 100);
    expect(pixelated(v, 1.5)).toBe(false);
    expect(pixelated({ ...v, scale: 2 }, 1.5)).toBe(true);
  });
});

describe("zoom at the cursor", () => {
  it("keeps the picture point under the cursor still", () => {
    const v = fitView(content, stage);
    const at = { x: 200, y: 150 };
    const before = toContent(v, content, at);
    const z = zoomAt(v, at, 8);
    const after = toContent(z, content, at);
    close(before.x, after.x, 1e-6);
    close(before.y, after.y, 1e-6);
    close(z.scale, v.scale * 8);
  });
  it("also holds when rotated and flipped", () => {
    const v: View = { scale: 0.5, x: 300, y: 200, rot: 37, flipH: true, flipV: false };
    const at = { x: 410, y: 95 };
    const before = toContent(v, content, at);
    const after = toContent(zoomAt(v, at, 3.7), content, at);
    close(before.x, after.x, 1e-6);
    close(before.y, after.y, 1e-6);
  });
  it("stops at the zoom limits", () => {
    const v = zoomAt(IDENTITY, { x: 0, y: 0 }, 1e6, 2);
    close(v.scale, MAX_ZOOM / 2);
    expect(zoomPercent(v, 2)).toBeGreaterThanOrEqual(3200);
  });
  it("one wheel notch is ×1.2", () => {
    close(wheelFactor(-100), 1.2);
    close(wheelFactor(100), 1 / 1.2);
    close(wheelFactor(-3, 1), wheelFactor(-99));
  });
});

describe("stage ↔ picture mapping", () => {
  it("round-trips any point", () => {
    const v: View = { scale: 2.5, x: 120, y: -40, rot: 123, flipH: false, flipV: true };
    const p = { x: 17.25, y: 300.5 };
    const back = toContent(v, content, toStage(v, content, p));
    close(back.x, p.x, 1e-6);
    close(back.y, p.y, 1e-6);
  });
  it("maps the picture's corners where CSS would put them", () => {
    const v = { ...IDENTITY, scale: 2, x: 100, y: 50 };
    const tl = toStage(v, { w: 10, h: 6 }, { x: 0, y: 0 });
    expect(tl).toEqual({ x: 90, y: 44 });
  });
  it("a 90° turn sends the right edge down", () => {
    const v = { ...IDENTITY, x: 0, y: 0, rot: 90 };
    const p = toStage(v, { w: 10, h: 10 }, { x: 10, y: 5 });
    close(p.x, 0);
    close(p.y, 5);
  });
  it("finds the pixel under the cursor at 32×", () => {
    const c = { w: 64, h: 64 };
    const v = { ...IDENTITY, scale: 32, x: 0, y: 0 }; // centre (32,32) at stage 0,0
    expect(pixelAt(v, c, { x: 0.5, y: 0.5 })).toEqual({ x: 32, y: 32 });
    expect(pixelAt(v, c, { x: -0.5, y: 31.9 })).toEqual({ x: 31, y: 32 });
    expect(pixelAt(v, c, { x: 32, y: 0 })).toEqual({ x: 33, y: 32 });
    expect(pixelAt(v, c, { x: 5000, y: 0 })).toBeNull();
  });
  it("a mirrored view reads the mirrored pixel", () => {
    const c = { w: 100, h: 10 };
    const v = { ...IDENTITY, x: 50, y: 5, flipH: true };
    expect(pixelAt(v, c, { x: 0.5, y: 5 })).toEqual({ x: 99, y: 5 });
  });
  it("matrix matches the documented formula", () => {
    const m = matrix({ ...IDENTITY, scale: 3, x: 10, y: 20 }, { w: 4, h: 2 });
    expect(m).toEqual([3, 0, -0, 3, 4, 17]);
  });
  it("viewForRect lays the picture over a rectangle", () => {
    const v = viewForRect({ w: 200, h: 100 }, { x: 10, y: 20, w: 100, h: 50 });
    const tl = toStage(v, { w: 200, h: 100 }, { x: 0, y: 0 });
    close(tl.x, 10);
    close(tl.y, 20);
  });
});

describe("rotate and flip", () => {
  it("normalises angles", () => {
    expect(normAngle(270)).toBe(-90);
    expect(normAngle(-180)).toBe(180);
    expect(normAngle(720)).toBe(0);
  });
  it("snaps near right angles only", () => {
    expect(snapAngle(88)).toBe(90);
    expect(snapAngle(80)).toBe(80);
  });
  it("rotates around a point", () => {
    const v = rotateBy({ ...IDENTITY, x: 10, y: 0 }, 90, { x: 0, y: 0 });
    close(v.x, 0);
    close(v.y, 10);
    expect(v.rot).toBe(90);
  });
  it("screen mirror flips left↔right even when rotated", () => {
    const c = { w: 10, h: 10 };
    const v: View = { ...IDENTITY, x: 0, y: 0, rot: 90 };
    const m = flipScreenH(v);
    const p = { x: 3, y: 1 };
    const a = toStage(v, c, p);
    const b = toStage(m, c, p);
    close(b.x, -a.x);
    close(b.y, a.y);
    const mv = flipScreenV(v);
    const d = toStage(mv, c, p);
    close(d.x, a.x);
    close(d.y, -a.y);
  });
});

describe("pan limits", () => {
  it("keeps part of the picture on the stage", () => {
    const v = clampPan({ ...IDENTITY, scale: 1, x: -5000, y: 99999 }, { w: 100, h: 100 }, { w: 500, h: 500 }, 40);
    expect(v.x).toBe(-10); // right edge 40 px inside
    expect(v.y).toBe(510);
  });
});

describe("colours", () => {
  it("formats hex and luma", () => {
    expect(hex(255, 0, 128)).toBe("#FF0080");
    expect(luma(255, 255, 255)).toBe(255);
    expect(luma(0, 0, 0)).toBe(0);
    expect(hsl(255, 0, 0)).toEqual([0, 100, 50]);
  });
  it("builds filter strings", () => {
    expect(filterString(NO_ADJUST)).toBe("none");
    expect(filterString({ ...NO_ADJUST, grayscale: 1, invert: true })).toBe("grayscale(1) invert(1)");
  });
});

describe("grids", () => {
  it("thirds give two lines each way", () => {
    const l = gridLines({ ...DEFAULT_GRID, kind: "thirds" }, 300, 90);
    expect(l).toHaveLength(4);
    expect(l[0]).toEqual({ x1: 100, y1: 0, x2: 100, y2: 90 });
    expect(l[3]).toEqual({ x1: 0, y1: 60, x2: 300, y2: 60 });
  });
  it("custom N×M with diagonals", () => {
    const l = gridLines({ ...DEFAULT_GRID, kind: "custom", cols: 4, rows: 2, diagonals: true }, 400, 200);
    expect(l).toHaveLength(3 + 1 + 2);
  });
  it("off draws nothing", () => {
    expect(gridLines(DEFAULT_GRID, 10, 10)).toEqual([]);
  });
});

describe("video helpers", () => {
  it("steps whole frames and lands mid-frame", () => {
    close(stepTime(0, 1, 60, 10), 1.5 / 60);
    close(stepTime(1.5 / 60, -1, 60, 10), 0.5 / 60);
    close(stepTime(0, -5, 60, 10), 0.5 / 60);
    expect(frameIndex(stepTime(2, 10, 30, 10), 30)).toBe(70);
    expect(stepTime(9.99, 50, 30, 10)).toBeLessThanOrEqual(10);
  });
  it("speeds go 0.1× to 4×", () => {
    expect(nextSpeed(1, 1)).toBe(1.25);
    expect(nextSpeed(4, 1)).toBe(4);
    expect(nextSpeed(0.1, -1)).toBe(0.1);
    expect(nextSpeed(1, -1)).toBe(0.75);
  });
  it("loops A–B and the whole clip", () => {
    expect(loopJump(5, 10, false, { a: 2, b: 5 })).toBe(2);
    expect(loopJump(3, 10, false, { a: 2, b: 5 })).toBeNull();
    expect(loopJump(1, 10, false, { a: 5, b: 2 })).toBe(2);
    expect(loopJump(9.99, 10, true, { a: null, b: null })).toBe(0);
    expect(loopJump(9.99, 10, false, { a: null, b: null })).toBeNull();
  });
});

describe("measure and crop", () => {
  it("measures length and angle", () => {
    const m = measure({ x: 0, y: 0 }, { x: 3, y: -4 });
    expect(m.length).toBe(5);
    close(m.angle, (Math.atan2(4, 3) * 180) / Math.PI);
  });
  it("clamps a crop inside the picture", () => {
    expect(clampCrop({ x: 90, y: -5, w: -40, h: 500 }, { w: 100, h: 100 })).toEqual({ x: 50, y: 0, w: 40, h: 100 });
  });
});

describe("following a resized stage", () => {
  const pic = { w: 1920, h: 1080 };
  it("keeps a fitted picture fitted at every aspect ratio", () => {
    for (const content of [pic, { w: 1080, h: 1920 }, { w: 2560, h: 1080 }, { w: 64, h: 64 }, { w: 7680, h: 4320 }]) {
      const from = { w: 640, h: 360 };
      const v = fitView(content, from);
      for (const to of [{ w: 1280, h: 720 }, { w: 200, h: 113 }, { w: 900, h: 300 }, { w: 300, h: 900 }]) {
        const f = followStage(v, from, to, content, "scale");
        const fit = fitView(content, to);
        close(f.scale, fit.scale);
        close(f.x, fit.x);
        close(f.y, fit.y);
      }
    }
  });
  it("scales a zoomed view with the stage and keeps the centre point", () => {
    const from = { w: 640, h: 360 };
    const v = { ...IDENTITY, scale: 2, x: 100, y: 50 };
    const to = { w: 1280, h: 720 };
    const f = followStage(v, from, to, pic, "scale");
    close(f.scale, 4);
    // The picture point at the old centre is at the new centre.
    const a = toContent(v, pic, { x: 320, y: 180 });
    const b = toContent(f, pic, { x: 640, y: 360 });
    close(a.x, b.x);
    close(a.y, b.y);
  });
  it("keeps the zoom in centre mode, and survives a DPI change (CSS stage shrinks)", () => {
    const v = { ...IDENTITY, scale: 1, x: 300, y: 200 };
    const c = followStage(v, { w: 600, h: 400 }, { w: 800, h: 400 }, pic, "centre");
    expect(c.scale).toBe(1);
    expect(c.x).toBe(400);
    // 100 % → 150 %: the same physical window is 2/3 the CSS size; the picture keeps its share.
    const d = followStage({ ...v, rot: 90 }, { w: 600, h: 400 }, { w: 400, h: 266.6667 }, pic, "scale");
    close(d.scale, 2 / 3, 1e-3);
    expect(d.rot).toBe(90);
  });
  it("ignores empty stages", () => {
    const v = { ...IDENTITY, scale: 3 };
    expect(followStage(v, { w: 0, h: 0 }, { w: 10, h: 10 }, pic)).toBe(v);
  });
});
