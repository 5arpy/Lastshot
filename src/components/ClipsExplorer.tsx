import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { assetUrl, isTauri, lastshot } from "../lib/bridge";
import type { ClipMetadata } from "../lib/types";
import { formatBytes, formatDuration } from "../lib/format";
import { cacheThumbnail, getCachedThumbnail } from "../lib/thumbCache";
import { cn } from "../utils/cn";
import * as X from "../lib/explorer";
import { dragHasFiles, droppedPaths, dropMode, fileKind, fs, isShowablePicture, splitExt, type DroppedItem } from "../lib/files";
import { isPinned, togglePin, repointPin, usePins } from "../lib/pins";
import { useShortcuts } from "../lib/useShortcuts";
import { activeShortcuts, comboFromEvent, isTextField, splitKeys, withKeys } from "../lib/shortcuts";
import { CLIPS_KEYS, NAV_KEYS } from "./clipsKeys";
import { popOutPicturePath } from "../popout/frames";

/**
 * The Clips tab as a file explorer: real folders (the save folder and the
 * linked ones) with every file in them, game folders with their newest clip,
 * "All clips" and "Recent", a grid with live previews and a details list,
 * Explorer's selection, keys, menus, copy / cut / paste with other apps,
 * native drags in and out, Recycle Bin deletes and undo for every change.
 * Only the rows on screen are drawn, so thousands of files stay smooth.
 *
 * Dropping a folder from outside LINKS it (adds its path to the library);
 * nothing is copied, and unlinking never deletes anything.
 */

type Tone = "ok" | "err" | "warn" | "info";

interface Props {
  clips: ClipMetadata[];
  saveDir: string;
  /** Linked library folders (shown as folders at the top). */
  externals: string[];
  loading?: boolean;
  selected: ReadonlySet<string>;
  onSelection: (paths: string[], anchor: string | null) => void;
  /** Opens the clip editor. */
  onOpen: (clip: ClipMetadata) => void;
  onPlay: (clip: ClipMetadata) => void;
  onReveal: (path: string) => void;
  onCopyForDiscord: (paths: string[]) => void;
  onShare: (clip: ClipMetadata) => void;
  /** Pops the clip out into a see-through frame that keeps playing. */
  onPopOut?: (clip: ClipMetadata) => void;
  /** Puts clips on the editor's timeline (the open edit). */
  onAddToEditor?: (paths: string[]) => void;
  onToggleFavorite: (clip: ClipMetadata) => void;
  /** Files changed: read the library again. */
  onChanged: () => void;
  onToast: (tone: Tone, title: string, body?: string) => void;
  /** Visible order, for "select all" outside. */
  onOrder?: (paths: string[]) => void;
  /** The sidebar asks to go somewhere (`n` changes on each ask). */
  navRequest?: { loc: X.Loc; n: number };
  onLocation?: (loc: X.Loc) => void;
  shareProgress?: ReadonlyMap<string, number>;
  /** Adds folders to the library as links (their paths, never copies). */
  onLinkFolders?: (dirs: string[]) => void | Promise<void>;
  /** Removes a linked folder from the library (the files stay). */
  onUnlinkFolder?: (dir: string) => void | Promise<void>;
}

const PREF_KEY = "lastshot.explorer.v1";
interface Prefs {
  view: "grid" | "details";
  size: number;
  sort: X.SortSpec;
  kind: X.KindFilter;
  preview: boolean;
  hoverPlay: boolean;
}
const DEFAULT_PREFS: Prefs = { view: "grid", size: 220, sort: { col: "date", desc: true }, kind: "all", preview: false, hoverPlay: true };
function loadPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREF_KEY) ?? "{}");
    return {
      view: p.view === "details" ? "details" : "grid",
      size: Math.min(360, Math.max(120, Number(p.size) || 220)),
      sort: p.sort?.col ? p.sort : DEFAULT_PREFS.sort,
      kind: X.KIND_FILTERS.includes(p.kind) ? p.kind : "all",
      preview: !!p.preview,
      hoverPlay: p.hoverPlay !== false,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

// At most three thumbnails decode at once; the rest wait their turn.
let running = 0;
const waiting: Array<() => void> = [];
function thumbFor(path: string): Promise<string | null> {
  const hit = getCachedThumbnail(path);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve) => {
    const run = () => {
      running++;
      lastshot
        .getClipThumbnail(path, 1)
        .then((t) => {
          if (t) cacheThumbnail(path, t);
          resolve(t || null);
        })
        .catch(() => resolve(null))
        .finally(() => {
          running--;
          waiting.shift()?.();
        });
    };
    if (running < 3) run();
    else waiting.push(run);
  });
}

/** A video's picture (from the scan, the cache or made on demand). */
function Thumb({ path, have, className }: { path: string | null; have?: string | null; className?: string }) {
  const [src, setSrc] = useState<string | null>(path ? (have ?? getCachedThumbnail(path) ?? null) : null);
  useEffect(() => {
    if (!path) return setSrc(null);
    let alive = true;
    const h = have ?? getCachedThumbnail(path);
    if (h) setSrc(h);
    else {
      setSrc(null);
      void thumbFor(path).then((t) => alive && setSrc(t));
    }
    return () => {
      alive = false;
    };
  }, [path, have]);
  return src ? (
    <img src={src} alt="" draggable={false} className={cn("h-full w-full object-cover", className)} />
  ) : (
    <div className={cn("h-full w-full bg-surface-4", className)} />
  );
}

/** A picture file shown as itself (loaded lazily, only when on screen). */
function PictureThumb({ path, className }: { path: string; className?: string }) {
  const [bad, setBad] = useState(false);
  const src = isTauri() ? assetUrl(path) : "";
  if (!src || bad) return <KindIcon name={path} />;
  return <img src={src} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setBad(true)} className={cn("h-full w-full object-cover", className)} />;
}

const FolderIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
    <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.6l2 2H19.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" />
  </svg>
);

const KIND_TONE: Record<string, string> = {
  video: "text-sky-300",
  picture: "text-emerald-300",
  audio: "text-fuchsia-300",
  doc: "text-ink-2",
  archive: "text-amber-300",
  other: "text-ink-3",
};
/** A file-type badge: the extension on a page. */
function KindIcon({ name, small }: { name: string; small?: boolean }) {
  const ext = splitExt(X.baseName(name))[1].slice(1).toUpperCase().slice(0, 4) || "FILE";
  return (
    <div className={cn("grid h-full w-full place-items-center bg-surface-3", KIND_TONE[fileKind(name)])}>
      <span className={cn("rounded border border-current px-1 font-mono font-semibold", small ? "text-[8px]" : "text-[11px]")}>{ext}</span>
    </div>
  );
}

const COLS: Array<{ col: X.SortCol; label: string; w: string }> = [
  { col: "name", label: "Name", w: "minmax(220px,3fr)" },
  { col: "game", label: "Game / type", w: "minmax(90px,1fr)" },
  { col: "date", label: "Date", w: "150px" },
  { col: "length", label: "Length", w: "80px" },
  { col: "size", label: "Size", w: "90px" },
  { col: "resolution", label: "Resolution", w: "100px" },
];
const GRID_TEMPLATE = COLS.map((c) => c.w).join(" ");
const ROW_H = 30;
const GAP = 12;
const LABEL_H = 46;
const MIME = "application/x-lastshot-paths";

const fmtDate = (ms: number) =>
  ms ? new Date(ms).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";

/** Windows' errors, said plainly. */
function friendly(err: unknown): string {
  const s = String(err).replace(/^Error:\s*/, "");
  if (/os error 32|being used by another process|sharing violation/i.test(s)) return "It is open in another app (or still recording). Close it and try again.";
  if (/os error 5\b|access is denied|permission denied/i.test(s)) return "Windows won't let Lastshot change it (read-only or protected).";
  if (/os error 3\b|os error 2\b|cannot find|not found/i.test(s)) return "It is not there any more (moved or deleted outside Lastshot).";
  if (/os error 112|not enough space|disk full/i.test(s)) return "The drive is full.";
  return s;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

interface Menu {
  x: number;
  y: number;
  target: X.Entry | null;
}
interface UndoStep {
  label: string;
  run: () => Promise<unknown>;
}
type MenuItem = { id?: string; label: string; key?: string; run: () => void; danger?: boolean; off?: boolean; check?: boolean } | "-";

function ClipsExplorer(props: Props) {
  const { clips, saveDir, externals, selected, onSelection, onToast, onChanged } = props;
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  useEffect(() => {
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
    } catch {
      /* per-viewer convenience only */
    }
  }, [prefs]);
  const [hist, setHist] = useState<X.History>(() => X.historyStart({ kind: "folder", path: saveDir }));
  const loc = hist.cur;
  const [dirs, setDirs] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [everywhere, setEverywhere] = useState(false);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [places, setPlaces] = useState(false);
  const [renaming, setRenaming] = useState<{ path: string; draft?: string } | null>(null);
  const [picker, setPicker] = useState<{ mode: "move" | "copy"; paths: string[] } | null>(null);
  const [cutPaths, setCutPaths] = useState<string[]>([]);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const [band, setBand] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [addr, setAddr] = useState<string | null>(null);
  const [linkAsk, setLinkAsk] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [undo, setUndo] = useState<UndoStep[]>([]);
  const [tick, setTick] = useState(0);
  const [listing, setListing] = useState<{ dir: string; items: X.Listed[] } | null>(null);
  const [listErr, setListErr] = useState<{ dir: string; msg: string } | null>(null);
  const [diskHits, setDiskHits] = useState<{ q: string; items: X.Listed[] }>({ q: "", items: [] });
  const rootRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ w: 800, h: 600, top: 0 });
  const anchorRef = useRef<string | null>(null);
  const bandedRef = useRef(false);
  const dragOut = useRef<string[]>([]);
  const hoverTimer = useRef<number | undefined>(undefined);
  const typed = useRef({ text: "", at: 0 });
  const renameDone = useRef(false);
  const native = isTauri();
  const pins = usePins();

  // The save folder can change in Settings: start over there.
  useEffect(() => {
    setHist(X.historyStart({ kind: "folder", path: saveDir }));
  }, [saveDir]);

  // Keys work as soon as Clips opens.
  useEffect(() => {
    const a = document.activeElement;
    if (!a || a === document.body) rootRef.current?.focus({ preventScroll: true });
  }, []);

  const readDirs = useCallback(() => {
    void lastshot
      .libraryDirs()
      .then(setDirs)
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    readDirs();
  }, [readDirs, clips]);

  const refresh = useCallback(() => {
    onChanged();
    readDirs();
    setTick((t) => t + 1);
  }, [onChanged, readDirs]);

  // Read the folders again when Clips opens (changes made while it was closed).
  useEffect(() => {
    onChanged();
    // On open only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Folder watch: files changed in File Explorer show up by themselves.
  useEffect(() => {
    let off: (() => void) | undefined;
    let alive = true;
    void lastshot.onLibraryChanged(refresh).then((u) => (alive ? (off = u) : u()));
    return () => {
      alive = false;
      off?.();
    };
  }, [refresh]);

  // The real folder: every file in it (not only scanned clips).
  const folderPath = loc.kind === "folder" ? loc.path : null;
  useEffect(() => {
    if (!folderPath || !native) return;
    let alive = true;
    fs.listDir(folderPath)
      .then((items) => {
        if (!alive) return;
        setListing({ dir: folderPath, items });
        setListErr(null);
      })
      .catch((e) => {
        if (!alive) return;
        setListing(null);
        setListErr({ dir: folderPath, msg: friendly(e) });
      });
    return () => {
      alive = false;
    };
  }, [folderPath, tick, clips, native]);

  const navigate = useCallback((to: X.Loc) => {
    setHist((h) => X.go(h, to));
    setQuery("");
    setRenaming(null);
    setAddr(null);
    setLinkAsk(null);
  }, []);
  useEffect(() => {
    if (props.navRequest) navigate(props.navRequest.loc);
    // Only when the sidebar asks again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.navRequest?.n]);
  const { onLocation } = props;
  useEffect(() => {
    onLocation?.(loc);
  }, [loc, onLocation]);

  // Search: clips by name / game / tags, plus any file on disk with the words.
  const q = query.trim();
  const searchRoots = useMemo(
    () => (everywhere || loc.kind !== "folder" ? [saveDir, ...externals] : [loc.path]),
    [everywhere, loc, saveDir, externals],
  );
  useEffect(() => {
    if (!native || q.length < 2) return;
    let alive = true;
    const t = window.setTimeout(() => {
      fs.search(searchRoots, q, 500)
        .then((items) => alive && setDiskHits({ q, items }))
        .catch(() => alive && setDiskHits({ q, items: [] }));
    }, 250);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [q, searchRoots, native, tick]);

  const roots = useMemo(() => [saveDir, ...externals], [saveDir, externals]);
  const inRoots = useCallback((p: string) => roots.some((r) => X.samePath(r, p) || X.isInside(p, r)), [roots]);
  const atRoot = loc.kind === "folder" && X.samePath(loc.path, saveDir);
  const clipPaths = useMemo(() => new Set(clips.map((c) => X.normPath(c.path))), [clips]);
  const shownErr = listErr && folderPath && X.samePath(listErr.dir, folderPath) ? listErr.msg : null;
  const entries = useMemo(() => {
    let list: X.Entry[];
    if (q) {
      const hits = X.searchClips(clips, q, everywhere || loc.kind !== "folder" ? null : loc.path);
      list = diskHits.q === q ? [...hits, ...X.extraHits(hits, diskHits.items, clipPaths)] : hits;
    } else if (loc.kind === "all") list = X.allClips(clips);
    else if (loc.kind === "recent") return X.filterKind(X.recentClips(clips), prefs.kind);
    else if (shownErr) list = [];
    else {
      list = X.folderContents(clips, dirs, loc.path, atRoot ? externals : []);
      if (listing && X.samePath(listing.dir, loc.path)) list = X.mergeListing(list, listing.items, loc.path);
    }
    return X.sortEntries(X.filterKind(list, prefs.kind), prefs.sort);
  }, [clips, dirs, loc, q, everywhere, externals, atRoot, prefs.sort, prefs.kind, listing, diskHits, clipPaths, shownErr]);
  const order = useMemo(() => entries.map(X.entryPath), [entries]);
  const { onOrder } = props;
  useEffect(() => onOrder?.(order), [order, onOrder]);
  const byPath = useMemo(() => new Map(entries.map((e) => [X.normPath(X.entryPath(e)), e])), [entries]);
  const find = useCallback((p: string | null) => (p ? byPath.get(X.normPath(p)) : undefined), [byPath]);

  // ------------------------------------------------------------ geometry
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setBox((b) => ({ ...b, w: el.clientWidth, h: el.clientHeight }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [prefs.view, prefs.preview]);
  const onScroll = () => setBox((b) => ({ ...b, top: scrollRef.current?.scrollTop ?? 0 }));
  const tileW = prefs.size;
  const cols = Math.max(1, Math.floor((box.w - 16 + GAP) / (tileW + GAP)));
  const tileH = Math.round((tileW * 9) / 16) + LABEL_H;
  const pitch = prefs.view === "grid" ? tileH + GAP : ROW_H;
  const perRow = prefs.view === "grid" ? cols : 1;
  const rows = Math.ceil(entries.length / perRow);
  const first = Math.max(0, Math.floor(box.top / pitch) - 2);
  const last = Math.min(rows, Math.ceil((box.top + box.h) / pitch) + 2);
  const visible = entries.slice(first * perRow, last * perRow);

  // Ctrl + wheel: picture size, like File Explorer (a passive React wheel
  // handler could not stop the page zoom).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setPrefs((p) => ({ ...p, view: "grid", size: Math.min(360, Math.max(120, p.size + (e.deltaY < 0 ? 20 : -20))) }));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const ensureVisible = (path: string) => {
    const i = order.findIndex((p) => X.samePath(p, path));
    const el = scrollRef.current;
    if (i < 0 || !el) return;
    const row = Math.floor(i / perRow);
    const top = row * pitch;
    const fit = () => {
      if (top < el.scrollTop) el.scrollTop = top;
      else if (top + pitch + 16 > el.scrollTop + el.clientHeight) el.scrollTop = top + pitch + 16 - el.clientHeight;
    };
    fit();
    // Selecting can show the status line under the list, which makes it
    // shorter: check again once that layout is in.
    requestAnimationFrame(fit);
  };

  // ------------------------------------------------------------ selection
  const select = (path: string, e: { ctrlKey: boolean; shiftKey: boolean; metaKey?: boolean }) => {
    const ctrl = e.ctrlKey || !!e.metaKey;
    setFocus(path);
    if (e.shiftKey && anchorRef.current) {
      const a = order.findIndex((p) => X.samePath(p, anchorRef.current!));
      const b = order.findIndex((p) => X.samePath(p, path));
      if (a >= 0 && b >= 0) {
        const range = order.slice(Math.min(a, b), Math.max(a, b) + 1);
        onSelection(ctrl ? [...new Set([...selected, ...range])] : range, anchorRef.current);
        return;
      }
    }
    anchorRef.current = path;
    if (ctrl) onSelection(selected.has(path) ? [...selected].filter((p) => p !== path) : [...selected, path], path);
    else onSelection([path], path);
  };
  const selection = useMemo(() => order.filter((p) => selected.has(p)), [order, selected]);
  const selectedEntries = selection.map((p) => find(p)).filter((e): e is X.Entry => !!e);
  const selectedClips = selectedEntries.flatMap((e) => (e.kind === "clip" ? [e.clip] : []));
  const single = selectedEntries.length === 1 ? selectedEntries[0] : null;

  // ------------------------------------------------------------ actions
  const currentDir = loc.kind === "folder" ? loc.path : saveDir;
  const pushUndo = (step: UndoStep) => setUndo((u) => [...u.slice(-29), step]);
  const run = async <T,>(what: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      const r = await fn();
      refresh();
      return r;
    } catch (err) {
      onToast("err", what, friendly(err));
      refresh();
      return undefined;
    }
  };
  const doUndo = () => {
    const step = undo[undo.length - 1];
    if (!step) return onToast("info", "Nothing to undo");
    setUndo((u) => u.slice(0, -1));
    void run("Could not undo", async () => {
      await step.run();
      onToast("ok", `Undone: ${step.label}`);
    });
  };

  const openEntry = (e: X.Entry) => {
    if (e.kind === "folder") return navigate({ kind: "folder", path: e.path });
    if (e.kind === "clip") return props.onOpen(e.clip);
    if (native && isShowablePicture(e.name)) {
      void popOutPicturePath(e.path).catch((err) => onToast("err", "Could not open the picture", friendly(err)));
      return;
    }
    openDefault(e.path);
  };
  const openDefault = (path: string) => void lastshot.openClip(path).catch((err) => onToast("err", "Could not open it", friendly(err)));
  const openWith = (path: string) => void fs.openWith(path).catch((err) => onToast("err", "Could not open “Open with”", friendly(err)));
  const properties = (path: string) => void fs.properties(path).catch((err) => onToast("err", "Could not show Properties", friendly(err)));
  const copyPath = (paths: string[]) => {
    const text = paths.map((p) => (/\s/.test(p) ? `"${p}"` : p)).join("\r\n");
    void navigator.clipboard
      ?.writeText(text)
      .then(() => onToast("ok", paths.length === 1 ? "Path copied" : `${paths.length} paths copied`, paths.length === 1 ? paths[0] : undefined))
      .catch((err) => onToast("err", "Could not copy the path", String(err)));
  };

  // Repair / convert to MP4: path -> progress 0-1 (-1 while it is being checked).
  const [repairs, setRepairs] = useState<ReadonlyMap<string, number>>(() => new Map());
  useEffect(() => {
    let off: (() => void) | undefined;
    let alive = true;
    void lastshot
      .onRepairProgress((p) =>
        setRepairs((m) => {
          const k = [...m.keys()].find((x) => X.samePath(x, p.path));
          return k ? new Map(m).set(k, Math.max(0, Math.min(1, p.progress))) : m;
        }),
      )
      .then((u) => (alive ? (off = u) : u()));
    return () => {
      alive = false;
      off?.();
    };
  }, []);
  const repairOf = (p: string): number | undefined => {
    for (const [k, v] of repairs) if (X.samePath(k, p)) return v;
    return undefined;
  };
  const repairText = (v: number) => (v < 0 ? "Checking…" : `${Math.round(v * 100)}%`);
  /** Checks the file first; repairs or converts it only when that helps. */
  const repair = (path: string) => {
    if (repairOf(path) !== undefined) return;
    const convert = /\.mkv$/i.test(path);
    setRepairs((m) => new Map(m).set(path, -1));
    void (async () => {
      try {
        const d = await lastshot.diagnoseClip(path);
        if (d.need === "nothing") return onToast("ok", "This file is fine", d.message || `${X.baseName(path)} plays as it is.`);
        if (d.need === "unfixable") return onToast("err", "This file can't be repaired", d.message);
        setRepairs((m) => new Map(m).set(path, 0));
        const r = await lastshot.repairClip(path);
        onToast("ok", d.need === "remux" ? "Converted to MP4" : "Repaired", r.message || X.baseName(r.path));
        if (r.newFile) {
          anchorRef.current = r.path;
          setFocus(r.path);
          onSelection([r.path], r.path);
        }
        refresh();
      } catch (err) {
        onToast("err", convert ? "Could not convert the file" : "Could not repair the file", friendly(err));
      } finally {
        setRepairs((m) => {
          const n = new Map(m);
          for (const k of n.keys()) if (X.samePath(k, path)) n.delete(k);
          return n;
        });
      }
    })();
  };

  const newFolder = () => {
    if (loc.kind !== "folder") return;
    void run("Could not make a folder", async () => {
      const p = await lastshot.createClipFolder(currentDir, "New folder");
      pushUndo({ label: `New folder “${X.baseName(p)}”`, run: () => lastshot.recycleItems([p]) });
      onSelection([p], p);
      setFocus(p);
      setRenaming({ path: p });
    });
  };

  const recycle = (paths: string[]) => {
    const list = paths.filter((p) => !roots.some((r) => X.samePath(r, p)));
    if (list.length < paths.length) onToast("info", "Linked folders are not deleted", "Use “Remove link” to take a folder out of Lastshot; its files stay.");
    if (!list.length) return;
    void run("Could not delete", async () => {
      const n = await lastshot.recycleItems(list);
      onSelection([], null);
      pushUndo({
        label: `Delete ${plural(n, "item")}`,
        run: async () => {
          const back = await fs.restore(list);
          if (!back.length) throw new Error("They are no longer in the Recycle Bin");
        },
      });
      onToast("warn", `Moved ${plural(n, "item")} to the Recycle Bin`, "Ctrl+Z puts them back.");
    });
  };

  /** Copy or move into a clips folder, like File Explorer (names never clash). */
  const transfer = (paths: string[], dest: string, mode: "copy" | "move") => {
    const list = paths.filter((p) => !X.samePath(p, dest) && !X.isInside(dest, p) && !(mode === "move" && X.samePath(X.parentOf(p), dest)));
    if (!list.length) return;
    void run(mode === "copy" ? "Could not copy" : "Could not move", async () => {
      const pairs = await fs.transfer(list, dest, mode);
      if (!pairs.length) return;
      for (const [from, to] of pairs) repointPin(from, to);
      pushUndo(
        mode === "move"
          ? { label: `Move ${plural(pairs.length, "item")}`, run: () => fs.moveBack(pairs) }
          : { label: `Copy ${plural(pairs.length, "item")}`, run: () => lastshot.recycleItems(pairs.map((p) => p[1])) },
      );
      const tos = pairs.map((p) => p[1]);
      if (X.samePath(dest, currentDir)) onSelection(tos, tos[0]);
      onToast("ok", `${mode === "copy" ? "Copied" : "Moved"} ${plural(pairs.length, "item")}`, `to ${X.baseName(dest)}`);
    });
  };

  const link = async (dirsToLink: string[]) => {
    const fresh = dirsToLink.filter((d) => !roots.some((r) => X.samePath(r, d)));
    if (!props.onLinkFolders) return onToast("info", "Linking folders works in the app");
    if (!fresh.length) return onToast("info", "Already in your library", dirsToLink.join("\n"));
    await props.onLinkFolders(fresh);
    pushUndo({ label: `Link ${plural(fresh.length, "folder")}`, run: async () => void (await Promise.all(fresh.map((d) => props.onUnlinkFolder?.(d)))) });
  };
  const unlink = async (dir: string) => {
    if (!props.onUnlinkFolder) return;
    await props.onUnlinkFolder(dir);
    if (loc.kind === "folder" && (X.samePath(loc.path, dir) || X.isInside(loc.path, dir))) navigate({ kind: "folder", path: saveDir });
    pushUndo({ label: `Remove link to ${X.baseName(dir)}`, run: async () => void (await props.onLinkFolders?.([dir])) });
    onToast("ok", `${X.baseName(dir)} is no longer in Clips`, "Nothing was deleted. Ctrl+Z links it again.");
  };
  const pickAndLink = async () => {
    if (!native) return onToast("info", "Browser preview", "Use the installed app to link folders.");
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const dir = await open({ directory: true, multiple: true, title: "Show these folders in Lastshot (they are linked, not copied)" });
      const list = (Array.isArray(dir) ? dir : dir ? [dir] : []).filter((d): d is string => typeof d === "string");
      if (list.length) await link(list);
    } catch (err) {
      onToast("err", "Could not link the folder", friendly(err));
    }
  };

  const startRename = (path: string) => {
    renameDone.current = false;
    setRenaming({ path });
  };
  const commitRename = (path: string, name: string) => {
    if (renameDone.current) return;
    renameDone.current = true;
    setRenaming(null);
    rootRef.current?.focus({ preventScroll: true });
    const old = X.baseName(path);
    const e = find(path);
    const v = name.trim();
    if (!v || v === old || (e?.kind === "clip" && v === X.displayName(e.clip))) return;
    void (async () => {
      try {
        const p = await lastshot.renameLibraryItem(path, v);
        repointPin(path, p);
        pushUndo({ label: `Rename “${X.baseName(p)}”`, run: () => lastshot.renameLibraryItem(p, old) });
        onSelection([p], p);
        setFocus(p);
        refresh();
      } catch (err) {
        onToast("err", "Could not rename", friendly(err));
        // Keep what was typed so it can be fixed (a taken name, a bad character).
        renameDone.current = false;
        setRenaming({ path, draft: v });
      }
    })();
  };

  const copySel = (cut: boolean) => {
    if (!selection.length) return;
    const list = cut ? selection.filter((p) => !roots.some((r) => X.samePath(r, p))) : selection;
    if (!list.length) return;
    if (!native) {
      setCutPaths(cut ? list : []);
      return;
    }
    void fs
      .setClipboard(list, cut)
      .then(() => {
        setCutPaths(cut ? list : []);
        onToast("ok", `${cut ? "Cut" : "Copied"} ${plural(list.length, "item")}`, cut ? "Ctrl+V in a folder moves them there." : "Paste into Discord, File Explorer, or Ctrl+V in a folder here.");
      })
      .catch((err) => onToast("err", "Clipboard failed", friendly(err)));
  };
  const paste = () => {
    const dest = currentDir;
    if (!native) {
      if (cutPaths.length) transfer(cutPaths, dest, "move");
      setCutPaths([]);
      return;
    }
    void fs.clipboardFiles().then(({ paths, cut }) => {
      if (!paths.length) return onToast("info", "Nothing to paste", "Copy files here or in File Explorer first.");
      transfer(paths, dest, cut ? "move" : "copy");
      if (cut) {
        setCutPaths([]);
        void fs.setClipboard([], false).catch(() => undefined);
      }
    });
  };

  const up = () => {
    const u = X.upOf(loc, saveDir, externals);
    if (u) navigate(u);
  };
  const goAddress = (raw: string) => {
    const p = raw.trim().replace(/^"|"$/g, "").replace(/[\\/]+$/, "");
    setAddr(null);
    rootRef.current?.focus({ preventScroll: true });
    if (!p || /^clips$/i.test(p)) return navigate({ kind: "folder", path: saveDir });
    if (/^(all|all clips)$/i.test(p)) return navigate({ kind: "all" });
    if (/^recent$/i.test(p)) return navigate({ kind: "recent" });
    if (inRoots(p)) return navigate({ kind: "folder", path: p });
    if (!native) return;
    void fs
      .listDir(p)
      .then(() => setLinkAsk(p))
      .catch((err) => onToast("err", "Can't open that folder", friendly(err)));
  };

  // ------------------------------------------------------------ keys
  const focusIdx = focus ? order.findIndex((p) => X.samePath(p, focus)) : -1;
  const moveTo = (key: string, extend: boolean) => {
    const i = X.moveFocus(key, focusIdx, order.length, perRow, Math.max(1, Math.floor(box.h / pitch)));
    if (i < 0) return;
    const p = order[i];
    if (extend) select(p, { ctrlKey: false, shiftKey: true });
    else select(p, { ctrlKey: false, shiftKey: false });
    ensureVisible(p);
  };
  const modalOpen = () => !!document.querySelector('[role="dialog"][aria-modal="true"]') && !rootRef.current?.contains(document.querySelector('[role="dialog"][aria-modal="true"]'));
  const keysHere = () => {
    if (picker || modalOpen()) return false;
    const a = document.activeElement;
    return !a || a === document.body || !!rootRef.current?.contains(a);
  };
  const onItems = () => keysHere() && !menu && !renaming && !addr && !(document.activeElement instanceof HTMLButtonElement || document.activeElement instanceof HTMLSelectElement);
  const openMenuAtFocus = () => {
    const p = focus ?? selection[0];
    const el = p ? scrollRef.current?.querySelector(`[data-entry="${CSS.escape(p)}"]`) : null;
    const r = (el ?? scrollRef.current)?.getBoundingClientRect();
    if (!r) return;
    const target = p ? (find(p) ?? null) : null;
    if (target && !selected.has(X.entryPath(target))) onSelection([X.entryPath(target)], X.entryPath(target));
    setMenu({ x: r.left + 24, y: r.top + 24, target });
  };
  // What each key in CLIPS_KEYS does here (and when it applies).
  const acts: Record<string, [run: () => void, when: () => boolean]> = {
    back: [() => setHist(X.goBack), keysHere],
    forward: [() => setHist(X.goForward), keysHere],
    up: [up, onItems],
    address: [() => setAddr(loc.kind === "folder" ? loc.path : ""), keysHere],
    search: [() => searchRef.current?.focus(), keysHere],
    refresh: [refresh, keysHere],
    "new-folder": [newFolder, keysHere],
    open: [() => selectedEntries.length === 1 && openEntry(selectedEntries[0]), () => onItems() && selectedEntries.length === 1],
    "open-default": [() => single && single.kind !== "folder" && openDefault(X.entryPath(single)), () => onItems() && !!single],
    rename: [() => selection.length === 1 && startRename(selection[0]), () => onItems() && selection.length === 1],
    delete: [() => recycle(selection), () => onItems() && selection.length > 0],
    copy: [() => copySel(false), () => onItems() && selection.length > 0],
    cut: [() => copySel(true), () => onItems() && selection.length > 0],
    paste: [paste, () => onItems() && loc.kind === "folder"],
    "copy-path": [() => copyPath(selection.length ? selection : [currentDir]), onItems],
    undo: [doUndo, () => onItems() && undo.length > 0],
    properties: [() => properties(single ? X.entryPath(single) : currentDir), () => onItems() && native],
    "select-all": [() => onSelection(order, order[0] ?? null), onItems],
    "toggle-select": [() => focus && select(focus, { ctrlKey: true, shiftKey: false }), () => onItems() && !!focus],
    menu: [openMenuAtFocus, onItems],
    escape: [
      () => {
        if (places) setPlaces(false);
        else if (linkAsk) setLinkAsk(null);
        else if (q) setQuery("");
        else onSelection([], null);
      },
      () => keysHere() && !menu && !renaming && !addr && (places || !!linkAsk || !!q || selection.length > 0),
    ],
    preview: [() => setPrefs((p) => ({ ...p, preview: !p.preview })), keysHere],
    "view-grid": [() => setPrefs((p) => ({ ...p, view: "grid" })), keysHere],
    "view-details": [() => setPrefs((p) => ({ ...p, view: "details" })), keysHere],
  };
  for (const k of NAV_KEYS) {
    acts[`focus-${k.toLowerCase()}`] = [() => moveTo(k, false), onItems];
    acts[`extend-${k.toLowerCase()}`] = [() => moveTo(k, true), onItems];
  }
  useShortcuts(
    "clips",
    CLIPS_KEYS.map((s) => ({ ...s, run: () => acts[s.id]?.[0](), when: () => !!acts[s.id]?.[1]() })),
  );
  const tip = (label: string, id: string) => withKeys(label, "clips", id);

  // Type-ahead: typing a name jumps to it (letters the shortcuts don't use).
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.defaultPrevented || isTextField(e.target) || e.ctrlKey || e.altKey || e.metaKey || e.key.length !== 1) return;
    if (!onItems()) return;
    // A key some shortcut uses ("?" for the cheat sheet…) is not type-ahead.
    const combo = comboFromEvent(e.nativeEvent);
    if (activeShortcuts().some((s) => splitKeys(s.keys).includes(combo))) return;
    const now = Date.now();
    const t = typed.current;
    if (e.key === " " && (!t.text || now - t.at > 800)) return;
    t.text = now - t.at > 800 ? e.key : t.text + e.key;
    t.at = now;
    const i = X.typeAhead(entries.map(X.entryName), t.text, focusIdx);
    if (i >= 0) {
      select(order[i], { ctrlKey: false, shiftKey: false });
      ensureVisible(order[i]);
    }
    e.preventDefault();
  };
  // Mouse back / forward buttons.
  const onMouseUp = (e: React.MouseEvent) => {
    if (e.button === 3) setHist(X.goBack);
    if (e.button === 4) setHist(X.goForward);
  };

  // ------------------------------------------------------------ drag & drop
  const onDragStart = (e: React.DragEvent, path: string) => {
    const paths = selected.has(path) ? selection : [path];
    if (!selected.has(path)) onSelection([path], path);
    if (native) {
      // A real shell drag (CF_HDROP with the real paths): Discord, File
      // Explorer, other Lastshot windows and any app take it.
      e.preventDefault();
      dragOut.current = paths;
      void fs
        .startDrag(paths)
        .catch((err) => onToast("err", "Could not drag", friendly(err)))
        .finally(() => {
          window.setTimeout(() => (dragOut.current = []), 3500);
        });
      return;
    }
    e.dataTransfer.setData(MIME, JSON.stringify(paths));
    e.dataTransfer.effectAllowed = "copyMove";
  };
  const accepts = (dt: DataTransfer | null) => !!dt && (Array.from(dt.types).includes(MIME) || dragHasFiles(dt));
  const handleDrop = async (dt: DataTransfer, dest: string, keys: { ctrlKey: boolean; shiftKey: boolean }) => {
    let items: DroppedItem[] = [];
    const mine = dt.getData(MIME);
    if (mine) {
      try {
        items = (JSON.parse(mine) as string[]).map((path) => ({ path, dir: find(path)?.kind === "folder" }));
      } catch {
        items = [];
      }
    } else {
      items = await droppedPaths(dt);
      if (!items.length && dragOut.current.length) items = dragOut.current.map((path) => ({ path, dir: find(path)?.kind === "folder" }));
    }
    dragOut.current = [];
    if (!items.length) return onToast("err", "Could not read what was dropped", "Try dragging it again, or use Copy and Paste.");
    // Folders from outside the library are linked, never copied.
    const outside = items.filter((i) => i.dir && !inRoots(i.path)).map((i) => i.path);
    const rest = items.filter((i) => !(i.dir && !inRoots(i.path))).map((i) => i.path);
    if (outside.length) await link(outside);
    if (rest.length) transfer(rest, dest, dropMode(rest[0], dest, keys));
  };
  const dropProps = (dest: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!accepts(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      // Lastshot's own drags offer copy and link only (so a drop on the
      // desktop never moves a clip away); what happens here follows File
      // Explorer's rules (see dropMode), decided on drop.
      e.dataTransfer.dropEffect = "copy";
      setDropOn(dest);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      setDropOn((d) => (d === dest ? null : d));
    },
    onDrop: (e: React.DragEvent) => {
      if (!accepts(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      setDropOn(null);
      void handleDrop(e.dataTransfer, dest, { ctrlKey: e.ctrlKey, shiftKey: e.shiftKey });
    },
  });

  // ------------------------------------------------------------ rubber band
  const onBgMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0 || prefs.view !== "grid" || (e.target as HTMLElement).closest("[data-entry]")) return;
    const el = scrollRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (e.clientX > r.left + el.clientWidth) return; // the scrollbar
    const at = (ev: MouseEvent | React.MouseEvent) => ({ x: ev.clientX - r.left - 8, y: ev.clientY - r.top + el.scrollTop - 8 });
    const s = at(e);
    const base = e.ctrlKey ? [...selected] : [];
    let moved = false;
    const move = (ev: MouseEvent) => {
      const p = at(ev);
      if (!moved && Math.hypot(p.x - s.x, p.y - s.y) < 5) return;
      moved = true;
      bandedRef.current = true;
      const rect = { x0: s.x, y0: s.y, x1: p.x, y1: p.y };
      setBand(rect);
      const hit = X.tilesInRect(rect, entries.length, cols, tileW, tileH, GAP).map((i) => order[i]);
      onSelection([...new Set([...base, ...hit])], hit[0] ?? null);
    };
    const upH = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", upH);
      setBand(null);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", upH);
  };

  // ------------------------------------------------------------ menu
  const openMenu = (e: React.MouseEvent, target: X.Entry | null) => {
    e.preventDefault();
    e.stopPropagation();
    if (target && !selected.has(X.entryPath(target))) {
      anchorRef.current = X.entryPath(target);
      setFocus(X.entryPath(target));
      onSelection([X.entryPath(target)], X.entryPath(target));
    }
    setMenu({ x: e.clientX, y: e.clientY, target });
  };
  useEffect(() => {
    if (!menu && !places) return;
    const close = () => {
      setMenu(null);
      setPlaces(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [menu, places]);
  useEffect(() => {
    if (menu) menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [menu]);
  const closeMenu = () => {
    setMenu(null);
    rootRef.current?.focus({ preventScroll: true });
  };
  const onMenuKey = (e: React.KeyboardEvent) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") closeMenu();
    else if (e.key === "ArrowDown") items[(i + 1) % items.length]?.focus();
    else if (e.key === "ArrowUp") items[(i - 1 + items.length) % items.length]?.focus();
    else if (e.key === "Home") items[0]?.focus();
    else if (e.key === "End") items[items.length - 1]?.focus();
    else if (e.key === "Tab") closeMenu();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const isLinkRoot = (p: string) => externals.some((x) => X.samePath(x, p));
  const menuItems = (): MenuItem[] => {
    const t = menu?.target ?? null;
    const many = selection.length;
    if (!t) {
      const folder = loc.kind === "folder";
      return [
        { label: "New folder", key: "Ctrl+Shift+N", run: newFolder, off: !folder },
        { label: cutPaths.length ? "Paste (move here)" : "Paste", key: "Ctrl+V", run: paste, off: !folder },
        { label: undo.length ? `Undo ${undo[undo.length - 1].label.toLowerCase()}` : "Undo", key: "Ctrl+Z", run: doUndo, off: !undo.length },
        { label: "Select all", key: "Ctrl+A", run: () => onSelection(order, order[0] ?? null), off: !order.length },
        "-",
        { label: "Link a folder…", run: () => void pickAndLink(), off: !props.onLinkFolders },
        ...(folder ? [{ label: isPinned(loc.path, pins) ? "Unpin from Places" : "Pin to Places", run: () => togglePin(loc.path) }] : []),
        ...(folder && isLinkRoot(loc.path) ? [{ label: "Remove link (keeps the files)", run: () => void unlink(loc.path) }] : []),
        { label: "Show in File Explorer", run: () => props.onReveal(currentDir) },
        { label: "Copy path", key: "Ctrl+Shift+C", run: () => copyPath([currentDir]) },
        { label: "Refresh", key: "F5", run: refresh },
        "-",
        { label: "Pictures", check: prefs.view === "grid", run: () => setPrefs((p) => ({ ...p, view: "grid" })) },
        { label: "Details", check: prefs.view === "details", run: () => setPrefs((p) => ({ ...p, view: "details" })) },
        { label: "Preview pane", key: "Alt+P", check: prefs.preview, run: () => setPrefs((p) => ({ ...p, preview: !p.preview })) },
        { label: "Play videos on hover", check: prefs.hoverPlay, run: () => setPrefs((p) => ({ ...p, hoverPlay: !p.hoverPlay })) },
        ...(native ? ["-" as const, { label: "Properties", key: "Alt+Enter", run: () => properties(currentDir) }] : []),
      ];
    }
    const path = X.entryPath(t);
    const clip = t.kind === "clip" ? t.clip : null;
    const isRoot = roots.some((r) => X.samePath(r, path));
    const picture = t.kind === "file" && isShowablePicture(t.name);
    return [
      { label: t.kind === "folder" ? "Open" : clip ? "Open in editor" : picture ? "Open in a frame" : "Open", key: "Enter", run: () => openEntry(t), off: many > 1 },
      ...(clip && props.onAddToEditor ? [{ label: many > 1 ? `Add ${selectedClips.length} clips to the edit` : "Add to the edit", run: () => props.onAddToEditor?.(selectedClips.length ? selectedClips.map((c) => c.path) : [clip.path]) }] : []),
      ...(clip
        ? [
            { label: "Play", run: () => props.onPlay(clip), off: many > 1 },
            ...(props.onPopOut ? [{ label: "Pop out (on top, see-through)", run: () => props.onPopOut?.(clip), off: many > 1 }] : []),
          ]
        : []),
      ...(t.kind !== "folder" && native
        ? [
            { label: "Open in default app", key: "Ctrl+Enter", run: () => openDefault(path), off: many > 1 },
            { label: "Open with…", run: () => openWith(path), off: many > 1 },
          ]
        : []),
      ...(clip
        ? [
            { label: "Copy for Discord", run: () => props.onCopyForDiscord(selectedClips.map((c) => c.path)) },
            { label: "Shrink & copy", run: () => props.onShare(clip), off: many > 1 },
            { label: clip.favorite ? "Unstar" : "Star", run: () => props.onToggleFavorite(clip), off: many > 1 },
          ]
        : []),
      ...(clip || (t.kind === "file" && fileKind(t.name) === "video")
        ? [
            {
              label: /\.mkv$/i.test(path) ? "Convert to MP4" : "Repair / convert to MP4",
              run: () => repair(path),
              off: many > 1 || repairOf(path) !== undefined,
            },
          ]
        : []),
      "-",
      { label: "Cut", key: "Ctrl+X", run: () => copySel(true), off: isRoot },
      { label: "Copy", key: "Ctrl+C", run: () => copySel(false) },
      { label: "Copy path", key: "Ctrl+Shift+C", run: () => copyPath(selection) },
      { label: "Rename", key: "F2", run: () => startRename(path), off: many > 1 },
      { label: "Move to…", run: () => setPicker({ mode: "move", paths: selection }), off: isRoot },
      { label: "Copy to…", run: () => setPicker({ mode: "copy", paths: selection }) },
      ...(t.kind === "folder" ? [{ label: isPinned(path, pins) ? "Unpin from Places" : "Pin to Places", run: () => togglePin(path), off: many > 1 }] : []),
      { label: "Show in File Explorer", run: () => props.onReveal(path) },
      "-",
      ...(isRoot && isLinkRoot(path)
        ? [{ label: "Remove link (keeps the files)", run: () => void unlink(path), off: many > 1 }]
        : [{ label: many > 1 ? `Delete ${many} items` : "Delete", key: "Del", danger: true, run: () => recycle(selection) }]),
      ...(native ? [{ label: "Properties", key: "Alt+Enter", run: () => properties(path), off: many > 1 }] : []),
    ];
  };

  // ------------------------------------------------------------ render
  const crumbs = X.breadcrumb(loc, saveDir, externals);
  const sizeOf = (e: X.Entry) => (e.kind === "clip" ? e.clip.size_bytes : e.kind === "file" ? e.size : e.bytes);
  const totalBytes = entries.reduce((a, e) => a + sizeOf(e), 0);
  const selBytes = selectedEntries.reduce((a, e) => a + sizeOf(e), 0);
  const btn = "rounded-md border border-line bg-surface px-2 py-1 text-[11px] text-ink-3 transition-colors hover:border-line-3 hover:text-ink disabled:opacity-35";
  const isVideoEntry = (e: X.Entry) => e.kind === "clip" || (e.kind === "file" && fileKind(e.name) === "video");

  const hoverIn = (e: X.Entry) => {
    window.clearTimeout(hoverTimer.current);
    if (!prefs.hoverPlay || !native || !isVideoEntry(e)) return;
    const p = X.entryPath(e);
    hoverTimer.current = window.setTimeout(() => setHover(p), 450);
  };
  const hoverOut = () => {
    window.clearTimeout(hoverTimer.current);
    setHover(null);
  };

  const nameEl = (e: X.Entry, path: string) => {
    if (renaming && X.samePath(renaming.path, path)) {
      const full = renaming.draft ?? X.baseName(path);
      const stem = splitExt(full, e.kind === "folder")[0].length;
      return (
        <input
          autoFocus
          defaultValue={full}
          aria-label="New name"
          spellCheck={false}
          onFocus={(ev) => ev.currentTarget.setSelectionRange(0, stem)}
          onClick={(ev) => ev.stopPropagation()}
          onDoubleClick={(ev) => ev.stopPropagation()}
          onMouseDown={(ev) => ev.stopPropagation()}
          onKeyDown={(ev) => {
            ev.stopPropagation();
            if (ev.key === "Enter") commitRename(path, ev.currentTarget.value);
            if (ev.key === "Escape") {
              renameDone.current = true;
              setRenaming(null);
              rootRef.current?.focus({ preventScroll: true });
            }
          }}
          onBlur={(ev) => commitRename(path, ev.currentTarget.value)}
          className="w-full rounded border border-accent bg-app px-1 text-[11px] text-ink outline-none"
        />
      );
    }
    return (
      <span className="truncate" title={path}>
        {e.kind === "clip" ? X.displayName(e.clip) : e.name}
      </span>
    );
  };

  const picture = (e: X.Entry, small = false) => {
    const path = X.entryPath(e);
    if (e.kind === "folder")
      return (
        <>
          <Thumb path={e.latest?.path ?? null} have={e.latest?.thumbnail} className="opacity-70" />
          {!small && <div className="absolute inset-0 bg-gradient-to-t from-black/70 to-transparent" />}
        </>
      );
    if (e.kind === "clip") return <Thumb path={path} have={e.clip.thumbnail} />;
    if (isShowablePicture(e.name)) return <PictureThumb path={path} />;
    if (fileKind(e.name) === "video") return <Thumb path={path} />;
    return <KindIcon name={e.name} small={small} />;
  };

  const entryView = (e: X.Entry, i: number) => {
    const path = X.entryPath(e);
    const sel = selected.has(path);
    const focused = !!focus && X.samePath(focus, path);
    const isCut = cutPaths.some((p) => X.samePath(p, path));
    const isRenaming = !!renaming && X.samePath(renaming.path, path);
    const common = {
      "data-entry": path,
      draggable: !isRenaming,
      onDragStart: (ev: React.DragEvent) => onDragStart(ev, path),
      onClick: (ev: React.MouseEvent) => {
        ev.stopPropagation();
        select(path, ev);
      },
      onDoubleClick: () => !isRenaming && openEntry(e),
      onContextMenu: (ev: React.MouseEvent) => openMenu(ev, e),
      onMouseEnter: () => hoverIn(e),
      onMouseLeave: hoverOut,
      ...(e.kind === "folder" ? dropProps(e.path) : {}),
    };
    if (prefs.view === "details") {
      const c = e.kind === "clip" ? e.clip : null;
      const typeLabel =
        e.kind === "clip"
          ? X.clipGame(e.clip)
          : e.kind === "folder"
            ? e.count
              ? plural(e.count, "clip")
              : "Folder"
            : `${splitExt(e.name)[1].slice(1).toUpperCase() || "File"} ${fileKind(e.name) === "other" ? "file" : fileKind(e.name)}`;
      const date = e.kind === "clip" ? e.clip.created_unix_ms : e.kind === "folder" ? (e.latest?.created_unix_ms ?? 0) : e.modified;
      return (
        <div
          key={path}
          {...common}
          role="row"
          aria-selected={sel}
          style={{ position: "absolute", top: (first * perRow + i) * ROW_H, left: 0, right: 0, height: ROW_H, gridTemplateColumns: GRID_TEMPLATE }}
          className={cn(
            "group grid cursor-default select-none items-center gap-3 rounded px-2 text-[11px]",
            sel ? "bg-accent/20 text-ink" : "text-ink-2 hover:bg-surface-3",
            focused && "outline outline-1 -outline-offset-1 outline-accent/60",
            dropOn === path && "ring-1 ring-accent",
            isCut && "opacity-50",
          )}
        >
          <span className="flex min-w-0 items-center gap-2">
            {e.kind === "folder" ? (
              <FolderIcon className="h-4 w-8 shrink-0 text-amber-400/90" />
            ) : (
              <span className="relative h-[18px] w-8 shrink-0 overflow-hidden rounded-sm">{picture(e, true)}</span>
            )}
            {nameEl(e, path)}
            {repairOf(path) !== undefined && (
              <span className="shrink-0 font-mono text-[10px] text-accent-fg">{repairText(repairOf(path)!)}</span>
            )}
            {c?.favorite && <span className="text-warn">★</span>}
            {e.kind === "file" && e.readonly && <span className="text-[9px] text-ink-4" title="Read-only">RO</span>}
            {c && <EditBtn onClick={() => props.onOpen(c)} className="ml-auto opacity-0 group-hover:opacity-100" />}
          </span>
          <span className="truncate text-ink-3">{typeLabel}</span>
          <span className="text-ink-3">{fmtDate(date)}</span>
          <span className="font-mono text-ink-3">{c ? formatDuration(c.duration_seconds) : ""}</span>
          <span className="font-mono text-ink-3">{e.kind === "folder" && !e.count ? "" : formatBytes(sizeOf(e))}</span>
          <span className="font-mono text-ink-3">{c && c.width ? `${c.width}×${c.height}` : ""}</span>
        </div>
      );
    }
    const idx = first * perRow + i;
    const live = hover && X.samePath(hover, path) && !isRenaming;
    return (
      <div
        key={path}
        {...common}
        role="option"
        aria-selected={sel}
        style={{ position: "absolute", left: 8 + (idx % cols) * (tileW + GAP), top: 8 + Math.floor(idx / cols) * (tileH + GAP), width: tileW, height: tileH }}
        className={cn(
          "group cursor-default select-none overflow-hidden rounded-lg border",
          sel ? "border-accent bg-accent/15" : "border-line bg-surface hover:border-line-3",
          focused && "outline outline-2 outline-offset-1 outline-accent/50",
          dropOn === path && "ring-2 ring-accent",
          isCut && "opacity-50",
        )}
      >
        <div className="relative w-full overflow-hidden bg-surface-4" style={{ height: tileH - LABEL_H }}>
          {picture(e)}
          {live && <video src={assetUrl(path)} muted autoPlay loop playsInline className="absolute inset-0 h-full w-full bg-black object-cover" />}
          {e.kind === "folder" ? (
            <>
              <FolderIcon className="absolute left-2 top-2 h-6 w-6 text-amber-400 drop-shadow" />
              <span className="absolute bottom-1.5 left-2 font-mono text-[10px] text-white/90">
                {e.count ? `${plural(e.count, "clip")} · ${formatBytes(e.bytes)}` : "Folder"}
              </span>
              {e.external && <span className="absolute right-1.5 top-1.5 rounded bg-black/60 px-1 text-[9px] text-white/80">Linked</span>}
              {isPinned(e.path, pins) && <span className="absolute right-1.5 bottom-1.5 text-[10px] text-white/80" title="Pinned">📌</span>}
            </>
          ) : e.kind === "clip" ? (
            <>
              <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 font-mono text-[10px] text-white">{formatDuration(e.clip.duration_seconds)}</span>
              {e.clip.favorite && <span className="absolute left-1.5 top-1 text-warn drop-shadow">★</span>}
              <EditBtn onClick={() => props.onOpen(e.clip)} className="absolute right-1.5 top-1.5 opacity-0 group-hover:opacity-100 focus:opacity-100" />
              {props.shareProgress?.has(e.clip.path) && (
                <span className="absolute bottom-1 left-1 rounded bg-black/70 px-1 font-mono text-[10px] text-white">
                  {Math.round((props.shareProgress.get(e.clip.path) ?? 0) * 100)}%
                </span>
              )}
            </>
          ) : null}
          {e.kind !== "folder" && repairOf(path) !== undefined && (
            <>
              <span className="absolute left-1 top-1 rounded bg-black/75 px-1.5 py-0.5 text-[10px] text-white" data-testid="repair-progress">
                {/\.mkv$/i.test(path) ? "Converting" : "Repairing"} {repairText(repairOf(path)!)}
              </span>
              <span className="absolute inset-x-0 bottom-0 h-1 bg-black/50">
                <span
                  className={cn("block h-full bg-accent transition-[width] duration-300", repairOf(path)! < 0 && "animate-pulse")}
                  style={{ width: `${repairOf(path)! < 0 ? 100 : Math.max(3, repairOf(path)! * 100)}%` }}
                />
              </span>
            </>
          )}
        </div>
        <div className="flex h-[46px] flex-col justify-center gap-0.5 px-2 text-[11px] text-ink">
          {nameEl(e, path)}
          <span className="truncate text-[10px] text-ink-3">
            {e.kind === "clip"
              ? [X.clipGame(e.clip), fmtDate(e.clip.created_unix_ms), formatBytes(e.clip.size_bytes)].filter(Boolean).join(" · ")
              : e.kind === "file"
                ? [fmtDate(e.modified), formatBytes(e.size)].join(" · ")
                : e.latest
                  ? `Newest ${fmtDate(e.latest.created_unix_ms)}`
                  : e.external
                    ? X.parentOf(e.path)
                    : ""}
          </span>
        </div>
      </div>
    );
  };

  const shown = single ?? (focus ? find(focus) : undefined) ?? null;
  const placeList: { label: string; loc: X.Loc; hint?: string }[] = [
    { label: "Clips", loc: { kind: "folder", path: saveDir }, hint: saveDir },
    ...externals.map((x) => ({ label: X.baseName(x), loc: { kind: "folder" as const, path: x }, hint: x })),
    ...pins.map((p) => ({ label: `📌 ${p.name}`, loc: { kind: "folder" as const, path: p.path }, hint: p.path })),
    { label: "All clips", loc: { kind: "all" } },
    { label: "Recent", loc: { kind: "recent" } },
  ];
  const emptyText = props.loading
    ? "Reading your clips…"
    : q
      ? "Nothing found"
      : loc.kind === "recent"
        ? "No clips in the last 7 days"
        : prefs.kind !== "all"
          ? "Nothing of this kind here"
          : "This folder is empty. Drop files or a folder here.";
  const errIsLink = !!shownErr && !!folderPath && externals.some((x) => X.samePath(x, folderPath) || X.isInside(folderPath, x));

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onMouseUp={onMouseUp}
      className="flex min-h-0 flex-1 flex-col gap-2 outline-none"
      data-testid="clips-explorer"
      aria-label="Clips explorer"
    >
      {/* Toolbar: back / forward / up, places, path bar, search */}
      <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" className={btn} title={tip("Back", "back")} aria-label="Back" disabled={!hist.back.length} onClick={() => setHist(X.goBack)}>
          ←
        </button>
        <button type="button" className={btn} title={tip("Forward", "forward")} aria-label="Forward" disabled={!hist.fwd.length} onClick={() => setHist(X.goForward)}>
          →
        </button>
        <button type="button" className={btn} title={tip("Up a folder", "up")} aria-label="Up a folder" disabled={!X.upOf(loc, saveDir, externals)} onClick={up}>
          ↑
        </button>
        <div className="relative">
          <button
            type="button"
            className={btn}
            title="Places: your clips folders, linked and pinned folders"
            aria-haspopup="menu"
            aria-expanded={places}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => setPlaces((v) => !v)}
          >
            Places ▾
          </button>
          {places && (
            <div role="menu" onMouseDown={(e) => e.stopPropagation()} className="absolute left-0 top-full z-50 mt-1 w-64 rounded-lg border border-line-3 bg-surface-2 py-1 text-[12px] shadow-xl">
              {placeList.map((p, i) => (
                <button
                  key={i}
                  type="button"
                  role="menuitem"
                  title={p.hint}
                  onClick={() => {
                    setPlaces(false);
                    navigate(p.loc);
                  }}
                  {...(p.loc.kind === "folder" ? dropProps(p.loc.path) : {})}
                  className={cn("flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-3", X.sameLoc(p.loc, loc) ? "text-accent-fg" : "text-ink")}
                >
                  <span className="truncate">{p.label}</span>
                </button>
              ))}
              <div className="my-1 h-px bg-line" />
              <button
                type="button"
                role="menuitem"
                disabled={!props.onLinkFolders}
                onClick={() => {
                  setPlaces(false);
                  void pickAndLink();
                }}
                className="flex w-full px-3 py-1.5 text-left text-ink hover:bg-surface-3 disabled:opacity-35"
              >
                Link a folder…
              </button>
            </div>
          )}
        </div>
        {addr !== null ? (
          <input
            autoFocus
            value={addr}
            aria-label="Folder path"
            spellCheck={false}
            onChange={(e) => setAddr(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={() => setAddr(null)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") goAddress(e.currentTarget.value);
              if (e.key === "Escape") {
                setAddr(null);
                rootRef.current?.focus({ preventScroll: true });
              }
            }}
            className="min-w-0 flex-1 rounded-md border border-accent bg-surface px-2 py-1 font-mono text-[12px] text-ink outline-none"
          />
        ) : (
          <nav
            className="flex min-w-0 flex-1 cursor-text items-center gap-0.5 overflow-hidden rounded-md border border-line bg-surface px-1.5 py-0.5 text-[12px]"
            aria-label="Path"
            title={withKeys("Click empty space to type a path", "clips", "address")}
            onClick={(e) => e.target === e.currentTarget && setAddr(loc.kind === "folder" ? loc.path : "")}
          >
            {crumbs.map((c, i) => (
              <span key={i} className="flex min-w-0 items-center">
                {i > 0 && <span className="px-0.5 text-ink-4">›</span>}
                <button
                  type="button"
                  onClick={() => navigate(c.loc)}
                  {...(c.loc.kind === "folder" ? dropProps(c.loc.path) : {})}
                  className={cn(
                    "cursor-default truncate rounded px-1 py-0.5 hover:bg-surface-3",
                    i === crumbs.length - 1 ? "font-semibold text-ink" : "text-ink-3",
                    c.loc.kind === "folder" && dropOn === c.loc.path && "ring-1 ring-accent",
                  )}
                >
                  {c.label}
                </button>
              </span>
            ))}
            <span className="min-w-[24px] flex-1 self-stretch" onClick={() => setAddr(loc.kind === "folder" ? loc.path : "")} />
          </nav>
        )}
        <div className="flex items-center gap-1 rounded-md border border-line bg-surface px-1.5">
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                if (query) setQuery("");
                else rootRef.current?.focus({ preventScroll: true });
              }
              if (e.key === "Enter" || e.key === "ArrowDown") {
                e.preventDefault();
                rootRef.current?.focus({ preventScroll: true });
                if (order[0]) select(order[0], { ctrlKey: false, shiftKey: false });
              }
            }}
            placeholder={everywhere || loc.kind !== "folder" ? "Search everything" : `Search ${crumbs[crumbs.length - 1]?.label ?? ""}`}
            title={tip("Search names, games and tags", "search")}
            aria-label="Search"
            className="w-44 bg-transparent py-1 text-[11px] text-ink outline-none placeholder:text-ink-3"
          />
          {query && (
            <button type="button" aria-label="Clear search" className="text-[11px] text-ink-3 hover:text-ink" onClick={() => setQuery("")}>
              ✕
            </button>
          )}
          <label className="flex items-center gap-1 text-[10px] text-ink-3" title="Search every clips folder, not only this one">
            <input type="checkbox" checked={everywhere} onChange={(e) => setEverywhere(e.target.checked)} />
            All
          </label>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {(["folder", "all", "recent"] as const).map((k) => {
          const on = k === "folder" ? loc.kind === "folder" : loc.kind === k;
          return (
            <button
              key={k}
              type="button"
              onClick={() => navigate(k === "folder" ? { kind: "folder", path: saveDir } : { kind: k })}
              className={cn(btn, on && "border-accent/60 bg-accent/15 text-accent-fg")}
            >
              {k === "folder" ? "Folders" : k === "all" ? "All clips" : "Recent"}
            </button>
          );
        })}
        <span className="mx-1 h-4 w-px bg-line" />
        <button type="button" className={btn} onClick={newFolder} disabled={loc.kind !== "folder"} title={tip("New folder", "new-folder")}>
          New folder
        </button>
        <button type="button" className={btn} disabled={!selection.length} onClick={() => setPicker({ mode: "move", paths: selection })}>
          Move to…
        </button>
        <button type="button" className={btn} disabled={selection.length !== 1} onClick={() => startRename(selection[0])} title={tip("Rename", "rename")}>
          Rename
        </button>
        <button type="button" className={cn(btn, "hover:text-danger")} disabled={!selection.length} onClick={() => recycle(selection)} title={tip("Delete to the Recycle Bin", "delete")}>
          Delete
        </button>
        <button type="button" className={btn} disabled={!undo.length} onClick={doUndo} title={undo.length ? tip(`Undo ${undo[undo.length - 1].label.toLowerCase()}`, "undo") : "Nothing to undo"}>
          Undo
        </button>
        <div className="flex-1" />
        <select
          value={prefs.kind}
          onChange={(e) => setPrefs((p) => ({ ...p, kind: e.target.value as X.KindFilter }))}
          className="rounded-md border border-line bg-surface px-1.5 py-1 text-[11px] text-ink"
          title="Show only one kind of file"
          aria-label="Kind"
        >
          <option value="all">All files</option>
          <option value="videos">All videos</option>
          <option value="clips">Clips (instant replay)</option>
          <option value="recordings">Recordings</option>
          <option value="edits">Edits</option>
          <option value="pictures">Pictures</option>
          <option value="other">Other files</option>
        </select>
        {prefs.view === "grid" && (
          <input
            type="range"
            min={120}
            max={360}
            step={10}
            value={prefs.size}
            onChange={(e) => setPrefs((p) => ({ ...p, size: Number(e.target.value) }))}
            title="Picture size (Ctrl + mouse wheel)"
            aria-label="Picture size"
            className="w-24 accent-[var(--color-accent,#7c5cff)]"
          />
        )}
        <select
          value={`${prefs.sort.col}:${prefs.sort.desc ? "d" : "a"}`}
          onChange={(e) => {
            const [col, d] = e.target.value.split(":");
            setPrefs((p) => ({ ...p, sort: { col: col as X.SortCol, desc: d === "d" } }));
          }}
          className="rounded-md border border-line bg-surface px-1.5 py-1 text-[11px] text-ink"
          title="Sort"
          aria-label="Sort"
        >
          {COLS.flatMap((c) => [
            <option key={c.col + "d"} value={`${c.col}:d`}>
              {c.label} ↓
            </option>,
            <option key={c.col + "a"} value={`${c.col}:a`}>
              {c.label} ↑
            </option>,
          ])}
        </select>
        <div className="flex overflow-hidden rounded-md border border-line">
          {(["grid", "details"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setPrefs((p) => ({ ...p, view: v }))}
              title={tip(v === "grid" ? "Pictures" : "Details", v === "grid" ? "view-grid" : "view-details")}
              className={cn("px-2 py-1 text-[11px]", prefs.view === v ? "bg-surface-3 text-ink" : "bg-surface text-ink-3 hover:text-ink")}
            >
              {v === "grid" ? "Grid" : "Details"}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setPrefs((p) => ({ ...p, preview: !p.preview }))}
          title={tip("Preview pane", "preview")}
          aria-pressed={prefs.preview}
          className={cn(btn, prefs.preview && "border-accent/60 bg-accent/15 text-accent-fg")}
        >
          Preview
        </button>
      </div>

      {linkAsk && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-accent/50 bg-accent/10 px-3 py-2 text-[12px] text-ink">
          <span className="min-w-0 flex-1 truncate">
            <b>{linkAsk}</b> is not in your clips folders. Link it? (Nothing is copied; removing the link never deletes files.)
          </span>
          <button
            type="button"
            className={cn(btn, "border-accent bg-accent text-white hover:text-white")}
            onClick={() => {
              const p = linkAsk;
              setLinkAsk(null);
              void link([p]).then(() => navigate({ kind: "folder", path: p }));
            }}
          >
            Link folder
          </button>
          <button type="button" className={btn} onClick={() => setLinkAsk(null)}>
            Cancel
          </button>
        </div>
      )}

      {prefs.view === "details" && (
        <div style={{ gridTemplateColumns: GRID_TEMPLATE }} className={cn("grid gap-3 border-b border-line px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-ink-3", prefs.preview && "mr-[292px]")}>
          {COLS.map((c) => (
            <button
              key={c.col}
              type="button"
              className="text-left hover:text-ink"
              onClick={() => setPrefs((p) => ({ ...p, sort: { col: c.col, desc: p.sort.col === c.col ? !p.sort.desc : c.col === "date" || c.col === "size" } }))}
            >
              {c.label}
              {prefs.sort.col === c.col ? (prefs.sort.desc ? " ↓" : " ↑") : ""}
            </button>
          ))}
        </div>
      )}

      <div className="flex min-h-[260px] flex-1 gap-2">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          onMouseDown={onBgMouseDown}
          onClick={() => {
            if (bandedRef.current) bandedRef.current = false;
            else onSelection([], null);
          }}
          onContextMenu={(e) => openMenu(e, null)}
          {...dropProps(currentDir)}
          role="listbox"
          aria-multiselectable
          aria-label="Files"
          className={cn(
            "relative min-h-[260px] min-w-0 flex-1 overflow-y-auto rounded-lg border bg-surface-2/40",
            dropOn === currentDir ? "border-accent" : "border-line",
          )}
        >
          <div style={{ height: rows * pitch + 16, position: "relative" }}>{visible.map(entryView)}</div>
          {band && (
            <div
              className="pointer-events-none absolute border border-accent bg-accent/15"
              style={{ left: 8 + Math.min(band.x0, band.x1), top: 8 + Math.min(band.y0, band.y1), width: Math.abs(band.x1 - band.x0), height: Math.abs(band.y1 - band.y0) }}
            />
          )}
          {shownErr ? (
            <div className="absolute inset-0 grid place-items-center p-6 text-center" data-testid="explorer-error">
              <div className="max-w-sm space-y-3">
                <p className="text-[13px] font-semibold text-ink">{shownErr}</p>
                <p className="break-all font-mono text-[10px] text-ink-3">{folderPath}</p>
                <div className="flex flex-wrap justify-center gap-2">
                  <button type="button" className={btn} onClick={refresh}>
                    Try again
                  </button>
                  {X.upOf(loc, saveDir, externals) && (
                    <button type="button" className={btn} onClick={up}>
                      Go up
                    </button>
                  )}
                  {errIsLink && folderPath && props.onUnlinkFolder && (
                    <button type="button" className={btn} onClick={() => void unlink(externals.find((x) => X.samePath(x, folderPath) || X.isInside(folderPath, x)) ?? folderPath)}>
                      Remove link
                    </button>
                  )}
                </div>
              </div>
            </div>
          ) : (
            !entries.length && <div className="pointer-events-none absolute inset-0 grid place-items-center text-[12px] text-ink-3">{emptyText}</div>
          )}
        </div>
        {prefs.preview && (
          <PreviewPane
            entry={shown}
            count={selection.length}
            bytes={selBytes}
            native={native}
            onOpen={(e) => openEntry(e)}
            onReveal={props.onReveal}
          />
        )}
      </div>
      <div className="flex flex-wrap justify-between gap-2 font-mono text-[10px] text-ink-3">
        <span>
          {plural(entries.length, "item")} · {formatBytes(totalBytes)}
          {selection.length > 0 && ` · ${selection.length} selected (${formatBytes(selBytes)})`}
          {[...repairs].map(([p, v]) => (
            <span key={p} className="text-accent-fg">
              {" · "}
              {/\.mkv$/i.test(p) ? "Converting" : "Repairing"} {X.baseName(p)} {repairText(v)}
            </span>
          ))}
        </span>
        <span>
          {undo.length ? (
            <button type="button" className="underline-offset-2 hover:text-ink hover:underline" onClick={doUndo}>
              Undo {undo[undo.length - 1].label.toLowerCase()} (Ctrl+Z)
            </button>
          ) : cutPaths.length ? (
            `${cutPaths.length} to move — Ctrl+V in a folder`
          ) : (
            "Drop a folder to link it · Del moves to the Recycle Bin"
          )}
        </span>
      </div>

      {menu && (
        <div
          ref={menuRef}
          role="menu"
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={onMenuKey}
          style={{ left: Math.max(4, Math.min(menu.x, window.innerWidth - 240)), top: Math.max(4, Math.min(menu.y, window.innerHeight - menuItems().length * 27 - 16)) }}
          className="fixed z-50 w-56 rounded-lg border border-line-3 bg-surface-2 py-1 text-[12px] shadow-xl"
        >
          {menuItems().map((m, i) =>
            m === "-" ? (
              <div key={i} className="my-1 h-px bg-line" />
            ) : (
              <button
                key={i}
                type="button"
                role={m.check === undefined ? "menuitem" : "menuitemcheckbox"}
                aria-checked={m.check}
                disabled={m.off}
                onClick={() => {
                  closeMenu();
                  m.run();
                }}
                className={cn(
                  "flex w-full items-center justify-between px-3 py-1.5 text-left outline-none hover:bg-surface-3 focus:bg-surface-3 disabled:opacity-35",
                  m.danger ? "text-danger" : "text-ink",
                )}
              >
                <span>
                  {m.check !== undefined && <span className="inline-block w-4">{m.check ? "✓" : ""}</span>}
                  {m.label}
                </span>
                {m.key && <span className="font-mono text-[10px] text-ink-3">{m.key}</span>}
              </button>
            ),
          )}
        </div>
      )}

      {picker && (
        <FolderPicker
          title={`${picker.mode === "move" ? "Move" : "Copy"} ${plural(picker.paths.length, "item")} to`}
          saveDir={saveDir}
          dirs={[...dirs, ...externals, ...pins.map((p) => p.path)]}
          onCancel={() => {
            setPicker(null);
            rootRef.current?.focus({ preventScroll: true });
          }}
          onPick={(dest) => {
            setPicker(null);
            rootRef.current?.focus({ preventScroll: true });
            transfer(picker.paths, dest, picker.mode);
          }}
        />
      )}
    </div>
  );
}

/** What is selected, larger: a video plays (muted until you unmute), a picture shows. */
function PreviewPane({
  entry,
  count,
  bytes,
  native,
  onOpen,
  onReveal,
}: {
  entry: X.Entry | null;
  count: number;
  bytes: number;
  native: boolean;
  onOpen: (e: X.Entry) => void;
  onReveal: (p: string) => void;
}) {
  const box = "w-[280px] shrink-0 overflow-y-auto rounded-lg border border-line bg-surface-2/40 p-3 text-[11px] text-ink-2";
  if (count > 1)
    return (
      <aside className={box} aria-label="Preview">
        <p className="text-[13px] font-semibold text-ink">{count} items selected</p>
        <p className="mt-1 font-mono text-ink-3">{formatBytes(bytes)}</p>
      </aside>
    );
  if (!entry)
    return (
      <aside className={cn(box, "grid place-items-center text-ink-3")} aria-label="Preview">
        Select a file to preview it
      </aside>
    );
  const path = X.entryPath(entry);
  const c = entry.kind === "clip" ? entry.clip : null;
  const video = c || (entry.kind === "file" && fileKind(entry.name) === "video");
  const pic = entry.kind === "file" && isShowablePicture(entry.name);
  const rows: [string, string][] = c
    ? [
        ["Game", X.clipGame(c) || "—"],
        ["Date", fmtDate(c.created_unix_ms)],
        ["Length", formatDuration(c.duration_seconds)],
        ["Size", formatBytes(c.size_bytes)],
        ["Resolution", c.width ? `${c.width}×${c.height}${c.fps ? ` · ${Math.round(c.fps)} fps` : ""}` : "—"],
      ]
    : entry.kind === "file"
      ? [
          ["Modified", fmtDate(entry.modified)],
          ["Size", formatBytes(entry.size)],
          ...(entry.readonly ? ([["", "Read-only"]] as [string, string][]) : []),
        ]
      : entry.kind === "folder"
        ? [
            ["Clips", String(entry.count)],
            ["Size", formatBytes(entry.bytes)],
            ...(entry.latest ? ([["Newest", fmtDate(entry.latest.created_unix_ms)]] as [string, string][]) : []),
          ]
        : [];
  return (
    <aside className={box} aria-label="Preview" data-testid="explorer-preview">
      <div className="relative mb-3 aspect-video overflow-hidden rounded-md bg-black">
        {video && native ? (
          <video key={path} src={assetUrl(path)} controls muted autoPlay loop playsInline className="h-full w-full object-contain" />
        ) : pic && native ? (
          <img src={assetUrl(path)} alt="" className="h-full w-full object-contain" />
        ) : entry.kind === "folder" ? (
          <Thumb path={entry.latest?.path ?? null} have={entry.latest?.thumbnail} />
        ) : c ? (
          <Thumb path={path} have={c.thumbnail} />
        ) : (
          <KindIcon name={path} />
        )}
      </div>
      <p className="break-words text-[12px] font-semibold text-ink">{c ? c.file_name : entry.kind === "clip" ? "" : entry.name}</p>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {rows.map(([k, v], i) => (
          <div key={i} className="contents">
            <dt className="text-ink-3">{k}</dt>
            <dd className="truncate text-ink-2">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 break-all font-mono text-[10px] text-ink-4">{path}</p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <button type="button" className="rounded-md border border-line px-2 py-1 text-[11px] text-ink-3 hover:text-ink" onClick={() => onOpen(entry)}>
          Open
        </button>
        <button type="button" className="rounded-md border border-line px-2 py-1 text-[11px] text-ink-3 hover:text-ink" onClick={() => onReveal(path)}>
          Show in File Explorer
        </button>
      </div>
    </aside>
  );
}

function FolderPicker({ title, saveDir, dirs, onPick, onCancel }: { title: string; saveDir: string; dirs: string[]; onPick: (d: string) => void; onCancel: () => void }) {
  const [pick, setPick] = useState(saveDir);
  const list = useMemo(() => {
    const seen = new Set<string>([X.normPath(saveDir)]);
    const rest = dirs.filter((d) => {
      const k = X.normPath(d);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return [saveDir, ...rest.sort((a, b) => a.localeCompare(b))];
  }, [saveDir, dirs]);
  const label = (d: string) => (X.samePath(d, saveDir) ? "Clips (main folder)" : X.isInside(d, saveDir) ? d.slice(saveDir.replace(/[\\/]+$/, "").length + 1) : d);
  const at = list.findIndex((d) => X.samePath(d, pick));
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50" onMouseDown={onCancel}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") onCancel();
          else if (e.key === "Enter" && (e.target as HTMLElement).tagName !== "BUTTON") onPick(pick);
          else if (e.key === "ArrowDown") setPick(list[Math.min(list.length - 1, at + 1)]);
          else if (e.key === "ArrowUp") setPick(list[Math.max(0, at - 1)]);
          else return;
          e.preventDefault();
        }}
        tabIndex={-1}
        ref={(el) => el?.focus()}
        className="w-[420px] max-w-[92vw] rounded-xl border border-line-3 bg-surface-2 p-4 shadow-2xl outline-none"
      >
        <h3 className="mb-2 text-[13px] font-semibold text-ink">{title}</h3>
        <div className="max-h-72 overflow-y-auto rounded-md border border-line">
          {list.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setPick(d)}
              onDoubleClick={() => onPick(d)}
              className={cn("flex w-full items-center gap-2 px-2 py-1.5 text-left text-[12px]", X.samePath(d, pick) ? "bg-accent/20 text-ink" : "text-ink-2 hover:bg-surface-3")}
            >
              <FolderIcon className="h-4 w-4 shrink-0 text-amber-400/90" />
              <span className="truncate">{label(d)}</span>
            </button>
          ))}
        </div>
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded-md border border-line px-3 py-1.5 text-[12px] text-ink-3 hover:text-ink">
            Cancel
          </button>
          <button type="button" onClick={() => onPick(pick)} className="rounded-md border border-accent bg-accent px-3 py-1.5 text-[12px] font-semibold text-white">
            {title.startsWith("Move") ? "Move here" : "Copy here"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default memo(ClipsExplorer);

/** "Open in editor" on a clip row / tile (shows on hover). */
function EditBtn({ onClick, className }: { onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      title="Open in editor: trim, cut, crop, draw, export"
      onClick={(ev) => {
        ev.stopPropagation();
        onClick();
      }}
      onDoubleClick={(ev) => ev.stopPropagation()}
      className={cn("inline-flex h-5 shrink-0 items-center gap-1 rounded bg-black/70 px-1.5 text-[10px] font-semibold text-white hover:bg-accent", className)}
    >
      <svg viewBox="0 0 16 16" className="h-3 w-3 fill-none stroke-current" strokeWidth="1.6" strokeLinecap="round">
        <path d="M2 14l2.5-.5 8-8-2-2-8 8zM9.5 4.5l2 2" />
      </svg>
      Edit
    </button>
  );
}
