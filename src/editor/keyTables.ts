/**
 * The editor's and the snip's keys in the app-wide registry (scopes "editor"
 * and "snip"), so Settings → Shortcuts, the cheat sheet (F1), the command
 * list (Ctrl+Shift+P) and the clash test see them and rebinding applies.
 *
 * `keys.ts` writes one key per entry, with aliases as extra entries of the
 * same label; here each action becomes one entry carrying all its keys
 * ("S | C | Ctrl+K | Ctrl+B"), with an id that stays the same between runs.
 */
import { comboFromEvent, declareShortcuts, effectiveKeys, isTextField, normalizeCombo, splitKeys, type Shortcut as Reg } from "../lib/shortcuts";
import { editorKeymap, snipKeymap, type EditorActions, type Shortcut, type SnipActions } from "./keys";

/** What Shift turns a symbol key into (US layout), the way key presses arrive. */
const SHIFTED: Record<string, string> = { ",": "<", ".": ">", "[": "{", "]": "}", "=": "+", "-": "_", ";": ":", "'": '"', "/": "?", "`": "~" };

/** One `keys.ts` binding in the registry's spelling: "Ctrl+Shift+]" arrives as "Ctrl+}", "ArrowLeft" is "Left". */
export function regCombo(keys: string): string {
  const plus = keys === "+" || keys.endsWith("++");
  const parts = (plus ? keys.slice(0, -1) : keys)
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  const key = plus ? "+" : (parts.pop() ?? "");
  const shift = parts.some((p) => p.toLowerCase() === "shift");
  return normalizeCombo([...parts, shift && SHIFTED[key] ? SHIFTED[key] : key].join("+"));
}

/** Registry entries from a `keys.ts` list: one per action (label, group, context), all its keys. */
export function toRegistry(list: Shortcut[]): Reg[] {
  const out: Reg[] = [];
  const byAction = new Map<string, Reg>();
  for (const s of list) {
    const k = `${s.group ?? ""}\u0001${s.label}\u0001${s.context ?? ""}`;
    const combo = s.mouse ? s.keys : regCombo(s.keys);
    const hit = byAction.get(k);
    if (hit) {
      if (combo && !splitKeys(hit.keys).includes(combo)) hit.keys = `${hit.keys} | ${combo}`;
      continue;
    }
    const e: Reg = { id: s.id.replace(/^[a-z]+\./, ""), keys: combo, label: s.label, group: s.group, run: s.run, when: s.when, context: s.context, mouse: s.mouse };
    byAction.set(k, e);
    out.push(e);
  }
  return out;
}

const noop = () => undefined;
const stub = <T extends object>() => new Proxy({} as T, { get: () => noop });

/** The editor's keys as built in (for Settings while the Editor tab is closed, and the tests). */
export const EDITOR_KEYS = toRegistry(editorKeymap(stub<EditorActions>()));
/** The snip's keys as built in. */
export const SNIP_KEYS = toRegistry(snipKeymap(stub<SnipActions>()));
declareShortcuts("editor", EDITOR_KEYS);
declareShortcuts("snip", SNIP_KEYS);

/** The first entry that takes this key press now, with the user's keys (never while typing). */
export function matchKey(scope: string, list: Reg[], e: KeyboardEvent): Reg | null {
  if (isTextField(e.target)) return null;
  const c = comboFromEvent(e);
  if (!c) return null;
  for (const s of list) {
    if (s.mouse || !splitKeys(effectiveKeys(scope, s)).includes(c)) continue;
    if (s.when && !s.when()) continue;
    return s;
  }
  return null;
}

const PRETTY: Record<string, string> = { Left: "←", Right: "→", Up: "↑", Down: "↓" };
const pretty = (combo: string) => combo.replace(/\b(Left|Right|Up|Down)$/, (m) => PRETTY[m]);

/** The key in effect for an action, by its label ("" when it has none). */
export function keyOfLabel(scope: string, list: Reg[], label: string): string {
  const s = list.find((x) => x.label === label);
  const first = s ? splitKeys(effectiveKeys(scope, s))[0] : undefined;
  return first ? pretty(first) : "";
}

/** The key in effect for an action whose built-in keys include `builtIn` (menus show it). */
export function keyOfDefault(scope: string, list: Reg[], builtIn: string): string {
  const c = regCombo(builtIn);
  const s = list.find((x) => splitKeys(x.keys).includes(c));
  if (!s) return builtIn;
  const now = splitKeys(effectiveKeys(scope, s));
  return now.includes(c) ? builtIn : now[0] ? pretty(now[0]) : "";
}

/** "Split (S)": a label with the key in effect, for tooltips. */
export function keyTip(scope: string, list: Reg[], label: string, text?: string): string {
  const k = keyOfLabel(scope, list, label);
  return `${text ?? label}${k ? ` (${k})` : ""}`;
}
