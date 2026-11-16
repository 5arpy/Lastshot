import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { lastshot } from "../lib/bridge";
import type { ClipMetadata } from "../lib/types";
import { formatBytes, formatDuration } from "../lib/format";
import { cacheThumbnail, getCachedThumbnail } from "../lib/thumbCache";
import { cn } from "../utils/cn";
import * as X from "../lib/explorer";

/**
 * Clips library as a file manager: game folders with their newest clip,
 * loose clips, "All clips" and "Recent", a grid (adjustable size) and a
 * details list (sortable columns), Explorer-style selection, keys, a
 * right-click menu, drag onto folders, and Recycle Bin deletes.
 * Only the rows on screen are drawn, so thousands of clips stay smooth.
 */

type Tone = "ok" | "err" | "warn" | "info";

interface Props {
  clips: ClipMetadata[];
  saveDir: string;
  /** Extra library folders (shown as folders at the top). */
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
}

const PREF_KEY = "lastshot.explorer.v1";
interface Prefs {
  view: "grid" | "details";
  size: number;
  sort: X.SortSpec;
}
function loadPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREF_KEY) ?? "{}");
    return { view: p.view === "details" ? "details" : "grid", size: Number(p.size) || 220, sort: p.sort?.col ? p.sort : { col: "date", desc: true } };
  } catch {
    return { view: "grid", size: 220, sort: { col: "date", desc: true } };
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

function Thumb({ clip, className }: { clip: ClipMetadata | null; className?: string }) {
  const [src, setSrc] = useState<string | null>(clip ? (clip.thumbnail ?? getCachedThumbnail(clip.path) ?? null) : null);
  useEffect(() => {
    if (!clip) return setSrc(null);
    let alive = true;
    const have = clip.thumbnail ?? getCachedThumbnail(clip.path);
    if (have) setSrc(have);
    else {
      setSrc(null);
      void thumbFor(clip.path).then((t) => alive && setSrc(t));
    }
    return () => {
      alive = false;
    };
  }, [clip]);
  return src ? (
    <img src={src} alt="" draggable={false} className={cn("h-full w-full object-cover", className)} />
  ) : (
    <div className={cn("h-full w-full bg-surface-4", className)} />
  );
}

const FolderIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
    <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.6l2 2H19.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" />
  </svg>
);

const COLS: Array<{ col: X.SortCol; label: string; w: string }> = [
  { col: "name", label: "Name", w: "minmax(220px,3fr)" },
  { col: "game", label: "Game", w: "minmax(90px,1fr)" },
  { col: "date", label: "Date", w: "150px" },
  { col: "length", label: "Length", w: "80px" },
  { col: "size", label: "Size", w: "90px" },
  { col: "resolution", label: "Resolution", w: "100px" },
];
const GRID_TEMPLATE = COLS.map((c) => c.w).join(" ");
const ROW_H = 30;
const GAP = 12;
const LABEL_H = 46;

const fmtDate = (ms: number) =>
  ms
    ? new Date(ms).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : "";

interface Menu {
  x: number;
  y: number;
  target: X.Entry | null;
}

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
  const [renaming, setRenaming] = useState<string | null>(null);
  const [picker, setPicker] = useState<{ mode: "move" | "copy"; paths: string[] } | null>(null);
  const [clipboard, setClipboard] = useState<{ mode: "cut" | "copy"; paths: string[] } | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const [band, setBand] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ w: 800, h: 600, top: 0 });
  const anchorRef = useRef<string | null>(null);
  const focusRef = useRef<string | null>(null);
  const bandedRef = useRef(false);

  // The save folder can change in Settings: start over there.
  useEffect(() => {
    setHist(X.historyStart({ kind: "folder", path: saveDir }));
  }, [saveDir]);

  const readDirs = useCallback(() => {
    void lastshot
      .libraryDirs()
      .then(setDirs)
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    readDirs();
  }, [readDirs, clips]);

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
    void lastshot
      .onLibraryChanged(() => {
        onChanged();
        readDirs();
      })
      .then((u) => (alive ? (off = u) : u()));
    return () => {
      alive = false;
      off?.();
    };
  }, [onChanged, readDirs]);

  const navigate = useCallback((to: X.Loc) => {
    setHist((h) => X.go(h, to));
    setQuery("");
    setRenaming(null);
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

  const atRoot = loc.kind === "folder" && X.samePath(loc.path, saveDir);
  const entries = useMemo(() => {
    let list: X.Entry[];
    if (query.trim()) list = X.searchClips(clips, query, everywhere || loc.kind !== "folder" ? null : loc.path);
    else if (loc.kind === "all") list = X.allClips(clips);
    else if (loc.kind === "recent") return X.recentClips(clips);
    else list = X.folderContents(clips, dirs, loc.path, atRoot ? externals : []);
    return X.sortEntries(list, prefs.sort);
  }, [clips, dirs, loc, query, everywhere, externals, atRoot, prefs.sort]);
  const order = useMemo(() => entries.map(X.entryPath), [entries]);
  const { onOrder } = props;
  useEffect(() => onOrder?.(order), [order, onOrder]);
  const byPath = useMemo(() => new Map(entries.map((e) => [X.normPath(X.entryPath(e)), e])), [entries]);

  // ------------------------------------------------------------ geometry
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setBox((b) => ({ ...b, w: el.clientWidth, h: el.clientHeight }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [prefs.view]);
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

  // ------------------------------------------------------------ selection
  const select = (path: string, e: { ctrlKey: boolean; shiftKey: boolean; metaKey?: boolean }) => {
    const ctrl = e.ctrlKey || !!e.metaKey;
    focusRef.current = path;
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
  const selectedEntries = selection.map((p) => byPath.get(X.normPath(p))).filter((e): e is X.Entry => !!e);
  const selectedClips = selectedEntries.flatMap((e) => (e.kind === "clip" ? [e.clip] : []));

  // ------------------------------------------------------------ actions
  const currentDir = loc.kind === "folder" ? loc.path : saveDir;
  const open = (e: X.Entry) => {
    if (e.kind === "folder") navigate({ kind: "folder", path: e.path });
    else props.onOpen(e.clip);
  };
  const run = async (what: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      onChanged();
      readDirs();
    } catch (err) {
      onToast("err", what, String(err));
    }
  };
  const newFolder = () =>
    run("Could not make a folder", async () => {
      const p = await lastshot.createClipFolder(currentDir, "New folder");
      readDirs();
      onSelection([p], p);
      setRenaming(p);
    });
  const recycle = (paths: string[]) => {
    if (!paths.length) return;
    void run("Could not delete", async () => {
      const n = await lastshot.recycleItems(paths);
      onSelection([], null);
      onToast("warn", `Moved ${n} item${n === 1 ? "" : "s"} to the Recycle Bin`, "Restore them from the Recycle Bin if you need them back.");
    });
  };
  const moveTo = (paths: string[], dest: string, copy = false) => {
    const list = paths.filter((p) => !X.samePath(p, dest) && !X.samePath(X.parentOf(p), dest) && !X.isInside(dest, p));
    if (!list.length) return;
    void run(copy ? "Could not copy" : "Could not move", async () => {
      const out = copy ? await lastshot.copyClipsTo(list, dest) : await lastshot.moveClips(list, dest);
      onToast("ok", `${copy ? "Copied" : "Moved"} ${out.length} item${out.length === 1 ? "" : "s"}`, `to ${X.baseName(dest)}`);
    });
  };
  const commitRename = (path: string, name: string) => {
    setRenaming(null);
    const e = byPath.get(X.normPath(path));
    const old = e?.kind === "clip" ? X.displayName(e.clip) : X.baseName(path);
    if (!name.trim() || name.trim() === old) return;
    void run("Could not rename", async () => {
      const p = await lastshot.renameLibraryItem(path, name);
      onSelection([p], p);
    });
  };
  const paste = () => {
    if (!clipboard) return;
    moveTo(clipboard.paths, currentDir, clipboard.mode === "copy");
    if (clipboard.mode === "cut") setClipboard(null);
  };
  const up = () => {
    const u = X.upOf(loc, saveDir, externals);
    if (u) navigate(u);
  };

  // ------------------------------------------------------------ keys
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("input,textarea,select")) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key;
    if (e.altKey && k === "ArrowLeft") setHist(X.goBack);
    else if (e.altKey && k === "ArrowRight") setHist(X.goForward);
    else if ((e.altKey && k === "ArrowUp") || k === "Backspace") up();
    else if (ctrl && k.toLowerCase() === "a") onSelection(order, order[0] ?? null);
    else if (ctrl && e.shiftKey && k.toLowerCase() === "n") newFolder();
    else if (ctrl && k.toLowerCase() === "c" && selection.length) {
      setClipboard({ mode: "copy", paths: selection });
      if (selectedClips.length) props.onCopyForDiscord(selectedClips.map((c) => c.path));
    } else if (ctrl && k.toLowerCase() === "x" && selection.length) setClipboard({ mode: "cut", paths: selection });
    else if (ctrl && k.toLowerCase() === "v") paste();
    else if (k === "F2" && selection.length === 1) setRenaming(selection[0]);
    else if (k === "Delete") recycle(selection);
    else if (k === "F5") (onChanged(), readDirs());
    else if (k === "Enter" && selectedEntries.length === 1) open(selectedEntries[0]);
    else if (k.startsWith("Arrow") && order.length) {
      const i = order.findIndex((p) => X.samePath(p, focusRef.current ?? anchorRef.current ?? ""));
      const step = k === "ArrowLeft" ? -1 : k === "ArrowRight" ? 1 : k === "ArrowUp" ? -perRow : perRow;
      const next = order[Math.min(order.length - 1, Math.max(0, i < 0 ? 0 : i + step))];
      select(next, { ctrlKey: false, shiftKey: e.shiftKey });
      const row = Math.floor(order.indexOf(next) / perRow);
      const el = scrollRef.current;
      if (el && (row * pitch < el.scrollTop || (row + 1) * pitch > el.scrollTop + el.clientHeight)) el.scrollTop = row * pitch;
    } else return;
    e.preventDefault();
  };
  // Mouse back / forward buttons.
  const onMouseUp = (e: React.MouseEvent) => {
    if (e.button === 3) setHist(X.goBack);
    if (e.button === 4) setHist(X.goForward);
  };

  // ------------------------------------------------------------ drag & drop
  const dragPaths = useRef<string[]>([]);
  const onDragStart = (e: React.DragEvent, path: string) => {
    const paths = selected.has(path) ? selection : [path];
    if (!selected.has(path)) onSelection([path], path);
    dragPaths.current = paths;
    e.dataTransfer.setData("application/x-lastshot-paths", JSON.stringify(paths));
    e.dataTransfer.effectAllowed = "copyMove";
  };
  const dropProps = (dest: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes("application/x-lastshot-paths")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = e.ctrlKey ? "copy" : "move";
      setDropOn(dest);
    },
    onDragLeave: () => setDropOn((d) => (d === dest ? null : d)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDropOn(null);
      let paths: string[] = [];
      try {
        paths = JSON.parse(e.dataTransfer.getData("application/x-lastshot-paths"));
      } catch {
        paths = dragPaths.current;
      }
      moveTo(paths, dest, e.ctrlKey);
    },
  });

  // ------------------------------------------------------------ rubber band
  const onBgMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0 || prefs.view !== "grid" || (e.target as HTMLElement).closest("[data-entry]")) return;
    const el = scrollRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const at = (ev: MouseEvent | React.MouseEvent) => ({ x: ev.clientX - r.left - 8, y: ev.clientY - r.top + el.scrollTop - 8 });
    const s = at(e);
    const base = e.ctrlKey ? [...selected] : [];
    if (!e.ctrlKey) onSelection([], null);
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
      onSelection([X.entryPath(target)], X.entryPath(target));
    }
    setMenu({ x: e.clientX, y: e.clientY, target });
  };
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  const menuItems = (): Array<{ label: string; key?: string; run: () => void; danger?: boolean; off?: boolean } | "-"> => {
    const t = menu?.target ?? null;
    const many = selection.length;
    if (!t)
      return [
        { label: "New folder", key: "Ctrl+Shift+N", run: newFolder, off: loc.kind !== "folder" },
        { label: clipboard?.mode === "cut" ? "Paste (move here)" : "Paste", key: "Ctrl+V", run: paste, off: !clipboard || loc.kind !== "folder" },
        { label: "Show in File Explorer", run: () => props.onReveal(currentDir) },
        { label: "Refresh", key: "F5", run: () => (onChanged(), readDirs()) },
        "-",
        { label: prefs.view === "grid" ? "Details view" : "Grid view", run: () => setPrefs((p) => ({ ...p, view: p.view === "grid" ? "details" : "grid" })) },
      ];
    const clip = t.kind === "clip" ? t.clip : null;
    return [
      { label: t.kind === "folder" ? "Open" : "Open in clip editor", key: "Enter", run: () => open(t), off: many > 1 },
      ...(clip
        ? [
            { label: "Play", run: () => props.onPlay(clip), off: many > 1 },
            { label: "Copy for Discord", key: "Ctrl+C", run: () => props.onCopyForDiscord(selectedClips.map((c) => c.path)) },
            { label: "Shrink & copy", run: () => props.onShare(clip), off: many > 1 },
            { label: clip.favorite ? "Unstar" : "Star", run: () => props.onToggleFavorite(clip), off: many > 1 },
          ]
        : []),
      "-",
      { label: "Show in File Explorer", run: () => props.onReveal(X.entryPath(t)) },
      { label: "Rename", key: "F2", run: () => setRenaming(X.entryPath(t)), off: many > 1 },
      { label: "Move to…", run: () => setPicker({ mode: "move", paths: selection }) },
      { label: "Copy to…", run: () => setPicker({ mode: "copy", paths: selection.filter((p) => byPath.get(X.normPath(p))?.kind === "clip") }), off: !selectedClips.length },
      { label: "Cut", key: "Ctrl+X", run: () => setClipboard({ mode: "cut", paths: selection }) },
      "-",
      { label: many > 1 ? `Delete ${many} items` : "Delete", key: "Del", danger: true, run: () => recycle(selection) },
    ];
  };

  // ------------------------------------------------------------ render
  const crumbs = X.breadcrumb(loc, saveDir, externals);
  const totalBytes = entries.reduce((a, e) => a + (e.kind === "clip" ? e.clip.size_bytes : e.bytes), 0);
  const selBytes = selectedEntries.reduce((a, e) => a + (e.kind === "clip" ? e.clip.size_bytes : e.bytes), 0);
  const btn = "rounded-md border border-line bg-surface px-2 py-1 text-[11px] text-ink-3 transition-colors hover:border-line-3 hover:text-ink disabled:opacity-35";

  const entryView = (e: X.Entry, i: number) => {
    const path = X.entryPath(e);
    const sel = selected.has(path);
    const isCut = clipboard?.mode === "cut" && clipboard.paths.some((p) => X.samePath(p, path));
    const common = {
      "data-entry": path,
      draggable: renaming !== path,
      onDragStart: (ev: React.DragEvent) => onDragStart(ev, path),
      onClick: (ev: React.MouseEvent) => (ev.stopPropagation(), select(path, ev)),
      onDoubleClick: () => open(e),
      onContextMenu: (ev: React.MouseEvent) => openMenu(ev, e),
      ...(e.kind === "folder" ? dropProps(e.path) : {}),
    };
    const name =
      renaming === path ? (
        <input
          autoFocus
          defaultValue={e.kind === "clip" ? X.displayName(e.clip) : e.name}
          onFocus={(ev) => ev.currentTarget.select()}
          onClick={(ev) => ev.stopPropagation()}
          onKeyDown={(ev) => {
            ev.stopPropagation();
            if (ev.key === "Enter") commitRename(path, ev.currentTarget.value);
            if (ev.key === "Escape") setRenaming(null);
          }}
          onBlur={(ev) => commitRename(path, ev.currentTarget.value)}
          className="w-full rounded border border-accent bg-app px-1 text-[11px] text-ink outline-none"
        />
      ) : (
        <span className="truncate" title={e.kind === "clip" ? e.clip.file_name : e.path}>
          {e.kind === "clip" ? X.displayName(e.clip) : e.name}
        </span>
      );
    if (prefs.view === "details") {
      const c = e.kind === "clip" ? e.clip : null;
      return (
        <div
          key={path}
          {...common}
          style={{ position: "absolute", top: (first * perRow + i) * ROW_H, left: 0, right: 0, height: ROW_H, gridTemplateColumns: GRID_TEMPLATE }}
          className={cn(
            "grid cursor-default select-none items-center gap-3 rounded px-2 text-[11px]",
            sel ? "bg-accent/20 text-ink" : "text-ink-2 hover:bg-surface-3",
            dropOn === path && "ring-1 ring-accent",
            isCut && "opacity-50",
          )}
        >
          <span className="flex min-w-0 items-center gap-2">
            {c ? (
              <span className="h-[18px] w-8 shrink-0 overflow-hidden rounded-sm">
                <Thumb clip={c} />
              </span>
            ) : (
              <FolderIcon className="h-4 w-8 shrink-0 text-amber-400/90" />
            )}
            {name}
            {c?.favorite && <span className="text-warn">★</span>}
          </span>
          <span className="truncate text-ink-3">{c ? X.clipGame(c) : e.kind === "folder" ? `${e.count} clip${e.count === 1 ? "" : "s"}` : ""}</span>
          <span className="text-ink-3">{fmtDate(c ? c.created_unix_ms : e.kind === "folder" ? (e.latest?.created_unix_ms ?? 0) : 0)}</span>
          <span className="font-mono text-ink-3">{c ? formatDuration(c.duration_seconds) : ""}</span>
          <span className="font-mono text-ink-3">{formatBytes(c ? c.size_bytes : e.kind === "folder" ? e.bytes : 0)}</span>
          <span className="font-mono text-ink-3">{c && c.width ? `${c.width}×${c.height}` : ""}</span>
        </div>
      );
    }
    const idx = first * perRow + i;
    return (
      <div
        key={path}
        {...common}
        style={{ position: "absolute", left: 8 + (idx % cols) * (tileW + GAP), top: 8 + Math.floor(idx / cols) * (tileH + GAP), width: tileW, height: tileH }}
        className={cn(
          "group cursor-default select-none overflow-hidden rounded-lg border",
          sel ? "border-accent bg-accent/15" : "border-line bg-surface hover:border-line-3",
          dropOn === path && "ring-2 ring-accent",
          isCut && "opacity-50",
        )}
      >
        <div className="relative w-full overflow-hidden bg-surface-4" style={{ height: tileH - LABEL_H }}>
          {e.kind === "folder" ? (
            <>
              <Thumb clip={e.latest} className="opacity-70" />
              <div className="absolute inset-0 bg-gradient-to-t from-black/70 to-transparent" />
              <FolderIcon className="absolute left-2 top-2 h-6 w-6 text-amber-400 drop-shadow" />
              <span className="absolute bottom-1.5 left-2 font-mono text-[10px] text-white/90">
                {e.count} clip{e.count === 1 ? "" : "s"} · {formatBytes(e.bytes)}
              </span>
              {e.external && <span className="absolute right-1.5 top-1.5 rounded bg-black/60 px-1 text-[9px] text-white/80">Other folder</span>}
            </>
          ) : (
            <>
              <Thumb clip={e.clip} />
              <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 font-mono text-[10px] text-white">{formatDuration(e.clip.duration_seconds)}</span>
              {e.clip.favorite && <span className="absolute left-1.5 top-1 text-warn drop-shadow">★</span>}
              {props.shareProgress?.has(e.clip.path) && (
                <span className="absolute left-1 bottom-1 rounded bg-black/70 px-1 font-mono text-[10px] text-white">
                  {Math.round((props.shareProgress.get(e.clip.path) ?? 0) * 100)}%
                </span>
              )}
            </>
          )}
        </div>
        <div className="flex h-[46px] flex-col justify-center gap-0.5 px-2 text-[11px] text-ink">
          {name}
          <span className="truncate text-[10px] text-ink-3">
            {e.kind === "clip" ? [X.clipGame(e.clip), fmtDate(e.clip.created_unix_ms), formatBytes(e.clip.size_bytes)].filter(Boolean).join(" · ") : e.latest ? `Newest ${fmtDate(e.latest.created_unix_ms)}` : "Empty"}
          </span>
        </div>
      </div>
    );
  };

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onMouseUp={onMouseUp}
      className="flex min-h-0 flex-col gap-2 outline-none"
      data-testid="clips-explorer"
    >
      {/* Toolbar: back / forward / up, path bar, search, view */}
      <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" className={btn} title="Back (Alt+Left)" disabled={!hist.back.length} onClick={() => setHist(X.goBack)}>
          ←
        </button>
        <button type="button" className={btn} title="Forward (Alt+Right)" disabled={!hist.fwd.length} onClick={() => setHist(X.goForward)}>
          →
        </button>
        <button type="button" className={btn} title="Up (Backspace)" disabled={!X.upOf(loc, saveDir, externals)} onClick={up}>
          ↑
        </button>
        <nav className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden rounded-md border border-line bg-surface px-1.5 py-0.5 text-[12px]" aria-label="Path">
          {crumbs.map((c, i) => (
            <span key={i} className="flex min-w-0 items-center">
              {i > 0 && <span className="px-0.5 text-ink-4">›</span>}
              <button
                type="button"
                onClick={() => navigate(c.loc)}
                {...(c.loc.kind === "folder" ? dropProps(c.loc.path) : {})}
                className={cn(
                  "truncate rounded px-1 py-0.5 hover:bg-surface-3",
                  i === crumbs.length - 1 ? "font-semibold text-ink" : "text-ink-3",
                  c.loc.kind === "folder" && dropOn === c.loc.path && "ring-1 ring-accent",
                )}
              >
                {c.label}
              </button>
            </span>
          ))}
        </nav>
        <div className="flex items-center gap-1 rounded-md border border-line bg-surface px-1.5">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQuery("")}
            placeholder={everywhere || loc.kind !== "folder" ? "Search all clips" : `Search ${crumbs[crumbs.length - 1]?.label ?? ""}`}
            className="w-44 bg-transparent py-1 text-[11px] text-ink outline-none placeholder:text-ink-3"
          />
          <label className="flex items-center gap-1 text-[10px] text-ink-3" title="Search every folder">
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
        <button type="button" className={btn} onClick={newFolder} disabled={loc.kind !== "folder"} title="New folder (Ctrl+Shift+N)">
          New folder
        </button>
        <button type="button" className={btn} disabled={!selection.length} onClick={() => setPicker({ mode: "move", paths: selection })}>
          Move to…
        </button>
        <button type="button" className={btn} disabled={selection.length !== 1} onClick={() => setRenaming(selection[0])} title="Rename (F2)">
          Rename
        </button>
        <button type="button" className={cn(btn, "hover:text-danger")} disabled={!selection.length} onClick={() => recycle(selection)} title="Delete to the Recycle Bin (Del)">
          Delete
        </button>
        <div className="flex-1" />
        {prefs.view === "grid" && (
          <input
            type="range"
            min={140}
            max={360}
            step={10}
            value={prefs.size}
            onChange={(e) => setPrefs((p) => ({ ...p, size: Number(e.target.value) }))}
            title="Picture size"
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
              className={cn("px-2 py-1 text-[11px]", prefs.view === v ? "bg-surface-3 text-ink" : "bg-surface text-ink-3 hover:text-ink")}
            >
              {v === "grid" ? "Grid" : "Details"}
            </button>
          ))}
        </div>
      </div>

      {prefs.view === "details" && (
        <div style={{ gridTemplateColumns: GRID_TEMPLATE }} className="grid gap-3 border-b border-line px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-ink-3">
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

      <div
        ref={scrollRef}
        onScroll={onScroll}
        onMouseDown={onBgMouseDown}
        onClick={() => {
          if (bandedRef.current) bandedRef.current = false;
          else onSelection([], null);
        }}
        onContextMenu={(e) => openMenu(e, null)}
        {...(loc.kind === "folder" ? dropProps(loc.path) : {})}
        className="relative h-[calc(100vh-250px)] min-h-[320px] overflow-y-auto rounded-lg border border-line bg-surface-2/40"
      >
        <div style={{ height: rows * pitch + 16, position: "relative" }}>{visible.map(entryView)}</div>
        {band && (
          <div
            className="pointer-events-none absolute border border-accent bg-accent/15"
            style={{ left: 8 + Math.min(band.x0, band.x1), top: 8 + Math.min(band.y0, band.y1), width: Math.abs(band.x1 - band.x0), height: Math.abs(band.y1 - band.y0) }}
          />
        )}
        {!entries.length && (
          <div className="absolute inset-0 grid place-items-center text-[12px] text-ink-3">
            {props.loading ? "Reading your clips…" : query ? "Nothing found" : loc.kind === "recent" ? "No clips in the last 7 days" : "This folder is empty"}
          </div>
        )}
      </div>
      <div className="flex justify-between font-mono text-[10px] text-ink-3">
        <span>
          {entries.length} item{entries.length === 1 ? "" : "s"} · {formatBytes(totalBytes)}
          {selection.length > 0 && ` · ${selection.length} selected (${formatBytes(selBytes)})`}
        </span>
        <span>{clipboard ? `${clipboard.paths.length} ${clipboard.mode === "cut" ? "to move" : "to copy"} — Ctrl+V in a folder` : "Del moves to the Recycle Bin"}</span>
      </div>

      {menu && (
        <div
          role="menu"
          onMouseDown={(e) => e.stopPropagation()}
          style={{ left: Math.min(menu.x, window.innerWidth - 230), top: Math.min(menu.y, window.innerHeight - 340) }}
          className="fixed z-50 w-56 rounded-lg border border-line-3 bg-surface-2 py-1 text-[12px] shadow-xl"
        >
          {menuItems().map((m, i) =>
            m === "-" ? (
              <div key={i} className="my-1 h-px bg-line" />
            ) : (
              <button
                key={i}
                type="button"
                role="menuitem"
                disabled={m.off}
                onClick={() => {
                  setMenu(null);
                  m.run();
                }}
                className={cn("flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-surface-3 disabled:opacity-35", m.danger ? "text-danger" : "text-ink")}
              >
                {m.label}
                {m.key && <span className="font-mono text-[10px] text-ink-3">{m.key}</span>}
              </button>
            ),
          )}
        </div>
      )}

      {picker && (
        <FolderPicker
          title={picker.mode === "move" ? `Move ${picker.paths.length} item${picker.paths.length === 1 ? "" : "s"} to` : `Copy ${picker.paths.length} clip${picker.paths.length === 1 ? "" : "s"} to`}
          saveDir={saveDir}
          dirs={[...dirs, ...externals]}
          onCancel={() => setPicker(null)}
          onPick={(dest) => {
            setPicker(null);
            moveTo(picker.paths, dest, picker.mode === "copy");
          }}
        />
      )}
    </div>
  );
}

function FolderPicker({ title, saveDir, dirs, onPick, onCancel }: { title: string; saveDir: string; dirs: string[]; onPick: (d: string) => void; onCancel: () => void }) {
  const [pick, setPick] = useState(saveDir);
  const list = useMemo(() => [saveDir, ...[...new Set(dirs)].sort((a, b) => a.localeCompare(b))], [saveDir, dirs]);
  const label = (d: string) => (X.samePath(d, saveDir) ? "Clips (main folder)" : X.isInside(d, saveDir) ? d.slice(saveDir.replace(/[\\/]+$/, "").length + 1) : d);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50" onMouseDown={onCancel}>
      <div onMouseDown={(e) => e.stopPropagation()} className="w-[420px] max-w-[92vw] rounded-xl border border-line-3 bg-surface-2 p-4 shadow-2xl">
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
