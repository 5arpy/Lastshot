/**
 * Viewer maths: zoom, pan, rotate and flip of a picture inside a stage, and
 * mapping points between the stage and the picture's own pixels.
 *
 * The picture ("content") is `cw × ch` pixels. Its centre sits at stage point
 * (x, y) (CSS px). It is flipped in its own axes, scaled by `scale` (CSS px
 * per picture px) and rotated by `rot` degrees clockwise:
 *
 *   stage = (x, y) + R(rot) · (scale·fx·(px − cw/2), scale·fy·(py − ch/2))
 *
 * where fx/fy are −1 when flipped. Everything here is pure so it can be unit
 * tested and shared by the clip viewer, the snip editor and pop-out frames.
 */

export interface View {
  /** CSS px per picture px. */
  scale: number;
  /** Stage point (CSS px) under the picture's centre. */
  x: number;
  y: number;
  /** Clockwise, degrees. */
  rot: number;
  flipH: boolean;
  flipV: boolean;
}

export interface Size {
  w: number;
  h: number;
}

export interface Pt {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Zoom limits, as device pixels per picture pixel (1 = 100 %). */
export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 64;

export const IDENTITY: View = { scale: 1, x: 0, y: 0, rot: 0, flipH: false, flipV: false };

const rad = (deg: number) => (deg * Math.PI) / 180;

/** Keeps an angle in (−180, 180]. */
export function normAngle(deg: number): number {
  let a = deg % 360;
  if (a <= -180) a += 360;
  if (a > 180) a -= 360;
  return Math.abs(a) < 1e-9 ? 0 : a;
}

/** Size of the picture's bounding box once rotated (unscaled). */
export function rotatedBox(content: Size, rot: number): Size {
  const c = Math.abs(Math.cos(rad(rot)));
  const s = Math.abs(Math.sin(rad(rot)));
  return { w: content.w * c + content.h * s, h: content.w * s + content.h * c };
}

/** Scale that fits the whole (rotated) picture into the stage. */
export function fitScale(content: Size, stage: Size, rot = 0, margin = 0): number {
  const b = rotatedBox(content, rot);
  if (b.w <= 0 || b.h <= 0) return 1;
  return Math.max(1e-6, Math.min((stage.w - margin * 2) / b.w, (stage.h - margin * 2) / b.h));
}

/** Scale that fills the stage (crops the picture's overflow). */
export function fillScale(content: Size, stage: Size, rot = 0): number {
  const b = rotatedBox(content, rot);
  if (b.w <= 0 || b.h <= 0) return 1;
  return Math.max(stage.w / b.w, stage.h / b.h);
}

/** A view that shows the picture at `scale`, centred, keeping rotation and flips. */
export function centred(view: View, stage: Size, scale: number): View {
  return { ...view, scale, x: stage.w / 2, y: stage.h / 2 };
}

export function fitView(content: Size, stage: Size, view: View = IDENTITY): View {
  return centred(view, stage, fitScale(content, stage, view.rot));
}

export function fillView(content: Size, stage: Size, view: View = IDENTITY): View {
  return centred(view, stage, fillScale(content, stage, view.rot));
}

/** 100 %: one picture pixel on one screen (device) pixel. */
export function actualView(stage: Size, view: View, dpr: number): View {
  return centred(view, stage, 1 / (dpr || 1));
}

/** Zoom as shown to the user: device px per picture px (1 = 100 %). */
export function zoomPercent(view: View, dpr: number): number {
  return view.scale * (dpr || 1) * 100;
}

/** Nearest-neighbour rendering once a picture pixel covers more than one screen pixel. */
export function pixelated(view: View, dpr: number): boolean {
  return view.scale * (dpr || 1) > 1.0001;
}

/** Clamp a scale to the zoom limits (given in device px per picture px). */
export function clampScale(scale: number, dpr: number, minScale?: number): number {
  const d = dpr || 1;
  const lo = Math.min(MIN_ZOOM / d, minScale ?? Infinity);
  return Math.min(MAX_ZOOM / d, Math.max(lo, scale));
}

/**
 * Zooms by `factor` keeping the picture point under `at` (a stage point)
 * where it is.
 */
export function zoomAt(view: View, at: Pt, factor: number, dpr = 1, minScale?: number): View {
  const scale = clampScale(view.scale * factor, dpr, minScale);
  const k = scale / view.scale;
  return { ...view, scale, x: at.x + (view.x - at.x) * k, y: at.y + (view.y - at.y) * k };
}

/** Zooms to an exact scale around a stage point. */
export function zoomTo(view: View, at: Pt, scale: number, dpr = 1): View {
  return zoomAt(view, at, scale / view.scale, dpr);
}

/** Wheel delta → zoom factor (one notch ≈ ×1.2; trackpads give smaller steps). */
export function wheelFactor(deltaY: number, deltaMode = 0): number {
  const px = deltaMode === 1 ? deltaY * 33 : deltaMode === 2 ? deltaY * 400 : deltaY;
  const clamped = Math.max(-300, Math.min(300, px));
  return Math.pow(1.2, -clamped / 100);
}

export function pan(view: View, dx: number, dy: number): View {
  return { ...view, x: view.x + dx, y: view.y + dy };
}

/**
 * Keeps at least `keep` CSS px of the picture inside the stage, so it can
 * never be panned out of sight.
 */
export function clampPan(view: View, content: Size, stage: Size, keep = 48): View {
  const b = rotatedBox(content, view.rot);
  const hw = (b.w * view.scale) / 2;
  const hh = (b.h * view.scale) / 2;
  const kx = Math.min(keep, hw * 2);
  const ky = Math.min(keep, hh * 2);
  const x = Math.min(stage.w - kx + hw, Math.max(kx - hw, view.x));
  const y = Math.min(stage.h - ky + hh, Math.max(ky - hh, view.y));
  return x === view.x && y === view.y ? view : { ...view, x, y };
}

/** Rotates around a stage point (default: the picture's centre). */
export function rotateBy(view: View, deg: number, around?: Pt): View {
  const rot = normAngle(view.rot + deg);
  if (!around) return { ...view, rot };
  const a = rad(deg);
  const dx = view.x - around.x;
  const dy = view.y - around.y;
  return {
    ...view,
    rot,
    x: around.x + dx * Math.cos(a) - dy * Math.sin(a),
    y: around.y + dx * Math.sin(a) + dy * Math.cos(a),
  };
}

/** Snaps a free angle to the nearest multiple of 90° when within `tol` degrees. */
export function snapAngle(deg: number, tol = 3): number {
  const n = Math.round(deg / 90) * 90;
  return Math.abs(deg - n) <= tol ? normAngle(n) : normAngle(deg);
}

/**
 * Mirrors the picture left↔right *as seen on screen*, whatever its rotation.
 * (A flip in the picture's own axes followed by rotation θ equals rotation −θ
 * followed by the flip: F·R(θ) = R(−θ)·F.)
 */
export function flipScreenH(view: View): View {
  return { ...view, flipH: !view.flipH, rot: normAngle(-view.rot) };
}

/** Mirrors top↔bottom as seen on screen. */
export function flipScreenV(view: View): View {
  return { ...view, flipV: !view.flipV, rot: normAngle(-view.rot) };
}

/** 2-D affine matrix [a, b, c, d, e, f] as used by canvas `setTransform`. */
export type Mat = [number, number, number, number, number, number];

/** Picture px → stage CSS px. */
export function matrix(view: View, content: Size): Mat {
  const a = rad(view.rot);
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const sx = view.scale * (view.flipH ? -1 : 1);
  const sy = view.scale * (view.flipV ? -1 : 1);
  // [cos −sin; sin cos] · diag(sx, sy)
  const ma = cos * sx;
  const mb = sin * sx;
  const mc = -sin * sy;
  const md = cos * sy;
  const e = view.x - ma * (content.w / 2) - mc * (content.h / 2);
  const f = view.y - mb * (content.w / 2) - md * (content.h / 2);
  return [ma, mb, mc, md, e, f];
}

export function apply(m: Mat, p: Pt): Pt {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

export function invert(m: Mat): Mat {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c || 1e-12;
  const ia = d / det;
  const ib = -b / det;
  const ic = -c / det;
  const id = a / det;
  return [ia, ib, ic, id, -(ia * e + ic * f), -(ib * e + id * f)];
}

/** Scales a matrix (e.g. CSS px → device px for a canvas). */
export function scaleMat(m: Mat, k: number): Mat {
  return [m[0] * k, m[1] * k, m[2] * k, m[3] * k, m[4] * k, m[5] * k];
}

/** Stage point → picture point (fractional pixels). */
export function toContent(view: View, content: Size, p: Pt): Pt {
  return apply(invert(matrix(view, content)), p);
}

/** Picture point → stage point. */
export function toStage(view: View, content: Size, p: Pt): Pt {
  return apply(matrix(view, content), p);
}

/** The picture pixel under a stage point, or null when outside the picture. */
export function pixelAt(view: View, content: Size, p: Pt): Pt | null {
  const c = toContent(view, content, p);
  const x = Math.floor(c.x);
  const y = Math.floor(c.y);
  if (x < 0 || y < 0 || x >= content.w || y >= content.h) return null;
  return { x, y };
}

/** A view that puts the picture exactly over a stage rectangle (no rotation). */
export function viewForRect(content: Size, r: Rect): View {
  return { ...IDENTITY, scale: content.w > 0 ? r.w / content.w : 1, x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/** True when two views are the same within a hair (for "reset" states). */
export function sameView(a: View, b: View, eps = 1e-3): boolean {
  return (
    Math.abs(a.scale - b.scale) < eps * Math.max(1, a.scale) &&
    Math.abs(a.x - b.x) < 0.5 &&
    Math.abs(a.y - b.y) < 0.5 &&
    Math.abs(normAngle(a.rot - b.rot)) < 0.01 &&
    a.flipH === b.flipH &&
    a.flipV === b.flipV
  );
}

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

export function hex(r: number, g: number, b: number): string {
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`.toUpperCase();
}

/** Rec. 709 luma, 0–255: what a grey "value check" shows. */
export function luma(r: number, g: number, b: number): number {
  return Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
}

export function hsl(r: number, g: number, b: number): [number, number, number] {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, Math.round(l * 100)];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  h *= 60;
  return [Math.round(h), Math.round(s * 100), Math.round(l * 100)];
}

// ---------------------------------------------------------------------------
// Grids
// ---------------------------------------------------------------------------

export type GridKind = "off" | "thirds" | "custom";

export interface GridSpec {
  kind: GridKind;
  cols: number;
  rows: number;
  color: string;
  /** 0–1 */
  opacity: number;
  diagonals: boolean;
}

export const DEFAULT_GRID: GridSpec = { kind: "off", cols: 4, rows: 4, color: "#00e5ff", opacity: 0.7, diagonals: false };

/** Lines of a grid over a w×h area, in that area's pixels. */
export function gridLines(spec: GridSpec, w: number, h: number): { x1: number; y1: number; x2: number; y2: number }[] {
  if (spec.kind === "off" || w <= 0 || h <= 0) return [];
  const cols = spec.kind === "thirds" ? 3 : Math.max(1, Math.min(64, Math.round(spec.cols)));
  const rows = spec.kind === "thirds" ? 3 : Math.max(1, Math.min(64, Math.round(spec.rows)));
  const out: { x1: number; y1: number; x2: number; y2: number }[] = [];
  for (let i = 1; i < cols; i++) {
    const x = (w * i) / cols;
    out.push({ x1: x, y1: 0, x2: x, y2: h });
  }
  for (let j = 1; j < rows; j++) {
    const y = (h * j) / rows;
    out.push({ x1: 0, y1: y, x2: w, y2: y });
  }
  if (spec.diagonals) {
    out.push({ x1: 0, y1: 0, x2: w, y2: h }, { x1: w, y1: 0, x2: 0, y2: h });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------

export interface Measure {
  dx: number;
  dy: number;
  length: number;
  /** Degrees, 0 = right, counter-clockwise positive (as on a protractor). */
  angle: number;
}

export function measure(a: Pt, b: Pt): Measure {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const angle = normAngle((Math.atan2(-dy, dx) * 180) / Math.PI);
  return { dx, dy, length: Math.hypot(dx, dy), angle };
}

// ---------------------------------------------------------------------------
// Video
// ---------------------------------------------------------------------------

export const SPEEDS = [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

export function nextSpeed(cur: number, dir: 1 | -1): number {
  if (dir > 0) return SPEEDS.find((s) => s > cur + 1e-6) ?? SPEEDS[SPEEDS.length - 1];
  return [...SPEEDS].reverse().find((s) => s < cur - 1e-6) ?? SPEEDS[0];
}

/**
 * Time of the frame `n` frames away from `t`. Lands in the middle of the
 * target frame so decoders never round to its neighbour.
 */
export function stepTime(t: number, n: number, fps: number, duration: number): number {
  const f = fps > 0 ? fps : 30;
  const idx = Math.floor(t * f + 1e-4) + n;
  const last = Math.max(0, Math.floor(duration * f - 1e-4));
  const clamped = Math.max(0, Math.min(last, idx));
  return Math.min(duration, (clamped + 0.5) / f);
}

export function frameIndex(t: number, fps: number): number {
  return Math.floor(t * (fps > 0 ? fps : 30) + 1e-4);
}

export interface LoopRange {
  a: number | null;
  b: number | null;
}

/** Where playback should jump to (or null to carry on) for the loop settings. */
export function loopJump(t: number, duration: number, loopAll: boolean, ab: LoopRange): number | null {
  if (ab.a !== null && ab.b !== null && Math.abs(ab.b - ab.a) > 0.02) {
    const a = Math.min(ab.a, ab.b);
    const b = Math.max(ab.a, ab.b);
    if (t >= b - 0.01 || t < a - 0.05) return a;
    return null;
  }
  if (loopAll && duration > 0 && t >= duration - 0.03) return 0;
  return null;
}

// ---------------------------------------------------------------------------
// Picture adjustments (CSS / canvas filter strings)
// ---------------------------------------------------------------------------

export interface Adjust {
  /** 1 = unchanged */
  brightness: number;
  contrast: number;
  saturation: number;
  /** degrees */
  hue: number;
  /** 0–1 */
  grayscale: number;
  invert: boolean;
  /** Tint colour and strength 0–1 (0 = none). */
  tint: string;
  tintAmount: number;
}

export const NO_ADJUST: Adjust = {
  brightness: 1,
  contrast: 1,
  saturation: 1,
  hue: 0,
  grayscale: 0,
  invert: false,
  tint: "#ff8800",
  tintAmount: 0,
};

export function filterString(a: Adjust): string {
  const parts: string[] = [];
  if (a.brightness !== 1) parts.push(`brightness(${round(a.brightness)})`);
  if (a.contrast !== 1) parts.push(`contrast(${round(a.contrast)})`);
  if (a.saturation !== 1) parts.push(`saturate(${round(a.saturation)})`);
  if (a.hue !== 0) parts.push(`hue-rotate(${round(a.hue)}deg)`);
  if (a.grayscale > 0) parts.push(`grayscale(${round(a.grayscale)})`);
  if (a.invert) parts.push("invert(1)");
  return parts.length ? parts.join(" ") : "none";
}

export function isNeutral(a: Adjust): boolean {
  return filterString(a) === "none" && a.tintAmount <= 0;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** Clamps a crop rectangle (picture px) to the picture and to at least 2×2. */
export function clampCrop(r: Rect, content: Size): Rect {
  const x = Math.max(0, Math.min(content.w - 2, Math.round(Math.min(r.x, r.x + r.w))));
  const y = Math.max(0, Math.min(content.h - 2, Math.round(Math.min(r.y, r.y + r.h))));
  const w = Math.max(2, Math.min(content.w - x, Math.round(Math.abs(r.w))));
  const h = Math.max(2, Math.min(content.h - y, Math.round(Math.abs(r.h))));
  return { x, y, w, h };
}
