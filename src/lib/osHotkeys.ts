/**
 * The Windows-wide hotkeys: Windows hands them to Lastshot first, even inside
 * full-screen games. One list for Settings and Settings › Shortcuts, and the
 * check that two of them never share keys.
 */
import type { AppSettings } from "./types";
import { normalizeCombo } from "./shortcuts";

export const OS_HOTKEYS = [
  { field: "hotkeySave", action: "save", label: "Save a replay" },
  { field: "hotkeyRecord", action: "record", label: "Start / stop screen recording" },
  { field: "hotkeyPause", action: "pause", label: "Pause / resume recording" },
  { field: "hotkeySnip", action: "snip", label: "Take a screenshot" },
  { field: "hotkeyToggle", action: "toggle", label: "Instant replay on / off" },
] as const;

export type OsHotkey = (typeof OS_HOTKEYS)[number];
export type OsHotkeyField = OsHotkey["field"];
export type OsHotkeyAction = OsHotkey["action"];

/** An accelerator ("Alt+Shift+R", "Win+F9") in the shortcut registry's spelling. */
export const osCombo = (accel: string) => normalizeCombo(accel.replace(/\bWin\b/g, "Meta"));

/** The other Windows-wide hotkey that already uses `accel`, or null. */
export function osHotkeyClash(
  values: Partial<Pick<AppSettings, OsHotkeyField>>,
  field: OsHotkeyField,
  accel: string,
): OsHotkey | null {
  const c = osCombo(accel);
  if (!c) return null;
  return OS_HOTKEYS.find((o) => o.field !== field && !!values[o.field] && osCombo(values[o.field]!) === c) ?? null;
}
