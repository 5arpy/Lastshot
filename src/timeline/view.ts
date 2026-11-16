/**
 * Timeline engine: zoom and scroll. A view is pixels per second plus the
 * time at the left edge. Ctrl+wheel zooms around the mouse, "fit" shows the
 * whole timeline.
 */
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
  const s = Math.abs(t);
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
