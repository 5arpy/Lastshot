/**
 * Audio tab → Devices: default devices with a fallback order, per-app
 * microphones, volumes and mutes, and the Audio guard that keeps them where
 * the user put them (ask / restore / accept), with snapshots and a log.
 */

import { isTauri } from "./bridge";

export type Policy = "ask" | "restore" | "accept";
export type Cause = "windows" | "user" | "lastshot" | "guard" | "restore";

export interface DevicePick {
  id: string;
  name: string;
}

export interface PreferredDefault {
  flow: 0 | 1;
  comm: boolean;
  order: DevicePick[];
}

export interface AppPref {
  exe: string;
  input: DevicePick | null;
  volume: number | null;
  mute: boolean | null;
  policy: Policy | null;
  noDuck: boolean;
}

export interface DuckSettings {
  enabled: boolean;
  thresholdDb: number;
  amountDb: number;
  releaseMs: number;
}

export interface GuardSettings {
  enabled: boolean;
  policy: Policy;
  notifyRestores: boolean;
  strict: boolean;
  defaults: PreferredDefault[];
  apps: AppPref[];
  deviceRules: { deviceId: string; policy: Policy }[];
  duck: DuckSettings;
  micMuteHotkey: string;
}

export interface Endpoint {
  id: string;
  name: string;
  flow: "render" | "capture";
  isDefault: boolean;
}

export interface SnapDefault {
  flow: 0 | 1;
  role: 0 | 1 | 2;
  id: string;
  name: string;
}

export interface GuardView {
  settings: GuardSettings;
  status: { tone: "ok" | "warn" | "err" | "info"; text: string };
  pending: { id: number; text: string }[];
  render: Endpoint[];
  capture: Endpoint[];
  defaults: SnapDefault[];
  cableIds: string[];
  micMuted: boolean | null;
  error: string | null;
}

export interface AppView {
  exe: string;
  pids: number[];
  playing: boolean;
  recording: boolean;
  volume: number;
  mute: boolean;
  peak: number;
  outputNow: string | null;
  inputNow: string | null;
  output: DevicePick | null;
  input: DevicePick | null;
  pref: AppPref | null;
  solo: boolean;
}

export interface LogEntry {
  time: number;
  kind: string;
  what: string;
  from: string;
  to: string;
  who: Cause;
  action: string;
}

export interface SnapshotMeta {
  id: string;
  name: string | null;
  time: number;
  reason: string;
}

export interface Change {
  what: string;
  from: string;
  to: string;
}

export const EVT_GUARD = "lastshot://audio-guard";

function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const t = window.__TAURI__;
  if (!t) return Promise.reject(new Error("Tauri API unavailable"));
  return t.core.invoke<T>(cmd, args);
}

export const guard = {
  status: (): Promise<GuardView> => invoke("guard_status"),
  setSettings: (s: GuardSettings): Promise<GuardView> => invoke("guard_set_settings", { settingsNew: s }),
  setDefault: (flow: 0 | 1, comm: boolean, id: string): Promise<GuardView> => invoke("guard_set_default", { flow, comm, id }),
  apps: (): Promise<AppView[]> => (isTauri() ? invoke("guard_apps") : Promise.resolve([])),
  setAppInput: (exe: string, device: DevicePick | null): Promise<void> => invoke("guard_set_app_input", { exe, device }),
  setAppVolume: (exe: string, volume: number | null, mute: boolean | null, remember: boolean): Promise<number> =>
    invoke("guard_set_app_volume", { exe, volume, mute, remember }),
  setAppOptions: (exe: string, policy: Policy | null, noDuck: boolean, forgetVolume = false): Promise<GuardView> =>
    invoke("guard_set_app_options", { exe, policy, noDuck, forgetVolume }),
  solo: (exe: string | null): Promise<void> => invoke("guard_solo", { exe }),
  answer: (id: number, choice: "restore" | "keep" | "alwaysRestore" | "alwaysKeep"): Promise<GuardView> =>
    invoke("guard_answer", { id, choice }),
  levels: (): Promise<{ output: number; mic: number }> => (isTauri() ? invoke("guard_levels") : Promise.resolve({ output: 0, mic: 0 })),
  micMute: (mute: boolean): Promise<boolean> => invoke("guard_mic_mute", { mute }),
  log: (limit = 500): Promise<LogEntry[]> => (isTauri() ? invoke("guard_log", { limit }) : Promise.resolve([])),
  exportLog: (path: string): Promise<number> => invoke("guard_export_log", { path }),
  snapshots: (): Promise<SnapshotMeta[]> => (isTauri() ? invoke("guard_snapshots") : Promise.resolve([])),
  take: (name: string | null): Promise<SnapshotMeta> => invoke("guard_snapshot_take", { name }),
  preview: (id: string): Promise<Change[]> => invoke("guard_snapshot_preview", { id }),
  restore: (id: string): Promise<Change[]> => invoke("guard_snapshot_restore", { id }),
  remove: (id: string): Promise<void> => invoke("guard_snapshot_delete", { id }),
  rename: (id: string, name: string): Promise<void> => invoke("guard_snapshot_rename", { id, name }),
  exportSnapshot: (id: string, path: string): Promise<void> => invoke("guard_snapshot_export", { id, path }),
  importSnapshot: (path: string): Promise<SnapshotMeta> => invoke("guard_snapshot_import", { path }),
};

/** Who changed it, in plain words. */
export function whoLabel(c: Cause): string {
  switch (c) {
    case "windows":
      return "Windows (after a device change)";
    case "user":
      return "You or another app";
    case "lastshot":
      return "You, in Lastshot";
    case "guard":
      return "Lastshot's guard";
    case "restore":
      return "A snapshot restore";
  }
}

export const KIND_LABELS: Record<string, string> = {
  default: "Default devices",
  "app-output": "App outputs",
  "app-input": "App microphones",
  "app-volume": "App volume",
  mic: "Microphone mute",
  snapshot: "Snapshots",
  guard: "Guard on/off",
};

export interface LogFilter {
  kind: string;
  who: Cause | "";
  text: string;
}

export function filterLog(entries: LogEntry[], f: LogFilter): LogEntry[] {
  const q = f.text.trim().toLowerCase();
  return entries.filter(
    (e) =>
      (!f.kind || e.kind === f.kind) &&
      (!f.who || e.who === f.who) &&
      (!q || `${e.what} ${e.from} ${e.to} ${e.action}`.toLowerCase().includes(q)),
  );
}

/** The four default rows: playback / recording × everyday / communications. */
export const DEFAULT_ROWS: { flow: 0 | 1; comm: boolean; label: string; hint: string }[] = [
  { flow: 0, comm: false, label: "Playback", hint: "Where apps play unless told otherwise." },
  { flow: 0, comm: true, label: "Playback for calls", hint: "Windows' communications output (Discord, Teams…)." },
  { flow: 1, comm: false, label: "Microphone", hint: "What apps record unless told otherwise." },
  { flow: 1, comm: true, label: "Microphone for calls", hint: "Windows' communications microphone." },
];

/** The device Windows uses now for a row. */
export function currentDefault(v: GuardView, flow: 0 | 1, comm: boolean): SnapDefault | null {
  const role = comm ? 2 : 0;
  return v.defaults.find((d) => d.flow === flow && d.role === role) ?? null;
}

export function preferredOrder(s: GuardSettings, flow: 0 | 1, comm: boolean): DevicePick[] {
  return s.defaults.find((d) => d.flow === flow && d.comm === comm)?.order ?? [];
}

/** A copy of the settings with one row's fallback order replaced. */
export function withOrder(s: GuardSettings, flow: 0 | 1, comm: boolean, order: DevicePick[]): GuardSettings {
  const rest = s.defaults.filter((d) => !(d.flow === flow && d.comm === comm));
  return { ...s, defaults: order.length ? [...rest, { flow, comm, order }] : rest };
}

/** Moves item `i` by `dir` (-1 up, +1 down). */
export function move<T>(list: T[], i: number, dir: -1 | 1): T[] {
  const j = i + dir;
  if (i < 0 || i >= list.length || j < 0 || j >= list.length) return list;
  const out = [...list];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/** Which connected device the fallback order picks (by id, then name). */
export function pickConnected(order: DevicePick[], active: Endpoint[]): Endpoint | null {
  for (const p of order) {
    const byId = active.find((e) => e.id === p.id);
    if (byId) return byId;
    const byName = p.name ? active.find((e) => e.name.toLowerCase() === p.name.toLowerCase()) : undefined;
    if (byName) return byName;
  }
  return null;
}

export function policyLabel(p: Policy): string {
  return p === "ask" ? "Ask me" : p === "restore" ? "Always restore mine" : "Accept Windows' changes";
}

export function timeLabel(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return sameDay ? hm : `${d.toLocaleDateString()} ${hm}`;
}

export function deviceName(id: string | null, list: Endpoint[]): string {
  if (!id) return "Windows' default";
  return list.find((e) => e.id === id)?.name ?? "a device that is not connected";
}
