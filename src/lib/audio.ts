/**
 * Audio tab (Voicemeeter remote, per-app output) and pop-out windows.
 * In a plain browser the calls return "not installed" / empty lists.
 */

import { isTauri } from "./bridge";

export interface VmRoute {
  name: string;
  on: boolean;
}

export interface VmStrip {
  index: number;
  label: string;
  role: string;
  virtual: boolean;
  gain: number;
  mute: boolean;
  routes: VmRoute[];
}

export interface VmBus {
  index: number;
  name: string;
  label: string;
  role: string;
  virtual: boolean;
  gain: number;
  mute: boolean;
  device: string | null;
}

export interface VmStatus {
  installed: boolean;
  running: boolean;
  kind: number;
  edition: string;
  error: string | null;
  strips: VmStrip[];
  buses: VmBus[];
}

export interface VmLevels {
  running: boolean;
  dirty: boolean;
  strips: number[];
  buses: number[];
}

export interface RenderDevice {
  id: string;
  name: string;
  isDefault: boolean;
}

export interface AudioApp {
  exe: string;
  pids: number[];
  output: string | null;
  active: boolean;
}

export interface AppOutputRule {
  exe: string;
  deviceId: string;
  deviceName: string;
}

export type PopView = "audio" | "editor" | "studio";
export const POP_VIEWS: PopView[] = ["audio", "editor", "studio"];
export const EVT_POPOUTS = "lastshot://popouts";

function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const t = window.__TAURI__;
  if (!t) return Promise.reject(new Error("Tauri API unavailable"));
  return t.core.invoke<T>(cmd, args);
}

const NOT_INSTALLED: VmStatus = {
  installed: false,
  running: false,
  kind: 0,
  edition: "",
  error: "Voicemeeter works in the desktop app only",
  strips: [],
  buses: [],
};

export const audio = {
  vmStatus: (): Promise<VmStatus> => (isTauri() ? invoke("vm_status") : Promise.resolve(NOT_INSTALLED)),
  vmLevels: (): Promise<VmLevels> =>
    isTauri() ? invoke("vm_levels") : Promise.resolve({ running: false, dirty: false, strips: [], buses: [] }),
  vmSet: (param: string, value: number | boolean | string): Promise<void> => invoke("vm_set", { param, value }),
  vmLaunch: (): Promise<void> => invoke("vm_launch"),
  listRenderDevices: (): Promise<RenderDevice[]> => (isTauri() ? invoke("list_render_devices") : Promise.resolve([])),
  listAudioApps: (): Promise<AudioApp[]> => (isTauri() ? invoke("list_audio_apps") : Promise.resolve([])),
  /** `deviceId` null = back to Windows' default. Returns how many processes changed. */
  setAppOutput: (exe: string, deviceId: string | null): Promise<number> =>
    invoke("set_app_output", { exe, deviceId, remember: true }),
};

export const popout = {
  list: (): Promise<PopView[]> => (isTauri() ? invoke("popout_list") : Promise.resolve([])),
  open: (view: PopView, focus = true): Promise<void> => invoke("popout_open", { view, focus }),
  close: (view: PopView): Promise<void> => invoke("popout_close", { view }),
  /** Calls `handler` with the popped-out tabs whenever that changes. */
  onChange(handler: (views: PopView[]) => void): Promise<() => void> {
    const t = window.__TAURI__;
    if (!t) return Promise.resolve(() => undefined);
    return t.event.listen<PopView[]>(EVT_POPOUTS, (e) => handler(e.payload));
  },
};

/** The tab this window shows on its own (`pop-audio` → "audio"), or null. */
export function popViewOf(label: string | null, search: string): PopView | null {
  const fromLabel = label?.startsWith("pop-") ? label.slice(4) : null;
  const fromQuery = new URLSearchParams(search).get("view");
  const v = fromLabel ?? fromQuery;
  return v && (POP_VIEWS as string[]).includes(v) ? (v as PopView) : null;
}

/** Linear peak (1.0 = 0 dB) → dB, floored at -60. */
export function toDb(linear: number): number {
  if (!(linear > 0)) return -60;
  return Math.max(-60, 20 * Math.log10(linear));
}

/** -60..+12 dB → 0..1 along a fader or meter. */
export function dbToPos(db: number): number {
  return Math.min(1, Math.max(0, (db + 60) / 72));
}

/** Voicemeeter's own virtual outputs/inputs, listed first in "Send to". */
export function isVoicemeeterDevice(name: string): boolean {
  return /voicemeeter|vb-audio/i.test(name);
}
