// The snip overlay's screens: which monitor a point is on, in the frozen
// picture's physical pixels (the Rust side's snip_geo has the desktop rules).
import type { SnipCapture } from "../lib/types";

export type Box = { x: number; y: number; w: number; h: number };

/** The monitors in the picture; older or single-screen captures are one screen. */
export function monitorsOf(c: Pick<SnipCapture, "width" | "height" | "monitors"> | null): Box[] {
  if (!c) return [];
  const m = (c.monitors ?? []).filter((r) => r.w > 0 && r.h > 0);
  return m.length ? m : [{ x: 0, y: 0, w: c.width, h: c.height }];
}

/** The monitor under the point, else the nearest one (the black between monitors). */
export function monitorAt(mons: Box[], x: number, y: number): number {
  let best = 0;
  let bestD = Infinity;
  mons.forEach((m, i) => {
    const dx = Math.max(m.x - x, 0, x - (m.x + m.w - 1));
    const dy = Math.max(m.y - y, 0, y - (m.y + m.h - 1));
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

// ------------------------------------------------------------------ the picked area

/** A resize handle: corners and edge middles ("n", "ne", ... "nw"). */
export type Handle = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";
export const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/**
 * The area after dragging `h` by (dx, dy), inside `bounds` (the picture);
 * an edge dragged past the other one flips over, like every editor. Never
 * smaller than `min` px.
 */
export function resizeBox(b: Box, h: Handle, dx: number, dy: number, bounds: Box, min = 1): Box {
  let x1 = b.x;
  let y1 = b.y;
  let x2 = b.x + b.w;
  let y2 = b.y + b.h;
  if (h.includes("w")) x1 += dx;
  if (h.includes("e")) x2 += dx;
  if (h.includes("n")) y1 += dy;
  if (h.includes("s")) y2 += dy;
  const cx = (v: number) => Math.max(bounds.x, Math.min(bounds.x + bounds.w, Math.round(v)));
  const cy = (v: number) => Math.max(bounds.y, Math.min(bounds.y + bounds.h, Math.round(v)));
  [x1, x2] = [cx(Math.min(x1, x2)), cx(Math.max(x1, x2))];
  [y1, y2] = [cy(Math.min(y1, y2)), cy(Math.max(y1, y2))];
  return { x: x1, y: y1, w: Math.max(min, x2 - x1), h: Math.max(min, y2 - y1) };
}

/** The area moved by (dx, dy), kept whole inside `bounds`. */
export function moveBox(b: Box, dx: number, dy: number, bounds: Box): Box {
  const x = Math.max(bounds.x, Math.min(bounds.x + bounds.w - b.w, Math.round(b.x + dx)));
  const y = Math.max(bounds.y, Math.min(bounds.y + bounds.h - b.h, Math.round(b.y + dy)));
  return { ...b, x, y };
}

/** A typed size (keeps the top-left corner; shifts left / up when it would leave the picture). */
export function sizeBox(b: Box, w: number, h: number, bounds: Box): Box {
  const W = Math.max(1, Math.min(bounds.w, Math.round(w)));
  const H = Math.max(1, Math.min(bounds.h, Math.round(h)));
  return moveBox({ ...b, w: W, h: H }, 0, 0, bounds);
}

/**
 * A dragged box from the press point to the pointer. Shift: a square (the
 * longer side wins), like ShareX, Snagit and every drawing app.
 */
export function dragBox(x1: number, y1: number, x2: number, y2: number, square: boolean): Box {
  let dx = x2 - x1;
  let dy = y2 - y1;
  if (square) {
    const s = Math.max(Math.abs(dx), Math.abs(dy));
    dx = Math.sign(dx || 1) * s;
    dy = Math.sign(dy || 1) * s;
  }
  return { x: Math.min(x1, x1 + dx), y: Math.min(y1, y1 + dy), w: Math.abs(dx), h: Math.abs(dy) };
}

/** Sizes offered for the area (video and social sizes), physical px. */
export const AREA_SIZES: { label: string; w: number; h: number }[] = [
  { label: "1920 × 1080", w: 1920, h: 1080 },
  { label: "1280 × 720", w: 1280, h: 720 },
  { label: "1080 × 1080", w: 1080, h: 1080 },
  { label: "1080 × 1920", w: 1080, h: 1920 },
  { label: "800 × 600", w: 800, h: 600 },
];

/** The last area, remembered in desktop pixels, as an area of this picture (null when it is not in it). */
export function lastAreaIn(last: Box | null, origin: [number, number], pic: { width: number; height: number }): Box | null {
  if (!last || !(last.w > 0 && last.h > 0)) return null;
  const b = { x: last.x - origin[0], y: last.y - origin[1], w: last.w, h: last.h };
  if (b.x < 0 || b.y < 0 || b.x + b.w > pic.width || b.y + b.h > pic.height) return null;
  return b;
}
