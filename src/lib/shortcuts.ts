/**
 * In-app keyboard shortcuts: one registry per window.
 *
 * - Parts of the app register their keys for a scope ("global", "clips",
 *   "viewer", "frame", "editor", …) while they are on screen:
 *   `registerShortcuts(scope, list)` returns the function that removes them.
 * - The newest registration wins a key, so a viewer opened over the library
 *   gets its keys first, and the library gets them back when it closes.
 * - Keys never fire while typing in a text field (unless a shortcut says
 *   `inText`), and never when another handler already took the key.
 * - Users rebind or unbind any shortcut in Settings → Shortcuts. Overrides are
 *   kept in the app settings (`shortcuts`: "scope:id" → keys, "" = none) and
 *   handed in with `setShortcutOverrides`.
 * - `?` / F1 opens the cheat sheet, which lists what works right now.
 *
 * Key strings: modifiers first in the order Ctrl, Alt, Shift, Meta, then one
 * key: a letter (`R`), a digit, `F1`…`F24`, a name (`Enter`, `Escape`,
 * `Delete`, `Backspace`, `Space`, `Tab`, `Left`, `Right`, `Up`, `Down`,
 * `Home`, `End`, `PageUp`, `PageDown`, `Insert`) or a symbol (`?`, `[`, `+`).
 * Symbols are matched by the character typed, so `?` needs no `Shift+`.
 */

export interface Shortcut {
  /** "Ctrl+Shift+R", "F2", "?" … Several alternatives: "F1 | ?". */
  keys: string;
  /** Shown in the cheat sheet, Settings and tooltips. */
  label: string;
  /** Heading in the cheat sheet ("View", "Files", …). */
  group?: string;
  run: () => void;
  /** Extra condition; the key is ignored (and passes on) when false. */
  when?: () => boolean;
  /** Also fires while typing in a text field (Ctrl+Tab, Escape, …). */
  inText?: boolean;
  /** Stable id for rebinding; default: the label. */
  id?: string;
}

export interface ShortcutInfo {
  scope: string;
  id: string;
  label: string;
  group?: string;
  /** Keys as built in. */
  defaultKeys: string;
  /** Keys in effect (after the user's override). */
  keys: string;
  /** Registered and allowed right now in this window. */
  active: boolean;
}

interface Reg {
  scope: string;
  list: Shortcut[];
  seq: number;
}

let regs: Reg[] = [];
let seq = 0;
let overrides: Record<string, string> = {};
/** Every shortcut this window has seen (declared or registered), for Settings. */
const known = new Map<string, Omit<ShortcutInfo, "keys" | "active">>();
const disabledScopes = new Set<string>();
const listeners = new Set<() => void>();
let installed = false;

const notify = () => listeners.forEach((l) => l());

export const idOf = (s: { id?: string; label: string }) => s.id ?? s.label;
const keyOf = (scope: string, id: string) => `${scope}:${id}`;

// ------------------------------------------------------------------ combos

const NAMED: Record<string, string> = {
  arrowleft: "Left",
  arrowright: "Right",
  arrowup: "Up",
  arrowdown: "Down",
  left: "Left",
  right: "Right",
  up: "Up",
  down: "Down",
  esc: "Escape",
  escape: "Escape",
  enter: "Enter",
  return: "Enter",
  del: "Delete",
  delete: "Delete",
  backspace: "Backspace",
  space: "Space",
  " ": "Space",
  spacebar: "Space",
  tab: "Tab",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  pgup: "PageUp",
  pgdn: "PageDown",
  insert: "Insert",
  ins: "Insert",
  plus: "+",
  minus: "-",
};

const MOD_ORDER = ["Ctrl", "Alt", "Shift", "Meta"] as const;

/** Is `k` (a normalised key) a symbol typed with or without Shift? */
const isSymbol = (k: string) => k.length === 1 && !/[A-Z0-9]/.test(k);

function normKey(raw: string): string {
  const t = raw.trim();
  if (!t) return "";
  const named = NAMED[t.toLowerCase()];
  if (named) return named;
  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(t)) return t.toUpperCase();
  if (t.length === 1) return t.toUpperCase();
  return t[0].toUpperCase() + t.slice(1);
}

/** One combo ("ctrl + shift + r") in its standard spelling ("Ctrl+Shift+R"). */
export function normalizeCombo(combo: string): string {
  const s = combo.trim();
  if (!s) return "";
  // "Ctrl++" ends in a plus key.
  const parts = s.endsWith("++") ? [...s.slice(0, -2).split("+"), "+"] : s.split("+");
  const mods = new Set<string>();
  let key = "";
  for (const p of parts) {
    const l = p.trim().toLowerCase();
    if (l === "ctrl" || l === "control" || l === "cmdorctrl" || l === "commandorcontrol") mods.add("Ctrl");
    else if (l === "alt" || l === "option") mods.add("Alt");
    else if (l === "shift") mods.add("Shift");
    else if (l === "meta" || l === "win" || l === "super" || l === "cmd") mods.add("Meta");
    else if (p.trim() || p === "+") key = normKey(p.trim() || "+");
  }
  if (!key) return "";
  // Symbols carry their own Shift ("?" is Shift+/ on most layouts).
  if (isSymbol(key)) mods.delete("Shift");
  return [...MOD_ORDER.filter((m) => mods.has(m)), key].join("+");
}

/** "F1 | ?" → ["F1", "?"]. */
export function splitKeys(keys: string): string[] {
  return keys
    .split("|")
    .map(normalizeCombo)
    .filter(Boolean);
}

/** The combo a key event stands for, in the same spelling; "" for a bare modifier. */
export function comboFromEvent(e: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">): string {
  const k = e.key;
  if (k === "Control" || k === "Alt" || k === "Shift" || k === "Meta" || k === "AltGraph" || k === "CapsLock" || k === "Dead" || k === "Unidentified") return "";
  let key: string;
  // Letters and digits by position, so Ctrl+Shift+1 and other layouts work.
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
  else if (/^Numpad[0-9]$/.test(e.code)) key = e.code.slice(6);
  else if (e.code === "NumpadAdd") key = "+";
  else if (e.code === "NumpadSubtract") key = "-";
  else key = normKey(k);
  if (!key) return "";
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey && !isSymbol(key)) mods.push("Shift");
  if (e.metaKey) mods.push("Meta");
  return [...mods, key].join("+");
}

// ------------------------------------------------------------------ registry

/** The keys in effect for a shortcut (the user's override, else its own). */
export function effectiveKeys(scope: string, s: Pick<Shortcut, "keys" | "label" | "id">): string {
  const o = overrides[keyOf(scope, idOf(s))];
  return o !== undefined ? o : s.keys;
}

function remember(scope: string, s: Pick<Shortcut, "keys" | "label" | "id" | "group">) {
  const id = idOf(s);
  const k = keyOf(scope, id);
  const old = known.get(k);
  if (!old || old.defaultKeys !== s.keys || old.label !== s.label || old.group !== s.group) {
    known.set(k, { scope, id, label: s.label, group: s.group, defaultKeys: s.keys });
    return true;
  }
  return false;
}

/**
 * Adds `list` for `scope` until the returned function is called. Later
 * registrations take a key before earlier ones.
 */
export function registerShortcuts(scope: string, list: Shortcut[]): () => void {
  install();
  const reg: Reg = { scope, list, seq: ++seq };
  regs.push(reg);
  list.forEach((s) => remember(scope, s));
  notify();
  return () => {
    regs = regs.filter((r) => r !== reg);
    notify();
  };
}

/** Makes shortcuts known to Settings and the cheat sheet without running them here. */
export function declareShortcuts(scope: string, list: Pick<Shortcut, "keys" | "label" | "id" | "group">[]): void {
  let changed = false;
  list.forEach((s) => (changed = remember(scope, s) || changed));
  if (changed) notify();
}

/** Turns a whole scope off or on (e.g. while a modal owns the keyboard). */
export function setScopeEnabled(scope: string, on: boolean): void {
  const had = disabledScopes.has(scope);
  if (on) disabledScopes.delete(scope);
  else disabledScopes.add(scope);
  if (had === on) notify();
}

/** The user's rebindings ("scope:id" → keys; "" = no key). */
export function setShortcutOverrides(map: Record<string, string> | null | undefined): void {
  const next = { ...(map ?? {}) };
  if (JSON.stringify(next) === JSON.stringify(overrides)) return;
  overrides = next;
  notify();
}

export function getShortcutOverrides(): Record<string, string> {
  return { ...overrides };
}

/** Calls `l` whenever shortcuts are added, removed or rebound. */
export function onShortcutsChange(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

const usable = (r: Reg, s: Shortcut) => !disabledScopes.has(r.scope) && (!s.when || safeWhen(s.when));
function safeWhen(w: () => boolean): boolean {
  try {
    return w();
  } catch {
    return false;
  }
}

/** Everything known, for Settings: built-in keys, the keys in effect, active now. */
export function allShortcuts(): ShortcutInfo[] {
  const activeIds = new Set<string>();
  for (const r of regs) for (const s of r.list) if (usable(r, s)) activeIds.add(keyOf(r.scope, idOf(s)));
  return [...known.values()].map((k) => ({
    ...k,
    keys: overrides[keyOf(k.scope, k.id)] ?? k.defaultKeys,
    active: activeIds.has(keyOf(k.scope, k.id)),
  }));
}

/** What works right now (newest first, one entry per shortcut), with a way to run it. */
export function activeShortcuts(): (ShortcutInfo & { run: () => void })[] {
  const out: (ShortcutInfo & { run: () => void })[] = [];
  const seen = new Set<string>();
  for (const r of [...regs].sort((a, b) => b.seq - a.seq)) {
    for (const s of r.list) {
      const k = keyOf(r.scope, idOf(s));
      if (seen.has(k) || !usable(r, s)) continue;
      seen.add(k);
      out.push({ scope: r.scope, id: idOf(s), label: s.label, group: s.group, defaultKeys: s.keys, keys: effectiveKeys(r.scope, s), active: true, run: s.run });
    }
  }
  return out;
}

/** "Rotate (R)": a label with the keys in effect, for tooltips. */
export function withKeys(label: string, scope: string, id: string): string {
  const k = known.get(keyOf(scope, id));
  const keys = overrides[keyOf(scope, id)] ?? k?.defaultKeys ?? "";
  const first = splitKeys(keys)[0];
  return first ? `${label} (${first})` : label;
}

/**
 * Other shortcuts that already use `combo` where `scope` is used: the same
 * scope or "global" (a global key and a scope key would fight).
 */
export function conflictsFor(scope: string, id: string, combo: string): ShortcutInfo[] {
  const c = normalizeCombo(combo);
  if (!c) return [];
  return allShortcuts().filter(
    (s) =>
      !(s.scope === scope && s.id === id) &&
      (s.scope === scope || s.scope === "global" || scope === "global") &&
      splitKeys(s.keys).includes(c),
  );
}

// ------------------------------------------------------------------ dispatch

export const isTextField = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
  if (el.tagName !== "INPUT") return false;
  const type = (el as HTMLInputElement).type;
  return !["checkbox", "radio", "range", "button", "submit", "reset", "color", "file"].includes(type);
};

/** Runs the shortcut for this key event, if any. Exported for tests. */
export function dispatchKey(e: KeyboardEvent): boolean {
  if (e.defaultPrevented && !(e as KeyboardEvent & { __lsGuard?: boolean }).__lsGuard) return false;
  if (e.isComposing) return false;
  const combo = comboFromEvent(e);
  if (!combo) return false;
  const typing = isTextField(e.target);
  for (const r of [...regs].sort((a, b) => b.seq - a.seq)) {
    if (disabledScopes.has(r.scope)) continue;
    for (const s of r.list) {
      if (typing && !s.inText) continue;
      if (!splitKeys(effectiveKeys(r.scope, s)).includes(combo)) continue;
      if (s.when && !safeWhen(s.when)) continue;
      e.preventDefault();
      e.stopPropagation();
      try {
        s.run();
      } catch (err) {
        console.error(`[shortcuts] ${r.scope}/${idOf(s)}`, err);
      }
      return true;
    }
  }
  return false;
}

function install() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("keydown", (e) => void dispatchKey(e));
}

/** Test helper: forget everything. */
export function _resetShortcuts(): void {
  regs = [];
  overrides = {};
  known.clear();
  disabledScopes.clear();
}
