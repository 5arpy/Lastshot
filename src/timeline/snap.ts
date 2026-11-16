/**
 * Timeline engine: snapping. Points are times (seconds) an edge can stick
 * to: the playhead, item edges, markers, in/out and 0. The threshold is in
 * pixels, so snapping feels the same at every zoom.
 */
import { type Timeline, end } from "./model";

export interface SnapOpts {
  playhead?: number | null;
  /** Items being dragged: their own edges do not count. */
  exclude?: Set<string>;
  markers?: boolean;
}

export function snapPoints(tl: Timeline, o: SnapOpts = {}): number[] {
  const pts: number[] = [0];
  if (o.playhead !== undefined && o.playhead !== null) pts.push(o.playhead);
  for (const i of tl.items) {
    if (o.exclude?.has(i.id)) continue;
    pts.push(i.start, end(i));
  }
  if (o.markers !== false) for (const m of tl.markers) pts.push(m.t);
  if (tl.inPoint !== null) pts.push(tl.inPoint);
  if (tl.outPoint !== null) pts.push(tl.outPoint);
  return [...new Set(pts.map((p) => Math.round(p * 1e6) / 1e6))].sort((a, b) => a - b);
}

/** The closest point within `threshold` seconds of `t`, if any. */
export function nearest(points: number[], t: number, threshold: number): number | null {
  // Binary search: points are sorted.
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  let best: number | null = null;
  for (const k of [lo - 1, lo]) {
    const p = points[k];
    if (p === undefined) continue;
    const d = Math.abs(p - t);
    if (d <= threshold && (best === null || d < Math.abs(best - t))) best = p;
  }
  return best;
}

/**
 * Snaps a span (a dragged group from `start` to `end`) by moving it so its
 * start or its end sits on a point. Returns the shift to apply and the point
 * it stuck to (for drawing the snap line).
 */
export function snapSpan(points: number[], start: number, endT: number, threshold: number): { shift: number; at: number | null } {
  const a = nearest(points, start, threshold);
  const b = nearest(points, endT, threshold);
  const da = a === null ? Infinity : a - start;
  const db = b === null ? Infinity : b - endT;
  if (!Number.isFinite(da) && !Number.isFinite(db)) return { shift: 0, at: null };
  return Math.abs(da) <= Math.abs(db) ? { shift: da, at: a } : { shift: db, at: b };
}
