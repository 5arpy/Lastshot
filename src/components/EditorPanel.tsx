import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { assetUrl, isTauri, lastshot } from "../lib/bridge";
import type { ClipMetadata, RenderProject } from "../lib/types";
import { formatDuration } from "../lib/format";
import {
  type AudioItem,
  type MainItem,
  type OverlayItem,
  type Project,
  EMPTY_PROJECT,
  MIN_LEN,
  audioGain,
  clockText,
  dropIndex,
  lanes,
  mainAt,
  mainStarts,
  moveTo,
  newId,
  projectLength,
  splitFree,
  splitMain,
  trimFree,
  trimMain,
} from "../lib/timeline";
import { cn } from "../utils/cn";

/**
 * Editor: a small timeline video editor. Main track (clips and pictures back
 * to back, drag to reorder, trim the ends, split at the playhead), overlays
 * (pictures and text on top, placed by dragging them in the preview) and an
 * audio track (music, voice) with volume and fades. Clip sound has its own
 * volume / mute. Render makes a new clip in Clips.
 */

const STORE = "lastshot.editor.project";
const IMAGE_RE = /\.(png|jpe?g|webp|gif|bmp)$/i;
const AUDIO_RE = /\.(mp3|wav|m4a|aac|wma|flac)$/i;
const VIDEO_RE = /\.(mp4|mov|m4v|mkv|avi|wmv)$/i;

type Selected = { track: "main" | "overlay" | "audio"; id: string } | null;

const SIZES = [
  { label: "1920 × 1080 (wide)", w: 1920, h: 1080 },
  { label: "1280 × 720 (wide)", w: 1280, h: 720 },
  { label: "2560 × 1440 (wide)", w: 2560, h: 1440 },
  { label: "1080 × 1920 (vertical)", w: 1080, h: 1920 },
  { label: "1080 × 1080 (square)", w: 1080, h: 1080 },
];

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error("Could not load the picture"));
    img.src = url;
  });
}

const TEXT_FONT = (size: number) => `700 ${size}px "Segoe UI", system-ui, sans-serif`;
const TEXT_PAD = 0.35;

/** Draws a text overlay at output pixels; returns the canvas. */
function textCanvas(o: OverlayItem): HTMLCanvasElement {
  const size = o.fontSize ?? 64;
  const lines = (o.text ?? "").split("\n");
  const c = document.createElement("canvas");
  const g = c.getContext("2d")!;
  g.font = TEXT_FONT(size);
  const pad = Math.round(size * TEXT_PAD);
  const w = Math.ceil(Math.max(1, ...lines.map((l) => g.measureText(l).width))) + pad * 2;
  const lh = Math.round(size * 1.2);
  const h = lh * lines.length + pad * 2;
  c.width = w + (w % 2);
  c.height = h + (h % 2);
  g.font = TEXT_FONT(size);
  if (o.box) {
    g.fillStyle = "rgba(0,0,0,0.6)";
    g.beginPath();
    g.roundRect(0, 0, c.width, c.height, pad);
    g.fill();
  }
  g.textBaseline = "top";
  g.fillStyle = o.color ?? "#ffffff";
  if (!o.box) {
    g.shadowColor = "rgba(0,0,0,0.75)";
    g.shadowBlur = size * 0.12;
    g.shadowOffsetY = size * 0.04;
  }
  lines.forEach((l, i) => g.fillText(l, pad, pad + i * lh + size * 0.08));
  return c;
}

/** Text overlays get their size from the text: width fraction + shape. */
function measureText(o: OverlayItem, frameW: number): { w: number; aspect: number } {
  const c = textCanvas(o);
  return { w: c.width / frameW, aspect: c.height / c.width };
}

interface Props {
  clips: ClipMetadata[];
  /** Files handed over from elsewhere (drag & drop, "Open in Editor"). */
  incoming: { paths: string[]; seq: number } | null;
  onToast: (tone: "ok" | "err" | "warn" | "info", title: string, body?: string) => void;
  onRendered: (clip: ClipMetadata) => void;
}

export default function EditorPanel({ clips, incoming, onToast, onRendered }: Props) {
  const [project, setProject] = useState<Project>(() => {
    try {
      const s = localStorage.getItem(STORE);
      if (s) return { ...EMPTY_PROJECT, ...(JSON.parse(s) as Project) };
    } catch {
      /* fresh project */
    }
    return EMPTY_PROJECT;
  });
  const history = useRef<{ past: Project[]; future: Project[] }>({ past: [], future: [] });
  const [selected, setSelected] = useState<Selected>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [zoom, setZoom] = useState(40); // px per second
  const [render, setRender] = useState<{ progress: number } | null>(null);
  const [targetMb, setTargetMb] = useState<number | null>(null);
  const [showLibrary, setShowLibrary] = useState(false);
  const urls = useRef(new Map<string, string>());

  const length = projectLength(project);
  const starts = useMemo(() => mainStarts(project.main), [project.main]);

  // ------------------------------------------------------------ persistence
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(STORE, JSON.stringify(project));
      } catch {
        /* storage full or blocked */
      }
    }, 400);
    return () => clearTimeout(t);
  }, [project]);

  useEffect(() => {
    // Saved projects may point at files outside the clip folders.
    const paths = [
      ...project.main.map((m) => m.path),
      ...project.overlays.flatMap((o) => (o.path ? [o.path] : [])),
      ...project.audio.map((a) => a.path),
    ];
    if (paths.length) void lastshot.allowMedia(paths).catch(() => undefined);
    // Only on first load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const urlOf = useCallback(
    (path: string) => {
      const known = urls.current.get(path);
      if (known) return known;
      const sim = clips.find((c) => c.path === path)?.preview_url;
      return sim ?? assetUrl(path);
    },
    [clips],
  );

  /** Every change goes through here so Undo works. */
  const commit = useCallback((fn: (p: Project) => Project) => {
    setProject((p) => {
      const next = fn(p);
      if (next !== p) {
        history.current.past.push(p);
        if (history.current.past.length > 100) history.current.past.shift();
        history.current.future = [];
      }
      return next;
    });
  }, []);
  /** Changes during a drag: one Undo step for the whole drag. */
  const live = useCallback((fn: (p: Project) => Project) => setProject(fn), []);
  const snapshot = useCallback(() => {
    setProject((p) => {
      history.current.past.push(p);
      history.current.future = [];
      return p;
    });
  }, []);
  const undo = () => {
    const prev = history.current.past.pop();
    if (!prev) return;
    history.current.future.push(project);
    setProject(prev);
  };
  const redo = () => {
    const next = history.current.future.pop();
    if (!next) return;
    history.current.past.push(project);
    setProject(next);
  };

  // ------------------------------------------------------------ adding media
  const addPaths = useCallback(
    async (paths: string[], where?: "main" | "overlay" | "audio") => {
      if (paths.length) await lastshot.allowMedia(paths).catch(() => undefined);
      for (const path of paths) {
        try {
          if (IMAGE_RE.test(path)) {
            const img = await loadImage(urlOf(path));
            const aspect = img.naturalHeight / Math.max(1, img.naturalWidth);
            if (where === "main") {
              commit((p) => ({
                ...p,
                main: [
                  ...p.main,
                  {
                    id: newId(),
                    kind: "image",
                    path,
                    name: baseName(path),
                    srcIn: 0,
                    duration: 5,
                    srcDuration: 5,
                    width: img.naturalWidth,
                    height: img.naturalHeight,
                    hasAudio: false,
                    volume: 1,
                    muted: true,
                  },
                ],
              }));
            } else {
              commit((p) => {
                const w = Math.min(0.35, img.naturalWidth / p.width);
                return {
                  ...p,
                  overlays: [
                    ...p.overlays,
                    {
                      id: newId(),
                      kind: "image",
                      path,
                      name: baseName(path),
                      start: time,
                      duration: Math.max(3, Math.min(5, projectLength(p) - time || 5)),
                      x: 0.05,
                      y: 0.05,
                      w,
                      aspect,
                      opacity: 1,
                    },
                  ],
                };
              });
            }
            continue;
          }
          const info = isTauri()
            ? await lastshot.mediaInfo(path)
            : (() => {
                const c = clips.find((x) => x.path === path);
                if (!c) throw new Error("not in the library");
                return { kind: "video" as const, duration: c.duration_seconds, width: c.width, height: c.height, hasAudio: c.has_audio };
              })();
          if (info.duration <= 0) throw new Error("Lastshot cannot tell how long it is");
          if (info.kind === "audio" || where === "audio") {
            commit((p) => ({
              ...p,
              audio: [
                ...p.audio,
                {
                  id: newId(),
                  path,
                  name: baseName(path),
                  start: where === "audio" || p.main.length ? time : 0,
                  srcIn: 0,
                  duration: info.duration,
                  srcDuration: info.duration,
                  volume: 0.8,
                  fadeIn: 0,
                  fadeOut: 0,
                },
              ],
            }));
          } else {
            commit((p) => {
              const first = p.main.length === 0;
              return {
                ...p,
                // The first clip decides the size, like most editors.
                ...(first && info.width > 0
                  ? { width: info.width & ~1, height: info.height & ~1 }
                  : {}),
                main: [
                  ...p.main,
                  {
                    id: newId(),
                    kind: "video",
                    path,
                    name: baseName(path),
                    srcIn: 0,
                    duration: info.duration,
                    srcDuration: info.duration,
                    width: info.width,
                    height: info.height,
                    hasAudio: info.hasAudio,
                    volume: 1,
                    muted: false,
                  },
                ],
              };
            });
          }
        } catch (e) {
          onToast("err", `Could not add ${baseName(path)}`, String(e));
        }
      }
    },
    [clips, commit, onToast, time, urlOf],
  );

  useEffect(() => {
    if (incoming?.paths.length) void addPaths(incoming.paths);
    // Each hand-over once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming?.seq]);

  const pickFiles = async (where?: "main" | "overlay" | "audio") => {
    if (!isTauri()) {
      onToast("info", "Browser preview", "Adding files works in the installed app; add clips from the library here.");
      setShowLibrary(true);
      return;
    }
    try {
      const filters =
        where === "audio"
          ? [{ name: "Sound", extensions: ["mp3", "wav", "m4a", "aac", "wma", "flac", "mp4"] }]
          : where === "overlay"
            ? [{ name: "Pictures", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }]
            : [
                { name: "Videos, pictures, sound", extensions: ["mp4", "mov", "m4v", "mkv", "avi", "wmv", "png", "jpg", "jpeg", "webp", "gif", "bmp", "mp3", "wav", "m4a", "aac", "flac"] },
              ];
      const picked = await open({ multiple: true, filters, title: "Add to the timeline" });
      const list = Array.isArray(picked) ? picked : picked ? [picked] : [];
      await addPaths(
        list.map(String),
        where ?? undefined,
      );
    } catch (e) {
      onToast("err", "Could not add files", String(e));
    }
  };

  const addText = () => {
    const base: OverlayItem = {
      id: newId(),
      kind: "text",
      name: "Text",
      text: "Your text",
      fontSize: Math.round(project.height / 12),
      color: "#ffffff",
      box: false,
      start: time,
      duration: 3,
      x: 0.06,
      y: 0.78,
      w: 0.3,
      aspect: 0.25,
      opacity: 1,
    };
    const m = measureText(base, project.width);
    const o = { ...base, ...m };
    commit((p) => ({ ...p, overlays: [...p.overlays, o] }));
    setSelected({ track: "overlay", id: o.id });
  };

  // ------------------------------------------------------------ editing
  const updateMain = (id: string, patch: Partial<MainItem>, history = true) =>
    (history ? commit : live)((p) => ({ ...p, main: p.main.map((m) => (m.id === id ? { ...m, ...patch } : m)) }));
  const updateOverlay = (id: string, patch: Partial<OverlayItem>, history = true) =>
    (history ? commit : live)((p) => ({
      ...p,
      overlays: p.overlays.map((o) => {
        if (o.id !== id) return o;
        const next = { ...o, ...patch };
        // Text decides its own size.
        if (next.kind === "text" && ("text" in patch || "fontSize" in patch || "box" in patch)) {
          Object.assign(next, measureText(next, p.width));
        }
        return next;
      }),
    }));
  const updateAudio = (id: string, patch: Partial<AudioItem>, history = true) =>
    (history ? commit : live)((p) => ({ ...p, audio: p.audio.map((a) => (a.id === id ? { ...a, ...patch } : a)) }));

  const removeSelected = useCallback(() => {
    if (!selected) return;
    commit((p) => ({
      ...p,
      main: selected.track === "main" ? p.main.filter((m) => m.id !== selected.id) : p.main,
      overlays: selected.track === "overlay" ? p.overlays.filter((o) => o.id !== selected.id) : p.overlays,
      audio: selected.track === "audio" ? p.audio.filter((a) => a.id !== selected.id) : p.audio,
    }));
    setSelected(null);
  }, [commit, selected]);

  const splitHere = useCallback(() => {
    if (selected?.track === "overlay") commit((p) => ({ ...p, overlays: splitFree(p.overlays, selected.id, time) }));
    else if (selected?.track === "audio") commit((p) => ({ ...p, audio: splitFree(p.audio, selected.id, time) }));
    else commit((p) => ({ ...p, main: splitMain(p.main, time) }));
  }, [commit, selected, time]);

  // ------------------------------------------------------------ playback
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRefs = useRef(new Map<string, HTMLAudioElement>());
  const clock = useRef({ t: 0, at: 0 });
  const timeRef = useRef(0);
  timeRef.current = time;

  const seek = useCallback(
    (t: number) => {
      const c = Math.max(0, Math.min(length, t));
      setTime(c);
      clock.current = { t: c, at: performance.now() };
    },
    [length],
  );

  useEffect(() => {
    if (!playing) return;
    clock.current = { t: timeRef.current, at: performance.now() };
    let raf = 0;
    const step = () => {
      let t = clock.current.t + (performance.now() - clock.current.at) / 1000;
      // While a clip plays, its own clock leads (no drift).
      const hit = mainAt(project.main, timeRef.current);
      const v = videoRef.current;
      if (hit?.item.kind === "video" && v && !v.paused && v.readyState >= 2) {
        const vt = hit.start + (v.currentTime - hit.item.srcIn);
        if (vt >= hit.start && vt < hit.start + hit.item.duration + 0.05) {
          t = vt;
          clock.current = { t, at: performance.now() };
        }
      }
      if (t >= length) {
        setPlaying(false);
        setTime(length);
        return;
      }
      setTime(t);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, project.main, length]);

  // Keep the preview's video and sounds where the playhead is.
  const current = mainAt(project.main, time);
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (current?.item.kind !== "video") {
      if (!v.paused) v.pause();
      return;
    }
    const src = urlOf(current.item.path);
    if (v.dataset.src !== src) {
      v.dataset.src = src;
      v.src = src;
    }
    const want = current.item.srcIn + (time - current.start);
    if (Math.abs(v.currentTime - want) > (playing ? 0.35 : 0.04)) v.currentTime = want;
    v.muted = current.item.muted;
    v.volume = Math.max(0, Math.min(1, current.item.volume));
    if (playing && v.paused) void v.play().catch(() => undefined);
    if (!playing && !v.paused) v.pause();
  }, [current?.item, current?.start, time, playing, urlOf]);

  useEffect(() => {
    for (const a of project.audio) {
      const el = audioRefs.current.get(a.id);
      if (!el) continue;
      const inside = time >= a.start && time < a.start + a.duration;
      if (!inside || !playing) {
        if (!el.paused) el.pause();
        if (!inside) continue;
      }
      const want = a.srcIn + (time - a.start);
      if (Math.abs(el.currentTime - want) > (playing ? 0.35 : 0.05)) el.currentTime = want;
      el.volume = Math.max(0, Math.min(1, audioGain(a, time - a.start)));
      if (playing && el.paused) void el.play().catch(() => undefined);
    }
  }, [project.audio, time, playing]);

  // ------------------------------------------------------------ keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.code === "Space") {
        e.preventDefault();
        if (!playing && time >= length - 0.05) seek(0);
        setPlaying((p) => !p);
      } else if (e.key === "s" || e.key === "S") {
        if (!e.ctrlKey) splitHere();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        removeSelected();
      } else if (e.ctrlKey && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (e.ctrlKey && (e.key === "y" || e.key === "Y")) {
        e.preventDefault();
        redo();
      } else if (e.key === "ArrowLeft") {
        seek(time - (e.shiftKey ? 1 : 1 / project.fps));
      } else if (e.key === "ArrowRight") {
        seek(time + (e.shiftKey ? 1 : 1 / project.fps));
      } else if (e.key === "Home") {
        seek(0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ------------------------------------------------------------ render
  const doRender = async () => {
    if (!project.main.length && !project.overlays.length) {
      onToast("warn", "Nothing to render", "Add a clip or picture to the timeline first.");
      return;
    }
    setPlaying(false);
    setRender({ progress: 0 });
    const off = lastshot.onRenderProgress((p) => setRender({ progress: p }));
    try {
      const W = project.width;
      const H = project.height;
      const toPng = async (draw: (c: HTMLCanvasElement) => Promise<void> | void, w: number, h: number) => {
        const c = document.createElement("canvas");
        c.width = Math.max(2, Math.round(w));
        c.height = Math.max(2, Math.round(h));
        await draw(c);
        return c.toDataURL("image/png");
      };
      const video: RenderProject["video"] = [];
      for (let i = 0; i < project.main.length; i++) {
        const m = project.main[i];
        if (m.kind === "video") {
          video.push({ path: m.path, start: starts[i], duration: m.duration, srcIn: m.srcIn });
        } else {
          const img = await loadImage(urlOf(m.path));
          const s = Math.min(W / img.naturalWidth, H / img.naturalHeight);
          const png = await toPng(
            (c) => c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height),
            img.naturalWidth * s,
            img.naturalHeight * s,
          );
          video.push({ png, start: starts[i], duration: m.duration, srcIn: 0 });
        }
      }
      const overlays: RenderProject["overlays"] = [];
      for (const o of project.overlays) {
        let png: string;
        if (o.kind === "text") {
          png = textCanvas(o).toDataURL("image/png");
        } else {
          const img = await loadImage(urlOf(o.path!));
          png = await toPng(
            (c) => c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height),
            o.w * W,
            o.w * W * o.aspect,
          );
        }
        overlays.push({ png, start: o.start, duration: o.duration, x: o.x, y: o.y, opacity: o.opacity });
      }
      const audio: RenderProject["audio"] = [
        ...project.main.flatMap((m, i) =>
          m.kind === "video" && m.hasAudio && !m.muted && m.volume > 0
            ? [{ path: m.path, start: starts[i], duration: m.duration, srcIn: m.srcIn, volume: m.volume, fadeIn: 0, fadeOut: 0 }]
            : [],
        ),
        ...project.audio.map((a) => ({
          path: a.path,
          start: a.start,
          duration: a.duration,
          srcIn: a.srcIn,
          volume: a.volume,
          fadeIn: a.fadeIn,
          fadeOut: a.fadeOut,
        })),
      ];
      const clip = await lastshot.renderProject({ width: W, height: H, fps: project.fps, video, overlays, audio, targetMb });
      onRendered(clip);
      onToast("ok", "Video rendered", `${clip.file_name} · ${formatDuration(clip.duration_seconds)} — it is in Clips.`);
    } catch (e) {
      onToast("err", "Render failed", String(e));
    } finally {
      void off.then((f) => f());
      setRender(null);
    }
  };

  // ------------------------------------------------------------ preview overlay drag
  const previewRef = useRef<HTMLDivElement | null>(null);
  const dragOverlay = (o: OverlayItem, mode: "move" | "size") => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setSelected({ track: "overlay", id: o.id });
    const box = previewRef.current?.getBoundingClientRect();
    if (!box) return;
    snapshot();
    const x0 = e.clientX;
    const y0 = e.clientY;
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - x0) / box.width;
      const dy = (ev.clientY - y0) / box.height;
      if (mode === "move") {
        updateOverlay(o.id, { x: o.x + dx, y: o.y + dy }, false);
      } else if (o.kind === "text") {
        const scale = Math.max(0.1, (o.w + dx) / o.w);
        updateOverlay(o.id, { fontSize: Math.max(8, Math.round((o.fontSize ?? 64) * scale)) }, false);
      } else {
        updateOverlay(o.id, { w: Math.max(0.02, o.w + dx) }, false);
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // ------------------------------------------------------------ timeline drag
  const trackRef = useRef<HTMLDivElement | null>(null);
  const timeAtX = (clientX: number) => {
    const r = trackRef.current?.getBoundingClientRect();
    if (!r) return 0;
    return Math.max(0, (clientX - r.left + (trackRef.current?.scrollLeft ?? 0) - 96) / zoom);
  };
  const scrub = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    seek(timeAtX(e.clientX));
    const move = (ev: PointerEvent) => seek(timeAtX(ev.clientX));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const dragItem =
    (track: "main" | "overlay" | "audio", id: string, mode: "move" | "left" | "right") => (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      setSelected({ track, id });
      snapshot();
      const x0 = e.clientX;
      const orig = project;
      let moved = false;
      const move = (ev: PointerEvent) => {
        const dt = (ev.clientX - x0) / zoom;
        if (Math.abs(ev.clientX - x0) > 3) moved = true;
        if (!moved) return;
        if (track === "main") {
          const i = orig.main.findIndex((m) => m.id === id);
          if (mode === "move") {
            const to = dropIndex(orig.main, i, timeAtX(ev.clientX));
            live((p) => ({ ...p, main: moveTo(orig.main, i, to) }));
          } else {
            live((p) => ({ ...p, main: orig.main.map((m) => (m.id === id ? trimMain(m, mode, dt) : m)) }));
          }
        } else {
          const list = track === "overlay" ? orig.overlays : orig.audio;
          const next = list.map((it) => {
            if (it.id !== id) return it;
            if (mode === "move") return { ...it, start: Math.max(0, it.start + dt) };
            return trimFree(it, mode, dt);
          });
          live((p) => (track === "overlay" ? { ...p, overlays: next as OverlayItem[] } : { ...p, audio: next as AudioItem[] }));
        }
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        if (!moved) history.current.past.pop();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    };

  // ------------------------------------------------------------ view
  const sel =
    selected?.track === "main"
      ? project.main.find((m) => m.id === selected.id)
      : selected?.track === "overlay"
        ? project.overlays.find((o) => o.id === selected.id)
        : selected?.track === "audio"
          ? project.audio.find((a) => a.id === selected.id)
          : undefined;

  const overlayLanes = lanes(project.overlays);
  const audioLanes = lanes(project.audio);
  const nOverlayLanes = Math.max(1, ...[...overlayLanes.values()].map((l) => l + 1));
  const nAudioLanes = Math.max(1, ...[...audioLanes.values()].map((l) => l + 1));
  const span = Math.max(length + 10, 30);
  const LANE = 34;

  const ticks: number[] = [];
  const step = zoom >= 80 ? 1 : zoom >= 30 ? 2 : zoom >= 12 ? 5 : 10;
  for (let t = 0; t <= span; t += step) ticks.push(t);

  const blockClass = (on: boolean, tone: string) =>
    cn(
      "absolute top-1 bottom-1 cursor-grab overflow-hidden rounded-md border px-1.5 text-[10px] leading-tight select-none active:cursor-grabbing",
      tone,
      on && "ring-2 ring-white/80",
    );
  const handle = (side: "left" | "right") =>
    cn("absolute inset-y-0 w-2 cursor-ew-resize bg-white/0 hover:bg-white/40", side === "left" ? "left-0" : "right-0");

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4">
      {/* Top: library, preview, inspector */}
      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[220px_minmax(0,1fr)_260px]">
        {/* Add media */}
        <div className="panel flex min-h-0 flex-col gap-2 rounded-xl p-3">
          <div className="text-[12px] font-semibold text-ink">Add to the timeline</div>
          <button type="button" onClick={() => void pickFiles()} className="rounded-lg bg-accent px-3 py-2 text-[12px] font-semibold text-white hover:bg-accent-hover">
            + Videos / pictures / sound
          </button>
          <div className="grid grid-cols-2 gap-1.5 text-[11px]">
            <button type="button" onClick={() => void pickFiles("overlay")} className="rounded-md border border-line bg-surface-2 px-2 py-1.5 text-ink-2 hover:border-accent">
              + Picture on top
            </button>
            <button type="button" onClick={addText} className="rounded-md border border-line bg-surface-2 px-2 py-1.5 text-ink-2 hover:border-accent">
              + Text
            </button>
            <button type="button" onClick={() => void pickFiles("audio")} className="col-span-2 rounded-md border border-line bg-surface-2 px-2 py-1.5 text-ink-2 hover:border-accent">
              + Music / sound
            </button>
          </div>
          <button
            type="button"
            onClick={() => setShowLibrary((s) => !s)}
            className="mt-1 flex items-center justify-between text-[11px] font-semibold text-ink-3 hover:text-ink"
          >
            Your clips ({clips.length}) <span>{showLibrary ? "▾" : "▸"}</span>
          </button>
          {showLibrary && (
            <div className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
              {clips.slice(0, 200).map((c) => (
                <button
                  key={c.path}
                  type="button"
                  title="Add to the end of the video track"
                  onClick={() => void addPaths([c.path], "main")}
                  className="flex w-full items-center gap-2 rounded-md border border-line bg-surface px-2 py-1 text-left hover:border-accent"
                >
                  {c.thumbnail ? <img src={c.thumbnail} alt="" className="h-7 w-12 shrink-0 rounded object-cover" /> : <span className="h-7 w-12 shrink-0 rounded bg-surface-3" />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11px] text-ink">{c.title}</span>
                    <span className="font-mono text-[10px] text-ink-3">{formatDuration(c.duration_seconds)}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
          <p className="mt-auto text-[10px] leading-snug text-ink-3">
            Tip: drop files from Explorer on the window. <b>Space</b> play · <b>S</b> split · <b>Del</b> remove · <b>Ctrl+Z</b> undo
          </p>
        </div>

        {/* Preview */}
        <div className="panel flex min-h-0 flex-col items-center justify-center rounded-xl p-3">
          <div
            ref={previewRef}
            className="relative max-h-full max-w-full overflow-hidden bg-black"
            style={{ aspectRatio: `${project.width} / ${project.height}`, height: "100%", containerType: "size" }}
            onPointerDown={() => setSelected(null)}
          >
            <video
              ref={videoRef}
              className={cn("absolute inset-0 h-full w-full object-contain", current?.item.kind !== "video" && "invisible")}
              playsInline
              preload="auto"
            />
            {current?.item.kind === "image" && (
              <img src={urlOf(current.item.path)} alt="" className="absolute inset-0 h-full w-full object-contain" draggable={false} />
            )}
            {project.overlays
              .filter((o) => time >= o.start && time < o.start + o.duration)
              .map((o) => {
                const on = selected?.id === o.id;
                return (
                  <div
                    key={o.id}
                    onPointerDown={dragOverlay(o, "move")}
                    className={cn("absolute cursor-move", on && "outline outline-2 outline-accent")}
                    style={{ left: `${o.x * 100}%`, top: `${o.y * 100}%`, width: `${o.w * 100}%`, opacity: o.opacity }}
                  >
                    {o.kind === "text" ? (
                      <TextPreview o={o} frameW={project.width} />
                    ) : (
                      <img src={urlOf(o.path!)} alt="" className="block w-full" draggable={false} />
                    )}
                    {on && (
                      <span
                        onPointerDown={dragOverlay(o, "size")}
                        className="absolute -bottom-1.5 -right-1.5 h-3 w-3 cursor-nwse-resize rounded-sm border border-black/40 bg-white"
                        title="Drag to resize"
                      />
                    )}
                  </div>
                );
              })}
            {!project.main.length && (
              <div className="absolute inset-0 grid place-items-center p-6 text-center text-[13px] text-white/60">
                Add clips, pictures or sound to start.
              </div>
            )}
          </div>
          {project.audio.map((a) => (
            <audio
              key={a.id}
              ref={(el) => {
                if (el) audioRefs.current.set(a.id, el);
                else audioRefs.current.delete(a.id);
              }}
              src={urlOf(a.path)}
              preload="auto"
            />
          ))}
        </div>

        {/* Inspector */}
        <div className="panel min-h-0 space-y-3 overflow-y-auto rounded-xl p-3 text-[12px]">
          {!sel ? (
            <>
              <div className="font-semibold text-ink">Video settings</div>
              <label className="block space-y-1">
                <span className="text-ink-3">Size</span>
                <select
                  value={`${project.width}x${project.height}`}
                  onChange={(e) => {
                    const [w, h] = e.target.value.split("x").map(Number);
                    commit((p) => ({ ...p, width: w, height: h }));
                  }}
                  className="w-full rounded-md border border-line bg-surface-2 px-2 py-1 text-ink"
                >
                  {!SIZES.some((s) => s.w === project.width && s.h === project.height) && (
                    <option value={`${project.width}x${project.height}`}>
                      {project.width} × {project.height} (first clip)
                    </option>
                  )}
                  {SIZES.map((s) => (
                    <option key={s.label} value={`${s.w}x${s.h}`}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block space-y-1">
                <span className="text-ink-3">Frame rate</span>
                <select
                  value={project.fps}
                  onChange={(e) => commit((p) => ({ ...p, fps: Number(e.target.value) }))}
                  className="w-full rounded-md border border-line bg-surface-2 px-2 py-1 text-ink"
                >
                  {[24, 30, 60].map((f) => (
                    <option key={f} value={f}>
                      {f} fps
                    </option>
                  ))}
                </select>
              </label>
              <label className="block space-y-1">
                <span className="text-ink-3">File size</span>
                <select
                  value={targetMb ?? 0}
                  onChange={(e) => setTargetMb(Number(e.target.value) || null)}
                  className="w-full rounded-md border border-line bg-surface-2 px-2 py-1 text-ink"
                >
                  <option value={0}>Best quality</option>
                  <option value={10}>At most 10 MB (Discord)</option>
                  <option value={25}>At most 25 MB</option>
                  <option value={50}>At most 50 MB</option>
                  <option value={100}>At most 100 MB</option>
                </select>
              </label>
              <p className="text-[11px] leading-snug text-ink-3">Click a piece on the timeline to change it.</p>
              <button
                type="button"
                onClick={() => {
                  if (window.confirm("Start a new, empty project? (Ctrl+Z brings this one back)")) {
                    commit(() => EMPTY_PROJECT);
                    seek(0);
                  }
                }}
                className="w-full rounded-md border border-line bg-surface-2 px-2 py-1.5 text-ink-3 hover:text-danger"
              >
                New project
              </button>
            </>
          ) : selected?.track === "main" ? (
            <MainInspector m={sel as MainItem} update={(p, h) => updateMain(selected.id, p, h)} />
          ) : selected?.track === "overlay" ? (
            <OverlayInspector o={sel as OverlayItem} update={(p, h) => updateOverlay(selected.id, p, h)} />
          ) : (
            <AudioInspector a={sel as AudioItem} update={(p, h) => updateAudio(selected!.id, p, h)} />
          )}
          {sel && (
            <div className="flex gap-1.5 pt-1">
              <button type="button" onClick={splitHere} className="flex-1 rounded-md border border-line bg-surface-2 px-2 py-1.5 hover:border-accent">
                Split (S)
              </button>
              <button type="button" onClick={removeSelected} className="flex-1 rounded-md border border-line bg-surface-2 px-2 py-1.5 hover:border-red-500/60 hover:text-danger">
                Remove
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Transport */}
      <div className="panel flex flex-wrap items-center gap-2 rounded-xl px-3 py-2 text-[12px]">
        <button
          type="button"
          onClick={() => {
            if (!playing && time >= length - 0.05) seek(0);
            setPlaying((p) => !p);
          }}
          className="grid h-8 w-10 place-items-center rounded-md bg-accent text-white hover:bg-accent-hover"
          title="Play / pause (Space)"
        >
          {playing ? "❚❚" : "▶"}
        </button>
        <span className="font-mono tabular-nums text-ink">
          {clockText(time)} <span className="text-ink-3">/ {clockText(length)}</span>
        </span>
        <span className="mx-1 h-5 w-px bg-line" />
        <button type="button" onClick={splitHere} className="rounded-md border border-line bg-surface-2 px-2 py-1 hover:border-accent" title="Split at the playhead (S)">
          Split
        </button>
        <button type="button" onClick={removeSelected} disabled={!selected} className="rounded-md border border-line bg-surface-2 px-2 py-1 hover:border-accent disabled:opacity-40" title="Remove (Del)">
          Remove
        </button>
        <button type="button" onClick={undo} className="rounded-md border border-line bg-surface-2 px-2 py-1 hover:border-accent" title="Undo (Ctrl+Z)">
          Undo
        </button>
        <button type="button" onClick={redo} className="rounded-md border border-line bg-surface-2 px-2 py-1 hover:border-accent" title="Redo (Ctrl+Y)">
          Redo
        </button>
        <label className="ml-2 flex items-center gap-1.5 text-ink-3" title="Timeline zoom">
          Zoom
          <input type="range" min={6} max={200} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} className="w-24 accent-[var(--color-accent)]" />
        </label>
        <span className="ml-auto font-mono text-[11px] text-ink-3">
          {project.width}×{project.height} · {project.fps} fps
        </span>
        <button
          type="button"
          onClick={() => void doRender()}
          disabled={!!render}
          className="min-w-[150px] rounded-lg bg-accent px-4 py-1.5 font-semibold text-white hover:bg-accent-hover disabled:opacity-70"
        >
          {render ? `Rendering… ${Math.round(render.progress * 100)}%` : "Render video"}
        </button>
      </div>

      {/* Timeline */}
      <div ref={trackRef} className="panel relative h-[220px] shrink-0 overflow-auto rounded-xl">
        <div className="relative" style={{ width: 96 + span * zoom, minHeight: "100%" }}>
          {/* Ruler */}
          <div className="sticky top-0 z-20 flex h-6 border-b border-line bg-surface" onPointerDown={scrub}>
            <div className="sticky left-0 z-10 w-24 shrink-0 border-r border-line bg-surface" />
            <div className="relative flex-1 cursor-pointer">
              {ticks.map((t) => (
                <span key={t} className="absolute top-0 h-full border-l border-line pl-1 font-mono text-[9px] text-ink-3" style={{ left: t * zoom }}>
                  {clockText(t).replace(/\.0$/, "")}
                </span>
              ))}
            </div>
          </div>

          {/* Tracks */}
          {(
            [
              { key: "main", label: "Video", h: 44 },
              { key: "overlay", label: "Overlays", h: nOverlayLanes * LANE + 8 },
              { key: "audio", label: "Music / sound", h: nAudioLanes * LANE + 8 },
            ] as const
          ).map((row) => (
            <div key={row.key} className="relative flex border-b border-line" style={{ height: row.h }}>
              <div className="sticky left-0 z-10 flex w-24 shrink-0 items-center border-r border-line bg-surface px-2 text-[11px] font-semibold text-ink-3">
                {row.label}
              </div>
              <div className="relative flex-1" onPointerDown={scrub}>
                {row.key === "main" &&
                  project.main.map((m, i) => (
                    <div
                      key={m.id}
                      onPointerDown={dragItem("main", m.id, "move")}
                      className={blockClass(
                        selected?.id === m.id,
                        m.kind === "video" ? "border-sky-400/50 bg-sky-500/25 text-sky-50" : "border-violet-400/50 bg-violet-500/25 text-violet-50",
                      )}
                      style={{ left: starts[i] * zoom, width: Math.max(6, m.duration * zoom - 2) }}
                      title={`${m.name} · ${m.duration.toFixed(1)} s · drag to move, drag the edges to trim`}
                    >
                      <div className="truncate pt-0.5 font-semibold">{m.kind === "image" ? "🖼 " : ""}{m.name}</div>
                      {m.kind === "video" && m.hasAudio && (
                        <div className={cn("mt-1 h-1.5 rounded-full", m.muted ? "bg-white/15" : "bg-emerald-400/70")} title={m.muted ? "Sound off" : `Sound ${Math.round(m.volume * 100)}%`} />
                      )}
                      <span className={handle("left")} onPointerDown={dragItem("main", m.id, "left")} />
                      <span className={handle("right")} onPointerDown={dragItem("main", m.id, "right")} />
                    </div>
                  ))}
                {row.key === "overlay" &&
                  project.overlays.map((o) => (
                    <div
                      key={o.id}
                      onPointerDown={dragItem("overlay", o.id, "move")}
                      className={blockClass(selected?.id === o.id, "border-amber-400/50 bg-amber-500/25 text-amber-50")}
                      style={{ left: o.start * zoom, width: Math.max(6, o.duration * zoom - 2), top: 4 + (overlayLanes.get(o.id) ?? 0) * LANE, height: LANE - 6, bottom: "auto" }}
                      title={`${o.kind === "text" ? `Text: ${o.text}` : o.name} · drag to move, edges to change length`}
                    >
                      <div className="truncate pt-1 font-semibold">{o.kind === "text" ? `T  ${o.text}` : `🖼 ${o.name}`}</div>
                      <span className={handle("left")} onPointerDown={dragItem("overlay", o.id, "left")} />
                      <span className={handle("right")} onPointerDown={dragItem("overlay", o.id, "right")} />
                    </div>
                  ))}
                {row.key === "audio" &&
                  project.audio.map((a) => (
                    <div
                      key={a.id}
                      onPointerDown={dragItem("audio", a.id, "move")}
                      className={blockClass(selected?.id === a.id, "border-emerald-400/50 bg-emerald-500/20 text-emerald-50")}
                      style={{ left: a.start * zoom, width: Math.max(6, a.duration * zoom - 2), top: 4 + (audioLanes.get(a.id) ?? 0) * LANE, height: LANE - 6, bottom: "auto" }}
                      title={`${a.name} · ${Math.round(a.volume * 100)}% · drag to move, edges to trim`}
                    >
                      <div className="truncate pt-1 font-semibold">♪ {a.name}</div>
                      <span className={handle("left")} onPointerDown={dragItem("audio", a.id, "left")} />
                      <span className={handle("right")} onPointerDown={dragItem("audio", a.id, "right")} />
                    </div>
                  ))}
              </div>
            </div>
          ))}

          {/* Playhead */}
          <div className="pointer-events-none absolute bottom-0 top-0 z-30 w-px bg-red-500" style={{ left: 96 + time * zoom }}>
            <span className="absolute -left-1 top-0 h-2 w-2 rotate-45 bg-red-500" />
          </div>
        </div>
      </div>
    </div>
  );
}

function TextPreview({ o, frameW }: { o: OverlayItem; frameW: number }) {
  // Same layout as the rendered PNG, scaled to the preview width.
  const size = o.fontSize ?? 64;
  return (
    <div
      className="whitespace-pre font-bold leading-[1.2]"
      style={{
        // cqw: % of the preview width; the frame is `frameW` px wide.
        fontSize: `${(size / frameW) * 100}cqw`,
        padding: `${((size * TEXT_PAD) / frameW) * 100}cqw`,
        color: o.color,
        fontFamily: '"Segoe UI", system-ui, sans-serif',
        background: o.box ? "rgba(0,0,0,0.6)" : undefined,
        borderRadius: o.box ? `${((size * TEXT_PAD) / frameW) * 100}cqw` : undefined,
        textShadow: o.box ? undefined : "0 0.04em 0.12em rgba(0,0,0,0.75)",
      }}
    >
      {o.text}
    </div>
  );
}

function Num({
  label,
  value,
  min,
  max,
  step,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  onChange: (v: number, final: boolean) => void;
}) {
  return (
    <label className="block space-y-1">
      <span className="flex justify-between text-ink-3">
        {label}
        <span className="font-mono text-ink-2">
          {Number.isInteger(step) ? Math.round(value) : value.toFixed(1)}
          {suffix}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value), false)}
        onPointerUp={(e) => onChange(Number((e.target as HTMLInputElement).value), true)}
        className="w-full accent-[var(--color-accent)]"
      />
    </label>
  );
}

function MainInspector({ m, update }: { m: MainItem; update: (p: Partial<MainItem>, history?: boolean) => void }) {
  return (
    <div className="space-y-3">
      <div className="truncate font-semibold text-ink" title={m.path}>
        {m.kind === "image" ? "Picture" : "Clip"}: {m.name}
      </div>
      <Num label="Length" value={m.duration} min={MIN_LEN} max={m.kind === "video" ? m.srcDuration - m.srcIn : 60} step={0.1} suffix=" s" onChange={(v, f) => update({ duration: v }, f)} />
      {m.kind === "video" && (
        <>
          <Num label="Starts at (in the file)" value={m.srcIn} min={0} max={Math.max(0, m.srcDuration - m.duration)} step={0.1} suffix=" s" onChange={(v, f) => update({ srcIn: v }, f)} />
          {m.hasAudio ? (
            <>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={!m.muted} onChange={(e) => update({ muted: !e.target.checked })} />
                <span>Clip sound</span>
              </label>
              {!m.muted && <Num label="Clip volume" value={m.volume * 100} min={0} max={200} step={1} suffix="%" onChange={(v, f) => update({ volume: v / 100 }, f)} />}
            </>
          ) : (
            <p className="text-[11px] text-ink-3">This clip has no sound.</p>
          )}
        </>
      )}
    </div>
  );
}

function OverlayInspector({ o, update }: { o: OverlayItem; update: (p: Partial<OverlayItem>, history?: boolean) => void }) {
  return (
    <div className="space-y-3">
      <div className="font-semibold text-ink">{o.kind === "text" ? "Text" : `Picture: ${o.name}`}</div>
      {o.kind === "text" && (
        <>
          <textarea
            value={o.text}
            onChange={(e) => update({ text: e.target.value }, false)}
            onBlur={(e) => update({ text: e.target.value })}
            rows={2}
            className="w-full rounded-md border border-line bg-surface-2 px-2 py-1 text-ink outline-none focus:border-accent"
          />
          <Num label="Text size" value={o.fontSize ?? 64} min={10} max={400} step={1} suffix=" px" onChange={(v, f) => update({ fontSize: v }, f)} />
          <div className="flex items-center gap-2">
            <input type="color" value={o.color ?? "#ffffff"} onChange={(e) => update({ color: e.target.value }, false)} onBlur={(e) => update({ color: e.target.value })} />
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={!!o.box} onChange={(e) => update({ box: e.target.checked })} />
              Dark box behind
            </label>
          </div>
        </>
      )}
      {o.kind === "image" && <Num label="Size" value={o.w * 100} min={2} max={100} step={1} suffix="% of width" onChange={(v, f) => update({ w: v / 100 }, f)} />}
      <Num label="Opacity" value={o.opacity * 100} min={5} max={100} step={1} suffix="%" onChange={(v, f) => update({ opacity: v / 100 }, f)} />
      <Num label="Shows for" value={o.duration} min={MIN_LEN} max={120} step={0.1} suffix=" s" onChange={(v, f) => update({ duration: v }, f)} />
      <p className="text-[11px] leading-snug text-ink-3">Drag it in the preview to move it; drag its corner to resize.</p>
    </div>
  );
}

function AudioInspector({ a, update }: { a: AudioItem; update: (p: Partial<AudioItem>, history?: boolean) => void }) {
  return (
    <div className="space-y-3">
      <div className="truncate font-semibold text-ink" title={a.path}>
        Sound: {a.name}
      </div>
      <Num label="Volume" value={a.volume * 100} min={0} max={200} step={1} suffix="%" onChange={(v, f) => update({ volume: v / 100 }, f)} />
      <Num label="Fade in" value={a.fadeIn} min={0} max={Math.min(10, a.duration)} step={0.1} suffix=" s" onChange={(v, f) => update({ fadeIn: v }, f)} />
      <Num label="Fade out" value={a.fadeOut} min={0} max={Math.min(10, a.duration)} step={0.1} suffix=" s" onChange={(v, f) => update({ fadeOut: v }, f)} />
      <Num label="Starts at (in the file)" value={a.srcIn} min={0} max={Math.max(0, a.srcDuration - a.duration)} step={0.1} suffix=" s" onChange={(v, f) => update({ srcIn: v }, f)} />
      <p className="text-[11px] text-ink-3">Above 100% the preview plays at 100%; the render is louder.</p>
    </div>
  );
}

export const EDITOR_FILE_TYPES = { IMAGE_RE, AUDIO_RE, VIDEO_RE };
