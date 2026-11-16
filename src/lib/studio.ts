/**
 * Studio layers: pictures, text, webcam, clock and a recording timer shown
 * on top of the recorded screen. Stored in local storage, which the Studio
 * panel (main window) and the layer window share, so edits show up live.
 */

export type LayerKind = "image" | "text" | "webcam" | "clock" | "timer";

export interface Layer {
  id: string;
  kind: LayerKind;
  name: string;
  visible: boolean;
  /** Top-left and width, as fractions of the screen. */
  x: number;
  y: number;
  w: number;
  /** Height / width of the box (pictures, webcam). */
  aspect: number;
  opacity: number;
  path?: string;
  text?: string;
  /** Text height as a fraction of the screen height. */
  fontSize?: number;
  color?: string;
  /** Dark box behind text. */
  box?: boolean;
  deviceId?: string;
  shape?: "rect" | "rounded" | "circle";
  border?: boolean;
  mirror?: boolean;
  /** Crop of the picture / webcam, a fraction per side. */
  cropLeft?: number;
  cropTop?: number;
  cropRight?: number;
  cropBottom?: number;
}

/** A scene: what to record plus its layers, switched with one click. */
export interface Scene {
  id: string;
  name: string;
  /** null = keep whatever is being recorded. */
  source: import("./types").CaptureSource | null;
  layers: Layer[];
}
export interface Scenes {
  active: string | null;
  scenes: Scene[];
}

/** "Scene 1", "Scene 2", ... the first free one. */
export function nextSceneName(scenes: readonly Scene[]): string {
  const taken = new Set(scenes.map((s) => s.name.trim().toLowerCase()));
  for (let i = 1; ; i++) if (!taken.has(`scene ${i}`)) return `Scene ${i}`;
}

/** The scene from what Studio has now. */
export function sceneFrom(name: string, source: Scene["source"], layers: Layer[]): Scene {
  return { id: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name, source, layers };
}

export const LAYERS_KEY = "lastshot.studio.layers";

export function loadLayers(): Layer[] {
  try {
    const raw = localStorage.getItem(LAYERS_KEY);
    const v = raw ? (JSON.parse(raw) as Layer[]) : [];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function saveLayers(layers: Layer[]): void {
  try {
    localStorage.setItem(LAYERS_KEY, JSON.stringify(layers));
  } catch {
    /* storage blocked */
  }
}

let n = 0;
export function newLayer(kind: LayerKind, extra: Partial<Layer> = {}): Layer {
  n += 1;
  const base: Layer = {
    id: `${Date.now().toString(36)}${n}`,
    kind,
    name: { image: "Picture", text: "Text", webcam: "Webcam", clock: "Clock", timer: "Recording timer" }[kind],
    visible: true,
    x: 0.03,
    y: 0.04,
    w: 0.2,
    aspect: 9 / 16,
    opacity: 1,
  };
  if (kind === "text") Object.assign(base, { text: "Your text", fontSize: 0.05, color: "#ffffff", box: true, x: 0.03, y: 0.85 });
  if (kind === "clock" || kind === "timer")
    Object.assign(base, { fontSize: 0.035, color: "#ffffff", box: true, x: kind === "clock" ? 0.86 : 0.03, y: 0.03 });
  if (kind === "webcam") Object.assign(base, { x: 0.76, y: 0.68, w: 0.21, aspect: 9 / 16, shape: "rounded", border: true, mirror: true });
  return { ...base, ...extra };
}

/** Moves a layer up (towards the front) or down in the stack. */
export function restack(layers: Layer[], id: string, dir: -1 | 1): Layer[] {
  const i = layers.findIndex((l) => l.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= layers.length) return layers;
  const out = layers.slice();
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}
