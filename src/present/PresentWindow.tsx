import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import AnnotationLayer from "../annotate/AnnotationLayer";
import { drawShape } from "../annotate/draw";
import { TOOLS } from "../annotate/StyleControls";
import { type Pt, type Shape, type Style, PALETTE, hit, moveBy, shapeId } from "../annotate/shapes";
import { monitorAt, monitorsOf } from "../components/snipGeo";
import { DRAW_TOOL_KEYS, drawKeymap } from "../editor/keys";
import { DRAW_KEYS, keyOfLabel, matchKey, toRegistry } from "../editor/keyTables";
import { isTauri, lastshot, showCurrentWindow } from "../lib/bridge";
import { setShortcutOverrides } from "../lib/shortcuts";
import { useShortcuts } from "../lib/useShortcuts";
import { APP_SCOPE, ak } from "../lib/appKeys";
import ShortcutsOverlay from "../components/ShortcutsOverlay";
import type { PresentInfo } from "../lib/types";
import { History } from "../timeline/history";
import { cn } from "../utils/cn";
import {
  type Board,
  type DrawPrefs,
  type DrawTool,
  MAIN_TOOLS,
  MORE_TOOLS,
  FADE_CHOICES,
  PEN_WIDTHS,
  along,
  boardCss,
  clampBar,
  clampFade,
  fadeAlpha,
  parseDrawPrefs,
  stepWidth,
  toggleBoard,
} from "./drawPrefs";

/**
 * Draw on screen (presentation mode): a transparent window over the live
 * screens (the snip bar's Draw, D). Pen, highlighter, eraser (X), arrows,
 * lines, boxes, ellipses, text, number steps and a spotlight, all movable
 * with V.
 *
 * - Mouse mode (M): the drawing stays, clicks go to the apps under it; the
 *   bar still takes clicks (a tool brings drawing back).
 * - C clears, I hides / shows the drawing, W / K a white or black board,
 *   1-7 colours, [ ] pen width, Ctrl+Z / Ctrl+Y, Ctrl+S snips the screen
 *   with the drawing. Esc deselects, then stops drawing. F1 or ? lists
 *   every key (all of them can be changed in Settings › Shortcuts).
 * - More (⋯): the board, and ink that fades away after a few seconds.
 * - The last drawing is kept when it closes: "Bring back" restores it.
 *
 * Shapes are in the window's physical pixels (like the snip's picture).
 */

const PREFS_KEY = "lastshot.draw.prefs";
const LAST_KEY = "lastshot.draw.last";

function readStore(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStore(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage off or full: only a convenience */
  }
}

function readLast(): Shape[] | null {
  try {
    const v = JSON.parse(readStore(LAST_KEY) ?? "null") as unknown;
    return Array.isArray(v) && v.length ? (v as Shape[]) : null;
  } catch {
    return null;
  }
}

/** In a plain browser (`?present`): the page is the whole "screen". */
function demoInfo(): PresentInfo {
  const d = window.devicePixelRatio || 1;
  return { width: Math.round(window.innerWidth * d), height: Math.round(window.innerHeight * d), monitors: [], home: 0 };
}

const svg = (d: string, cls = "h-4 w-4") => (
  <svg viewBox="0 0 16 16" className={cn(cls, "fill-none stroke-current")} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);
const ICON = {
  grip: "M6 3.5h.01M10 3.5h.01M6 8h.01M10 8h.01M6 12.5h.01M10 12.5h.01",
  undo: "M5.5 4L2.5 7l3 3M2.5 7h7a4 4 0 0 1 0 8H8",
  redo: "M10.5 4l3 3-3 3M13.5 7h-7a4 4 0 0 0 0 8H8",
  clear: "M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9",
  eye: "M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8zM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  eyeOff: "M2 2l12 12M6.6 6.6a2 2 0 0 0 2.8 2.8M4.2 4.6C2.6 5.8 1.5 8 1.5 8s2.4 4.5 6.5 4.5c1.3 0 2.4-.4 3.3-1M7 3.6c.3 0 .7-.1 1-.1 4.1 0 6.5 4.5 6.5 4.5s-.5 1-1.5 2.1",
  mouse: "M4 2l8.5 6-3.6.8 2.3 4.4-1.7.9-2.3-4.4L4.5 12z",
  camera: "M2 5h3l1.5-2h3L11 5h3v8H2zM8 11.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
  more: "M3.5 8h.01M8 8h.01M12.5 8h.01",
  shapes: "M2.5 13.5l4-7 4 7zM10 2.5h3.5V6H10z",
  eraser: "M6.5 13.5h7M3.2 9.8l5.6-6.3 4.3 3.8-5.6 6.2H5.8z",
  close: "M4 4l8 8M12 4l-8 8",
};

export default function PresentWindow() {
  // The user's keys (Settings → Shortcuts → Draw on screen).
  useEffect(() => {
    if (isTauri())
      void lastshot
        .getSettings()
        .then((s) => setShortcutOverrides(s.shortcuts))
        .catch(() => undefined);
  }, []);
  const [info, setInfo] = useState<PresentInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [prefs, setPrefsState] = useState<DrawPrefs>(() => parseDrawPrefs(readStore(PREFS_KEY)));
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const [shapes, setShapesState] = useState<Shape[]>([]);
  const shapesRef = useRef<Shape[]>([]);
  shapesRef.current = shapes;
  const [picked, setPickedState] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const editingRef = useRef<string | null>(null);
  editingRef.current = editing;
  const [mouse, setMouse] = useState(false);
  const [hidden, setHidden] = useState(false);
  const hiddenRef = useRef(false);
  hiddenRef.current = hidden;
  const [menu, setMenu] = useState<null | "more" | "width" | "colour" | "tools">(null);
  const [snipping, setSnipping] = useState(false);
  const [barPos, setBarPos] = useState<{ x: number; y: number } | null>(null);
  const [last, setLast] = useState<Shape[] | null>(readLast);
  const hist = useRef(new History<Shape[]>());
  const gesture = useRef<Shape[] | null>(null);
  const [, setHv] = useState(0);
  const born = useRef(new Map<string, number>());
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const shown = useRef(false);

  const { tool, style, board, fade } = prefs;
  // Physical pixels per CSS pixel.
  const scale = info ? info.width / Math.max(1, view.w) : window.devicePixelRatio || 1;
  const mons = useMemo(() => monitorsOf(info), [info]);
  const home = Math.max(0, Math.min(mons.length - 1, info?.home ?? 0));
  // The bar starts at the top of the screen the mouse was on.
  const work = useMemo(() => {
    const m = mons[home] ?? { x: 0, y: 0, w: view.w * scale, h: view.h * scale };
    return { x: m.x / scale, y: m.y / scale, w: m.w / scale, h: m.h / scale };
  }, [mons, home, scale, view]);

  const setPrefs = useCallback((p: Partial<DrawPrefs>) => {
    setPrefsState((cur) => {
      const next = { ...cur, ...p };
      writeStore(PREFS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);
  const setStyle = useCallback((p: Partial<Style>) => setPrefs({ style: { ...prefsRef.current.style, ...p } }), [setPrefs]);
  // Only the select tool selects: drawing never leaves handles on the screen.
  const setPicked = useCallback((ids: string[]) => {
    setPickedState(prefsRef.current.tool === "select" || !ids.length ? ids : []);
  }, []);

  // ------------------------------------------------------------ objects + undo
  const setShapes = (next: Shape[]) => {
    shapesRef.current = next;
    setShapesState(next);
    setHv((x) => x + 1);
  };
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
    setShapes(next);
  }, []);
  const undo = useCallback(() => {
    const prev = hist.current.undo(shapesRef.current);
    if (!prev) return;
    setEditing(null);
    setShapes(prev);
  }, []);
  const redo = useCallback(() => {
    const next = hist.current.redo(shapesRef.current);
    if (next) setShapes(next);
  }, []);
  const clear = useCallback(() => {
    if (!shapesRef.current.length) return;
    setEditing(null);
    setPickedState([]);
    commitShapes([], "once", "Clear");
  }, [commitShapes]);
  /** Changes the selected objects (one undo step). */
  const editPicked = useCallback(
    (fn: (s: Shape) => Shape, label: string) => {
      if (!picked.length) return;
      const ids = new Set(picked);
      commitShapes(shapesRef.current.map((s) => (ids.has(s.id) && !s.locked ? fn(s) : s)), "once", label);
    },
    [picked, commitShapes],
  );

  // A tool, a colour or a width also applies to what is selected, and
  // picking a tool always comes back from mouse mode and shows the drawing.
  const chooseTool = useCallback(
    (t: DrawTool) => {
      setPrefs({ tool: t });
      if (t !== "select") setPickedState([]);
      setMouse(false);
      setHidden(false);
      setMenu(null);
    },
    [setPrefs],
  );
  const chooseColour = useCallback(
    (c: string) => {
      setStyle({ color: c });
      editPicked((s) => ({ ...s, color: c }), "Colour");
    },
    [setStyle, editPicked],
  );
  const chooseWidth = useCallback(
    (w: number) => {
      const v = Math.max(1, Math.min(200, Math.round(w)));
      setStyle({ width: v });
      editPicked((s) => (s.kind === "text" || s.kind === "step" ? s : { ...s, width: v }), "Width");
    },
    [setStyle, editPicked],
  );

  // ------------------------------------------------------------ load + show
  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    let alive = true;
    (isTauri() ? lastshot.presentInfo() : Promise.resolve(demoInfo()))
      .then((i) => alive && setInfo(i))
      .catch((e) => alive && setError(String(e)));
    const onResize = () => setView({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => {
      alive = false;
      window.removeEventListener("resize", onResize);
    };
  }, []);
  useEffect(() => {
    if ((!info && !error) || shown.current) return;
    shown.current = true;
    requestAnimationFrame(() => requestAnimationFrame(() => void showCurrentWindow()));
  }, [info, error]);

  // ------------------------------------------------------------ painting
  const paint = useCallback(() => {
    const c = canvasRef.current;
    if (!c || !info) return;
    if (c.width !== info.width || c.height !== info.height) {
      c.width = info.width;
      c.height = info.height;
    }
    const g = c.getContext("2d")!;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, c.width, c.height);
    if (hiddenRef.current) return;
    const now = performance.now();
    const f = prefsRef.current.fade;
    // Spotlights dim the screen, never the ink: they go underneath.
    const list = shapesRef.current;
    const ordered = [...list.filter((s) => s.kind === "spotlight"), ...list.filter((s) => s.kind !== "spotlight")];
    for (const s of ordered) {
      if (s.id === editingRef.current || s.hidden) continue;
      const a = f > 0 ? fadeAlpha(now - (born.current.get(s.id) ?? now), f) : 1;
      if (a <= 0) continue;
      drawShape(g, a < 1 ? { ...s, opacity: s.opacity * a } : s, { content: { w: c.width, h: c.height } });
    }
  }, [info]);

  // When each object appeared (for fading ink).
  useLayoutEffect(() => {
    const now = performance.now();
    const ids = new Set(shapes.map((s) => s.id));
    for (const s of shapes) if (!born.current.has(s.id)) born.current.set(s.id, now);
    for (const id of [...born.current.keys()]) if (!ids.has(id)) born.current.delete(id);
    paint();
  }, [shapes, editing, hidden, fade, paint]);

  // Fading ink: redraw while something fades, drop what has gone.
  useEffect(() => {
    if (!(fade > 0) || !shapes.length) return;
    let raf = 0;
    const tick = () => {
      const now = performance.now();
      const total = fade * 1000;
      let fading = false;
      const gone: string[] = [];
      for (const s of shapesRef.current) {
        if (s.id === editingRef.current) continue;
        const age = now - (born.current.get(s.id) ?? now);
        if (age >= total) gone.push(s.id);
        else if (age > (total * 2) / 3) fading = true;
      }
      if (gone.length) {
        const g = new Set(gone);
        setPickedState((p) => p.filter((id) => !g.has(id)));
        setShapes(shapesRef.current.filter((s) => !g.has(s.id)));
      } else if (fading) paint();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [fade, shapes.length, paint]);

  // ------------------------------------------------------------ closing, snipping
  const close = useCallback(() => {
    if (shapesRef.current.length) writeStore(LAST_KEY, JSON.stringify(shapesRef.current));
    void lastshot.presentClose();
  }, []);
  const restore = useCallback(() => {
    if (!last) return;
    commitShapes([...shapesRef.current, ...last.map((s) => ({ ...s, id: shapeId() }))], "once", "Bring back");
    setLast(null);
  }, [last, commitShapes]);
  const snip = useCallback(async () => {
    setMenu(null);
    setPickedState([]);
    setEditing(null);
    setMouse(false);
    setSnipping(true);
    // The bar leaves the picture first.
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60))));
    try {
      await lastshot.presentSnip();
    } catch (e) {
      setError(String(e));
    } finally {
      setSnipping(false);
    }
  }, []);

  // ------------------------------------------------------------ mouse mode
  const reportThrough = useCallback(() => {
    if (!isTauri()) return;
    if (!mouse) {
      void lastshot.presentThrough(false, null).catch(() => undefined);
      return;
    }
    const r = barRef.current?.getBoundingClientRect();
    const bar: [number, number, number, number] | null = r ? [r.left * scale, r.top * scale, r.width * scale, r.height * scale] : null;
    void lastshot.presentThrough(true, bar).catch(() => undefined);
  }, [mouse, scale]);
  useEffect(() => {
    reportThrough();
  }, [reportThrough, barPos]);
  useEffect(() => {
    const el = barRef.current;
    if (!el || !mouse) return;
    const ro = new ResizeObserver(() => reportThrough());
    ro.observe(el);
    return () => ro.disconnect();
  }, [mouse, reportThrough]);
  useEffect(() => {
    if (mouse) {
      setPickedState([]);
      setMenu(null);
    }
  }, [mouse]);

  // ------------------------------------------------------------ keyboard
  const [sheet, setSheet] = useState<null | "keys" | "commands">(null);
  const toggleSheet = useCallback((m: "keys" | "commands") => {
    setMouse(false); // the list takes clicks
    setSheet((s) => (s === m ? null : m));
  }, []);
  /** The screen the bar is on (CSS px), for the key list. */
  const sheetBox = () => {
    const r = barRef.current?.getBoundingClientRect();
    const m = r ? mons[monitorAt(mons, (r.left + r.width / 2) * scale, (r.top + r.height / 2) * scale)] : undefined;
    return m ? { left: m.x / scale, top: m.y / scale, width: m.w / scale, height: m.h / scale } : { left: work.x, top: work.y, width: work.w, height: work.h };
  };
  const drawList = toRegistry(
    drawKeymap({
      undo,
      redo,
      selectAll: () => {
        setPrefs({ tool: "select" });
        setPickedState(shapesRef.current.map((s) => s.id));
      },
      duplicate: () => {
        const ids = new Set(picked);
        const copies = shapesRef.current.filter((x) => ids.has(x.id)).map((x) => ({ ...moveBy(x, 16 * scale, 16 * scale), id: shapeId(), locked: false }));
        if (!copies.length) return;
        commitShapes([...shapesRef.current, ...copies], "once", "Duplicate");
        setPickedState(copies.map((c) => c.id));
      },
      del: () => {
        const ids = new Set(picked);
        commitShapes(shapesRef.current.filter((s) => !ids.has(s.id) || s.locked), "once", "Delete");
        setPickedState([]);
      },
      nudge: (dx, dy) => editPicked((s) => moveBy(s, dx * scale, dy * scale), "Nudge"),
      tool: (x) => chooseTool(x as DrawTool),
      clear,
      ink: () => setHidden((h) => !h),
      mouse: () => setMouse((m) => !m),
      board: (b) => setPrefs({ board: toggleBoard(prefsRef.current.board, b) }),
      width: (dir) => chooseWidth(stepWidth(prefsRef.current.style.width, dir)),
      colour: (n) => PALETTE[n] && chooseColour(PALETTE[n]),
      snip: () => void snip(),
      picked: () => picked.length > 0,
      escape: () => {
        if (menu) setMenu(null);
        else if (picked.length) setPickedState([]);
        else close();
      },
    }),
  );
  // Registered too, so F1 / ? and the command list show (and run) them.
  useShortcuts("draw", drawList, !!info);
  useShortcuts(APP_SCOPE, [
    { ...ak("cheat-sheet"), run: () => toggleSheet("keys") },
    { ...ak("commands"), run: () => toggleSheet("commands") },
  ]);
  // Capture phase, so the drawing's keys win over the page's.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editingRef.current || sheet) return; // typing in a text, or the key list is open
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
      const hit = matchKey("draw", drawList, e);
      if (!hit) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      hit.run();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  // ------------------------------------------------------------ eraser
  // Drag over drawings to remove them: one undo step per drag.
  const erasing = useRef<{ last: Pt } | null>(null);
  const eraseAt = (from: Pt, to: Pt) => {
    const tol = 8 * scale;
    const pts = along(from, to, tol / 2);
    const gone = new Set(shapesRef.current.filter((s) => !s.locked && pts.some((p) => hit(s, p, tol))).map((s) => s.id));
    if (gone.size) commitShapes(shapesRef.current.filter((s) => !gone.has(s.id)), "live", "Erase");
  };
  const onEraseDown = (e: React.PointerEvent) => {
    if (tool !== "eraser" || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const p: Pt = [e.clientX * scale, e.clientY * scale];
    erasing.current = { last: p };
    eraseAt(p, p);
  };
  const onEraseMove = (e: React.PointerEvent) => {
    const d = erasing.current;
    if (!d) return;
    const p: Pt = [e.clientX * scale, e.clientY * scale];
    eraseAt(d.last, p);
    d.last = p;
  };
  const onEraseUp = () => {
    if (!erasing.current) return;
    erasing.current = null;
    if (gesture.current) commitShapes(shapesRef.current, "end", "Erase");
  };

  // Ctrl + wheel: pen width (ZoomIt), anywhere on the window.
  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey || mouse) return;
    chooseWidth(stepWidth(prefsRef.current.style.width, e.deltaY < 0 ? 1 : -1));
  };

  // ------------------------------------------------------------ the bar
  const dragBar = useRef<{ dx: number; dy: number } | null>(null);
  const onGripDown = (e: React.PointerEvent) => {
    const r = barRef.current?.getBoundingClientRect();
    if (!r || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragBar.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
  };
  const onGripMove = (e: React.PointerEvent) => {
    const d = dragBar.current;
    const r = barRef.current?.getBoundingClientRect();
    if (!d || !r) return;
    setBarPos(clampBar(e.clientX - d.dx, e.clientY - d.dy, r.width, r.height, view.w, view.h));
  };
  const onGripUp = () => {
    dragBar.current = null;
  };
  const barStyle: React.CSSProperties = barPos
    ? { left: barPos.x, top: barPos.y, maxWidth: view.w - 8 }
    : { left: work.x + work.w / 2, top: work.y + 12, transform: "translateX(-50%)", maxWidth: work.w - 16 };

  const keyOf = (label: string) => keyOfLabel("draw", DRAW_KEYS, label);
  const tip = (text: string, label: string) => {
    const k = keyOf(label);
    return k ? `${text} (${k})` : text;
  };
  const penCursor = useMemo(() => {
    if (tool === "eraser") {
      const ring = "<svg xmlns='http://www.w3.org/2000/svg' width='20' height='20'><circle cx='10' cy='10' r='8' fill='white' fill-opacity='0.25' stroke='black' stroke-opacity='0.7'/><circle cx='10' cy='10' r='7' fill='none' stroke='white'/></svg>";
      return `url("data:image/svg+xml,${encodeURIComponent(ring)}") 10 10, cell`;
    }
    if (tool !== "pen" && tool !== "highlight") return null;
    const w = tool === "highlight" ? Math.max(style.width * 3, 14) : style.width;
    const r = Math.max(2, Math.min(30, w / scale / 2));
    const size = Math.ceil(r * 2 + 4);
    const c = size / 2;
    const dot = `<svg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}'><circle cx='${c}' cy='${c}' r='${r}' fill='${style.color}' fill-opacity='${tool === "highlight" ? 0.45 : 1}' stroke='white' stroke-opacity='0.8'/></svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(dot)}") ${Math.round(c)} ${Math.round(c)}, crosshair`;
  }, [tool, style.width, style.color, scale]);

  const btn = "inline-flex h-8 min-w-8 items-center justify-center rounded-lg px-1.5 text-white/80 hover:bg-white/10 disabled:opacity-35";
  // Menus open towards the middle of the window (up when the bar is low).
  const low = (barRef.current?.getBoundingClientRect().top ?? 0) > view.h / 2;
  const pop = low ? "bottom-full mb-1" : "top-full mt-1";
  const toolLabel = (id: DrawTool) => (id === "eraser" ? "Eraser: drag over drawings" : (TOOLS.find((x) => x.id === id)?.label ?? id));
  const toolIcon = (id: DrawTool) => (id === "eraser" ? ICON.eraser : (TOOLS.find((x) => x.id === id)?.icon ?? ICON.shapes));
  const toolButton = (id: DrawTool) => {
    const label = toolLabel(id);
    const on = tool === id && !mouse;
    return (
      <button
        key={id}
        type="button"
        title={tip(label, DRAW_TOOL_KEYS.find((x) => x.tool === id)?.label ?? "") || label}
        aria-label={label}
        aria-pressed={on}
        data-testid={`draw-tool-${id}`}
        onClick={() => chooseTool(id)}
        className={cn(btn, on && "bg-[#5d72db] text-white hover:bg-[#5d72db]")}
      >
        {svg(toolIcon(id))}
      </button>
    );
  };
  const sep = <div className="mx-0.5 h-6 w-px shrink-0 bg-white/15" />;
  const layerView = useMemo(() => ({ scale: 1 / scale, ox: 0, oy: 0 }), [scale]);

  return (
    <div
      className="fixed inset-0 overflow-hidden select-none"
      style={{ background: boardCss(board) }}
      data-testid="draw-root"
      data-count={shapes.length}
      data-mouse={mouse ? "1" : "0"}
      onWheel={onWheel}
      onContextMenu={(e) => e.preventDefault()}
    >
      {penCursor && <style>{`[data-draw-layer] > div { cursor: ${penCursor} !important; }`}</style>}
      <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" data-testid="draw-canvas" />
      {info && (
        <div
          data-draw-layer=""
          className="absolute inset-0"
          style={{ pointerEvents: mouse ? "none" : "auto" }}
          onPointerDownCapture={(e) => {
            // A click that closes a menu only closes it.
            if (menu) {
              setMenu(null);
              e.stopPropagation();
              e.preventDefault();
              return;
            }
            onEraseDown(e);
          }}
          onPointerMove={onEraseMove}
          onPointerUp={onEraseUp}
          onPointerCancel={onEraseUp}
        >
          <AnnotationLayer
            className="absolute inset-0"
            shapes={shapes}
            content={{ w: info.width, h: info.height }}
            view={layerView}
            tool={tool === "eraser" ? "select" : tool}
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
              setHidden(false);
              setLast(null);
              commitShapes([...shapesRef.current, x], "once", "Add");
            }}
            onDelete={(ids) => {
              const set = new Set(ids);
              commitShapes(shapesRef.current.filter((x) => !set.has(x.id)), "once", "Delete");
              setPickedState([]);
            }}
            editing={editing}
            setEditing={setEditing}
            nextStep={shapes.filter((x) => x.kind === "step").reduce((m, x) => Math.max(m, x.n ?? 0), 0) + 1}
          />
        </div>
      )}

      <div
        ref={barRef}
        className={cn(
          // w-max: an absolute box near the right edge would otherwise wrap early.
          "absolute z-20 flex w-max flex-wrap items-center gap-0.5 rounded-xl border border-white/10 bg-[#1c1e25]/95 p-1 text-[12px] text-white shadow-2xl",
          snipping && "invisible",
        )}
        style={barStyle}
        data-testid="draw-bar"
        onPointerDown={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
      >
        <div
          className="grid h-8 w-5 shrink-0 cursor-grab place-items-center text-white/40 active:cursor-grabbing"
          title="Drag to move the bar"
          onPointerDown={onGripDown}
          onPointerMove={onGripMove}
          onPointerUp={onGripUp}
          onPointerCancel={onGripUp}
          onDoubleClick={() => setBarPos(null)}
        >
          {svg(ICON.grip, "h-4 w-4 stroke-[2.5]")}
        </div>
        {MAIN_TOOLS.map((id) => toolButton(id))}
        <div className="relative">
          <button
            type="button"
            title={`More tools: ${MORE_TOOLS.map((id) => toolLabel(id)).join(", ")}`}
            aria-pressed={MORE_TOOLS.includes(tool) && !mouse}
            data-testid="draw-tools-more"
            onClick={() => setMenu((m) => (m === "tools" ? null : "tools"))}
            className={cn(btn, "gap-0.5", MORE_TOOLS.includes(tool) && !mouse && "bg-[#5d72db] text-white hover:bg-[#5d72db]", menu === "tools" && "bg-white/15")}
          >
            {svg(MORE_TOOLS.includes(tool) ? toolIcon(tool) : ICON.shapes)}
            <span className="text-[9px] text-white/60">▾</span>
          </button>
          {menu === "tools" && (
            <div className={cn("absolute left-0 z-30 flex items-center gap-0.5 rounded-lg border border-white/10 bg-[#1c1e25] p-1 shadow-2xl", pop)} data-testid="draw-tools-menu">
              {MORE_TOOLS.map((id) => toolButton(id))}
            </div>
          )}
        </div>
        {sep}
        <div className="relative">
          <button
            type="button"
            title={`Colour ${style.color}: the palette or any colour (${keyOf("Colour 1 (red)") || "1"}–${keyOf(`Colour ${PALETTE.length} (black)`) || PALETTE.length})`}
            data-testid="draw-colour"
            onClick={() => setMenu((m) => (m === "colour" ? null : "colour"))}
            className={cn(btn, "gap-0.5", menu === "colour" && "bg-white/15")}
          >
            <span className="h-5 w-5 rounded-full border-2 border-white/70" style={{ background: style.color }} />
            <span className="text-[9px] text-white/60">▾</span>
          </button>
          {menu === "colour" && (
            <div className={cn("absolute left-0 z-30 flex items-center gap-1 rounded-lg border border-white/10 bg-[#1c1e25] p-1.5 shadow-2xl", pop)} data-testid="draw-colours">
              {PALETTE.map((c, i) => (
                <button
                  key={c}
                  type="button"
                  title={tip(`Colour ${c}`, `Colour ${i + 1} (${["red", "yellow", "green", "blue", "purple", "white", "black"][i]})`)}
                  onClick={() => {
                    chooseColour(c);
                    setMenu(null);
                  }}
                  className={cn("mx-px h-6 w-6 shrink-0 rounded-full border-2", style.color.toLowerCase() === c ? "border-white" : "border-white/20")}
                  style={{ background: c }}
                />
              ))}
              <label className="relative mx-px h-6 w-6 shrink-0 cursor-pointer overflow-hidden rounded-full border-2 border-dashed border-white/30" title="Any colour">
                <input
                  type="color"
                  value={/^#[0-9a-f]{6}$/i.test(style.color) ? style.color : "#ffffff"}
                  onChange={(e) => chooseColour(e.target.value)}
                  className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                />
                <span className="pointer-events-none grid h-full place-items-center text-[10px] text-white/60">+</span>
              </label>
            </div>
          )}
        </div>
        <div className="relative">
          <button
            type="button"
            title={`Pen width ${style.width} px (${keyOf("Thinner") || "["} / ${keyOf("Thicker") || "]"}, Ctrl+wheel)`}
            data-testid="draw-width"
            onClick={() => setMenu((m) => (m === "width" ? null : "width"))}
            className={cn(btn, "gap-1")}
          >
            <span className="rounded-full bg-white" style={{ width: Math.min(14, 2 + style.width / 2), height: Math.min(14, 2 + style.width / 2) }} />
            <span className="tabular-nums text-[11px] text-white/60">{style.width}</span>
          </button>
          {menu === "width" && (
            <div className={cn("absolute left-0 z-30 flex items-center gap-1 rounded-lg border border-white/10 bg-[#1c1e25] p-1.5 shadow-2xl", pop)} data-testid="draw-widths">
              {PEN_WIDTHS.map((w) => (
                <button
                  key={w}
                  type="button"
                  title={`${w} px`}
                  onClick={() => chooseWidth(w)}
                  className={cn("grid h-8 w-8 place-items-center rounded-md hover:bg-white/10", style.width === w && "bg-white/15")}
                >
                  <span className="rounded-full bg-white" style={{ width: Math.min(18, 2 + w / 1.5), height: Math.min(18, 2 + w / 1.5) }} />
                </button>
              ))}
              <input
                type="number"
                min={1}
                max={200}
                title="Any width (px)"
                defaultValue={style.width}
                key={style.width}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") chooseWidth(Number((e.target as HTMLInputElement).value) || style.width);
                }}
                onBlur={(e) => chooseWidth(Number(e.target.value) || style.width)}
                className="h-7 w-14 rounded-md border border-white/15 bg-black/30 px-1.5 text-[12px] text-white outline-none"
              />
            </div>
          )}
        </div>
        {sep}
        <button
          type="button"
          className={btn}
          title={`${tip("Undo", "Undo")}${keyOf("Redo") ? ` · redo: ${keyOf("Redo")}` : ""}`}
          disabled={!hist.current.undoLabel}
          onClick={undo}
          data-testid="draw-undo"
        >
          {svg(ICON.undo)}
        </button>
        <button type="button" className={btn} title={tip("Clear the drawing", "Clear the drawing")} disabled={!shapes.length} onClick={clear} data-testid="draw-clear">
          {svg(ICON.clear)}
        </button>
        {hidden && (
          // Shown only while the drawing is hidden (I), so it can always come back with a click.
          <button type="button" className={cn(btn, "bg-white/15 text-white")} title={tip("Show the drawing", "Hide / show the drawing")} onClick={() => setHidden(false)} data-testid="draw-ink">
            {svg(ICON.eyeOff)}
          </button>
        )}
        {sep}
        <button
          type="button"
          className={cn(btn, "gap-1.5 px-2", mouse && "bg-[#2f9e6b] text-white hover:bg-[#2f9e6b]")}
          title={
            mouse
              ? "Mouse mode is on: clicks go to the apps under the drawing. Pick a tool (or click here) to draw again."
              : tip("Use the mouse: the drawing stays, clicks go to the apps under it", "Use the mouse (click-through)")
          }
          aria-pressed={mouse}
          onClick={() => setMouse((m) => !m)}
          data-testid="draw-mouse"
        >
          {svg(ICON.mouse)}
          <span className="whitespace-nowrap">{mouse ? "Mouse on" : "Mouse"}</span>
        </button>
        <button type="button" className={btn} title={tip("Snip the screen with the drawing", "Snip the screen with the drawing")} onClick={() => void snip()} data-testid="draw-snip">
          {svg(ICON.camera)}
        </button>
        {last && !shapes.length && (
          <button
            type="button"
            className="whitespace-nowrap rounded-lg px-2 py-1.5 text-[12px] text-[#9fb0ff] hover:bg-white/10"
            title="Bring back the drawing you had when you last stopped"
            onClick={restore}
            data-testid="draw-restore"
          >
            Bring back last
          </button>
        )}
        <div className="relative">
          <button
            type="button"
            className={cn(btn, menu === "more" && "bg-white/15")}
            title="More: redo, hide the drawing, whiteboard, fading ink"
            onClick={() => setMenu((m) => (m === "more" ? null : "more"))}
            data-testid="draw-more"
          >
            {svg(ICON.more, "h-4 w-4 stroke-[2.5]")}
          </button>
          {menu === "more" && (
            <div className={cn("absolute right-0 z-30 w-64 space-y-2.5 rounded-lg border border-white/10 bg-[#1c1e25] p-2.5 text-[12px] text-white/80 shadow-2xl", pop)} data-testid="draw-menu">
              <div className="grid grid-cols-2 gap-1">
                <button
                  type="button"
                  disabled={!hist.current.redoLabel}
                  onClick={redo}
                  data-testid="draw-redo"
                  className="flex items-center gap-1.5 rounded-md border border-white/10 px-2 py-1 text-left hover:bg-white/10 disabled:opacity-35"
                >
                  {svg(ICON.redo, "h-3.5 w-3.5")} Redo{keyOf("Redo") && <span className="ml-auto text-white/40">{keyOf("Redo")}</span>}
                </button>
                <button
                  type="button"
                  aria-pressed={hidden}
                  onClick={() => setHidden((h) => !h)}
                  data-testid="draw-ink-menu"
                  className={cn("flex items-center gap-1.5 rounded-md border px-2 py-1 text-left", hidden ? "border-[#5d72db] bg-[#5d72db]/20 text-white" : "border-white/10 hover:bg-white/10")}
                >
                  {svg(hidden ? ICON.eyeOff : ICON.eye, "h-3.5 w-3.5")} Hide{keyOf("Hide / show the drawing") && <span className="ml-auto text-white/40">{keyOf("Hide / show the drawing")}</span>}
                </button>
              </div>
              <div>
                <div className="mb-1 text-white/50">Behind the drawing</div>
                <div className="grid grid-cols-2 gap-1">
                  {(
                    [
                      ["none", "The screen", ""],
                      ["dim", "Dimmed screen", ""],
                      ["white", "Whiteboard", "Whiteboard"],
                      ["black", "Blackboard", "Blackboard"],
                    ] as [Board, string, string][]
                  ).map(([b, label, keyLabel]) => (
                    <button
                      key={b}
                      type="button"
                      onClick={() => setPrefs({ board: b })}
                      className={cn("rounded-md border px-2 py-1 text-left", board === b ? "border-[#5d72db] bg-[#5d72db]/20 text-white" : "border-white/10 hover:bg-white/10")}
                    >
                      {label}
                      {keyLabel && keyOf(keyLabel) && <span className="ml-1 text-white/40">{keyOf(keyLabel)}</span>}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="mb-1 text-white/50">Ink fades away after</div>
                <div className="flex flex-wrap items-center gap-1">
                  {FADE_CHOICES.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setPrefs({ fade: s })}
                      className={cn("rounded-md border px-2 py-1", fade === s ? "border-[#5d72db] bg-[#5d72db]/20 text-white" : "border-white/10 hover:bg-white/10")}
                    >
                      {s ? `${s} s` : "Never"}
                    </button>
                  ))}
                  <input
                    type="number"
                    min={0}
                    max={600}
                    step={0.5}
                    title="Any number of seconds (0 = never)"
                    defaultValue={FADE_CHOICES.includes(fade) ? "" : fade}
                    placeholder="s"
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") setPrefs({ fade: clampFade((e.target as HTMLInputElement).value) });
                    }}
                    onBlur={(e) => e.target.value !== "" && setPrefs({ fade: clampFade(e.target.value) })}
                    className="h-7 w-14 rounded-md border border-white/15 bg-black/30 px-1.5 text-white outline-none"
                  />
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setMenu(null);
                  toggleSheet("keys");
                }}
                data-testid="draw-keys"
                className="flex w-full items-center gap-1.5 rounded-md border border-white/10 px-2 py-1 text-left hover:bg-white/10"
              >
                All keys (change them in Settings › Shortcuts)<span className="ml-auto text-white/40">F1</span>
              </button>
            </div>
          )}
        </div>
        <button type="button" className={btn} title={tip("Stop drawing", "Drop the selection, or stop drawing")} onClick={close} data-testid="draw-close">
          {svg(ICON.close)}
        </button>
      </div>

      {sheet && (
        <>
          <div className="absolute inset-0 z-[89]" onPointerDown={(e) => (e.stopPropagation(), setSheet(null))} />
          {/* On the screen the bar is on (the list is "fixed" inside this box). */}
          <div className="absolute z-[90]" style={{ ...sheetBox(), transform: "translateZ(0)" }} data-testid="draw-sheet">
            <ShortcutsOverlay
              mode={sheet}
              onClose={() => setSheet(null)}
              onEdit={() => {
                void window.__TAURI__?.core.invoke("shell_open_tab", { tab: "settings", payload: { section: "shortcuts" } }).catch(() => undefined);
                close();
              }}
            />
          </div>
        </>
      )}

      {error && (
        <div className="absolute bottom-6 left-1/2 z-30 -translate-x-1/2 rounded-lg bg-[#3a1d22] px-3 py-2 text-[12px] text-white shadow-2xl">
          {error}
          <button type="button" className="ml-3 text-white/60 hover:text-white" onClick={() => setError(null)}>
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
