/**
 * The app's windows and tabs (see src-tauri/src/shell.rs): which tabs this
 * window holds, moving tabs between windows, and opening a tab wherever it
 * lives.
 */
import { useEffect, useState } from "react";
import { currentWindowLabel, isTauri } from "./bridge";

export type TabId = "home" | "clips" | "editor" | "studio" | "audio" | "settings";
export const TAB_IDS: TabId[] = ["home", "clips", "editor", "studio", "audio", "settings"];
export const TAB_NAMES: Record<TabId, string> = {
  home: "Home",
  clips: "Clips",
  editor: "Editor",
  studio: "Studio",
  audio: "Audio",
  settings: "Settings",
};
export const isTabId = (t: unknown): t is TabId => typeof t === "string" && (TAB_IDS as string[]).includes(t);

export interface ShellWin {
  label: string;
  tabs: TabId[];
  active: TabId;
}
export interface ShellLayout {
  windows: ShellWin[];
}

export const EVT_SHELL = "lastshot://shell";
export const EVT_HINT = "lastshot://shell-hint";
export const EVT_OPEN = "lastshot://shell-open";
export const MAIN = "main";

/** This window's label ("main" in a browser). */
export const myLabel = (): string => currentWindowLabel() ?? MAIN;
export const isMainWindow = (): boolean => myLabel() === MAIN;

type Listen = <T>(e: string, h: (ev: { payload: T }) => void, o?: { target?: string }) => Promise<() => void>;
const t = () => window.__TAURI__;
function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const g = t();
  if (!g) return Promise.reject(new Error("not in the app"));
  return g.core.invoke<T>(cmd, args);
}
/**
 * `mine`: only events sent to this window. (A plain listen also hears
 * events sent to other windows.)
 */
function listen<T>(e: string, h: (p: T) => void, mine = false): Promise<() => void> {
  const g = t();
  if (!g) return Promise.resolve(() => undefined);
  return (g.event.listen as Listen)<T>(e, (ev) => h(ev.payload), mine ? { target: myLabel() } : undefined);
}

/** The default layout: everything in the main window. */
export const DEFAULT_LAYOUT: ShellLayout = { windows: [{ label: MAIN, tabs: [...TAB_IDS], active: "home" }] };

export const shell = {
  layout: (): Promise<ShellLayout> => (isTauri() ? invoke<ShellLayout>("shell_layout") : Promise.resolve(DEFAULT_LAYOUT)),
  restore: (): Promise<ShellLayout> => invoke("shell_restore"),
  setActive: (tab: TabId): Promise<void> => (isTauri() ? invoke("shell_set_active", { tab }) : Promise.resolve()),
  reorder: (tabs: TabId[]): Promise<void> => invoke("shell_reorder", { tabs }),
  reportStrip: (rect: [number, number, number, number], tabs: [number, number][]): Promise<void> =>
    isTauri() ? invoke("shell_report_strip", { rect, tabs }) : Promise.resolve(),
  /** Returns the label of the window being dragged (this one, when it held only `tab`). */
  tearOut: (tab: TabId, grab: [number, number]): Promise<string> => invoke("shell_tear_out", { tab, grab, size: null }),
  dragTo: (label: string, grab: [number, number]): Promise<[string, number] | null> => invoke("shell_drag_to", { label, grab }),
  drop: (label: string, tab: TabId): Promise<string> => invoke("shell_drop", { label, tab }),
  /** `to`: a window label, or "new" for a window of its own. */
  moveTab: (tab: TabId, to: string, index?: number): Promise<string> => invoke("shell_move_tab", { tab, to, index: index ?? null }),
  /** Shows the window holding `tab`, makes it active and hands it `payload`. */
  openTab: (tab: TabId, payload?: unknown): Promise<string> => invoke("shell_open_tab", { tab, payload: payload ?? null }),
  onLayout: (h: (l: ShellLayout) => void) => listen<ShellLayout>(EVT_SHELL, h),
  onHint: (h: (index: number | null) => void) => listen<number | null>(EVT_HINT, h, true),
  onOpen: (h: (o: { tab: TabId; payload: unknown }) => void) => listen<{ tab: TabId; payload: unknown }>(EVT_OPEN, h, true),
  closeWindow: async (): Promise<void> => {
    const w = (t()?.window?.getCurrentWindow() as unknown as { close?: () => Promise<void> }) ?? null;
    await w?.close?.();
  },
};

/** Index of the tab `step` away from `active`, wrapping. */
export function cycleTab(tabs: TabId[], active: TabId, step: number): TabId {
  if (!tabs.length) return active;
  const i = Math.max(0, tabs.indexOf(active));
  return tabs[(((i + step) % tabs.length) + tabs.length) % tabs.length];
}

/** Insert index for a point over tabs given as [left, right]. */
export function insertIndex(tabs: [number, number][], x: number): number {
  return tabs.filter(([l, r]) => (l + r) / 2 < x).length;
}

/** The layout, kept current. */
export function useShellLayout(): ShellLayout {
  const [layout, setLayout] = useState<ShellLayout>(DEFAULT_LAYOUT);
  useEffect(() => {
    let alive = true;
    let off: (() => void) | undefined;
    void shell.layout().then((l) => alive && setLayout(l)).catch(() => undefined);
    void shell.onLayout((l) => setLayout(l)).then((u) => (alive ? (off = u) : u()));
    return () => {
      alive = false;
      off?.();
    };
  }, []);
  return layout;
}

/** This window's entry in a layout (a fresh window may not be in it yet). */
export function myWindow(layout: ShellLayout, label = myLabel()): ShellWin | null {
  return layout.windows.find((w) => w.label === label) ?? null;
}
