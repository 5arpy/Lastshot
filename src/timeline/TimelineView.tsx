import { type ReactNode, type Ref, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { EPS, type Item, type Marker, type Timeline, type Track, end, timelineEnd, withLinked } from "./model";
import { type EditOpts, type Move, type PlaceMode, itemsInBox, moveItems, patchMarker, splitAt, trimItem } from "./ops";
import { nearest, snapPoints, snapSpan } from "./snap";
import { type TlView, rulerLabel, tickStep, timeToX, xToTime, zoomAt } from "./view";

/**
 * Timeline engine: the view. Generic over the item type, so the audio editor
 * can reuse it with its own item drawing. It owns pointer interaction (move,
 * trim, marquee, blade, scrub, markers, zoom, scroll, snapping) and reports
 * edits; the host owns the state, the history and the keys.
 *
 * Performance: only items in view are rendered (and cut to the view, so a
 * 30-minute clip at frame zoom is still one small element); the playhead and
 * time follow the clock without re-rendering.
 */

export type EditPhase = "start" | "live" | "end" | "once" | "cancel";

export interface Clock {
  time: number;
  subscribe: (fn: (t: number, playing: boolean) => void) => () => void;
  seek: (t: number) => void;
}

export interface ItemGeom {
  /** Element width in px (already cut to the view). */
  w: number;
  h: number;
  /** Timeline seconds at the element's left edge. */
  t0: number;
  pxPerSec: number;
  /** True when the item's real start / end edge is inside the element. */
  hasStart: boolean;
  hasEnd: boolean;
}

export interface Hit {
  track: Track | null;
  /** Below the last track (drop there to add a track). */
  below: boolean;
  t: number;
}

export interface TimelineApi {
  hit: (clientX: number, clientY: number) => Hit;
  lanesWidth: () => number;
}

export interface TimelineViewProps<I extends Item> {
  tl: Timeline<I>;
  clock: Clock;
  selection: Set<string>;
  onSelection: (ids: Set<string>) => void;
  view: TlView;
  onView: (v: TlView) => void;
  snapping: boolean;
  tool: "select" | "blade";
  /** Ripple trims (and Ctrl while trimming). */
  ripple: boolean;
  editOpts: () => EditOpts;
  onEdit: (next: Timeline<I>, phase: EditPhase, label: string) => void;
  accepts: (track: Track, item: I) => boolean;
  trackHeight: (track: Track) => number;
  renderItem: (item: I, g: ItemGeom, selected: boolean) => ReactNode;
  itemClass: (item: I, selected: boolean) => string;
  renderHeader: (track: Track) => ReactNode;
  onContext?: (e: React.MouseEvent, hit: { item?: I; track: Track | null; t: number }) => void;
  onItemDoubleClick?: (item: I) => void;
  onGap?: (gap: { track: string; t: number } | null) => void;
  gap?: { track: string; t: number; start: number; end: number } | null;
  onMarkerEdit?: (m: Marker) => void;
  /** A drop being dragged over (files, library clips): drawn as a ghost. */
  ghost?: { track: string; start: number; duration: number; label: string } | null;
  /** Extra space under the tracks that accepts drops ("drop here for a new track"). */
  belowHint?: string | null;
  headerWidth?: number;
  fps?: number;
  apiRef?: Ref<TimelineApi>;
}

const EDGE_PX = 7;
const SNAP_PX = 9;
const RULER_H = 26;

type Drag =
  | { kind: "move"; x0: number; y0: number; t0: number; orig: Timeline<Item>; ids: string[]; anchor: Item; moved: boolean; trackIdx0: number }
  | { kind: "trim"; orig: Timeline<Item>; id: string; edge: "left" | "right"; moved: boolean }
  | { kind: "marquee"; x0: number; y0: number; add: boolean; before: Set<string>; moved: boolean; t: number; track: Track | null }
  | { kind: "scrub" }
  | { kind: "marker"; id: string; orig: Timeline<Item>; moved: boolean };

export default function TimelineView<I extends Item>(p: TimelineViewProps<I>) {
  const HEAD = p.headerWidth ?? 148;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const lanesRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const rulerRef = useRef<HTMLCanvasElement | null>(null);
  const playRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(800);
  const [snapAt, setSnapAt] = useState<number | null>(null);
  const [box, setBox] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const [hoverEdge, setHoverEdge] = useState(false);
  const drag = useRef<Drag | null>(null);
  const v = p.view;
  const pRef = useRef(p);
  pRef.current = p;

  // Lane width follows the panel size.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(100, el.clientWidth - HEAD)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [HEAD]);

  // Track rows: top offsets.
  const rows = useMemo(() => {
    let y = 0;
    return p.tl.tracks.map((t) => {
      const h = p.trackHeight(t);
      const r = { track: t, y, h };
      y += h;
      return r;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.tl.tracks, p.trackHeight]);
  const rowsH = rows.length ? rows[rows.length - 1].y + rows[rows.length - 1].h : 0;

  const length = timelineEnd(p.tl);
  const span = Math.max(length * 1.15 + 5, v.scroll + width / v.pxPerSec);

  // ------------------------------------------------------------ geometry
  const laneX = (clientX: number) => clientX - (lanesRef.current?.getBoundingClientRect().left ?? 0);
  const timeAt = (clientX: number) => Math.max(0, xToTime(pRef.current.view, laneX(clientX)));
  const rowAt = (clientY: number): { track: Track | null; below: boolean } => {
    const body = bodyRef.current;
    if (!body) return { track: null, below: false };
    const y = clientY - body.getBoundingClientRect().top + body.scrollTop;
    for (const r of rows) if (y >= r.y && y < r.y + r.h) return { track: r.track, below: false };
    return { track: null, below: y >= rowsH };
  };

  useImperativeHandle(
    p.apiRef,
    () => ({
      hit: (cx, cy) => {
        const r = rowAt(cy);
        return { ...r, t: timeAt(cx) };
      },
      lanesWidth: () => width,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, width],
  );

  // ------------------------------------------------------------ playhead (no re-render)
  useEffect(() => {
    const place = (t: number) => {
      const el = playRef.current;
      if (!el) return;
      const x = timeToX(pRef.current.view, t);
      el.style.transform = `translateX(${HEAD + x}px)`;
      el.style.display = x < -2 || x > width + 2 ? "none" : "block";
    };
    place(p.clock.time);
    return p.clock.subscribe((t) => place(t));
  }, [p.clock, v, width, HEAD]);

  // ------------------------------------------------------------ ruler (canvas)
  useEffect(() => {
    const c = rulerRef.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(width * dpr);
    c.height = Math.round(RULER_H * dpr);
    c.style.width = `${width}px`;
    const g = c.getContext("2d")!;
    g.scale(dpr, dpr);
    const css = getComputedStyle(c);
    const ink = css.getPropertyValue("--color-ink-3").trim() || "#8a8f9c";
    const line = css.getPropertyValue("--color-line-2").trim() || "#3a3d47";
    g.clearRect(0, 0, width, RULER_H);
    const step = tickStep(v.pxPerSec);
    const minor = step / (step >= 60 ? 6 : step >= 1 ? 5 : 2);
    const t0 = Math.floor(v.scroll / minor) * minor;
    const t1 = v.scroll + width / v.pxPerSec;
    g.strokeStyle = line;
    g.fillStyle = ink;
    g.font = "10px ui-monospace, Consolas, monospace";
    g.textBaseline = "top";
    g.beginPath();
    for (let t = t0; t <= t1 + minor; t += minor) {
      const x = Math.round(timeToX(v, t)) + 0.5;
      const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
      g.moveTo(x, major ? 10 : 18);
      g.lineTo(x, RULER_H);
      if (major) g.fillText(rulerLabel(t, step, p.fps ?? 60), x + 3, 2);
    }
    g.stroke();
    // In / out.
    const { inPoint, outPoint } = p.tl;
    if (inPoint !== null || outPoint !== null) {
      const a = timeToX(v, inPoint ?? 0);
      const b = timeToX(v, outPoint ?? length);
      g.fillStyle = "rgba(79,140,255,0.35)";
      g.fillRect(a, RULER_H - 6, b - a, 6);
    }
  }, [v, width, p.tl.inPoint, p.tl.outPoint, length, p.fps]);

  // ------------------------------------------------------------ wheel: zoom and scroll
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const P = pRef.current;
      const overHeaders = e.clientX - el.getBoundingClientRect().left < HEAD;
      if (e.ctrlKey || e.altKey) {
        e.preventDefault();
        const f = Math.exp(-e.deltaY * 0.0022);
        P.onView(zoomAt(P.view, f, Math.max(0, laneX(e.clientX))));
        return;
      }
      const dx = e.shiftKey ? 0 : e.deltaX;
      const vertical = e.shiftKey || overHeaders;
      if (vertical && !e.deltaX) return; // let the track list scroll natively
      e.preventDefault();
      const d = dx || e.deltaY;
      P.onView({ ...P.view, scroll: Math.max(0, P.view.scroll + d / P.view.pxPerSec) });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [HEAD]);

  // ------------------------------------------------------------ snapping
  const snapThreshold = () => SNAP_PX / pRef.current.view.pxPerSec;
  const points = (exclude: Set<string>) => snapPoints(pRef.current.tl, { playhead: pRef.current.clock.time, exclude });

  // ------------------------------------------------------------ pointer: lanes
  const itemOf = (target: EventTarget | null): I | null => {
    const el = (target as HTMLElement | null)?.closest?.("[data-item]") as HTMLElement | null;
    if (!el) return null;
    return pRef.current.tl.items.find((i) => i.id === el.dataset.item) ?? null;
  };

  const edgeOf = (it: I, clientX: number): "left" | "right" | null => {
    const x = laneX(clientX);
    const a = timeToX(v, it.start);
    const b = timeToX(v, end(it));
    if (b - a < EDGE_PX * 3) return Math.abs(x - b) < EDGE_PX ? "right" : null;
    if (Math.abs(x - a) <= EDGE_PX) return "left";
    if (Math.abs(x - b) <= EDGE_PX) return "right";
    return null;
  };

  const onLaneDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const P = pRef.current;
    const it = itemOf(e.target);
    const t = timeAt(e.clientX);
    const { track } = rowAt(e.clientY);
    P.onGap?.(null);
    if (P.tool === "blade" && it) {
      let at = t;
      if (P.snapping) at = nearest(points(new Set()), t, snapThreshold()) ?? t;
      const r = splitAt(P.tl, at, e.altKey ? [it.id] : withLinked(P.tl, [it.id]));
      if (r.created.length) P.onEdit(r.tl, "once", "Split");
      return;
    }
    if (it) {
      const locked = P.tl.tracks.find((x) => x.id === it.track)?.locked;
      const edge = locked ? null : edgeOf(it, e.clientX);
      let sel = new Set(P.selection);
      const group = e.altKey ? new Set([it.id]) : withLinked(P.tl, [it.id]);
      if (e.ctrlKey) {
        if (sel.has(it.id)) for (const g of group) sel.delete(g);
        else for (const g of group) sel.add(g);
      } else if (e.shiftKey) {
        for (const g of group) sel.add(g);
      } else if (!sel.has(it.id) || edge) {
        sel = group;
      }
      P.onSelection(sel);
      if (locked) return;
      if (edge) {
        drag.current = { kind: "trim", orig: P.tl as Timeline<Item>, id: it.id, edge, moved: false };
      } else {
        const ids = [...sel].filter((id) => {
          const x = P.tl.items.find((i) => i.id === id);
          return x && !P.tl.tracks.find((tr) => tr.id === x.track)?.locked;
        });
        drag.current = {
          kind: "move",
          x0: e.clientX,
          y0: e.clientY,
          t0: t,
          orig: P.tl as Timeline<Item>,
          ids,
          anchor: it,
          moved: false,
          trackIdx0: P.tl.tracks.findIndex((x) => x.id === it.track),
        };
      }
    } else {
      drag.current = { kind: "marquee", x0: e.clientX, y0: e.clientY, add: e.ctrlKey || e.shiftKey, before: new Set(P.selection), moved: false, t, track };
    }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onLaneMove = (e: React.PointerEvent) => {
    const P = pRef.current;
    const d = drag.current;
    if (!d) {
      const it = itemOf(e.target);
      setHoverEdge(!!it && P.tool === "select" && !!edgeOf(it, e.clientX));
      return;
    }
    if (d.kind === "move") {
      if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 4) return;
      if (!d.moved) {
        d.moved = true;
        P.onEdit(P.tl, "start", "Move");
      }
      const orig = d.orig as Timeline<I>;
      const items = d.ids.map((id) => orig.items.find((i) => i.id === id)!).filter(Boolean);
      let dt = timeAt(e.clientX) - d.t0;
      const minStart = Math.min(...items.map((i) => i.start));
      dt = Math.max(dt, -minStart);
      let at: number | null = null;
      if (P.snapping !== e.shiftKey) {
        const maxEnd = Math.max(...items.map((i) => end(i)));
        const s = snapSpan(points(new Set(d.ids)), minStart + dt, maxEnd + dt, snapThreshold());
        if (s.at !== null && minStart + dt + s.shift >= -EPS) {
          dt += s.shift;
          at = s.at;
        }
      }
      setSnapAt(at);
      // Vertical: shift every item by the same number of tracks if all fit.
      const { track } = rowAt(e.clientY);
      let dIdx = track ? orig.tracks.findIndex((x) => x.id === track.id) - d.trackIdx0 : 0;
      const target = (i: I) => orig.tracks[orig.tracks.findIndex((x) => x.id === i.track) + dIdx];
      if (dIdx !== 0 && !items.every((i) => target(i) && !target(i).locked && P.accepts(target(i), i))) dIdx = 0;
      const moves: Move[] = items.map((i) => ({ id: i.id, start: i.start + dt, track: dIdx ? target(i).id : i.track }));
      const mode: PlaceMode = e.ctrlKey ? "insert" : "overwrite";
      const next = moveItems(orig, moves, mode, P.editOpts());
      P.onEdit(next, "live", "Move");
      setTip({ x: e.clientX, y: e.clientY, text: `${fmt(minStart + dt)}${mode === "insert" ? " · Insert" : ""}` });
    } else if (d.kind === "trim") {
      if (!d.moved) {
        d.moved = true;
        P.onEdit(P.tl, "start", "Trim");
      }
      let t = timeAt(e.clientX);
      let at: number | null = null;
      if (P.snapping !== e.shiftKey) {
        const n = nearest(points(withLinked(d.orig, [d.id])), t, snapThreshold());
        if (n !== null) {
          t = n;
          at = n;
        }
      }
      setSnapAt(at);
      const next = trimItem(d.orig as Timeline<I>, d.id, d.edge, t, { ripple: P.ripple || e.ctrlKey, ...P.editOpts() });
      const it = next.items.find((i) => i.id === d.id);
      P.onEdit(next, "live", "Trim");
      if (it) setTip({ x: e.clientX, y: e.clientY, text: `${fmt(it.duration)} long${P.ripple || e.ctrlKey ? " · Ripple" : ""}` });
    } else if (d.kind === "marquee") {
      if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 4) return;
      d.moved = true;
      const lr = lanesRef.current!.getBoundingClientRect();
      setBox({ x0: d.x0 - lr.left, y0: d.y0 - lr.top, x1: e.clientX - lr.left, y1: e.clientY - lr.top });
      const ya = Math.min(d.y0, e.clientY);
      const yb = Math.max(d.y0, e.clientY);
      const body = bodyRef.current!;
      const top = body.getBoundingClientRect().top - body.scrollTop;
      const tracks = new Set(rows.filter((r) => top + r.y + r.h > ya && top + r.y < yb).map((r) => r.track.id));
      const ids = itemsInBox(P.tl, tracks, timeAt(d.x0), timeAt(e.clientX));
      P.onSelection(new Set(d.add ? [...d.before, ...ids] : ids));
    }
  };

  const onLaneUp = (e: React.PointerEvent) => {
    const P = pRef.current;
    const d = drag.current;
    drag.current = null;
    setSnapAt(null);
    setBox(null);
    setTip(null);
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }
    if (!d) return;
    if (d.kind === "move" || d.kind === "trim") {
      if (d.moved) P.onEdit(P.tl, "end", d.kind === "move" ? "Move" : "Trim");
    } else if (d.kind === "marquee" && !d.moved) {
      // A click on empty track: playhead there, and the gap (if any) selected.
      if (!d.add) P.onSelection(new Set());
      P.clock.seek(P.snapping ? nearest(points(new Set()), d.t, snapThreshold()) ?? d.t : d.t);
      if (d.track) P.onGap?.({ track: d.track.id, t: d.t });
    }
  };

  // ------------------------------------------------------------ ruler: scrub and markers
  const onRulerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const P = pRef.current;
    const mk = (e.target as HTMLElement).closest?.("[data-marker]") as HTMLElement | null;
    if (mk) {
      drag.current = { kind: "marker", id: mk.dataset.marker!, orig: P.tl as Timeline<Item>, moved: false };
    } else {
      drag.current = { kind: "scrub" };
      P.clock.seek(timeAt(e.clientX));
    }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onRulerMove = (e: React.PointerEvent) => {
    const P = pRef.current;
    const d = drag.current;
    if (!d) return;
    if (d.kind === "scrub") {
      let t = timeAt(e.clientX);
      if (e.shiftKey) t = nearest(points(new Set()), t, snapThreshold() * 2) ?? t;
      P.clock.seek(t);
    } else if (d.kind === "marker") {
      if (!d.moved) {
        d.moved = true;
        P.onEdit(P.tl, "start", "Move marker");
      }
      let t = timeAt(e.clientX);
      if (P.snapping) t = nearest(snapPoints(P.tl, { playhead: P.clock.time, markers: false }), t, snapThreshold()) ?? t;
      P.onEdit(patchMarker(d.orig as Timeline<I>, d.id, { t }), "live", "Move marker");
    }
  };
  const onRulerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }
    if (d?.kind === "marker") {
      if (d.moved) pRef.current.onEdit(pRef.current.tl, "end", "Move marker");
      else pRef.current.clock.seek(d.orig.markers.find((m) => m.id === d.id)?.t ?? 0);
    }
  };

  // ------------------------------------------------------------ scrollbar
  const barRef = useRef<HTMLDivElement | null>(null);
  const thumbW = Math.max(24, (width / v.pxPerSec / span) * width);
  const thumbX = (v.scroll / span) * width;
  const onBarDown = (e: React.PointerEvent) => {
    const r = barRef.current!.getBoundingClientRect();
    const onThumb = e.clientX - r.left >= thumbX && e.clientX - r.left <= thumbX + thumbW;
    const grab = onThumb ? e.clientX - r.left - thumbX : thumbW / 2;
    const go = (cx: number) => {
      const x = cx - r.left - grab;
      pRef.current.onView({ ...pRef.current.view, scroll: Math.max(0, (x / width) * span) });
    };
    go(e.clientX);
    const mv = (ev: PointerEvent) => go(ev.clientX);
    const up = () => {
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
  };

  // ------------------------------------------------------------ items in view
  const t0 = v.scroll - 40 / v.pxPerSec;
  const t1 = v.scroll + (width + 40) / v.pxPerSec;
  const byTrack = useMemo(() => {
    const m = new Map<string, I[]>();
    for (const i of p.tl.items) {
      if (end(i) < t0 || i.start > t1) continue;
      const arr = m.get(i.track) ?? [];
      arr.push(i);
      m.set(i.track, arr);
    }
    return m;
  }, [p.tl.items, t0, t1]);

  const gapBox = p.gap ? rows.find((r) => r.track.id === p.gap!.track) : null;

  const contextAt = useCallback(
    (e: React.MouseEvent) => {
      const P = pRef.current;
      if (!P.onContext) return;
      e.preventDefault();
      const it = itemOf(e.target) ?? undefined;
      if (it && !P.selection.has(it.id)) P.onSelection(withLinked(P.tl, [it.id]));
      P.onContext(e, { item: it, track: rowAt(e.clientY).track, t: timeAt(e.clientX) });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows],
  );

  return (
    <div ref={rootRef} className="relative flex h-full min-h-0 flex-col select-none" onContextMenu={contextAt}>
      {/* Ruler */}
      <div className="flex shrink-0 border-b border-line bg-surface" style={{ height: RULER_H }}>
        <div className="shrink-0 border-r border-line" style={{ width: HEAD }} />
        <div className="relative flex-1 cursor-text overflow-hidden" onPointerDown={onRulerDown} onPointerMove={onRulerMove} onPointerUp={onRulerUp}>
          <canvas ref={rulerRef} className="absolute left-0 top-0" style={{ height: RULER_H }} />
          {p.tl.markers.map((m) => {
            const x = timeToX(v, m.t);
            if (x < -10 || x > width + 10) return null;
            return (
              <div
                key={m.id}
                data-marker={m.id}
                title={`${m.label || "Marker"} · ${fmt(m.t)} · drag to move, double-click to name, right-click to delete`}
                onDoubleClick={() => p.onMarkerEdit?.(m)}
                className="absolute top-0 z-10 flex h-full cursor-ew-resize flex-col items-center"
                style={{ left: x - 6, width: 12 }}
              >
                <span className="mt-[2px] h-0 w-0 border-x-[6px] border-t-[9px] border-x-transparent" style={{ borderTopColor: m.color ?? "#f5a524" }} />
                {m.label && <span className="pointer-events-none absolute left-3 top-[1px] whitespace-nowrap rounded bg-black/60 px-1 text-[9px] text-white">{m.label}</span>}
              </div>
            );
          })}
        </div>
      </div>

      {/* Tracks */}
      <div ref={bodyRef} className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <div className="relative flex" style={{ minHeight: "100%" }}>
          <div className="sticky left-0 z-20 shrink-0 border-r border-line bg-surface" style={{ width: HEAD }}>
            {rows.map((r) => (
              <div key={r.track.id} className="border-b border-line" style={{ height: r.h }}>
                {p.renderHeader(r.track)}
              </div>
            ))}
            {p.belowHint !== undefined && <div className="h-10" />}
          </div>
          <div
            ref={lanesRef}
            className={`relative flex-1 overflow-hidden ${p.tool === "blade" ? "cursor-crosshair" : hoverEdge ? "cursor-ew-resize" : ""}`}
            onPointerDown={onLaneDown}
            onPointerMove={onLaneMove}
            onPointerUp={onLaneUp}
            onPointerCancel={onLaneUp}
            onDoubleClick={(e) => {
              const it = itemOf(e.target);
              if (it) p.onItemDoubleClick?.(it);
            }}
          >
            {rows.map((r) => (
              <div
                key={r.track.id}
                className={`absolute left-0 right-0 border-b border-line ${r.track.locked ? "bg-[repeating-linear-gradient(135deg,transparent_0_8px,rgba(127,127,127,0.07)_8px_16px)]" : ""}`}
                style={{ top: r.y, height: r.h }}
              >
                {(byTrack.get(r.track.id) ?? []).map((it) => {
                  const xa = timeToX(v, it.start);
                  const xb = timeToX(v, end(it));
                  const ca = Math.max(xa, -20);
                  const cb = Math.min(xb, width + 20);
                  const sel = p.selection.has(it.id);
                  const g: ItemGeom = { w: Math.max(2, cb - ca), h: r.h - 6, t0: xToTime(v, ca), pxPerSec: v.pxPerSec, hasStart: xa >= -20, hasEnd: xb <= width + 20 };
                  return (
                    <div
                      key={it.id}
                      data-item={it.id}
                      className={`absolute top-[3px] overflow-hidden ${p.itemClass(it, sel)} ${it.disabled ? "opacity-40" : ""}`}
                      style={{ left: ca, width: g.w - 1, height: g.h }}
                    >
                      {p.renderItem(it, g, sel)}
                    </div>
                  );
                })}
                {r.track.hidden && <div className="pointer-events-none absolute inset-0 bg-black/30" />}
              </div>
            ))}
            {p.gap && gapBox && (
              <div
                className="pointer-events-none absolute rounded border border-dashed border-accent bg-accent/10"
                style={{ top: gapBox.y + 3, height: gapBox.h - 6, left: timeToX(v, p.gap.start), width: (p.gap.end - p.gap.start) * v.pxPerSec }}
                title="Gap: Delete closes it"
              />
            )}
            {p.ghost &&
              (() => {
                const r = rows.find((x) => x.track.id === p.ghost!.track);
                if (!r) return null;
                return (
                  <div
                    className="pointer-events-none absolute z-10 overflow-hidden rounded-md border-2 border-dashed border-accent bg-accent/20 px-1.5 text-[10px] font-semibold text-ink"
                    style={{ top: r.y + 3, height: r.h - 6, left: timeToX(v, p.ghost.start), width: Math.max(8, p.ghost.duration * v.pxPerSec) }}
                  >
                    {p.ghost.label}
                  </div>
                );
              })()}
            {p.belowHint && (
              <div className="pointer-events-none absolute left-0 right-0 flex h-10 items-center justify-center text-[11px] text-ink-3" style={{ top: rowsH }}>
                {p.belowHint}
              </div>
            )}
            {/* In/out shade */}
            {(p.tl.inPoint !== null || p.tl.outPoint !== null) && (
              <>
                <div className="pointer-events-none absolute inset-y-0 left-0 bg-black/25" style={{ width: Math.max(0, timeToX(v, p.tl.inPoint ?? 0)) }} />
                <div className="pointer-events-none absolute inset-y-0 right-0 bg-black/25" style={{ left: Math.max(0, timeToX(v, p.tl.outPoint ?? length)) }} />
              </>
            )}
            {p.tl.markers.map((m) => {
              const x = timeToX(v, m.t);
              return x < 0 || x > width ? null : <div key={m.id} className="pointer-events-none absolute inset-y-0 w-px opacity-50" style={{ left: x, background: m.color ?? "#f5a524" }} />;
            })}
            {snapAt !== null && <div className="pointer-events-none absolute inset-y-0 z-20 w-px bg-[#ff4fd8]" style={{ left: timeToX(v, snapAt) }} />}
            {box && (
              <div
                className="pointer-events-none absolute z-20 border border-accent bg-accent/10"
                style={{ left: Math.min(box.x0, box.x1), top: Math.min(box.y0, box.y1), width: Math.abs(box.x1 - box.x0), height: Math.abs(box.y1 - box.y0) }}
              />
            )}
            <div style={{ height: rowsH + (p.belowHint !== undefined ? 40 : 0) }} />
          </div>
        </div>
      </div>

      {/* Playhead over ruler and tracks */}
      <div ref={playRef} className="pointer-events-none absolute bottom-[10px] left-0 top-0 z-30 w-px bg-red-500">
        <span className="absolute -left-[5px] top-0 h-0 w-0 border-x-[5.5px] border-t-[8px] border-x-transparent border-t-red-500" />
      </div>

      {/* Horizontal scrollbar */}
      <div className="flex h-[10px] shrink-0">
        <div style={{ width: HEAD }} />
        <div ref={barRef} className="relative flex-1 cursor-pointer bg-surface-2" onPointerDown={onBarDown} title="Scroll the timeline (wheel; Ctrl+wheel zooms)">
          <div className="absolute inset-y-[2px] rounded-full bg-line-3 hover:bg-ink-3" style={{ left: thumbX, width: Math.min(width, thumbW) }} />
        </div>
      </div>

      {tip && (
        <div className="pointer-events-none fixed z-50 rounded bg-black/80 px-1.5 py-0.5 font-mono text-[10px] text-white" style={{ left: tip.x + 12, top: tip.y - 26 }}>
          {tip.text}
        </div>
      )}
    </div>
  );
}

function fmt(t: number): string {
  const s = Math.max(0, t);
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toFixed(2).padStart(5, "0")}`;
}
