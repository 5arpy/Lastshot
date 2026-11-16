import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetShortcuts,
  activeShortcuts,
  allShortcuts,
  comboFromEvent,
  conflictsFor,
  declareShortcuts,
  dispatchKey,
  normalizeCombo,
  registerShortcuts,
  setScopeEnabled,
  setShortcutOverrides,
  splitKeys,
  withKeys,
} from "./shortcuts";

type Ev = Partial<KeyboardEvent> & { key: string; code?: string };
const ev = (e: Ev, target: unknown = null) => {
  const out = {
    code: "",
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    isComposing: false,
    defaultPrevented: false,
    target,
    prevented: false,
    stopped: false,
    preventDefault() {
      out.prevented = true;
      out.defaultPrevented = true;
    },
    stopPropagation() {
      out.stopped = true;
    },
    ...e,
  };
  return out as unknown as KeyboardEvent & { prevented: boolean };
};

beforeEach(() => _resetShortcuts());

describe("combos", () => {
  it("normalises spellings", () => {
    expect(normalizeCombo("shift + ctrl + r")).toBe("Ctrl+Shift+R");
    expect(normalizeCombo("Control+Alt+delete")).toBe("Ctrl+Alt+Delete");
    expect(normalizeCombo("ArrowLeft")).toBe("Left");
    expect(normalizeCombo("f12")).toBe("F12");
    expect(normalizeCombo("Ctrl++")).toBe("Ctrl++");
    expect(normalizeCombo("Shift+?")).toBe("?");
    expect(normalizeCombo("esc")).toBe("Escape");
    expect(normalizeCombo("+")).toBe("+");
    expect(splitKeys("= | +")).toEqual(["=", "+"]);
    expect(splitKeys("F1 | ?")).toEqual(["F1", "?"]);
  });

  it("reads events by key position for letters and digits", () => {
    expect(comboFromEvent({ key: "r", code: "KeyR", ctrlKey: true, altKey: false, shiftKey: false, metaKey: false })).toBe("Ctrl+R");
    // Shift+1 types "!" but is still Ctrl+Shift+1.
    expect(comboFromEvent({ key: "!", code: "Digit1", ctrlKey: true, altKey: false, shiftKey: true, metaKey: false })).toBe("Ctrl+Shift+1");
    expect(comboFromEvent({ key: "?", code: "Slash", ctrlKey: false, altKey: false, shiftKey: true, metaKey: false })).toBe("?");
    expect(comboFromEvent({ key: "ArrowUp", code: "ArrowUp", ctrlKey: false, altKey: true, shiftKey: false, metaKey: false })).toBe("Alt+Up");
    expect(comboFromEvent({ key: "Shift", code: "ShiftLeft", ctrlKey: false, altKey: false, shiftKey: true, metaKey: false })).toBe("");
  });
});

describe("dispatch", () => {
  it("runs the newest registration first and gives keys back when it goes", () => {
    const log: string[] = [];
    registerShortcuts("clips", [{ keys: "Delete", label: "Delete", run: () => log.push("clips") }]);
    const off = registerShortcuts("viewer", [{ keys: "Delete", label: "Delete frame", run: () => log.push("viewer") }]);
    dispatchKey(ev({ key: "Delete", code: "Delete" }));
    off();
    dispatchKey(ev({ key: "Delete", code: "Delete" }));
    expect(log).toEqual(["viewer", "clips"]);
  });

  it("a tab's own key wins over an app-wide one on the same combo", () => {
    const log: string[] = [];
    registerShortcuts("clips", [{ keys: "F1", label: "Refresh", run: () => log.push("clips") }]);
    const off = registerShortcuts("global", [{ keys: "F1", label: "Keys", run: () => log.push("global") }]);
    dispatchKey(ev({ key: "F1", code: "F1" }));
    setScopeEnabled("clips", false);
    dispatchKey(ev({ key: "F1", code: "F1" }));
    off();
    expect(log).toEqual(["clips", "global"]);
  });

  it("never fires while typing unless allowed", () => {
    const log: string[] = [];
    registerShortcuts("clips", [
      { keys: "R", label: "Rotate", run: () => log.push("r") },
      { keys: "Ctrl+Tab", label: "Next tab", run: () => log.push("tab"), inText: true },
    ]);
    const input = { tagName: "INPUT", type: "text", isContentEditable: false };
    expect(dispatchKey(ev({ key: "r", code: "KeyR" }, input))).toBe(false);
    expect(dispatchKey(ev({ key: "Tab", code: "Tab", ctrlKey: true }, input))).toBe(true);
    // A checkbox is not a text field.
    expect(dispatchKey(ev({ key: "r", code: "KeyR" }, { tagName: "INPUT", type: "checkbox" }))).toBe(true);
    expect(log).toEqual(["tab", "r"]);
  });

  it("skips keys someone else took, `when` false and disabled scopes", () => {
    let n = 0;
    let ok = false;
    registerShortcuts("a", [{ keys: "X", label: "x", run: () => n++, when: () => ok }]);
    expect(dispatchKey(ev({ key: "x", code: "KeyX" }))).toBe(false);
    ok = true;
    const taken = ev({ key: "x", code: "KeyX" });
    taken.preventDefault();
    expect(dispatchKey(taken)).toBe(false);
    setScopeEnabled("a", false);
    expect(dispatchKey(ev({ key: "x", code: "KeyX" }))).toBe(false);
    setScopeEnabled("a", true);
    const e = ev({ key: "x", code: "KeyX" });
    expect(dispatchKey(e)).toBe(true);
    expect(e.prevented).toBe(true);
    expect(n).toBe(1);
  });

  it("follows the user's rebinding and unbinding", () => {
    const log: string[] = [];
    registerShortcuts("viewer", [{ keys: "R", label: "Rotate", id: "rotate", run: () => log.push("rot") }]);
    setShortcutOverrides({ "viewer:rotate": "Shift+R" });
    dispatchKey(ev({ key: "r", code: "KeyR" }));
    dispatchKey(ev({ key: "R", code: "KeyR", shiftKey: true }));
    setShortcutOverrides({ "viewer:rotate": "" });
    dispatchKey(ev({ key: "R", code: "KeyR", shiftKey: true }));
    expect(log).toEqual(["rot"]);
    expect(withKeys("Rotate", "viewer", "rotate")).toBe("Rotate");
    setShortcutOverrides({});
    expect(withKeys("Rotate", "viewer", "rotate")).toBe("Rotate (R)");
  });
});

describe("lists and conflicts", () => {
  it("knows declared and registered shortcuts, and what is active", () => {
    declareShortcuts("editor", [{ keys: "S", label: "Split" }]);
    registerShortcuts("global", [{ keys: "F1 | ?", label: "Shortcuts", run: () => undefined }]);
    const all = allShortcuts();
    expect(all.map((s) => `${s.scope}/${s.id}/${s.active}`).sort()).toEqual(["editor/Split/false", "global/Shortcuts/true"]);
    expect(activeShortcuts().map((s) => s.label)).toEqual(["Shortcuts"]);
  });

  it("finds clashes in the same scope and with global keys", () => {
    declareShortcuts("global", [{ keys: "Ctrl+1", label: "First tab" }]);
    declareShortcuts("clips", [
      { keys: "F2", label: "Rename" },
      { keys: "Delete", label: "Delete" },
    ]);
    declareShortcuts("viewer", [{ keys: "F2", label: "Something" }]);
    expect(conflictsFor("clips", "Delete", "f2").map((s) => s.id)).toEqual(["Rename"]);
    expect(conflictsFor("clips", "Rename", "ctrl+1").map((s) => s.id)).toEqual(["First tab"]);
    expect(conflictsFor("clips", "Rename", "F2")).toEqual([]);
  });
});
