/**
 * The video editor's project: a timeline (from the shared engine) whose
 * items are clips, pictures, sounds and annotation objects, plus the output
 * size and frame rate. Also: how a project becomes a render job, and when a
 * plain lossless copy or the old trimmer's export path can do the job.
 */
import type { CropRect } from "../lib/types";
import { type Item, type Timeline, type Track, end, newId, timelineEnd } from "../timeline/model";
import { audible } from "../timeline/ops";
import type { Shape } from "../annotate/shapes";

export type TrackKind = "video" | "overlay" | "audio";

export interface AudioFx {
  /** 1 = 100 %, up to 4. */
  volume: number;
  muted?: boolean;
  fadeIn: number;
  fadeOut: number;
  /** -1 left .. 1 right. */
  pan: number;
  normalize?: boolean;
  /** Low / mid / high gain in dB (-12..12). */
  eq?: [number, number, number];
  /** Noise gate threshold in dBFS (e.g. -45); null = off. */
  gate?: number | null;
}

export const DEFAULT_FX: AudioFx = { volume: 1, fadeIn: 0, fadeOut: 0, pan: 0 };

export interface Picture {
  /** Part of the source to keep (fractions); null = all. */
  crop?: CropRect | null;
  flipH?: boolean;
  flipV?: boolean;
  /** Quarter turns, clockwise. */
  rot90?: 0 | 90 | 180 | 270;
  /** 1 = fits the frame; < 1 picture in picture. */
  scale?: number;
  /** Centre, as fractions of the frame (0.5 = middle). */
  cx?: number;
  cy?: number;
  /** Fill the frame (cut the edges) instead of fitting with bars. */
  fill?: boolean;
}

export interface EdItem extends Item {
  kind: "video" | "image" | "audio" | "shape";
  name: string;
  path?: string;
  width?: number;
  height?: number;
  fps?: number;
  hasAudio?: boolean;
  audio?: AudioFx;
  pic?: Picture;
  shape?: Shape;
  /** Moments marked while recording, seconds into the source. */
  srcMarkers?: number[];
  missing?: boolean;
}

export type EdTimeline = Timeline<EdItem>;

export interface EdProject {
  id: string;
  name: string;
  updated: number;
  /** Output size; "auto" = the first clip's (after its crop and turn). */
  size: { w: number; h: number } | "auto";
  /** Output frame rate; "auto" = the highest clip rate (60 if unknown). */
  fps: number | "auto";
  tl: EdTimeline;
  /** Clip the project was opened from (Open in editor). */
  source?: string | null;
  magnet: boolean;
  snapping: boolean;
  /** Ripple trims on every track. */
  ripple: boolean;
  view?: { pxPerSec: number; scroll: number };
}

export const TRACK_LIMIT = 3; // per kind in the free app; Pro may raise it.

export function track(kind: TrackKind, n: number): Track {
  const name = kind === "video" ? `Video ${n}` : kind === "overlay" ? `Overlay ${n}` : `Audio ${n}`;
  return { id: newId(kind[0]), kind, name, volume: 1, pan: 0 };
}

export function newProject(name = "Untitled"): EdProject {
  return {
    id: newId("p"),
    name,
    updated: Date.now(),
    size: "auto",
    fps: "auto",
    tl: { tracks: [track("overlay", 1), track("video", 1), track("audio", 1)], items: [], markers: [], inPoint: null, outPoint: null },
    magnet: false,
    snapping: true,
    ripple: false,
  };
}

export const kindOf = (tl: EdTimeline, trackId: string): TrackKind | undefined => tl.tracks.find((t) => t.id === trackId)?.kind as TrackKind | undefined;

/** Tracks of one kind in display order (top first). */
export const tracksOf = (tl: EdTimeline, kind: TrackKind) => tl.tracks.filter((t) => t.kind === kind);

/** The main video track: the bottom one (V1). */
export function mainTrack(tl: EdTimeline): string | null {
  const v = tracksOf(tl, "video");
  return v.length ? v[v.length - 1].id : null;
}

/** Which tracks an item may sit on. */
export function accepts(trackKind: TrackKind, item: Pick<EdItem, "kind">): boolean {
  if (item.kind === "audio") return trackKind === "audio";
  if (item.kind === "video") return trackKind === "video";
  if (item.kind === "image") return trackKind === "video";
  return trackKind === "overlay";
}

/** Picture size after crop and quarter turns. */
export function shownSize(it: EdItem): { w: number; h: number } {
  const w0 = it.width || 1920;
  const h0 = it.height || 1080;
  const c = it.pic?.crop;
  let w = c ? w0 * c.w : w0;
  let h = c ? h0 * c.h : h0;
  if (it.pic?.rot90 === 90 || it.pic?.rot90 === 270) [w, h] = [h, w];
  return { w, h };
}

const even = (v: number) => Math.max(16, Math.round(v / 2) * 2);

/** The output size: chosen, or from the first picture on the timeline. */
export function outputSize(p: EdProject): { w: number; h: number } {
  if (p.size !== "auto") return { w: even(p.size.w), h: even(p.size.h) };
  const first = p.tl.items
    .filter((i) => (i.kind === "video" || i.kind === "image") && !i.disabled)
    .sort((a, b) => a.start - b.start || trackIndex(p.tl, b.track) - trackIndex(p.tl, a.track))[0];
  if (!first) return { w: 1920, h: 1080 };
  const s = shownSize(first);
  // Keep huge pictures to 4K.
  const k = Math.min(1, 3840 / Math.max(s.w, s.h));
  return { w: even(s.w * k), h: even(s.h * k) };
}

export function outputFps(p: EdProject): number {
  if (p.fps !== "auto") return p.fps;
  const rates = p.tl.items.filter((i) => i.kind === "video" && i.fps).map((i) => Math.round(i.fps!));
  return rates.length ? Math.min(120, Math.max(...rates)) : 60;
}

export const trackIndex = (tl: EdTimeline, id: string) => tl.tracks.findIndex((t) => t.id === id);

export const projectLength = (p: EdProject) => timelineEnd(p.tl);

/** Effective sound settings of an item on its track (null = silent). */
export function effectiveAudio(tl: EdTimeline, it: EdItem, normGain = 1): AudioFx | null {
  if (it.disabled) return null;
  if (it.kind !== "audio" && !(it.kind === "video" && it.hasAudio)) return null;
  if (!audible(tl, it.track)) return null;
  const fx = { ...DEFAULT_FX, ...it.audio };
  if (fx.muted || fx.volume <= 0) return null;
  const tr = tl.tracks.find((t) => t.id === it.track);
  return {
    ...fx,
    volume: Math.min(4, fx.volume * (tr?.volume ?? 1) * (fx.normalize ? normGain : 1)),
    pan: Math.max(-1, Math.min(1, fx.pan + (tr?.pan ?? 0))),
  };
}

// ------------------------------------------------------------------ export routes

export interface Range {
  start: number;
  end: number;
}

/** The range to export: in/out when set, else everything. */
export function exportRange(p: EdProject): Range {
  const len = projectLength(p);
  const a = p.tl.inPoint ?? 0;
  const b = p.tl.outPoint ?? len;
  return { start: Math.max(0, Math.min(a, b)), end: Math.min(len, Math.max(a, b)) };
}

/** Video items inside a range, cut to it and moved so the range starts at 0. */
export function clipToRange<T extends Item>(items: T[], r: Range): T[] {
  const out: T[] = [];
  for (const i of items) {
    const a = Math.max(i.start, r.start);
    const b = Math.min(end(i), r.end);
    if (b - a < 0.01) continue;
    out.push({ ...i, start: a - r.start, srcIn: i.srcIn + (a - i.start), duration: b - a });
  }
  return out;
}

const plainAudio = (it: EdItem) => {
  const a = { ...DEFAULT_FX, ...it.audio };
  return !a.muted && a.volume === 1 && !a.fadeIn && !a.fadeOut && !a.pan && !a.normalize && !a.gate && !(a.eq && a.eq.some((x) => x !== 0));
};

const plainPicture = (it: EdItem) => {
  const q = it.pic ?? {};
  return !q.flipH && !q.flipV && !q.rot90 && (q.scale ?? 1) === 1 && (q.cx ?? 0.5) === 0.5 && (q.cy ?? 0.5) === 0.5 && !q.fill;
};

export type Route =
  /** One plain piece of one file: stream copy (lossless, instant). */
  | { kind: "copy"; path: string; start: number; end: number }
  /** Pieces of clips back to back with one crop: the proven trimmer export. */
  | { kind: "segments"; segments: { path: string; start: number; end: number }[]; crop: CropRect | null }
  /** Anything else: the full timeline render. */
  | { kind: "render" };

/**
 * Picks the fastest way to export that gives the same result. Only the main
 * picture track may hold anything, with no gaps, overlays, extra sound or
 * picture changes; the size must be Auto.
 */
export function exportRoute(p: EdProject): Route {
  const r = exportRange(p);
  const tl = p.tl;
  const live = clipToRange(
    tl.items.filter((i) => !i.disabled),
    r,
  ).sort((a, b) => a.start - b.start);
  if (!live.length || p.size !== "auto") return { kind: "render" };
  const vid = live.filter((i) => i.kind === "video");
  if (vid.length !== live.length) return { kind: "render" };
  if (new Set(vid.map((v) => v.track)).size !== 1) return { kind: "render" };
  const tr = tl.tracks.find((t) => t.id === vid[0].track);
  if (!tr || tr.hidden || (tr.volume ?? 1) !== 1 || (tr.pan ?? 0) !== 0 || !audible(tl, tr.id)) return { kind: "render" };
  if (p.fps !== "auto") return { kind: "render" };
  let t = 0;
  for (const v of vid) {
    if (Math.abs(v.start - t) > 0.02) return { kind: "render" }; // a gap (black)
    if (!v.path || !plainPicture(v) || (v.hasAudio && !plainAudio(v))) return { kind: "render" };
    t = end(v);
  }
  const crops = vid.map((v) => JSON.stringify(v.pic?.crop ?? null));
  if (new Set(crops).size !== 1) return { kind: "render" };
  const crop = vid[0].pic?.crop ?? null;
  // Different sizes would be joined at the first one's size: render instead.
  if (new Set(vid.map((v) => `${v.width}x${v.height}`)).size !== 1) return { kind: "render" };
  if (vid.length === 1 && !crop) return { kind: "copy", path: vid[0].path!, start: vid[0].srcIn, end: vid[0].srcIn + vid[0].duration };
  return { kind: "segments", segments: vid.map((v) => ({ path: v.path!, start: v.srcIn, end: v.srcIn + v.duration })), crop };
}

// ------------------------------------------------------------------ render job

export interface RenderVideo {
  path?: string;
  png?: string;
  start: number;
  duration: number;
  srcIn: number;
  z: number;
  crop?: CropRect | null;
  flipH?: boolean;
  flipV?: boolean;
  rot90?: number;
  scale?: number;
  cx?: number;
  cy?: number;
  fill?: boolean;
}

export interface RenderOverlay {
  png: string;
  start: number;
  duration: number;
  x: number;
  y: number;
  opacity: number;
}

export interface RenderRegion {
  kind: "pixelate" | "blur";
  start: number;
  duration: number;
  x: number;
  y: number;
  w: number;
  h: number;
  strength: number;
}

export interface RenderAudio {
  path: string;
  start: number;
  duration: number;
  srcIn: number;
  volume: number;
  fadeIn: number;
  fadeOut: number;
  pan: number;
  eq: [number, number, number];
  gate: number | null;
}

export interface RenderJob {
  width: number;
  height: number;
  fps: number;
  video: RenderVideo[];
  overlays: RenderOverlay[];
  regions: RenderRegion[];
  audio: RenderAudio[];
  targetMb: number | null;
}

/** Sound pieces of a timeline (all, or some items), ready for the mixer. */
export function audioJob(p: EdProject, items: EdItem[], norm: (it: EdItem) => number, r: Range | null): RenderAudio[] {
  const out: RenderAudio[] = [];
  const list = r ? clipToRange(items, r) : items;
  for (const it of list) {
    const fx = effectiveAudio(p.tl, it, norm(it));
    if (!fx || !it.path) continue;
    // Fades belong to the whole item: shorten them when the range cut it.
    const orig = items.find((x) => x.id === it.id)!;
    const cutHead = it.srcIn - orig.srcIn;
    const cutTail = orig.srcIn + orig.duration - (it.srcIn + it.duration);
    out.push({
      path: it.path,
      start: it.start,
      duration: it.duration,
      srcIn: it.srcIn,
      volume: fx.volume,
      fadeIn: Math.max(0, fx.fadeIn - cutHead),
      fadeOut: Math.max(0, fx.fadeOut - cutTail),
      pan: fx.pan,
      eq: fx.eq ?? [0, 0, 0],
      gate: fx.gate ?? null,
    });
  }
  return out;
}

/**
 * Builds the render job. `still` makes a PNG of a picture item fitted to the
 * output, `raster` a PNG of an annotation (with its top-left corner).
 */
export async function renderJob(
  p: EdProject,
  opts: {
    range: Range;
    targetMb: number | null;
    norm: (it: EdItem) => number;
    still: (it: EdItem, w: number, h: number) => Promise<string>;
    raster: (s: Shape) => { png: string; x: number; y: number } | null;
  },
): Promise<RenderJob> {
  const { w, h } = outputSize(p);
  const tl = p.tl;
  const r = opts.range;
  const items = clipToRange(
    tl.items.filter((i) => !i.disabled),
    r,
  );
  const video: RenderVideo[] = [];
  const vTracks = tracksOf(tl, "video");
  for (const it of items) {
    if (it.kind !== "video" && it.kind !== "image") continue;
    const tr = vTracks.find((t) => t.id === it.track);
    if (!tr || tr.hidden) continue;
    // Bottom track first: z grows upwards.
    const z = vTracks.length - 1 - vTracks.indexOf(tr);
    const q = it.pic ?? {};
    const base = { start: it.start, duration: it.duration, srcIn: it.srcIn, z, scale: q.scale ?? 1, cx: q.cx ?? 0.5, cy: q.cy ?? 0.5 };
    if (it.kind === "video") {
      video.push({ ...base, path: it.path, crop: q.crop ?? null, flipH: !!q.flipH, flipV: !!q.flipV, rot90: q.rot90 ?? 0, fill: !!q.fill });
    } else {
      video.push({ ...base, srcIn: 0, png: await opts.still(it, w, h) });
    }
  }
  const overlays: RenderOverlay[] = [];
  const regions: RenderRegion[] = [];
  const oTracks = tracksOf(tl, "overlay");
  // Back to front: the bottom overlay track first, earlier items first.
  const shapes = items
    .filter((i) => i.kind === "shape" && i.shape && !oTracks.find((t) => t.id === i.track)?.hidden)
    .sort((a, b) => oTracks.findIndex((t) => t.id === b.track) - oTracks.findIndex((t) => t.id === a.track));
  for (const it of shapes) {
    const s = it.shape!;
    if (s.hidden) continue;
    if (s.kind === "blur" || s.kind === "pixelate") {
      regions.push({
        kind: s.kind,
        start: it.start,
        duration: it.duration,
        x: s.x / w,
        y: s.y / h,
        w: s.w / w,
        h: s.h / h,
        strength: s.strength ?? (s.kind === "blur" ? 12 : 16),
      });
      continue;
    }
    const png = opts.raster(s);
    if (!png) continue;
    overlays.push({ png: png.png, start: it.start, duration: it.duration, x: png.x / w, y: png.y / h, opacity: 1 });
  }
  const audio = audioJob(p, tl.items.filter((i) => !i.disabled), opts.norm, r);
  return { width: w, height: h, fps: outputFps(p), video, overlays, regions, audio, targetMb: opts.targetMb };
}

/** A short file-name stem for exports. */
export function exportStem(p: EdProject): string {
  const src = p.source?.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "");
  const base = src || (p.name !== "Untitled" ? p.name : "Lastshot_Edit");
  return base.replace(/[<>:"/\\|?*]+/g, "_").slice(0, 80);
}
