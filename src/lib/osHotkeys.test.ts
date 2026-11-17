/**
 * The Windows-wide hotkeys never share keys: not by default, and Settings
 * refuses a second use. Windows hands them to Lastshot before any window, so
 * no built-in in-app key may sit on one either.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./bridge";
import { OS_HOTKEYS, osCombo, osHotkeyClash } from "./osHotkeys";
import { allShortcuts, splitKeys } from "./shortcuts";
import "../components/clipsKeys";
import "../viewer/keys";
import "../popout/frameKeys";
import "../editor/keyTables";

describe("Windows-wide hotkeys", () => {
  it("every one has a default, and no two defaults share keys", () => {
    const combos = OS_HOTKEYS.map((o) => osCombo(DEFAULT_SETTINGS[o.field]));
    for (const c of combos) expect(c).not.toBe("");
    expect(new Set(combos).size).toBe(combos.length);
    expect(DEFAULT_SETTINGS.hotkeyPause).toBe("Alt+Shift+R");
  });

  it("no built-in in-app key uses one", () => {
    const os = new Set(OS_HOTKEYS.map((o) => osCombo(DEFAULT_SETTINGS[o.field])));
    const hits = allShortcuts().flatMap((s) => splitKeys(s.defaultKeys).filter((k) => os.has(k)).map((k) => `${s.scope}/${s.id}: ${k}`));
    expect(hits).toEqual([]);
  });

  it("finds the other hotkey that has the keys", () => {
    const v = { ...DEFAULT_SETTINGS };
    expect(osHotkeyClash(v, "hotkeyPause", "Alt+R")?.field).toBe("hotkeyRecord");
    expect(osHotkeyClash(v, "hotkeyRecord", "shift+alt+r")?.field).toBe("hotkeyPause");
    expect(osHotkeyClash(v, "hotkeySnip", "Alt+Shift+C")?.label).toBe("Instant replay on / off");
    // Its own keys, new keys, and empty values are fine.
    expect(osHotkeyClash(v, "hotkeyPause", "Alt+Shift+R")).toBeNull();
    expect(osHotkeyClash(v, "hotkeyPause", "Ctrl+Alt+P")).toBeNull();
    expect(osHotkeyClash({ hotkeyRecord: "" }, "hotkeyPause", "Alt+R")).toBeNull();
    // Win and Meta are the same key.
    expect(osHotkeyClash({ hotkeySave: "Win+F9" }, "hotkeyPause", "Meta+F9")?.field).toBe("hotkeySave");
  });
});
