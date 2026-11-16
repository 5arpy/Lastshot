import { memo, useEffect, useRef, useSyncExternalStore } from "react";
import type { ItemGeom } from "../timeline/TimelineView";
import type { Track } from "../timeline/model";
import { cn } from "../utils/cn";
import { media } from "./media";
import { DEFAULT_FX, type AudioFx, type EdItem } from "./project";
import { Ico, I } from "./ui";

/**
 * What a timeline bar shows: filmstrip pictures, the waveform, the volume
 * line (drag it) and fade handles in the top corners (drag them), plus the
 * name. Only the visible part of a bar is drawn.
 */

export type FxEdit = (it: EdItem, patch: Partial<AudioFx>, phase: "start" | "live" | "end") => void;

const useMediaVersion = () => useSyncExternalStore((l) => media.subscribe(l), () => media.version);

function Waveform({ it, g, height, vol }: { it: EdItem; g: ItemGeom; height: number; vol: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const ver = useMediaVersion();
  useEffect(() => {
    const c = ref.current;
    if (!c || !it.path) return;
    const peaks = media.peaksOf(it.path);
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(g.w));
    c.width = Math.round(w * dpr);
    c.height = Math.round(height * dpr);
    const x = c.getContext("2d")!;
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, w, height);
    if (!peaks) return;
    x.fillStyle = "rgba(255,255,255,0.55)";
    const mid = height / 2;
    const src0 = it.srcIn + (g.t0 - it.start);
    const secPerPx = 1 / g.pxPerSec;
    for (let px = 0; px < w; px++) {
      const a = Math.floor((src0 + px * secPerPx) * peaks.rate);
      const b = Math.max(a + 1, Math.floor((src0 + (px + 1) * secPerPx) * peaks.rate));
      let m = 0;
      for (let k = Math.max(0, a); k < Math.min(peaks.data.length, b); k++) m = Math.max(m, peaks.data[k]);
      const amp = Math.min(1, (m / 255) * vol) * mid;
      if (amp > 0.3) x.fillRect(px, mid - amp, 1, amp * 2);
    }
  }, [it.path, it.srcIn, it.start, g.t0, g.w, g.pxPerSec, height, vol, ver]);
  return <canvas ref={ref} className="pointer-events-none absolute left-0" style={{ width: g.w, height, bottom: 0 }} />;
}

function Filmstrip({ it, g, height }: { it: EdItem; g: ItemGeom; height: number }) {
  useMediaVersion();
  if (!it.path || height < 18) return null;
  const tw = Math.round((height * (it.width || 16)) / (it.height || 9));
  const n = Math.min(40, Math.ceil(g.w / tw) + 1);
  // Cache-friendly step: a power of two in seconds.
  const raw = tw / g.pxPerSec;
  const step = Math.pow(2, Math.round(Math.log2(Math.max(0.25, raw))));
  const firstSlot = Math.floor((g.t0 - it.start) * g.pxPerSec / tw);
  const pics = [];
  for (let k = 0; k < n; k++) {
    const slot = firstSlot + k;
    const x = slot * tw - (g.t0 - it.start) * g.pxPerSec;
    if (x > g.w) break;
    const srcT = Math.min((it.srcDuration ?? 1e9) - 0.05, it.srcIn + (slot * tw) / g.pxPerSec);
    const url = media.thumb(it.path, Math.max(0, srcT), step, 72);
    pics.push(url ? <img key={slot} src={url} alt="" draggable={false} className="absolute top-0 object-cover" style={{ left: x, width: tw, height }} /> : null);
  }
  return <div className="pointer-events-none absolute inset-x-0 top-0 overflow-hidden opacity-80" style={{ height }}>{pics}</div>;
}

function FadeAndVolume({ it, g, fx, onFx, top, height }: { it: EdItem; g: ItemGeom; fx: AudioFx; onFx: FxEdit; top: number; height: number }) {
  const startX = (it.start - g.t0) * g.pxPerSec;
  const endX = startX + it.duration * g.pxPerSec;
  const fi = fx.fadeIn * g.pxPerSec;
  const fo = fx.fadeOut * g.pxPerSec;
  // Volume line: 0 % at the bottom, 100 % at 2/3 up, 200 % at the top.
  const volY = top + height * (1 - Math.min(1, fx.volume / 1.5));
  const dragFade = (side: "in" | "out") => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const x0 = e.clientX;
    const v0 = side === "in" ? fx.fadeIn : fx.fadeOut;
    onFx(it, {}, "start");
    const mv = (ev: PointerEvent) => {
      const d = ((ev.clientX - x0) / g.pxPerSec) * (side === "in" ? 1 : -1);
      const v = Math.max(0, Math.min(it.duration / 2, v0 + d));
      onFx(it, side === "in" ? { fadeIn: Math.round(v * 100) / 100 } : { fadeOut: Math.round(v * 100) / 100 }, "live");
    };
    const up = () => {
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
      onFx(it, {}, "end");
    };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
  };
  const dragVol = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const y0 = e.clientY;
    const v0 = fx.volume;
    onFx(it, {}, "start");
    const mv = (ev: PointerEvent) => {
      const v = Math.max(0, Math.min(1.5, v0 - ((ev.clientY - y0) / height) * 1.5));
      onFx(it, { volume: Math.round(v * 100) / 100 }, "live");
    };
    const up = () => {
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
      onFx(it, {}, "end");
    };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
  };
  const pct = Math.round(fx.volume * 100);
  return (
    <>
      <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width={g.w} height={top + height}>
        {fi > 0 && <path d={`M${startX},${top + height} L${startX + fi},${top} L${startX},${top} Z`} fill="rgba(0,0,0,0.35)" />}
        {fo > 0 && <path d={`M${endX},${top + height} L${endX - fo},${top} L${endX},${top} Z`} fill="rgba(0,0,0,0.35)" />}
        <polyline
          points={`${startX},${top + height} ${startX + fi},${volY} ${endX - fo},${volY} ${endX},${top + height}`}
          fill="none"
          stroke={fx.muted ? "rgba(255,255,255,0.3)" : "#ffd666"}
          strokeWidth={1.2}
        />
      </svg>
      <div
        className="absolute left-0 right-0 z-[1] h-[7px] cursor-ns-resize"
        style={{ top: volY - 3 }}
        title={`Volume ${pct} % (drag up or down)`}
        onPointerDown={dragVol}
      />
      {g.hasStart && (
        <span
          className="absolute z-[2] h-2.5 w-2.5 cursor-ew-resize rounded-full border border-black/50 bg-white/90 hover:scale-125"
          style={{ left: startX + fi - 5, top: top - 1 }}
          title={`Fade in ${fx.fadeIn.toFixed(2)} s (drag)`}
          onPointerDown={dragFade("in")}
        />
      )}
      {g.hasEnd && (
        <span
          className="absolute z-[2] h-2.5 w-2.5 cursor-ew-resize rounded-full border border-black/50 bg-white/90 hover:scale-125"
          style={{ left: endX - fo - 5, top: top - 1 }}
          title={`Fade out ${fx.fadeOut.toFixed(2)} s (drag)`}
          onPointerDown={dragFade("out")}
        />
      )}
    </>
  );
}

const SHAPE_LABEL: Record<string, string> = {
  rect: "Rectangle",
  ellipse: "Ellipse",
  arrow: "Arrow",
  line: "Line",
  pen: "Drawing",
  highlight: "Highlight",
  step: "Step",
  image: "Picture",
  blur: "Blur",
  pixelate: "Pixelate",
  redact: "Black box",
};

export const ItemContent = memo(function ItemContent({ it, g, selected, onFx }: { it: EdItem; g: ItemGeom; selected: boolean; onFx: FxEdit }) {
  const fx = { ...DEFAULT_FX, ...it.audio };
  const sound = it.kind === "audio" || (it.kind === "video" && it.hasAudio);
  const label =
    it.kind === "shape" ? (it.shape?.kind === "text" ? `T  ${it.shape.text || "Text"}` : SHAPE_LABEL[it.shape?.kind ?? ""] ?? it.name) : it.name;
  const nameLeft = Math.max(0, (it.start - g.t0) * g.pxPerSec) + 4;
  if (it.kind === "shape") {
    return (
      <div className="flex h-full items-center truncate px-1.5 text-[10.5px] font-semibold" style={{ paddingLeft: nameLeft }}>
        {label}
      </div>
    );
  }
  const film = it.kind === "video" || it.kind === "image";
  const filmH = sound ? Math.round(g.h * 0.58) : g.h;
  const waveH = sound ? (it.kind === "audio" ? g.h - 12 : g.h - filmH) : 0;
  return (
    <>
      {it.kind === "video" && <Filmstrip it={it} g={g} height={filmH} />}
      {it.kind === "image" && it.path && <div className="pointer-events-none absolute inset-0 opacity-60" style={{ backgroundImage: `url("${encodeURI(it.path.startsWith("data:") ? it.path : "")}")` }} />}
      {sound && <Waveform it={it} g={g} height={waveH} vol={fx.muted ? 0.15 : fx.volume} />}
      {sound && g.w > 24 && <FadeAndVolume it={it} g={g} fx={fx} onFx={onFx} top={it.kind === "audio" ? 12 : filmH} height={waveH} />}
      <div
        className={cn("pointer-events-none absolute top-0 flex max-w-full items-center gap-1 truncate rounded-br px-1 text-[10.5px] font-semibold leading-[14px]", film && "bg-black/45 text-white")}
        style={{ left: nameLeft - 4 }}
      >
        {it.missing && <span className="text-danger">Missing ·</span>}
        {it.kind === "audio" && <Ico d={I.music} className="h-3 w-3" />}
        {sound && fx.muted && <Ico d={I.mute} className="h-3 w-3" />}
        {it.disabled && <span>Off ·</span>}
        <span className="truncate">{label}</span>
        {selected && sound && !fx.muted && fx.volume !== 1 && <span className="font-mono opacity-80">{Math.round(fx.volume * 100)}%</span>}
      </div>
      {(it.srcMarkers ?? []).map((m, k) => {
        const x = (it.start + (m - it.srcIn) - g.t0) * g.pxPerSec;
        if (x < 0 || x > g.w || m < it.srcIn || m > it.srcIn + it.duration) return null;
        return <span key={k} className="pointer-events-none absolute bottom-0 top-0 w-px bg-sky-300/80" style={{ left: x }} title="Marked while recording" />;
      })}
    </>
  );
});

export function itemTone(it: EdItem, selected: boolean): string {
  const base =
    it.kind === "video"
      ? "bg-sky-700/70 border-sky-400/60 text-white"
      : it.kind === "image"
        ? "bg-violet-700/60 border-violet-400/60 text-white"
        : it.kind === "audio"
          ? "bg-emerald-800/70 border-emerald-400/60 text-emerald-50"
          : "bg-amber-600/60 border-amber-300/60 text-amber-50";
  return cn("rounded-md border", base, selected && "ring-2 ring-white shadow-[0_0_0_1px_rgba(0,0,0,0.5)]", it.missing && "border-red-500");
}

export function TrackHeader({
  track,
  onPatch,
  onMenu,
  canHide,
  sound,
}: {
  track: Track;
  onPatch: (p: Partial<Track>, label: string) => void;
  onMenu: (e: React.MouseEvent) => void;
  canHide: boolean;
  sound: boolean;
}) {
  const btn = (on: boolean, title: string, d: string, run: () => void, txt?: string) => (
    <button
      type="button"
      title={title}
      onClick={run}
      className={cn("grid h-5 min-w-5 place-items-center rounded px-0.5 text-[10px] font-bold", on ? "bg-accent/25 text-accent-fg" : "text-ink-4 hover:bg-surface-4 hover:text-ink")}
    >
      {txt ?? <Ico d={d} className="h-3.5 w-3.5" />}
    </button>
  );
  return (
    <div className="flex h-full flex-col justify-center gap-0.5 px-2" onContextMenu={onMenu}>
      <div className="flex items-center gap-1">
        <span className={cn("min-w-0 flex-1 truncate text-[11px] font-semibold", track.kind === "video" ? "text-sky-300" : track.kind === "audio" ? "text-emerald-300" : "text-amber-300")} title={track.name}>
          {track.name}
        </span>
        {canHide && btn(!!track.hidden, track.hidden ? "Show this track" : "Hide this track", track.hidden ? I.eyeOff : I.eye, () => onPatch({ hidden: !track.hidden }, track.hidden ? "Show track" : "Hide track"))}
        {sound && btn(!!track.muted, track.muted ? "Unmute" : "Mute", I.mute, () => onPatch({ muted: !track.muted }, "Mute track"), "M")}
        {sound && btn(!!track.solo, track.solo ? "Unsolo" : "Solo (hear only this)", I.speaker, () => onPatch({ solo: !track.solo }, "Solo track"), "S")}
        {btn(!!track.locked, track.locked ? "Unlock" : "Lock (no edits)", track.locked ? I.lock : I.unlock, () => onPatch({ locked: !track.locked }, track.locked ? "Unlock track" : "Lock track"))}
        <button type="button" title="Track menu" onClick={onMenu} className="grid h-5 w-4 place-items-center rounded text-ink-4 hover:bg-surface-4 hover:text-ink">
          <Ico d={I.more} className="h-3.5 w-3.5" />
        </button>
      </div>
      {sound && (
        <input
          type="range"
          min={0}
          max={200}
          value={Math.round((track.volume ?? 1) * 100)}
          title={`Track volume ${Math.round((track.volume ?? 1) * 100)} % (double-click: 100 %)`}
          onChange={(e) => onPatch({ volume: Number(e.target.value) / 100 }, "Track volume")}
          onDoubleClick={() => onPatch({ volume: 1 }, "Track volume")}
          className="h-3 w-full accent-[var(--color-accent)]"
        />
      )}
    </div>
  );
}
