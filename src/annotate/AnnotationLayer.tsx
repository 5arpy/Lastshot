import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  type Handle,
  IS_LINE,
  NO_ROTATE,
  type Pt,
  type Shape,
  type Style,
  type Tool,
  addStroke,
  corners,
  fitText,
  fromPts,
  handlePoints,
  hit,
  measureText,
  moveBy,
  penShape,
  resize,
  rotateTo,
  shapeId,
  thin,
  TEXT_PAD,
  fontOf,
  bounds,
} from "./shapes";

/**
 * The interactive layer over a picture: draws selection boxes and handles,
 * and turns pointer input into object edits. The host draws the objects
 * themselves (so the preview and the export match) and keeps the list.
 *
 * - Select tool: click to select (Shift/Ctrl adds), drag to move (snaps to
 *   the frame's centre and edges and to other objects; Ctrl stops snapping),
 *   handles resize (Shift keeps the shape, Alt from the centre), the round
 *   handle rotates (Shift snaps to 15°), drag on empty space selects a box.
 *   Double-click a text to edit it.
 * - Other tools: drag to draw; the text tool places a text and starts typing.
 */

export interface LayerView {
  /** Layer CSS pixels per content pixel. */
  scale: number;
  /** Where content (0, 0) is, in layer CSS pixels. */
  ox: number;
  oy: number;
}

interface Props {
  shapes: Shape[];
  content: { w: number; h: number };
  view: LayerView;
  tool: Tool;
  style: Style;
  selected: string[];
  onSelect: (ids: string[]) => void;
  /** `commit`: false while dragging (preview), true once at the end (one undo step). */
  onChange: (changed: Shape[], commit: boolean, label: string) => void;
  onCreate: (s: Shape) => void;
  onDelete: (ids: string[]) => void;
  editing: string | null;
  setEditing: (id: string | null) => void;
  /** Number for the next step badge. */
  nextStep?: number;
  /** A pen shape new strokes join (so one drawing is one object). */
  penTarget?: string | null;
  /** Lets the host take a pointer-down first (return true to take it). */
  onEmptyPointer?: (e: React.PointerEvent) => boolean;
  /** Called after a shape is made with a one-shot tool (text). */
  onToolDone?: () => void;
  className?: string;
}

type Drag =
  | { kind: "create"; start: Pt; shape: Shape }
  | { kind: "pen"; points: Pt[]; base: Shape | null }
  | { kind: "move"; start: Pt; orig: Shape[]; moved: boolean }
  | { kind: "resize"; h: Handle; s0: Shape }
  | { kind: "rotate"; start: Pt; s0: Shape }
  | { kind: "marquee"; start: Pt; cur: Pt; add: boolean; before: string[] };

const HANDLE_CURSOR: Record<string, string> = {
  nw: "nwse-resize",
  se: "nwse-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
  p0: "move",
  p1: "move",
  rot: "grab",
};

export default function AnnotationLayer(p: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const drag = useRef<Drag | null>(null);
  const [draft, setDraft] = useState<Shape | null>(null);
  const [marquee, setMarquee] = useState<{ a: Pt; b: Pt } | null>(null);
  const [guides, setGuides] = useState<{ x: number[]; y: number[] }>({ x: [], y: [] });
  const [cursor, setCursor] = useState<string>("default");
  const { scale, ox, oy } = p.view;
  const tol = 6 / Math.max(scale, 1e-3);

  const toContent = (e: { clientX: number; clientY: number }): Pt => {
    const r = ref.current!.getBoundingClientRect();
    return [(e.clientX - r.left - ox) / scale, (e.clientY - r.top - oy) / scale];
  };
  const sx = (x: number) => ox + x * scale;
  const sy = (y: number) => oy + y * scale;

  const byId = new Map(p.shapes.map((s) => [s.id, s]));
  const sel = p.selected.map((id) => byId.get(id)).filter((s): s is Shape => !!s);
  const single = sel.length === 1 && !sel[0].locked ? sel[0] : null;

  const topHit = (pt: Pt): Shape | null => {
    for (let k = p.shapes.length - 1; k >= 0; k--) if (hit(p.shapes[k], pt, tol)) return p.shapes[k];
    return null;
  };

  const handleAt = (pt: Pt): Handle | null => {
    if (!single) return null;
    for (const h of handlePoints(single, 26 / scale)) if (Math.hypot(h.p[0] - pt[0], h.p[1] - pt[1]) <= 8 / scale) return h.h;
    return null;
  };

  /** Snaps a moving group's box to the frame and other objects. */
  const snapMove = (orig: Shape[], dx: number, dy: number, off: boolean): { dx: number; dy: number } => {
    if (off) {
      setGuides({ x: [], y: [] });
      return { dx, dy };
    }
    const b = bounds(orig.flatMap((s) => corners(s)));
    const xs = [b.x + dx, b.x + b.w / 2 + dx, b.x + b.w + dx];
    const ys = [b.y + dy, b.y + b.h / 2 + dy, b.y + b.h + dy];
    const ids = new Set(orig.map((s) => s.id));
    const tx = [0, p.content.w / 2, p.content.w];
    const ty = [0, p.content.h / 2, p.content.h];
    for (const s of p.shapes) {
      if (ids.has(s.id) || s.hidden) continue;
      const o = bounds(corners(s));
      tx.push(o.x, o.x + o.w / 2, o.x + o.w);
      ty.push(o.y, o.y + o.h / 2, o.y + o.h);
    }
    const lim = 6 / scale;
    let bx: number | null = null;
    let by: number | null = null;
    let ddx = 0;
    let ddy = 0;
    for (const x of xs) for (const t of tx) if (Math.abs(t - x) <= lim && (bx === null || Math.abs(t - x) < Math.abs(ddx))) ((bx = t), (ddx = t - x));
    for (const y of ys) for (const t of ty) if (Math.abs(t - y) <= lim && (by === null || Math.abs(t - y) < Math.abs(ddy))) ((by = t), (ddy = t - y));
    setGuides({ x: bx === null ? [] : [bx], y: by === null ? [] : [by] });
    return { dx: dx + ddx, dy: dy + ddy };
  };

  const down = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (p.editing) {
      // Clicking outside the text being edited finishes it.
      (document.activeElement as HTMLElement | null)?.blur?.();
      return;
    }
    const pt = toContent(e);
    const tool = p.tool;
    if (tool === "select") {
      const h = handleAt(pt);
      if (h && single) {
        drag.current = h === "rot" ? { kind: "rotate", start: pt, s0: single } : { kind: "resize", h, s0: single };
      } else {
        const s = topHit(pt);
        if (s) {
          let ids = p.selected;
          if (e.shiftKey || e.ctrlKey) {
            ids = ids.includes(s.id) ? ids.filter((x) => x !== s.id) : [...ids, s.id];
            p.onSelect(ids);
          } else if (!ids.includes(s.id)) {
            ids = [s.id];
            p.onSelect(ids);
          }
          const orig = ids.map((id) => byId.get(id)).filter((x): x is Shape => !!x && !x.locked);
          drag.current = { kind: "move", start: pt, orig, moved: false };
        } else {
          if (p.onEmptyPointer?.(e)) return;
          drag.current = { kind: "marquee", start: pt, cur: pt, add: e.shiftKey || e.ctrlKey, before: p.selected };
          if (!e.shiftKey && !e.ctrlKey) p.onSelect([]);
        }
      }
    } else if (tool === "text") {
      const s0: Shape = {
        id: shapeId(),
        kind: "text",
        x: pt[0],
        y: pt[1],
        w: 10,
        h: 10,
        rot: 0,
        color: p.style.color,
        fill: p.style.fill,
        width: 0,
        opacity: p.style.opacity,
        text: "",
        size: p.style.size,
        bold: p.style.bold,
        italic: p.style.italic,
        align: p.style.align,
        outline: p.style.outline,
        shadow: p.style.shadow,
      };
      const m = measureText({ ...s0, text: "M" });
      const s = { ...s0, y: pt[1] - m.h / 2, w: m.w, h: m.h };
      p.onCreate(s);
      p.onSelect([s.id]);
      p.setEditing(s.id);
      p.onToolDone?.();
      e.preventDefault();
      return;
    } else if (tool === "pen" || tool === "highlight") {
      const base = p.penTarget ? byId.get(p.penTarget) ?? null : null;
      drag.current = { kind: "pen", points: [pt], base: base && base.kind === tool && !base.rot && !base.flipX && !base.flipY ? base : null };
    } else {
      const s: Shape = {
        id: shapeId(),
        kind: tool,
        x: pt[0],
        y: pt[1],
        w: 0,
        h: 0,
        rot: 0,
        color: tool === "redact" ? "#000000" : p.style.color,
        fill: tool === "redact" ? "#000000" : p.style.fill,
        width: p.style.width,
        opacity: tool === "blur" || tool === "pixelate" ? 1 : p.style.opacity,
        dash: p.style.dash,
        n: p.nextStep,
        pts: IS_LINE(tool) ? [pt, pt] : undefined,
      };
      if (tool === "step") {
        const r = Math.max(18, p.style.size * 0.45);
        const st = { ...s, x: pt[0] - r, y: pt[1] - r, w: r * 2, h: r * 2 };
        p.onCreate(st);
        p.onSelect([st.id]);
        return;
      }
      drag.current = { kind: "create", start: pt, shape: s };
    }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const move = (e: React.PointerEvent) => {
    const pt = toContent(e);
    const d = drag.current;
    if (!d) {
      if (p.tool !== "select") {
        setCursor("crosshair");
        return;
      }
      const h = handleAt(pt);
      setCursor(h ? HANDLE_CURSOR[h] : topHit(pt) ? "move" : "default");
      return;
    }
    if (d.kind === "create") {
      const s = d.shape;
      let shape: Shape;
      if (IS_LINE(s.kind)) {
        let q = pt;
        if (e.shiftKey) {
          const a = Math.round(Math.atan2(pt[1] - d.start[1], pt[0] - d.start[0]) / (Math.PI / 12)) * (Math.PI / 12);
          const len = Math.hypot(pt[0] - d.start[0], pt[1] - d.start[1]);
          q = [d.start[0] + Math.cos(a) * len, d.start[1] + Math.sin(a) * len];
        }
        shape = fromPts(s, [d.start, q]);
      } else {
        let w = pt[0] - d.start[0];
        let h = pt[1] - d.start[1];
        if (e.shiftKey) {
          const m = Math.max(Math.abs(w), Math.abs(h));
          w = Math.sign(w || 1) * m;
          h = Math.sign(h || 1) * m;
        }
        shape = { ...s, x: Math.min(d.start[0], d.start[0] + w), y: Math.min(d.start[1], d.start[1] + h), w: Math.abs(w), h: Math.abs(h) };
      }
      d.shape = shape;
      setDraft(shape);
    } else if (d.kind === "pen") {
      d.points.push(pt);
      const base = { id: "draft", kind: p.tool as Shape["kind"], rot: 0, color: p.style.color, width: p.tool === "highlight" ? Math.max(p.style.width * 3, 14) : p.style.width, opacity: p.style.opacity };
      setDraft(penShape(base, [d.points]));
    } else if (d.kind === "move") {
      if (!d.orig.length) return;
      let dx = pt[0] - d.start[0];
      let dy = pt[1] - d.start[1];
      if (!d.moved && Math.hypot(dx, dy) * scale < 3) return;
      d.moved = true;
      if (e.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      ({ dx, dy } = snapMove(d.orig, dx, dy, e.ctrlKey));
      p.onChange(
        d.orig.map((s) => moveBy(s, dx, dy)),
        false,
        "Move",
      );
    } else if (d.kind === "resize") {
      p.onChange([resize(d.s0, d.h, pt, { shift: e.shiftKey, fromCentre: e.altKey })], false, "Resize");
    } else if (d.kind === "rotate") {
      p.onChange([rotateTo(d.s0, d.start, pt, e.shiftKey)], false, "Rotate");
    } else if (d.kind === "marquee") {
      d.cur = pt;
      setMarquee({ a: d.start, b: pt });
      const lo: Pt = [Math.min(d.start[0], pt[0]), Math.min(d.start[1], pt[1])];
      const hi: Pt = [Math.max(d.start[0], pt[0]), Math.max(d.start[1], pt[1])];
      const inside = p.shapes
        .filter((s) => !s.hidden)
        .filter((s) => {
          const b = bounds(corners(s));
          return b.x < hi[0] && b.x + b.w > lo[0] && b.y < hi[1] && b.y + b.h > lo[1];
        })
        .map((s) => s.id);
      p.onSelect(d.add ? [...new Set([...d.before, ...inside])] : inside);
    }
  };

  const up = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    setGuides({ x: [], y: [] });
    setMarquee(null);
    setDraft(null);
    if (!d) return;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }
    if (d.kind === "create") {
      const s = d.shape;
      const tiny = IS_LINE(s.kind) ? Math.hypot(s.w, s.h) * scale < 4 : s.w * scale < 4 || s.h * scale < 4;
      if (tiny) return;
      p.onCreate(s);
      p.onSelect([s.id]);
    } else if (d.kind === "pen") {
      const pts = thin(d.points, 1 / scale);
      const width = p.tool === "highlight" ? Math.max(p.style.width * 3, 14) : p.style.width;
      if (d.base) {
        const s = addStroke(d.base, pts);
        p.onChange([s], true, "Draw");
      } else {
        const s = penShape({ id: shapeId(), kind: p.tool as Shape["kind"], rot: 0, color: p.style.color, width, opacity: p.style.opacity }, [pts]);
        p.onCreate(s);
      }
    } else if (d.kind === "move") {
      if (d.moved) {
        const live = d.orig.map((s) => byId.get(s.id) ?? s);
        p.onChange(live, true, "Move");
      }
    } else if (d.kind === "resize" || d.kind === "rotate") {
      const live = byId.get(d.s0.id);
      if (live) p.onChange([live], true, d.kind === "resize" ? "Resize" : "Rotate");
    }
  };

  const dbl = (e: React.MouseEvent) => {
    const s = topHit(toContent(e));
    if (s?.kind === "text" && !s.locked) {
      p.onSelect([s.id]);
      p.setEditing(s.id);
    }
  };

  const editing = p.editing ? byId.get(p.editing) : null;

  return (
    <div
      ref={ref}
      className={p.className ?? "absolute inset-0"}
      style={{ cursor, touchAction: "none" }}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onDoubleClick={dbl}
    >
      <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
        {draft && <DraftOutline s={draft} sx={sx} sy={sy} />}
        {sel.map((s) => (
          <polygon
            key={s.id}
            points={(IS_LINE(s.kind) && s.pts ? s.pts : corners(s)).map(([x, y]) => `${sx(x)},${sy(y)}`).join(" ")}
            fill="none"
            stroke={s.locked ? "#9aa0ae" : "#4f8cff"}
            strokeWidth={1.5}
            strokeDasharray={s.locked ? "4 3" : undefined}
          />
        ))}
        {single &&
          !(p.editing === single.id) &&
          (() => {
            const hs = handlePoints(single, 26 / scale);
            const top = hs.find((h) => h.h === "n");
            const rot = hs.find((h) => h.h === "rot");
            return (
              <g>
                {top && rot && !NO_ROTATE.has(single.kind) && (
                  <line x1={sx(top.p[0])} y1={sy(top.p[1])} x2={sx(rot.p[0])} y2={sy(rot.p[1])} stroke="#4f8cff" strokeWidth={1.5} />
                )}
                {hs.map((h) =>
                  h.h === "rot" ? (
                    <circle key={h.h} cx={sx(h.p[0])} cy={sy(h.p[1])} r={5.5} fill="#fff" stroke="#4f8cff" strokeWidth={1.5} />
                  ) : (
                    <rect key={h.h} x={sx(h.p[0]) - 4.5} y={sy(h.p[1]) - 4.5} width={9} height={9} rx={2} fill="#fff" stroke="#4f8cff" strokeWidth={1.5} />
                  ),
                )}
              </g>
            );
          })()}
        {sel.length === 1 && sel[0].locked && (
          <text x={sx(bounds(corners(sel[0])).x)} y={sy(bounds(corners(sel[0])).y) - 6} fill="#c8ccd6" fontSize={11}>
            Locked (Ctrl+Shift+L)
          </text>
        )}
        {marquee && (
          <rect
            x={sx(Math.min(marquee.a[0], marquee.b[0]))}
            y={sy(Math.min(marquee.a[1], marquee.b[1]))}
            width={Math.abs(marquee.b[0] - marquee.a[0]) * scale}
            height={Math.abs(marquee.b[1] - marquee.a[1]) * scale}
            fill="rgba(79,140,255,0.12)"
            stroke="#4f8cff"
            strokeDasharray="4 3"
          />
        )}
        {guides.x.map((x) => (
          <line key={`gx${x}`} x1={sx(x)} x2={sx(x)} y1={sy(0)} y2={sy(p.content.h)} stroke="#ff4fd8" strokeWidth={1} />
        ))}
        {guides.y.map((y) => (
          <line key={`gy${y}`} y1={sy(y)} y2={sy(y)} x1={sx(0)} x2={sx(p.content.w)} stroke="#ff4fd8" strokeWidth={1} />
        ))}
      </svg>
      {editing && editing.kind === "text" && (
        <TextEditor
          s={editing}
          view={p.view}
          onText={(text, commit) => {
            const next = fitText({ ...editing, text });
            p.onChange([next], commit, "Text");
          }}
          onDone={(text) => {
            p.setEditing(null);
            if (!text.trim()) p.onDelete([editing.id]);
            else p.onChange([fitText({ ...editing, text })], true, "Text");
          }}
        />
      )}
    </div>
  );
}

function DraftOutline({ s, sx, sy }: { s: Shape; sx: (x: number) => number; sy: (y: number) => number }) {
  if (s.kind === "pen" || s.kind === "highlight") {
    const st = s.strokes?.[0] ?? [];
    return (
      <polyline
        points={st.map(([u, v]) => `${sx(s.x + u * s.w)},${sy(s.y + v * s.h)}`).join(" ")}
        fill="none"
        stroke={s.color}
        strokeOpacity={s.kind === "highlight" ? 0.45 : s.opacity}
        strokeWidth={Math.max(1, s.width * ((sx(1) - sx(0)) || 1))}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    );
  }
  if (IS_LINE(s.kind) && s.pts) {
    return <line x1={sx(s.pts[0][0])} y1={sy(s.pts[0][1])} x2={sx(s.pts[1][0])} y2={sy(s.pts[1][1])} stroke={s.color} strokeWidth={2} strokeDasharray="5 3" />;
  }
  const k = sx(1) - sx(0);
  if (s.kind === "ellipse")
    return <ellipse cx={sx(s.x + s.w / 2)} cy={sy(s.y + s.h / 2)} rx={(s.w / 2) * k} ry={(s.h / 2) * k} fill="none" stroke={s.color} strokeWidth={2} strokeDasharray="5 3" />;
  return <rect x={sx(s.x)} y={sy(s.y)} width={s.w * k} height={s.h * k} fill="none" stroke={s.kind === "blur" || s.kind === "pixelate" ? "#fff" : s.color} strokeWidth={2} strokeDasharray="5 3" />;
}

/** Typing in place: a see-through text box laid exactly over the text. */
function TextEditor({ s, view, onText, onDone }: { s: Shape; view: LayerView; onText: (t: string, commit: boolean) => void; onDone: (t: string) => void }) {
  const ta = useRef<HTMLTextAreaElement | null>(null);
  const [value, setValue] = useState(s.text ?? "");
  const done = useRef(false);
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    // No scrolling: the layer sits in an overflow-hidden overlay.
    el.focus({ preventScroll: true });
    el.select();
  }, []);
  useEffect(() => {
    done.current = false;
    return () => void (done.current = true);
  }, []);
  const finish = () => {
    if (done.current) return;
    done.current = true;
    onDone(ta.current?.value ?? value);
  };
  const size = (s.size ?? 64) * view.scale;
  const pad = size * TEXT_PAD;
  return (
    <textarea
      ref={ta}
      value={value}
      spellCheck={false}
      onChange={(e) => {
        setValue(e.target.value);
        onText(e.target.value, false);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape" || (e.key === "Enter" && e.ctrlKey)) {
          e.preventDefault();
          finish();
        }
      }}
      onBlur={finish}
      onPointerDown={(e) => e.stopPropagation()}
      className="absolute resize-none overflow-hidden border border-dashed border-[#4f8cff] bg-transparent outline-none"
      style={{
        left: view.ox + s.x * view.scale,
        top: view.oy + s.y * view.scale,
        width: Math.max(40, s.w * view.scale + size * 0.6),
        height: s.h * view.scale,
        transform: `rotate(${s.rot}deg) scale(${s.flipX ? -1 : 1}, ${s.flipY ? -1 : 1})`,
        transformOrigin: `${(s.w * view.scale) / 2}px ${(s.h * view.scale) / 2}px`,
        font: fontOf({ ...s, size }),
        lineHeight: 1.2,
        padding: `${pad + size * 0.08}px ${pad}px ${pad}px`,
        color: s.color,
        caretColor: s.color === "#111111" ? "#000" : "#fff",
        textAlign: s.align ?? "left",
        whiteSpace: "pre",
        WebkitTextStroke: s.outline ? `${Math.max(0.5, size * 0.06)}px ${s.outline}` : undefined,
        paintOrder: "stroke fill",
      }}
    />
  );
}
