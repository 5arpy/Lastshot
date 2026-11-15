import { useEffect, useRef, useState } from "react";
import { lastshot } from "../lib/bridge";
import type { DrawCommand } from "../lib/types";

/**
 * Transparent layer over the recorded screen for drawing while recording.
 * Unlike the control bar, it IS captured, so the drawings end up in the
 * video. Tools and colours come from the control bar.
 */

type Tool = Extract<DrawCommand, { kind: "tool" }>["tool"];
type Stroke =
  | { tool: "pen" | "marker"; color: string; width: number; points: [number, number][] }
  | { tool: "arrow" | "box"; color: string; width: number; x1: number; y1: number; x2: number; y2: number };

function draw(g: CanvasRenderingContext2D, s: Stroke) {
  g.save();
  g.lineCap = "round";
  g.lineJoin = "round";
  g.strokeStyle = s.color;
  g.fillStyle = s.color;
  g.lineWidth = s.width;
  if (s.tool === "marker") g.globalAlpha = 0.35;
  if ("points" in s) {
    if (s.points.length > 1) {
      g.beginPath();
      g.moveTo(s.points[0][0], s.points[0][1]);
      for (const [x, y] of s.points.slice(1)) g.lineTo(x, y);
      g.stroke();
    }
  } else if (s.tool === "box") {
    g.strokeRect(Math.min(s.x1, s.x2), Math.min(s.y1, s.y2), Math.abs(s.x2 - s.x1), Math.abs(s.y2 - s.y1));
  } else {
    const a = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
    const head = Math.max(14, s.width * 4);
    g.beginPath();
    g.moveTo(s.x1, s.y1);
    g.lineTo(s.x2 - Math.cos(a) * head * 0.6, s.y2 - Math.sin(a) * head * 0.6);
    g.stroke();
    g.beginPath();
    g.moveTo(s.x2, s.y2);
    g.lineTo(s.x2 - head * Math.cos(a - Math.PI / 7), s.y2 - head * Math.sin(a - Math.PI / 7));
    g.lineTo(s.x2 - head * Math.cos(a + Math.PI / 7), s.y2 - head * Math.sin(a + Math.PI / 7));
    g.closePath();
    g.fill();
  }
  g.restore();
}

export default function DrawLayer() {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [tool, setTool] = useState<{ tool: Tool; color: string }>({ tool: "pen", color: "#ff4d4f" });
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [draft, setDraft] = useState<Stroke | null>(null);
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  const dpr = window.devicePixelRatio || 1;

  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    const off = lastshot.onDraw((c) => {
      if (c.kind === "tool") setTool({ tool: c.tool, color: c.color });
      else if (c.kind === "undo") setStrokes((s) => s.slice(0, -1));
      else setStrokes([]);
    });
    return () => {
      window.removeEventListener("resize", onResize);
      void off.then((f) => f());
    };
  }, []);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    c.width = Math.round(size.w * dpr);
    c.height = Math.round(size.h * dpr);
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, size.w, size.h);
    for (const s of draft ? [...strokes, draft] : strokes) draw(g, s);
  }, [strokes, draft, size, dpr]);

  const width = tool.tool === "marker" ? 18 : 4;
  const down = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    const p: [number, number] = [e.clientX, e.clientY];
    setDraft(
      tool.tool === "pen" || tool.tool === "marker"
        ? { tool: tool.tool, color: tool.color, width, points: [p] }
        : { tool: tool.tool, color: tool.color, width, x1: p[0], y1: p[1], x2: p[0], y2: p[1] },
    );
  };
  const move = (e: React.PointerEvent) => {
    if (!draft) return;
    if ("points" in draft) setDraft({ ...draft, points: [...draft.points, [e.clientX, e.clientY]] });
    else setDraft({ ...draft, x2: e.clientX, y2: e.clientY });
  };
  const up = () => {
    if (!draft) return;
    const tiny = "points" in draft ? draft.points.length < 2 : Math.hypot(draft.x2 - draft.x1, draft.y2 - draft.y1) < 4;
    if (!tiny) setStrokes((s) => [...s, draft]);
    setDraft(null);
  };

  return (
    <canvas
      ref={canvas}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onContextMenu={(e) => {
        e.preventDefault();
        setStrokes((s) => s.slice(0, -1));
      }}
      // A whisper of colour: fully clear pixels may let clicks fall through.
      style={{ position: "fixed", inset: 0, width: "100vw", height: "100vh", background: "rgba(0,0,0,0.004)", cursor: "crosshair" }}
    />
  );
}
