/**
 * Moving and resizing a frame window by hand: edges and corners, aspect
 * lock (Shift frees it), and snapping to screen edges and other frames.
 * All in physical screen pixels. Pure, so it is unit tested.
 */

export interface R {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Which edges a handle moves: n, s, e, w or a corner like "se"; "move" moves. */
export type Edge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw" | "move";

export const MIN_W = 80;
export const MIN_H = 50;

export interface DragOpts {
  /** Keep the shape (width / height); null = free. */
  aspect: number | null;
  minW?: number;
  minH?: number;
}

/** The rectangle after dragging `edge` by (dx, dy) from `start`. */
export function dragRect(start: R, edge: Edge, dx: number, dy: number, o: DragOpts): R {
  const minW = o.minW ?? MIN_W;
  const minH = o.minH ?? MIN_H;
  if (edge === "move") return { ...start, x: start.x + dx, y: start.y + dy };
  let { x, y, w, h } = start;
  const right = start.x + start.w;
  const bottom = start.y + start.h;
  if (edge.includes("e")) w = Math.max(minW, start.w + dx);
  if (edge.includes("w")) w = Math.max(minW, start.w - dx);
  if (edge.includes("s")) h = Math.max(minH, start.h + dy);
  if (edge.includes("n")) h = Math.max(minH, start.h - dy);
  if (o.aspect && o.aspect > 0) {
    const a = o.aspect;
    const horizontal = edge === "e" || edge === "w";
    const vertical = edge === "n" || edge === "s";
    if (horizontal) h = w / a;
    else if (vertical) w = h * a;
    else {
      // Corners follow whichever side moved more.
      if (Math.abs(w - start.w) / start.w >= Math.abs(h - start.h) / start.h) h = w / a;
      else w = h * a;
    }
    if (w < minW) (w = minW), (h = w / a);
    if (h < minH) (h = minH), (w = h * a);
    // Side handles grow the other side around the middle.
    if (horizontal) y = start.y + (start.h - h) / 2;
    if (vertical) x = start.x + (start.w - w) / 2;
  }
  if (edge.includes("w")) x = right - w;
  if (edge.includes("n")) y = bottom - h;
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

export interface SnapTargets {
  /** Vertical lines (x) and horizontal lines (y) to snap to. */
  xs: number[];
  ys: number[];
}

/** Screen work areas and other frames → lines to snap to. */
export function snapTargets(screens: [number, number, number, number][], others: R[]): SnapTargets {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y, w, h] of screens) {
    xs.push(x, x + w);
    ys.push(y, y + h);
  }
  for (const o of others) {
    xs.push(o.x, o.x + o.w);
    ys.push(o.y, o.y + o.h);
  }
  return { xs, ys };
}

function nearest(v: number, lines: number[], dist: number): number | null {
  let best: number | null = null;
  for (const l of lines) {
    const d = Math.abs(l - v);
    if (d <= dist && (best === null || d < Math.abs(best - v))) best = l;
  }
  return best;
}

/**
 * Snaps the moving edges of `r` to the nearest lines within `dist`. Moving
 * keeps the size; resizing moves only the dragged edges.
 */
export function snapRect(r: R, edge: Edge, t: SnapTargets, dist: number): R {
  let { x, y, w, h } = r;
  if (edge === "move") {
    const l = nearest(x, t.xs, dist);
    const rr = nearest(x + w, t.xs, dist);
    if (l !== null && (rr === null || Math.abs(l - x) <= Math.abs(rr - (x + w)))) x = l;
    else if (rr !== null) x = rr - w;
    const tp = nearest(y, t.ys, dist);
    const bt = nearest(y + h, t.ys, dist);
    if (tp !== null && (bt === null || Math.abs(tp - y) <= Math.abs(bt - (y + h)))) y = tp;
    else if (bt !== null) y = bt - h;
    return { x, y, w, h };
  }
  if (edge.includes("w")) {
    const l = nearest(x, t.xs, dist);
    if (l !== null) (w += x - l), (x = l);
  }
  if (edge.includes("e")) {
    const rr = nearest(x + w, t.xs, dist);
    if (rr !== null) w = rr - x;
  }
  if (edge.includes("n")) {
    const tp = nearest(y, t.ys, dist);
    if (tp !== null) (h += y - tp), (y = tp);
  }
  if (edge.includes("s")) {
    const bt = nearest(y + h, t.ys, dist);
    if (bt !== null) h = bt - y;
  }
  return { x, y, w, h };
}

/** CSS cursor for a handle. */
export function cursorFor(edge: Edge): string {
  if (edge === "move") return "move";
  return `${edge}-resize`;
}
