/**
 * Timeline engine: the data model. Shared by the video editor and (later)
 * the audio editor / DAW, so nothing here knows about pictures or sound.
 *
 * - A timeline has tracks (top to bottom, in display order), items on those
 *   tracks, markers and an optional in/out range.
 * - An item sits at `start` for `duration` seconds and shows its source from
 *   `srcIn`. `srcDuration` limits trims (undefined = no limit, e.g. a picture
 *   or a text). Items on one track never overlap (the ops keep it so).
 * - Everything is plain JSON and every op is a pure function, so undo is a
 *   stack of whole timelines and tests need no DOM.
 */

export interface Track {
  id: string;
  /** What the track holds; the host decides what kinds exist ("video", "overlay", "audio", ...). */
  kind: string;
  name: string;
  muted?: boolean;
  solo?: boolean;
  locked?: boolean;
  hidden?: boolean;
  /** Track gain, 1 = 100 %. */
  volume?: number;
  /** -1 left .. 1 right. */
  pan?: number;
  /** Row height in the timeline, px (unset = the host's default for the kind). */
  height?: number;
}

export interface Item {
  id: string;
  track: string;
  start: number;
  duration: number;
  /** Where in the source the item begins, seconds. */
  srcIn: number;
  /** Length of the source; undefined = unlimited (pictures, text). */
  srcDuration?: number;
  /** Skipped in playback and export (D). */
  disabled?: boolean;
  /** Items with the same link move, trim, split and delete together. */
  link?: string;
}

export interface Marker {
  id: string;
  t: number;
  label?: string;
  color?: string;
}

export interface Timeline<I extends Item = Item> {
  tracks: Track[];
  items: I[];
  markers: Marker[];
  /** In/out range (I / O); null = not set. */
  inPoint: number | null;
  outPoint: number | null;
}

/** Shortest item, seconds. */
export const MIN_LEN = 0.05;
/** Float slack for comparisons, seconds. */
export const EPS = 1e-6;

let seq = 0;
export function newId(prefix = ""): string {
  seq += 1;
  return `${prefix}${Date.now().toString(36)}${seq.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

export function emptyTimeline<I extends Item>(tracks: Track[] = []): Timeline<I> {
  return { tracks, items: [], markers: [], inPoint: null, outPoint: null };
}

export const end = (i: Item): number => i.start + i.duration;

/** Items of one track, in time order. */
export function trackItems<I extends Item>(tl: Timeline<I>, track: string): I[] {
  return tl.items.filter((i) => i.track === track).sort((a, b) => a.start - b.start);
}

export function trackOf<I extends Item>(tl: Timeline<I>, id: string): Track | undefined {
  return tl.tracks.find((t) => t.id === id);
}

/** End of the last item (the length of the timeline). */
export function timelineEnd(tl: Timeline): number {
  let e = 0;
  for (const i of tl.items) e = Math.max(e, end(i));
  return e;
}

/** Items under time `t` (start inclusive, end exclusive). */
export function itemsAt<I extends Item>(tl: Timeline<I>, t: number): I[] {
  return tl.items.filter((i) => t >= i.start - EPS && t < end(i) - EPS);
}

/** Every cut, start and end on the timeline, sorted, for ↑ / ↓. */
export function editPoints(tl: Timeline): number[] {
  const s = new Set<number>([0]);
  for (const i of tl.items) {
    s.add(round(i.start));
    s.add(round(end(i)));
  }
  return [...s].sort((a, b) => a - b);
}

/** The gap on a track that holds `t`: between two items, or before the first. */
export function gapAt(tl: Timeline, track: string, t: number): { start: number; end: number } | null {
  const items = trackItems(tl, track);
  let prev = 0;
  for (const i of items) {
    if (t < i.start - EPS) return i.start - prev > EPS && t >= prev - EPS ? { start: prev, end: i.start } : null;
    prev = Math.max(prev, end(i));
  }
  return null;
}

/** Ids plus every item linked to them. */
export function withLinked(tl: Timeline, ids: Iterable<string>): Set<string> {
  const out = new Set(ids);
  const links = new Set<string>();
  for (const i of tl.items) if (out.has(i.id) && i.link) links.add(i.link);
  if (links.size) for (const i of tl.items) if (i.link && links.has(i.link)) out.add(i.id);
  return out;
}

export function isLocked(tl: Timeline, trackId: string): boolean {
  return !!trackOf(tl, trackId)?.locked;
}

/** Rounds to 1 µs so float noise does not create fake gaps. */
export function round(t: number): number {
  return Math.round(t * 1e6) / 1e6;
}
