/**
 * Draws one preview frame: picture tracks bottom to top (each placed with
 * its crop, turn, flip, size and position), then the blur/pixelate boxes,
 * then the annotation objects back to front. The render in Rust follows the
 * same rules (media/compose.rs), so the preview shows what export makes.
 */
import { drawShape, type DrawEnv } from "../annotate/draw";
import type { Shape } from "../annotate/shapes";
import { end } from "../timeline/model";
import { type EdItem, type EdProject, tracksOf } from "./project";

export interface Placement {
  /** Source rectangle (natural pixels). */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** Centre on the canvas and drawn size before the turn (canvas pixels). */
  cx: number;
  cy: number;
  dw: number;
  dh: number;
  rot: number;
  flipH: boolean;
  flipV: boolean;
}

/** Where a picture of natural size `nw x nh` goes on a `W x H` frame. */
export function placement(it: EdItem, nw: number, nh: number, W: number, H: number): Placement {
  const q = it.pic ?? {};
  const c = q.crop ?? { x: 0, y: 0, w: 1, h: 1 };
  const sx = c.x * nw;
  const sy = c.y * nh;
  const sw = Math.max(1, c.w * nw);
  const sh = Math.max(1, c.h * nh);
  const turned = q.rot90 === 90 || q.rot90 === 270;
  const vw = turned ? sh : sw;
  const vh = turned ? sw : sh;
  const k = (q.fill ? Math.max(W / vw, H / vh) : Math.min(W / vw, H / vh)) * (q.scale ?? 1);
  return {
    sx,
    sy,
    sw,
    sh,
    cx: (q.cx ?? 0.5) * W,
    cy: (q.cy ?? 0.5) * H,
    dw: sw * k,
    dh: sh * k,
    rot: q.rot90 ?? 0,
    flipH: !!q.flipH,
    flipV: !!q.flipV,
  };
}

/** The placed picture's corners on the canvas (for handles). */
export function placedBox(pl: Placement): { x: number; y: number; w: number; h: number } {
  const turned = pl.rot === 90 || pl.rot === 270;
  const w = turned ? pl.dh : pl.dw;
  const h = turned ? pl.dw : pl.dh;
  return { x: pl.cx - w / 2, y: pl.cy - h / 2, w, h };
}

export function drawPlaced(g: CanvasRenderingContext2D, src: CanvasImageSource, pl: Placement) {
  g.save();
  g.translate(pl.cx, pl.cy);
  g.rotate((pl.rot * Math.PI) / 180);
  g.scale(pl.flipH ? -1 : 1, pl.flipV ? -1 : 1);
  g.drawImage(src, pl.sx, pl.sy, pl.sw, pl.sh, -pl.dw / 2, -pl.dh / 2, pl.dw, pl.dh);
  g.restore();
}

export interface FrameSources {
  video: (it: EdItem) => HTMLVideoElement | null;
  image: (src: string) => HTMLImageElement | null;
  urlOf: (path: string) => string;
}

/** Items visible at `t`, picture tracks bottom first. */
export function picturesAt(p: EdProject, t: number): EdItem[] {
  const v = tracksOf(p.tl, "video").filter((tr) => !tr.hidden);
  const out: EdItem[] = [];
  for (let k = v.length - 1; k >= 0; k--) {
    for (const it of p.tl.items) {
      if (it.track === v[k].id && !it.disabled && (it.kind === "video" || it.kind === "image") && t >= it.start && t < end(it)) out.push(it);
    }
  }
  return out;
}

/** Annotation objects visible at `t`, back to front (blur boxes first). */
export function shapesAt(p: EdProject, t: number): { item: EdItem; shape: Shape }[] {
  const o = tracksOf(p.tl, "overlay").filter((tr) => !tr.hidden);
  const out: { item: EdItem; shape: Shape }[] = [];
  for (let k = o.length - 1; k >= 0; k--) {
    for (const it of p.tl.items) {
      if (it.track === o[k].id && !it.disabled && it.kind === "shape" && it.shape && t >= it.start - 1e-6 && t < end(it)) out.push({ item: it, shape: it.shape });
    }
  }
  const censor = out.filter((x) => x.shape.kind === "blur" || x.shape.kind === "pixelate");
  return [...censor, ...out.filter((x) => !censor.includes(x))];
}

/**
 * Draws the frame at `t` on `g`, whose canvas is `scale` × the output size.
 * `skip`: a shape being typed into (the text box shows it instead).
 */
export function drawFrame(g: CanvasRenderingContext2D, p: EdProject, t: number, W: number, H: number, scale: number, src: FrameSources, skip?: string | null) {
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = "#000";
  g.fillRect(0, 0, g.canvas.width, g.canvas.height);
  g.setTransform(scale, 0, 0, scale, 0, 0);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  for (const it of picturesAt(p, t)) {
    if (it.kind === "video") {
      const v = src.video(it);
      if (!v || !v.videoWidth) continue;
      drawPlaced(g, v, placement(it, v.videoWidth, v.videoHeight, W, H));
    } else if (it.path) {
      const img = src.image(src.urlOf(it.path));
      if (!img) continue;
      drawPlaced(g, img, placement(it, img.naturalWidth, img.naturalHeight, W, H));
    }
  }
  const env: DrawEnv = { image: (s) => src.image(src.urlOf(s)) };
  for (const { shape } of shapesAt(p, t)) {
    if (shape.id === skip) continue;
    drawShape(g, shape, env);
  }
  g.setTransform(1, 0, 0, 1, 0, 0);
}
