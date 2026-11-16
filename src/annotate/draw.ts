/**
 * Draws annotation objects on a 2D canvas. The same code draws the editor's
 * preview, the PNGs sent to the video render, and the screenshot export, so
 * what you see is what you get.
 */
import { IS_LINE, type Pt, type Shape, TEXT_PAD, centre, drawnBounds, fontOf } from "./shapes";

export interface DrawEnv {
  /** Loaded picture for an image shape (null while loading). */
  image?: (src: string) => CanvasImageSource | null;
  /** Size of the whole picture (a spotlight covers all of it). */
  content?: { w: number; h: number };
}

function arrowHead(g: CanvasRenderingContext2D, from: Pt, to: Pt, size: number) {
  const a = Math.atan2(to[1] - from[1], to[0] - from[0]);
  g.beginPath();
  g.moveTo(to[0], to[1]);
  g.lineTo(to[0] - size * Math.cos(a - Math.PI / 7), to[1] - size * Math.sin(a - Math.PI / 7));
  g.lineTo(to[0] - size * Math.cos(a + Math.PI / 7), to[1] - size * Math.sin(a + Math.PI / 7));
  g.closePath();
  g.fill();
}

/** Is a colour light (for the number on a step badge)? */
function light(hex: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return false;
  const v = parseInt(m[1], 16);
  return 0.299 * (v >> 16) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255) > 160;
}

/** The pixels under the current transform's box, in device pixels. */
function deviceRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const m = g.getTransform();
  const xs = [x, x + w].map((px) => m.a * px + m.e);
  const ys = [y, y + h].map((py) => m.d * py + m.f);
  const rx = Math.max(0, Math.floor(Math.min(...xs)));
  const ry = Math.max(0, Math.floor(Math.min(...ys)));
  const rw = Math.min(g.canvas.width, Math.ceil(Math.max(...xs))) - rx;
  const rh = Math.min(g.canvas.height, Math.ceil(Math.max(...ys))) - ry;
  return { x: rx, y: ry, w: rw, h: rh, scale: Math.abs(m.a) };
}

let scratch: HTMLCanvasElement | null = null;
function tmp(w: number, h: number): CanvasRenderingContext2D {
  if (!scratch) scratch = document.createElement("canvas");
  scratch.width = Math.max(1, w);
  scratch.height = Math.max(1, h);
  return scratch.getContext("2d")!;
}

/** Pixelates or blurs what is already drawn under the box (irreversible). */
function censor(g: CanvasRenderingContext2D, s: Shape) {
  const r = deviceRect(g, s.x, s.y, s.w, s.h);
  if (r.w < 1 || r.h < 1) return;
  const strength = Math.max(2, (s.strength ?? (s.kind === "blur" ? 12 : 16)) * r.scale);
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  if (s.kind === "pixelate") {
    const tw = Math.max(1, Math.round(r.w / strength));
    const th = Math.max(1, Math.round(r.h / strength));
    const t = tmp(tw, th);
    t.imageSmoothingEnabled = true;
    t.drawImage(g.canvas, r.x, r.y, r.w, r.h, 0, 0, tw, th);
    g.imageSmoothingEnabled = false;
    g.drawImage(t.canvas, 0, 0, tw, th, r.x, r.y, r.w, r.h);
  } else {
    const pad = Math.ceil(strength * 2);
    const sx = Math.max(0, r.x - pad);
    const sy = Math.max(0, r.y - pad);
    const sw = Math.min(g.canvas.width - sx, r.w + pad * 2);
    const sh = Math.min(g.canvas.height - sy, r.h + pad * 2);
    const t = tmp(sw, sh);
    t.drawImage(g.canvas, sx, sy, sw, sh, 0, 0, sw, sh);
    g.beginPath();
    g.rect(r.x, r.y, r.w, r.h);
    g.clip();
    g.filter = `blur(${strength}px)`;
    // Twice: a single pass leaves readable text at small strengths.
    g.drawImage(t.canvas, sx, sy);
    g.drawImage(t.canvas, sx, sy);
    g.filter = "none";
  }
  g.restore();
}

/** Draws one shape in content pixels (the caller sets the scale). */
export function drawShape(g: CanvasRenderingContext2D, s: Shape, env: DrawEnv = {}) {
  if (s.hidden) return;
  if (s.kind === "blur" || s.kind === "pixelate") {
    censor(g, s);
    return;
  }
  g.save();
  g.globalAlpha *= Math.max(0, Math.min(1, s.opacity));
  g.lineCap = "round";
  g.lineJoin = "round";
  g.strokeStyle = s.color;
  g.fillStyle = s.color;
  g.lineWidth = s.width;
  if (s.dash) g.setLineDash([s.width * 2.5, s.width * 2]);

  if (IS_LINE(s.kind) && s.pts) {
    const [a, b] = s.pts;
    const head = Math.max(10, s.width * 3.5);
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const back = s.kind === "arrow" ? Math.min(head * 0.6, len / 2) : 0;
    const ux = (b[0] - a[0]) / len;
    const uy = (b[1] - a[1]) / len;
    g.beginPath();
    g.moveTo(a[0] + (s.double ? ux * back : 0), a[1] + (s.double ? uy * back : 0));
    g.lineTo(b[0] - ux * back, b[1] - uy * back);
    g.stroke();
    g.setLineDash([]);
    if (s.kind === "arrow") {
      arrowHead(g, a, b, head);
      if (s.double) arrowHead(g, b, a, head);
    }
    g.restore();
    return;
  }

  // Boxed shapes: turn and flip about the centre.
  const [cx, cy] = centre(s);
  g.translate(cx, cy);
  g.rotate((s.rot * Math.PI) / 180);
  g.scale(s.flipX ? -1 : 1, s.flipY ? -1 : 1);
  g.translate(-cx, -cy);

  switch (s.kind) {
    case "spotlight": {
      // Everything but the box, dimmed (even-odd: the box is a hole).
      g.beginPath();
      g.rect(-1e5, -1e5, 2e5, 2e5);
      const r = Math.min(s.radius ?? 0, s.w / 2, s.h / 2);
      if (r > 0) g.roundRect(s.x, s.y, s.w, s.h, r);
      else g.rect(s.x, s.y, s.w, s.h);
      g.fillStyle = s.fill ?? "#000000";
      g.fill("evenodd");
      break;
    }
    case "rect":
    case "redact": {
      g.beginPath();
      const r = Math.min(s.radius ?? 0, s.w / 2, s.h / 2);
      if (r > 0) g.roundRect(s.x, s.y, s.w, s.h, r);
      else g.rect(s.x, s.y, s.w, s.h);
      if (s.kind === "redact") {
        g.fillStyle = s.fill ?? s.color ?? "#000";
        g.fill();
        break;
      }
      if (s.fill) {
        g.fillStyle = s.fill;
        g.fill();
      }
      if (s.width > 0) g.stroke();
      break;
    }
    case "ellipse": {
      g.beginPath();
      g.ellipse(cx, cy, Math.max(0.5, s.w / 2), Math.max(0.5, s.h / 2), 0, 0, Math.PI * 2);
      if (s.fill) {
        g.fillStyle = s.fill;
        g.fill();
      }
      if (s.width > 0) g.stroke();
      break;
    }
    case "pen":
    case "highlight": {
      if (s.kind === "highlight") {
        g.globalAlpha *= 0.45;
        g.lineCap = "square";
      }
      for (const st of s.strokes ?? []) {
        const p = st.map(([u, v]) => [s.x + u * s.w, s.y + v * s.h] as Pt);
        if (p.length === 1) {
          g.beginPath();
          g.arc(p[0][0], p[0][1], s.width / 2, 0, Math.PI * 2);
          g.fill();
          continue;
        }
        g.beginPath();
        g.moveTo(p[0][0], p[0][1]);
        // Smooth through midpoints (quadratic curves).
        for (let k = 1; k < p.length - 1; k++) {
          const mx = (p[k][0] + p[k + 1][0]) / 2;
          const my = (p[k][1] + p[k + 1][1]) / 2;
          g.quadraticCurveTo(p[k][0], p[k][1], mx, my);
        }
        g.lineTo(p[p.length - 1][0], p[p.length - 1][1]);
        g.stroke();
      }
      break;
    }
    case "step": {
      const r = Math.min(s.w, s.h) / 2;
      g.beginPath();
      g.arc(cx, cy, r, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = light(s.color) ? "#111" : "#fff";
      g.font = `700 ${Math.round(r * 1.1)}px "Segoe UI", sans-serif`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(String(s.n ?? 1), cx, cy + r * 0.06);
      break;
    }
    case "image": {
      const img = s.src ? env.image?.(s.src) : null;
      if (img) g.drawImage(img, s.x, s.y, s.w, s.h);
      else {
        g.setLineDash([6, 4]);
        g.lineWidth = 2;
        g.strokeStyle = "rgba(255,255,255,0.6)";
        g.strokeRect(s.x, s.y, s.w, s.h);
      }
      break;
    }
    case "text": {
      const size = s.size ?? 64;
      const pad = size * TEXT_PAD;
      if (s.fill) {
        g.fillStyle = s.fill;
        g.beginPath();
        g.roundRect(s.x, s.y, s.w, s.h, pad);
        g.fill();
      }
      g.font = fontOf(s);
      g.textBaseline = "top";
      const align = s.align ?? "left";
      g.textAlign = align;
      const tx = align === "left" ? s.x + pad : align === "right" ? s.x + s.w - pad : cx;
      const lines = (s.text ?? "").split("\n");
      const lh = size * 1.2;
      if (s.shadow) {
        g.shadowColor = "rgba(0,0,0,0.6)";
        g.shadowBlur = size * 0.12;
        g.shadowOffsetY = size * 0.04;
      }
      lines.forEach((l, i) => {
        const y = s.y + pad + i * lh + size * 0.08;
        if (s.outline) {
          g.save();
          g.strokeStyle = s.outline;
          g.lineWidth = Math.max(1, size * 0.12);
          g.lineJoin = "round";
          g.setLineDash([]);
          g.strokeText(l, tx, y);
          g.restore();
          g.shadowColor = "transparent";
        }
        g.fillStyle = s.color;
        g.fillText(l, tx, y);
      });
      break;
    }
  }
  g.restore();
}

/**
 * One shape as a PNG of exactly the pixels it covers (for the video render):
 * returns the picture and its top-left corner in content pixels.
 */
export function rasterize(s: Shape, env: DrawEnv = {}): { png: string; x: number; y: number } | null {
  const b = s.kind === "spotlight" && env.content ? { x: 0, y: 0, ...env.content } : drawnBounds(s);
  const x = Math.floor(b.x);
  const y = Math.floor(b.y);
  const w = Math.ceil(b.x + b.w) - x;
  const h = Math.ceil(b.y + b.h) - y;
  if (w < 1 || h < 1 || w * h > 8192 * 8192) return null;
  const c = document.createElement("canvas");
  c.width = w + (w % 2);
  c.height = h + (h % 2);
  const g = c.getContext("2d")!;
  g.translate(-x, -y);
  drawShape(g, s, env);
  return { png: c.toDataURL("image/png"), x, y };
}

/** Loads pictures for image shapes once and redraws when they arrive. */
export class ImageCache {
  private map = new Map<string, HTMLImageElement | "loading" | "error">();
  constructor(private onLoad: () => void) {}
  get = (src: string): HTMLImageElement | null => {
    const v = this.map.get(src);
    if (v instanceof HTMLImageElement) return v;
    if (v) return null;
    this.map.set(src, "loading");
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      this.map.set(src, img);
      this.onLoad();
    };
    img.onerror = () => this.map.set(src, "error");
    img.src = src;
    return null;
  };
}
