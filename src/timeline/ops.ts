/**
 * Timeline engine: edits. Every function is pure (it returns a new timeline
 * and never changes its input) and keeps the rule that items on one track
 * never overlap.
 *
 * Placement modes:
 * - "overwrite" (default, Premiere/Resolve): whatever lies under the placed
 *   items is trimmed, split or removed.
 * - "insert" (Ctrl while dropping): items at and after the drop point move
 *   right to make room.
 * A magnetic track (CapCut's main track) is packed back to back after every
 * edit; pass its id as `magnet`.
 */
import { EPS, MIN_LEN, type Item, type Marker, type Timeline, type Track, end, gapAt, isLocked, newId, round, withLinked } from "./model";

export type PlaceMode = "overwrite" | "insert";

export interface EditOpts {
  /** Track packed back to back after the edit (magnetic main track). */
  magnet?: string | null;
}

function cloneItem<I extends Item>(i: I, patch: Partial<I>): I {
  return { ...i, ...patch };
}

/** A new link id per old one, shared by every piece cut in one edit. */
function relinker(): (link: string | undefined) => string | undefined {
  const map = new Map<string, string>();
  return (link) => {
    if (!link) return link;
    if (!map.has(link)) map.set(link, newId("l"));
    return map.get(link);
  };
}

/**
 * Removes `a..b` from one track's items (overwrite), splitting what straddles
 * it. A right-hand piece cut off an item gets a new id and, like splitAt, a
 * new link (pass one `relink` for every track of an edit so linked pieces
 * stay together).
 */
export function clearRange<I extends Item>(items: I[], track: string, a: number, b: number, relink = relinker()): I[] {
  if (b - a <= EPS) return items;
  const out: I[] = [];
  for (const i of items) {
    if (i.track !== track) {
      out.push(i);
      continue;
    }
    const e = end(i);
    if (e <= a + EPS || i.start >= b - EPS) {
      out.push(i);
      continue;
    }
    const left = i.start < a - EPS && a - i.start >= MIN_LEN;
    if (left) out.push(cloneItem(i, { duration: round(a - i.start) } as Partial<I>));
    if (e > b + EPS && e - b >= MIN_LEN) {
      out.push(
        cloneItem(i, {
          id: left ? newId() : i.id,
          start: round(b),
          srcIn: round(i.srcIn + (b - i.start)),
          duration: round(e - b),
          link: left ? relink(i.link) : i.link,
        } as Partial<I>),
      );
    }
  }
  return out;
}

/** Packs one track's items back to back from 0, keeping their order. */
export function compact<I extends Item>(items: I[], track: string): I[] {
  const on = items.filter((i) => i.track === track).sort((a, b) => a.start - b.start);
  let t = 0;
  const moved = new Map<string, number>();
  for (const i of on) {
    moved.set(i.id, round(t));
    t += i.duration;
  }
  return items.map((i) => (moved.has(i.id) && moved.get(i.id) !== i.start ? cloneItem(i, { start: moved.get(i.id)! } as Partial<I>) : i));
}

/** Shifts items of `track` that start at or after `from` by `dt`. */
function shiftAfter<I extends Item>(items: I[], track: string, from: number, dt: number, skip?: Set<string>): I[] {
  if (Math.abs(dt) < EPS) return items;
  return items.map((i) =>
    i.track === track && i.start >= from - EPS && !skip?.has(i.id) ? cloneItem(i, { start: round(Math.max(0, i.start + dt)) } as Partial<I>) : i,
  );
}

/**
 * Moves items by their own amount (`delta`), track by track in time order.
 * An item never lands on the one before it (nor before 0): it stops there,
 * so the no-overlap rule holds whatever the amounts.
 */
function shiftBy<I extends Item>(items: I[], delta: Map<string, number>): I[] {
  if (!delta.size) return items;
  const byId = new Map(items.map((i) => [i.id, i]));
  const tracks = new Set([...delta.keys()].map((id) => byId.get(id)?.track).filter((t): t is string => !!t));
  const to = new Map<string, number>();
  for (const tr of tracks) {
    const on = items.filter((i) => i.track === tr).sort((a, b) => a.start - b.start);
    let prev = 0;
    for (const i of on) {
      const d = delta.get(i.id) ?? 0;
      const s = Math.abs(d) > EPS ? Math.max(prev, i.start + d) : i.start;
      if (Math.abs(s - i.start) > EPS) to.set(i.id, round(s));
      prev = Math.max(prev, s + i.duration);
    }
  }
  return to.size ? items.map((i) => (to.has(i.id) ? cloneItem(i, { start: to.get(i.id)! } as Partial<I>) : i)) : items;
}

/** Items linked to any of `ids` (not those themselves). */
function partners<I extends Item>(items: I[], ids: Iterable<string>): I[] {
  const set = new Set(ids);
  const links = new Set(items.filter((i) => set.has(i.id) && i.link).map((i) => i.link));
  return links.size ? items.filter((i) => !set.has(i.id) && i.link && links.has(i.link)) : [];
}

/**
 * Packs the magnetic track back to back. What belongs to a clip that moves
 * goes with it: its linked items, and items on other unlocked tracks that
 * start over it (titles, pictures and sound laid on top).
 */
function packMagnet<I extends Item>(tl: Timeline<I>, items: I[], magnet: string): I[] {
  const packed = compact(items, magnet);
  const delta = new Map<string, number>();
  const before = new Map(items.map((i) => [i.id, i]));
  for (const i of packed) {
    const d = i.start - before.get(i.id)!.start;
    if (i.track === magnet && Math.abs(d) > EPS) delta.set(i.id, d);
  }
  if (!delta.size) return packed;
  const main = items.filter((i) => i.track === magnet);
  for (const m of main) {
    const d = delta.get(m.id);
    if (d === undefined) continue;
    for (const x of partners(items, [m.id])) if (!isLocked(tl, x.track) && x.track !== magnet) delta.set(x.id, d);
  }
  for (const x of items) {
    if (x.track === magnet || delta.has(x.id) || isLocked(tl, x.track) || x.link) continue;
    const host = main.find((m) => x.start >= m.start - EPS && x.start < end(m) - EPS);
    const d = host && delta.get(host.id);
    if (d !== undefined) delta.set(x.id, d);
  }
  // The main track is already packed; move the rest.
  for (const m of main) delta.delete(m.id);
  return shiftBy(packed, delta);
}

/**
 * Puts `placed` items on the timeline (new ones, or moved copies of existing
 * ones: an item with an existing id replaces it).
 */
export function place<I extends Item>(tl: Timeline<I>, placed: I[], mode: PlaceMode = "overwrite", opts: EditOpts = {}): Timeline<I> {
  if (!placed.length) return tl;
  const ids = new Set(placed.map((p) => p.id));
  let items = tl.items.filter((i) => !ids.has(i.id));
  const fixed = placed.map((p) => cloneItem(p, { start: round(Math.max(0, p.start)), duration: round(Math.max(MIN_LEN, p.duration)) } as Partial<I>));
  if (mode === "insert" && opts.magnet) {
    // On the magnetic track a drop never cuts a clip: it goes to the nearest
    // edge of the clip under it.
    const shift = new Map<string, number>();
    for (const p of fixed) {
      if (p.track !== opts.magnet || shift.has(p.track)) continue;
      const under = items.find((i) => i.track === p.track && p.start > i.start + EPS && p.start < end(i) - EPS);
      if (under) shift.set(p.track, (p.start - under.start < under.duration / 2 ? under.start : end(under)) - p.start);
    }
    for (let k = 0; k < fixed.length; k++) {
      const d = shift.get(fixed[k].track);
      if (d) fixed[k] = cloneItem(fixed[k], { start: round(Math.max(0, fixed[k].start + d)) } as Partial<I>);
    }
  }
  if (mode === "insert") {
    // A hole from the earliest placed start, as long as the placed span, on
    // every unlocked track (sync lock): linked sound and the titles over the
    // clips after it stay with them. What straddles the hole on the tracks
    // that receive items is cut (with its linked pieces).
    const at = Math.min(...fixed.map((p) => p.start));
    const span = Math.max(...fixed.map((p) => end(p))) - at;
    const targets = new Set(fixed.map((p) => p.track));
    const straddle = items.filter((i) => targets.has(i.track) && at > i.start + EPS && at < end(i) - EPS).map((i) => i.id);
    if (straddle.length) items = splitAt({ ...tl, items }, at, straddle).tl.items;
    const delta = new Map<string, number>();
    for (const i of items) if (!isLocked(tl, i.track) && i.start >= at - EPS) delta.set(i.id, span);
    items = shiftBy(items, delta);
  }
  // Overwrite: clear under the placed items. After an insert this only
  // removes slivers too short to split off.
  const relink = relinker();
  for (const p of fixed) items = clearRange(items, p.track, p.start, end(p), relink);
  items = [...items, ...fixed];
  if (opts.magnet) items = packMagnet(tl, items, opts.magnet);
  return { ...tl, items };
}

export interface Move {
  id: string;
  start: number;
  track: string;
}

/** Moves items to new places (drag, nudge). Locked tracks are refused. */
export function moveItems<I extends Item>(tl: Timeline<I>, moves: Move[], mode: PlaceMode = "overwrite", opts: EditOpts = {}): Timeline<I> {
  const byId = new Map(tl.items.map((i) => [i.id, i]));
  const placed: I[] = [];
  for (const m of moves) {
    const i = byId.get(m.id);
    if (!i) continue;
    if (isLocked(tl, i.track) || isLocked(tl, m.track)) return tl;
    placed.push(cloneItem(i, { start: m.start, track: m.track } as Partial<I>));
  }
  return place(tl, placed, mode, opts);
}

/** Moves a group by `dt` seconds on their own tracks; the group never goes before 0. */
export function shiftItems<I extends Item>(tl: Timeline<I>, ids: Iterable<string>, dt: number, mode: PlaceMode = "overwrite", opts: EditOpts = {}): Timeline<I> {
  const set = new Set(ids);
  const items = tl.items.filter((i) => set.has(i.id));
  if (!items.length) return tl;
  const minStart = Math.min(...items.map((i) => i.start));
  const d = Math.max(dt, -minStart);
  return moveItems(tl, items.map((i) => ({ id: i.id, start: i.start + d, track: i.track })), mode, opts);
}

export interface TrimOpts extends EditOpts {
  /** Later items on the track follow the edge (ripple trim). */
  ripple?: boolean;
}

/**
 * Moves one edge of an item to `to` (timeline seconds). Without ripple the
 * edge stops at the neighbour; it never goes past the source. Linked items
 * whose same edge lines up are trimmed with it.
 */
export function trimItem<I extends Item>(tl: Timeline<I>, id: string, edge: "left" | "right", to: number, opts: TrimOpts = {}): Timeline<I> {
  const it = tl.items.find((i) => i.id === id);
  if (!it || isLocked(tl, it.track)) return tl;
  const group = [...withLinked(tl, [id])]
    .map((x) => tl.items.find((i) => i.id === x)!)
    .filter((i) => (edge === "left" ? Math.abs(i.start - it.start) < 1e-3 : Math.abs(end(i) - end(it)) < 1e-3));
  // The allowed range is the tightest over the whole group.
  let lo = -Infinity;
  let hi = Infinity;
  for (const g of group) {
    if (isLocked(tl, g.track)) return tl;
    const bounded = g.srcDuration !== undefined;
    const neighbours = tl.items.filter((i) => i.track === g.track && i.id !== g.id);
    if (edge === "left") {
      hi = Math.min(hi, end(g) - MIN_LEN);
      if (bounded) lo = Math.max(lo, g.start - g.srcIn);
      if (!opts.ripple) {
        lo = Math.max(lo, 0);
        for (const n of neighbours) if (end(n) <= g.start + EPS) lo = Math.max(lo, end(n));
      }
    } else {
      lo = Math.max(lo, g.start + MIN_LEN);
      if (bounded) hi = Math.min(hi, g.start + (g.srcDuration! - g.srcIn));
      if (!opts.ripple) for (const n of neighbours) if (n.start >= end(g) - EPS) hi = Math.min(hi, n.start);
    }
  }
  const t = round(Math.min(hi, Math.max(lo, to)));
  let items = tl.items;
  for (const g of group) {
    const others = new Set(group.map((x) => x.id));
    if (edge === "right") {
      const d = t - end(g);
      if (opts.ripple) items = shiftAfter(items, g.track, end(g), d, others);
      items = items.map((i) => (i.id === g.id ? cloneItem(i, { duration: round(t - i.start) } as Partial<I>) : i));
    } else {
      const d = t - g.start; // > 0 = shorter
      if (opts.ripple) {
        // The item keeps its place; its head is cut off (or put back) and
        // everything after it follows.
        items = items.map((i) => (i.id === g.id ? cloneItem(i, { srcIn: i.srcDuration === undefined ? i.srcIn : round(i.srcIn + d), duration: round(i.duration - d) } as Partial<I>) : i));
        items = shiftAfter(items, g.track, end(g), -d, others);
      } else {
        items = items.map((i) => (i.id === g.id ? cloneItem(i, { start: t, srcIn: i.srcDuration === undefined ? i.srcIn : round(i.srcIn + d), duration: round(i.duration - d) } as Partial<I>) : i));
      }
    }
  }
  let out = { ...tl, items };
  if (opts.magnet) out = { ...out, items: packMagnet(tl, out.items, opts.magnet) };
  return out;
}

/**
 * Slip: the item stays where it is; the part of its source it shows moves
 * by `d` seconds (Premiere's Y). Linked items slip with it. Clamped to the
 * source.
 */
export function slipItem<I extends Item>(tl: Timeline<I>, id: string, d: number): Timeline<I> {
  const ids = withLinked(tl, [id]);
  const group = tl.items.filter((i) => ids.has(i.id) && i.srcDuration !== undefined);
  if (!group.length || group.some((g) => isLocked(tl, g.track))) return tl;
  let lo = -Infinity;
  let hi = Infinity;
  for (const g of group) {
    lo = Math.max(lo, -g.srcIn);
    hi = Math.min(hi, g.srcDuration! - g.srcIn - g.duration);
  }
  if (hi < lo) return tl;
  const dd = round(Math.min(hi, Math.max(lo, d)));
  if (Math.abs(dd) < EPS) return tl;
  const set = new Set(group.map((g) => g.id));
  return { ...tl, items: tl.items.map((i) => (set.has(i.id) ? cloneItem(i, { srcIn: round(i.srcIn + dd) } as Partial<I>) : i)) };
}

/**
 * Roll: moves the cut between `id` and the item touching its `edge` to `to`.
 * One gets longer, the other shorter; nothing else moves. Returns the
 * timeline unchanged when no item touches that edge.
 */
export function rollEdit<I extends Item>(tl: Timeline<I>, id: string, edge: "left" | "right", to: number): Timeline<I> {
  const it = tl.items.find((i) => i.id === id);
  if (!it || isLocked(tl, it.track)) return tl;
  const cut = edge === "right" ? end(it) : it.start;
  const other = tl.items.find((i) => i.track === it.track && i.id !== it.id && (edge === "right" ? Math.abs(i.start - cut) < 1e-3 : Math.abs(end(i) - cut) < 1e-3));
  if (!other) return tl;
  const [a, b] = edge === "right" ? [it, other] : [other, it];
  let lo = Math.max(a.start + MIN_LEN, b.srcDuration !== undefined ? b.start - b.srcIn : -Infinity);
  let hi = Math.min(end(b) - MIN_LEN, a.srcDuration !== undefined ? a.start + (a.srcDuration - a.srcIn) : Infinity);
  if (hi < lo) return tl;
  const t = round(Math.min(hi, Math.max(lo, to)));
  const d = t - cut;
  return {
    ...tl,
    items: tl.items.map((i) =>
      i.id === a.id
        ? cloneItem(i, { duration: round(t - i.start) } as Partial<I>)
        : i.id === b.id
          ? cloneItem(i, { start: t, srcIn: i.srcDuration === undefined ? i.srcIn : round(i.srcIn + d), duration: round(i.duration - d) } as Partial<I>)
          : i,
    ),
  };
}

/**
 * Splits items under `t`. With `ids`, only those (and their links); else
 * every item on an unlocked track. Returns the new right-hand pieces too.
 */
export function splitAt<I extends Item>(tl: Timeline<I>, t: number, ids?: Iterable<string> | null): { tl: Timeline<I>; created: string[] } {
  const want = ids ? withLinked(tl, ids) : null;
  const created: string[] = [];
  const linkMap = new Map<string, string>();
  const items: I[] = [];
  for (const i of tl.items) {
    const hit = (!want || want.has(i.id)) && !isLocked(tl, i.track) && t - i.start >= MIN_LEN - EPS && end(i) - t >= MIN_LEN - EPS;
    if (!hit) {
      items.push(i);
      continue;
    }
    const off = t - i.start;
    items.push(cloneItem(i, { duration: round(off) } as Partial<I>));
    let link = i.link;
    if (link) {
      if (!linkMap.has(link)) linkMap.set(link, newId("l"));
      link = linkMap.get(link);
    }
    const id = newId();
    created.push(id);
    items.push(cloneItem(i, { id, start: round(t), srcIn: round(i.srcIn + off), duration: round(i.duration - off), link } as Partial<I>));
  }
  return { tl: created.length ? { ...tl, items } : tl, created };
}

/**
 * Deletes items. With ripple, what came after each deleted item on its track
 * moves left by exactly the deleted length (never further: an earlier gap
 * stays), and items linked to what moves move by the same amount so sound
 * stays in sync. Linked items deleted together close up once, by the
 * shortest of them.
 */
export function removeItems<I extends Item>(tl: Timeline<I>, ids: Iterable<string>, ripple = false, opts: EditOpts = {}): Timeline<I> {
  const set = new Set(ids);
  const gone = tl.items.filter((i) => set.has(i.id) && !isLocked(tl, i.track));
  if (!gone.length) return tl;
  const goneIds = new Set(gone.map((g) => g.id));
  let items = tl.items.filter((i) => !goneIds.has(i.id));
  if (ripple) {
    const groups = new Map<string, I[]>();
    for (const g of gone) {
      const k = g.link ?? g.id;
      groups.set(k, [...(groups.get(k) ?? []), g]);
    }
    // Last first, so earlier holes are measured on unmoved items.
    const order = [...groups.values()].sort((a, b) => Math.max(...b.map((x) => x.start)) - Math.max(...a.map((x) => x.start)));
    for (const grp of order) {
      const dt = Math.min(...grp.map((g) => g.duration));
      const delta = new Map<string, number>();
      for (const g of grp) for (const i of items) if (i.track === g.track && i.start >= end(g) - EPS) delta.set(i.id, -dt);
      for (const x of partners(items, [...delta.keys()])) if (!isLocked(tl, x.track) && !delta.has(x.id)) delta.set(x.id, -dt);
      items = shiftBy(items, delta);
    }
  }
  let out = { ...tl, items };
  if (opts.magnet) out = { ...out, items: packMagnet(tl, out.items, opts.magnet) };
  return out;
}

/** Closes the gap under `t` on a track (later items move left). */
export function closeGap<I extends Item>(tl: Timeline<I>, track: string, t: number): Timeline<I> {
  if (isLocked(tl, track)) return tl;
  const g = gapAt(tl, track, t);
  if (!g) return tl;
  return { ...tl, items: shiftAfter(tl.items, track, g.end, -(g.end - g.start)) };
}

/** Closes every gap on a track (or on every unlocked track). */
export function closeAllGaps<I extends Item>(tl: Timeline<I>, track?: string): Timeline<I> {
  let items = tl.items;
  for (const tr of tl.tracks) {
    if ((track && tr.id !== track) || tr.locked) continue;
    items = compact(items, tr.id);
  }
  return { ...tl, items };
}

/**
 * Q / W: removes everything before (left) or after (right) the playhead
 * from the items under it and closes the hole on their tracks.
 */
export function rippleTrimToPlayhead<I extends Item>(tl: Timeline<I>, t: number, side: "left" | "right", ids?: Iterable<string> | null): Timeline<I> {
  const want = ids ? withLinked(tl, ids) : null;
  let out = tl;
  // What stays must be at least MIN_LEN long.
  const hits = tl.items.filter(
    (i) => (!want || want.has(i.id)) && !isLocked(tl, i.track) && t > i.start + EPS && t < end(i) - EPS && (side === "left" ? end(i) - t : t - i.start) >= MIN_LEN - EPS,
  );
  for (const h of hits) {
    const cur = out.items.find((i) => i.id === h.id);
    if (!cur) continue;
    if (side === "left") {
      const d = t - cur.start;
      let items = out.items.map((i) => (i.id === cur.id ? cloneItem(i, { srcIn: round(i.srcIn + d), duration: round(i.duration - d) } as Partial<I>) : i));
      items = shiftAfter(items, cur.track, end(cur), -d, new Set([cur.id]));
      out = { ...out, items };
    } else {
      const d = end(cur) - t;
      let items = shiftAfter(out.items, cur.track, end(cur), -d, new Set([cur.id]));
      items = items.map((i) => (i.id === cur.id ? cloneItem(i, { duration: round(t - i.start) } as Partial<I>) : i));
      out = { ...out, items };
    }
  }
  return out;
}

/**
 * Pastes copies of `clip` so the earliest starts at `t`. Each keeps its track
 * when that track exists and is unlocked, else `fallback(item)` picks one.
 */
export function pasteItems<I extends Item>(
  tl: Timeline<I>,
  clip: I[],
  t: number,
  fallback: (i: I) => string | null,
  mode: PlaceMode = "overwrite",
  opts: EditOpts = {},
): { tl: Timeline<I>; created: string[] } {
  if (!clip.length) return { tl, created: [] };
  const first = Math.min(...clip.map((c) => c.start));
  const links = new Map<string, string>();
  const placed: I[] = [];
  for (const c of clip) {
    const tr = tl.tracks.find((x) => x.id === c.track && !x.locked) ? c.track : fallback(c);
    if (!tr) continue;
    let link = c.link;
    if (link) {
      if (!links.has(link)) links.set(link, newId("l"));
      link = links.get(link);
    }
    placed.push(cloneItem(c, { id: newId(), track: tr, start: round(t + (c.start - first)), link } as Partial<I>));
  }
  return { tl: place(tl, placed, mode, opts), created: placed.map((p) => p.id) };
}

/** Patches items by id (properties that do not change placement). */
export function patchItems<I extends Item>(tl: Timeline<I>, ids: Iterable<string>, patch: Partial<I> | ((i: I) => Partial<I>)): Timeline<I> {
  const set = new Set(ids);
  let changed = false;
  const items = tl.items.map((i) => {
    if (!set.has(i.id)) return i;
    changed = true;
    return cloneItem(i, typeof patch === "function" ? patch(i) : patch);
  });
  return changed ? { ...tl, items } : tl;
}

// ------------------------------------------------------------------ tracks

export function addTrack<I extends Item>(tl: Timeline<I>, track: Track, index?: number): Timeline<I> {
  const tracks = tl.tracks.slice();
  tracks.splice(index === undefined ? tracks.length : Math.max(0, Math.min(tracks.length, index)), 0, track);
  return { ...tl, tracks };
}

/** Removes a track and everything on it. */
export function removeTrack<I extends Item>(tl: Timeline<I>, id: string): Timeline<I> {
  return { ...tl, tracks: tl.tracks.filter((t) => t.id !== id), items: tl.items.filter((i) => i.track !== id) };
}

export function patchTrack<I extends Item>(tl: Timeline<I>, id: string, patch: Partial<Track>): Timeline<I> {
  return { ...tl, tracks: tl.tracks.map((t) => (t.id === id ? { ...t, ...patch } : t)) };
}

/** Is a track heard? Solo on any track of the same kind silences the others. */
export function audible(tl: Timeline, trackId: string): boolean {
  const tr = tl.tracks.find((t) => t.id === trackId);
  if (!tr || tr.muted) return false;
  const anySolo = tl.tracks.some((t) => t.solo);
  return !anySolo || !!tr.solo;
}

// ------------------------------------------------------------------ markers

export function addMarker<I extends Item>(tl: Timeline<I>, t: number, label?: string): { tl: Timeline<I>; id: string } {
  const near = tl.markers.find((m) => Math.abs(m.t - t) < 1e-3);
  if (near) return { tl, id: near.id };
  const m: Marker = { id: newId("m"), t: round(Math.max(0, t)), label };
  return { tl: { ...tl, markers: [...tl.markers, m].sort((a, b) => a.t - b.t) }, id: m.id };
}

export function patchMarker<I extends Item>(tl: Timeline<I>, id: string, patch: Partial<Marker>): Timeline<I> {
  return {
    ...tl,
    markers: tl.markers.map((m) => (m.id === id ? { ...m, ...patch, t: round(Math.max(0, patch.t ?? m.t)) } : m)).sort((a, b) => a.t - b.t),
  };
}

export function removeMarker<I extends Item>(tl: Timeline<I>, id: string): Timeline<I> {
  return { ...tl, markers: tl.markers.filter((m) => m.id !== id) };
}

/** Next (dir 1) or previous (dir -1) point in a sorted list from `t`. */
export function nextPoint(points: number[], t: number, dir: 1 | -1): number | null {
  if (dir > 0) return points.find((p) => p > t + 1e-3) ?? null;
  for (let i = points.length - 1; i >= 0; i--) if (points[i] < t - 1e-3) return points[i];
  return null;
}

/** Items overlapping `a..b` on the given tracks (marquee selection). */
export function itemsInBox(tl: Timeline, tracks: Set<string>, a: number, b: number): string[] {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return tl.items.filter((i) => tracks.has(i.track) && end(i) > lo && i.start < hi).map((i) => i.id);
}

/** Items starting at or after `t` (dir 1), or ending at or before it (dir -1). */
export function itemsFrom(tl: Timeline, t: number, dir: 1 | -1): string[] {
  return tl.items.filter((i) => (dir > 0 ? end(i) > t + EPS : i.start < t - EPS)).map((i) => i.id);
}

/**
 * Removes `a..b` from every unlocked track and closes the hole (cut out the
 * in→out range); with `keep`, keeps only `a..b` and moves it to 0.
 */
export function extractRange<I extends Item>(tl: Timeline<I>, a: number, b: number, keep = false): Timeline<I> {
  const lo = Math.max(0, Math.min(a, b));
  const hi = Math.max(a, b);
  if (hi - lo < MIN_LEN) return tl;
  const cut = hi - lo;
  const relink = relinker();
  const items: I[] = [];
  for (const i of tl.items) {
    if (isLocked(tl, i.track)) {
      items.push(i);
      continue;
    }
    const s = i.start;
    const e = end(i);
    if (keep) {
      // Only the part inside the range, moved to 0; slivers go.
      const x = Math.max(s, lo);
      const y = Math.min(e, hi);
      if (y - x >= MIN_LEN) items.push(cloneItem(i, { start: round(x - lo), srcIn: round(i.srcIn + (x - s)), duration: round(y - x) } as Partial<I>));
      continue;
    }
    if (e <= lo + EPS) items.push(i);
    else if (s >= hi - EPS) items.push(cloneItem(i, { start: round(s - cut) } as Partial<I>));
    else {
      // The part before the range stays; the part after it closes up. A
      // piece shorter than the shortest item goes rather than overlap.
      const head = lo - s >= MIN_LEN;
      if (head) items.push(cloneItem(i, { duration: round(lo - s) } as Partial<I>));
      if (e - hi >= MIN_LEN) items.push(cloneItem(i, { id: head ? newId() : i.id, start: round(lo), srcIn: round(i.srcIn + (hi - s)), duration: round(e - hi), link: head ? relink(i.link) : i.link } as Partial<I>));
    }
  }
  const markers = keep
    ? tl.markers.filter((m) => m.t >= lo && m.t <= hi).map((m) => ({ ...m, t: round(m.t - lo) }))
    : tl.markers.filter((m) => m.t < lo || m.t > hi).map((m) => (m.t > hi ? { ...m, t: round(m.t - cut) } : m));
  return { ...tl, items, inPoint: null, outPoint: null, markers };
}
