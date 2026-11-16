/**
 * Clips library as a file manager (pure logic, unit-tested): what is inside a
 * folder, the "All clips" and "Recent" views, search, sorting, the path bar
 * and back / forward history.
 *
 * Paths are Windows paths. Folders are compared without letter case.
 */
import type { ClipMetadata } from "./types";

export type Loc = { kind: "folder"; path: string } | { kind: "all" } | { kind: "recent" };
export type SortCol = "name" | "game" | "date" | "length" | "size" | "resolution";
export interface SortSpec {
  col: SortCol;
  desc: boolean;
}

export interface FolderEntry {
  kind: "folder";
  path: string;
  name: string;
  /** Clips in it and its subfolders. */
  count: number;
  bytes: number;
  /** Newest clip inside (for the folder's picture). */
  latest: ClipMetadata | null;
  /** An extra library folder shown at the top level. */
  external?: boolean;
}
export interface ClipEntry {
  kind: "clip";
  clip: ClipMetadata;
}
export type Entry = FolderEntry | ClipEntry;

export const entryPath = (e: Entry) => (e.kind === "folder" ? e.path : e.clip.path);

export function normPath(p: string): string {
  return p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}
export function samePath(a: string, b: string): boolean {
  return normPath(a) === normPath(b);
}
export function parentOf(p: string): string {
  const s = p.replace(/[\\/]+$/, "");
  const i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
  return i > 0 ? s.slice(0, i) : s;
}
export function baseName(p: string): string {
  const s = p.replace(/[\\/]+$/, "");
  return s.slice(Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/")) + 1);
}
/** Whether `p` is inside `dir` (not equal). */
export function isInside(p: string, dir: string): boolean {
  const a = normPath(p);
  const d = normPath(dir);
  return a.length > d.length + 1 && a.startsWith(d + "\\");
}

/** What a file name says: the app and kind. Mirrors `appname::parse_file_name`. */
export interface ParsedName {
  app: string | null;
  kind: string | null;
  /** "YYYY-MM-DD HH-MM-SS" */
  stamp: string | null;
}
const STAMP = /^\d{4}-\d\d-\d\d \d\d-\d\d-\d\d$/;
export function parseClipName(fileName: string): ParsedName {
  const stem = fileName.replace(/\.[^.]+$/, "");
  for (const [prefix, kind] of [
    ["Lastshot_Recording_", "Recording"],
    ["Lastshot_Edit_", "Edit"],
    ["Lastshot_", null],
    ["ClipFlow_", null],
  ] as const) {
    if (stem.startsWith(prefix)) {
      const t = stem.slice(prefix.length, prefix.length + 19).replace("_", " ");
      return { app: null, kind, stamp: STAMP.test(t) ? t : null };
    }
  }
  const base = stem.replace(/(?:_\d+| ?\(\d+\))$/, "").trimEnd();
  if (base.length >= 20) {
    const stamp = base.slice(-19);
    const head = base.slice(0, -19);
    if (STAMP.test(stamp) && head.endsWith(" ")) {
      const h = head.trimEnd();
      for (const k of ["Recording", "Edit", "Screenshot"]) {
        if (h.endsWith(k)) {
          const app = h.slice(0, -k.length).trimEnd();
          return { app: app || null, kind: k, stamp };
        }
      }
      return { app: h || null, kind: null, stamp };
    }
  }
  return { app: null, kind: null, stamp: null };
}

/** The game / app a clip belongs to: its folder tag, else its file name. */
export function clipGame(c: ClipMetadata): string {
  const g = c.game ?? parseClipName(c.file_name).app;
  return g && g !== "Desktop" ? g : "";
}

export function displayName(c: ClipMetadata): string {
  return c.file_name.replace(/\.mp4$/i, "");
}

/**
 * The folders and clips directly inside `dir`. `dirs` are all known folders
 * (also empty ones); `externals` are extra library folders shown as folders
 * at the top level (`dir` = the save folder).
 */
export function folderContents(
  clips: readonly ClipMetadata[],
  dirs: readonly string[],
  dir: string,
  externals: readonly string[] = [],
): Entry[] {
  const d = normPath(dir);
  const folders = new Map<string, FolderEntry>();
  const ensure = (path: string, external = false) => {
    const k = normPath(path);
    let f = folders.get(k);
    if (!f) {
      f = { kind: "folder", path, name: baseName(path), count: 0, bytes: 0, latest: null, external: external || undefined };
      folders.set(k, f);
    }
    return f;
  };
  const childOf = (p: string): string | null => {
    const n = normPath(p);
    if (!n.startsWith(d + "\\")) return null;
    const rest = p.replace(/\//g, "\\").slice(d.length + 1);
    const seg = rest.split("\\")[0];
    return seg ? p.replace(/\//g, "\\").slice(0, d.length + 1 + seg.length) : null;
  };
  for (const x of dirs) {
    const c = childOf(x);
    if (c) ensure(c);
  }
  for (const x of externals) if (!isInside(x, dir) && !samePath(x, dir)) ensure(x, true);
  const out: Entry[] = [];
  for (const c of clips) {
    const parent = parentOf(c.path);
    if (samePath(parent, dir)) {
      out.push({ kind: "clip", clip: c });
      continue;
    }
    let f: FolderEntry | null = null;
    const sub = childOf(c.path);
    if (sub && !samePath(sub, c.path)) f = ensure(sub);
    else {
      const ext = externals.find((e) => samePath(parent, e) || isInside(c.path, e));
      if (ext && !isInside(ext, dir)) f = folders.get(normPath(ext)) ?? null;
    }
    if (f) {
      f.count++;
      f.bytes += c.size_bytes;
      if (!f.latest || c.created_unix_ms > f.latest.created_unix_ms) f.latest = c;
    }
  }
  return [...folders.values(), ...out];
}

export const byNewest = (a: ClipMetadata, b: ClipMetadata) => b.created_unix_ms - a.created_unix_ms;

export function allClips(clips: readonly ClipMetadata[]): Entry[] {
  return [...clips].sort(byNewest).map((clip) => ({ kind: "clip" as const, clip }));
}

/** Clips from the last 7 days (at most 200), newest first. */
export function recentClips(clips: readonly ClipMetadata[], now = Date.now()): Entry[] {
  const from = now - 7 * 24 * 3600 * 1000;
  return [...clips]
    .filter((c) => c.created_unix_ms >= from)
    .sort(byNewest)
    .slice(0, 200)
    .map((clip) => ({ kind: "clip" as const, clip }));
}

function matches(q: string, ...fields: string[]) {
  return fields.some((f) => f.toLowerCase().includes(q));
}

/** Search: in the current folder (and its subfolders), or everywhere. */
export function searchClips(clips: readonly ClipMetadata[], q: string, within: string | null): Entry[] {
  const s = q.trim().toLowerCase();
  return clips
    .filter((c) => (!within || isInside(c.path, within)) && matches(s, c.file_name, c.title, clipGame(c), ...c.tags))
    .sort(byNewest)
    .map((clip) => ({ kind: "clip" as const, clip }));
}

function key(e: Entry, col: SortCol): number | string {
  if (e.kind === "folder") {
    switch (col) {
      case "date":
        return e.latest?.created_unix_ms ?? 0;
      case "size":
        return e.bytes;
      case "length":
        return e.count;
      default:
        return e.name.toLowerCase();
    }
  }
  const c = e.clip;
  switch (col) {
    case "name":
      return displayName(c).toLowerCase();
    case "game":
      return clipGame(c).toLowerCase();
    case "date":
      return c.created_unix_ms;
    case "length":
      return c.duration_seconds;
    case "size":
      return c.size_bytes;
    case "resolution":
      return c.width * c.height;
  }
}

/** Folders first (like File Explorer), each group sorted by the column. */
export function sortEntries(entries: readonly Entry[], spec: SortSpec): Entry[] {
  const dir = spec.desc ? -1 : 1;
  const cmp = (a: Entry, b: Entry) => {
    const ka = key(a, spec.col);
    const kb = key(b, spec.col);
    const r = typeof ka === "number" && typeof kb === "number" ? ka - kb : String(ka).localeCompare(String(kb), undefined, { numeric: true });
    return r !== 0 ? r * dir : entryPath(a).localeCompare(entryPath(b));
  };
  const folders = entries.filter((e) => e.kind === "folder").sort(cmp);
  const files = entries.filter((e) => e.kind === "clip").sort(cmp);
  return [...folders, ...files];
}

export interface Crumb {
  label: string;
  loc: Loc;
}

/** Path bar: "Clips › Roblox › Best". `roots` are the save folder and the extra folders. */
export function breadcrumb(loc: Loc, saveDir: string, externals: readonly string[] = []): Crumb[] {
  const top: Crumb = { label: "Clips", loc: { kind: "folder", path: saveDir } };
  if (loc.kind === "all") return [top, { label: "All clips", loc }];
  if (loc.kind === "recent") return [top, { label: "Recent", loc }];
  const root = samePath(loc.path, saveDir) || isInside(loc.path, saveDir) ? saveDir : externals.find((e) => samePath(loc.path, e) || isInside(loc.path, e));
  if (!root) return [top, { label: baseName(loc.path), loc }];
  const out: Crumb[] = [top];
  if (!samePath(root, saveDir)) out.push({ label: baseName(root), loc: { kind: "folder", path: root } });
  const rest = loc.path.replace(/\//g, "\\").slice(root.replace(/[\\/]+$/, "").length).split("\\").filter(Boolean);
  let p = root.replace(/[\\/]+$/, "");
  for (const seg of rest) {
    p = `${p}\\${seg}`;
    out.push({ label: seg, loc: { kind: "folder", path: p } });
  }
  return out;
}

/** One level up, or null at the top. */
export function upOf(loc: Loc, saveDir: string, externals: readonly string[] = []): Loc | null {
  if (loc.kind !== "folder") return { kind: "folder", path: saveDir };
  if (samePath(loc.path, saveDir)) return null;
  if (externals.some((e) => samePath(e, loc.path))) return { kind: "folder", path: saveDir };
  return { kind: "folder", path: parentOf(loc.path) };
}

export function sameLoc(a: Loc, b: Loc): boolean {
  return a.kind === b.kind && (a.kind !== "folder" || samePath(a.path, (b as { path: string }).path));
}

export interface History {
  back: Loc[];
  cur: Loc;
  fwd: Loc[];
}
export const historyStart = (cur: Loc): History => ({ back: [], cur, fwd: [] });
export function go(h: History, to: Loc): History {
  if (sameLoc(h.cur, to)) return h;
  return { back: [...h.back.slice(-49), h.cur], cur: to, fwd: [] };
}
export function goBack(h: History): History {
  if (!h.back.length) return h;
  return { back: h.back.slice(0, -1), cur: h.back[h.back.length - 1], fwd: [h.cur, ...h.fwd] };
}
export function goForward(h: History): History {
  if (!h.fwd.length) return h;
  return { back: [...h.back, h.cur], cur: h.fwd[0], fwd: h.fwd.slice(1) };
}

/** Rubber-band: indexes of grid tiles that touch the rectangle. */
export function tilesInRect(
  rect: { x0: number; y0: number; x1: number; y1: number },
  count: number,
  cols: number,
  tileW: number,
  tileH: number,
  gap: number,
): number[] {
  const [l, r] = [Math.min(rect.x0, rect.x1), Math.max(rect.x0, rect.x1)];
  const [t, b] = [Math.min(rect.y0, rect.y1), Math.max(rect.y0, rect.y1)];
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const x = (i % cols) * (tileW + gap);
    const y = Math.floor(i / cols) * (tileH + gap);
    if (x < r && x + tileW > l && y < b && y + tileH > t) out.push(i);
  }
  return out;
}
