import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { lastshot, isTauri, showCurrentWindow } from "../lib/bridge";
import type { SnipCapture, SnipWindowRect } from "../lib/types";
import { cn } from "../utils/cn";

/**
 * Full-screen snipping overlay. It runs in its own borderless window that
 * covers one monitor and shows a frozen picture of it.
 *
 * 1. Pick: drag a box, click a window, or press F for the whole screen.
 * 2. Mark up (optional): box, arrow, pen, blur. Ctrl+Z undoes.
 * 3. Enter / Ctrl+C copies, Ctrl+S saves (and copies), Esc cancels.
 *
 * All coordinates below are in the captured image's physical pixels; the page
 * scales them to CSS pixels only for display.
 */

type Tool = "box" | "arrow" | "pen" | "blur";
type Rect = { x: number; y: number; w: number; h: number };
type Shape =
  | { kind: "box" | "arrow" | "blur"; x1: number; y1: number; x2: number; y2: number; color: string; width: number }
  | { kind: "pen"; points: [number, number][]; color: string; width: number };

const COLORS = ["#ff4d4f", "#ffc53d", "#52c41a", "#4096ff", "#ffffff", "#111111"];
const TOOLS: { id: Tool; label: string; key: string; icon: string }[] = [
  { id: "box", label: "Box", key: "R", icon: "M3 4h10v8H3z" },
  { id: "arrow", label: "Arrow", key: "A", icon: "M3 13L13 3M7 3h6v6" },
  { id: "pen", label: "Pen", key: "P", icon: "M3 13c2-1 3-5 5-6s3 2 5 0" },
  { id: "blur", label: "Blur", key: "B", icon: "M3 3h3v3H3zM8 3h3v3H8zM5.5 7.5h3v3h-3zM3 10h3v3H3zM10 10h3v3h-3z" },
];

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

function drawArrow(g: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, width: number) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const head = Math.max(10, width * 4);
  g.beginPath();
  g.moveTo(x1, y1);
  g.lineTo(x2 - Math.cos(angle) * head * 0.6, y2 - Math.sin(angle) * head * 0.6);
  g.stroke();
  g.beginPath();
  g.moveTo(x2, y2);
  g.lineTo(x2 - head * Math.cos(angle - Math.PI / 7), y2 - head * Math.sin(angle - Math.PI / 7));
  g.lineTo(x2 - head * Math.cos(angle + Math.PI / 7), y2 - head * Math.sin(angle + Math.PI / 7));
  g.closePath();
  g.fill();
}

/** Draws the selected part of the screen plus all markup at full resolution. */
function render(
  g: CanvasRenderingContext2D,
  img: HTMLImageElement,
  sel: Rect,
  shapes: Shape[],
  blockPx: number,
) {
  g.imageSmoothingEnabled = true;
  g.clearRect(0, 0, sel.w, sel.h);
  g.drawImage(img, sel.x, sel.y, sel.w, sel.h, 0, 0, sel.w, sel.h);
  for (const s of shapes) {
    g.lineCap = "round";
    g.lineJoin = "round";
    g.strokeStyle = s.color;
    g.fillStyle = s.color;
    g.lineWidth = s.width;
    if (s.kind === "pen") {
      if (s.points.length < 2) continue;
      g.beginPath();
      g.moveTo(s.points[0][0], s.points[0][1]);
      for (const [x, y] of s.points.slice(1)) g.lineTo(x, y);
      g.stroke();
    } else if (s.kind === "box") {
      const r = normalize(s.x1, s.y1, s.x2, s.y2);
      g.strokeRect(r.x, r.y, r.w, r.h);
    } else if (s.kind === "arrow") {
      drawArrow(g, s.x1, s.y1, s.x2, s.y2, s.width);
    } else {
      // Pixelate from the original picture, so it cannot be undone by
      // un-blurring and markup underneath does not leak through.
      const r = normalize(s.x1, s.y1, s.x2, s.y2);
      if (r.w < 2 || r.h < 2) continue;
      const tw = Math.max(1, Math.ceil(r.w / blockPx));
      const th = Math.max(1, Math.ceil(r.h / blockPx));
      const tmp = document.createElement("canvas");
      tmp.width = tw;
      tmp.height = th;
      const tg = tmp.getContext("2d")!;
      tg.drawImage(img, sel.x + r.x, sel.y + r.y, r.w, r.h, 0, 0, tw, th);
      g.imageSmoothingEnabled = false;
      g.drawImage(tmp, 0, 0, tw, th, r.x, r.y, r.w, r.h);
      g.imageSmoothingEnabled = true;
    }
  }
}

export default function SnipOverlay() {
  const [capture, setCapture] = useState<SnipCapture | null>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState({ w: window.innerWidth, h: window.innerHeight });
  // Picking phase.
  const [hover, setHover] = useState<SnipWindowRect | null>(null);
  const [drag, setDrag] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  // Editing phase.
  const [sel, setSel] = useState<Rect | null>(null);
  const [tool, setTool] = useState<Tool>("box");
  const [color, setColor] = useState(COLORS[0]);
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [draft, setDraft] = useState<Shape | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const shown = useRef(false);

  // Physical pixels per CSS pixel.
  const scale = capture ? capture.width / view.w : window.devicePixelRatio || 1;
  const strokeWidth = Math.max(2, Math.round(3 * scale));
  const blockPx = Math.max(6, Math.round(10 * scale));

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
    render(c.getContext("2d")!, img, sel, draft ? [...shapes, draft] : shapes, blockPx);
  }, [img, sel, shapes, draft, blockPx]);

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
    setShapes([]);
    setDraft(null);
    setDrag(null);
    setHover(null);
  }, []);

  const selectAll = useCallback(() => {
    if (capture) select({ x: 0, y: 0, w: capture.width, h: capture.height });
  }, [capture, select]);

  // ------------------------------------------------------------ finish
  const finish = useCallback(
    async (save: boolean) => {
      const c = canvasRef.current;
      if (!c || !sel || busy) return;
      setBusy(save ? "Saving…" : "Copying…");
      try {
        const png = c.toDataURL("image/png");
        if (isTauri()) {
          const s = await lastshot.getSettings().catch(() => null);
          const jpg =
            s?.screenshotFormat === "jpg" ? c.toDataURL("image/jpeg", (s.screenshotQuality ?? 90) / 100) : undefined;
          await lastshot.snipFinish(png, true, save, jpg);
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

  // ------------------------------------------------------------ keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
        return;
      }
      if (!sel) {
        if (e.key === "f" || e.key === "F") selectAll();
        if (e.key === "Enter" && hover) select(hover);
        return;
      }
      const k = e.key.toLowerCase();
      if (e.ctrlKey && k === "z") {
        e.preventDefault();
        setShapes((s) => s.slice(0, -1));
      } else if ((e.ctrlKey && k === "c") || e.key === "Enter") {
        e.preventDefault();
        void finish(false);
      } else if (e.ctrlKey && k === "s") {
        e.preventDefault();
        void finish(true);
      } else if (!e.ctrlKey && !e.altKey) {
        const t = TOOLS.find((t) => t.key.toLowerCase() === k);
        if (t) setTool(t.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sel, hover, cancel, finish, select, selectAll]);

  // ------------------------------------------------------------ picking pointer
  const onPickDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    const [x, y] = toImage(e);
    setDrag({ x1: x, y1: y, x2: x, y2: y });
  };
  const onPickMove = (e: React.PointerEvent) => {
    const [x, y] = toImage(e);
    if (drag) setDrag({ ...drag, x2: x, y2: y });
    else setHover(windowAt(x, y));
  };
  const onPickUp = (e: React.PointerEvent) => {
    if (!drag) return;
    const [x, y] = toImage(e);
    const r = normalize(drag.x1, drag.y1, x, y);
    if (r.w < 6 * scale && r.h < 6 * scale) {
      // A click: take the window under the cursor, or the whole screen.
      const w = windowAt(x, y);
      if (w) select(w);
      else selectAll();
    } else {
      select(r);
    }
  };

  // ------------------------------------------------------------ markup pointer
  const toSel = (e: React.PointerEvent): [number, number] => {
    const [x, y] = toImage(e);
    return [x - (sel?.x ?? 0), y - (sel?.y ?? 0)];
  };
  const onEditDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || busy) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    const [x, y] = toSel(e);
    if (tool === "pen") setDraft({ kind: "pen", points: [[x, y]], color, width: strokeWidth });
    else setDraft({ kind: tool, x1: x, y1: y, x2: x, y2: y, color, width: strokeWidth });
  };
  const onEditMove = (e: React.PointerEvent) => {
    if (!draft) return;
    const [x, y] = toSel(e);
    if (draft.kind === "pen") setDraft({ ...draft, points: [...draft.points, [x, y]] });
    else setDraft({ ...draft, x2: x, y2: y });
  };
  const onEditUp = () => {
    if (!draft) return;
    const tiny =
      draft.kind === "pen"
        ? draft.points.length < 2
        : Math.abs(draft.x2 - draft.x1) < 3 && Math.abs(draft.y2 - draft.y1) < 3;
    if (!tiny) setShapes((s) => [...s, draft]);
    setDraft(null);
  };

  // ------------------------------------------------------------ layout
  const css = (r: Rect) => ({ left: r.x / scale, top: r.y / scale, width: r.w / scale, height: r.h / scale });
  const live: Rect | null = sel
    ? sel
    : drag
      ? normalize(drag.x1, drag.y1, drag.x2, drag.y2)
      : hover;
  const liveCss = live ? css(live) : null;

  const toolbarStyle = useMemo(() => {
    if (!sel) return undefined;
    const r = css(sel);
    const barH = 44;
    const below = r.top + r.height + 10;
    const top = below + barH < view.h ? below : r.top - barH - 10 > 0 ? r.top - barH - 10 : r.top + r.height - barH - 10;
    const left = Math.max(8, Math.min(r.left, view.w - 560));
    return { top, left };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, scale, view]);

  if (error) {
    return (
      <div className="fixed inset-0 grid place-items-center bg-black/80 text-white">
        <div className="max-w-md rounded-xl border border-white/10 bg-[#1c1e25] p-5 text-center">
          <div className="text-[14px] font-semibold">Screenshot failed</div>
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
      {liveCss ? (
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
          {!drag && (
            <div className="pointer-events-none absolute left-1/2 top-4 -translate-x-1/2 rounded-full border border-white/10 bg-[#1c1e25]/95 px-4 py-1.5 text-[12px] text-white/85 shadow-lg">
              Drag a box · click a window{hover ? ` (${hover.title.slice(0, 40)})` : ""} · <b>F</b> whole screen · <b>Esc</b> cancel
            </div>
          )}
        </>
      )}

      {sel && (
        <>
          {/* Clicking outside the selection with no markup starts over. */}
          <div
            className="absolute inset-0"
            onPointerDown={(e) => {
              if (shapes.length === 0 && !busy) {
                setSel(null);
                onPickDown(e);
              }
            }}
            onPointerMove={(e) => drag && onPickMove(e)}
            onPointerUp={(e) => drag && onPickUp(e)}
          />
          <canvas
            ref={canvasRef}
            className="absolute"
            style={{ ...css(sel), cursor: "crosshair" }}
            onPointerDown={onEditDown}
            onPointerMove={onEditMove}
            onPointerUp={onEditUp}
            onDoubleClick={() => void finish(false)}
          />
          <div
            className="absolute z-10 flex items-center gap-1 rounded-xl border border-white/10 bg-[#1c1e25]/95 p-1.5 text-white shadow-2xl"
            style={toolbarStyle}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {TOOLS.map((t) => (
              <button
                key={t.id}
                type="button"
                title={`${t.label} (${t.key})`}
                onClick={() => setTool(t.id)}
                className={cn(
                  "grid h-8 w-8 place-items-center rounded-lg transition-colors",
                  tool === t.id ? "bg-[#5d72db] text-white" : "text-white/75 hover:bg-white/10",
                )}
              >
                <svg viewBox="0 0 16 16" className="h-4 w-4 fill-none stroke-current" strokeWidth="1.6">
                  <path d={t.icon} />
                </svg>
              </button>
            ))}
            <div className="mx-1 h-6 w-px bg-white/15" />
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                title="Colour"
                onClick={() => setColor(c)}
                className={cn(
                  "h-5 w-5 rounded-full border-2 transition-transform",
                  color === c ? "scale-110 border-white" : "border-white/20 hover:scale-105",
                )}
                style={{ background: c }}
              />
            ))}
            <div className="mx-1 h-6 w-px bg-white/15" />
            <button
              type="button"
              title="Undo (Ctrl+Z)"
              disabled={shapes.length === 0}
              onClick={() => setShapes((s) => s.slice(0, -1))}
              className="rounded-lg px-2 py-1.5 text-[12px] text-white/80 hover:bg-white/10 disabled:opacity-30"
            >
              Undo
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
              title="Copy to the clipboard (Enter)"
              disabled={!!busy}
              onClick={() => void finish(false)}
              className="rounded-lg bg-[#5d72db] px-3 py-1.5 text-[12px] font-semibold hover:bg-[#6b80e4] disabled:opacity-60"
            >
              {busy ?? "Copy"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
