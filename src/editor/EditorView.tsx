import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { ImageCache, rasterize } from "../annotate/draw";
import { type Shape, type Style, type Tool, DEFAULT_STYLE, align as alignShapes, flip as flipShape, moveBy, reorder, rotateBy } from "../annotate/shapes";
import { TOOLS } from "../annotate/StyleControls";
import { isTauri, lastshot } from "../lib/bridge";
import { formatBytes } from "../lib/format";
import type { ClipMetadata, ShrinkResult } from "../lib/types";
import { popOutCanvas, popOutClip } from "../popout/frames";
import { type Marker, type Track, editPoints, end, newId, withLinked } from "../timeline/model";
import {
  addMarker,
  addTrack,
  closeAllGaps,
  closeGap,
  extractRange,
  itemsFrom,
  nextPoint,
  pasteItems,
  patchItems as patchTl,
  patchMarker,
  patchTrack,
  place,
  removeItems,
  removeMarker,
  removeTrack,
  rippleTrimToPlayhead,
  shiftItems,
  splitAt,
} from "../timeline/ops";
import { History } from "../timeline/history";
import TimelineView, { type EditPhase, type TimelineApi } from "../timeline/TimelineView";
import { type TlView, clampZoom, fitView, parseTime, reveal, timecode, zoomAt } from "../timeline/view";
import { cn } from "../utils/cn";
import { editorApi } from "./api";
import { drawFrame } from "./compose";
import Inspector, { type ClipActions } from "./Inspector";
import { ItemContent, TrackHeader, itemTone, type FxEdit } from "./ItemContent";
import { editorKeymap, runShortcut, tip, type EditorActions, type Shortcut } from "./keys";
import MediaBin, { DRAG_TYPE } from "./MediaBin";
import { media } from "./media";
import { Player } from "./player";
import Preview, { type SafeZone } from "./Preview";
import {
  type EdItem,
  type EdProject,
  type Picture,
  type TrackKind,
  DEFAULT_FX,
  TRACK_LIMIT,
  accepts,
  audioJob,
  exportRange,
  exportRoute,
  exportStem,
  kindOf,
  mainTrack,
  newProject,
  outputFps,
  outputSize,
  projectLength,
  renderJob,
  track as makeTrack,
  tracksOf,
} from "./project";
import { baseName, isEmpty, itemFromPath, lastOpen, loadProjects, saveProjects, stillPng, urlOf, MEDIA_RE, AUDIO_RE, IMAGE_RE } from "./store";
import { Btn, Ico, I, Menu, type MenuItem, Sep, usePersist } from "./ui";

/**
 * The editor: one window-sized place for everything that used to be split
 * between the quick trimmer and the old editor. Preview on top (with drawing
 * and picture handles), the timeline below, media on the left, settings on
 * the right. Panels open and close and remember it; every action has a key.
 */

type Tone = "ok" | "warn" | "err" | "info";

export interface EditorIncoming {
  paths: string[];
  seq: number;
  /** "open": a clip becomes its own project; "add": goes onto this one. */
  mode?: "open" | "add";
  flushMs?: number;
}

export interface EditorProps {
  clips: ClipMetadata[];
  incoming: EditorIncoming | null;
  onToast: (tone: Tone, title: string, body?: string) => void;
  onRendered: (c: ClipMetadata) => void;
  /** Files in the library changed (saved, renamed, deleted). */
  onClipsChanged?: () => void;
  shareLimitMb?: number;
  /** Keys work only while the editor is showing. */
  active?: boolean;
}

const TRACK_H: Record<string, number> = { video: 62, overlay: 30, audio: 50 };
const STILL = 5;
const SHAPE_SECONDS = 4;

type Ask = { title: string; body?: string; ok: string; danger?: boolean; field?: string; run: (v: string) => void };

export default function EditorView(props: EditorProps) {
  const { onToast } = props;
  const shareMb = props.shareLimitMb ?? 10;
  // ------------------------------------------------------------ project + history
  const [p, setP] = useState<EdProject>(() => lastOpen(loadProjects()));
  const pRef = useRef(p);
  pRef.current = p;
  const hist = useRef(new History<EdProject>());
  const [, setHv] = useState(0);
  const gesture = useRef<{ before: EdProject; label: string } | null>(null);

  /** Every change goes through here: one undo step per click or per drag. */
  const apply = useCallback((next: EdProject, phase: EditPhase, label: string) => {
    const cur = pRef.current;
    switch (phase) {
      case "start":
        gesture.current = { before: cur, label };
        break;
      case "live":
        if (!gesture.current) gesture.current = { before: cur, label };
        break;
      case "end": {
        const g = gesture.current;
        gesture.current = null;
        if (g && g.before.tl !== next.tl) {
          hist.current.push(g.before, g.label || label);
          setHv((x) => x + 1);
        } else if (g && g.before !== next) {
          hist.current.push(g.before, g.label || label);
          setHv((x) => x + 1);
        }
        break;
      }
      case "once":
        if (next === cur) return;
        hist.current.push(cur, label);
        setHv((x) => x + 1);
        break;
      case "cancel": {
        const g = gesture.current;
        gesture.current = null;
        if (g) next = g.before;
        break;
      }
    }
    pRef.current = next;
    setP(next);
  }, []);
  const setTl = useCallback((tl: EdProject["tl"], phase: EditPhase, label: string) => apply({ ...pRef.current, tl }, phase, label), [apply]);

  // ------------------------------------------------------------ saving
  const saveTimer = useRef(0);
  useEffect(() => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      const cur = pRef.current;
      const list = loadProjects().filter((x) => x.id !== cur.id);
      if (isEmpty(cur) && !cur.source) saveProjects(list.length ? [{ ...cur, updated: Date.now() }, ...list] : [{ ...cur, updated: Date.now() }]);
      else saveProjects([{ ...cur, updated: Date.now() }, ...list]);
    }, 500);
  }, [p]);
  // Save straight away when the editor goes (tab switch, window close).
  useEffect(() => {
    const flush = () => {
      const cur = pRef.current;
      saveProjects([{ ...cur, updated: Date.now() }, ...loadProjects().filter((x) => x.id !== cur.id)]);
    };
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      flush();
    };
  }, []);

  // ------------------------------------------------------------ player
  const player = useMemo(() => new Player(urlOf), []);
  useEffect(() => () => player.dispose(), [player]);
  useEffect(() => player.setProject(p), [player, p]);
  const [imgVer, setImgVer] = useState(0);
  const images = useMemo(() => new ImageCache(() => setImgVer((v) => v + 1)), []);
  const clock = useMemo(() => ({ get time() { return player.time; }, subscribe: (fn: (t: number, playing: boolean) => void) => player.subscribe(fn), seek: (t: number) => player.seek(t) }), [player]);
  const [playing, setPlaying] = useState(false);
  useEffect(() => player.subscribe((_t, pl) => setPlaying((o) => (o === pl ? o : pl))), [player]);
  const fps = outputFps(p);

  // ------------------------------------------------------------ UI state
  const [sel, setSel] = useState<Set<string>>(new Set());
  const selRef = useRef(sel);
  selRef.current = sel;
  const [gap, setGap] = useState<{ track: string; t: number; start: number; end: number } | null>(null);
  const [tool, setToolState] = useState<Tool | "blade" | "slip">("select");
  const [style, setStyle] = usePersist<Style>("style", DEFAULT_STYLE);
  const [editing, setEditing] = useState<string | null>(null);
  const [crop, setCrop] = useState<{ id: string; aspect: import("../lib/edit").CropAspect } | null>(null);
  const [quality, setQuality] = usePersist<number>("quality", 1);
  const [safe, setSafe] = usePersist<SafeZone>("safe", "off");
  const [showBin, setShowBin] = usePersist<boolean>("bin", true);
  const [showInsp, setShowInsp] = usePersist<boolean>("inspector", true);
  const [showDraw, setShowDraw] = usePersist<boolean>("drawbar", false);
  const [tlHeight, setTlHeight] = usePersist<number>("tlh", 300);
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; items: MenuItem[] } | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [help, setHelp] = useState(false);
  const [busy, setBusy] = useState<{ label: string; p: number | null } | null>(null);
  const [ghost, setGhost] = useState<{ track: string; start: number; duration: number; label: string } | null>(null);
  const [belowHint, setBelowHint] = useState<string | null>(null);
  const [view, setViewState] = useState<TlView>(() => p.view ?? { pxPerSec: 40, scroll: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const setView = useCallback((v: TlView) => setViewState({ pxPerSec: clampZoom(v.pxPerSec), scroll: Math.max(0, v.scroll) }), []);
  const focusArea = useRef<"preview" | "timeline" | "other">("timeline");
  const tlApi = useRef<TimelineApi | null>(null);
  const clipboard = useRef<EdItem[]>([]);
  const dragPaths = useRef<string[] | null>(null);
  const flushMsRef = useRef<number | undefined>(undefined);
  const shuttle = useRef(0);

  const setTool = (t: Tool | "blade" | "slip") => {
    setToolState(t);
    if (t !== "select" && t !== "blade" && t !== "slip") setShowDraw(true);
  };

  const selItems = useMemo(() => p.tl.items.filter((i) => sel.has(i.id)), [p.tl.items, sel]);
  const selShapes = selItems.filter((i) => i.kind === "shape" && i.shape);
  const objectFocus = () => focusArea.current === "preview" && pRef.current.tl.items.some((i) => selRef.current.has(i.id) && i.kind === "shape");

  const fit = useCallback(() => {
    const w = tlApi.current?.lanesWidth() ?? 800;
    setView(fitView(Math.max(5, projectLength(pRef.current)), w));
  }, [setView]);

  // Keep the playhead in view while playing.
  useEffect(
    () =>
      player.subscribe((t, pl) => {
        if (!pl) return;
        const w = tlApi.current?.lanesWidth() ?? 800;
        const v = viewRef.current;
        if (t > v.scroll + w / v.pxPerSec || t < v.scroll) setView(reveal(v, t, w, 0.05));
      }),
    [player, setView],
  );

  // ------------------------------------------------------------ library clip of this project
  const sourceClip = useMemo(() => (p.source ? props.clips.find((c) => c.path === p.source) ?? null : null), [p.source, props.clips]);

  // ------------------------------------------------------------ adding media
  const firstTrack = (tl: EdProject["tl"], it: EdItem): string | null => {
    const kind: TrackKind = it.kind === "audio" ? "audio" : it.kind === "shape" ? "overlay" : "video";
    if (kind === "video") return mainTrack(tl);
    return tracksOf(tl, kind).find((t) => !t.locked)?.id ?? null;
  };

  /** A track of `kind` free over [a, b] (adds one when allowed). */
  const freeTrack = (tl: EdProject["tl"], kind: TrackKind, a: number, b: number, prefer?: string): { tl: EdProject["tl"]; track: string | null } => {
    const list = tracksOf(tl, kind).filter((t) => !t.locked);
    const order = prefer ? [...list.filter((t) => t.id === prefer), ...list.filter((t) => t.id !== prefer)] : kind === "overlay" ? list : list;
    for (const t of order) if (!tl.items.some((i) => i.track === t.id && i.start < b - 1e-6 && end(i) > a + 1e-6)) return { tl, track: t.id };
    if (tracksOf(tl, kind).length < TRACK_LIMIT) {
      const nt = makeTrack(kind, tracksOf(tl, kind).length + 1);
      // Overlays and pictures stack on top; sound goes at the bottom.
      const idx = kind === "audio" ? tl.tracks.length : tl.tracks.findIndex((t) => t.kind === kind);
      return { tl: addTrack(tl, nt, Math.max(0, idx)), track: nt.id };
    }
    return { tl, track: order[0]?.id ?? null };
  };

  const clipByPath = (path: string) => props.clips.find((c) => c.path === path);

  const loadItems = async (paths: string[]): Promise<EdItem[]> => {
    const out: EdItem[] = [];
    const bad: string[] = [];
    await editorApi.allowMedia(paths.filter((x) => !x.startsWith("blob:"))).catch(() => undefined);
    for (const path of paths) {
      try {
        const it = await itemFromPath(path, clipByPath(path));
        if (it && it.duration > 0) out.push(it);
        else bad.push(baseName(path));
      } catch {
        bad.push(baseName(path));
      }
    }
    if (bad.length) onToast("warn", bad.length === 1 ? "Could not add this file" : `Could not add ${bad.length} files`, bad.slice(0, 4).join(", "));
    return out;
  };

  /**
   * Puts files on the timeline. `at`: where they were dropped; without it
   * they go at the playhead (pictures and clips on the main track, after the
   * clip under the playhead; sound on a free audio track).
   */
  const addPaths = async (paths: string[], at?: { track: string | null; t: number; below: boolean; insert: boolean }) => {
    const list = paths.filter((x) => MEDIA_RE.test(x) || clipByPath(x) || x.startsWith("blob:"));
    if (!list.length) {
      if (paths.length) onToast("warn", "Not a video, picture or sound", "The editor takes MP4, MOV, MKV, WebM, PNG, JPG, GIF, WebP, MP3, WAV, M4A and FLAC.");
      return;
    }
    const items = await loadItems(list);
    if (!items.length) return;
    let tl = pRef.current.tl;
    let t = at?.t ?? player.time;
    const placed: EdItem[] = [];
    let mode: "insert" | "overwrite" = at?.insert ? "insert" : "overwrite";
    for (const it0 of items) {
      const kind: TrackKind = it0.kind === "audio" ? "audio" : "video";
      let track: string | null = null;
      const span: [number, number] = [t, t + it0.duration];
      if (at?.track && kindOf(tl, at.track) === kind && !tl.tracks.find((x) => x.id === at.track)?.locked) track = at.track;
      else if (at?.below || (at?.track && kindOf(tl, at.track) !== kind)) {
        const r = freeTrack(tl, kind, ...span);
        tl = r.tl;
        track = r.track;
      } else if (!at) {
        if (kind === "video") {
          track = mainTrack(tl);
          // After the clip under the playhead, pushing the rest along.
          const under = tl.items.find((i) => i.track === track && i.start < t - 1e-6 && end(i) > t + 1e-6);
          if (under) t = end(under);
          mode = tl.items.some((i) => i.track === track && i.start >= t - 1e-6) ? "insert" : "overwrite";
        } else {
          const r = freeTrack(tl, kind, ...span);
          tl = r.tl;
          track = r.track;
        }
      } else {
        track = firstTrack(tl, it0);
      }
      if (!track) continue;
      const it = { ...it0, id: newId("i"), track, start: t };
      placed.push(it);
      tl = place(tl, [it], mode, { magnet: pRef.current.magnet ? mainTrack(tl) : null });
      t += it.duration;
    }
    if (!placed.length) return;
    // Recorded markers of a library clip become timeline markers too.
    apply({ ...pRef.current, tl }, "once", placed.length === 1 ? `Add ${placed[0].name}` : `Add ${placed.length} files`);
    setSel(new Set(placed.map((x) => x.id)));
    if (pRef.current.tl.items.length === placed.length) requestAnimationFrame(fit);
  };

  /** Opens a library clip (or video file) as its own project. */
  const openClip = async (path: string) => {
    const cur = pRef.current;
    const existing = loadProjects().find((x) => x.source === path);
    if (cur.source === path) return;
    if (existing) {
      switchTo(existing);
      return;
    }
    const items = await loadItems([path]);
    if (!items.length) return;
    const clip = clipByPath(path);
    const np = newProject(clip?.title || baseName(path).replace(/\.[^.]+$/, ""));
    np.source = path;
    const v = mainTrack(np.tl)!;
    const it = { ...items[0], track: v, start: 0 };
    np.tl = {
      ...np.tl,
      items: [it],
      markers: (clip?.markers ?? it.srcMarkers ?? []).map((t) => ({ id: newId("m"), t, label: "", color: "#4fb3ff" })),
    };
    switchTo(np);
  };

  const switchTo = (next: EdProject) => {
    const cur = pRef.current;
    const list = loadProjects().filter((x) => x.id !== cur.id && x.id !== next.id);
    saveProjects([{ ...next, updated: Date.now() }, ...(isEmpty(cur) && !cur.source ? [] : [{ ...cur, updated: cur.updated }]), ...list]);
    hist.current.clear();
    gesture.current = null;
    player.pause();
    pRef.current = next;
    setP(next);
    setSel(new Set());
    setGap(null);
    setEditing(null);
    setCrop(null);
    player.setProject(next);
    player.seek(0);
    if (next.view) setView(next.view);
    else requestAnimationFrame(fit);
  };

  // Files sent from the rest of the app (Open in editor, drops on the tab).
  const lastSeq = useRef(0);
  useEffect(() => {
    const inc = props.incoming;
    if (!inc || inc.seq === lastSeq.current) return;
    lastSeq.current = inc.seq;
    flushMsRef.current = inc.flushMs;
    const single = inc.paths.length === 1 && !IMAGE_RE.test(inc.paths[0]) && !AUDIO_RE.test(inc.paths[0]);
    const mode = inc.mode ?? (single ? "open" : "add");
    if (mode === "open" && single) void openClip(inc.paths[0]);
    else void addPaths(inc.paths, { track: null, t: projectLength(pRef.current), below: false, insert: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.incoming]);

  const importFiles = async () => {
    if (!isTauri()) return onToast("info", "Add files works in the installed app", "In this preview, drag clips from the Library list.");
    const picked = await openDialog({
      multiple: true,
      title: "Add to the timeline",
      filters: [
        { name: "Videos, pictures and sound", extensions: ["mp4", "mov", "m4v", "mkv", "webm", "avi", "wmv", "png", "jpg", "jpeg", "gif", "webp", "bmp", "mp3", "wav", "m4a", "aac", "flac", "ogg", "wma"] },
      ],
    }).catch(() => null);
    if (!picked) return;
    void addPaths(Array.isArray(picked) ? picked : [picked]);
  };

  // ------------------------------------------------------------ drops (library list, Explorer, other windows)
  const dropKind = (e: React.DragEvent): TrackKind | null => {
    const paths = dragPaths.current;
    if (paths?.length) return AUDIO_RE.test(paths[0]) ? "audio" : "video";
    const it = Array.from(e.dataTransfer.items ?? []).find((x) => x.kind === "file");
    if (it) return it.type.startsWith("audio/") ? "audio" : "video";
    return e.dataTransfer.types.includes(DRAG_TYPE) ? "video" : null;
  };
  const droppable = (e: React.DragEvent) => e.dataTransfer.types.includes("Files") || e.dataTransfer.types.includes(DRAG_TYPE);
  const hitFor = (e: React.DragEvent) => {
    const h = tlApi.current?.hit(e.clientX, e.clientY);
    return h ?? null;
  };
  const onTlDragOver = (e: React.DragEvent) => {
    if (!droppable(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    const h = hitFor(e);
    const kind = dropKind(e) ?? "video";
    if (!h) return;
    const tl = pRef.current.tl;
    const track = h.track && kindOf(tl, h.track.id) === kind ? h.track.id : tracksOf(tl, kind)[0]?.id;
    const clip = dragPaths.current?.[0] ? clipByPath(dragPaths.current[0]) : undefined;
    const label = dragPaths.current?.length ? baseName(dragPaths.current[0]) : "Drop here";
    if (h.below) {
      setGhost(null);
      setBelowHint(tracksOf(tl, kind).length < TRACK_LIMIT ? `Drop for a new ${kind === "audio" ? "audio" : "video"} track` : "No more tracks of this kind");
      return;
    }
    setBelowHint("");
    if (track) setGhost({ track, start: h.t, duration: clip?.duration_seconds ?? STILL, label: `${label}${e.ctrlKey ? " · insert" : ""}` });
  };
  const clearDrag = () => {
    setGhost(null);
    setBelowHint(null);
  };
  const pathsOf = async (e: React.DragEvent): Promise<string[]> => {
    const raw = e.dataTransfer.getData(DRAG_TYPE);
    if (raw) {
      try {
        return JSON.parse(raw) as string[];
      } catch {
        return [];
      }
    }
    const files = Array.from(e.dataTransfer.files ?? []);
    if (!files.length) return [];
    if (isTauri()) {
      const got = await editorApi.dropPaths(files);
      if (!got.length) onToast("warn", "Could not read the dropped files", "Use Add files (Ctrl+I) instead.");
      return got;
    }
    // Browser preview: play the files from memory.
    return files.map((f) => `${URL.createObjectURL(f)}#${f.name}`);
  };
  const onTlDrop = async (e: React.DragEvent) => {
    if (!droppable(e)) return;
    e.preventDefault();
    const h = hitFor(e);
    const insert = e.ctrlKey;
    clearDrag();
    dragPaths.current = null;
    const paths = await pathsOf(e);
    if (!paths.length) return;
    void addPaths(paths, h ? { track: h.track?.id ?? null, t: h.t, below: h.below, insert } : undefined);
  };
  const onRootDrop = async (e: React.DragEvent) => {
    if (!droppable(e) || e.defaultPrevented) return;
    e.preventDefault();
    clearDrag();
    dragPaths.current = null;
    const paths = await pathsOf(e);
    if (!paths.length) return;
    if (isEmpty(pRef.current) && paths.length === 1 && !IMAGE_RE.test(paths[0]) && !AUDIO_RE.test(paths[0]) && clipByPath(paths[0])) void openClip(paths[0]);
    else void addPaths(paths);
  };

  // ------------------------------------------------------------ edits
  const editOpts = useCallback(() => ({ magnet: pRef.current.magnet ? mainTrack(pRef.current.tl) : null }), []);
  const sounds = (it: EdItem) => it.kind === "audio" || (it.kind === "video" && !!it.hasAudio);

  const patchSel = (fn: (it: EdItem) => Partial<EdItem>, commit: boolean, label: string, ids?: Iterable<string>) => {
    const set = new Set(ids ?? selRef.current);
    const tl = patchTl(pRef.current.tl, set, (it) => fn(it));
    apply({ ...pRef.current, tl }, commit ? (gesture.current ? "end" : "once") : "live", label);
  };

  const onFx: FxEdit = (it, patch, phase) => {
    const ids = selRef.current.has(it.id) ? [...selRef.current].filter((id) => pRef.current.tl.items.find((x) => x.id === id && sounds(x))) : [it.id];
    if (phase === "start") return apply(pRef.current, "start", "Sound");
    if (phase === "end") return apply(pRef.current, "end", "Sound");
    const tl = patchTl(pRef.current.tl, ids, (x) => ({ audio: { ...DEFAULT_FX, ...x.audio, ...patch } }));
    apply({ ...pRef.current, tl }, "live", "Sound");
  };

  const onPic = (id: string, patch: Partial<Picture>, phase: EditPhase, label: string) => {
    if (phase === "end") return apply(pRef.current, "end", label);
    const tl = patchTl(pRef.current.tl, [id], (x) => ({ pic: { ...x.pic, ...patch } }));
    apply({ ...pRef.current, tl }, phase, label);
  };

  const onShapes = (changed: Shape[], commit: boolean, label: string) => {
    const by = new Map(changed.map((s) => [s.id, s]));
    const tl = patchTl(pRef.current.tl, by.keys(), (it) => ({ shape: by.get(it.id) }));
    apply({ ...pRef.current, tl }, commit ? (gesture.current ? "end" : "once") : "live", label);
  };

  const onCreateShape = (s: Shape) => {
    const cur = pRef.current;
    const t = player.time;
    const len = projectLength(cur);
    let d = SHAPE_SECONDS;
    if (len > 0 && t < len && len - t < d) d = Math.max(1, len - t);
    const r = freeTrack(cur.tl, "overlay", t, t + d);
    if (!r.track) return onToast("warn", "No overlay track", "Add an overlay track or unlock one.");
    // On a busy track, use the free space up to the next object.
    const next = r.tl.items.filter((i) => i.track === r.track && i.start >= t).sort((a, b) => a.start - b.start)[0];
    if (next && next.start < t + d) d = Math.max(0.2, next.start - t);
    const names: Record<string, string> = { text: "Text", rect: "Rectangle", ellipse: "Ellipse", arrow: "Arrow", line: "Line", pen: "Drawing", highlight: "Highlight", step: "Step", pixelate: "Pixelate", blur: "Blur", redact: "Black box", image: "Picture" };
    const it: EdItem = { id: s.id, track: r.track, kind: "shape", name: names[s.kind] ?? s.kind, start: t, duration: d, srcIn: 0, shape: s };
    apply({ ...cur, tl: place(r.tl, [it], "overwrite") }, "once", `Add ${it.name.toLowerCase()}`);
    setSel(new Set([it.id]));
  };

  const removeIds = (ids: Iterable<string>, ripple: boolean, label: string) => {
    const set = new Set(ids);
    if (!set.size) return;
    const tl = removeItems(pRef.current.tl, set, ripple, editOpts());
    apply({ ...pRef.current, tl }, "once", label);
    setSel(new Set());
    if (editing && set.has(editing)) setEditing(null);
  };

  const unlocked = (ids: Iterable<string>) => {
    const tl = pRef.current.tl;
    return [...ids].filter((id) => {
      const it = tl.items.find((i) => i.id === id);
      return it && !tl.tracks.find((t) => t.id === it.track)?.locked && !it.shape?.locked;
    });
  };

  const split = (all: boolean) => {
    const cur = pRef.current;
    const t = player.time;
    const selected = [...selRef.current].filter((id) => {
      const it = cur.tl.items.find((i) => i.id === id);
      return it && it.start < t - 1e-3 && end(it) > t + 1e-3;
    });
    let ids: string[] | null;
    if (all) ids = null;
    else if (selected.length) ids = [...withLinked(cur.tl, selected)];
    else ids = cur.tl.items.filter((i) => kindOf(cur.tl, i.track) !== "overlay" && i.start < t && end(i) > t).map((i) => i.id);
    const r = splitAt(cur.tl, t, ids ? unlocked(ids) : unlocked(cur.tl.items.map((i) => i.id)));
    if (!r.created.length) return onToast("info", "Nothing to split here", "Put the playhead over a clip.");
    apply({ ...cur, tl: r.tl }, "once", "Split");
  };

  const del = (ripple: boolean) => {
    const cur = pRef.current;
    if (gap && !selRef.current.size) {
      apply({ ...cur, tl: closeGap(cur.tl, gap.track, gap.t) }, "once", "Close gap");
      setGap(null);
      return;
    }
    const ids = unlocked(withLinked(cur.tl, selRef.current));
    removeIds(ids, ripple, ripple ? "Ripple delete" : "Delete");
  };

  const copySel = () => {
    const cur = pRef.current;
    const ids = withLinked(cur.tl, selRef.current);
    clipboard.current = cur.tl.items.filter((i) => ids.has(i.id)).map((i) => ({ ...i }));
    return clipboard.current.length;
  };

  const paste = (at?: number) => {
    const cur = pRef.current;
    if (!clipboard.current.length) return;
    const fallback = (i: EdItem) => firstTrack(cur.tl, i);
    const items = clipboard.current.map((i) => (i.shape ? { ...i, shape: { ...i.shape, id: "" } } : i));
    const r = pasteItems(cur.tl, items, at ?? player.time, fallback, "overwrite", editOpts());
    // Shapes keep item id = shape id.
    const tl = { ...r.tl, items: r.tl.items.map((i) => (r.created.includes(i.id) && i.shape ? { ...i, shape: { ...i.shape, id: i.id } } : i)) };
    apply({ ...cur, tl }, "once", "Paste");
    setSel(new Set(r.created));
  };

  const duplicate = () => {
    const cur = pRef.current;
    if (!copySel()) return;
    const objs = clipboard.current.every((i) => i.kind === "shape");
    if (objs && focusArea.current === "preview") {
      // Objects: a copy slightly offset on the picture, same time.
      const r = pasteItems(cur.tl, clipboard.current, Math.min(...clipboard.current.map((i) => i.start)), () => null, "overwrite");
      let tl = r.tl;
      // Same track would overlap: put copies on a free overlay track.
      const copies = r.tl.items.filter((i) => r.created.includes(i.id));
      if (copies.length < clipboard.current.length || copies.some((c) => !c.shape)) return paste(end(clipboard.current[0]));
      tl = {
        ...tl,
        items: tl.items.map((i) => (r.created.includes(i.id) && i.shape ? { ...i, shape: { ...moveBy(i.shape, 24, 24), id: i.id } } : i)),
      };
      apply({ ...cur, tl }, "once", "Duplicate");
      setSel(new Set(r.created));
      return;
    }
    paste(Math.max(...clipboard.current.map((i) => end(i))));
  };

  const shapeEdit = (fn: (s: Shape) => Shape, label: string) => {
    const ids = selShapesNow();
    if (!ids.length) return false;
    const tl = patchTl(pRef.current.tl, ids, (it) => (it.shape && !it.shape.locked ? { shape: fn(it.shape) } : {}));
    apply({ ...pRef.current, tl }, "once", label);
    return true;
  };
  const selShapesNow = () => pRef.current.tl.items.filter((i) => selRef.current.has(i.id) && i.shape).map((i) => i.id);

  const picEdit = (fn: (q: Picture) => Partial<Picture>, label: string) => {
    const ids = pRef.current.tl.items.filter((i) => selRef.current.has(i.id) && (i.kind === "video" || i.kind === "image")).map((i) => i.id);
    if (!ids.length) return false;
    const tl = patchTl(pRef.current.tl, ids, (it) => ({ pic: { ...it.pic, ...fn(it.pic ?? {}) } }));
    apply({ ...pRef.current, tl }, "once", label);
    return true;
  };

  const detachAudio = () => {
    let tl = pRef.current.tl;
    const vids = tl.items.filter((i) => selRef.current.has(i.id) && i.kind === "video" && i.hasAudio);
    if (!vids.length) return onToast("info", "Select a clip with sound first");
    const made: string[] = [];
    for (const v of vids) {
      const r = freeTrack(tl, "audio", v.start, end(v));
      tl = r.tl;
      if (!r.track) continue;
      const link = v.link ?? newId("l");
      const a: EdItem = { id: newId("i"), track: r.track, kind: "audio", name: `${v.name} (sound)`, path: v.path, start: v.start, duration: v.duration, srcIn: v.srcIn, srcDuration: v.srcDuration, hasAudio: true, audio: { ...DEFAULT_FX, ...v.audio }, link };
      tl = place(tl, [a], "overwrite");
      tl = patchTl(tl, [v.id], { hasAudio: false, link, audio: { ...DEFAULT_FX } });
      made.push(a.id);
    }
    apply({ ...pRef.current, tl }, "once", "Detach audio");
    setSel(new Set(made));
  };

  const setLink = (on: boolean) => {
    const ids = [...selRef.current];
    if (on && ids.length < 2) return;
    const link = on ? newId("l") : undefined;
    patchSel(() => ({ link }), true, on ? "Link" : "Unlink", on ? ids : withLinked(pRef.current.tl, ids));
  };

  const moveTo = (id: string, t: number) => {
    const cur = pRef.current;
    const it = cur.tl.items.find((i) => i.id === id);
    if (!it) return;
    apply({ ...cur, tl: shiftItems(cur.tl, withLinked(cur.tl, [id]), t - it.start, "overwrite", editOpts()) }, "once", "Move");
  };
  const setLength = (id: string, d: number) => {
    const cur = pRef.current;
    const it = cur.tl.items.find((i) => i.id === id);
    if (!it) return;
    const max = it.srcDuration !== undefined ? it.srcDuration - it.srcIn : Infinity;
    const nd = Math.max(0.05, Math.min(max, d));
    const tl = place(cur.tl, [{ ...it, duration: nd }], "overwrite", editOpts());
    apply({ ...cur, tl }, "once", "Length");
  };

  const markRange = (a: number | null, b: number | null, label: string) => apply({ ...pRef.current, tl: { ...pRef.current.tl, inPoint: a, outPoint: b } }, "once", label);
  const lastSeconds = (s: number) => {
    const len = projectLength(pRef.current);
    markRange(Math.max(0, len - s), len, `Last ${s} s`);
  };
  const cutRange = (keep: boolean) => {
    const cur = pRef.current;
    const { inPoint: a, outPoint: b } = cur.tl;
    if (a === null && b === null) return onToast("info", "Set a range first", "Press I at the start and O at the end.");
    const r = exportRange(cur);
    const tl = extractRange(cur.tl, r.start, r.end, keep);
    apply({ ...cur, tl: { ...tl, inPoint: null, outPoint: null } }, "once", keep ? "Keep only the range" : "Cut out the range");
    player.seek(keep ? 0 : r.start);
  };

  // ------------------------------------------------------------ export
  const preloadImages = async (cur: EdProject) => {
    const srcs = new Set<string>();
    for (const i of cur.tl.items) if (i.shape?.kind === "image" && i.shape.src) srcs.add(urlOf(i.shape.src));
    await Promise.all(
      [...srcs].map(
        (u) =>
          new Promise<void>((res) => {
            if (images.get(u)) return res();
            const t0 = Date.now();
            const poll = () => (images.get(u) || Date.now() - t0 > 4000 ? res() : setTimeout(poll, 50));
            poll();
          }),
      ),
    );
  };

  const runExport = async (mode: "save" | "share") => {
    const cur = pRef.current;
    if (busy) return;
    if (!cur.tl.items.some((i) => !i.disabled)) return onToast("info", "Nothing to export yet", "Add a clip to the timeline first.");
    const r = exportRange(cur);
    if (r.end - r.start < 0.05) return onToast("warn", "The range is empty", "Clear in and out (Alt+X) or set them again.");
    const route = exportRoute(cur);
    player.pause();
    const key = `editor-${Date.now()}`;
    setBusy({ label: mode === "save" ? "Exporting…" : `Shrinking under ${shareMb} MB…`, p: null });
    const offs: (() => void)[] = [];
    const prog = (x: number) => setBusy((b) => (b ? { ...b, p: x } : b));
    try {
      offs.push(await editorApi.onRenderProgress(prog));
      const sp = await Promise.resolve(lastshot.onShrinkProgress((e) => (e.path === key || (route.kind === "copy" && e.path === route.path) ? prog(e.progress) : undefined)));
      if (typeof sp === "function") offs.push(sp);
      let res: ClipMetadata | ShrinkResult | { path: string; file_name: string; size_bytes: number };
      if (route.kind === "copy") {
        if (mode === "save") res = await lastshot.trimClip(route.path, route.start, route.end, false);
        else res = await lastshot.shrinkClip(route.path, { start: route.start, end: route.end, copy: true, keep: false });
      } else if (route.kind === "segments") {
        res = await lastshot.exportClip({ segments: route.segments, crop: route.crop, mode, copy: mode === "share", progressKey: key });
      } else {
        await preloadImages(cur);
        const env = { image: (s: string) => images.get(urlOf(s)) };
        const job = await renderJob(cur, {
          range: r,
          targetMb: mode === "share" ? shareMb : null,
          norm: (it) => media.normGain(it),
          still: (it) => stillPng(it),
          raster: (s) => rasterize(s, env),
        });
        res = await editorApi.render(job, mode, exportStem(cur));
      }
      if (mode === "save") {
        onToast("ok", "Saved as a new clip", `${res.file_name} · ${formatBytes(res.size_bytes)}${route.kind === "copy" ? " · lossless" : ""}`);
        if ("id" in res && "created_unix_ms" in res) props.onRendered(res as ClipMetadata);
        props.onClipsChanged?.();
      } else {
        onToast("ok", "Copied, ready to paste", `${res.file_name} · ${formatBytes(res.size_bytes)}. Paste it in Discord with Ctrl+V.`);
      }
    } catch (e) {
      onToast("err", mode === "save" ? "Export failed" : "Shrink failed", String(e));
    } finally {
      offs.forEach((o) => o());
      setBusy(null);
    }
  };

  const exportAudio = async () => {
    const cur = pRef.current;
    if (!isTauri()) return onToast("info", "Audio export works in the installed app");
    const chosen = cur.tl.items.filter((i) => selRef.current.has(i.id) && sounds(i));
    const items = chosen.length ? chosen : cur.tl.items;
    const range = chosen.length ? { start: Math.min(...chosen.map((i) => i.start)), end: Math.max(...chosen.map((i) => end(i))) } : exportRange(cur);
    const job = audioJob(cur, items.filter((i) => !i.disabled), (it) => media.normGain(it), range);
    if (!job.length) return onToast("info", "No sound to export", "The selection has no sound (or it is muted).");
    const formats = await (window as unknown as { __TAURI__: { core: { invoke: <T>(c: string) => Promise<T> } } }).__TAURI__.core.invoke<string[]>("audio_formats").catch(() => ["wav", "m4a"]);
    const filters = [
      { name: "WAV (lossless)", extensions: ["wav"] },
      ...(formats.includes("mp3") ? [{ name: "MP3", extensions: ["mp3"] }] : []),
      { name: "M4A (AAC)", extensions: ["m4a"] },
    ];
    const dest = await saveDialog({ title: "Export audio", defaultPath: `${exportStem(cur)}_audio.wav`, filters }).catch(() => null);
    if (!dest) return;
    setBusy({ label: "Exporting audio…", p: null });
    try {
      const out = await editorApi.exportAudio(job, range.end - range.start, dest);
      onToast("ok", "Audio saved", baseName(out));
    } catch (e) {
      onToast("err", "Audio export failed", String(e));
    } finally {
      setBusy(null);
    }
  };

  /** The frame at the playhead at full size. */
  const frameCanvas = (): HTMLCanvasElement => {
    const cur = pRef.current;
    const { w, h } = outputSize(cur);
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    drawFrame(c.getContext("2d")!, cur, player.time, w, h, 1, { video: (it) => player.videoOf(it), image: images.get, urlOf });
    return c;
  };
  const snapshot = async (how: "save" | "copy") => {
    try {
      const c = frameCanvas();
      if (how === "copy") {
        const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
        if (!blob) throw new Error("No picture");
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        onToast("ok", "Frame copied", "Paste it with Ctrl+V.");
      } else {
        const where = await lastshot.snapshotToOutput(c.toDataURL("image/png"), `${exportStem(pRef.current)}_${timecode(player.time, fps).replace(/[:.]/g, "-")}`);
        onToast("ok", "Frame saved", baseName(where));
      }
    } catch (e) {
      onToast("err", "Could not take the frame", String(e));
    }
  };

  // ------------------------------------------------------------ clip file actions (project opened from a clip)
  const clipActions: ClipActions | null = sourceClip
    ? {
        rename: (name) =>
          void lastshot
            .renameClip(sourceClip.path, name)
            .then((np) => {
              apply({ ...pRef.current, source: np, name, tl: { ...pRef.current.tl, items: pRef.current.tl.items.map((i) => (i.path === sourceClip.path ? { ...i, path: np } : i)) } }, "once", "Rename");
              props.onClipsChanged?.();
            })
            .catch((e) => onToast("err", "Could not rename", String(e))),
        favorite: () => void lastshot.setClipFavorite(sourceClip.path, !sourceClip.favorite).then(() => props.onClipsChanged?.()),
        tags: (tags) => void lastshot.setClipTags(sourceClip.path, tags).then(() => props.onClipsChanged?.()),
        reveal: () => void lastshot.revealClip(sourceClip.path),
        openExternal: () => void lastshot.openClip(sourceClip.path),
        copyFile: () => void lastshot.copyClip(sourceClip.path).then(() => onToast("ok", "File copied", "Paste it in Discord or Explorer.")),
        moveToLibrary: sourceClip.folder
          ? () =>
              void lastshot
                .moveClipToLibrary(sourceClip.path)
                .then((np) => {
                  apply({ ...pRef.current, source: np, tl: { ...pRef.current.tl, items: pRef.current.tl.items.map((i) => (i.path === sourceClip.path ? { ...i, path: np } : i)) } }, "once", "Move file");
                  props.onClipsChanged?.();
                })
                .catch((e) => onToast("err", "Could not move", String(e)))
          : undefined,
        splitFile: () => {
          const it = pRef.current.tl.items.find((i) => i.path === sourceClip.path && player.time >= i.start && player.time < end(i));
          const at = it ? it.srcIn + (player.time - it.start) : player.time;
          if (at < 0.2 || at > sourceClip.duration_seconds - 0.2) return onToast("info", "Move the playhead inside the clip first");
          void lastshot
            .splitClip(sourceClip.path, at)
            .then(() => {
              onToast("ok", "Split into two files", "Both parts are in Clips (lossless).");
              props.onClipsChanged?.();
            })
            .catch((e) => onToast("err", "Could not split", String(e)));
        },
        discard: () =>
          void lastshot
            .deleteClip(sourceClip.path)
            .then(() => {
              onToast("ok", "Clip discarded", sourceClip.file_name);
              props.onClipsChanged?.();
              const rest = loadProjects().filter((x) => x.id !== pRef.current.id);
              saveProjects(rest);
              switchTo(newProject());
            })
            .catch((e) => onToast("err", "Could not discard", String(e))),
      }
    : null;

  // ------------------------------------------------------------ keys
  const actions: EditorActions = {
    togglePlay: () => {
      shuttle.current = 0;
      player.loop = null;
      player.toggle();
    },
    shuttle: (dir) => {
      if (dir === 0) {
        shuttle.current = 0;
        return player.pause();
      }
      const s = shuttle.current;
      const next = Math.sign(s) === dir ? Math.min(8, Math.abs(s) * 2) * dir : dir;
      shuttle.current = next;
      player.play(next);
    },
    step: (n) => {
      player.pause();
      player.seek(player.time + n / fps);
    },
    stepSeconds: (s) => player.seek(player.time + s),
    editPoint: (dir) => {
      const t = nextPoint(editPoints(pRef.current.tl), player.time, dir);
      if (t !== null) player.seek(t);
    },
    home: () => player.seek(0),
    end: () => player.seek(projectLength(pRef.current)),
    loopPlay: () => {
      const r = exportRange(pRef.current);
      player.loop = { a: r.start, b: r.end };
      player.seek(r.start);
      player.play(1);
    },
    markIn: () => markRange(player.time, pRef.current.tl.outPoint !== null && pRef.current.tl.outPoint <= player.time ? null : pRef.current.tl.outPoint, "Mark in"),
    markOut: () => markRange(pRef.current.tl.inPoint !== null && pRef.current.tl.inPoint >= player.time ? null : pRef.current.tl.inPoint, player.time, "Mark out"),
    clearInOut: () => markRange(null, null, "Clear in and out"),
    split: () => split(false),
    splitAll: () => split(true),
    blade: () => setTool(tool === "blade" ? "select" : "blade"),
    slip: () => setTool(tool === "slip" ? "select" : "slip"),
    select: () => setTool("select"),
    del: () => del(false),
    rippleDelete: () => del(true),
    trimLeft: () => apply({ ...pRef.current, tl: rippleTrimToPlayhead(pRef.current.tl, player.time, "left", selRef.current.size ? selRef.current : null) }, "once", "Trim start"),
    trimRight: () => apply({ ...pRef.current, tl: rippleTrimToPlayhead(pRef.current.tl, player.time, "right", selRef.current.size ? selRef.current : null) }, "once", "Trim end"),
    undo: () => {
      const prev = hist.current.undo(pRef.current);
      if (!prev) return;
      pRef.current = prev;
      setP(prev);
      setHv((x) => x + 1);
    },
    redo: () => {
      const nx = hist.current.redo(pRef.current);
      if (!nx) return;
      pRef.current = nx;
      setP(nx);
      setHv((x) => x + 1);
    },
    copy: () => void copySel(),
    cut: () => {
      if (copySel()) del(false);
    },
    paste: () => paste(),
    duplicate,
    selectAll: () => setSel(new Set(pRef.current.tl.items.map((i) => i.id))),
    deselect: () => {
      if (crop) return setCrop(null);
      if (tool !== "select") return setTool("select");
      setSel(new Set());
      setGap(null);
    },
    nudge: (n) => {
      const ids = unlocked(withLinked(pRef.current.tl, selRef.current));
      if (ids.length) apply({ ...pRef.current, tl: shiftItems(pRef.current.tl, ids, n / fps, "overwrite", editOpts()) }, "once", "Nudge");
    },
    toggleEnable: () => {
      const any = selItems.some((i) => !i.disabled);
      patchSel(() => ({ disabled: any || undefined }), true, any ? "Turn off" : "Turn on", withLinked(pRef.current.tl, selRef.current));
    },
    toggleSnap: () => setP((x) => (pRef.current = { ...x, snapping: !x.snapping })),
    toggleMagnet: () => setP((x) => (pRef.current = { ...x, magnet: !x.magnet })),
    marker: () => {
      const r = addMarker(pRef.current.tl, player.time);
      apply({ ...pRef.current, tl: r.tl }, "once", "Add marker");
    },
    marker2: (dir) => {
      const t = nextPoint(pRef.current.tl.markers.map((m) => m.t).sort((a, b) => a - b), player.time, dir);
      if (t !== null) player.seek(t);
    },
    zoom: (f) => {
      const v = viewRef.current;
      setView(zoomAt(v, f, Math.max(0, (player.time - v.scroll) * v.pxPerSec)));
    },
    fit,
    tool: (t) => setTool(t as Tool),
    rotate: (deg) => {
      if (objectFocus() && shapeEdit((s) => rotateBy(s, deg), "Turn")) return;
      picEdit((q) => ({ rot90: ((((q.rot90 ?? 0) + deg) % 360) + 360) % 360 as Picture["rot90"] }), "Turn");
    },
    flip: (axis) => {
      if (objectFocus() && shapeEdit((s) => flipShape(s, axis), "Flip")) return;
      picEdit((q) => (axis === "x" ? { flipH: !q.flipH } : { flipV: !q.flipV }), "Flip");
    },
    order: (dir) => {
      const ids = new Set(selShapesNow());
      if (!ids.size) return;
      apply({ ...pRef.current, tl: { ...pRef.current.tl, items: reorder(pRef.current.tl.items, ids, dir) } }, "once", "Order");
    },
    lock: () => {
      const ids = selShapesNow();
      const any = pRef.current.tl.items.some((i) => ids.includes(i.id) && !i.shape?.locked);
      const tl = patchTl(pRef.current.tl, ids, (it) => ({ shape: { ...it.shape!, locked: any } }));
      apply({ ...pRef.current, tl }, "once", any ? "Lock" : "Unlock");
    },
    opacity: (v) => void shapeEdit((s) => ({ ...s, opacity: v }), "Opacity"),
    arrows: (dx, dy) => shapeEdit((s) => moveBy(s, dx, dy), "Nudge"),
    exportSave: () => void runExport("save"),
    exportShare: () => void runExport("share"),
    snapshot: () => void snapshot("save"),
    importFiles: () => void importFiles(),
    detachAudio,
    selectSide: (dir) => setSel(new Set(itemsFrom(pRef.current.tl, player.time, dir))),
    editText: () => {
      const it = pRef.current.tl.items.find((i) => selRef.current.has(i.id) && i.shape?.kind === "text");
      if (!it) return false;
      setEditing(it.id);
      return true;
    },
    objectFocus,
  };
  const actRef = useRef(actions);
  actRef.current = actions;
  const keymap: Shortcut[] = useMemo(() => {
    const a = new Proxy({} as EditorActions, { get: (_t, k) => (...args: unknown[]) => (actRef.current[k as keyof EditorActions] as (...x: unknown[]) => unknown)(...args) });
    const extra: Shortcut[] = [
      { keys: "X", label: "Cut out in → out (closes the gap)", group: "Range", run: () => cutRange(false) },
      { keys: "Shift+X", label: "Keep only in → out", group: "Range", run: () => cutRange(true) },
      { keys: "Ctrl+Shift+C", label: "Copy the frame as a picture", group: "File", run: () => void snapshot("copy") },
      { keys: "?", label: "Show all shortcuts", group: "Help", run: () => setHelp((h) => !h) },
      { keys: "F1", label: "Show all shortcuts", group: "Help", run: () => setHelp((h) => !h) },
    ];
    return [...editorKeymap(a), ...extra];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const k = (label: string, text?: string) => tip(keymap, label, text);

  const active = props.active ?? true;
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (menu || ask || editing) return;
      if (help && e.key === "Escape") return setHelp(false);
      // "?" arrives as Shift+/ on most layouts.
      if (e.key === "?" && !(e.target as HTMLElement)?.closest?.("input,textarea,select")) {
        e.preventDefault();
        return setHelp((h) => !h);
      }
      runShortcut(keymap, e);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, keymap, menu, ask, editing, help]);

  // ------------------------------------------------------------ menus
  const projectsMenu = (e: React.MouseEvent) => {
    const list = loadProjects().filter((x) => x.id !== p.id);
    setMenu({
      at: { x: e.currentTarget.getBoundingClientRect().left, y: e.currentTarget.getBoundingClientRect().bottom + 4 },
      items: [
        { label: "New project", run: () => switchTo(newProject()) },
        {
          label: "Open recent",
          disabled: !list.length,
          sub: list.slice(0, 16).map((x) => ({ label: `${x.name} · ${new Date(x.updated).toLocaleDateString()}`, run: () => switchTo(x) })),
        },
        { sep: true, label: "" },
        { label: "Rename project…", run: () => setAsk({ title: "Rename project", ok: "Rename", field: p.name, run: (v) => v.trim() && apply({ ...pRef.current, name: v.trim() }, "once", "Rename project") }) },
        { label: "Duplicate project", run: () => switchTo({ ...structuredClone(pRef.current), id: newId("p"), name: `${pRef.current.name} copy`, source: null, updated: Date.now() }) },
        {
          label: "Delete project…",
          danger: true,
          run: () =>
            setAsk({
              title: `Delete "${p.name}"?`,
              body: "The edit is removed from the list. Your clips and exported files stay.",
              ok: "Delete",
              danger: true,
              run: () => {
                saveProjects(loadProjects().filter((x) => x.id !== pRef.current.id));
                const rest = loadProjects();
                pRef.current = newProject();
                switchTo(rest[0] ?? newProject());
              },
            }),
        },
      ],
    });
  };

  const exportMenu = (e: React.MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    const route = exportRoute(p);
    setMenu({
      at: { x: r.right - 280, y: r.bottom + 4 },
      items: [
        { label: route.kind === "copy" ? "Save as a new clip (lossless)" : "Save as a new clip", key: "Ctrl+E", run: () => void runExport("save") },
        { label: `Shrink under ${shareMb} MB and copy (Discord)`, key: "Ctrl+Shift+E", run: () => void runExport("share") },
        { sep: true, label: "" },
        { label: "Export audio as a file…", run: () => void exportAudio(), hint: "WAV, MP3 or M4A" },
        { label: "Save the frame as a picture", key: "Ctrl+Shift+S", run: () => void snapshot("save") },
        { label: "Copy the frame", key: "Ctrl+Shift+C", run: () => void snapshot("copy") },
        ...(sourceClip ? [{ sep: true, label: "" }, { label: "Split the clip file in two at the playhead", run: () => clipActions?.splitFile() }] : []),
      ],
      minWidth: 280,
    } as { at: { x: number; y: number }; items: MenuItem[] });
  };

  const rangeMenu = (e: React.MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    setMenu({
      at: { x: r.left, y: r.top - 8 - 260 },
      items: [
        { label: "Mark in", key: "I", run: actions.markIn },
        { label: "Mark out", key: "O", run: actions.markOut },
        ...[5, 10, 15, 30].map((s) => ({ label: `Last ${s} seconds`, run: () => lastSeconds(s) })),
        { sep: true, label: "" },
        { label: "Play the range in a loop", key: "Shift+Space", run: actions.loopPlay },
        { label: "Cut out the range (close the gap)", key: "X", run: () => cutRange(false) },
        { label: "Keep only the range", key: "Shift+X", run: () => cutRange(true) },
        { label: "Clear in and out", key: "Alt+X", run: actions.clearInOut },
      ],
    });
  };

  const trackMenu = (tr: Track, at: { x: number; y: number }) => {
    const cur = pRef.current;
    const kind = tr.kind as TrackKind;
    const count = tracksOf(cur.tl, kind).length;
    const idx = cur.tl.tracks.findIndex((t) => t.id === tr.id);
    const add = (where: number) => apply({ ...cur, tl: addTrack(cur.tl, makeTrack(kind, count + 1), where) }, "once", "Add track");
    setMenu({
      at,
      items: [
        { label: "Rename…", run: () => setAsk({ title: "Rename track", ok: "Rename", field: tr.name, run: (v) => v.trim() && apply({ ...pRef.current, tl: patchTrack(pRef.current.tl, tr.id, { name: v.trim() }) }, "once", "Rename track") }) },
        { label: `Add a ${kind} track above`, disabled: count >= TRACK_LIMIT, run: () => add(idx), hint: count >= TRACK_LIMIT ? `Up to ${TRACK_LIMIT} in the free app` : undefined },
        { label: `Add a ${kind} track below`, disabled: count >= TRACK_LIMIT, run: () => add(idx + 1) },
        { label: "Remove this track", danger: true, disabled: count <= 1, run: () => apply({ ...cur, tl: removeTrack(cur.tl, tr.id) }, "once", "Remove track") },
        { sep: true, label: "" },
        ...(kind !== "overlay" || true ? [{ label: tr.locked ? "Unlock" : "Lock", run: () => apply({ ...cur, tl: patchTrack(cur.tl, tr.id, { locked: !tr.locked }) }, "once", "Lock track") }] : []),
        ...(kind !== "audio" ? [{ label: tr.hidden ? "Show" : "Hide", run: () => apply({ ...cur, tl: patchTrack(cur.tl, tr.id, { hidden: !tr.hidden }) }, "once", "Hide track") }] : []),
        ...(kind !== "overlay"
          ? [
              { label: tr.muted ? "Unmute" : "Mute", run: () => apply({ ...cur, tl: patchTrack(cur.tl, tr.id, { muted: !tr.muted }) }, "once", "Mute track") },
              { label: tr.solo ? "Unsolo" : "Solo", run: () => apply({ ...cur, tl: patchTrack(cur.tl, tr.id, { solo: !tr.solo }) }, "once", "Solo track") },
            ]
          : []),
        { label: "Close all gaps on this track", run: () => apply({ ...cur, tl: closeAllGaps(cur.tl, tr.id) }, "once", "Close gaps") },
        { label: "Select everything on this track", run: () => setSel(new Set(cur.tl.items.filter((i) => i.track === tr.id).map((i) => i.id))) },
      ],
    });
  };

  const onContext = (e: React.MouseEvent, h: { item?: EdItem; track: Track | null; t: number }) => {
    const at = { x: e.clientX, y: e.clientY };
    const cur = pRef.current;
    if (!h.item) {
      const g = h.track ? (() => {
        const items = cur.tl.items.filter((i) => i.track === h.track!.id);
        const before = items.filter((i) => end(i) <= h.t).reduce((m, i) => Math.max(m, end(i)), 0);
        const after = items.filter((i) => i.start >= h.t).reduce((m, i) => Math.min(m, i.start), Infinity);
        return after < Infinity ? { start: before, end: after } : null;
      })() : null;
      const near = cur.tl.markers.find((m) => Math.abs(m.t - h.t) * viewRef.current.pxPerSec < 8);
      setMenu({
        at,
        items: [
          { label: "Paste here", key: "Ctrl+V", disabled: !clipboard.current.length, run: () => paste(h.t) },
          ...(g && h.track ? [{ label: "Close this gap", run: () => apply({ ...cur, tl: closeGap(cur.tl, h.track!.id, h.t) }, "once", "Close gap") }] : []),
          { label: "Add a marker here", key: "M", run: () => apply({ ...cur, tl: addMarker(cur.tl, h.t).tl }, "once", "Add marker") },
          ...(near ? [{ label: "Delete this marker", danger: true, run: () => apply({ ...cur, tl: removeMarker(cur.tl, near.id) }, "once", "Delete marker") }] : []),
          { sep: true, label: "" },
          { label: "Add files…", key: "Ctrl+I", run: () => void importFiles() },
          ...(h.track ? [{ label: "Track", sub: [] as MenuItem[], run: () => trackMenu(h.track!, at) }] : []).map((x) => ({ label: "Track options…", run: x.run })),
        ],
      });
      return;
    }
    const it = h.item;
    const many = selRef.current.size > 1;
    const linked = !!it.link;
    setMenu({
      at,
      items: [
        { label: "Split at the playhead", key: "S", run: () => split(false) },
        { label: "Copy", key: "Ctrl+C", run: () => void copySel() },
        { label: "Cut", key: "Ctrl+X", run: actions.cut },
        { label: "Duplicate", key: "Ctrl+D", run: duplicate },
        { label: it.disabled ? "Turn on" : "Turn off", key: "D", run: actions.toggleEnable },
        { sep: true, label: "" },
        ...(it.kind === "video" && it.hasAudio ? [{ label: "Detach audio", key: "Ctrl+Shift+D", run: detachAudio }] : []),
        ...(linked ? [{ label: "Unlink", run: () => setLink(false) }] : many ? [{ label: "Link (move together)", run: () => setLink(true) }] : []),
        ...(sounds(it)
          ? [
              { label: it.audio?.muted ? "Unmute" : "Mute", run: () => patchSel((x) => ({ audio: { ...DEFAULT_FX, ...x.audio, muted: !it.audio?.muted } }), true, "Mute") },
              { label: "Normalise loudness", checked: !!it.audio?.normalize, run: () => patchSel((x) => ({ audio: { ...DEFAULT_FX, ...x.audio, normalize: !it.audio?.normalize } }), true, "Normalise") },
              { label: "Export audio as a file…", run: () => void exportAudio() },
            ]
          : []),
        ...(it.kind === "video" || it.kind === "image"
          ? [
              { label: "Crop…", run: () => startCrop(it) },
              { label: "Turn 90° right", key: "Shift+R", run: () => picEdit((q) => ({ rot90: (((q.rot90 ?? 0) + 90) % 360) as Picture["rot90"] }), "Turn") },
              { label: "Fill the frame", checked: !!it.pic?.fill, run: () => picEdit((q) => ({ fill: !q.fill }), "Fill") },
            ]
          : []),
        ...(it.kind === "video" && it.path ? [{ label: "Pop out the source clip", run: () => void popOutClip({ path: it.path!, title: it.name, width: it.width, height: it.height }, { t: it.srcIn + Math.max(0, player.time - it.start), playing: false, muted: true }).catch((err) => onToast("err", "Could not pop out", String(err))) }] : []),
        ...(it.path && !it.path.startsWith("blob:") ? [{ label: "Show the file in its folder", run: () => void lastshot.revealClip(it.path!) }] : []),
        { sep: true, label: "" },
        { label: "Delete", key: "Del", danger: true, run: () => del(false) },
        { label: "Ripple delete (close the gap)", key: "Shift+Del", danger: true, run: () => del(true) },
      ],
    });
  };

  const startCrop = (it: EdItem) => {
    if (it.kind !== "video" && it.kind !== "image") return;
    setSel(new Set([it.id]));
    if (player.time < it.start || player.time >= end(it)) player.seek(it.start + Math.min(0.1, it.duration / 2));
    setCrop({ id: it.id, aspect: "free" });
  };
  const cropTarget = (): EdItem | null => {
    const cur = pRef.current;
    const s = cur.tl.items.find((i) => selRef.current.has(i.id) && (i.kind === "video" || i.kind === "image"));
    if (s) return s;
    const t = player.time;
    const vids = tracksOf(cur.tl, "video");
    for (const tr of vids) {
      const it = cur.tl.items.find((i) => i.track === tr.id && (i.kind === "video" || i.kind === "image") && t >= i.start && t < end(i));
      if (it) return it;
    }
    return null;
  };

  // ------------------------------------------------------------ layout bits
  const resizeTl = (e: React.PointerEvent) => {
    e.preventDefault();
    const y0 = e.clientY;
    const h0 = tlHeight;
    const mv = (ev: PointerEvent) => setTlHeight(Math.max(140, Math.min(window.innerHeight - 220, h0 - (ev.clientY - y0))));
    const up = () => {
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
  };

  const length = projectLength(p);
  const range = exportRange(p);
  const hasRange = p.tl.inPoint !== null || p.tl.outPoint !== null;
  const estimate = useMemo(() => {
    // Rough size of a save: the clips' own bit rates over the range.
    let bytes = 0;
    for (const it of p.tl.items) {
      if (it.kind !== "video" || it.disabled) continue;
      const c = props.clips.find((x) => x.path === it.path);
      if (!c || !c.duration_seconds) continue;
      const a = Math.max(it.start, range.start);
      const b = Math.min(end(it), range.end);
      if (b > a) bytes += (c.size_bytes / c.duration_seconds) * (b - a);
    }
    return bytes;
  }, [p.tl.items, props.clips, range.start, range.end]);
  const route = useMemo(() => exportRoute(p), [p]);
  const penTarget = (() => {
    if (tool !== "pen" && tool !== "highlight") return null;
    const s = selShapes.length === 1 ? selShapes[0] : null;
    return s && s.shape!.kind === tool ? s.id : null;
  })();
  const undoL = hist.current.undoLabel;
  const redoL = hist.current.redoLabel;
  const trackHeight = useCallback((t: Track) => TRACK_H[t.kind] ?? 48, []);
  const previewTool: Tool = tool === "blade" || tool === "slip" ? "select" : tool;

  const arrange = {
    flip: (axis: "x" | "y") => void shapeEdit((s) => flipShape(s, axis), "Flip"),
    rotate: (deg: number) => void shapeEdit((s) => rotateBy(s, deg), "Turn"),
    duplicate: () => {
      focusArea.current = "preview";
      duplicate();
    },
    remove: () => removeIds(selShapesNow(), false, "Delete"),
    order: actions.order,
    lock: actions.lock,
    align: (how: "left" | "centre" | "right" | "top" | "middle" | "bottom") => {
      const ids = selShapesNow();
      const shapes = pRef.current.tl.items.filter((i) => ids.includes(i.id)).map((i) => i.shape!);
      const out = alignShapes(shapes, how, outputSize(pRef.current));
      onShapes(out, true, "Align");
    },
  };

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-app text-ink"
      onDragOver={(e) => {
        if (droppable(e)) e.preventDefault();
      }}
      onDrop={(e) => void onRootDrop(e)}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) clearDrag();
      }}
    >
      {/* ------------------------------------------------ toolbar */}
      <div className="flex h-11 shrink-0 items-center gap-0.5 border-b border-line bg-surface px-2">
        <Btn title={showBin ? "Hide media" : "Show media"} on={showBin} onClick={() => setShowBin(!showBin)}>
          <Ico d={I.media} />
        </Btn>
        <button type="button" onClick={projectsMenu} title="Projects: new, recent, rename, duplicate" className="ml-1 flex h-7 max-w-[220px] items-center gap-1 rounded-md px-2 text-[12px] font-semibold text-ink hover:bg-surface-4">
          <span className="truncate">{p.name}</span>
          <span className="text-[9px] text-ink-4">▼</span>
        </button>
        <Sep />
        <Btn title={undoL ? k("Undo", `Undo ${undoL.toLowerCase()}`) : "Nothing to undo"} disabled={!undoL} onClick={actions.undo}>
          <Ico d={I.undo} />
        </Btn>
        <Btn title={redoL ? k("Redo", `Redo ${redoL.toLowerCase()}`) : "Nothing to redo"} disabled={!redoL} onClick={actions.redo}>
          <Ico d={I.redo} />
        </Btn>
        <Sep />
        <Btn title={k("Select / move tool")} on={tool === "select"} onClick={() => setTool("select")}>
          <Ico d={I.select} />
        </Btn>
        <Btn title={k("Blade tool (click a clip to cut it)")} on={tool === "blade"} onClick={actions.blade}>
          <Ico d={I.blade} />
        </Btn>
        <Btn title={k("Slip tool (drag what a clip shows; Alt+drag a cut rolls it)")} on={tool === "slip"} onClick={actions.slip}>
          <Ico d={I.slip} />
        </Btn>
        <Btn title={k("Split at playhead")} onClick={() => split(false)}>
          <Ico d={I.split} />
        </Btn>
        <Btn title={k("Delete (leaves a gap)", "Delete (Shift+Del closes the gap)")} disabled={!sel.size && !gap} onClick={() => del(false)} tone="danger">
          <Ico d={I.trash} />
        </Btn>
        <Sep />
        <Btn title="Draw and write on the picture: text, boxes, arrows, pen, pixelate" on={showDraw} onClick={() => setShowDraw(!showDraw)} wide>
          <Ico d={I.annotate} /> Annotate
        </Btn>
        <Btn title="Crop the selected clip (16:9, 9:16, 1:1, 4:3, free)" on={!!crop} onClick={() => (crop ? setCrop(null) : (() => { const it = cropTarget(); if (it) startCrop(it); else onToast("info", "Nothing to crop here", "Select a clip or put the playhead over one."); })())}>
          <Ico d={I.crop} />
        </Btn>
        <Btn title={k("Save the frame as a picture", "Snapshot: save the frame as a picture")} onClick={() => void snapshot("save")}>
          <Ico d={I.camera} />
        </Btn>
        <Btn
          title="Pop out the frame (zoom, inspect, keep on top)"
          onClick={() => void popOutCanvas(frameCanvas(), `${p.name} · ${timecode(player.time, fps)}`).catch((e) => onToast("err", "Could not pop out", String(e)))}
        >
          <Ico d={I.popout} />
        </Btn>
        <span className="flex-1" />
        {busy && (
          <div className="mr-2 flex items-center gap-2 text-[11px] text-ink-3">
            <span>{busy.label}</span>
            <span className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-4">
              <span className={cn("block h-full bg-accent transition-[width]", busy.p === null && "animate-pulse")} style={{ width: `${Math.round((busy.p ?? 0.3) * 100)}%` }} />
            </span>
          </div>
        )}
        <span className="mr-2 hidden font-mono text-[10.5px] text-ink-4 xl:inline" title="Export length and rough size">
          {timecode(range.end - range.start, fps)}
          {estimate > 0 && ` · ~${formatBytes(route.kind === "render" ? estimate * 1.1 : estimate)}`}
        </span>
        <Btn title={`${k("Shrink and copy for Discord")}: makes a copy under ${shareMb} MB and puts it on the clipboard`} onClick={() => void runExport("share")} disabled={!!busy} wide>
          <Ico d={I.discord} /> {shareMb} MB copy
        </Btn>
        <Btn title={`${k("Export (save as a new clip)")} · more in the menu`} tone="accent" onClick={exportMenu} disabled={!!busy} wide className="ml-1">
          <Ico d={I.exportI} /> Export ▾
        </Btn>
        <Sep />
        <Btn title="Keyboard shortcuts (?)" onClick={() => setHelp(true)}>
          <Ico d={I.keyboard} />
        </Btn>
        <Btn title={showInsp ? "Hide settings" : "Show settings"} on={showInsp} onClick={() => setShowInsp(!showInsp)}>
          <Ico d={I.panel} />
        </Btn>
      </div>

      {/* ------------------------------------------------ media | preview | inspector */}
      <div className="flex min-h-0 flex-1">
        {showBin && (
          <div className="w-[260px] shrink-0 border-r border-line bg-surface" onPointerDownCapture={() => (focusArea.current = "other")}>
            <MediaBin clips={props.clips} p={p} onAdd={(paths) => void addPaths(paths)} onImport={() => void importFiles()} onDragPaths={(x) => (dragPaths.current = x)} />
          </div>
        )}
        <div className="relative flex min-w-0 flex-1 flex-col">
          {showDraw && (
            <div className="flex h-9 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-line bg-surface-2 px-2">
              {TOOLS.map((t) => (
                <Btn key={t.id} title={`${t.label}${t.key ? ` (${t.key})` : ""}`} on={tool === t.id} onClick={() => setTool(t.id)}>
                  <Ico d={t.icon} />
                </Btn>
              ))}
              <Sep />
              <span className="text-[10.5px] text-ink-4">Objects show for {SHAPE_SECONDS} s from the playhead; drag their ends on the Overlay track.</span>
              <span className="flex-1" />
              <Btn title="Close the drawing tools" onClick={() => (setShowDraw(false), setTool("select"))}>
                <Ico d={I.close} />
              </Btn>
            </div>
          )}
          <div className="min-h-0 flex-1">
            <Preview
              p={p}
              player={player}
              images={images}
              imgVer={imgVer}
              selection={sel}
              onSelect={(ids) => {
                setSel(ids);
                setGap(null);
              }}
              tool={previewTool}
              style={style}
              onShapes={onShapes}
              onCreateShape={onCreateShape}
              onDeleteItems={(ids) => removeIds(ids, false, "Delete")}
              editing={editing}
              setEditing={setEditing}
              onPic={onPic}
              crop={crop}
              setCrop={setCrop}
              quality={quality}
              safe={safe}
              onFocus={() => (focusArea.current = "preview")}
              onToolDone={() => setTool("select")}
              penTarget={penTarget}
              empty={
                <div className="max-w-sm text-center text-[12px] leading-relaxed text-ink-3">
                  <div className="mb-2 text-[14px] font-semibold text-ink-2">Drop clips, pictures or music here</div>
                  From the Library list on the left, your clips, or Explorer. Or{" "}
                  <button type="button" className="font-semibold text-accent-fg hover:underline" onClick={() => void importFiles()}>
                    add files
                  </button>
                  .
                </div>
              }
            />
          </div>
          {/* Transport */}
          <Transport
            player={player}
            playing={playing}
            fps={fps}
            length={length}
            p={p}
            k={k}
            actions={actions}
            hasRange={hasRange}
            range={range}
            onRangeMenu={rangeMenu}
            quality={quality}
            setQuality={setQuality}
            safe={safe}
            setSafe={setSafe}
          />
        </div>
        {showInsp && (
          <div className="w-[290px] shrink-0 border-l border-line bg-surface" onPointerDownCapture={() => (focusArea.current = "other")}>
            <Inspector
              p={p}
              sel={selItems}
              patchItems={(fn, commit, label) => patchSel(fn, commit, label)}
              patchProject={(patch, label) => apply({ ...pRef.current, ...patch }, "once", label)}
              onMoveTo={moveTo}
              onLength={setLength}
              style={style}
              onStyle={(x) => setStyle((s) => ({ ...s, ...x }))}
              tool={previewTool}
              arrange={arrange}
              onCrop={startCrop}
              onDetachAudio={detachAudio}
              onAudioExport={() => void exportAudio()}
              clip={sourceClip}
              flushMs={flushMsRef.current}
              clipActions={clipActions}
              fps={fps}
            />
          </div>
        )}
      </div>

      {/* ------------------------------------------------ timeline */}
      <div className="h-1.5 shrink-0 cursor-ns-resize bg-line/40 hover:bg-accent/50" onPointerDown={resizeTl} title="Drag to resize the timeline" />
      <div className="flex shrink-0 flex-col border-t border-line bg-surface" style={{ height: tlHeight }}>
        <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-line px-2">
          <Btn title={k("Snapping on / off")} on={p.snapping} onClick={actions.toggleSnap}>
            <Ico d={I.snap} />
          </Btn>
          <Btn title={`${k("Magnetic main track on / off")}: clips on the main video track stay back to back`} on={p.magnet} onClick={actions.toggleMagnet}>
            <Ico d={I.magnet} />
          </Btn>
          <Btn title="Ripple trims: trimming a clip moves everything after it (or hold Ctrl while trimming)" on={p.ripple} onClick={() => apply({ ...pRef.current, ripple: !p.ripple }, "once", "Ripple")}>
            <Ico d={I.ripple} />
          </Btn>
          <Btn title={k("Add a marker")} onClick={actions.marker}>
            <Ico d={I.marker} />
          </Btn>
          <Sep />
          <AddTrack p={p} onAdd={(kind) => apply({ ...pRef.current, tl: addTrack(pRef.current.tl, makeTrack(kind, tracksOf(pRef.current.tl, kind).length + 1), kind === "audio" ? pRef.current.tl.tracks.length : pRef.current.tl.tracks.findIndex((t) => t.kind === kind)) }, "once", "Add track")} />
          <span className="flex-1" />
          <span className="mr-2 text-[10.5px] text-ink-4">{sel.size ? `${sel.size} selected` : gap ? "Gap selected: Del closes it" : ""}</span>
          <Btn title={k("Zoom out")} onClick={() => actions.zoom(1 / 1.5)}>
            <Ico d={I.zoomOut} />
          </Btn>
          <input
            type="range"
            min={0}
            max={1000}
            value={Math.round((Math.log(view.pxPerSec / 0.02) / Math.log(2400 / 0.02)) * 1000)}
            onChange={(e) => {
              const z = 0.02 * Math.pow(2400 / 0.02, Number(e.target.value) / 1000);
              actions.zoom(z / view.pxPerSec);
            }}
            title="Zoom (Ctrl+wheel on the timeline, + and -)"
            className="w-28 accent-[var(--color-accent)]"
          />
          <Btn title={k("Zoom in")} onClick={() => actions.zoom(1.5)}>
            <Ico d={I.zoomIn} />
          </Btn>
          <Btn title={k("Zoom to fit")} onClick={fit}>
            <Ico d={I.fit} />
          </Btn>
        </div>
        <div
          className="min-h-0 flex-1"
          onPointerDownCapture={() => (focusArea.current = "timeline")}
          onDragOver={onTlDragOver}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) clearDrag();
          }}
          onDrop={(e) => void onTlDrop(e)}
        >
          <TimelineView<EdItem>
            tl={p.tl}
            clock={clock}
            selection={sel}
            onSelection={(s) => {
              setSel(s);
              if (s.size) setGap(null);
            }}
            view={view}
            onView={setView}
            snapping={p.snapping}
            tool={tool === "blade" || tool === "slip" ? tool : "select"}
            ripple={p.ripple}
            editOpts={editOpts}
            onEdit={setTl}
            accepts={(tr, it) => accepts(tr.kind as TrackKind, it)}
            trackHeight={trackHeight}
            renderItem={(it, g, s) => <ItemContent it={it} g={g} selected={s} onFx={onFx} />}
            itemClass={itemTone}
            renderHeader={(tr) => (
              <TrackHeader
                track={tr}
                canHide={tr.kind !== "audio"}
                sound={tr.kind !== "overlay"}
                onPatch={(patch, label) => apply({ ...pRef.current, tl: patchTrack(pRef.current.tl, tr.id, patch) }, "once", label)}
                onMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  trackMenu(tr, { x: e.clientX, y: e.clientY });
                }}
              />
            )}
            onContext={onContext}
            onItemDoubleClick={(it) => {
              if (it.shape?.kind === "text") {
                player.seek(Math.max(player.time, it.start));
                setEditing(it.id);
              } else if (it.kind === "video" || it.kind === "image") {
                setShowInsp(true);
              }
            }}
            onGap={(g) => {
              if (!g) return setGap(null);
              const items = pRef.current.tl.items.filter((i) => i.track === g.track);
              const before = items.filter((i) => end(i) <= g.t + 1e-6).reduce((m, i) => Math.max(m, end(i)), 0);
              const after = items.filter((i) => i.start >= g.t - 1e-6).reduce((m, i) => Math.min(m, i.start), Infinity);
              setGap(after < Infinity && after - before > 0.01 ? { ...g, start: before, end: after } : null);
            }}
            gap={gap}
            onMarkerEdit={(m: Marker) => setAsk({ title: "Marker name", ok: "Save", field: m.label ?? "", run: (v) => apply({ ...pRef.current, tl: patchMarker(pRef.current.tl, m.id, { label: v.trim() }) }, "once", "Name marker") })}
            ghost={ghost}
            belowHint={belowHint === null ? undefined : belowHint}
            fps={fps}
            apiRef={tlApi}
            headerWidth={176}
          />
        </div>
      </div>

      {menu && <Menu at={menu.at} items={menu.items} onClose={() => setMenu(null)} />}
      {ask && <AskDialog ask={ask} onClose={() => setAsk(null)} />}
      {help && <KeysHelp list={keymap} onClose={() => setHelp(false)} />}
    </div>
  );
}

// ------------------------------------------------------------ pieces

function Transport({
  player,
  playing,
  fps,
  length,
  p,
  k,
  actions,
  hasRange,
  range,
  onRangeMenu,
  quality,
  setQuality,
  safe,
  setSafe,
}: {
  player: Player;
  playing: boolean;
  fps: number;
  length: number;
  p: EdProject;
  k: (label: string, text?: string) => string;
  actions: EditorActions;
  hasRange: boolean;
  range: { start: number; end: number };
  onRangeMenu: (e: React.MouseEvent) => void;
  quality: number;
  setQuality: (q: number) => void;
  safe: SafeZone;
  setSafe: (s: SafeZone) => void;
}) {
  const timeRef = useRef<HTMLInputElement | null>(null);
  const [typing, setTyping] = useState<string | null>(null);
  useEffect(
    () =>
      player.subscribe((t) => {
        if (timeRef.current && document.activeElement !== timeRef.current) timeRef.current.value = timecode(t, fps);
      }),
    [player, fps],
  );
  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-t border-line bg-surface px-2">
      <Btn title={k("Go to start")} onClick={actions.home}>
        <Ico d="M4 3v10M13 3L6 8l7 5z" />
      </Btn>
      <Btn title={k("Back one frame")} onClick={() => actions.step(-1)}>
        <Ico d="M10 4L6 8l4 4" />
      </Btn>
      <Btn title={`${k("Play / pause")} · J K L shuttle`} onClick={actions.togglePlay} tone="accent">
        <Ico d={playing ? I.pause : I.play} />
      </Btn>
      <Btn title={k("Forward one frame")} onClick={() => actions.step(1)}>
        <Ico d="M6 4l4 4-4 4" />
      </Btn>
      <Btn title={k("Go to end")} onClick={actions.end}>
        <Ico d="M12 3v10M3 3l7 5-7 5z" />
      </Btn>
      <input
        ref={timeRef}
        defaultValue={timecode(0, fps)}
        onFocus={(e) => {
          setTyping(e.target.value);
          e.target.select();
        }}
        onChange={(e) => setTyping(e.target.value)}
        onBlur={() => {
          if (typing !== null) {
            const t = parseTime(typing, player.time);
            if (t !== null) player.seek(t);
          }
          setTyping(null);
          if (timeRef.current) timeRef.current.value = timecode(player.time, fps);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setTyping(null);
            (e.target as HTMLInputElement).blur();
          }
        }}
        title="Playhead. Type a time (1:05.10) or +2 / -0.5 to jump"
        className="ml-1 w-[86px] rounded border border-transparent bg-transparent px-1 font-mono text-[12px] text-ink hover:border-line focus:border-accent focus:outline-none"
      />
      <span className="font-mono text-[11px] text-ink-4">/ {timecode(length, fps)}</span>
      <Sep />
      <Btn title={k("Mark in")} onClick={actions.markIn} wide>
        I
      </Btn>
      <Btn title={k("Mark out")} onClick={actions.markOut} wide>
        O
      </Btn>
      <button
        type="button"
        onClick={onRangeMenu}
        title="Range: what export and loop use. Last 5/10/15/30 s, cut out, keep only"
        className={cn("h-7 rounded-md px-2 font-mono text-[10.5px]", hasRange ? "bg-accent/15 text-accent-fg" : "text-ink-3 hover:bg-surface-4 hover:text-ink")}
      >
        {hasRange ? `${timecode(range.start, fps)} → ${timecode(range.end, fps)}` : "Range ▾"}
      </button>
      <Btn title={k("Loop play in → out")} on={!!player.loop && playing} onClick={actions.loopPlay}>
        <Ico d={I.loop} />
      </Btn>
      <span className="flex-1" />
      <select
        value={quality}
        onChange={(e) => setQuality(Number(e.target.value))}
        title="Preview quality (lower is smoother on slow PCs; export is always full)"
        className="h-7 rounded-md border border-line bg-surface-2 px-1 text-[11px] text-ink-2"
      >
        <option value={1}>Full</option>
        <option value={0.5}>Half</option>
        <option value={0.25}>Quarter</option>
      </select>
      <select
        value={safe}
        onChange={(e) => setSafe(e.target.value as SafeZone)}
        title="Guides on the picture"
        className="h-7 rounded-md border border-line bg-surface-2 px-1 text-[11px] text-ink-2"
      >
        <option value="off">No guides</option>
        <option value="title">Safe areas</option>
        <option value="vertical">Shorts / TikTok UI</option>
      </select>
      <span className="ml-1 font-mono text-[10px] text-ink-4">
        {outputSize(p).w}×{outputSize(p).h}
      </span>
    </div>
  );
}

function AddTrack({ p, onAdd }: { p: EdProject; onAdd: (k: TrackKind) => void }) {
  const [m, setM] = useState<{ x: number; y: number } | null>(null);
  return (
    <>
      <Btn
        title="Add a track"
        wide
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setM({ x: r.left, y: r.top - 110 });
        }}
      >
        <Ico d={I.plus} /> Track
      </Btn>
      {m && (
        <Menu
          at={m}
          onClose={() => setM(null)}
          items={(["video", "overlay", "audio"] as TrackKind[]).map((kind) => ({
            label: `${kind === "video" ? "Video" : kind === "overlay" ? "Overlay (text, drawings)" : "Audio"} track`,
            disabled: tracksOf(p.tl, kind).length >= TRACK_LIMIT,
            hint: tracksOf(p.tl, kind).length >= TRACK_LIMIT ? `Up to ${TRACK_LIMIT} in the free app` : undefined,
            run: () => onAdd(kind),
          }))}
        />
      )}
    </>
  );
}

function AskDialog({ ask, onClose }: { ask: Ask; onClose: () => void }) {
  const [v, setV] = useState(ask.field ?? "");
  const ok = () => {
    onClose();
    ask.run(v);
  };
  return (
    <div className="fixed inset-0 z-[90] grid place-items-center bg-black/40" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="w-[360px] rounded-xl border border-line-2 bg-surface p-4 shadow-2xl" onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <div className="text-[13px] font-semibold text-ink">{ask.title}</div>
        {ask.body && <p className="mt-1 text-[12px] text-ink-3">{ask.body}</p>}
        {ask.field !== undefined && (
          <input
            autoFocus
            value={v}
            onChange={(e) => setV(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && ok()}
            className="mt-3 w-full rounded-md border border-line bg-surface-2 px-2 py-1.5 text-[12px] text-ink focus:border-accent focus:outline-none"
          />
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-[12px] text-ink-3 hover:text-ink">
            Cancel
          </button>
          <button type="button" autoFocus={ask.field === undefined} onClick={ok} className={cn("rounded-md px-3 py-1.5 text-[12px] font-semibold text-white", ask.danger ? "bg-red-600 hover:bg-red-500" : "bg-accent hover:bg-accent-hover")}>
            {ask.ok}
          </button>
        </div>
      </div>
    </div>
  );
}

function KeysHelp({ list, onClose }: { list: Shortcut[]; onClose: () => void }) {
  const groups = new Map<string, Map<string, string[]>>();
  for (const s of list) {
    const g = groups.get(s.group ?? "Other") ?? new Map<string, string[]>();
    const keys = g.get(s.label) ?? [];
    if (!/^[0-9]$/.test(s.keys) || s.keys === "1") keys.push(/^[0-9]$/.test(s.keys) ? "0-9" : s.keys.replace("Arrow", ""));
    g.set(/^Opacity/.test(s.label) ? "Opacity (10 % - 100 %)" : s.label, keys);
    groups.set(s.group ?? "Other", g);
  }
  return (
    <div className="fixed inset-0 z-[90] grid place-items-center bg-black/50" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="max-h-[85vh] w-[min(920px,94vw)] overflow-y-auto rounded-xl border border-line-2 bg-surface p-5 shadow-2xl">
        <div className="mb-3 flex items-center">
          <div className="flex-1 text-[14px] font-semibold text-ink">Editor shortcuts</div>
          <button type="button" onClick={onClose} className="text-ink-3 hover:text-ink">
            <Ico d={I.close} />
          </button>
        </div>
        <div className="columns-1 gap-6 sm:columns-2 lg:columns-3">
          {[...groups].map(([g, items]) => (
            <div key={g} className="mb-4 break-inside-avoid">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3">{g}</div>
              {[...items].map(([label, keys]) => (
                <div key={label} className="flex items-baseline justify-between gap-3 py-0.5 text-[11.5px]">
                  <span className="text-ink-2">{label}</span>
                  <span className="shrink-0 text-right font-mono text-[10.5px] text-ink-4">{[...new Set(keys)].join(" · ")}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

