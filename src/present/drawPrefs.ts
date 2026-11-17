// Draw on screen: the choices it remembers between uses, and the small rules
// the window follows (fading ink, pen widths, the board behind the drawing).
import { DEFAULT_STYLE, type Style, type Tool } from "../annotate/shapes";

/** What is behind the drawing: nothing (the live screen), a white or black board, or the screen dimmed. */
export type Board = "none" | "white" | "black" | "dim";

/** The annotation tools plus an eraser (drag over drawings to remove them). */
export type DrawTool = Tool | "eraser";

export interface DrawPrefs {
  tool: DrawTool;
  style: Style;
  board: Board;
  /** Seconds before a drawing fades away (0 = it stays until cleared). */
  fade: number;
}

export const DRAW_TOOLS: DrawTool[] = ["select", "pen", "highlight", "eraser", "arrow", "line", "rect", "ellipse", "text", "step", "spotlight"];
export const PEN_WIDTHS = [2, 4, 6, 10, 16, 24];
/** Fade choices in the menu (any other number can be typed). */
export const FADE_CHOICES = [0, 2, 4, 8];
export const FADE_MAX = 600;

export const DEFAULT_DRAW_PREFS: DrawPrefs = { tool: "pen", style: { ...DEFAULT_STYLE, width: 4, size: 48 }, board: "none", fade: 0 };

/** Prefs from storage, every field checked (bad or old values fall back). */
export function parseDrawPrefs(raw: string | null): DrawPrefs {
  let v: Partial<DrawPrefs> = {};
  try {
    v = raw ? (JSON.parse(raw) as Partial<DrawPrefs>) : {};
  } catch {
    v = {};
  }
  if (!v || typeof v !== "object") v = {};
  const d = DEFAULT_DRAW_PREFS;
  const style = { ...d.style, ...(v.style && typeof v.style === "object" ? v.style : {}) };
  if (!(style.width > 0 && style.width <= 200)) style.width = d.style.width;
  return {
    tool: DRAW_TOOLS.includes(v.tool as DrawTool) ? (v.tool as DrawTool) : d.tool,
    style,
    board: (["none", "white", "black", "dim"] as const).includes(v.board as Board) ? (v.board as Board) : d.board,
    fade: clampFade(v.fade),
  };
}

export function clampFade(s: unknown): number {
  const n = typeof s === "number" ? s : Number(s);
  return Number.isFinite(n) && n > 0 ? Math.min(FADE_MAX, Math.round(n * 10) / 10) : 0;
}

/** The next pen width up (dir 1) or down (-1) from any width. */
export function stepWidth(w: number, dir: number): number {
  if (dir > 0) return PEN_WIDTHS.find((x) => x > w + 1e-9) ?? PEN_WIDTHS[PEN_WIDTHS.length - 1];
  return [...PEN_WIDTHS].reverse().find((x) => x < w - 1e-9) ?? PEN_WIDTHS[0];
}

/** How visible a drawing is `ageMs` after it was made: whole, then fading over the last third, then 0 (gone). */
export function fadeAlpha(ageMs: number, fadeS: number): number {
  if (!(fadeS > 0)) return 1;
  const total = fadeS * 1000;
  if (ageMs >= total) return 0;
  const start = total * (2 / 3);
  return ageMs <= start ? 1 : 1 - (ageMs - start) / (total - start);
}

/**
 * The window's background. "none" is a near-invisible tint: a window that is
 * fully see-through there could let clicks fall through to the app below
 * while drawing.
 */
export function boardCss(b: Board): string {
  return b === "white" ? "#ffffff" : b === "black" ? "#16171b" : b === "dim" ? "rgba(0,0,0,0.55)" : "rgba(0,0,0,0.004)";
}

/** W / K: the board, or back to the screen when it is already on. */
export const toggleBoard = (cur: Board, b: Board): Board => (cur === b ? "none" : b);

/** Points every `step` px along a drag from `a` to `b` (the eraser tests each, so a fast stroke misses nothing). */
export function along(a: [number, number], b: [number, number], step: number): [number, number][] {
  const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / Math.max(step, 1e-6)));
  return Array.from({ length: n }, (_, i) => [a[0] + ((b[0] - a[0]) * (i + 1)) / n, a[1] + ((b[1] - a[1]) * (i + 1)) / n]);
}

/** Keeps the floating bar inside the window (CSS px). */
export function clampBar(x: number, y: number, w: number, h: number, viewW: number, viewH: number): { x: number; y: number } {
  return { x: Math.max(0, Math.min(viewW - w, x)), y: Math.max(0, Math.min(viewH - h, y)) };
}
