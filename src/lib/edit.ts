// Pure helpers for the clip editor: cut lists, kept ranges and crop boxes.

import type { CropRect } from "./types";

export interface Range {
  start: number;
  end: number;
}

/** Shortest piece worth keeping or cutting, in seconds. */
export const MIN_PIECE = 0.1;

/** Adds `a..b` to a cut list, merging overlaps; the result is sorted. */
export function addCut(cuts: Range[], a: number, b: number): Range[] {
  const next = [...cuts, { start: Math.min(a, b), end: Math.max(a, b) }].sort(
    (x, y) => x.start - y.start,
  );
  const out: Range[] = [];
  for (const c of next) {
    const last = out[out.length - 1];
    if (last && c.start <= last.end + 0.01) last.end = Math.max(last.end, c.end);
    else out.push({ ...c });
  }
  return out;
}

/** The parts of `start..end` that survive the cuts, in order. */
export function keptRanges(start: number, end: number, cuts: Range[]): Range[] {
  const out: Range[] = [];
  let t = start;
  for (const c of [...cuts].sort((x, y) => x.start - y.start)) {
    if (c.end <= t) continue;
    if (c.start >= end) break;
    if (c.start - t >= MIN_PIECE) out.push({ start: t, end: c.start });
    t = Math.max(t, c.end);
  }
  if (end - t >= MIN_PIECE) out.push({ start: t, end });
  return out;
}

/** Total length of some ranges, in seconds. */
export function totalLength(ranges: Range[]): number {
  return ranges.reduce((s, r) => s + (r.end - r.start), 0);
}

/** If `t` falls inside a cut, the time playback should jump to; else `t`. */
export function skipCuts(t: number, cuts: Range[]): number {
  for (const c of cuts) if (t >= c.start && t < c.end - 0.01) return c.end;
  return t;
}

export const CROP_ASPECTS = [
  { id: "16:9", w: 16, h: 9, hint: "YouTube, wide" },
  { id: "9:16", w: 9, h: 16, hint: "TikTok, Shorts, Reels" },
  { id: "1:1", w: 1, h: 1, hint: "Square" },
  { id: "4:3", w: 4, h: 3, hint: "Classic" },
] as const;

export type CropAspect = (typeof CROP_ASPECTS)[number]["id"];

/** Where the crop box is: aspect, size (0.2-1 of the largest fit) and centre. */
export interface CropState {
  aspect: CropAspect;
  scale: number;
  cx: number;
  cy: number;
}

/** The crop box as fractions of a `srcW x srcH` frame. */
export function cropRect(srcW: number, srcH: number, s: CropState): CropRect {
  const a = CROP_ASPECTS.find((x) => x.id === s.aspect) ?? CROP_ASPECTS[0];
  const src = srcW > 0 && srcH > 0 ? srcW / srcH : 16 / 9;
  const want = a.w / a.h;
  const scale = Math.min(Math.max(s.scale, 0.2), 1);
  const w = (want < src ? want / src : 1) * scale;
  const h = (want < src ? 1 : src / want) * scale;
  const clampTo = (v: number, max: number) => Math.min(Math.max(v, 0), max);
  return { x: clampTo(s.cx - w / 2, 1 - w), y: clampTo(s.cy - h / 2, 1 - h), w, h };
}

/** True when the box is (nearly) the whole frame, so cropping does nothing. */
export function isFullFrame(r: CropRect): boolean {
  return r.w >= 0.995 && r.h >= 0.995;
}

// ------------------------------------------------------------------ parts

/** Splits ranges at the given times (only splits inside a range count). */
export function splitRanges(ranges: Range[], splits: number[]): Range[] {
  const out: Range[] = [];
  const pts = [...splits].sort((a, b) => a - b);
  for (const r of ranges) {
    let t = r.start;
    for (const p of pts) {
      if (p - t >= MIN_PIECE && r.end - p >= MIN_PIECE) {
        out.push({ start: t, end: p });
        t = p;
      }
    }
    out.push({ start: t, end: r.end });
  }
  return out;
}

/** Stable id of a part: where it starts, to the millisecond. */
export function partKey(r: Range): string {
  return r.start.toFixed(3);
}

/**
 * Parts in the user's order. Parts not in `order` yet (new after a split)
 * go right after the part before them in time; parts that no longer exist
 * are dropped.
 */
export function orderParts(parts: Range[], order: string[] | null): Range[] {
  if (!order || order.length === 0) return parts;
  const byKey = new Map(parts.map((p) => [partKey(p), p]));
  const out: Range[] = order.map((k) => byKey.get(k)).filter((p): p is Range => !!p);
  const placed = new Set(out.map(partKey));
  parts.forEach((p, i) => {
    if (placed.has(partKey(p))) return;
    const prev = i > 0 ? parts[i - 1] : null;
    const at = prev ? out.findIndex((q) => partKey(q) === partKey(prev)) : -1;
    out.splice(at + 1, 0, p);
    placed.add(partKey(p));
  });
  return out;
}

/** True when the parts play in time order. */
export function inTimeOrder(parts: Range[]): boolean {
  return parts.every((p, i) => i === 0 || p.start >= parts[i - 1].start);
}

/** Moves the part at `from` to index `to`. */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  const next = [...list];
  const [it] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, it);
  return next;
}
