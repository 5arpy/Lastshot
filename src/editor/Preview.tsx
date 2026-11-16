import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import AnnotationLayer from "../annotate/AnnotationLayer";
import type { ImageCache } from "../annotate/draw";
import type { Shape, Style, Tool } from "../annotate/shapes";
import { CROP_ASPECTS, type CropAspect, resizeCrop } from "../lib/edit";
import type { CropRect } from "../lib/types";
import { end } from "../timeline/model";
import type { EditPhase } from "../timeline/TimelineView";
import { cn } from "../utils/cn";
import { drawFrame, picturesAt, placedBox, placement, shapesAt } from "./compose";
import type { Player } from "./player";
import { type EdItem, type EdProject, type Picture, outputSize } from "./project";
import { urlOf } from "./store";

/**
 * The picture: what export makes at the playhead, drawn on a canvas, with
 * the annotation layer on top (draw, select, move, resize, turn, type) and
 * handles to move and size a selected clip or picture (picture in picture).
 * Crop mode shows the whole source with a crop box to drag.
 */

export type SafeZone = "off" | "title" | "vertical";

export interface PreviewProps {
  p: EdProject;
  player: Player;
  images: ImageCache;
  imgVer: number;
  selection: Set<string>;
  onSelect: (ids: Set<string>) => void;
  tool: Tool;
  style: Style;
  onShapes: (changed: Shape[], commit: boolean, label: string) => void;
  onCreateShape: (s: Shape) => void;
  onDeleteItems: (ids: string[]) => void;
  editing: string | null;
  setEditing: (id: string | null) => void;
  onPic: (id: string, patch: Partial<Picture>, phase: EditPhase, label: string) => void;
  crop: { id: string; aspect: CropAspect } | null;
  setCrop: (c: { id: string; aspect: CropAspect } | null) => void;
  /** Preview resolution: 1 full, 0.5 half, 0.25 quarter. */
  quality: number;
  safe: SafeZone;
  onFocus: () => void;
  onToolDone: () => void;
  penTarget: string | null;
  empty: React.ReactNode;
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export default function Preview(P: PreviewProps) {
  const { p, player } = P;
  const boxRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [area, setArea] = useState({ w: 640, h: 360 });
  const { w: W, h: H } = outputSize(p);
  const pad = 12;
  const scale = Math.max(0.01, Math.min((area.w - pad * 2) / W, (area.h - pad * 2) / H));
  const dw = W * scale;
  const dh = H * scale;
  const ox = (area.w - dw) / 2;
  const oy = (area.h - dh) / 2;

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setArea({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ---------------------------------------------------------------- drawing
  const latest = useRef(P);
  latest.current = P;
  const raf = useRef(0);
  const draw = useCallback(() => {
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      const c = canvasRef.current;
      const L = latest.current;
      if (!c) return;
      const { w, h } = outputSize(L.p);
      const s = Math.min((c.parentElement?.clientWidth ?? w) / w, 4);
      const dpr = window.devicePixelRatio || 1;
      const k = Math.max(0.05, Math.min(1, (s * dpr) * L.quality));
      const cw = Math.max(2, Math.round(w * k));
      const ch = Math.max(2, Math.round(h * k));
      if (c.width !== cw) c.width = cw;
      if (c.height !== ch) c.height = ch;
      const g = c.getContext("2d");
      if (!g) return;
      drawFrame(g, L.p, L.player.time, w, h, k, { video: (it) => L.player.videoOf(it), image: L.images.get, urlOf }, L.editing);
    });
  }, []);

  useEffect(() => {
    player.onFrame = draw;
    return () => {
      if (player.onFrame === draw) player.onFrame = null;
    };
  }, [player, draw]);
  useEffect(draw, [draw, p, P.imgVer, P.quality, P.editing, dw, dh]);

  // Which annotation objects are on screen (changes as the playhead moves).
  const [visKey, setVisKey] = useState("");
  useEffect(() => {
    const upd = () => {
      const k = shapesAt(latest.current.p, player.time)
        .map((x) => x.item.id)
        .join(",");
      setVisKey((o) => (o === k ? o : k));
    };
    upd();
    return player.subscribe(upd);
  }, [player, p]);
  const visible = useMemo(() => {
    const ids = new Set(visKey ? visKey.split(",") : []);
    // Keep the object being typed into or selected on screen.
    return p.tl.items.filter((i) => i.kind === "shape" && i.shape && (ids.has(i.id) || i.id === P.editing)).map((i) => i.shape!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visKey, p.tl.items, P.editing]);
  // Annotation objects in drawing order.
  const ordered = useMemo(() => {
    const order = shapesAt(p, player.time).map((x) => x.item.id);
    return [...visible].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);
  const nextStep = useMemo(() => {
    let n = 0;
    for (const i of p.tl.items) if (i.shape?.kind === "step") n = Math.max(n, i.shape.n ?? 0);
    return n + 1;
  }, [p.tl.items]);
  const selectedShapes = [...P.selection].filter((id) => visible.some((s) => s.id === id));

  // ---------------------------------------------------- picture handles
  const selPic: EdItem | null = useMemo(() => {
    if (P.selection.size !== 1) return null;
    const it = p.tl.items.find((i) => P.selection.has(i.id));
    if (!it || (it.kind !== "video" && it.kind !== "image")) return null;
    return it;
  }, [p.tl.items, P.selection]);
  const [, setT] = useState(0);
  useEffect(() => player.subscribe(() => setT((x) => (selPic ? x + 1 : x))), [player, selPic]);
  const picShown = selPic && player.time >= selPic.start - 1e-6 && player.time < end(selPic);
  const picBox = (it: EdItem) => placedBox(placement(it, it.width || 1920, it.height || 1080, W, H));

  const toOut = (e: { clientX: number; clientY: number }) => {
    const r = boxRef.current!.getBoundingClientRect();
    return [(e.clientX - r.left - ox) / scale, (e.clientY - r.top - oy) / scale] as const;
  };

  const dragPic = (it: EdItem, e: { clientX: number; clientY: number; ctrlKey: boolean }, mode: "move" | "scale") => {
    const q0 = it.pic ?? {};
    const [x0, y0] = toOut(e);
    const cx0 = (q0.cx ?? 0.5) * W;
    const cy0 = (q0.cy ?? 0.5) * H;
    const d0 = Math.max(4, Math.hypot(x0 - cx0, y0 - cy0));
    const s0 = q0.scale ?? 1;
    let started = false;
    const mv = (ev: PointerEvent) => {
      const [x, y] = toOut(ev);
      if (!started) {
        if (Math.hypot(x - x0, y - y0) * scale < 3) return;
        started = true;
        P.onPic(it.id, {}, "start", mode === "move" ? "Move picture" : "Size picture");
      }
      if (mode === "move") {
        let cx = (cx0 + (x - x0)) / W;
        let cy = (cy0 + (y - y0)) / H;
        if (!ev.ctrlKey) {
          const lim = 8 / scale;
          if (Math.abs(cx * W - W / 2) < lim) cx = 0.5;
          if (Math.abs(cy * H - H / 2) < lim) cy = 0.5;
        }
        P.onPic(it.id, { cx: Math.round(cx * 10000) / 10000, cy: Math.round(cy * 10000) / 10000 }, "live", "Move picture");
      } else {
        let s = clamp((s0 * Math.hypot(x - cx0, y - cy0)) / d0, 0.05, 8);
        if (!ev.ctrlKey && Math.abs(s - 1) < 0.03) s = 1;
        P.onPic(it.id, { scale: Math.round(s * 1000) / 1000 }, "live", "Size picture");
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
      if (started) P.onPic(it.id, {}, "end", mode === "move" ? "Move picture" : "Size picture");
    };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
  };

  /** A click on the picture where there is no annotation: select / move the clip there. */
  const onEmptyPointer = (e: React.PointerEvent): boolean => {
    if (P.tool !== "select") return false;
    const [x, y] = toOut(e);
    const pics = picturesAt(p, player.time).filter((i) => !p.tl.tracks.find((t) => t.id === i.track)?.locked);
    for (let k = pics.length - 1; k >= 0; k--) {
      const it = pics[k];
      const b = picBox(it);
      if (x < b.x || y < b.y || x > b.x + b.w || y > b.y + b.h) continue;
      if (P.selection.has(it.id)) dragPic(it, e, "move");
      else P.onSelect(new Set([it.id]));
      return true;
    }
    return false;
  };

  // ---------------------------------------------------------------- crop
  const cropItem = P.crop ? p.tl.items.find((i) => i.id === P.crop!.id) ?? null : null;

  return (
    <div
      ref={boxRef}
      className="relative h-full w-full overflow-hidden bg-[#0b0c10]"
      onPointerDownCapture={P.onFocus}
      onWheel={(e) => {
        // Wheel over the picture scrubs a frame at a time when paused.
        if (e.ctrlKey || player.playing) return;
        player.seek(player.time + (e.deltaY > 0 ? 1 : -1) / 30);
      }}
    >
      <canvas
        ref={canvasRef}
        className="absolute bg-black shadow-[0_0_0_1px_rgba(255,255,255,0.06)]"
        style={{ left: ox, top: oy, width: dw, height: dh, imageRendering: P.quality < 1 ? "auto" : undefined }}
      />
      {!p.tl.items.length && <div className="absolute inset-0 grid place-items-center">{P.empty}</div>}
      {!cropItem && (
        <AnnotationLayer
          className="absolute inset-0"
          shapes={ordered}
          content={{ w: W, h: H }}
          view={{ scale, ox, oy }}
          tool={P.tool}
          style={P.style}
          selected={selectedShapes}
          onSelect={(ids) => P.onSelect(new Set(ids))}
          onChange={P.onShapes}
          onCreate={P.onCreateShape}
          onDelete={P.onDeleteItems}
          editing={P.editing}
          setEditing={P.setEditing}
          nextStep={nextStep}
          penTarget={P.penTarget}
          onEmptyPointer={onEmptyPointer}
          onToolDone={P.onToolDone}
        />
      )}
      {!cropItem && selPic && picShown && P.tool === "select" && <PicHandles box={picBox(selPic)} scale={scale} ox={ox} oy={oy} onScale={(e) => dragPic(selPic, e, "scale")} />}
      {P.safe !== "off" && !cropItem && <SafeZones kind={P.safe} x={ox} y={oy} w={dw} h={dh} />}
      {cropItem && (
        <CropOverlay
          key={cropItem.id}
          it={cropItem}
          area={area}
          aspect={P.crop!.aspect}
          setAspect={(a) => P.setCrop({ id: cropItem.id, aspect: a })}
          source={() => (cropItem.kind === "video" ? player.videoOf(cropItem) : cropItem.path ? P.images.get(urlOf(cropItem.path)) : null)}
          onCrop={(c, phase) => P.onPic(cropItem.id, { crop: c }, phase, "Crop")}
          onDone={() => P.setCrop(null)}
          player={player}
        />
      )}
    </div>
  );
}

function PicHandles({ box, scale, ox, oy, onScale }: { box: { x: number; y: number; w: number; h: number }; scale: number; ox: number; oy: number; onScale: (e: React.PointerEvent) => void }) {
  const x = ox + box.x * scale;
  const y = oy + box.y * scale;
  const w = box.w * scale;
  const h = box.h * scale;
  const corners: [number, number, string][] = [
    [x, y, "nwse-resize"],
    [x + w, y, "nesw-resize"],
    [x, y + h, "nesw-resize"],
    [x + w, y + h, "nwse-resize"],
  ];
  return (
    <>
      <div className="pointer-events-none absolute border border-dashed border-sky-400" style={{ left: x, top: y, width: w, height: h }} />
      {corners.map(([cx, cy, cur], k) => (
        <span
          key={k}
          title="Drag to size (Ctrl: no snapping). Move: drag the picture."
          className="absolute z-[3] h-3 w-3 rounded-sm border border-sky-500 bg-white"
          style={{ left: cx - 6, top: cy - 6, cursor: cur }}
          onPointerDown={(e) => {
            e.stopPropagation();
            e.preventDefault();
            onScale(e);
          }}
        />
      ))}
    </>
  );
}

function SafeZones({ kind, x, y, w, h }: { kind: SafeZone; x: number; y: number; w: number; h: number }) {
  return (
    <svg className="pointer-events-none absolute" style={{ left: x, top: y }} width={w} height={h}>
      {kind === "title" ? (
        <>
          <rect x={w * 0.05} y={h * 0.05} width={w * 0.9} height={h * 0.9} fill="none" stroke="rgba(255,255,255,0.45)" strokeDasharray="6 4" />
          <rect x={w * 0.1} y={h * 0.1} width={w * 0.8} height={h * 0.8} fill="none" stroke="rgba(255,214,102,0.6)" strokeDasharray="6 4" />
          <line x1={w / 2 - 10} x2={w / 2 + 10} y1={h / 2} y2={h / 2} stroke="rgba(255,255,255,0.5)" />
          <line y1={h / 2 - 10} y2={h / 2 + 10} x1={w / 2} x2={w / 2} stroke="rgba(255,255,255,0.5)" />
        </>
      ) : (
        <>
          {/* Shorts / TikTok / Reels: the app covers the top, the bottom and the right side. */}
          <rect x={0} y={0} width={w} height={h * 0.12} fill="rgba(255,77,79,0.18)" />
          <rect x={0} y={h * 0.72} width={w} height={h * 0.28} fill="rgba(255,77,79,0.18)" />
          <rect x={w * 0.84} y={h * 0.12} width={w * 0.16} height={h * 0.6} fill="rgba(255,77,79,0.18)" />
          <text x={6} y={14} fill="rgba(255,255,255,0.7)" fontSize={10}>
            Covered by app buttons on vertical video apps
          </text>
        </>
      )}
    </svg>
  );
}

/** The crop box over the whole source picture. */
function CropOverlay({
  it,
  area,
  aspect,
  setAspect,
  source,
  onCrop,
  onDone,
  player,
}: {
  it: EdItem;
  area: { w: number; h: number };
  aspect: CropAspect;
  setAspect: (a: CropAspect) => void;
  source: () => CanvasImageSource | null;
  onCrop: (c: CropRect | null, phase: EditPhase) => void;
  onDone: () => void;
  player: Player;
}) {
  const nw = it.width || 1920;
  const nh = it.height || 1080;
  const top = 44;
  const s = Math.min((area.w - 32) / nw, (area.h - top - 16) / nh);
  const dw = nw * s;
  const dh = nh * s;
  const ox = (area.w - dw) / 2;
  const oy = top + (area.h - top - dh) / 2;
  const r = it.pic?.crop ?? { x: 0, y: 0, w: 1, h: 1 };
  const c = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const paint = () => {
      const cv = c.current;
      const src = source();
      if (!cv || !src) return;
      cv.width = Math.round(dw);
      cv.height = Math.round(dh);
      cv.getContext("2d")!.drawImage(src, 0, 0, cv.width, cv.height);
    };
    paint();
    return player.subscribe(paint);
  }, [dw, dh, source, player]);

  const ratio = (a: CropAspect) => {
    const x = CROP_ASPECTS.find((q) => q.id === a);
    return x && x.w ? x.w / x.h : null;
  };
  /** The biggest box of an aspect, centred where the box is now. */
  const fitAspect = (a: CropAspect, size = 1): CropRect => {
    const want = ratio(a);
    if (!want) return r;
    const src = nw / nh;
    const w = (want < src ? want / src : 1) * size;
    const h = (want < src ? 1 : src / want) * size;
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    return { x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h), w, h };
  };
  const sizeOf = () => {
    const want = ratio(aspect);
    if (!want) return 1;
    const src = nw / nh;
    return r.w / (want < src ? want / src : 1);
  };

  const drag = (e: React.PointerEvent, edge: string | null) => {
    e.stopPropagation();
    e.preventDefault();
    const x0 = e.clientX;
    const y0 = e.clientY;
    const r0 = r;
    const fixed = ratio(aspect);
    onCrop(r0, "start");
    const mv = (ev: PointerEvent) => {
      const dx = (ev.clientX - x0) / dw;
      const dy = (ev.clientY - y0) / dh;
      let next: CropRect;
      if (!edge) {
        next = { ...r0, x: clamp(r0.x + dx, 0, 1 - r0.w), y: clamp(r0.y + dy, 0, 1 - r0.h) };
      } else if (fixed) {
        // Fixed shape: corners size the box around its centre.
        const sx = edge.includes("e") ? dx : edge.includes("w") ? -dx : 0;
        const sy = edge.includes("s") ? dy : edge.includes("n") ? -dy : 0;
        const grow = Math.max(sx * nw, sy * nh) * 2;
        const k = clamp((r0.w * nw + grow) / (r0.w * nw), 0.05, 10);
        let w = r0.w * k;
        let h = r0.h * k;
        const lim = Math.min(1 / w, 1 / h, 1);
        if (lim < 1) ((w *= lim), (h *= lim));
        const cx = r0.x + r0.w / 2;
        const cy = r0.y + r0.h / 2;
        next = { x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h), w, h };
      } else {
        next = resizeCrop(r0, edge, dx, dy);
      }
      onCrop(next, "live");
    };
    const up = () => {
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
      onCrop(latestR.current, "end");
    };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
  };
  const latestR = useRef<CropRect | null>(r);
  latestR.current = it.pic?.crop ?? null;

  const bx = ox + r.x * dw;
  const by = oy + r.y * dh;
  const bw = r.w * dw;
  const bh = r.h * dh;
  const handles = ["nw", "n", "ne", "e", "se", "s", "sw", "w"].filter((h) => !ratio(aspect) || h.length === 2);
  const hp = (h: string): [number, number] => [bx + (h.includes("w") ? 0 : h.includes("e") ? bw : bw / 2), by + (h.includes("n") ? 0 : h.includes("s") ? bh : bh / 2)];
  const pxW = Math.round(r.w * nw);
  const pxH = Math.round(r.h * nh);

  return (
    <div
      className="absolute inset-0 z-[5] bg-[#0b0c10]"
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === "Escape") onDone();
      }}
    >
      <div className="absolute inset-x-0 top-0 flex h-10 flex-wrap items-center justify-center gap-1.5 border-b border-line bg-surface/90 px-2 text-[11.5px]">
        <span className="mr-1 font-semibold text-ink-2">Crop</span>
        {CROP_ASPECTS.map((a) => (
          <button
            key={a.id}
            type="button"
            title={a.hint}
            onClick={() => {
              setAspect(a.id);
              if (a.w) onCrop(fitAspect(a.id), "once");
            }}
            className={cn("rounded-md border px-2 py-0.5", aspect === a.id ? "border-accent bg-accent/15 text-accent-fg" : "border-line text-ink-2 hover:text-ink")}
          >
            {a.id === "free" ? "Free" : a.id}
          </button>
        ))}
        {ratio(aspect) && (
          <input
            type="range"
            min={20}
            max={100}
            value={Math.round(sizeOf() * 100)}
            title="Size of the box"
            onChange={(e) => onCrop(fitAspect(aspect, Number(e.target.value) / 100), "once")}
            className="w-24 accent-[var(--color-accent)]"
          />
        )}
        <span className="font-mono text-[10.5px] text-ink-4">
          {pxW}×{pxH}
        </span>
        <button type="button" onClick={() => onCrop(null, "once")} className="rounded-md px-2 py-0.5 text-ink-3 hover:text-ink">
          Reset
        </button>
        <button type="button" onClick={onDone} className="rounded-md bg-accent px-2.5 py-0.5 font-semibold text-white hover:bg-accent-hover" title="Done (Enter)">
          Done
        </button>
      </div>
      <canvas ref={c} className="absolute" style={{ left: ox, top: oy, width: dw, height: dh }} />
      <svg className="pointer-events-none absolute inset-0" width={area.w} height={area.h}>
        <path d={`M${ox},${oy}h${dw}v${dh}h${-dw}z M${bx},${by}v${bh}h${bw}v${-bh}z`} fill="rgba(0,0,0,0.6)" fillRule="evenodd" />
        <rect x={bx} y={by} width={bw} height={bh} fill="none" stroke="#fff" strokeWidth={1.5} />
        {[1, 2].map((k) => (
          <g key={k} stroke="rgba(255,255,255,0.35)">
            <line x1={bx + (bw * k) / 3} x2={bx + (bw * k) / 3} y1={by} y2={by + bh} />
            <line y1={by + (bh * k) / 3} y2={by + (bh * k) / 3} x1={bx} x2={bx + bw} />
          </g>
        ))}
      </svg>
      <div className="absolute cursor-move" style={{ left: bx, top: by, width: bw, height: bh }} onPointerDown={(e) => drag(e, null)} onDoubleClick={onDone} />
      {handles.map((h) => {
        const [x, y] = hp(h);
        return (
          <span
            key={h}
            className="absolute z-[2] h-3 w-3 rounded-sm border border-black/40 bg-white"
            style={{ left: x - 6, top: y - 6, cursor: h === "n" || h === "s" ? "ns-resize" : h === "e" || h === "w" ? "ew-resize" : h === "nw" || h === "se" ? "nwse-resize" : "nesw-resize" }}
            onPointerDown={(e) => drag(e, h)}
          />
        );
      })}
    </div>
  );
}
