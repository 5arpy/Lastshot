import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { lastshot, isTauri, showCurrentWindow } from "../lib/bridge";
import type { SnipCapture, SnipWindowRect } from "../lib/types";
import { cn } from "../utils/cn";
import { AREA_SIZES, HANDLES, dragBox, lastAreaIn, monitorAt, monitorsOf, moveBox, resizeBox, sizeBox, type Handle } from "./snipGeo";
import { COLOUR_FORMATS, colourText, hexOf, linesLabel, ocrTable, ocrText, privateBoxes, type ColourFormat } from "./snipText";
import Viewer, { type ViewerApi } from "../viewer/Viewer";
import { popOutCanvas } from "../popout/frames";
import { normAngle, viewForRect, type View } from "../viewer/math";
import AnnotationLayer, { type LayerView } from "../annotate/AnnotationLayer";
import { drawShape } from "../annotate/draw";
import StyleControls, { TOOLS } from "../annotate/StyleControls";
import { type Shape, type Style, type Tool, DEFAULT_STYLE, PALETTE, align, flip, moveBy, reorder, rotateBy, shapeId } from "../annotate/shapes";
import { History } from "../timeline/history";
import { postToEditor } from "../editor/inbox";
import { SNIP_TOOL_KEYS, snipKeymap, type SnipActions } from "../editor/keys";
import { SNIP_KEYS, keyOfLabel, matchKey, toRegistry } from "../editor/keyTables";
import { setShortcutOverrides, type Shortcut as Reg } from "../lib/shortcuts";
import { useShortcuts } from "../lib/useShortcuts";
import { APP_SCOPE, ak } from "../lib/appKeys";
import ShortcutsOverlay from "./ShortcutsOverlay";

/**
 * Full-screen snipping overlay. It runs in its own borderless window that
 * covers the snipped screens (by default every monitor at once) and shows a
 * frozen picture of them. The bar at the top of the screen the mouse was on
 * switches between Screenshot and Record.
 *
 * 1. Pick: drag a box (it may cross screens; Shift: a square), click a
 *    window, click the desktop or press F for the screen under the mouse,
 *    Shift+F for all, L for the last area. A magnifier with the pixel's
 *    colour follows the mouse (M). Or:
 *    - Text (T): drag a box, its text is copied (Windows' own OCR);
 *    - Colour (C): click a pixel, its colour is copied;
 *    - Draw (D): draw on the live screens (`present/PresentWindow.tsx`).
 * 2. Screenshot: the area keeps handles (and arrows move it, Ctrl+arrows
 *    size it, or type a size); mark it up with the shared annotation
 *    objects. Every object can be selected, moved, sized, turned and
 *    restyled; Ctrl+Z / Ctrl+Y. Enter / Ctrl+C copies, Ctrl+S saves (and
 *    copies), Ctrl+Shift+C copies the text in it. A QR code in the area
 *    shows its link.
 *    Record: Enter / Start recording records that area until stopped.
 * Esc cancels. F1 or ? lists every key.
 *
 * Opened by the "last area" or "window in front" hotkey, it snips that
 * area at once and closes without ever showing.
 *
 * All coordinates below are in the captured image's physical pixels; the page
 * scales them to CSS pixels only for display.
 */

type Mode = "shot" | "rec";
type PickTool = "area" | "text" | "colour";
type Rect = { x: number; y: number; w: number; h: number };

const STYLE_KEY = "lastshot.snip.style";
const LAST_KEY = "lastshot.snip.last";
function loadStyle(): Style {
  try {
    const v = localStorage.getItem(STYLE_KEY);
    return v ? { ...DEFAULT_STYLE, ...(JSON.parse(v) as Partial<Style>) } : DEFAULT_STYLE;
  } catch {
    return DEFAULT_STYLE;
  }
}
/** A remembered choice (magnifier, hints, …); private mode just forgets. */
function readPref(key: string, def: string): string {
  try {
    return localStorage.getItem(`lastshot.snip.${key}`) ?? def;
  } catch {
    return def;
  }
}
function writePref(key: string, v: string) {
  try {
    localStorage.setItem(`lastshot.snip.${key}`, v);
  } catch {
    /* a preference only */
  }
}
function readLast(): Rect | null {
  try {
    const v = JSON.parse(localStorage.getItem(LAST_KEY) ?? "null") as Rect | null;
    return v && v.w > 0 && v.h > 0 ? v : null;
  } catch {
    return null;
  }
}

/** Snip keys for the drawing tools, as the user set them (B stays blur here; Shift+B pixelates). */
function keyOf(t: Tool): string | undefined {
  const label = SNIP_TOOL_KEYS.find((x) => x.tool === t)?.label;
  return (label && keyOfLabel("snip", SNIP_KEYS, label)) || undefined;
}
/** "Undo (Ctrl+Z)": a label with the snip key in effect. */
const tipOf = (text: string, label = text) => {
  const k = keyOfLabel("snip", SNIP_KEYS, label);
  return k ? `${text} (${k})` : text;
};
const keyText = (label: string) => keyOfLabel("snip", SNIP_KEYS, label);

/** The tools on the bar; the rest are under "More tools" (every key works). */
const MAIN_TOOLS: Tool[] = ["select", "text", "rect", "arrow", "pen", "highlight", "step", "blur", "redact"];
const MORE_TOOLS: Tool[] = TOOLS.map((t) => t.id).filter((t) => !MAIN_TOOLS.includes(t));

/** A stand-in picture so the overlay can be tried in a plain browser. */
function demoCapture(): SnipCapture {
  const w = Math.round(window.innerWidth * window.devicePixelRatio);
  const h = Math.round(window.innerHeight * window.devicePixelRatio);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, "#1d2340");
  grad.addColorStop(1, "#3a1d40");
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  g.fillStyle = "#e4e6ee";
  g.font = `${Math.round(28 * window.devicePixelRatio)}px sans-serif`;
  g.fillText("Demo screen (browser preview)", 60, 90);
  g.fillStyle = "#2a2d37";
  g.fillRect(w * 0.1, h * 0.2, w * 0.45, h * 0.5);
  g.fillRect(w * 0.6, h * 0.3, w * 0.3, h * 0.4);
  return {
    image: c.toDataURL("image/png"),
    width: w,
    height: h,
    windows: [
      { x: Math.round(w * 0.6), y: Math.round(h * 0.3), w: Math.round(w * 0.3), h: Math.round(h * 0.4), title: "Small window" },
      { x: Math.round(w * 0.1), y: Math.round(h * 0.2), w: Math.round(w * 0.45), h: Math.round(h * 0.5), title: "Big window" },
    ],
  };
}

/** The selected part of the screen plus all objects, at full resolution. */
function render(g: CanvasRenderingContext2D, img: HTMLImageElement, sel: Rect, shapes: Shape[], skip: string | null) {
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.imageSmoothingEnabled = true;
  g.clearRect(0, 0, sel.w, sel.h);
  g.drawImage(img, sel.x, sel.y, sel.w, sel.h, 0, 0, sel.w, sel.h);
  for (const s of shapes) if (s.id !== skip && !s.hidden) drawShape(g, s);
}

/** One pixel of the frozen picture. */
const pixelCanvas = typeof document !== "undefined" ? document.createElement("canvas") : null;
function pixelAt(img: HTMLImageElement, x: number, y: number): [number, number, number] {
  if (!pixelCanvas) return [0, 0, 0];
  pixelCanvas.width = 1;
  pixelCanvas.height = 1;
  const g = pixelCanvas.getContext("2d", { willReadFrequently: true })!;
  g.clearRect(0, 0, 1, 1);
  g.drawImage(img, Math.floor(x), Math.floor(y), 1, 1, 0, 0, 1, 1);
  const d = g.getImageData(0, 0, 1, 1).data;
  return [d[0], d[1], d[2]];
}

/** Opens a link from a QR code (web links only). */
function openLink(url: string) {
  if (!/^https?:\/\//i.test(url)) return;
  void window.__TAURI__?.core.invoke("plugin:opener|open_url", { url }).catch(() => undefined);
}

/**
 * The magnifier (ShareX / Snagit style): the pixels around the cursor,
 * enlarged with a pixel grid and the centre pixel outlined, plus its
 * position and colour.
 */
function Magnifier({ img, px, py, origin, at, big, fmt }: { img: HTMLImageElement; px: number; py: number; origin: [number, number]; at: { left: number; top: number }; big: boolean; fmt: ColourFormat }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const cells = big ? 17 : 15;
  const cell = big ? 10 : 9;
  const size = cells * cell;
  const [rgb, setRgb] = useState<[number, number, number]>([0, 0, 0]);
  useLayoutEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(size * dpr)) {
      c.width = Math.round(size * dpr);
      c.height = Math.round(size * dpr);
    }
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.imageSmoothingEnabled = false;
    g.fillStyle = "#000";
    g.fillRect(0, 0, size, size);
    // The source square, clipped to the picture (black outside it).
    const half = Math.floor(cells / 2);
    const sx = Math.floor(px) - half;
    const sy = Math.floor(py) - half;
    const x0 = Math.max(0, sx);
    const y0 = Math.max(0, sy);
    const x1 = Math.min(img.naturalWidth, sx + cells);
    const y1 = Math.min(img.naturalHeight, sy + cells);
    if (x1 > x0 && y1 > y0) g.drawImage(img, x0, y0, x1 - x0, y1 - y0, (x0 - sx) * cell, (y0 - sy) * cell, (x1 - x0) * cell, (y1 - y0) * cell);
    g.strokeStyle = "rgba(255,255,255,0.10)";
    g.lineWidth = 1;
    g.beginPath();
    for (let i = 1; i < cells; i++) {
      g.moveTo(i * cell + 0.5, 0);
      g.lineTo(i * cell + 0.5, size);
      g.moveTo(0, i * cell + 0.5);
      g.lineTo(size, i * cell + 0.5);
    }
    g.stroke();
    g.strokeStyle = "#000";
    g.strokeRect(half * cell - 0.5, half * cell - 0.5, cell + 1, cell + 1);
    g.strokeStyle = "#fff";
    g.strokeRect(half * cell + 0.5, half * cell + 0.5, cell - 1, cell - 1);
    setRgb(pixelAt(img, px, py));
  }, [img, px, py, cells, cell, size]);
  const hex = hexOf(...rgb);
  return (
    <div className="pointer-events-none absolute z-30 overflow-hidden rounded-lg border border-white/25 bg-[#14161c] shadow-2xl" style={at} data-testid="snip-magnifier">
      <canvas ref={ref} style={{ width: size, height: size, display: "block" }} />
      <div className="flex items-center gap-1.5 px-1.5 py-1 font-mono text-[10.5px] leading-tight text-white/85" style={{ width: size }}>
        <span className="h-3 w-3 shrink-0 rounded-sm border border-white/40" style={{ background: hex }} />
        <span className="min-w-0 flex-1 truncate">{fmt === "hex" ? hex : colourText(...rgb, fmt)}</span>
      </div>
      <div className="px-1.5 pb-1 font-mono text-[10px] text-white/55">
        {Math.floor(px) + origin[0]}, {Math.floor(py) + origin[1]}
      </div>
    </div>
  );
}

export default function SnipOverlay() {
  // The user's keys (Settings → Shortcuts → Snip).
  useEffect(() => {
    if (lastshot.isTauri())
      void lastshot
        .getSettings()
        .then((s) => setShortcutOverrides(s.shortcuts))
        .catch(() => undefined);
  }, []);
  const [capture, setCapture] = useState<SnipCapture | null>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState({ w: window.innerWidth, h: window.innerHeight });
  // Picking phase.
  const [hover, setHover] = useState<SnipWindowRect | null>(null);
  const [drag, setDrag] = useState<{ x1: number; y1: number; x2: number; y2: number; square: boolean } | null>(null);
  const [pick, setPick] = useState<PickTool>("area");
  const [cursor, setCursor] = useState<{ cx: number; cy: number; px: number; py: number } | null>(null);
  const [mag, setMagState] = useState(() => readPref("magnifier", "1") === "1");
  const [cross, setCrossState] = useState(() => readPref("crosshair", "0") === "1");
  const [hints, setHintsState] = useState(() => readPref("hints", "1") === "1");
  const [fmt, setFmtState] = useState<ColourFormat>(() => (COLOUR_FORMATS as string[]).includes(readPref("colourFormat", "hex")) ? (readPref("colourFormat", "hex") as ColourFormat) : "hex");
  const [lang, setLangState] = useState(() => readPref("ocrLang", ""));
  const [langs, setLangs] = useState<{ tag: string; name: string }[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  // Editing phase.
  const [sel, setSel] = useState<Rect | null>(null);
  const selRef = useRef<Rect | null>(null);
  selRef.current = sel;
  const [tool, setTool] = useState<Tool>("rect");
  const [style, setStyleState] = useState<Style>(loadStyle);
  const [shapes, setShapesState] = useState<Shape[]>([]);
  const shapesRef = useRef<Shape[]>([]);
  shapesRef.current = shapes;
  const [picked, setPicked] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [pop, setPop] = useState<null | "style" | "colour" | "tools" | "more" | "size">(() => (readPref("styleOpen", "0") === "1" ? "style" : null));
  const [viewTools, setViewToolsState] = useState(() => readPref("viewTools", "0") === "1");
  const [space, setSpace] = useState(false);
  /** Z is held: a drag zooms the view (the drawing tools let it through). */
  const [holdZ, setHoldZ] = useState(false);
  const [vv, setVv] = useState<View | null>(null);
  const hist = useRef(new History<Shape[]>());
  const gesture = useRef<Shape[] | null>(null);
  const [, setHv] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("shot");
  const [qr, setQr] = useState<string[]>([]);
  const [sheet, setSheet] = useState<null | "keys" | "commands">(null);
  const viewer = useRef<ViewerApi | null>(null);
  /** Opened by the "last area" / "window in front" hotkey: snip at once. */
  const autoFinish = useRef(false);
  const instantDone = useRef(false);

  // The marked-up selection at full resolution. The viewer shows it (zoom,
  // pan, turn, inspect); at rest it sits exactly over the frozen screen.
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  if (!canvasRef.current && typeof document !== "undefined") canvasRef.current = document.createElement("canvas");
  const [canvasVersion, setCanvasVersion] = useState(0);
  const [zoomed, setZoomed] = useState(false);
  const zoomedRef = useRef(false);
  zoomedRef.current = zoomed;
  /** The area moved while the view was at rest: put the view on it again. */
  const refit = useRef(false);
  const shown = useRef(false);

  // Physical pixels per CSS pixel.
  const scale = capture ? capture.width / view.w : window.devicePixelRatio || 1;
  // The monitors in the picture (one when the snip covers one screen), the
  // one the mouse was on, and where the mouse is now (picture px).
  const mons = useMemo(() => monitorsOf(capture), [capture]);
  const home = Math.max(0, Math.min(mons.length - 1, capture?.home ?? 0));
  const pointer = useRef<[number, number] | null>(null);
  const origin: [number, number] = capture?.origin ?? [0, 0];
  const picBounds = useMemo(() => ({ x: 0, y: 0, w: capture?.width ?? 1, h: capture?.height ?? 1 }), [capture]);

  const setMag = (on: boolean) => {
    setMagState(on);
    writePref("magnifier", on ? "1" : "0");
  };
  const setCross = (on: boolean) => {
    setCrossState(on);
    writePref("crosshair", on ? "1" : "0");
  };
  const setHints = (on: boolean) => {
    setHintsState(on);
    writePref("hints", on ? "1" : "0");
  };
  const setFmt = (f: ColourFormat) => {
    setFmtState(f);
    writePref("colourFormat", f);
  };
  const setLang = (l: string) => {
    setLangState(l);
    writePref("ocrLang", l);
  };
  const setViewTools = (on: boolean) => {
    setViewToolsState(on);
    writePref("viewTools", on ? "1" : "0");
  };
  const say = useCallback((m: string) => setNotice(m), []);
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(t);
  }, [notice]);

  const setStyle = (p: Partial<Style>) =>
    setStyleState((st) => {
      const next = { ...st, ...p };
      try {
        localStorage.setItem(STYLE_KEY, JSON.stringify(next));
      } catch {
        /* private mode */
      }
      return next;
    });

  /** Object edits: one undo step per click or per drag. */
  const commitShapes = useCallback((next: Shape[], phase: "live" | "end" | "once", label: string) => {
    const cur = shapesRef.current;
    if (phase === "live") {
      if (!gesture.current) gesture.current = cur;
    } else if (phase === "end") {
      const before = gesture.current ?? cur;
      gesture.current = null;
      if (before !== next) hist.current.push(before, label);
    } else {
      hist.current.push(cur, label);
    }
    shapesRef.current = next;
    setShapesState(next);
    setHv((x) => x + 1);
  }, []);
  const undo = useCallback(() => {
    const prev = hist.current.undo(shapesRef.current);
    if (!prev) return;
    shapesRef.current = prev;
    setShapesState(prev);
    setEditing(null);
    setHv((x) => x + 1);
  }, []);
  const redo = useCallback(() => {
    const next = hist.current.redo(shapesRef.current);
    if (!next) return;
    shapesRef.current = next;
    setShapesState(next);
    setHv((x) => x + 1);
  }, []);
  const editPicked = useCallback(
    (fn: (s: Shape) => Shape, label: string) => {
      if (!picked.length) return false;
      const ids = new Set(picked);
      commitShapes(shapesRef.current.map((s) => (ids.has(s.id) && !s.locked ? fn(s) : s)), "once", label);
      return true;
    },
    [picked, commitShapes],
  );
  const duplicatePicked = useCallback(() => {
    const ids = new Set(picked);
    const copies = shapesRef.current.filter((x) => ids.has(x.id)).map((x) => ({ ...moveBy(x, 16 * scale, 16 * scale), id: shapeId(), locked: false }));
    if (!copies.length) return;
    commitShapes([...shapesRef.current, ...copies], "once", "Duplicate");
    setPicked(copies.map((c) => c.id));
  }, [picked, scale, commitShapes]);

  // ------------------------------------------------------------ load
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const c = isTauri() ? await lastshot.snipGetCapture() : demoCapture();
        if (!alive) return;
        const image = new Image();
        image.onload = () => {
          if (!alive) return;
          setCapture(c);
          setMode(c.start_mode === "rec" ? "rec" : "shot");
          setPick(c.start_mode === "text" ? "text" : c.start_mode === "colour" ? "colour" : "area");
          setImg(image);
        };
        image.onerror = () => setError("Could not read the screen picture.");
        image.src = c.image;
      } catch (e) {
        setError(String(e));
      }
    };
    void load();
    const onResize = () => setView({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => {
      alive = false;
      window.removeEventListener("resize", onResize);
    };
  }, []);
  // Text languages (only shown when there is a choice).
  useEffect(() => {
    if (pick === "text" && isTauri() && !langs.length) void lastshot.ocrLanguages().then(setLangs, () => undefined);
  }, [pick, langs.length]);

  // Show the window only once the frozen picture is on screen, so the user
  // never sees a black or half-drawn overlay. A "snip at once" hotkey never
  // shows it (unless it has nothing to snip).
  const instant = capture?.start_mode === "last" || capture?.start_mode === "window";
  const reveal = useCallback(() => {
    if (shown.current) return;
    shown.current = true;
    requestAnimationFrame(() => requestAnimationFrame(() => void showCurrentWindow()));
  }, []);
  useEffect(() => {
    if (img && !instant) reveal();
  }, [img, instant, reveal]);
  useEffect(() => {
    if (error) void showCurrentWindow();
  }, [error]);

  const cancel = useCallback(() => {
    if (isTauri()) void lastshot.snipCancel();
    else window.close();
  }, []);
  /** Draw on the live screens instead (this overlay closes). */
  const drawOnScreen = useCallback(() => {
    if (isTauri()) void lastshot.snipDraw().catch((e) => setError(String(e)));
    else location.search = "?present";
  }, []);

  // ------------------------------------------------------------ editing canvas
  useLayoutEffect(() => {
    const c = canvasRef.current;
    if (!c || !img || !sel) return;
    if (c.width !== sel.w || c.height !== sel.h) {
      c.width = sel.w;
      c.height = sel.h;
    }
    render(c.getContext("2d")!, img, sel, shapes, editing);
    setCanvasVersion((v) => v + 1);
  }, [img, sel, shapes, editing]);

  const toImage = (e: React.PointerEvent | PointerEvent): [number, number] => {
    const x = Math.round(e.clientX * scale);
    const y = Math.round(e.clientY * scale);
    return [
      Math.max(0, Math.min(capture?.width ?? x, x)),
      Math.max(0, Math.min(capture?.height ?? y, y)),
    ];
  };

  const windowAt = (x: number, y: number): SnipWindowRect | null =>
    capture?.windows.find((w) => x >= w.x && y >= w.y && x < w.x + w.w && y < w.y + w.h) ?? null;

  const select = useCallback((r: Rect) => {
    setSel({ x: r.x, y: r.y, w: Math.max(1, r.w), h: Math.max(1, r.h) });
    shapesRef.current = [];
    setShapesState([]);
    hist.current.clear();
    setPicked([]);
    setEditing(null);
    setDrag(null);
    setHover(null);
    setQr([]);
    setPop((p) => (p === "style" ? p : null));
  }, []);

  /**
   * The area moves or changes size; the objects stay on what they mark
   * (they are kept relative to the area, so they shift back by its move,
   * in the undo history too).
   */
  const changeArea = useCallback((next: Rect) => {
    const cur = selRef.current;
    if (!cur) return;
    if (!zoomedRef.current) refit.current = true;
    const ox = next.x - cur.x;
    const oy = next.y - cur.y;
    if (ox || oy) {
      const shift = (list: Shape[]) => list.map((s) => moveBy(s, -ox, -oy));
      const moved = shift(shapesRef.current);
      shapesRef.current = moved;
      setShapesState(moved);
      for (const st of [...hist.current.past, ...hist.current.future]) st.state = shift(st.state);
      if (gesture.current) gesture.current = shift(gesture.current);
    }
    setSel({ ...next, w: Math.max(1, next.w), h: Math.max(1, next.h) });
  }, []);

  useEffect(() => {
    if (!refit.current) return;
    refit.current = false;
    viewer.current?.fit();
  }, [sel]);

  /** Every screen in the picture (Shift+F). */
  const selectAll = useCallback(() => {
    if (capture) select({ x: 0, y: 0, w: capture.width, h: capture.height });
  }, [capture, select]);
  /** The screen under the mouse (F, a click on the desktop). */
  const selectScreen = useCallback(
    (at?: [number, number] | null) => {
      const p = at ?? pointer.current;
      const m = mons[p ? monitorAt(mons, p[0], p[1]) : home];
      if (m) select(m);
    },
    [mons, home, select],
  );
  /** The last area snipped (L), when it is on these screens. */
  const selectLast = useCallback(() => {
    if (!capture) return false;
    const r = lastAreaIn(readLast(), capture.origin ?? [0, 0], capture);
    if (r) select(r);
    else say("No last area on these screens yet.");
    return !!r;
  }, [capture, select, say]);
  /** Remembers the area (desktop px) for "the last area again". */
  const rememberArea = useCallback(
    (r: Rect) => {
      try {
        localStorage.setItem(LAST_KEY, JSON.stringify({ x: r.x + origin[0], y: r.y + origin[1], w: r.w, h: r.h }));
      } catch {
        /* private mode */
      }
    },
    [origin],
  );

  // The "last area" / "window in front" hotkeys: snip at once.
  useEffect(() => {
    if (!img || !capture || instantDone.current || !instant) return;
    instantDone.current = true;
    const r = capture.start_mode === "last" ? lastAreaIn(readLast(), capture.origin ?? [0, 0], capture) : (capture.active ?? null);
    if (r) {
      autoFinish.current = true;
      select(r);
    } else {
      say(capture.start_mode === "last" ? "No last area on these screens yet: drag one." : "No window in front: click one.");
      reveal();
    }
  }, [img, capture, instant, select, say, reveal]);

  // ------------------------------------------------------------ finish
  /** Pins the snip (with its markup) where it was taken, as a pop-out frame. */
  const popOut = useCallback(async () => {
    const c = canvasRef.current;
    if (!c || !sel || busy || !isTauri()) return;
    setBusy("Popping out…");
    try {
      rememberArea(sel);
      type Pos = { x: number; y: number };
      const w = window.__TAURI__?.window?.getCurrentWindow() as unknown as { outerPosition?: () => Promise<Pos> } | undefined;
      const at = (await w?.outerPosition?.().catch(() => null)) ?? { x: 0, y: 0 };
      await popOutCanvas(c, "Snip", undefined, { x: at.x + sel.x, y: at.y + sel.y });
      await lastshot.snipCancel();
    } catch (e) {
      setError(String(e));
      setBusy(null);
    }
  }, [sel, busy, rememberArea]);

  const finish = useCallback(
    /** `toEditor`: saved, then opened in the main window's editor. */
    async (save: boolean, toEditor = false) => {
      const c = canvasRef.current;
      if (!c || !sel || busy) return;
      setBusy(save ? "Saving…" : "Copying…");
      rememberArea(sel);
      try {
        const png = c.toDataURL("image/png");
        if (isTauri()) {
          const s = await lastshot.getSettings().catch(() => null);
          const jpg =
            s?.screenshotFormat === "jpg" ? c.toDataURL("image/jpeg", (s.screenshotQuality ?? 90) / 100) : undefined;
          const done = await lastshot.snipFinish(png, true, save || toEditor, jpg);
          if (toEditor && done.path) {
            // The editor queue waits for the main window if it is not up yet.
            postToEditor([done.path], { mode: "open" });
            await window.__TAURI__?.core.invoke("shell_open_tab", { tab: "editor", payload: null }).catch(() => undefined);
          }
        } else {
          const a = document.createElement("a");
          a.href = png;
          a.download = "Lastshot_demo.png";
          a.click();
          setBusy(null);
        }
      } catch (e) {
        setError(String(e));
        setBusy(null);
      }
    },
    [sel, busy, rememberArea],
  );
  // The hotkey's area is drawn: copy it (and save, as set) and close.
  useEffect(() => {
    if (autoFinish.current && sel && canvasVersion > 0) {
      autoFinish.current = false;
      void finish(false);
    }
  }, [canvasVersion, sel, finish]);

  const startRecording = useCallback(async () => {
    if (!sel || busy) return;
    setBusy("Starting…");
    rememberArea(sel);
    try {
      if (isTauri()) await lastshot.snipRecord(sel);
      else window.close();
    } catch (e) {
      setError(String(e));
      setBusy(null);
    }
  }, [sel, busy, rememberArea]);

  /** Copies the text in an area (Windows' OCR); a table keeps columns apart with tabs. */
  const copyText = useCallback(
    async (r: Rect, table = false) => {
      if (busy) return;
      if (!isTauri()) return say("Text recognition works in the installed app.");
      setBusy("Reading text…");
      try {
        const res = await lastshot.snipOcr(r, lang || undefined);
        const text = table ? ocrTable(res) : ocrText(res);
        if (!text.trim()) {
          setBusy(null);
          say("No text found there. Try a bigger area, or another text language (…).");
          return;
        }
        rememberArea(r);
        await lastshot.snipCopyText(text, table ? "Table copied" : "Text copied", `${linesLabel(text)}: paste with Ctrl+V.`);
      } catch (e) {
        setBusy(null);
        say(String(e));
      }
    },
    [busy, lang, say, rememberArea],
  );
  /** Black boxes over e-mails, phone and card numbers, IBANs and IPs in the area (one undo step). */
  const hidePrivate = useCallback(async () => {
    if (!sel || busy) return;
    if (!isTauri()) return say("Text recognition works in the installed app.");
    setBusy("Looking for personal details…");
    try {
      const res = await lastshot.snipOcr(sel, lang || undefined);
      const hits = privateBoxes(res);
      setBusy(null);
      if (!hits.length) return say("No e-mails, phone or card numbers found.");
      const pad = 2 * scale;
      const boxes: Shape[] = hits.map((h) => ({
        id: shapeId(),
        kind: "redact",
        x: h.box.x - sel.x - pad,
        y: h.box.y - sel.y - pad,
        w: h.box.w + 2 * pad,
        h: h.box.h + 2 * pad,
        rot: 0,
        color: "#000000",
        width: 0,
        opacity: 1,
      }));
      commitShapes([...shapesRef.current, ...boxes], "once", "Hide personal details");
      say(`Hid ${hits.length} detail${hits.length === 1 ? "" : "s"}. Ctrl+Z brings them back.`);
    } catch (e) {
      setBusy(null);
      say(String(e));
    }
  }, [sel, busy, lang, scale, say, commitShapes]);
  /** Copies the colour of a picture pixel in the chosen format. */
  const copyColour = useCallback(
    async (x: number, y: number) => {
      if (!img) return;
      const rgb = pixelAt(img, x, y);
      const text = colourText(...rgb, fmt);
      if (!isTauri()) return say(`${text} (copy works in the installed app)`);
      setBusy("Copying…");
      await lastshot.snipCopyText(text, `Copied ${text}`, "Paste it with Ctrl+V.").catch((e) => {
        setBusy(null);
        say(String(e));
      });
    },
    [img, fmt, say],
  );

  // A QR code in the area: show its text (decoded on the frozen pixels,
  // shortly after the area settles).
  useEffect(() => {
    if (!sel || mode !== "shot" || !isTauri()) return;
    const t = window.setTimeout(() => {
      void lastshot.snipQr(sel).then(setQr, () => setQr([]));
    }, 350);
    return () => window.clearTimeout(t);
  }, [sel, mode]);

  // ------------------------------------------------------------ keys
  const toggleSheet = useCallback((m: "keys" | "commands") => setSheet((s) => (s === m ? null : m)), []);
  const phase = !sel ? "pick" : mode === "rec" ? "rec" : "mark";
  const actions: SnipActions = {
    undo,
    redo,
    copy: () => void finish(false),
    save: () => void finish(true),
    toEditor: () => void finish(true, true),
    popOut: () => void popOut(),
    selectAll: () => setPicked(shapesRef.current.map((s) => s.id)),
    duplicate: duplicatePicked,
    lock: () => void editPicked((s) => ({ ...s, locked: !s.locked }), "Lock"),
    order: (dir) => commitShapes(reorder(shapesRef.current, new Set(picked), dir), "once", "Order"),
    rotate: (deg) => void editPicked((s) => rotateBy(s, deg), "Turn"),
    flip: (axis) => void editPicked((s) => flip(s, axis), "Flip"),
    enter: () => {
      const txt = shapesRef.current.find((s) => picked.includes(s.id) && s.kind === "text");
      if (txt) setEditing(txt.id);
      else void finish(false);
    },
    del: () => {
      const ids = new Set(picked);
      commitShapes(shapesRef.current.filter((s) => !ids.has(s.id) || s.locked), "once", "Delete");
      setPicked([]);
    },
    nudge: (dx, dy) => editPicked((s) => moveBy(s, dx * scale, dy * scale), "Nudge"),
    opacity: (v) => editPicked((s) => ({ ...s, opacity: v }), "Opacity"),
    tool: (t) => setTool(t as Tool),
    picked: () => picked.length > 0,
    copyText: () => sel && void copyText(sel),
    // Esc: closes a menu, then drops the selected objects, then cancels
    // (a drawing tool alone does not hold it up, as in ShareX).
    escape: () => {
      if (pop) setPop(null);
      else if (picked.length) {
        setPicked([]);
        setTool("select");
      } else cancel();
    },
    area: (dx, dy, resize) => {
      if (!sel) return;
      const px = Math.round(dx * scale) || dx;
      const py = Math.round(dy * scale) || dy;
      changeArea(resize ? resizeBox(sel, "se", px, py, picBounds, 1) : moveBox(sel, px, py, picBounds));
    },
    screen: () => selectScreen(),
    allScreens: selectAll,
    hovered: () => hover && select(hover),
    draw: drawOnScreen,
    textMode: () => setPick((p) => (p === "text" ? "area" : "text")),
    colourMode: () => setPick((p) => (p === "colour" ? "area" : "colour")),
    lastArea: () => void selectLast(),
    magnifier: () => setMag(!mag),
    hints: () => setHints(!hints),
    cancel,
    record: () => void startRecording(),
  };
  const keyList = toRegistry(snipKeymap(actions));
  /** The keys of this phase: "pick" before an area, "rec" for a recording, else marking up. */
  const inPhase = (s: Reg, p: string) => (p === "pick" ? s.context === "pick" : p === "rec" ? s.context === "rec" : s.context !== "pick" && s.context !== "rec");
  // Registered too, so F1 / ? and the command list show (and run) them.
  useShortcuts(
    "snip",
    keyList.map((s) => ({ ...s, when: () => !busy && inPhase(s, phase) && (!s.when || s.when()) })),
    !!img,
  );
  useShortcuts(APP_SCOPE, [
    { ...ak("cheat-sheet"), run: () => toggleSheet("keys") },
    { ...ak("commands"), run: () => toggleSheet("commands") },
  ]);

  // Capture phase: the snip's keys win over the viewer's; keys the snip
  // does not use (0 fit, 1 actual size, ...) still reach the viewer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editing || sheet) return; // typing in a text, or the key list is open
      if (busy && e.key !== "Escape") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
      if (phase === "mark" && e.code === "Space") {
        setSpace(true);
        return;
      }
      // Hold Z (or Ctrl+Space): drag to zoom; the viewer underneath does it.
      if (phase === "mark" && e.code === "KeyZ" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        setHoldZ(true);
        return;
      }
      const hit = matchKey("snip", keyList.filter((s) => inPhase(s, phase)), e);
      if (!hit) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      hit.run();
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpace(false);
      if (e.code === "KeyZ") setHoldZ(false);
    };
    const onBlur = () => {
      setSpace(false);
      setHoldZ(false);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onUp, true);
      window.removeEventListener("blur", onBlur);
    };
  });

  // ------------------------------------------------------------ picking pointer
  const onPickDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || busy) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    const [x, y] = toImage(e);
    setDrag({ x1: x, y1: y, x2: x, y2: y, square: e.shiftKey });
  };
  const onPickMove = (e: React.PointerEvent) => {
    const [x, y] = toImage(e);
    pointer.current = [x, y];
    setCursor({ cx: e.clientX, cy: e.clientY, px: x, py: y });
    if (drag) setDrag({ ...drag, x2: x, y2: y, square: e.shiftKey });
    else setHover(pick === "colour" ? null : windowAt(x, y));
  };
  const onPickUp = (e: React.PointerEvent) => {
    if (!drag) return;
    const [x, y] = toImage(e);
    const r = dragBox(drag.x1, drag.y1, x, y, e.shiftKey);
    setDrag(null);
    const click = r.w < 6 * scale && r.h < 6 * scale;
    if (pick === "colour") {
      void copyColour(x, y);
      return;
    }
    // A click: the window under the cursor, or that screen.
    const area = click ? (windowAt(x, y) ?? mons[monitorAt(mons, x, y)] ?? null) : r;
    if (!area) return;
    if (pick === "text") void copyText(area);
    else select(area);
  };

  // ------------------------------------------------------------ handles
  const handleDrag = useRef<{ kind: Handle | "move"; x0: number; y0: number; start: Rect } | null>(null);
  const onHandleDown = (kind: Handle | "move") => (e: React.PointerEvent) => {
    if (e.button !== 0 || !sel) return;
    e.stopPropagation();
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    handleDrag.current = { kind, x0: e.clientX, y0: e.clientY, start: sel };
  };
  const onHandleMove = (e: React.PointerEvent) => {
    const d = handleDrag.current;
    if (!d) return;
    const dx = (e.clientX - d.x0) * scale;
    const dy = (e.clientY - d.y0) * scale;
    changeArea(d.kind === "move" ? moveBox(d.start, dx, dy, picBounds) : resizeBox(d.start, d.kind, dx, dy, picBounds, 4));
  };
  const onHandleUp = () => {
    handleDrag.current = null;
  };

  // ------------------------------------------------------------ layout
  const css = (r: Rect) => ({ left: r.x / scale, top: r.y / scale, width: r.w / scale, height: r.h / scale });
  const cssRect = (r: Rect) => ({ x: r.x / scale, y: r.y / scale, w: r.w / scale, h: r.h / scale });
  const live: Rect | null = sel ? sel : drag ? dragBox(drag.x1, drag.y1, drag.x2, drag.y2, drag.square) : pick === "colour" ? null : hover;
  const liveCss = live ? css(live) : null;

  // ------------------------------------------------------------ objects layer
  /** Where the selection's pixels are on screen (follows the viewer's zoom). */
  const layerView: LayerView | null = !sel
    ? null
    : !zoomed || !vv
      ? { scale: 1 / scale, ox: sel.x / scale, oy: sel.y / scale }
      : vv.rot === 0 && !vv.flipH && !vv.flipV
        ? { scale: vv.scale, ox: vv.x - (sel.w / 2) * vv.scale, oy: vv.y - (sel.h / 2) * vv.scale }
        : null; // turned or mirrored: inspect only
  /** Clicking outside the selection with nothing drawn starts over. */
  const onLayerDownCapture = (e: React.PointerEvent) => {
    if (!sel || zoomed || e.button !== 0 || shapesRef.current.length || busy) return;
    const r = css(sel);
    if (e.clientX >= r.left && e.clientY >= r.top && e.clientX <= r.left + r.width && e.clientY <= r.top + r.height) return;
    e.stopPropagation();
    e.preventDefault();
    setSel(null);
    setQr([]);
    onPickDown(e);
  };

  // The screen the work is on: the selection's (by its middle), else the
  // one the mouse was on. Bars stay on it (never in the black between
  // monitors of different sizes).
  const work = useMemo(() => {
    const m = mons[sel ? monitorAt(mons, sel.x + sel.w / 2, sel.y + sel.h / 2) : home] ?? { x: 0, y: 0, w: view.w * scale, h: view.h * scale };
    return { x: m.x / scale, y: m.y / scale, w: m.w / scale, h: m.h / scale };
  }, [mons, sel, home, scale, view]);
  const toolbarStyle = useMemo(() => {
    if (!sel) return undefined;
    const r = css(sel);
    const B = work;
    const barH = 44;
    const below = r.top + r.height + 10;
    // Below the box, else above it; never under the picking bar at the top
    // (16 + 48 px) or the viewer's bar at the bottom (~56 px). A box that
    // fills the screen gets the tools inside it, under the picking bar.
    const bottomGap = viewTools ? 56 : 12;
    const top =
      below + barH < B.y + B.h - bottomGap ? below : r.top - barH - 10 > B.y + 72 ? r.top - barH - 10 : Math.max(r.top + 10, B.y + 72);
    const left = Math.max(B.x + 8, Math.min(r.left, B.x + B.w - 660));
    return { top, left, maxWidth: B.w - 16 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, scale, work, viewTools]);

  // The monitor under the mouse, for the magnifier's side.
  const magAt = useMemo(() => {
    if (!cursor) return null;
    const m = mons[monitorAt(mons, cursor.px, cursor.py)];
    const B = m ? { x: m.x / scale, y: m.y / scale, w: m.w / scale, h: m.h / scale } : work;
    const size = (pick === "colour" ? 170 : 135) + 4;
    const tall = size + 40;
    const left = cursor.cx + 20 + size > B.x + B.w ? cursor.cx - 20 - size : cursor.cx + 20;
    const top = cursor.cy + 20 + tall > B.y + B.h ? cursor.cy - 20 - tall : cursor.cy + 20;
    return { left, top };
  }, [cursor, mons, scale, work, pick]);

  if (error) {
    return (
      <div className="fixed inset-0 grid place-items-center bg-black/80 text-white">
        <div className="max-w-md rounded-xl border border-white/10 bg-[#1c1e25] p-5 text-center">
          <div className="text-[14px] font-semibold">
            {mode === "rec" ? "Could not start recording" : "Screenshot failed"}
          </div>
          <p className="mt-2 text-[12px] text-white/70">{error}</p>
          <button
            type="button"
            onClick={cancel}
            className="mt-4 rounded-lg bg-[#5d72db] px-4 py-1.5 text-[12px] font-semibold"
          >
            Close
          </button>
        </div>
      </div>
    );
  }
  if (!capture || !img) return <div className="fixed inset-0 bg-black" />;

  const barBtn = "flex items-center gap-1.5 whitespace-nowrap rounded-lg px-2 py-1.5 text-white/85 hover:bg-white/10 disabled:opacity-40";
  const menuItem = "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-white/85 hover:bg-white/10 disabled:opacity-40";
  const menuKey = (k: string) => (k ? <span className="ml-auto pl-3 font-mono text-[10.5px] text-white/40">{k}</span> : null);
  const check = (on: boolean) => <span className="w-3 text-center text-[10px] text-[#9fb0ff]">{on ? "✓" : ""}</span>;
  const pickHint =
    pick === "text"
      ? "Drag a box over text, or click a window: its text is copied"
      : pick === "colour"
        ? `Click a pixel: its colour is copied (${fmt.toUpperCase()})`
        : hover
          ? `Click: ${mode === "rec" ? "record" : "snip"} “${hover.title.slice(0, 32)}”`
          : `Drag a box or click a window to ${mode === "rec" ? "record" : "snip"}`;
  const hintKeys: [string, string][] = (
    [
      ["The window under the mouse", "window"],
      ["This whole screen", "screen"],
      ...(mons.length > 1 ? ([["Every screen at once", "all screens"]] as [string, string][]) : []),
      ["The last area again", "last area"],
      ["Copy text: drag a box over it", "text"],
      ["Pick a colour", "colour"],
      ["Draw on the screen", "draw"],
      ["Magnifier on / off", "magnifier"],
    ] as [string, string][]
  )
    .map(([label, what]) => [keyText(label), what] as [string, string])
    .filter(([k]) => !!k);
  const sheetKey = "F1";

  return (
    <div className="fixed inset-0 select-none overflow-hidden bg-black" style={{ cursor: sel ? "default" : pick === "colour" ? "cell" : "crosshair" }}>
      <img src={capture.image} alt="" draggable={false} className="pointer-events-none absolute inset-0 h-full w-full" />

      {/* Dim everything except the live rectangle. */}
      {zoomed && sel ? null : liveCss ? (
        <div
          className="pointer-events-none absolute rounded-[1px]"
          style={{
            ...liveCss,
            boxShadow: "0 0 0 99999px rgba(5,6,10,0.55)",
            outline: sel ? "1px solid rgba(255,255,255,0.9)" : pick === "text" ? "2px dashed #f5c542" : "2px solid #6b80e4",
          }}
        />
      ) : (
        <div className={cn("pointer-events-none absolute inset-0", pick === "colour" ? "bg-[rgba(5,6,10,0.15)]" : "bg-[rgba(5,6,10,0.55)]")} />
      )}

      {!sel && (
        <>
          <div
            className="absolute inset-0"
            onPointerDown={onPickDown}
            onPointerMove={onPickMove}
            onPointerUp={onPickUp}
            onPointerLeave={() => setCursor(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              cancel();
            }}
          />
          {cross && cursor && (
            <>
              <div className="pointer-events-none absolute inset-x-0 h-px bg-white/45" style={{ top: cursor.cy }} />
              <div className="pointer-events-none absolute inset-y-0 w-px bg-white/45" style={{ left: cursor.cx }} />
            </>
          )}
          {drag && liveCss && live && (
            <div
              className="pointer-events-none absolute rounded bg-black/75 px-1.5 py-0.5 font-mono text-[11px] text-white"
              style={{ left: liveCss.left, top: Math.max(0, liveCss.top - 22) }}
            >
              {live.w} × {live.h}
            </div>
          )}
          {cursor && magAt && (mag || pick === "colour") && !busy && (
            <Magnifier img={img} px={cursor.px} py={cursor.py} origin={origin} at={magAt} big={pick === "colour"} fmt={fmt} />
          )}
          {/* Key hints (ShareX style), faint; H hides them. Never in the picture. */}
          {hints && pick === "area" && !drag && (
            <div
              className="pointer-events-none absolute z-10 -translate-x-1/2 whitespace-nowrap rounded-full bg-black/45 px-3 py-1 text-[11px] text-white/60"
              style={{ left: work.x + work.w / 2, top: work.y + work.h - 40, maxWidth: work.w - 24, overflow: "hidden", textOverflow: "ellipsis" }}
              data-testid="snip-hints"
            >
              {hintKeys.map(([k, what]) => (
                <span key={what} className="mr-2.5">
                  <span className="font-mono text-white/80">{k}</span> {what}
                </span>
              ))}
              <span className="mr-2.5">
                <span className="font-mono text-white/80">{sheetKey}</span> all keys
              </span>
              <span>
                <span className="font-mono text-white/80">{keyText("Key hints on / off")}</span> hide this
              </span>
            </div>
          )}
        </>
      )}

      {!drag && (
        <div
          className="absolute z-20 flex w-max -translate-x-1/2 flex-wrap items-center justify-center gap-1 rounded-xl border border-white/10 bg-[#1c1e25]/95 p-1.5 text-[12px] text-white shadow-2xl"
          style={{ left: work.x + work.w / 2, top: work.y + 16, maxWidth: work.w - 16 }}
          data-testid="snip-bar"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="flex rounded-lg bg-black/30 p-0.5">
            {(
              [
                ["shot", "Screenshot", "M2 5h3l1.5-2h3L11 5h3v8H2zM8 11.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z"],
                ["rec", "Record", "M8 13A5 5 0 1 0 8 3a5 5 0 0 0 0 10z"],
              ] as const
            ).map(([id, label, icon]) => (
              <button
                key={id}
                type="button"
                disabled={!!busy}
                onClick={() => {
                  setMode(id);
                  if (id === "rec") setPick("area");
                }}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-3 py-1.5 font-medium transition-colors",
                  mode === id
                    ? id === "rec"
                      ? "bg-[#e5484d] text-white"
                      : "bg-[#5d72db] text-white"
                    : "text-white/70 hover:bg-white/10",
                )}
              >
                <svg
                  viewBox="0 0 16 16"
                  className={cn("h-3.5 w-3.5", id === "rec" ? "fill-current" : "fill-none stroke-current")}
                  strokeWidth="1.5"
                >
                  <path d={icon} />
                </svg>
                {label}
              </button>
            ))}
          </div>
          {!sel && mode === "shot" && (
            <>
              <button
                type="button"
                title={tipOf("Copy text: drag a box over it, or click a window", "Copy text: drag a box over it")}
                disabled={!!busy}
                onClick={actions.textMode}
                className={cn(barBtn, pick === "text" && "bg-white/15 text-white")}
                data-testid="snip-text"
              >
                <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-none stroke-current" strokeWidth="1.5" strokeLinecap="round">
                  <path d="M3 4V2.5h10V4M8 2.5v11M6 13.5h4" />
                </svg>
                Text
              </button>
              <button
                type="button"
                title={tipOf("Pick a colour: click a pixel, its colour is copied", "Pick a colour")}
                disabled={!!busy}
                onClick={actions.colourMode}
                className={cn(barBtn, pick === "colour" && "bg-white/15 text-white")}
                data-testid="snip-colour"
              >
                <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-none stroke-current" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10 2.5l3.5 3.5-1.5 1.5-3.5-3.5zM9 6l-6 6v1.5h1.5l6-6" />
                </svg>
                Colour
              </button>
            </>
          )}
          {!sel && (
            <button
              type="button"
              title={tipOf("Draw on the live screen: pen, arrows, boxes, text, spotlight", "Draw on the screen")}
              disabled={!!busy}
              onClick={drawOnScreen}
              className={barBtn}
              data-testid="snip-draw"
            >
              <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-none stroke-current" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 13c2-1 3-5 5-6s3 2 5 0" />
              </svg>
              Draw
            </button>
          )}
          {!sel && pick === "colour" && (
            <div className="flex rounded-lg bg-black/30 p-0.5" title="What a click copies">
              {COLOUR_FORMATS.map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFmt(f)}
                  className={cn("rounded-md px-2 py-1 font-mono text-[11px]", fmt === f ? "bg-white/20 text-white" : "text-white/65 hover:bg-white/10")}
                >
                  {f.toUpperCase()}
                </button>
              ))}
            </div>
          )}
          {!sel && pick === "text" && langs.length > 1 && (
            <select
              value={lang}
              onChange={(e) => setLang(e.target.value)}
              title="Text language"
              className="rounded-lg border border-white/15 bg-black/30 px-1.5 py-1 text-[11px] text-white/85"
            >
              <option value="">Language: mine</option>
              {langs.map((l) => (
                <option key={l.tag} value={l.tag}>
                  {l.name || l.tag}
                </option>
              ))}
            </select>
          )}
          <div className="mx-1 h-6 w-px bg-white/15" />
          {/* On a small screen the hint goes; the buttons (and ✕) always fit. */}
          <span className={cn("max-w-[420px] truncate whitespace-nowrap px-1 text-white/75", work.w < 820 && "hidden", notice && "text-[#ffd479]")} data-testid="snip-hint">
            {busy ?? notice ?? (sel ? (mode === "rec" ? "Drag the handles to adjust, or click outside to pick again" : "Draw on it, drag the handles, or click outside to pick again") : pickHint)}
          </span>
          {!sel && (
            <>
              <button type="button" title={tipOf(mons.length > 1 ? "This whole screen" : "The whole screen", "This whole screen")} disabled={!!busy} onClick={() => selectScreen(null)} className={barBtn} data-testid="snip-screen">
                Full screen
              </button>
              {mons.length > 1 && (
                <button type="button" title={tipOf("Every screen at once")} disabled={!!busy} onClick={selectAll} className={barBtn} data-testid="snip-all">
                  All screens
                </button>
              )}
            </>
          )}
          {!sel && (
            <div className="relative">
              <button type="button" title="More: last area, delay, magnifier, keys" onClick={() => setPop(pop === "more" ? null : "more")} className={cn(barBtn, pop === "more" && "bg-white/15")} data-testid="snip-pick-more">
                ⋯
              </button>
              {pop === "more" && (
                <div className="absolute right-0 top-full z-30 mt-1 w-[250px] rounded-lg border border-white/10 bg-[#1c1e25] p-1 shadow-2xl" data-testid="snip-pick-menu">
                  <button type="button" className={menuItem} onClick={() => (setPop(null), void selectLast())}>
                    {check(false)}The last area again{menuKey(keyText("The last area again"))}
                  </button>
                  {[3, 5, 10].map((s) => (
                    <button
                      key={s}
                      type="button"
                      className={menuItem}
                      disabled={!isTauri()}
                      onClick={() => void lastshot.snipDelay(s, mode).catch((e) => say(String(e)))}
                      data-testid={`snip-delay-${s}`}
                    >
                      {check(false)}Snip in {s} seconds
                    </button>
                  ))}
                  <div className="my-1 h-px bg-white/10" />
                  <button type="button" className={menuItem} onClick={() => setMag(!mag)}>
                    {check(mag)}Magnifier{menuKey(keyText("Magnifier on / off"))}
                  </button>
                  <button type="button" className={menuItem} onClick={() => setCross(!cross)}>
                    {check(cross)}Crosshair lines
                  </button>
                  <button type="button" className={menuItem} onClick={() => setHints(!hints)}>
                    {check(hints)}Key hints at the bottom{menuKey(keyText("Key hints on / off"))}
                  </button>
                  <button type="button" className={menuItem} onClick={() => (setPop(null), toggleSheet("keys"))}>
                    {check(false)}All keys{menuKey(sheetKey)}
                  </button>
                </div>
              )}
            </div>
          )}
          <button
            type="button"
            title={tipOf("Cancel", sel ? (mode === "rec" ? "Cancel the recording" : "Drop the selection, or cancel") : "Cancel the snip")}
            onClick={cancel}
            className="rounded-lg px-2 py-1.5 text-white/70 hover:bg-white/10"
          >
            ✕
          </button>
        </div>
      )}

      {sel && (
        <>
          {zoomed && <div className="pointer-events-none absolute inset-0 bg-[#0a0c10]" />}
          {/* The selection in the viewer: wheel zooms (to single pixels),
              Space+drag or the middle button pans. The viewer's own tools
              (turn, mirror, picker, measure…) are behind "Zoom and view
              tools" in the … menu; their keys always work. */}
          <Viewer
            className="absolute inset-0"
            source={canvasRef.current}
            version={canvasVersion}
            name="Lastshot snip"
            background="none"
            leftDragPans={false}
            bar={viewTools ? "show" : "none"}
            barPlace="bottom"
            // The picture lies exactly over the screen here, so the bar floats.
            barLayout="overlay"
            barBox={work}
            exportKeys={false}
            apiRef={viewer}
            homeView={(c) => viewForRect(c, cssRect(sel))}
            onViewChange={(v, _st, _c, fitted) => {
              setVv(v);
              // "Zoomed" = the user moved the view (or turned / mirrored it).
              // Not a comparison with the area's place: while the area is
              // being resized the view lags it by a frame, and that must not
              // hide the handles mid-drag.
              setZoomed(!fitted || Math.abs(normAngle(v.rot)) > 0.01 || v.flipH || v.flipV);
            }}
            onDoubleClick={() => void finish(false)}
          />
          {mode === "shot" && layerView && (
            <div
              className={cn("absolute inset-0", viewTools && "bottom-12")}
              style={{ pointerEvents: space || holdZ ? "none" : "auto" }}
              onPointerDownCapture={onLayerDownCapture}
              onWheel={(e) => {
                // The wheel zooms the viewer underneath.
                const el = e.currentTarget.previousElementSibling as HTMLElement | null;
                el?.dispatchEvent(
                  new WheelEvent("wheel", { deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode, clientX: e.clientX, clientY: e.clientY, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, bubbles: true, cancelable: true }),
                );
              }}
              onDoubleClick={() => {
                if (tool === "select" && !picked.length && !editing) void finish(false);
              }}
            >
              <AnnotationLayer
                className="absolute inset-0"
                shapes={shapes}
                content={{ w: sel.w, h: sel.h }}
                view={layerView}
                tool={tool}
                style={style}
                selected={picked}
                onSelect={setPicked}
                onChange={(changed, commit) => {
                  const by = new Map(changed.map((x) => [x.id, x]));
                  commitShapes(
                    shapesRef.current.map((x) => by.get(x.id) ?? x),
                    commit ? (gesture.current ? "end" : "once") : "live",
                    "Edit",
                  );
                }}
                onCreate={(x) => {
                  commitShapes([...shapesRef.current, x], "once", "Add");
                  setPicked([x.id]);
                }}
                onDelete={(ids) => {
                  const set = new Set(ids);
                  commitShapes(shapesRef.current.filter((x) => !set.has(x.id)), "once", "Delete");
                  setPicked([]);
                }}
                editing={editing}
                setEditing={setEditing}
                nextStep={shapes.filter((x) => x.kind === "step").reduce((m, x) => Math.max(m, x.n ?? 0), 0) + 1}
                penTarget={(tool === "pen" || tool === "highlight") && picked.length === 1 && shapes.find((x) => x.id === picked[0])?.kind === tool ? picked[0] : null}
                onToolDone={() => setTool("select")}
              />
            </div>
          )}

          {/* The area's handles and its size (drag ⠿ to move it). */}
          {!zoomed && liveCss && (
            <>
              {HANDLES.map((h) => {
                const x = h.includes("w") ? liveCss.left : h.includes("e") ? liveCss.left + liveCss.width : liveCss.left + liveCss.width / 2;
                const y = h.includes("n") ? liveCss.top : h.includes("s") ? liveCss.top + liveCss.height : liveCss.top + liveCss.height / 2;
                const cur = h === "n" || h === "s" ? "ns-resize" : h === "e" || h === "w" ? "ew-resize" : h === "nw" || h === "se" ? "nwse-resize" : "nesw-resize";
                return (
                  <div
                    key={h}
                    className="absolute z-[15] h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-[2px] border border-[#2a3050] bg-white shadow"
                    style={{ left: x, top: y, cursor: cur }}
                    onPointerDown={onHandleDown(h)}
                    onPointerMove={onHandleMove}
                    onPointerUp={onHandleUp}
                    data-testid={`snip-handle-${h}`}
                  />
                );
              })}
              <div
                className="absolute z-[15] flex items-center overflow-visible rounded-md bg-black/75 font-mono text-[11px] text-white shadow"
                style={{ left: liveCss.left, top: liveCss.top >= work.y + 96 ? liveCss.top - 26 : liveCss.top + 6 }}
                onPointerDown={(e) => e.stopPropagation()}
              >
                <span
                  className="cursor-move px-1.5 py-0.5 text-white/60 hover:text-white"
                  title="Drag to move the area (or the arrow keys; Ctrl+arrows size it)"
                  onPointerDown={onHandleDown("move")}
                  onPointerMove={onHandleMove}
                  onPointerUp={onHandleUp}
                  data-testid="snip-move"
                >
                  ⠿
                </span>
                <button type="button" className="rounded-r-md px-1.5 py-0.5 hover:bg-white/15" title="Type a size, or pick one" onClick={() => setPop(pop === "size" ? null : "size")} data-testid="snip-size">
                  {sel.w} × {sel.h}
                </button>
                {pop === "size" && (
                  <SizePop
                    sel={sel}
                    onSize={(w, h) => changeArea(sizeBox(sel, w, h, picBounds))}
                    onClose={() => setPop(null)}
                  />
                )}
              </div>
            </>
          )}

          {zoomed && !viewTools && (
            <button
              type="button"
              className="absolute z-20 -translate-x-1/2 rounded-full bg-black/75 px-3 py-1 text-[11.5px] text-white/85 hover:bg-black/90"
              style={{ left: work.x + work.w / 2, top: work.y + work.h - 44 }}
              title="Back to the area as it lies on the screen (0)"
              onClick={() => viewer.current?.fit()}
              data-testid="snip-unzoom"
            >
              Zoomed: back to fit <span className="font-mono text-white/50">0</span>
            </button>
          )}

          {mode === "rec" ? (
            <div
              className="absolute z-10 flex items-center gap-1.5 rounded-xl border border-white/10 bg-[#1c1e25]/95 p-1.5 text-white shadow-2xl"
              style={toolbarStyle}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <span className="px-2 text-[12px] text-white/80">
                Record this area · <span className="font-mono">{sel.w} × {sel.h}</span>
              </span>
              <button
                type="button"
                title={tipOf("Cancel", "Cancel the recording")}
                onClick={cancel}
                className="rounded-lg px-2 py-1.5 text-[12px] text-white/80 hover:bg-white/10"
              >
                Cancel
              </button>
              <button
                type="button"
                title={`${tipOf("Start recording")}. Stop it from the control bar, the Home page or the record shortcut.`}
                disabled={!!busy}
                onClick={() => void startRecording()}
                className="flex items-center gap-1.5 rounded-lg bg-[#e5484d] px-3 py-1.5 text-[12px] font-semibold hover:bg-[#ec5d62] disabled:opacity-60"
              >
                <span className="h-2 w-2 rounded-full bg-white" />
                {busy ?? "Start recording"}
              </button>
            </div>
          ) : (
            <div
              className="absolute z-10 flex flex-wrap items-center gap-1 rounded-xl border border-white/10 bg-[#1c1e25]/95 p-1.5 text-white shadow-2xl"
              style={toolbarStyle}
              onPointerDown={(e) => e.stopPropagation()}
              data-testid="snip-markup-bar"
            >
              {MAIN_TOOLS.map((id) => {
                const t = TOOLS.find((x) => x.id === id)!;
                return (
                  <button
                    key={t.id}
                    type="button"
                    title={`${t.label}${keyOf(t.id) ? ` (${keyOf(t.id)})` : ""}`}
                    onClick={() => setTool(t.id)}
                    className={cn("grid h-8 w-8 place-items-center rounded-lg transition-colors", tool === t.id ? "bg-[#5d72db] text-white" : "text-white/75 hover:bg-white/10")}
                    data-testid={`snip-tool-${t.id}`}
                  >
                    <svg viewBox="0 0 16 16" className="h-4 w-4 fill-none stroke-current" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                      <path d={t.icon} />
                    </svg>
                  </button>
                );
              })}
              <div className="relative">
                {(() => {
                  const cur = MORE_TOOLS.includes(tool) ? TOOLS.find((x) => x.id === tool) : null;
                  return (
                    <button
                      type="button"
                      title="More tools: ellipse, line, pixelate, spotlight"
                      onClick={() => setPop(pop === "tools" ? null : "tools")}
                      className={cn("flex h-8 items-center gap-0.5 rounded-lg px-1.5 transition-colors", cur ? "bg-[#5d72db] text-white" : "text-white/75 hover:bg-white/10")}
                      data-testid="snip-more-tools"
                    >
                      {cur ? (
                        <svg viewBox="0 0 16 16" className="h-4 w-4 fill-none stroke-current" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                          <path d={cur.icon} />
                        </svg>
                      ) : (
                        <span className="text-[12px]">More</span>
                      )}
                      <span className="text-[9px]">▾</span>
                    </button>
                  );
                })()}
                {pop === "tools" && (
                  <div className="absolute left-0 top-full z-30 mt-1 w-[210px] rounded-lg border border-white/10 bg-[#1c1e25] p-1 shadow-2xl">
                    {MORE_TOOLS.map((id) => {
                      const t = TOOLS.find((x) => x.id === id)!;
                      return (
                        <button key={id} type="button" className={cn(menuItem, tool === id && "bg-white/10")} onClick={() => (setTool(id), setPop(null))}>
                          <svg viewBox="0 0 16 16" className="h-4 w-4 shrink-0 fill-none stroke-current" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                            <path d={t.icon} />
                          </svg>
                          {t.label}
                          {menuKey(keyOf(id) ?? "")}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
              <div className="mx-1 h-6 w-px bg-white/15" />
              <div className="relative">
                <button
                  type="button"
                  title="Colour (also changes the selected objects)"
                  onClick={() => setPop(pop === "colour" ? null : "colour")}
                  className={cn("grid h-8 w-8 place-items-center rounded-lg hover:bg-white/10", pop === "colour" && "bg-white/10")}
                  data-testid="snip-colour-btn"
                >
                  <span className="h-4 w-4 rounded-full border-2 border-white/70" style={{ background: style.color }} />
                </button>
                {pop === "colour" && (
                  <div className="absolute left-0 top-full z-30 mt-1 flex items-center gap-1.5 rounded-lg border border-white/10 bg-[#1c1e25] p-2 shadow-2xl">
                    {PALETTE.map((c) => (
                      <button
                        key={c}
                        type="button"
                        title={c}
                        onClick={() => {
                          setStyle({ color: c });
                          editPicked((x) => ({ ...x, color: c }), "Colour");
                          setPop(null);
                        }}
                        className={cn("h-5 w-5 rounded-full border-2 transition-transform", style.color === c ? "scale-110 border-white" : "border-white/20 hover:scale-105")}
                        style={{ background: c }}
                      />
                    ))}
                    <input
                      type="color"
                      value={/^#[0-9a-f]{6}$/i.test(style.color) ? style.color : "#ff4d4f"}
                      title="Any colour"
                      onChange={(e) => {
                        setStyle({ color: e.target.value });
                        editPicked((x) => ({ ...x, color: e.target.value }), "Colour");
                      }}
                      className="h-6 w-7 cursor-pointer rounded bg-transparent"
                    />
                  </div>
                )}
              </div>
              <button
                type="button"
                title="Style: width, fill, text size, outline, opacity, turn, flip, order, lock"
                onClick={() => {
                  const open = pop !== "style";
                  setPop(open ? "style" : null);
                  writePref("styleOpen", open ? "1" : "0");
                }}
                className={cn("rounded-lg px-2 py-1.5 text-[12px]", pop === "style" ? "bg-white/15 text-white" : "text-white/80 hover:bg-white/10")}
                data-testid="snip-style"
              >
                Style ▾
              </button>
              <div className="mx-1 h-6 w-px bg-white/15" />
              <button
                type="button"
                title={tipOf(hist.current.undoLabel ? `Undo ${hist.current.undoLabel.toLowerCase()}` : "Undo", "Undo")}
                disabled={!hist.current.undoLabel}
                onClick={undo}
                className="grid h-8 w-8 place-items-center rounded-lg text-white/80 hover:bg-white/10 disabled:opacity-30"
                data-testid="snip-undo"
              >
                <svg viewBox="0 0 16 16" className="h-4 w-4 fill-none stroke-current" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 3L2 6l3 3M2 6h7.5a4 4 0 0 1 0 8H7" />
                </svg>
              </button>
              <div className="relative">
                <button
                  type="button"
                  title="More: copy text, redo, pop out, editor, view tools"
                  onClick={() => setPop(pop === "more" ? null : "more")}
                  className={cn("grid h-8 w-8 place-items-center rounded-lg text-white/80 hover:bg-white/10", pop === "more" && "bg-white/15")}
                  data-testid="snip-more"
                >
                  ⋯
                </button>
                {pop === "more" && (
                  <div className="absolute right-0 top-full z-30 mt-1 w-[270px] rounded-lg border border-white/10 bg-[#1c1e25] p-1 shadow-2xl" data-testid="snip-more-menu">
                    <button type="button" className={menuItem} disabled={!hist.current.redoLabel} onClick={() => (setPop(null), redo())}>
                      {check(false)}Redo{menuKey(keyText("Redo"))}
                    </button>
                    <div className="my-1 h-px bg-white/10" />
                    <button type="button" className={menuItem} onClick={() => (setPop(null), void copyText(sel))} data-testid="snip-copy-text">
                      {check(false)}Copy the text in it{menuKey(keyText("Copy the text in it"))}
                    </button>
                    <button type="button" className={menuItem} onClick={() => (setPop(null), void copyText(sel, true))} data-testid="snip-copy-table">
                      {check(false)}Copy the text as a table
                    </button>
                    <button type="button" className={menuItem} onClick={() => (setPop(null), void hidePrivate())} data-testid="snip-hide-private">
                      {check(false)}Hide e-mails, phone and card numbers
                    </button>
                    <div className="my-1 h-px bg-white/10" />
                    {isTauri() && (
                      <button type="button" className={menuItem} onClick={() => (setPop(null), void popOut())}>
                        {check(false)}Pop out: pin it on top of other apps{menuKey(keyText("Pop out as a frame"))}
                      </button>
                    )}
                    <button type="button" className={menuItem} onClick={() => (setPop(null), void finish(true, true))}>
                      {check(false)}Open in the editor{menuKey(keyText("Open in the editor"))}
                    </button>
                    <div className="my-1 h-px bg-white/10" />
                    <button type="button" className={menuItem} onClick={() => setViewTools(!viewTools)} data-testid="snip-view-tools">
                      {check(viewTools)}Zoom and view tools (turn, mirror, picker, measure)
                    </button>
                    <button type="button" className={menuItem} onClick={() => (setPop(null), toggleSheet("keys"))}>
                      {check(false)}All keys{menuKey(sheetKey)}
                    </button>
                    <button type="button" className={menuItem} onClick={cancel}>
                      {check(false)}Cancel{menuKey("Esc")}
                    </button>
                  </div>
                )}
              </div>
              <button
                type="button"
                title={`${tipOf("Save", "Save, copy and close")} to the Screenshots folder and copy`}
                disabled={!!busy}
                onClick={() => void finish(true)}
                className="rounded-lg border border-white/15 px-2.5 py-1.5 text-[12px] font-medium hover:bg-white/10 disabled:opacity-50"
              >
                Save
              </button>
              <button
                type="button"
                title={`${tipOf("Copy", "Copy and close")} to the clipboard (or Enter)`}
                disabled={!!busy}
                onClick={() => void finish(false)}
                className="rounded-lg bg-[#5d72db] px-3 py-1.5 text-[12px] font-semibold hover:bg-[#6b80e4] disabled:opacity-60"
                data-testid="snip-copy"
              >
                {busy ?? "Copy"}
              </button>
            </div>
          )}
          {mode === "shot" && qr.length > 0 && toolbarStyle && (
            <div
              className="absolute z-10 flex max-w-[520px] items-center gap-1.5 rounded-lg border border-white/10 bg-[#1c1e25]/95 px-2 py-1 text-[11.5px] text-white shadow-2xl"
              style={{ top: toolbarStyle.top > (sel.y / scale) ? toolbarStyle.top + 50 : toolbarStyle.top - 34, left: toolbarStyle.left }}
              onPointerDown={(e) => e.stopPropagation()}
              data-testid="snip-qr"
            >
              <span className="rounded bg-white/15 px-1 font-mono text-[10px]">QR</span>
              <span className="min-w-0 flex-1 truncate" title={qr[0]}>
                {qr[0]}
              </span>
              {/^https?:\/\//i.test(qr[0]) && (
                <button type="button" className="rounded px-1.5 py-0.5 hover:bg-white/10" onClick={() => openLink(qr[0])} title="Open the link in your browser">
                  Open
                </button>
              )}
              <button type="button" className="rounded px-1.5 py-0.5 hover:bg-white/10" onClick={() => void lastshot.snipCopyText(qr[0], "QR code text copied", qr[0]).catch((e) => say(String(e)))}>
                Copy
              </button>
            </div>
          )}
          {mode === "shot" && pop === "style" && (
            <div
              className="absolute z-10 max-h-[60vh] w-[270px] overflow-y-auto rounded-xl border border-white/10 bg-[#1c1e25]/95 p-3 text-white shadow-2xl"
              style={{ top: (toolbarStyle?.top ?? 60) + 52, left: toolbarStyle?.left ?? 8 }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <StyleControls
                selected={shapes.filter((x) => picked.includes(x.id))}
                style={style}
                onStyle={setStyle}
                tool={tool}
                onPatch={(fn, commit) => {
                  const ids = new Set(picked);
                  commitShapes(shapesRef.current.map((x) => (ids.has(x.id) ? { ...x, ...fn(x) } : x)), commit ? (gesture.current ? "end" : "once") : "live", "Style");
                }}
                arrange={{
                  flip: (axis) => void editPicked((x) => flip(x, axis), "Flip"),
                  rotate: (deg) => void editPicked((x) => rotateBy(x, deg), "Turn"),
                  duplicate: duplicatePicked,
                  remove: () => {
                    const ids = new Set(picked);
                    commitShapes(shapesRef.current.filter((x) => !ids.has(x.id)), "once", "Delete");
                    setPicked([]);
                  },
                  order: (dir) => commitShapes(reorder(shapesRef.current, new Set(picked), dir), "once", "Order"),
                  lock: () => void editPicked((x) => ({ ...x, locked: !x.locked }), "Lock"),
                  align: (how) => {
                    const ids = new Set(picked);
                    const moved = align(shapesRef.current.filter((x) => ids.has(x.id)), how, { w: sel.w, h: sel.h });
                    const by = new Map(moved.map((x) => [x.id, x]));
                    commitShapes(shapesRef.current.map((x) => by.get(x.id) ?? x), "once", "Align");
                  },
                }}
              />
            </div>
          )}
        </>
      )}
      {sheet && (
        <>
          {/* A click anywhere else closes the list (never starts a snip). */}
          <div className="absolute inset-0 z-[89]" onPointerDown={(e) => (e.stopPropagation(), setSheet(null))} />
          {/* On the work screen only (the list is "fixed" inside this box). */}
          <div className="absolute z-[90]" style={{ left: work.x, top: work.y, width: work.w, height: work.h, transform: "translateZ(0)" }} data-testid="snip-sheet">
            <ShortcutsOverlay
              mode={sheet}
              onClose={() => setSheet(null)}
              onEdit={() => {
                void window.__TAURI__?.core.invoke("shell_open_tab", { tab: "settings", payload: { section: "shortcuts" } }).catch(() => undefined);
                cancel();
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}

/** Typed width and height for the area, plus common sizes. */
function SizePop({ sel, onSize, onClose }: { sel: Rect; onSize: (w: number, h: number) => void; onClose: () => void }) {
  const [w, setW] = useState(String(sel.w));
  const [h, setH] = useState(String(sel.h));
  useEffect(() => {
    setW(String(sel.w));
    setH(String(sel.h));
  }, [sel.w, sel.h]);
  const apply = () => {
    const W = Number(w);
    const H = Number(h);
    if (W > 0 && H > 0) onSize(W, H);
  };
  const field = (v: string, set: (s: string) => void, label: string) => (
    <input
      value={v}
      onChange={(e) => set(e.target.value.replace(/[^\d]/g, ""))}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") apply();
        if (e.key === "Escape") onClose();
      }}
      onBlur={apply}
      aria-label={label}
      inputMode="numeric"
      className="w-16 rounded border border-white/15 bg-black/40 px-1.5 py-1 text-right font-mono text-[12px] text-white focus:border-white/40 focus:outline-none"
    />
  );
  return (
    <div className="absolute left-0 top-full z-30 mt-1 w-[230px] rounded-lg border border-white/10 bg-[#1c1e25] p-2 font-sans text-[12px] text-white shadow-2xl" data-testid="snip-size-pop">
      <div className="flex items-center gap-1.5">
        {field(w, setW, "Width")}
        <span className="text-white/50">×</span>
        {field(h, setH, "Height")}
        <span className="text-[11px] text-white/50">px</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        {AREA_SIZES.map((s) => (
          <button key={s.label} type="button" className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10.5px] hover:bg-white/20" onClick={() => onSize(s.w, s.h)}>
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}
