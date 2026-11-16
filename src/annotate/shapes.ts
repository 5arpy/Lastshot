/**
 * Annotation objects shared by the video editor (overlays on the picture)
 * and the screenshot annotator. Coordinates are content pixels (the video's
 * canvas or the screenshot's pixels). Every object stays editable: select,
 * move, resize, rotate, flip, restyle, reorder, until it is exported.
 *
 * - Boxed kinds (rect, ellipse, text, image, pen, highlight, step, blur,
 *   pixelate, redact) have a box `x, y, w, h` and turn `rot` degrees about its
 *   centre. Pen strokes are stored inside the box (0-1), so they scale and
 *   turn with it.
 * - Lines and arrows keep their two end points in `pts` (absolute); the box
 *   is their bounds.
 */

export type ShapeKind =
  | "rect"
  | "ellipse"
  | "line"
  | "arrow"
  | "pen"
  | "highlight"
  | "text"
  | "step"
  | "image"
  | "blur"
  | "pixelate"
  | "redact"
  /** Dims everything outside its box. */
  | "spotlight";

export type Pt = [number, number];

export interface Shape {
  id: string;
  kind: ShapeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Degrees, clockwise, about the box centre. */
  rot: number;
  flipX?: boolean;
  flipY?: boolean;
  /** Stroke / text / step colour. */
  color: string;
  /** Shape fill, or the label box behind text. */
  fill?: string | null;
  /** Stroke width, px. */
  width: number;
  opacity: number;
  dash?: boolean;
  /** Rectangle corner radius, px. */
  radius?: number;
  /** Arrow at both ends. */
  double?: boolean;
  /** Line / arrow end points (absolute). */
  pts?: Pt[];
  /** Pen / highlighter strokes, 0-1 inside the box. */
  strokes?: Pt[][];
  // Text
  text?: string;
  size?: number;
  bold?: boolean;
  italic?: boolean;
  align?: "left" | "center" | "right";
  /** Outline colour around the letters (null = none). */
  outline?: string | null;
  shadow?: boolean;
  // Image
  src?: string;
  // Step number
  n?: number;
  /** Pixelate block / blur radius, px. */
  strength?: number;
  locked?: boolean;
  hidden?: boolean;
}

export type Tool = "select" | ShapeKind;

/** Kinds whose box cannot turn (they read the picture under them straight). */
export const NO_ROTATE: ReadonlySet<ShapeKind> = new Set(["blur", "pixelate", "redact", "spotlight"]);
export const IS_LINE = (k: ShapeKind) => k === "line" || k === "arrow";
/** Kinds that keep their shape on corner drags unless Shift is held. */
const KEEP_ASPECT: ReadonlySet<ShapeKind> = new Set(["image", "text", "step"]);

export const MIN_SIDE = 4;

export interface Style {
  color: string;
  fill: string | null;
  width: number;
  opacity: number;
  size: number;
  bold: boolean;
  italic: boolean;
  align: "left" | "center" | "right";
  outline: string | null;
  shadow: boolean;
  dash: boolean;
}

export const DEFAULT_STYLE: Style = {
  color: "#ff4d4f",
  fill: null,
  width: 6,
  opacity: 1,
  size: 64,
  bold: true,
  italic: false,
  align: "left",
  outline: "#000000",
  shadow: true,
  dash: false,
};

export const PALETTE = ["#ff4d4f", "#ffc53d", "#52c41a", "#4096ff", "#b37feb", "#ffffff", "#111111"];

let seq = 0;
export const shapeId = () => `s${Date.now().toString(36)}${(++seq).toString(36)}`;

// ------------------------------------------------------------------ geometry

export const centre = (s: Shape): Pt => [s.x + s.w / 2, s.y + s.h / 2];

export function rotatePt(p: Pt, c: Pt, deg: number): Pt {
  const a = (deg * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const dx = p[0] - c[0];
  const dy = p[1] - c[1];
  return [c[0] + dx * cos - dy * sin, c[1] + dx * sin + dy * cos];
}

/** A content point in the shape's own unturned frame. */
export const toLocal = (s: Shape, p: Pt): Pt => rotatePt(p, centre(s), -s.rot);

/** Bounds of a list of points. */
export function bounds(pts: Pt[]): { x: number; y: number; w: number; h: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** The four corners of the turned box. */
export function corners(s: Shape): Pt[] {
  const c = centre(s);
  return (
    [
      [s.x, s.y],
      [s.x + s.w, s.y],
      [s.x + s.w, s.y + s.h],
      [s.x, s.y + s.h],
    ] as Pt[]
  ).map((p) => rotatePt(p, c, s.rot));
}

/** Axis-aligned bounds of what the shape draws (stroke included). */
export function drawnBounds(s: Shape): { x: number; y: number; w: number; h: number } {
  const pad = s.kind === "text" ? (s.size ?? 64) * 0.15 : s.width * 2 + (s.kind === "arrow" ? s.width * 4 + 8 : 2);
  const b = IS_LINE(s.kind) && s.pts ? bounds(s.pts) : bounds(corners(s));
  return { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
}

function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Is content point `p` on the shape? `tol` is in content pixels. */
export function hit(s: Shape, p: Pt, tol: number): boolean {
  if (s.hidden) return false;
  if (IS_LINE(s.kind) && s.pts) return segDist(p, s.pts[0], s.pts[1]) <= tol + s.width / 2;
  const [lx, ly] = toLocal(s, p);
  const inBox = lx >= s.x - tol && lx <= s.x + s.w + tol && ly >= s.y - tol && ly <= s.y + s.h + tol;
  if (!inBox) return false;
  if ((s.kind === "rect" || s.kind === "ellipse") && !s.fill) {
    // Hollow shapes: only near the outline (so things inside stay clickable).
    const edge = tol + s.width;
    if (s.kind === "rect") {
      return lx < s.x + edge || lx > s.x + s.w - edge || ly < s.y + edge || ly > s.y + s.h - edge;
    }
    const rx = s.w / 2;
    const ry = s.h / 2;
    const [cx, cy] = centre(s);
    const d = Math.hypot((lx - cx) / Math.max(rx, 1), (ly - cy) / Math.max(ry, 1));
    return Math.abs(d - 1) * Math.min(rx, ry) <= edge;
  }
  if ((s.kind === "pen" || s.kind === "highlight") && s.strokes) {
    const local = (q: Pt): Pt => [s.x + q[0] * s.w, s.y + q[1] * s.h];
    const lp: Pt = [lx, ly];
    for (const st of s.strokes) for (let k = 1; k < st.length; k++) if (segDist(lp, local(st[k - 1]), local(st[k])) <= tol + s.width / 2) return true;
    return st1(s, lp, tol);
  }
  return true;
}

function st1(s: Shape, p: Pt, tol: number): boolean {
  // A single dot.
  return !!s.strokes?.some((st) => st.length === 1 && Math.hypot(p[0] - (s.x + st[0][0] * s.w), p[1] - (s.y + st[0][1] * s.h)) <= tol + s.width);
}

export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "rot" | "p0" | "p1";

/** Handle positions in content pixels (turned with the shape). */
export function handlePoints(s: Shape, rotGap: number): { h: Handle; p: Pt }[] {
  if (IS_LINE(s.kind) && s.pts) {
    return [
      { h: "p0", p: s.pts[0] },
      { h: "p1", p: s.pts[1] },
    ];
  }
  const c = centre(s);
  const { x, y, w, h } = s;
  const raw: { h: Handle; p: Pt }[] = [
    { h: "nw", p: [x, y] },
    { h: "n", p: [x + w / 2, y] },
    { h: "ne", p: [x + w, y] },
    { h: "e", p: [x + w, y + h / 2] },
    { h: "se", p: [x + w, y + h] },
    { h: "s", p: [x + w / 2, y + h] },
    { h: "sw", p: [x, y + h] },
    { h: "w", p: [x, y + h / 2] },
  ];
  if (!NO_ROTATE.has(s.kind)) raw.push({ h: "rot", p: [x + w / 2, y - rotGap] });
  return raw.map((r) => ({ h: r.h, p: rotatePt(r.p, c, s.rot) }));
}

/** Moves a shape by dx, dy. */
export function moveBy(s: Shape, dx: number, dy: number): Shape {
  return {
    ...s,
    x: s.x + dx,
    y: s.y + dy,
    pts: s.pts?.map(([x, y]) => [x + dx, y + dy] as Pt),
  };
}

/** Line/arrow: refreshes the box from the end points. */
export function fromPts(s: Shape, pts: Pt[]): Shape {
  const b = bounds(pts);
  return { ...s, pts, x: b.x, y: b.y, w: b.w, h: b.h, rot: 0 };
}

export interface ResizeOpts {
  /** Shift: keeps the shape (or frees it, for kinds that keep it by default). */
  shift?: boolean;
  /** Alt: resizes about the centre. */
  fromCentre?: boolean;
}

/** Drags handle `h` of the shape as it was at drag start (`s0`) to content point `p`. */
export function resize(s0: Shape, h: Handle, p: Pt, o: ResizeOpts = {}): Shape {
  if (IS_LINE(s0.kind) && s0.pts) {
    const pts = s0.pts.slice() as Pt[];
    let q = p;
    if (o.shift) {
      // Snap the angle to 15° steps around the other end.
      const other = pts[h === "p0" ? 1 : 0];
      const ang = Math.atan2(q[1] - other[1], q[0] - other[0]);
      const step = Math.PI / 12;
      const a = Math.round(ang / step) * step;
      const len = Math.hypot(q[0] - other[0], q[1] - other[1]);
      q = [other[0] + Math.cos(a) * len, other[1] + Math.sin(a) * len];
    }
    pts[h === "p0" ? 0 : 1] = q;
    return fromPts(s0, pts);
  }
  const c = centre(s0);
  const [lx, ly] = rotatePt(p, c, -s0.rot);
  let x0 = s0.x;
  let y0 = s0.y;
  let x1 = s0.x + s0.w;
  let y1 = s0.y + s0.h;
  const moveW = h.includes("w");
  const moveE = h.includes("e");
  const moveN = h.includes("n");
  const moveS = h.includes("s");
  if (moveW) x0 = Math.min(lx, x1 - MIN_SIDE);
  if (moveE) x1 = Math.max(lx, x0 + MIN_SIDE);
  if (moveN) y0 = Math.min(ly, y1 - MIN_SIDE);
  if (moveS) y1 = Math.max(ly, y0 + MIN_SIDE);
  const keep = KEEP_ASPECT.has(s0.kind) ? !o.shift : !!o.shift;
  const corner = (moveW || moveE) && (moveN || moveS);
  if (keep && (corner || KEEP_ASPECT.has(s0.kind))) {
    const ratio = s0.h / Math.max(s0.w, 1e-6);
    const sx = (x1 - x0) / s0.w;
    const sy = (y1 - y0) / s0.h;
    const k = corner ? Math.max(sx, sy) : moveW || moveE ? sx : sy;
    const w = Math.max(MIN_SIDE, s0.w * k);
    const hh = Math.max(MIN_SIDE, w * ratio);
    if (moveW) x0 = x1 - w;
    else if (moveE) x1 = x0 + w;
    else {
      const cx = (s0.x + s0.x + s0.w) / 2;
      x0 = cx - w / 2;
      x1 = cx + w / 2;
    }
    if (moveN) y0 = y1 - hh;
    else if (moveS) y1 = y0 + hh;
    else {
      const cy = (s0.y + s0.y + s0.h) / 2;
      y0 = cy - hh / 2;
      y1 = cy + hh / 2;
    }
  }
  if (o.fromCentre) {
    // Mirror the change to the other side.
    const cx = s0.x + s0.w / 2;
    const cy = s0.y + s0.h / 2;
    if (moveW) x1 = 2 * cx - x0;
    else if (moveE) x0 = 2 * cx - x1;
    if (moveN) y1 = 2 * cy - y0;
    else if (moveS) y0 = 2 * cy - y1;
  }
  // The new box in the old frame; its centre moved, so place it back in content space.
  const nc = rotatePt([(x0 + x1) / 2, (y0 + y1) / 2], c, s0.rot);
  const w = x1 - x0;
  const hh = y1 - y0;
  const out: Shape = { ...s0, x: nc[0] - w / 2, y: nc[1] - hh / 2, w, h: hh };
  if (s0.kind === "text") {
    // Text grows by its letter size; the box follows the text.
    out.size = Math.max(6, Math.round((s0.size ?? 64) * (w / s0.w) * 10) / 10);
  }
  return out;
}

/** Turns the shape so the handle follows `p`; Shift snaps to 15°. */
export function rotateTo(s0: Shape, start: Pt, p: Pt, snap: boolean): Shape {
  const c = centre(s0);
  if (IS_LINE(s0.kind) && s0.pts) {
    let d = ((Math.atan2(p[1] - c[1], p[0] - c[0]) - Math.atan2(start[1] - c[1], start[0] - c[0])) * 180) / Math.PI;
    if (snap) d = Math.round(d / 15) * 15;
    return fromPts(s0, s0.pts.map((q) => rotatePt(q, c, d)));
  }
  let deg = s0.rot + ((Math.atan2(p[1] - c[1], p[0] - c[0]) - Math.atan2(start[1] - c[1], start[0] - c[0])) * 180) / Math.PI;
  if (snap) deg = Math.round(deg / 15) * 15;
  return { ...s0, rot: normDeg(deg) };
}

export function normDeg(d: number): number {
  let r = d % 360;
  if (r > 180) r -= 360;
  if (r <= -180) r += 360;
  return Math.round(r * 100) / 100;
}

/** Turns by a fixed amount (R / Shift+R). */
export function rotateBy(s: Shape, deg: number): Shape {
  if (NO_ROTATE.has(s.kind)) return s;
  if (IS_LINE(s.kind) && s.pts) return fromPts(s, s.pts.map((q) => rotatePt(q, centre(s), deg)));
  return { ...s, rot: normDeg(s.rot + deg) };
}

export function flip(s: Shape, axis: "x" | "y"): Shape {
  if (IS_LINE(s.kind) && s.pts) {
    const [cx, cy] = centre(s);
    return fromPts(
      s,
      s.pts.map(([x, y]) => (axis === "x" ? [2 * cx - x, y] : [x, 2 * cy - y]) as Pt),
    );
  }
  return axis === "x" ? { ...s, flipX: !s.flipX } : { ...s, flipY: !s.flipY };
}

/** Z-order: moves ids forward (+1), back (-1), to front (+Inf) or back (-Inf). */
export function reorder<T extends { id: string }>(list: T[], ids: Set<string>, dir: number): T[] {
  const out = list.slice();
  if (dir === Infinity || dir === -Infinity) {
    const sel = out.filter((s) => ids.has(s.id));
    const rest = out.filter((s) => !ids.has(s.id));
    return dir > 0 ? [...rest, ...sel] : [...sel, ...rest];
  }
  const idx = out.map((s, i) => (ids.has(s.id) ? i : -1)).filter((i) => i >= 0);
  if (dir > 0) {
    for (const i of idx.reverse()) if (i + 1 < out.length && !ids.has(out[i + 1].id)) [out[i], out[i + 1]] = [out[i + 1], out[i]];
  } else {
    for (const i of idx) if (i > 0 && !ids.has(out[i - 1].id)) [out[i], out[i - 1]] = [out[i - 1], out[i]];
  }
  return out;
}

/** Pen strokes in content pixels → a pen shape (box + 0-1 strokes). */
export function penShape(base: Omit<Shape, "x" | "y" | "w" | "h" | "strokes">, strokes: Pt[][]): Shape {
  const all = strokes.flat();
  const b = bounds(all.length ? all : [[0, 0]]);
  const w = Math.max(b.w, 1);
  const h = Math.max(b.h, 1);
  return {
    ...base,
    x: b.x,
    y: b.y,
    w,
    h,
    strokes: strokes.map((st) => st.map(([x, y]) => [(x - b.x) / w, (y - b.y) / h] as Pt)),
  } as Shape;
}

/** Adds a stroke (content pixels) to an existing pen shape (which must be unturned). */
export function addStroke(s: Shape, stroke: Pt[]): Shape {
  const old = (s.strokes ?? []).map((st) => st.map(([u, v]) => [s.x + u * s.w, s.y + v * s.h] as Pt));
  return penShape(s, [...old, stroke]);
}

/** Simplifies a freehand stroke (drops points closer than `min` px). */
export function thin(points: Pt[], min = 1.5): Pt[] {
  const out: Pt[] = [];
  for (const p of points) {
    const l = out[out.length - 1];
    if (!l || Math.hypot(p[0] - l[0], p[1] - l[1]) >= min) out.push(p);
  }
  return out;
}

// ------------------------------------------------------------------ text

export const TEXT_FONT = '"Segoe UI", system-ui, sans-serif';
export const TEXT_PAD = 0.25;

export function fontOf(s: Pick<Shape, "size" | "bold" | "italic">): string {
  return `${s.italic ? "italic " : ""}${s.bold === false ? 500 : 700} ${s.size ?? 64}px ${TEXT_FONT}`;
}

let measureCtx: CanvasRenderingContext2D | null = null;
function ctx2d(): CanvasRenderingContext2D | null {
  if (measureCtx) return measureCtx;
  if (typeof document === "undefined") return null;
  measureCtx = document.createElement("canvas").getContext("2d");
  return measureCtx;
}

/** Box size of a text shape from its text and letter size. */
export function measureText(s: Pick<Shape, "text" | "size" | "bold" | "italic">): { w: number; h: number } {
  const size = s.size ?? 64;
  const lines = (s.text || " ").split("\n");
  const g = ctx2d();
  let wMax = 0;
  if (g) {
    g.font = fontOf(s);
    for (const l of lines) wMax = Math.max(wMax, g.measureText(l || " ").width);
  } else wMax = Math.max(...lines.map((l) => Math.max(1, l.length))) * size * 0.55;
  const pad = size * TEXT_PAD;
  return { w: Math.ceil(wMax + pad * 2), h: Math.ceil(lines.length * size * 1.2 + pad * 2) };
}

/** Re-fits a text shape's box to its text, keeping the box centre. */
export function fitText(s: Shape): Shape {
  if (s.kind !== "text") return s;
  const m = measureText(s);
  const [cx, cy] = centre(s);
  // Keep the side the text is aligned to still when the text is upright.
  if (!s.rot) {
    const x = s.align === "right" ? s.x + s.w - m.w : s.align === "center" ? cx - m.w / 2 : s.x;
    return { ...s, x, w: m.w, h: m.h };
  }
  return { ...s, x: cx - m.w / 2, y: cy - m.h / 2, w: m.w, h: m.h };
}

/** Aligns shapes to each other (several) or to the frame (one). Returns moved copies. */
export function align(shapes: Shape[], how: "left" | "centre" | "right" | "top" | "middle" | "bottom", frame: { w: number; h: number }): Shape[] {
  if (!shapes.length) return shapes;
  const boxes = shapes.map((s) => bounds(corners(s)));
  const ref =
    shapes.length > 1
      ? bounds(boxes.flatMap((b) => [[b.x, b.y] as Pt, [b.x + b.w, b.y + b.h] as Pt]))
      : { x: 0, y: 0, w: frame.w, h: frame.h };
  return shapes.map((s, k) => {
    const b = boxes[k];
    let dx = 0;
    let dy = 0;
    if (how === "left") dx = ref.x - b.x;
    if (how === "right") dx = ref.x + ref.w - (b.x + b.w);
    if (how === "centre") dx = ref.x + ref.w / 2 - (b.x + b.w / 2);
    if (how === "top") dy = ref.y - b.y;
    if (how === "bottom") dy = ref.y + ref.h - (b.y + b.h);
    if (how === "middle") dy = ref.y + ref.h / 2 - (b.y + b.h / 2);
    return moveBy(s, dx, dy);
  });
}
