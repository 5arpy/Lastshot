/**
 * Draws the viewer's stage on a 2-D canvas: the picture through the view
 * matrix (nearest-neighbour above 100 %), colour adjustments, compare modes,
 * onion-skin ghosts and the overlays (grids, pixel grid, hovered pixel,
 * measuring line). Canvas drawImage with a transform runs on the GPU in
 * Chromium/WebView2, and the source (a <video>, <img> or <canvas>) is never
 * decoded again on zoom.
 */
import {
  apply,
  filterString,
  gridLines,
  invert,
  matrix,
  measure,
  pixelated,
  scaleMat,
  type Adjust,
  type GridSpec,
  type Mat,
  type Pt,
  type Rect,
  type Size,
  type View,
} from "./math";

export type CompareMode = "off" | "wipe" | "diff" | "side";

export interface CompareSource {
  source: CanvasImageSource;
  size: Size;
}

export interface Ghost {
  source: CanvasImageSource;
  /** −1, −2 … before; 1, 2 … after */
  offset: number;
}

export interface Scene {
  source: CanvasImageSource | null;
  /** Natural size of the source. */
  natural: Size;
  crop: Rect | null;
  view: View;
  stage: Size;
  dpr: number;
  adjust: Adjust;
  mono: boolean;
  grid: GridSpec;
  background: "dark" | "checker" | "none";
  compare: CompareMode;
  compareWith: CompareSource | null;
  /** 0–1 across the stage. */
  wipe: number;
  ghosts: Ghost[];
  ghostOpacity: number;
  /** Picture pixel to outline (pixel inspector). */
  hoverPixel: Pt | null;
  /** Measuring line, in picture px. */
  measureLine: { a: Pt; b: Pt } | null;
  /** Crop being dragged, in picture px. */
  cropDraft: Rect | null;
  /** "low" while zooming / panning / playing, "high" once settled. */
  quality: "low" | "high";
}

/** The size the view works in: the crop when there is one. */
export function contentSize(natural: Size, crop: Rect | null): Size {
  return crop ? { w: crop.w, h: crop.h } : natural;
}

/** For side-by-side compare: the two half-stages and their views. */
export function sideViews(view: View, stage: Size): { left: View; right: View; half: number } {
  const half = stage.w / 2;
  return {
    half,
    left: { ...view, x: view.x - half / 2 },
    right: { ...view, x: view.x + half / 2 },
  };
}

let checker: CanvasPattern | null = null;
function checkerPattern(g: CanvasRenderingContext2D): CanvasPattern | null {
  if (checker) return checker;
  const c = document.createElement("canvas");
  c.width = c.height = 16;
  const t = c.getContext("2d")!;
  t.fillStyle = "#2a2d37";
  t.fillRect(0, 0, 16, 16);
  t.fillStyle = "#363a46";
  t.fillRect(0, 0, 8, 8);
  t.fillRect(8, 8, 8, 8);
  checker = g.createPattern(c, "repeat");
  return checker;
}

/** Bilinear below 100 %, nearest-neighbour above; "high" (mipmapped) only once settled. */
function smoothing(s: Scene, view: View = s.view): false | "low" | "high" {
  if (pixelated(view, s.dpr)) return false;
  return s.quality;
}

function drawPicture(
  g: CanvasRenderingContext2D,
  src: CanvasImageSource,
  natural: Size,
  crop: Rect | null,
  m: Mat,
  smooth: false | "low" | "high",
  filter: string,
  alpha = 1,
) {
  const c = contentSize(natural, crop);
  g.save();
  g.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
  g.imageSmoothingEnabled = smooth !== false;
  if (smooth) g.imageSmoothingQuality = smooth;
  g.filter = filter;
  g.globalAlpha = alpha;
  if (crop) g.drawImage(src, crop.x, crop.y, crop.w, crop.h, 0, 0, c.w, c.h);
  else g.drawImage(src, 0, 0, natural.w, natural.h);
  g.restore();
}

/** Clip to the picture's quad (device px). */
function clipToPicture(g: CanvasRenderingContext2D, m: Mat, c: Size) {
  const pts = [
    apply(m, { x: 0, y: 0 }),
    apply(m, { x: c.w, y: 0 }),
    apply(m, { x: c.w, y: c.h }),
    apply(m, { x: 0, y: c.h }),
  ];
  g.beginPath();
  g.moveTo(pts[0].x, pts[0].y);
  for (const p of pts.slice(1)) g.lineTo(p.x, p.y);
  g.closePath();
  g.clip();
}

function drawOne(g: CanvasRenderingContext2D, s: Scene, view: View, src: CanvasImageSource, srcNatural: Size, crop: Rect | null) {
  const c = contentSize(s.natural, s.crop);
  const m = scaleMat(matrix(view, c), s.dpr);
  const smooth = smoothing(s, view);
  const filter = "none";
  // A compare picture of another size is stretched over the same box.
  if (srcNatural.w !== s.natural.w || srcNatural.h !== s.natural.h) {
    const k: Mat = [c.w / srcNatural.w, 0, 0, c.h / srcNatural.h, 0, 0];
    const mm: Mat = [m[0] * k[0], m[1] * k[0], m[2] * k[3], m[3] * k[3], m[4], m[5]];
    drawPicture(g, src, srcNatural, null, mm, smooth, filter);
  } else {
    drawPicture(g, src, s.natural, crop, m, smooth, filter);
  }
  if (s.adjust.tintAmount > 0) {
    g.save();
    clipToPicture(g, m, c);
    g.globalCompositeOperation = "color";
    g.globalAlpha = Math.min(1, s.adjust.tintAmount);
    g.fillStyle = s.adjust.tint;
    g.fillRect(0, 0, s.stage.w * s.dpr, s.stage.h * s.dpr);
    g.restore();
  }
  return m;
}

function prep(g: CanvasRenderingContext2D, s: Scene) {
  const W = Math.round(s.stage.w * s.dpr);
  const H = Math.round(s.stage.h * s.dpr);
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = "source-over";
  g.globalAlpha = 1;
  g.filter = "none";
  g.clearRect(0, 0, W, H);
  return { W, H };
}

/**
 * Layer 1: background and picture A (plus onion-skin ghosts, tint, and B for
 * side by side). Colour adjustments are a CSS filter on this canvas
 * (`cssFilter`), which the GPU compositor applies for free.
 */
export function drawBase(g: CanvasRenderingContext2D, s: Scene) {
  const { W, H } = prep(g, s);
  if (s.background === "dark") {
    g.fillStyle = "#0a0c10";
    g.fillRect(0, 0, W, H);
  } else if (s.background === "checker") {
    const p = checkerPattern(g);
    if (p) {
      g.fillStyle = p;
      g.fillRect(0, 0, W, H);
    }
  }
  if (!s.source || s.natural.w <= 0 || s.natural.h <= 0) return;

  if (s.compare === "side" && s.compareWith) {
    const { left, right, half } = sideViews(s.view, s.stage);
    g.save();
    g.beginPath();
    g.rect(0, 0, half * s.dpr, H);
    g.clip();
    drawOne(g, s, left, s.source, s.natural, s.crop);
    g.restore();
    g.save();
    g.beginPath();
    g.rect(half * s.dpr, 0, W - half * s.dpr, H);
    g.clip();
    drawOne(g, s, right, s.compareWith.source, s.compareWith.size, null);
    g.restore();
    return;
  }

  const m = drawOne(g, s, s.view, s.source, s.natural, s.crop);
  for (const gh of s.ghosts) {
    const tint = gh.offset < 0 ? "sepia(1) saturate(6) hue-rotate(-50deg)" : "sepia(1) saturate(6) hue-rotate(75deg)";
    const a = s.ghostOpacity / Math.abs(gh.offset);
    drawPicture(g, gh.source, s.natural, s.crop, m, smoothing(s), tint, a);
  }
}

/**
 * Layer 2: picture B for wipe / difference. The page clips it (wipe) or
 * blends it with `mix-blend-mode: difference` on the GPU.
 */
export function drawCompare(g: CanvasRenderingContext2D, s: Scene) {
  prep(g, s);
  if (!s.compareWith || (s.compare !== "wipe" && s.compare !== "diff")) return;
  drawOne(g, s, s.view, s.compareWith.source, s.compareWith.size, null);
}

/** Layer 3: grids, the hovered pixel, measuring line, crop box, dividers. */
export function drawOverlay(g: CanvasRenderingContext2D, s: Scene) {
  const { W, H } = prep(g, s);
  if (!s.source || s.natural.w <= 0 || s.natural.h <= 0) return;
  const c = contentSize(s.natural, s.crop);
  if (s.compare === "side" && s.compareWith) {
    const { left, half } = sideViews(s.view, s.stage);
    g.fillStyle = "rgba(255,255,255,0.6)";
    g.fillRect(Math.round(half * s.dpr) - 1, 0, 2, H);
    drawOverlays(g, s, left, c);
    return;
  }
  if (s.compareWith && s.compare === "wipe") {
    const x = Math.round(s.wipe * W);
    g.fillStyle = "rgba(255,255,255,0.85)";
    g.fillRect(x - 1, 0, 2, H);
    g.beginPath();
    g.arc(x, H / 2, 9 * s.dpr, 0, Math.PI * 2);
    g.fill();
  }
  drawOverlays(g, s, s.view, c);
}

/** The CSS filter for the picture layers. */
export function cssFilter(s: Pick<Scene, "adjust" | "mono">): string {
  return filterString(s.mono ? { ...s.adjust, grayscale: 1 } : s.adjust);
}

/** All three layers on one canvas (tests, exports, benchmarks). */
export function drawScene(g: CanvasRenderingContext2D, s: Scene) {
  drawBase(g, s);
  if (s.compareWith && (s.compare === "wipe" || s.compare === "diff")) {
    const t = document.createElement("canvas");
    t.width = g.canvas.width;
    t.height = g.canvas.height;
    drawCompare(t.getContext("2d")!, s);
    g.save();
    if (s.compare === "wipe") {
      const x = Math.round(s.wipe * t.width);
      g.beginPath();
      g.rect(x, 0, t.width - x, t.height);
      g.clip();
    } else g.globalCompositeOperation = "difference";
    g.drawImage(t, 0, 0);
    g.restore();
  }
  const f = cssFilter(s);
  if (f !== "none") {
    g.save();
    g.filter = f;
    g.drawImage(g.canvas, 0, 0);
    g.restore();
  }
  const o = document.createElement("canvas");
  o.width = g.canvas.width;
  o.height = g.canvas.height;
  drawOverlay(o.getContext("2d")!, s);
  g.drawImage(o, 0, 0);
}

function drawOverlays(g: CanvasRenderingContext2D, s: Scene, view: View, c: Size) {
  const m = scaleMat(matrix(view, c), s.dpr);
  const dev = (p: Pt) => apply(m, p);
  const line = (a: Pt, b: Pt) => {
    const p = dev(a);
    const q = dev(b);
    g.moveTo(Math.round(p.x) + 0.5, Math.round(p.y) + 0.5);
    g.lineTo(Math.round(q.x) + 0.5, Math.round(q.y) + 0.5);
  };
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.filter = "none";
  g.globalCompositeOperation = "source-over";

  // Pixel grid once a pixel is 12+ screen px wide.
  const pxSize = view.scale * s.dpr;
  if (pxSize >= 12) {
    const toPic = invert(matrix(view, c));
    const corners = [
      { x: 0, y: 0 },
      { x: s.stage.w, y: 0 },
      { x: 0, y: s.stage.h },
      { x: s.stage.w, y: s.stage.h },
    ].map((p) => apply(toPic, p));
    const x0 = Math.max(0, Math.floor(Math.min(...corners.map((p) => p.x))));
    const x1 = Math.min(c.w, Math.ceil(Math.max(...corners.map((p) => p.x))));
    const y0 = Math.max(0, Math.floor(Math.min(...corners.map((p) => p.y))));
    const y1 = Math.min(c.h, Math.ceil(Math.max(...corners.map((p) => p.y))));
    if ((x1 - x0) * (y1 - y0) < 40000) {
      g.beginPath();
      for (let x = x0; x <= x1; x++) line({ x, y: y0 }, { x, y: y1 });
      for (let y = y0; y <= y1; y++) line({ x: x0, y }, { x: x1, y });
      g.strokeStyle = "rgba(128,128,128,0.35)";
      g.lineWidth = 1;
      g.stroke();
    }
  }

  const lines = gridLines(s.grid, c.w, c.h);
  if (lines.length) {
    g.beginPath();
    for (const l of lines) line({ x: l.x1, y: l.y1 }, { x: l.x2, y: l.y2 });
    g.globalAlpha = s.grid.opacity;
    g.strokeStyle = s.grid.color;
    g.lineWidth = Math.max(1, Math.round(s.dpr));
    g.stroke();
    g.globalAlpha = 1;
  }

  if (s.hoverPixel) {
    const { x, y } = s.hoverPixel;
    if (pxSize >= 6) {
      const pts = [dev({ x, y }), dev({ x: x + 1, y }), dev({ x: x + 1, y: y + 1 }), dev({ x, y: y + 1 })];
      g.beginPath();
      g.moveTo(pts[0].x, pts[0].y);
      for (const p of pts.slice(1)) g.lineTo(p.x, p.y);
      g.closePath();
      g.lineWidth = 2;
      g.strokeStyle = "rgba(0,0,0,0.8)";
      g.stroke();
      g.lineWidth = 1;
      g.strokeStyle = "rgba(255,255,255,0.95)";
      g.stroke();
    }
  }

  if (s.cropDraft) {
    const r = s.cropDraft;
    const pts = [dev({ x: r.x, y: r.y }), dev({ x: r.x + r.w, y: r.y }), dev({ x: r.x + r.w, y: r.y + r.h }), dev({ x: r.x, y: r.y + r.h })];
    g.beginPath();
    g.rect(0, 0, s.stage.w * s.dpr, s.stage.h * s.dpr);
    g.moveTo(pts[0].x, pts[0].y);
    for (const p of [...pts].reverse()) g.lineTo(p.x, p.y);
    g.closePath();
    g.fillStyle = "rgba(0,0,0,0.55)";
    g.fill("evenodd");
    g.beginPath();
    g.moveTo(pts[0].x, pts[0].y);
    for (const p of pts.slice(1)) g.lineTo(p.x, p.y);
    g.closePath();
    g.setLineDash([6, 4]);
    g.strokeStyle = "#fff";
    g.lineWidth = 1.5;
    g.stroke();
    g.setLineDash([]);
  }

  if (s.measureLine) {
    const { a, b } = s.measureLine;
    const p = dev(a);
    const q = dev(b);
    g.beginPath();
    g.moveTo(p.x, p.y);
    g.lineTo(q.x, q.y);
    g.lineWidth = 3;
    g.strokeStyle = "rgba(0,0,0,0.7)";
    g.stroke();
    g.lineWidth = 1.5;
    g.strokeStyle = "#ffd60a";
    g.stroke();
    for (const e of [p, q]) {
      g.beginPath();
      g.arc(e.x, e.y, 3.5 * s.dpr, 0, Math.PI * 2);
      g.fillStyle = "#ffd60a";
      g.fill();
    }
    const mm = measure(a, b);
    const label = `${mm.length.toFixed(1)} px · ${Math.round(Math.abs(mm.dx))}×${Math.round(Math.abs(mm.dy))} · ${mm.angle.toFixed(1)}°`;
    g.font = `${Math.round(11 * s.dpr)}px "Cascadia Code", Consolas, monospace`;
    const tw = g.measureText(label).width;
    const lx = (p.x + q.x) / 2 + 8 * s.dpr;
    const ly = (p.y + q.y) / 2 - 8 * s.dpr;
    g.fillStyle = "rgba(0,0,0,0.78)";
    g.fillRect(lx - 4 * s.dpr, ly - 13 * s.dpr, tw + 8 * s.dpr, 18 * s.dpr);
    g.fillStyle = "#fff";
    g.fillText(label, lx, ly);
  }
  g.restore();
}

// ---------------------------------------------------------------------------
// Pixels and frames
// ---------------------------------------------------------------------------

let probe: CanvasRenderingContext2D | null = null;

/** Reads one pixel of a source (null when the source cannot be read). */
export function readPixel(src: CanvasImageSource, x: number, y: number): [number, number, number, number] | null {
  try {
    if (!probe) {
      const c = document.createElement("canvas");
      c.width = c.height = 1;
      probe = c.getContext("2d", { willReadFrequently: true });
    }
    if (!probe) return null;
    probe.clearRect(0, 0, 1, 1);
    probe.drawImage(src, x, y, 1, 1, 0, 0, 1, 1);
    const d = probe.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3]];
  } catch {
    return null;
  }
}

/** The source's pixels (cropped) on a canvas at full resolution. */
export function frameCanvas(src: CanvasImageSource, natural: Size, crop: Rect | null): HTMLCanvasElement {
  const c = contentSize(natural, crop);
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(c.w));
  out.height = Math.max(1, Math.round(c.h));
  const g = out.getContext("2d")!;
  if (crop) g.drawImage(src, crop.x, crop.y, crop.w, crop.h, 0, 0, c.w, c.h);
  else g.drawImage(src, 0, 0, natural.w, natural.h);
  return out;
}

export function canvasPng(c: HTMLCanvasElement): Promise<string> {
  return new Promise((resolve, reject) => {
    c.toBlob((b) => {
      if (!b) return reject(new Error("Could not encode the PNG"));
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(b);
    }, "image/png");
  });
}

/** Natural size of a canvas image source. */
export function naturalSize(src: CanvasImageSource | null): Size {
  if (!src) return { w: 0, h: 0 };
  if (src instanceof HTMLVideoElement) return { w: src.videoWidth, h: src.videoHeight };
  if (src instanceof HTMLImageElement) return { w: src.naturalWidth, h: src.naturalHeight };
  if (src instanceof HTMLCanvasElement) return { w: src.width, h: src.height };
  if (typeof ImageBitmap !== "undefined" && src instanceof ImageBitmap) return { w: src.width, h: src.height };
  return { w: 0, h: 0 };
}
