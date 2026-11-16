/**
 * Saved editor projects (kept in the window's local storage, newest first)
 * and turning files into timeline items.
 */
import { assetUrl, isTauri } from "../lib/bridge";
import type { ClipMetadata } from "../lib/types";
import { newId } from "../timeline/model";
import { type Shape, DEFAULT_STYLE, shapeId } from "../annotate/shapes";
import { editorApi } from "./api";
import { DEFAULT_FX, type EdItem, type EdProject, newProject, tracksOf, withSpare } from "./project";

const LIST = "lastshot.editor.projects.v2";
const OLD = "lastshot.editor.project";
const KEEP = 24;

export const IMAGE_RE = /\.(png|jpe?g|webp|gif|bmp)$/i;
export const AUDIO_RE = /\.(mp3|wav|m4a|aac|wma|flac|ogg)$/i;
export const VIDEO_RE = /\.(mp4|mov|m4v|mkv|avi|wmv|webm)$/i;
export const MEDIA_RE = /\.(png|jpe?g|webp|gif|bmp|mp3|wav|m4a|aac|wma|flac|ogg|mp4|mov|m4v|mkv|avi|wmv|webm)$/i;

export const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;
export const stem = (p: string) => baseName(p).replace(/\.[^.]+$/, "");

export function loadProjects(): EdProject[] {
  try {
    const raw = localStorage.getItem(LIST);
    if (raw) return (JSON.parse(raw) as EdProject[]).filter((p) => p && p.tl && Array.isArray(p.tl.items)).map((p) => ({ ...p, tl: withSpare(p.tl) }));
    const old = localStorage.getItem(OLD);
    if (old) {
      const p = migrate(JSON.parse(old));
      if (p) {
        saveProjects([p]);
        return [p];
      }
    }
  } catch {
    /* unreadable: start fresh */
  }
  return [];
}

export function saveProjects(list: EdProject[]) {
  const sorted = [...list].sort((a, b) => b.updated - a.updated).slice(0, KEEP);
  try {
    localStorage.setItem(LIST, JSON.stringify(sorted));
  } catch {
    // Full: keep fewer.
    try {
      localStorage.setItem(LIST, JSON.stringify(sorted.slice(0, 6)));
    } catch {
      /* give up quietly; the open project stays in memory */
    }
  }
}

export const isEmpty = (p: EdProject) => p.tl.items.length === 0;

/** The project last open (from the list), or a new one. */
export function lastOpen(list: EdProject[]): EdProject {
  return list[0] ?? newProject();
}

// ------------------------------------------------------------- migration

interface OldProject {
  width: number;
  height: number;
  fps: number;
  main: { id: string; kind: "video" | "image"; path: string; name: string; srcIn: number; duration: number; srcDuration: number; width: number; height: number; hasAudio: boolean; volume: number; muted: boolean }[];
  overlays: { id: string; kind: "image" | "text"; path?: string; name: string; text?: string; fontSize?: number; color?: string; box?: boolean; start: number; duration: number; x: number; y: number; w: number; aspect: number; opacity: number }[];
  audio: { id: string; path: string; name: string; start: number; srcIn: number; duration: number; srcDuration: number; volume: number; fadeIn: number; fadeOut: number }[];
}

/** The old one-track editor's project, as a timeline project. */
export function migrate(o: OldProject): EdProject | null {
  if (!o || !Array.isArray(o.main)) return null;
  const p = newProject("Earlier edit");
  const [ov, v, a] = [tracksOf(p.tl, "overlay")[0], tracksOf(p.tl, "video")[0], tracksOf(p.tl, "audio")[0]];
  p.size = o.width && o.height ? { w: o.width, h: o.height } : "auto";
  const items: EdItem[] = [];
  let t = 0;
  for (const m of o.main) {
    items.push({
      id: newId("i"),
      track: v.id,
      kind: m.kind,
      name: m.name,
      path: m.path,
      start: t,
      duration: m.duration,
      srcIn: m.kind === "video" ? m.srcIn : 0,
      srcDuration: m.kind === "video" ? m.srcDuration : undefined,
      width: m.width,
      height: m.height,
      hasAudio: m.hasAudio,
      audio: { ...DEFAULT_FX, volume: m.volume ?? 1, muted: m.muted },
    });
    t += m.duration;
  }
  const W = o.width || 1920;
  const H = o.height || 1080;
  for (const x of o.overlays ?? []) {
    const w = x.w * W;
    const h = w * (x.aspect || 1);
    const id = shapeId();
    const shape: Shape =
      x.kind === "text"
        ? { ...base(id, "text", x.x * W, x.y * H, w, h), text: x.text ?? "", size: x.fontSize ?? 64, color: x.color ?? "#ffffff", fill: x.box ? "#000000aa" : null, bold: true, outline: null, shadow: !x.box, opacity: x.opacity ?? 1 }
        : { ...base(id, "image", x.x * W, x.y * H, w, h), src: x.path, opacity: x.opacity ?? 1 };
    items.push({ id, track: ov.id, kind: "shape", name: x.name, start: x.start, duration: x.duration, srcIn: 0, shape });
  }
  for (const s of o.audio ?? []) {
    items.push({
      id: newId("i"),
      track: a.id,
      kind: "audio",
      name: s.name,
      path: s.path,
      start: s.start,
      duration: s.duration,
      srcIn: s.srcIn,
      srcDuration: s.srcDuration,
      audio: { ...DEFAULT_FX, volume: s.volume ?? 1, fadeIn: s.fadeIn ?? 0, fadeOut: s.fadeOut ?? 0 },
    });
  }
  p.tl = { ...p.tl, items };
  return p;
}

function base(id: string, kind: Shape["kind"], x: number, y: number, w: number, h: number): Shape {
  return { id, kind, x, y, w, h, rot: 0, color: DEFAULT_STYLE.color, width: DEFAULT_STYLE.width, opacity: 1 };
}

// ------------------------------------------------------------- media

/** In the browser preview, library clips play from object URLs. */
const simUrls = new Map<string, string>();
export function rememberSimClip(c: ClipMetadata) {
  if (c.preview_url) simUrls.set(c.path, c.preview_url);
}
export const urlOf = (path: string): string => simUrls.get(path) ?? (path.startsWith("data:") || path.startsWith("blob:") ? path : assetUrl(path));

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => res(img);
    img.onerror = () => rej(new Error("Could not load the picture"));
    img.src = url;
  });
}

function probeVideo(url: string): Promise<{ duration: number; width: number; height: number }> {
  return new Promise((res, rej) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    v.onloadedmetadata = () => res({ duration: v.duration || 0, width: v.videoWidth, height: v.videoHeight });
    v.onerror = () => rej(new Error("Could not read the video"));
    v.src = url;
  });
}

export const STILL_SECONDS = 5;

/**
 * A timeline item for a file (not yet placed: start 0, no track). Unknown
 * files give null. `clip` (from the library) saves a probe.
 */
export async function itemFromPath(path: string, clip?: ClipMetadata): Promise<EdItem | null> {
  if (clip) rememberSimClip(clip);
  const name = clip?.title || stem(path);
  const common = { id: newId("i"), track: "", start: 0, srcIn: 0, name, path };
  if (IMAGE_RE.test(path)) {
    await editorApi.allowMedia([path]).catch(() => undefined);
    const img = await loadImage(urlOf(path));
    return { ...common, kind: "image", duration: STILL_SECONDS, width: img.naturalWidth, height: img.naturalHeight };
  }
  if (AUDIO_RE.test(path)) {
    const info = isTauri() ? await editorApi.mediaInfo(path) : { duration: 10, hasAudio: true };
    return { ...common, kind: "audio", duration: info.duration, srcDuration: info.duration, hasAudio: true, audio: { ...DEFAULT_FX } };
  }
  if (!VIDEO_RE.test(path) && !clip) return null;
  if (clip && !isTauri()) {
    return {
      ...common,
      kind: "video",
      duration: clip.duration_seconds,
      srcDuration: clip.duration_seconds,
      width: clip.width,
      height: clip.height,
      fps: clip.fps,
      hasAudio: clip.has_audio,
      audio: { ...DEFAULT_FX },
      srcMarkers: clip.markers ?? [],
    };
  }
  let info: { duration: number; width: number; height: number; hasAudio: boolean; fps?: number };
  if (isTauri()) {
    const m = await editorApi.mediaInfo(path);
    if (m.kind === "audio") return { ...common, kind: "audio", duration: m.duration, srcDuration: m.duration, hasAudio: true, audio: { ...DEFAULT_FX } };
    info = m;
  } else {
    const m = await probeVideo(urlOf(path));
    info = { ...m, hasAudio: true };
  }
  return {
    ...common,
    kind: "video",
    duration: info.duration,
    srcDuration: info.duration,
    width: info.width || clip?.width,
    height: info.height || clip?.height,
    fps: info.fps ?? clip?.fps,
    hasAudio: info.hasAudio,
    audio: { ...DEFAULT_FX },
    srcMarkers: clip?.markers ?? [],
  };
}

/** A picture item's PNG at its own size (capped to 4K), for the render. */
export async function stillPng(it: EdItem): Promise<string> {
  const img = await loadImage(urlOf(it.path!));
  const k = Math.min(1, 3840 / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(img.naturalWidth * k));
  c.height = Math.max(1, Math.round(img.naturalHeight * k));
  c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL("image/png");
}
