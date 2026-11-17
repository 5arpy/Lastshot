/**
 * Timeline engine: zoom and scroll. A view is pixels per second plus the
 * time at the left edge. Ctrl+wheel zooms around the mouse, "fit" shows the
 * whole timeline.
 */
import { type Item, end } from "./model";

export interface TlView {
  pxPerSec: number;
  /** Time at the left edge of the lanes, seconds. */
  scroll: number;
}

export const MIN_PX_PER_SEC = 0.02; // ~14 h across 1000 px
export const MAX_PX_PER_SEC = 2400; // ~40 px per frame at 60 fps

export const clampZoom = (z: number) => Math.min(MAX_PX_PER_SEC, Math.max(MIN_PX_PER_SEC, z));

export const timeToX = (v: TlView, t: number) => (t - v.scroll) * v.pxPerSec;
export const xToTime = (v: TlView, x: number) => v.scroll + x / v.pxPerSec;

/** Zooms by `factor` keeping the time under `anchorX` (lane pixels) still. */
export function zoomAt(v: TlView, factor: number, anchorX: number): TlView {
  const t = xToTime(v, anchorX);
  const pxPerSec = clampZoom(v.pxPerSec * factor);
  return { pxPerSec, scroll: Math.max(0, t - anchorX / pxPerSec) };
}

/**
 * Room after the last item: the playhead and the view may go there (the
 * preview shows black), so the end is never a wall. 30 % of the length,
 * at least 10 s.
 */
export function endRoom(length: number): number {
  return Math.max(0, length) + Math.max(10, length * 0.3);
}

/** Keeps the view inside 0 .. endRoom(length) (the left edge never past it). */
export function clampScroll(v: TlView, length: number, width: number): TlView {
  const max = Math.max(0, endRoom(length) - width / v.pxPerSec);
  const scroll = Math.min(Math.max(0, v.scroll), max);
  return scroll === v.scroll ? v : { ...v, scroll };
}

/**
 * Where keyboard zoom anchors: the playhead when it is on screen, else the
 * middle of the lanes (lane pixels).
 */
export function keyZoomAnchor(v: TlView, playhead: number, width: number): number {
  const x = timeToX(v, playhead);
  return x >= 0 && x <= width ? x : width / 2;
}

/**
 * The view that shows `a..b` (seconds) in `width` pixels: what dragging the
 * edges of the overview box does.
 */
export function viewOfSpan(a: number, b: number, width: number): TlView {
  const lo = Math.max(0, Math.min(a, b));
  const hi = Math.max(lo + 0.05, Math.max(a, b));
  const pxPerSec = clampZoom(width / (hi - lo));
  return { pxPerSec, scroll: lo };
}

/**
 * Follow the playhead while playing. "page": jump a screen when it leaves;
 * "smooth": keep it at 40 % of the width once it gets there.
 */
export function follow(v: TlView, t: number, width: number, mode: "page" | "smooth"): TlView {
  if (mode === "page") {
    const x = timeToX(v, t);
    if (x >= 0 && x <= width - 8) return v;
    return { ...v, scroll: Math.max(0, t - (width * 0.05) / v.pxPerSec) };
  }
  const want = Math.max(0, t - (width * 0.4) / v.pxPerSec);
  return want > v.scroll || timeToX(v, t) < 0 ? { ...v, scroll: want } : v;
}

/** A step towards `to` for animated zoom (k = 0..1 of the way). */
export function easeView(from: TlView, to: TlView, k: number): TlView {
  const e = 1 - Math.pow(1 - Math.min(1, Math.max(0, k)), 3);
  // Zoom in log space so it feels even.
  const z = Math.exp(Math.log(from.pxPerSec) + (Math.log(to.pxPerSec) - Math.log(from.pxPerSec)) * e);
  return { pxPerSec: z, scroll: from.scroll + (to.scroll - from.scroll) * e };
}

/** Shows `0..length` in `width` pixels, with a little room at the end. */
export function fitView(length: number, width: number): TlView {
  const span = Math.max(length, 1) * 1.04;
  return { pxPerSec: clampZoom(width / span), scroll: 0 };
}

/** Scrolls so `t` is visible, with a margin (follow the playhead). */
export function reveal(v: TlView, t: number, width: number, margin = 0.1): TlView {
  const x = timeToX(v, t);
  if (x >= width * margin && x <= width * (1 - margin)) return v;
  if (x > width * (1 - margin)) return { ...v, scroll: Math.max(0, t - width * margin / v.pxPerSec) };
  return { ...v, scroll: Math.max(0, t - width * (1 - margin) / v.pxPerSec) };
}

const STEPS = [1 / 60, 1 / 30, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

/** Ruler label spacing: the smallest step that leaves `minPx` between labels. */
export function tickStep(pxPerSec: number, minPx = 72): number {
  for (const s of STEPS) if (s * pxPerSec >= minPx) return s;
  return 7200;
}

/** Ruler text for a time; finer steps show tenths or frames. */
export function rulerLabel(t: number, step: number, fps = 60): string {
  const neg = t < 0;
  // 10.9999999 (float steps) is 11, not "0:10".
  const s = Math.round(Math.abs(t) * 1e6) / 1e6;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const base = h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
  let tail = "";
  if (step < 0.1) tail = `:${String(Math.round((s % 1) * fps)).padStart(2, "0")}`;
  else if (step < 1) tail = `.${Math.round((s % 1) * 10) % 10}`;
  return (neg ? "-" : "") + base + tail;
}

/** "m:ss.ff" timecode (frames at `fps`) for the time display. */
export function timecode(t: number, fps = 60): string {
  const s = Math.max(0, t);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const f = Math.min(fps - 1, Math.floor((s % 1) * fps + 1e-6));
  const hh = h > 0 ? `${h}:${String(m).padStart(2, "0")}` : `${m}`;
  return `${hh}:${String(sec).padStart(2, "0")}.${String(f).padStart(2, "0")}`;
}

/**
 * Reads a typed time: "90", "1:30", "1:30.5", "1:02:03", "+5", "-2.5"
 * (relative to `now`), or "1:30:15f" style frames after a dot are seconds
 * fractions. Returns null if it cannot be read.
 */
export function parseTime(text: string, now: number): number | null {
  const s = text.trim();
  if (!s) return null;
  const rel = s[0] === "+" || s[0] === "-" ? s[0] : null;
  const body = rel ? s.slice(1) : s;
  if (!/^[0-9:.]+$/.test(body)) return null;
  const parts = body.split(":");
  if (parts.length > 3 || parts.some((p) => p === "" || Number.isNaN(Number(p)))) return null;
  let v = 0;
  for (const p of parts) v = v * 60 + Number(p);
  if (rel === "+") return now + v;
  if (rel === "-") return Math.max(0, now - v);
  return v;
}

/**
 * The clip edge nearest to `t` on one track, within `tol` seconds (the
 * trim handle under the pointer, inside or just outside the clip). On a cut
 * between two clips, the side the pointer is on wins.
 */
export function edgeNear<I extends Item>(items: I[], t: number, tol: number): { item: I; edge: "left" | "right"; t: number } | null {
  let best: { item: I; edge: "left" | "right"; t: number; d: number } | null = null;
  for (const it of items) {
    const a = it.start;
    const b = end(it);
    // A tiny clip keeps a middle to grab: edges get at most a third each.
    const room = Math.min(tol, (b - a) / 3);
    for (const [edge, x] of [["left", a], ["right", b]] as const) {
      const d = Math.abs(t - x);
      if (d > tol) continue;
      const inside = edge === "left" ? t >= a : t <= b;
      if (inside && d > room) continue;
      // Prefer the clip the pointer is over.
      const score = d + (inside ? 0 : tol * 0.5);
      if (!best || score < best.d) best = { item: it, edge, t: x, d: score };
    }
  }
  return best && { item: best.item, edge: best.edge, t: best.t };
}

/** Edge hit size in pixels: a little wider when zoomed far out. */
export const edgePx = (pxPerSec: number) => (pxPerSec < 5 ? 10 : 8);

/**
 * Edge auto-scroll while dragging, in px per second (signed). `push` is how
 * far the pointer is into the edge zone (negative = left side) and keeps
 * growing past the edge of the lanes. Slow when just touching the zone
 * (~80 px/s), ~500 px/s at the very edge, faster the further out, never more
 * than about one view width a second. Ramps up over the first 0.4 s so a
 * brief touch of the edge barely moves the view. Time-based, so it is the
 * same at 60 Hz and 144 Hz (callers multiply by the frame time).
 */
export function autoScrollSpeed(push: number, zone: number, width: number, heldSec: number): number {
  if (!push || zone <= 0) return 0;
  const depth = Math.abs(push);
  const max = Math.min(1600, Math.max(400, width));
  const v = Math.min(max, 80 + (Math.min(depth, zone) / zone) * 420 + Math.max(0, depth - zone) * 8);
  const ramp = Math.min(1, 0.35 + (Math.max(0, heldSec) / 0.4) * 0.65);
  return Math.sign(push) * v * ramp;
}
