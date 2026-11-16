/**
 * Built-in keys never fight: no combo twice in one tab (in one context), and
 * no tab default on an app-wide key. Every scope's key table is imported here;
 * a new scope imports its table too and this test covers it.
 */
import { describe, expect, it } from "vitest";
import { allShortcuts, findClashes, splitKeys } from "./shortcuts";
import { APP_KEYS, APP_SCOPE } from "./appKeys";
import "../components/clipsKeys";
import "../viewer/keys";
import "../popout/frameKeys";
import { EDITOR_KEYS, SNIP_KEYS } from "../editor/keyTables";

const defaults = () => allShortcuts().map((s) => ({ scope: s.scope, id: s.id, label: s.label, keys: s.defaultKeys, context: s.context, mouse: s.mouse }));

describe("default shortcuts", () => {
  it("covers every scope's table", () => {
    const scopes = new Set(allShortcuts().map((s) => s.scope));
    for (const s of [APP_SCOPE, "clips", "viewer", "frame", "editor", "snip"]) expect(scopes.has(s), s).toBe(true);
    expect(EDITOR_KEYS.length).toBeGreaterThan(80);
    expect(SNIP_KEYS.length).toBeGreaterThan(20);
  });

  it("have no clashes (same tab, or a tab on an app-wide key)", () => {
    const clashes = findClashes(defaults(), APP_SCOPE).map((c) => `${c.combo}: ${c.a.scope}/${c.a.id} vs ${c.b.scope}/${c.b.id}`);
    expect(clashes).toEqual([]);
  });

  it("app-wide keys are standards or three-key Ctrl+Shift combos (no Ctrl+Alt+letter)", () => {
    const standard = /^(F1|\?|Ctrl\+[1-9]|Ctrl\+(Shift\+)?Tab|Ctrl\+Page(Up|Down)|Ctrl\+\+|Ctrl\+_)$/;
    for (const k of APP_KEYS)
      for (const c of splitKeys(k.keys)) {
        expect(/^Ctrl\+Alt\+[A-Z]$/.test(c), `${k.id}: ${c}`).toBe(false);
        expect(standard.test(c) || /^Ctrl\+Shift\+[A-Z0-9]$/.test(c), `${k.id}: ${c}`).toBe(true);
      }
  });

  it("reads the editor's and snip's tables in the registry's spelling", () => {
    const ed = (label: string) => EDITOR_KEYS.find((s) => s.label === label);
    expect(ed("Split at playhead")?.keys).toBe("S | C | Ctrl+K | Ctrl+B");
    expect(ed("Bring to front")?.keys).toBe("Ctrl+}");
    expect(ed("Nudge right ten frames")?.keys).toBe(">");
    expect(ed("Zoom in")?.keys).toBe("= | +");
    expect(ed("Nudge left 1 px")).toMatchObject({ keys: "Left", context: "object" });
    expect(ed("Back one frame")?.context).toBeUndefined();
    expect(ed("Detach audio")?.keys).toBe("Ctrl+Shift+D");
    expect(SNIP_KEYS.find((s) => s.label === "Open in the editor")?.keys).toBe("Ctrl+E");
    for (const list of [EDITOR_KEYS, SNIP_KEYS]) expect(new Set(list.map((s) => s.id)).size).toBe(list.length);
    // The same key in two contexts of one tab is fine; in one context it is a clash.
    const c = findClashes([
      { scope: "editor", id: "a", label: "A", keys: "Left" },
      { scope: "editor", id: "b", label: "B", keys: "Left", context: "object" },
      { scope: "editor", id: "c", label: "C", keys: "Left", context: "object" },
    ]);
    expect(c.map((x) => [x.a.id, x.b.id])).toEqual([["b", "c"]]);
  });

  it("finds clashes when there are some", () => {
    const c = findClashes([
      { scope: "global", id: "a", label: "A", keys: "Ctrl+Shift+U" },
      { scope: "clips", id: "b", label: "B", keys: "ctrl+shift+u" },
      { scope: "clips", id: "c", label: "C", keys: "F2" },
      { scope: "clips", id: "d", label: "D", keys: "F2 | F3" },
      { scope: "viewer", id: "e", label: "E", keys: "F3" },
    ]);
    expect(c.map((x) => [x.combo, x.kind])).toEqual([
      ["Ctrl+Shift+U", "app-wide"],
      ["F2", "same-scope"],
    ]);
  });
});
