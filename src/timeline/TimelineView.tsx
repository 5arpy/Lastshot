import { type ReactNode, type Ref, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { EPS, type Item, type Marker, type Timeline, type Track, end, newId, timelineEnd, withLinked } from "./model";
import { type EditOpts, type Move, type PlaceMode, itemsInBox, moveItems, patchMarker, place, rollEdit, slipItem, splitAt, trimItem } from "./ops";
import { nearest, snapPoints, snapSpan } from "./snap";
import { type TlView, autoScrollSpeed, edgeNear, edgePx, endRoom, rulerLabel, tickStep, timeToX, viewOfSpan, xToTime, zoomAt } from "./view";

/**
 * Timeline engine: the view. Generic over the item type, so the audio editor
 * can reuse it with its own item drawing. It owns pointer interaction (move,
 * trim, marquee, blade, scrub, markers, zoom, scroll, snapping) and reports
 * edits; the host owns the state, the history and the keys.
 *
 * Performance: only items in view are rendered (and cut to the view, so a
 * 30-minute clip at frame zoom is still one small element); the playhead and
 * time follow the clock without re-rendering.
 *
 * Navigation: an overview strip on top (drag = scroll, box edges or a
 * vertical / Ctrl drag = zoom), the ruler (drag = scrub, Ctrl+drag = zoom),
 * wheel = scroll, Ctrl / Alt / Z + wheel = zoom at the pointer, Shift+wheel =
 * tracks up and down, Ctrl+Shift+wheel = track height, middle drag = pan,
 * and the view scrolls by itself when a drag reaches its edge.
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
  /** A drag (move, trim, scrub, box...) is in progress. */
  dragging: () => boolean;
}

/** Where a right-click landed. */
export interface ContextHit<I> {
  item?: I;
  track: Track | null;
  t: number;
  area: "lanes" | "ruler" | "header";
}

export interface TimelineViewProps<I extends Item> {
  tl: Timeline<I>;
  clock: Clock;
  selection: Set<string>;
  onSelection: (ids: Set<string>) => void;
  view: TlView;
  onView: (v: TlView) => void;
  snapping: boolean;
  /** Edge auto-scroll while dragging: speed factor (1 normal, 0 off). */
  edgeScroll?: number;
  /** select; blade cuts on click; slip drags what a clip shows (Y). */
  tool: "select" | "blade" | "slip";
  /** Ripple trims (and Ctrl while trimming). */
  ripple: boolean;
  editOpts: () => EditOpts;
  onEdit: (next: Timeline<I>, phase: EditPhase, label: string) => void;
  accepts: (track: Track, item: I) => boolean;
  trackHeight: (track: Track) => number;
  renderItem: (item: I, g: ItemGeom, selected: boolean) => ReactNode;
  itemClass: (item: I, selected: boolean) => string;
  renderHeader: (track: Track) => ReactNode;
  onContext?: (e: React.MouseEvent, hit: ContextHit<I>) => void;
  /** A copy of `it` under a new id (Alt+drag); default: the item with the id swapped. */
  cloneItem?: (it: I, id: string) => I;
  /** A track's row height changed (border drag, Ctrl+Shift+wheel). */
  onTrackHeight?: (track: Track, h: number) => void;
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

const SNAP_PX = 9;
const RULER_H = 26;
const OVERVIEW_H = 14;
/** Drags this close to the lanes' side scroll the view. */
const AUTO_PX = 28;
const MIN_TRACK_H = 24;
const MAX_TRACK_H = 160;

/** What a pointer move needs (a real event, or the last one again while auto-scrolling). */
interface Ptr {
  clientX: number;
  clientY: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
}

type Drag =
  | {
      kind: "move";
      x0: number;
      y0: number;
      t0: number;
      orig: Timeline<Item>;
      ids: string[];
      anchor: Item;
      moved: boolean;
      trackIdx0: number;
      /** Alt at the start: copies move, the originals stay. */
      dup: Map<string, string> | null;
    }
  | { kind: "trim"; orig: Timeline<Item>; id: string; edge: "left" | "right"; moved: boolean; roll: boolean }
  | { kind: "slip"; orig: Timeline<Item>; id: string; t0: number; moved: boolean }
  | { kind: "marquee"; x0: number; y0: number; add: boolean; before: Set<string>; moved: boolean; t: number; track: Track | null }
  | { kind: "scrub" }
  | { kind: "marker"; id: string; orig: Timeline<Item>; moved: boolean }
  | { kind: "pan"; x: number; y: number; scroll: number; top: number }
  | { kind: "rzoom"; x0: number; y0: number; view: TlView; anchor: number };

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
  // Everything the view can show: the edit plus room after it.
  const span = Math.max(endRoom(length), v.scroll + width / v.pxPerSec);

  // ------------------------------------------------------------ geometry
  const laneX = (clientX: number) => clientX - (lanesRef.current?.getBoundingClientRect().left ?? 0);
  const timeAt = (clientX: number) => Math.max(0, xToTime(pRef.current.view, laneX(clientX)));
  const rulerEl = useRef<HTMLDivElement | null>(null);
  /** The point is on the ruler (by position: the playhead's grab strip lies over it). */
  const inRuler = (clientX: number, clientY: number) => {
    const r = rulerEl.current?.getBoundingClientRect();
    return !!r && clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
  };
  /** The marker at that point of the ruler (within its 12 px flag), if any. */
  const markerAt = (clientX: number, clientY: number) => {
    if (!inRuler(clientX, clientY)) return null;
    const P = pRef.current;
    const t = timeAt(clientX);
    let best: Marker | null = null;
    for (const m of P.tl.markers) if (Math.abs(m.t - t) * P.view.pxPerSec <= 7 && (!best || Math.abs(m.t - t) < Math.abs(best.t - t))) best = m;
    return best;
  };
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
      dragging: () => !!drag.current,
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
      el.dataset.t = String(t); // the exact time, for tests and tools (the timecode shows frames)
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
    const i0 = Math.floor(v.scroll / minor);
    const t1 = v.scroll + width / v.pxPerSec;
    g.strokeStyle = line;
    g.fillStyle = ink;
    g.font = "10px ui-monospace, Consolas, monospace";
    g.textBaseline = "top";
    g.beginPath();
    // By index, not t += minor: adding 0.2 five times gives 10.9999999,
    // which drew "0:10" under the 11 s tick (every label a second behind).
    for (let i = i0, t = i0 * minor; t <= t1 + minor; i++, t = i * minor) {
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
  // Z held (like a zoom tool): the wheel zooms.
  const zHeld = useRef(false);
  useEffect(() => {
    const typing = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.("input,textarea,select,[contenteditable=true]");
    const down = (e: KeyboardEvent) => {
      if ((e.key === "z" || e.key === "Z") && !e.ctrlKey && !e.metaKey && !e.altKey && !typing(e.target)) zHeld.current = true;
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "z" || e.key === "Z") zHeld.current = false;
    };
    const blur = () => (zHeld.current = false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const P = pRef.current;
      const overHeaders = e.clientX - el.getBoundingClientRect().left < HEAD;
      if (e.ctrlKey && e.shiftKey) {
        // Taller / shorter track under the pointer.
        const { track } = rowAt(e.clientY);
        if (!track || !P.onTrackHeight) return;
        e.preventDefault();
        const h = P.trackHeight(track);
        P.onTrackHeight(track, Math.round(Math.min(MAX_TRACK_H, Math.max(MIN_TRACK_H, h * Math.exp(-e.deltaY * 0.002)))));
        return;
      }
      if (e.ctrlKey || e.altKey || zHeld.current) {
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
  }, [HEAD, rows]);

  // ------------------------------------------------------------ snapping
  const snapThreshold = () => SNAP_PX / pRef.current.view.pxPerSec;
  const points = (exclude: Set<string>) => snapPoints(pRef.current.tl, { playhead: pRef.current.clock.time, exclude });

  // ------------------------------------------------------------ pointer: lanes
  const itemOf = (target: EventTarget | null): I | null => {
    const el = (target as HTMLElement | null)?.closest?.("[data-item]") as HTMLElement | null;
    if (!el) return null;
    return pRef.current.tl.items.find((i) => i.id === el.dataset.item) ?? null;
  };

  /** The trim handle under the pointer: an edge of a clip on that row, inside or just outside it. */
  const edgeAt = (clientX: number, clientY: number): { item: I; edge: "left" | "right"; t: number } | null => {
    const P = pRef.current;
    const { track } = rowAt(clientY);
    if (!track || track.locked) return null;
    const tol = edgePx(P.view.pxPerSec) / P.view.pxPerSec;
    return edgeNear(P.tl.items.filter((i) => i.track === track.id), xToTime(P.view, laneX(clientX)), tol);
  };

  // ------------------------------------------------------------ auto-scroll at the sides while dragging
  const lastPtr = useRef<Ptr | null>(null);
  const autoRaf = useRef(0);
  // When the pointer entered the edge zone and the last step's time (the
  // loop restarts on every pointer move; these keep the timing continuous).
  const autoT = useRef<{ since: number; last: number } | null>(null);
  const autoScroll = () => {
    cancelAnimationFrame(autoRaf.current);
    const step = (now: number) => {
      const P = pRef.current;
      const ptr = lastPtr.current;
      const d = drag.current;
      const lanes = lanesRef.current;
      const stop = () => void (autoT.current = null);
      if (!ptr || !d || !lanes || (d.kind !== "move" && d.kind !== "trim" && d.kind !== "marquee" && d.kind !== "scrub")) return stop();
      const r = lanes.getBoundingClientRect();
      const x = ptr.clientX - r.left;
      const push = x < AUTO_PX ? x - AUTO_PX : x > r.width - AUTO_PX ? x - (r.width - AUTO_PX) : 0;
      const k = P.edgeScroll ?? 1;
      if (!push || !k || (push < 0 && P.view.scroll <= 0)) return stop();
      // Speed by elapsed time (same at any refresh rate), capped; a stalled
      // frame never jumps more than 50 ms worth.
      const a = autoT.current ?? (autoT.current = { since: now, last: now });
      const dt = Math.min(0.05, Math.max(0, (now - a.last) / 1000));
      a.last = now;
      const px = autoScrollSpeed(push, AUTO_PX, r.width, (now - a.since) / 1000) * dt * k;
      if (px) P.onView({ ...P.view, scroll: Math.max(0, P.view.scroll + px / P.view.pxPerSec) });
      requestAnimationFrame(() => {
        if (d.kind === "scrub") P.clock.seek(timeAt(ptr.clientX));
        else laneMove(ptr);
      });
      autoRaf.current = requestAnimationFrame(step);
    };
    autoRaf.current = requestAnimationFrame(step);
  };
  useEffect(() => () => cancelAnimationFrame(autoRaf.current), []);

  const onLaneDown = (e: React.PointerEvent) => {
    if (e.button === 1) return startPan(e);
    if (e.button !== 0) return;
    const P = pRef.current;
    const hitEdge = P.tool === "select" ? edgeAt(e.clientX, e.clientY) : null;
    const it = hitEdge?.item ?? itemOf(e.target);
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
      const edge = locked ? null : hitEdge?.item.id === it.id ? hitEdge.edge : null;
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
      if (P.tool === "slip" && !edge) {
        drag.current = { kind: "slip", orig: P.tl as Timeline<Item>, id: it.id, t0: t, moved: false };
      } else if (edge) {
        // Alt on a cut between two clips rolls it (one longer, one shorter).
        drag.current = { kind: "trim", orig: P.tl as Timeline<Item>, id: it.id, edge, moved: false, roll: e.altKey };
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
          dup: e.altKey ? new Map() : null,
        };
      }
    } else {
      drag.current = { kind: "marquee", x0: e.clientX, y0: e.clientY, add: e.ctrlKey || e.shiftKey, before: new Set(P.selection), moved: false, t, track };
    }
    lastPtr.current = e;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onLaneMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) {
      setHoverEdge(pRef.current.tool === "select" && !!edgeAt(e.clientX, e.clientY));
      return;
    }
    if (d.kind === "pan") return panMove(e);
    lastPtr.current = { clientX: e.clientX, clientY: e.clientY, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, target: e.target };
    laneMove(lastPtr.current);
    autoScroll();
  };

  const laneMove = (e: Ptr) => {
    const P = pRef.current;
    const d = drag.current;
    if (!d) return;
    if (d.kind === "move") {
      if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 4) return;
      if (!d.moved) {
        d.moved = true;
        P.onEdit(P.tl, "start", "Move");
      }
      const orig = d.orig as Timeline<I>;
      const items = d.ids.map((id) => orig.items.find((i) => i.id === id)!).filter(Boolean);
      // Shift: keep the time, change only the track.
      let dt = e.shiftKey ? 0 : timeAt(e.clientX) - d.t0;
      const minStart = Math.min(...items.map((i) => i.start));
      dt = Math.max(dt, -minStart);
      let at: number | null = null;
      if (P.snapping && !e.shiftKey) {
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
      let next: Timeline<I>;
      if (d.dup) {
        // Copies (new ids, their own links) go where the drag is; the originals stay.
        const links = new Map<string, string>();
        const copies = items.map((i, k) => {
          if (!d.dup!.has(i.id)) d.dup!.set(i.id, newId());
          const link = i.link ? (links.get(i.link) ?? (links.set(i.link, newId("l")), links.get(i.link))) : undefined;
          const id = d.dup!.get(i.id)!;
          const copy = P.cloneItem ? P.cloneItem(i as I, id) : ({ ...i, id } as I);
          return { ...copy, start: moves[k].start, track: moves[k].track, link } as I;
        });
        next = place(orig, copies, mode, P.editOpts());
      } else next = moveItems(orig, moves, mode, P.editOpts());
      P.onEdit(next, "live", d.dup ? "Duplicate" : "Move");
      const tr = dIdx ? target(d.anchor as I) : null;
      const sign = dt >= 0 ? "+" : "−";
      setTip({
        x: e.clientX,
        y: e.clientY,
        text: `${fmt(minStart + dt)} (${sign}${fmt(Math.abs(dt))})${tr ? ` · ${tr.name}` : ""}${mode === "insert" ? " · Insert" : ""}${d.dup ? " · Copy" : ""}`,
      });
    } else if (d.kind === "trim") {
      if (!d.moved) {
        d.moved = true;
        P.onEdit(P.tl, "start", "Trim");
      }
      let t = timeAt(e.clientX);
      let at: number | null = null;
      // Shift: no snapping while trimming.
      if (P.snapping && !e.shiftKey) {
        const n = nearest(points(withLinked(d.orig, [d.id])), t, snapThreshold());
        if (n !== null) {
          t = n;
          at = n;
        }
      }
      setSnapAt(at);
      const rolled = d.roll ? rollEdit(d.orig as Timeline<I>, d.id, d.edge, t) : null;
      const roll = !!rolled && rolled !== d.orig;
      const next = roll ? rolled! : trimItem(d.orig as Timeline<I>, d.id, d.edge, t, { ripple: P.ripple || e.ctrlKey, ...P.editOpts() });
      const it = next.items.find((i) => i.id === d.id);
      P.onEdit(next, "live", "Trim");
      const was = d.orig.items.find((i) => i.id === d.id);
      const dd = it && was ? it.duration - was.duration : 0;
      if (it)
        setTip({
          x: e.clientX,
          y: e.clientY,
          text: roll
            ? `Roll · cut at ${fmt(d.edge === "right" ? end(it) : it.start)}`
            : `${fmt(it.duration)} long (${dd >= 0 ? "+" : "−"}${fmt(Math.abs(dd))})${P.ripple || e.ctrlKey ? " · Ripple" : ""}`,
        });
    } else if (d.kind === "slip") {
      if (!d.moved) {
        d.moved = true;
        P.onEdit(P.tl, "start", "Slip");
      }
      // Dragging right shows earlier source (the picture moves with the mouse).
      const next = slipItem(d.orig as Timeline<I>, d.id, d.t0 - timeAt(e.clientX));
      const it = next.items.find((i) => i.id === d.id);
      P.onEdit(next, "live", "Slip");
      if (it) setTip({ x: e.clientX, y: e.clientY, text: `Slip · shows ${fmt(it.srcIn)} to ${fmt(it.srcIn + it.duration)}` });
    } else if (d.kind === "marquee") {
      if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 4) return;
      d.moved = true;
      const lr = lanesRef.current!.getBoundingClientRect();
      // The start stays at its time while the view scrolls under the drag.
      setBox({ x0: timeToX(P.view, d.t), y0: d.y0 - lr.top, x1: e.clientX - lr.left, y1: e.clientY - lr.top });
      const ya = Math.min(d.y0, e.clientY);
      const yb = Math.max(d.y0, e.clientY);
      const body = bodyRef.current!;
      const top = body.getBoundingClientRect().top - body.scrollTop;
      const tracks = new Set(rows.filter((r) => top + r.y + r.h > ya && top + r.y < yb).map((r) => r.track.id));
      const ids = itemsInBox(P.tl, tracks, d.t, timeAt(e.clientX));
      P.onSelection(new Set(d.add ? [...d.before, ...ids] : ids));
    }
  };

  const onLaneUp = (e: React.PointerEvent) => {
    const P = pRef.current;
    const d = drag.current;
    drag.current = null;
    cancelAnimationFrame(autoRaf.current);
    lastPtr.current = null;
    setSnapAt(null);
    setBox(null);
    setTip(null);
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }
    if (!d) return;
    if (d.kind === "move" || d.kind === "trim" || d.kind === "slip") {
      if (d.moved) P.onEdit(P.tl, "end", d.kind === "move" ? (d.dup ? "Duplicate" : "Move") : d.kind === "slip" ? "Slip" : "Trim");
      if (d.kind === "move" && d.moved && d.dup?.size) P.onSelection(new Set(d.dup.values()));
    } else if (d.kind === "marquee" && !d.moved) {
      // A click on empty track: playhead there, and the gap (if any) selected.
      if (!d.add) P.onSelection(new Set());
      P.clock.seek(scrubTime(e.clientX, e.shiftKey));
      if (d.track) P.onGap?.({ track: d.track.id, t: d.t });
    }
  };

  // ------------------------------------------------------------ ruler: scrub and markers
  /** Scrub target: snaps to cuts, markers and in/out when snapping is on (Shift: free). */
  const scrubTime = (clientX: number, shift: boolean) => {
    const P = pRef.current;
    const t = timeAt(clientX);
    // Cuts, markers, in / out, but not the playhead itself (it would stick).
    return P.snapping && !shift ? nearest(snapPoints(P.tl), t, snapThreshold()) ?? t : t;
  };
  const onRulerDown = (e: React.PointerEvent) => {
    if (e.button === 1) return startPan(e);
    if (e.button !== 0) return;
    const P = pRef.current;
    const mk = (e.target as HTMLElement).closest?.("[data-marker]") as HTMLElement | null;
    if (mk) {
      drag.current = { kind: "marker", id: mk.dataset.marker!, orig: P.tl as Timeline<Item>, moved: false };
    } else if (e.ctrlKey) {
      // Ctrl+drag: zoom around where the drag started (right or down = closer).
      drag.current = { kind: "rzoom", x0: e.clientX, y0: e.clientY, view: P.view, anchor: laneX(e.clientX) };
    } else {
      drag.current = { kind: "scrub" };
      P.clock.seek(scrubTime(e.clientX, e.shiftKey));
    }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onRulerMove = (e: React.PointerEvent) => {
    const P = pRef.current;
    const d = drag.current;
    if (!d) return;
    if (d.kind === "pan") return panMove(e);
    if (d.kind === "rzoom") {
      P.onView(zoomAt(d.view, Math.exp((e.clientX - d.x0 + e.clientY - d.y0) * 0.008), d.anchor));
    } else if (d.kind === "scrub") {
      lastPtr.current = { clientX: e.clientX, clientY: e.clientY, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, target: e.target };
      P.clock.seek(scrubTime(e.clientX, e.shiftKey));
      autoScroll();
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
    cancelAnimationFrame(autoRaf.current);
    lastPtr.current = null;
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

  // ------------------------------------------------------------ middle-button pan
  const startPan = (e: React.PointerEvent) => {
    e.preventDefault();
    drag.current = { kind: "pan", x: e.clientX, y: e.clientY, scroll: pRef.current.view.scroll, top: bodyRef.current?.scrollTop ?? 0 };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const panMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (d?.kind !== "pan") return;
    const P = pRef.current;
    P.onView({ ...P.view, scroll: Math.max(0, d.scroll - (e.clientX - d.x) / P.view.pxPerSec) });
    if (bodyRef.current) bodyRef.current.scrollTop = d.top - (e.clientY - d.y);
  };

  // ------------------------------------------------------------ overview strip
  const overRef = useRef<HTMLCanvasElement | null>(null);
  const boxW = Math.max(6, (width / v.pxPerSec / span) * width);
  const boxX = (v.scroll / span) * width;
  useEffect(() => {
    const c = overRef.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(width * dpr);
    c.height = Math.round(OVERVIEW_H * dpr);
    c.style.width = `${width}px`;
    const g = c.getContext("2d")!;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, width, OVERVIEW_H);
    const css = getComputedStyle(c);
    const n = Math.max(1, p.tl.tracks.length);
    const lane = (OVERVIEW_H - 4) / n;
    p.tl.tracks.forEach((tr, k) => {
      g.fillStyle = css.getPropertyValue("--color-ink-4").trim() || "#6b7080";
      for (const it of p.tl.items) {
        if (it.track !== tr.id) continue;
        const a = (it.start / span) * width;
        g.fillRect(a, 2 + k * lane, Math.max(1, (it.duration / span) * width), Math.max(1, lane - 0.5));
      }
    });
    g.fillStyle = "rgba(245,165,36,0.9)";
    for (const m of p.tl.markers) g.fillRect((m.t / span) * width, 0, 1, OVERVIEW_H);
  }, [p.tl.items, p.tl.tracks, p.tl.markers, span, width]);
  const onOverDown = (e: React.PointerEvent) => {
    if (e.button === 1) return startPan(e);
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    const P0 = pRef.current;
    const v0 = P0.view;
    const span0 = span;
    const x = e.clientX - r.left;
    const bx = (v0.scroll / span0) * width;
    const bw = Math.max(6, (width / v0.pxPerSec / span0) * width);
    const toT = (px: number) => (px / width) * span0;
    const shown = width / v0.pxPerSec;
    const mode = Math.abs(x - bx) <= 5 ? "left" : Math.abs(x - (bx + bw)) <= 5 ? "right" : "pan";
    // Outside the box: jump there first (centred), then drag.
    const start = mode === "pan" && (x < bx || x > bx + bw) ? Math.max(0, toT(x) - shown / 2) : v0.scroll;
    if (start !== v0.scroll) P0.onView({ ...v0, scroll: start });
    const mv = (ev: PointerEvent) => {
      const P = pRef.current;
      const dx = ev.clientX - e.clientX;
      const dy = ev.clientY - e.clientY;
      if (mode === "left") P.onView(viewOfSpan(toT(Math.min(bx + dx, bx + bw - 6)), v0.scroll + shown, width));
      else if (mode === "right") P.onView(viewOfSpan(v0.scroll, toT(Math.max(bx + bw + dx, bx + 6)), width));
      else if (ev.ctrlKey || Math.abs(dy) > 6) {
        // Ableton style: down = closer, sideways = scroll, around the grabbed time.
        const base = { pxPerSec: v0.pxPerSec, scroll: start + toT(dx) };
        const anchor = timeToX(base, toT(x));
        P.onView(zoomAt(base, Math.exp(dy * 0.012), Math.max(0, Math.min(width, anchor))));
      } else P.onView({ ...P.view, scroll: Math.max(0, start + toT(dx)) });
    };
    const up = () => {
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
  };

  // ------------------------------------------------------------ playhead grab
  // A clip edge (or the blade) under the line wins: trimming a fresh cut still works.
  const onHeadDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (pRef.current.tool !== "select" || edgeAt(e.clientX, e.clientY)) return onLaneDown(e);
    drag.current = { kind: "scrub" };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onHeadMove = (e: React.PointerEvent) => (drag.current?.kind === "scrub" ? onRulerMove(e) : onLaneMove(e));
  const onHeadUp = (e: React.PointerEvent) => (drag.current?.kind === "scrub" ? onRulerUp(e) : onLaneUp(e));

  // ------------------------------------------------------------ track height (header border)
  const onBorderDown = (e: React.PointerEvent, track: Track) => {
    if (e.button !== 0 || !p.onTrackHeight) return;
    e.preventDefault();
    e.stopPropagation();
    const y0 = e.clientY;
    const h0 = p.trackHeight(track);
    const mv = (ev: PointerEvent) => pRef.current.onTrackHeight?.(track, Math.round(Math.min(MAX_TRACK_H, Math.max(MIN_TRACK_H, h0 + ev.clientY - y0))));
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
      const el = e.target as HTMLElement;
      const area = el.closest?.("[data-ruler]") || inRuler(e.clientX, e.clientY) ? "ruler" : e.clientX - (rootRef.current?.getBoundingClientRect().left ?? 0) < HEAD ? "header" : "lanes";
      const it = area === "lanes" ? (itemOf(e.target) ?? undefined) : undefined;
      if (it && !P.selection.has(it.id)) P.onSelection(withLinked(P.tl, [it.id]));
      P.onContext(e, { item: it, track: area === "ruler" ? null : rowAt(e.clientY).track, t: timeAt(e.clientX), area });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows],
  );

  return (
    <div
      ref={rootRef}
      className="relative flex h-full min-h-0 flex-col select-none"
      onContextMenu={contextAt}
      // Double-click a marker: name it. Found by position, because the click
      // lands on the ruler (pointer capture) or on the playhead's grab strip
      // (a new marker sits right under the playhead).
      onDoubleClick={(e) => {
        const m = markerAt(e.clientX, e.clientY);
        if (m) p.onMarkerEdit?.(m);
      }}
    >
      {/* Overview: the whole edit, the shown part as a box */}
      <div className="flex shrink-0 border-b border-line bg-surface-2" style={{ height: OVERVIEW_H }}>
        <div className="shrink-0 border-r border-line" style={{ width: HEAD }} />
        <div
          className="relative flex-1 cursor-grab overflow-hidden active:cursor-grabbing"
          onPointerDown={onOverDown}
          title="Overview: drag to scroll; drag the box edges, drag up or down, or Ctrl+drag to zoom"
        >
          <canvas ref={overRef} className="pointer-events-none absolute left-0 top-0" style={{ height: OVERVIEW_H }} />
          <div className="absolute inset-y-0 rounded-sm border border-accent/80 bg-accent/15" style={{ left: boxX, width: Math.min(width, boxW) }}>
            <span className="absolute inset-y-0 -left-[3px] w-[6px] cursor-ew-resize" />
            <span className="absolute inset-y-0 -right-[3px] w-[6px] cursor-ew-resize" />
          </div>
        </div>
      </div>
      {/* Ruler */}
      <div className="flex shrink-0 border-b border-line bg-surface" style={{ height: RULER_H }}>
        <div className="shrink-0 border-r border-line" style={{ width: HEAD }} />
        <div
          ref={rulerEl}
          data-ruler
          className="relative flex-1 cursor-text overflow-hidden"
          onPointerDown={onRulerDown}
          onPointerMove={onRulerMove}
          onPointerUp={onRulerUp}
          title="Drag to move the playhead (snaps to cuts; Shift: free) · Ctrl+drag to zoom · right-click for in, out and markers"
        >
          <canvas ref={rulerRef} className="absolute left-0 top-0" style={{ height: RULER_H }} />
          {p.tl.markers.map((m) => {
            const x = timeToX(v, m.t);
            if (x < -10 || x > width + 10) return null;
            return (
              <div
                key={m.id}
                data-marker={m.id}
                title={`${m.label || "Marker"} · ${fmt(m.t)} · drag to move, double-click to name, right-click to delete`}
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
              <div key={r.track.id} className="relative border-b border-line" style={{ height: r.h }}>
                {p.renderHeader(r.track)}
                {p.onTrackHeight && (
                  <div
                    className="absolute inset-x-0 -bottom-[3px] z-10 h-[6px] cursor-row-resize"
                    title="Drag to make the track taller or shorter (Ctrl+Shift+wheel too)"
                    onPointerDown={(e) => onBorderDown(e, r.track)}
                  />
                )}
              </div>
            ))}
            {p.belowHint !== undefined && <div className="h-10" />}
          </div>
          <div
            ref={lanesRef}
            data-lanes
            // The shown view, for tests and tools (zoom in px per second, scroll in seconds).
            data-pps={v.pxPerSec}
            data-scroll={v.scroll}
            className={`relative flex-1 overflow-hidden ${p.tool === "blade" ? "cursor-crosshair" : p.tool === "slip" ? "cursor-col-resize" : hoverEdge ? "cursor-ew-resize" : ""}`}
            onPointerDown={onLaneDown}
            onPointerMove={onLaneMove}
            onPointerUp={onLaneUp}
            onPointerCancel={onLaneUp}
            onDoubleClick={(e) => {
              // On a clip edge: the playhead goes to that cut. On a clip: its settings.
              const edge = edgeAt(e.clientX, e.clientY);
              if (edge) return p.clock.seek(edge.t);
              // The target is the lanes (pointer capture), so look under the pointer.
              const it = itemOf(document.elementFromPoint(e.clientX, e.clientY));
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
      <div ref={playRef} data-playhead className="pointer-events-none absolute bottom-0 left-0 z-30 w-px bg-red-500" style={{ top: OVERVIEW_H }}>
        <span className="absolute -left-[5px] top-0 h-0 w-0 border-x-[5.5px] border-t-[8px] border-x-transparent border-t-red-500" />
        {/* Grab the line anywhere along its height to scrub. */}
        <span
          className="pointer-events-auto absolute inset-y-0 -left-[3px] w-[7px] cursor-ew-resize"
          title="Drag the playhead (snaps to cuts; Shift: free)"
          onPointerDown={onHeadDown}
          onPointerMove={onHeadMove}
          onPointerUp={onHeadUp}
        />
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
