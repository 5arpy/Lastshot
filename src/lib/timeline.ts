/**
 * Editor timeline model: a main track (clips and pictures, back to back),
 * an overlay track (pictures and text on top) and an audio track (music,
 * voice). Pure functions, so they are easy to test.
 */

export type MainItem = {
  id: string;
  kind: "video" | "image";
  path: string;
  name: string;
  /** Where in the file it starts (video). */
  srcIn: number;
  duration: number;
  /** Length of the whole file (video); images can be any length. */
  srcDuration: number;
  width: number;
  height: number;
  hasAudio: boolean;
  volume: number;
  muted: boolean;
};

export type OverlayItem = {
  id: string;
  kind: "image" | "text";
  path?: string;
  name: string;
  text?: string;
  fontSize?: number;
  color?: string;
  /** Text on a dark box. */
  box?: boolean;
  start: number;
  duration: number;
  /** Top-left and width as fractions of the frame; height follows the picture's shape. */
  x: number;
  y: number;
  w: number;
  /** Height / width of the picture, in pixels. */
  aspect: number;
  opacity: number;
};

export type AudioItem = {
  id: string;
  path: string;
  name: string;
  start: number;
  srcIn: number;
  duration: number;
  srcDuration: number;
  volume: number;
  fadeIn: number;
  fadeOut: number;
};

export type Project = {
  width: number;
  height: number;
  fps: number;
  main: MainItem[];
  overlays: OverlayItem[];
  audio: AudioItem[];
};

export const EMPTY_PROJECT: Project = { width: 1920, height: 1080, fps: 60, main: [], overlays: [], audio: [] };

export const MIN_LEN = 0.1;

let seq = 0;
export function newId(): string {
  seq += 1;
  return `${Date.now().toString(36)}${seq.toString(36)}`;
}

/** Start times of the main track's items (they sit back to back). */
export function mainStarts(main: MainItem[]): number[] {
  const out: number[] = [];
  let t = 0;
  for (const m of main) {
    out.push(t);
    t += m.duration;
  }
  return out;
}

export function projectLength(p: Project): number {
  const main = p.main.reduce((s, m) => s + m.duration, 0);
  if (main > 0) return main;
  const ends = [...p.overlays, ...p.audio].map((x) => x.start + x.duration);
  return ends.length ? Math.max(...ends) : 0;
}

/** The main-track item at time `t`, with its start. */
export function mainAt(main: MainItem[], t: number): { item: MainItem; start: number; index: number } | null {
  let s = 0;
  for (let i = 0; i < main.length; i++) {
    const m = main[i];
    if (t >= s && t < s + m.duration) return { item: m, start: s, index: i };
    s += m.duration;
  }
  return null;
}

/** Splits the main-track item under `t` in two. */
export function splitMain(main: MainItem[], t: number): MainItem[] {
  const hit = mainAt(main, t);
  if (!hit) return main;
  const off = t - hit.start;
  if (off < MIN_LEN || hit.item.duration - off < MIN_LEN) return main;
  const a = { ...hit.item, duration: off };
  const b = {
    ...hit.item,
    id: newId(),
    srcIn: hit.item.kind === "video" ? hit.item.srcIn + off : 0,
    duration: hit.item.duration - off,
  };
  return [...main.slice(0, hit.index), a, b, ...main.slice(hit.index + 1)];
}

/** Splits a free-standing item (overlay or audio) at `t`. */
export function splitFree<T extends { id: string; start: number; duration: number; srcIn?: number }>(
  items: T[],
  id: string,
  t: number,
): T[] {
  const i = items.findIndex((x) => x.id === id);
  if (i < 0) return items;
  const it = items[i];
  const off = t - it.start;
  if (off < MIN_LEN || it.duration - off < MIN_LEN) return items;
  const a = { ...it, duration: off };
  const b = { ...it, id: newId(), start: t, duration: it.duration - off } as T;
  if (typeof it.srcIn === "number") (b as { srcIn?: number }).srcIn = it.srcIn + off;
  return [...items.slice(0, i), a, b, ...items.slice(i + 1)];
}

/**
 * Trims a main-track video/picture from one side. `delta` seconds moves
 * that edge right (positive) or left. Video cannot go past its file.
 */
export function trimMain(m: MainItem, edge: "left" | "right", delta: number): MainItem {
  if (edge === "right") {
    const max = m.kind === "video" ? m.srcDuration - m.srcIn : Infinity;
    return { ...m, duration: Math.min(max, Math.max(MIN_LEN, m.duration + delta)) };
  }
  if (m.kind === "image") return { ...m, duration: Math.max(MIN_LEN, m.duration - delta) };
  const srcIn = Math.min(m.srcIn + m.duration - MIN_LEN, Math.max(0, m.srcIn + delta));
  return { ...m, srcIn, duration: m.duration - (srcIn - m.srcIn) };
}

/** Same for overlay/audio items, which keep their place on the timeline. */
export function trimFree<T extends { start: number; duration: number; srcIn?: number; srcDuration?: number }>(
  it: T,
  edge: "left" | "right",
  delta: number,
): T {
  const hasSrc = typeof it.srcIn === "number" && typeof it.srcDuration === "number";
  if (edge === "right") {
    const max = hasSrc ? it.srcDuration! - it.srcIn! : Infinity;
    return { ...it, duration: Math.min(max, Math.max(MIN_LEN, it.duration + delta)) };
  }
  let d = Math.min(it.duration - MIN_LEN, delta);
  d = Math.max(d, -it.start);
  if (hasSrc) d = Math.max(d, -it.srcIn!);
  const out = { ...it, start: it.start + d, duration: it.duration - d };
  if (hasSrc) (out as { srcIn?: number }).srcIn = it.srcIn! + d;
  return out;
}

/** Moves an item in a list to another index. */
export function moveTo<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= list.length) return list;
  const out = list.slice();
  const [x] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(out.length, to)), 0, x);
  return out;
}

/** Rows so overlapping items do not cover each other. */
export function lanes<T extends { id: string; start: number; duration: number }>(items: T[]): Map<string, number> {
  const ends: number[] = [];
  const out = new Map<string, number>();
  for (const it of [...items].sort((a, b) => a.start - b.start)) {
    let lane = ends.findIndex((e) => e <= it.start + 1e-6);
    if (lane < 0) {
      lane = ends.length;
      ends.push(0);
    }
    ends[lane] = it.start + it.duration;
    out.set(it.id, lane);
  }
  return out;
}

/** Volume at `t` seconds into an audio piece, with fades (0-1 for the preview). */
export function audioGain(a: AudioItem, t: number): number {
  let g = a.volume;
  if (a.fadeIn > 0 && t < a.fadeIn) g *= Math.max(0, t / a.fadeIn);
  const left = a.duration - t;
  if (a.fadeOut > 0 && left < a.fadeOut) g *= Math.max(0, left / a.fadeOut);
  return g;
}

/** Where a dragged main-track item should go, from the pointer's time. */
export function dropIndex(main: MainItem[], from: number, t: number): number {
  const starts = mainStarts(main);
  let to = 0;
  for (let i = 0; i < main.length; i++) {
    if (i === from) continue;
    if (t > starts[i] + main[i].duration / 2) to = i < from ? i + 1 : i;
  }
  return to;
}

export function clockText(t: number): string {
  const s = Math.max(0, t);
  const m = Math.floor(s / 60);
  const ss = (s % 60).toFixed(1).padStart(4, "0");
  return `${m}:${ss}`;
}
