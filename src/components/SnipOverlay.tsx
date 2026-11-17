import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { lastshot, isTauri, showCurrentWindow } from "../lib/bridge";
import type { SnipCapture, SnipWindowRect } from "../lib/types";
import { cn } from "../utils/cn";
import { monitorAt, monitorsOf } from "./snipGeo";
import Viewer from "../viewer/Viewer";
import { Btn, Icon } from "../viewer/ui";
import { popOutCanvas } from "../popout/frames";
import { sameView, viewForRect, type View } from "../viewer/math";
import AnnotationLayer, { type LayerView } from "../annotate/AnnotationLayer";
import { drawShape } from "../annotate/draw";
import StyleControls, { TOOLS } from "../annotate/StyleControls";
import { type Shape, type Style, type Tool, DEFAULT_STYLE, PALETTE, align, flip, moveBy, reorder, rotateBy, shapeId } from "../annotate/shapes";
import { History } from "../timeline/history";
import { postToEditor } from "../editor/inbox";
import { SNIP_TOOL_KEYS, snipKeymap } from "../editor/keys";
import { SNIP_KEYS, keyOfLabel, matchKey, toRegistry } from "../editor/keyTables";
import { setShortcutOverrides } from "../lib/shortcuts";

/**
 * Full-screen snipping overlay. It runs in its own borderless window that
 * covers the snipped screens (by default every monitor at once) and shows a
 * frozen picture of them. The bar at the top of the screen the mouse was on
 * switches between Screenshot and Record.
 *
 * 1. Pick: drag a box (it may cross screens), click a window, click the
 *    desktop or press F for the screen under the mouse, Shift+F for all.
 * 2. Screenshot: mark up with the shared annotation objects (text, boxes,
 *    arrows, pen, highlighter, steps, blur, pixelate, black box). Every
 *    object can be selected, moved, sized, turned and restyled; Ctrl+Z /
 *    Ctrl+Y. Enter / Ctrl+C copies, Ctrl+S saves (and copies).
 *    Record: Enter / Start recording records that area until stopped.
 * Esc cancels.
 *
 * All coordinates below are in the captured image's physical pixels; the page
 * scales them to CSS pixels only for display.
 */

type Mode = "shot" | "rec";
type Rect = { x: number; y: number; w: number; h: number };

const STYLE_KEY = "lastshot.snip.style";
function loadStyle(): Style {
  try {
    const v = localStorage.getItem(STYLE_KEY);
    return v ? { ...DEFAULT_STYLE, ...(JSON.parse(v) as Partial<Style>) } : DEFAULT_STYLE;
  } catch {
    return DEFAULT_STYLE;
  }
}

/** Snip keys for the drawing tools, as the user set them (B stays blur here; Shift+B pixelates). */
function keyOf(t: Tool): string | undefined {
  const label = SNIP_TOOL_KEYS.find((x) => x.tool === t)?.label;
  return (label && keyOfLabel("snip", SNIP_KEYS, label)) || undefined;
}

function normalize(x1: number, y1: number, x2: number, y2: number): Rect {
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

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
  const [drag, setDrag] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  // Editing phase.
  const [sel, setSel] = useState<Rect | null>(null);
  const [tool, setTool] = useState<Tool>("rect");
  const [style, setStyleState] = useState<Style>(loadStyle);
  const [shapes, setShapesState] = useState<Shape[]>([]);
  const shapesRef = useRef<Shape[]>([]);
  shapesRef.current = shapes;
  const [picked, setPicked] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [showStyle, setShowStyle] = useState(() => {
    try {
      return localStorage.getItem("lastshot.snip.styleOpen") === "1";
    } catch {
      return false;
    }
  });
  const [space, setSpace] = useState(false);
  const [vv, setVv] = useState<View | null>(null);
  const hist = useRef(new History<Shape[]>());
  const gesture = useRef<Shape[] | null>(null);
  const [, setHv] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("shot");

  // The marked-up selection at full resolution. The viewer shows it (zoom,
  // pan, turn, inspect); at rest it sits exactly over the frozen screen.
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  if (!canvasRef.current && typeof document !== "undefined") canvasRef.current = document.createElement("canvas");
  const [canvasVersion, setCanvasVersion] = useState(0);
  const [zoomed, setZoomed] = useState(false);
  const shown = useRef(false);

  // Physical pixels per CSS pixel.
  const scale = capture ? capture.width / view.w : window.devicePixelRatio || 1;
  // The monitors in the picture (one when the snip covers one screen), the
  // one the mouse was on, and where the mouse is now (picture px).
  const mons = useMemo(() => monitorsOf(capture), [capture]);
  const home = Math.max(0, Math.min(mons.length - 1, capture?.home ?? 0));
  const pointer = useRef<[number, number] | null>(null);

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

  // Show the window only once the frozen picture is on screen, so the user
  // never sees a black or half-drawn overlay.
  useEffect(() => {
    if (!img || shown.current) return;
    shown.current = true;
    requestAnimationFrame(() => requestAnimationFrame(() => void showCurrentWindow()));
  }, [img]);
  useEffect(() => {
    if (error) void showCurrentWindow();
  }, [error]);

  const cancel = useCallback(() => {
    if (isTauri()) void lastshot.snipCancel();
    else window.close();
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
  }, []);

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

  // ------------------------------------------------------------ finish
  /** Pins the snip (with its markup) where it was taken, as a pop-out frame. */
  const popOut = useCallback(async () => {
    const c = canvasRef.current;
    if (!c || !sel || busy || !isTauri()) return;
    setBusy("Popping out…");
    try {
      type Pos = { x: number; y: number };
      const w = window.__TAURI__?.window?.getCurrentWindow() as unknown as { outerPosition?: () => Promise<Pos> } | undefined;
      const origin = (await w?.outerPosition?.().catch(() => null)) ?? { x: 0, y: 0 };
      await popOutCanvas(c, "Snip", undefined, { x: origin.x + sel.x, y: origin.y + sel.y });
      await lastshot.snipCancel();
    } catch (e) {
      setError(String(e));
      setBusy(null);
    }
  }, [sel, busy]);

  /** Host buttons at the end of the viewer's bar. */
  const snipExtra: React.ReactNode = isTauri() ? (
    <Btn title="Pop out: pin this snip on top of other apps, see-through (Ctrl+P)" wide onClick={() => void popOut()}>
      <span className="flex items-center gap-1">
        <Icon d="M2 5h8v8H2zM6 2h8v8" />
        Pop out
      </span>
    </Btn>
  ) : null;

  const finish = useCallback(
    /** `toEditor`: saved, then opened in the main window's editor. */
    async (save: boolean, toEditor = false) => {
      const c = canvasRef.current;
      if (!c || !sel || busy) return;
      setBusy(save ? "Saving…" : "Copying…");
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
    [sel, busy],
  );

  const startRecording = useCallback(async () => {
    if (!sel || busy) return;
    setBusy("Starting…");
    try {
      if (isTauri()) await lastshot.snipRecord(sel);
      else window.close();
    } catch (e) {
      setError(String(e));
      setBusy(null);
    }
  }, [sel, busy]);

  // ------------------------------------------------------------ keyboard
  // Capture phase: the snip's keys win over the viewer's; keys the snip
  // does not use (0 fit, 1 actual size, ...) still reach the viewer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editing) return; // typing in a text
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
      const done = () => {
        e.preventDefault();
        e.stopImmediatePropagation();
      };
      if (e.key === "Escape") {
        done();
        if (sel && mode === "shot" && (picked.length || tool !== "select")) {
          setPicked([]);
          setTool("select");
          return;
        }
        cancel();
        return;
      }
      if (!sel) {
        if ((e.key === "f" || e.key === "F") && !e.ctrlKey && !e.altKey) {
          if (e.shiftKey) selectAll();
          else selectScreen();
        }
        if (e.key === "Enter" && hover) select(hover);
        return;
      }
      if (mode === "rec") {
        if (e.key === "Enter") {
          done();
          void startRecording();
        }
        return;
      }
      if (e.code === "Space") {
        setSpace(true);
        return;
      }
      const one = () => picked.length > 0;
      const list = snipKeymap({
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
        picked: one,
      });
      const hit = matchKey("snip", toRegistry(list), e);
      if (!hit) return;
      done();
      hit.run();
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpace(false);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onUp, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onUp, true);
    };
  }, [sel, hover, mode, cancel, finish, popOut, startRecording, select, selectAll, selectScreen, editing, picked, tool, undo, redo, commitShapes, editPicked, duplicatePicked, scale]);

  // ------------------------------------------------------------ picking pointer
  const onPickDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    const [x, y] = toImage(e);
    setDrag({ x1: x, y1: y, x2: x, y2: y });
  };
  const onPickMove = (e: React.PointerEvent) => {
    const [x, y] = toImage(e);
    pointer.current = [x, y];
    if (drag) setDrag({ ...drag, x2: x, y2: y });
    else setHover(windowAt(x, y));
  };
  const onPickUp = (e: React.PointerEvent) => {
    if (!drag) return;
    const [x, y] = toImage(e);
    const r = normalize(drag.x1, drag.y1, x, y);
    if (r.w < 6 * scale && r.h < 6 * scale) {
      // A click: take the window under the cursor, or that screen.
      const w = windowAt(x, y);
      if (w) select(w);
      else selectScreen([x, y]);
    } else {
      select(r);
    }
  };

  // ------------------------------------------------------------ layout
  const css = (r: Rect) => ({ left: r.x / scale, top: r.y / scale, width: r.w / scale, height: r.h / scale });
  const cssRect = (r: Rect) => ({ x: r.x / scale, y: r.y / scale, w: r.w / scale, h: r.h / scale });
  const live: Rect | null = sel
    ? sel
    : drag
      ? normalize(drag.x1, drag.y1, drag.x2, drag.y2)
      : hover;
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
    const top = below + barH < B.y + B.h ? below : r.top - barH - 10 > B.y ? r.top - barH - 10 : Math.min(r.top + r.height, B.y + B.h) - barH - 10;
    const left = Math.max(B.x + 8, Math.min(r.left, B.x + B.w - 960));
    return { top, left, maxWidth: B.w - 16 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, scale, work]);

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

  return (
    <div className="fixed inset-0 select-none overflow-hidden bg-black" style={{ cursor: sel ? "default" : "crosshair" }}>
      <img src={capture.image} alt="" draggable={false} className="pointer-events-none absolute inset-0 h-full w-full" />

      {/* Dim everything except the live rectangle. */}
      {zoomed && sel ? null : liveCss ? (
        <div
          className="pointer-events-none absolute rounded-[1px]"
          style={{
            ...liveCss,
            boxShadow: "0 0 0 99999px rgba(5,6,10,0.55)",
            outline: sel ? "1px solid rgba(255,255,255,0.9)" : "2px solid #6b80e4",
          }}
        />
      ) : (
        <div className="pointer-events-none absolute inset-0 bg-[rgba(5,6,10,0.55)]" />
      )}

      {!sel && (
        <>
          <div
            className="absolute inset-0"
            onPointerDown={onPickDown}
            onPointerMove={onPickMove}
            onPointerUp={onPickUp}
            onContextMenu={(e) => {
              e.preventDefault();
              cancel();
            }}
          />
          {drag && liveCss && live && (
            <div
              className="pointer-events-none absolute rounded bg-black/75 px-1.5 py-0.5 font-mono text-[11px] text-white"
              style={{ left: liveCss.left, top: Math.max(0, liveCss.top - 22) }}
            >
              {live.w} × {live.h}
            </div>
          )}
        </>
      )}

      {!drag && (
        <div
          className="absolute z-20 flex -translate-x-1/2 items-center gap-1 rounded-xl border border-white/10 bg-[#1c1e25]/95 p-1.5 text-[12px] text-white shadow-2xl"
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
                onClick={() => setMode(id)}
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
          <div className="mx-1 h-6 w-px bg-white/15" />
          <span className="whitespace-nowrap px-1 text-white/75">
            {sel
              ? mode === "rec"
                ? "Click outside to pick again"
                : "Draw on it, or click outside to pick again"
              : hover
                ? `Click: ${mode === "rec" ? "record" : "snip"} “${hover.title.slice(0, 32)}”`
                : `Drag a box or click a window to ${mode === "rec" ? "record" : "snip"}`}
          </span>
          <button
            type="button"
            title={mons.length > 1 ? "This whole screen (F)" : "The whole screen (F)"}
            disabled={!!busy}
            onClick={() => selectScreen(null)}
            className="whitespace-nowrap rounded-lg px-2 py-1.5 text-white/85 hover:bg-white/10"
            data-testid="snip-screen"
          >
            Full screen <span className="text-white/45">F</span>
          </button>
          {mons.length > 1 && (
            <button
              type="button"
              title="Every screen at once (Shift+F)"
              disabled={!!busy}
              onClick={selectAll}
              className="whitespace-nowrap rounded-lg px-2 py-1.5 text-white/85 hover:bg-white/10"
              data-testid="snip-all"
            >
              All screens <span className="text-white/45">⇧F</span>
            </button>
          )}
          <button
            type="button"
            title="Cancel (Esc)"
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
              Space+drag or the middle button pans, C picks colours, D
              measures, H mirrors. Markup keeps working at any zoom. */}
          <Viewer
            className="absolute inset-0"
            source={canvasRef.current}
            version={canvasVersion}
            name="Lastshot snip"
            background="none"
            leftDragPans={false}
            bar="show"
            barPlace="bottom"
            // The picture lies exactly over the screen here, so the bar floats.
            barLayout="overlay"
            barBox={work}
            exportKeys={false}
            homeView={(c) => viewForRect(c, cssRect(sel))}
            onViewChange={(v, _st, c) => {
              setVv(v);
              setZoomed(!sameView(v, viewForRect(c, cssRect(sel))));
            }}
            onDoubleClick={() => void finish(false)}
            extra={snipExtra}
          />
          {mode === "shot" && layerView && (
            <div
              className="absolute inset-0 bottom-12"
              style={{ pointerEvents: space ? "none" : "auto" }}
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
                title="Cancel (Esc)"
                onClick={cancel}
                className="rounded-lg px-2 py-1.5 text-[12px] text-white/80 hover:bg-white/10"
              >
                Cancel
              </button>
              <button
                type="button"
                title="Start recording (Enter). Stop it from the control bar, the Home page or the record shortcut."
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
          >
            {TOOLS.map((t) => (
              <button
                key={t.id}
                type="button"
                title={`${t.label}${keyOf(t.id) ? ` (${keyOf(t.id)})` : ""}`}
                onClick={() => setTool(t.id)}
                className={cn(
                  "grid h-8 w-8 place-items-center rounded-lg transition-colors",
                  tool === t.id ? "bg-[#5d72db] text-white" : "text-white/75 hover:bg-white/10",
                )}
              >
                <svg viewBox="0 0 16 16" className="h-4 w-4 fill-none stroke-current" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d={t.icon} />
                </svg>
              </button>
            ))}
            <div className="mx-1 h-6 w-px bg-white/15" />
            {PALETTE.slice(0, 6).map((c) => (
              <button
                key={c}
                type="button"
                title="Colour (also changes the selected objects)"
                onClick={() => {
                  setStyle({ color: c });
                  editPicked((x) => ({ ...x, color: c }), "Colour");
                }}
                className={cn(
                  "h-5 w-5 rounded-full border-2 transition-transform",
                  style.color === c ? "scale-110 border-white" : "border-white/20 hover:scale-105",
                )}
                style={{ background: c }}
              />
            ))}
            <button
              type="button"
              title="More: width, fill, text size, outline, opacity, turn, flip, order, lock"
              onClick={() => {
                setShowStyle(!showStyle);
                try {
                  localStorage.setItem("lastshot.snip.styleOpen", showStyle ? "0" : "1");
                } catch {
                  /* private mode */
                }
              }}
              className={cn("rounded-lg px-2 py-1.5 text-[12px]", showStyle ? "bg-white/15 text-white" : "text-white/80 hover:bg-white/10")}
            >
              Style ▾
            </button>
            <div className="mx-1 h-6 w-px bg-white/15" />
            <button
              type="button"
              title="Undo (Ctrl+Z)"
              disabled={!hist.current.undoLabel}
              onClick={undo}
              className="rounded-lg px-2 py-1.5 text-[12px] text-white/80 hover:bg-white/10 disabled:opacity-30"
            >
              Undo
            </button>
            <button
              type="button"
              title="Redo (Ctrl+Y)"
              disabled={!hist.current.redoLabel}
              onClick={redo}
              className="rounded-lg px-2 py-1.5 text-[12px] text-white/80 hover:bg-white/10 disabled:opacity-30"
            >
              Redo
            </button>
            <button
              type="button"
              title="Cancel (Esc)"
              onClick={cancel}
              className="rounded-lg px-2 py-1.5 text-[12px] text-white/80 hover:bg-white/10"
            >
              Cancel
            </button>
            <button
              type="button"
              title="Save to the Screenshots folder and copy (Ctrl+S)"
              disabled={!!busy}
              onClick={() => void finish(true)}
              className="rounded-lg border border-white/15 px-2.5 py-1.5 text-[12px] font-medium hover:bg-white/10 disabled:opacity-50"
            >
              Save
            </button>
            <button
              type="button"
              title="Save and open in the Lastshot editor (Ctrl+E)"
              disabled={!!busy}
              onClick={() => void finish(true, true)}
              className="rounded-lg border border-white/15 px-2.5 py-1.5 text-[12px] font-medium hover:bg-white/10 disabled:opacity-50"
            >
              Editor
            </button>
            <button
              type="button"
              title="Copy to the clipboard (Enter)"
              disabled={!!busy}
              onClick={() => void finish(false)}
              className="rounded-lg bg-[#5d72db] px-3 py-1.5 text-[12px] font-semibold hover:bg-[#6b80e4] disabled:opacity-60"
            >
              {busy ?? "Copy"}
            </button>
          </div>
          )}
          {mode === "shot" && showStyle && (
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
    </div>
  );
}
