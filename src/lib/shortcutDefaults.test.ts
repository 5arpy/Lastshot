/**
 * Built-in keys never fight: no combo twice in one tab, and no tab default
 * on an app-wide key. Every scope's key table is imported here; when a new
 * scope arrives (the editor's "editor" and "snip" keys), import its table
 * too and this test covers it.
 */
import { describe, expect, it } from "vitest";
import { allShortcuts, findClashes, splitKeys } from "./shortcuts";
import { APP_KEYS, APP_SCOPE } from "./appKeys";
import "../components/clipsKeys";
import "../viewer/keys";
import "../popout/frameKeys";

const defaults = () => allShortcuts().map((s) => ({ scope: s.scope, id: s.id, label: s.label, keys: s.defaultKeys }));

describe("default shortcuts", () => {
  it("covers every scope's table", () => {
    const scopes = new Set(allShortcuts().map((s) => s.scope));
    for (const s of [APP_SCOPE, "clips", "viewer", "frame"]) expect(scopes.has(s), s).toBe(true);
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
