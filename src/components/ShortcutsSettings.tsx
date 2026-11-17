/**
 * Settings → Shortcuts: every key in one place.
 *
 * - Chips pick a tab (App-wide, Clips, Viewer, Frames, Editor, Snip) or the
 *   Windows-wide hotkeys; "All" lists everything, grouped by tab.
 * - Search by name, or press "Press a key" and then a key: the list shows
 *   what that key does in every tab ("what does Ctrl+D do?").
 * - A keyboard map for the chosen tab: keys this tab uses, app-wide keys,
 *   Windows-wide hotkeys, and clashes in red. Ctrl / Shift / Alt (buttons,
 *   or just hold them) show those layers. Click a key to see its uses.
 * - Click a key on a row to record a new one (Escape cancels). A key that is
 *   taken asks: Replace, Keep both (only across tabs: the tab's own key wins
 *   inside that tab) or Cancel. Reset per action, per tab, or all.
 */
import { useEffect, useMemo, useState } from "react";
import type { AppSettings } from "../lib/types";
import { DEFAULT_SETTINGS } from "../lib/bridge";
import { acceleratorFromEvent } from "../lib/accelerator";
import { APP_SCOPE } from "../lib/appKeys";
import {
  allShortcuts,
  comboFromEvent,
  conflictsFor,
  findClashes,
  normalizeCombo,
  onShortcutsChange,
  splitKeys,
  type ShortcutInfo,
} from "../lib/shortcuts";
// Every tab's key table, so Settings lists tabs that are not open in this window.
import "./clipsKeys";
import "../viewer/keys";
import "../popout/frameKeys";
import "../editor/keyTables";
import { cn } from "../utils/cn";
import { Keys } from "./ShortcutsOverlay";
import { OS_HOTKEYS, osCombo, type OsHotkeyField } from "../lib/osHotkeys";

const MODIFIER_KEYS = new Set(["Control", "Alt", "Shift", "Meta", "CapsLock", "NumLock", "ScrollLock", "AltGraph"]);
const ORDER = [APP_SCOPE, "clips", "viewer", "frame", "editor", "snip"];
const CHIP_NAMES: Record<string, string> = {
  all: "All",
  [APP_SCOPE]: "App-wide",
  clips: "Clips",
  viewer: "Viewer",
  frame: "Frames",
  editor: "Editor",
  snip: "Snip",
  os: "Windows-wide",
};
const chipName = (s: string) => CHIP_NAMES[s] ?? s.charAt(0).toUpperCase() + s.slice(1);
const rank = (s: string) => {
  const i = ORDER.indexOf(s);
  return i < 0 ? ORDER.length : i;
};

/** The global hotkeys: Windows hands them to Lastshot first, even in games. */
const OS_KEYS = OS_HOTKEYS;
type OsField = OsHotkeyField;

const keyOf = (s: { scope: string; id: string }) => `${s.scope}:${s.id}`;

/** A clash in effect: two uses of one combo that fight. */
interface Clash {
  combo: string;
  a: { scope: string; id: string; label: string };
  b: { scope: string; id: string; label: string };
}

type Cell = { label: string; key: string; shifted?: string; w?: number };
const sym = (key: string, shifted: string): Cell => ({ label: key, key, shifted });
const plain = (s: string): Cell[] => s.split("").map((k) => ({ label: k, key: k }));
const KEYBOARD: Cell[][] = [
  [{ label: "Esc", key: "Escape" }, ...Array.from({ length: 12 }, (_, i) => ({ label: `F${i + 1}`, key: `F${i + 1}` }))],
  [sym("`", "~"), ...plain("1234567890"), sym("-", "_"), sym("=", "+"), { label: "⌫", key: "Backspace", w: 2 }],
  [{ label: "Tab", key: "Tab", w: 1.5 }, ...plain("QWERTYUIOP"), sym("[", "{"), sym("]", "}")],
  [...plain("ASDFGHJKL"), sym(";", ":"), sym("'", '"'), { label: "Enter", key: "Enter", w: 2 }],
  [...plain("ZXCVBNM"), sym(",", "<"), sym(".", ">"), sym("/", "?")],
  [
    { label: "Space", key: "Space", w: 4 },
    { label: "←", key: "Left" },
    { label: "↑", key: "Up" },
    { label: "↓", key: "Down" },
    { label: "→", key: "Right" },
    { label: "Ins", key: "Insert" },
    { label: "Del", key: "Delete" },
    { label: "Home", key: "Home", w: 1.5 },
    { label: "End", key: "End" },
    { label: "PgUp", key: "PageUp", w: 1.5 },
    { label: "PgDn", key: "PageDown", w: 1.5 },
  ],
];

interface Mods {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

/** The combo a map key stands for with these modifiers (symbols carry their own Shift). */
function cellCombo(c: Cell, m: Mods): string {
  const symbol = !!c.shifted;
  const key = symbol && m.shift ? c.shifted! : c.key;
  const parts = [m.ctrl && "Ctrl", m.alt && "Alt", m.shift && !symbol && "Shift", key].filter(Boolean);
  return normalizeCombo(parts.join("+"));
}

type Problem = {
  /** The row ("scope:id", or "os:field") the key was meant for. */
  key: string;
  combo: string;
  add: boolean;
  text: string;
  others: ShortcutInfo[];
  /** Every other use is in a different tab, so both may keep it. */
  canKeepBoth: boolean;
};

export default function ShortcutsSettings({
  settings,
  onChange,
}: {
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
}) {
  const [ver, setVer] = useState(0);
  useEffect(() => onShortcutsChange(() => setVer((v) => v + 1)), []);
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<string>("all");
  /** "What does this key do?": the combo searched for, or null. */
  const [keyQ, setKeyQ] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [mods, setMods] = useState<Mods>({ ctrl: false, shift: false, alt: false });
  /** Recording a key for this row ("add" keeps the old keys). */
  const [rec, setRec] = useState<{ key: string; add: boolean } | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const overrides = useMemo(() => settings.shortcuts ?? {}, [settings.shortcuts]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const all = useMemo(() => allShortcuts(), [ver, overrides]);
  const scopes = useMemo(() => [...new Set(all.map((s) => s.scope))].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)), [all]);
  const osHotkeys = useMemo(
    () =>
      OS_KEYS.map((o) => ({ ...o, value: (settings[o.field] as string) || "", combo: osCombo((settings[o.field] as string) || "") })).filter(
        (o) => !!o.value,
      ),
    [settings],
  );

  // Clashes in effect: same tab, a tab on an app-wide key, or a key a Windows-wide hotkey takes first.
  const clashes: Clash[] = useMemo(() => {
    const out: Clash[] = findClashes(all, APP_SCOPE);
    for (const o of osHotkeys)
      for (const s of all)
        if (splitKeys(s.keys).includes(o.combo))
          out.push({ combo: o.combo, a: { scope: "os", id: o.field, label: o.label }, b: { scope: s.scope, id: s.id, label: s.label } });
    return out;
  }, [all, osHotkeys]);
  const clashesOf = (k: string) => clashes.filter((c) => keyOf(c.a) === k || keyOf(c.b) === k);
  const clashCount = (scope: string) =>
    scope === "all" ? clashes.length : clashes.filter((c) => c.a.scope === scope || c.b.scope === scope).length;

  const words = useMemo(() => q.toLowerCase().split(/\s+/).filter(Boolean), [q]);
  const rows = useMemo(() => {
    let list: ShortcutInfo[];
    if (keyQ) list = all.filter((s) => splitKeys(s.keys).includes(keyQ));
    else if (words.length)
      list = all.filter((s) => {
        const hay = `${s.label} ${s.keys} ${s.group ?? ""} ${chipName(s.scope)}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      });
    else if (tab === "all") list = all;
    else if (tab === "os") list = [];
    else list = all.filter((s) => s.scope === tab);
    return [...list].sort(
      (a, b) => rank(a.scope) - rank(b.scope) || a.scope.localeCompare(b.scope) || (a.group ?? "").localeCompare(b.group ?? ""),
    );
  }, [all, words, tab, keyQ]);
  const osRows = useMemo(() => {
    if (keyQ) return osHotkeys.filter((o) => o.combo === keyQ);
    if (words.length) return osHotkeys.filter((o) => words.every((w) => `${o.label} ${o.value} windows`.toLowerCase().includes(w)));
    return tab === "all" || tab === "os" ? osHotkeys : [];
  }, [osHotkeys, words, tab, keyQ]);

  const save = (next: Record<string, string>) => onChange({ shortcuts: next });
  const put = (next: Record<string, string>, s: ShortcutInfo, keys: string[]) => {
    const value = keys.join(" | ");
    if (value === s.defaultKeys) delete next[keyOf(s)];
    else next[keyOf(s)] = value;
  };

  /** Gives `combo` to `s`. "ask" stops at a clash; "replace" takes it from the others; "both" leaves them. */
  const apply = (s: ShortcutInfo, combo: string, add: boolean, mode: "ask" | "replace" | "both" = "ask") => {
    const c = normalizeCombo(combo);
    if (!c) return;
    const hot = osHotkeys.find((o) => o.combo === c);
    if (hot) {
      setProblem({
        key: keyOf(s),
        combo: c,
        add,
        text: `'${c}' is already the Windows-wide hotkey for ${hot.label}; Windows gives it to Lastshot first, so pick another key`,
        others: [],
        canKeepBoth: false,
      });
      return;
    }
    const others = conflictsFor(s.scope, s.id, c);
    if (others.length && mode === "ask") {
      const names = others.map((o) => `${o.label}${o.scope !== s.scope ? ` (${chipName(o.scope)})` : ""}`).join(", ");
      setProblem({
        key: keyOf(s),
        combo: c,
        add,
        text: `'${c}' is already the shortcut for ${names}`,
        others,
        canKeepBoth: others.every((o) => o.scope !== s.scope),
      });
      return;
    }
    const next = { ...overrides };
    if (mode === "replace") for (const o of others) put(next, o, splitKeys(o.keys).filter((k) => k !== c));
    put(next, s, add ? [...splitKeys(s.keys).filter((k) => k !== c), c] : [c]);
    save(next);
    setProblem(null);
  };

  /** A Windows-wide hotkey. App keys on the same combo lose it on Replace (Windows takes it first anyway). */
  const applyOs = (field: OsField, accel: string, mode: "ask" | "replace" = "ask") => {
    const c = osCombo(accel);
    const label = OS_KEYS.find((o) => o.field === field)!.label;
    const otherOs = osHotkeys.find((o) => o.field !== field && o.combo === c);
    if (otherOs) {
      setProblem({
        key: `os:${field}`,
        combo: accel,
        add: false,
        text: `'${accel}' is already the Windows-wide hotkey for ${otherOs.label}`,
        others: [],
        canKeepBoth: false,
      });
      return;
    }
    const others = all.filter((s) => splitKeys(s.keys).includes(c));
    if (others.length && mode === "ask") {
      const names = others.map((o) => `${o.label} (${chipName(o.scope)})`).join(", ");
      setProblem({
        key: `os:${field}`,
        combo: accel,
        add: false,
        text: `'${accel}' is used by ${names}; as the hotkey for ${label}, Windows would take it first`,
        others,
        canKeepBoth: false,
      });
      return;
    }
    if (others.length) {
      const next = { ...overrides };
      for (const o of others) put(next, o, splitKeys(o.keys).filter((k) => k !== c));
      save(next);
    }
    onChange({ [field]: accel } as Partial<AppSettings>);
    setProblem(null);
  };

  // Recording: the next key press (with its modifiers) becomes the key.
  useEffect(() => {
    if (!rec) return;
    const os = rec.key.startsWith("os:") ? (rec.key.slice(3) as OsField) : null;
    const s = os ? undefined : allShortcuts().find((x) => keyOf(x) === rec.key);
    const onKey = (e: KeyboardEvent) => {
      if (MODIFIER_KEYS.has(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        setRec(null);
        return;
      }
      if (os) {
        const accel = acceleratorFromEvent(e);
        if (!accel || accel === "__cancel__") return; // needs a modifier: keep listening
        setRec(null);
        applyOs(os, accel);
        return;
      }
      const combo = comboFromEvent(e);
      setRec(null);
      if (s && combo) apply(s, combo, rec.add);
    };
    window.addEventListener("keydown", onKey, true);
    const cancel = () => setRec(null);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", cancel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec]);

  // "Press a key": the next key press becomes the search.
  useEffect(() => {
    if (!listening) return;
    const onKey = (e: KeyboardEvent) => {
      if (MODIFIER_KEYS.has(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      setListening(false);
      if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey) return;
      const c = comboFromEvent(e);
      if (c) setKeyQ(c);
    };
    window.addEventListener("keydown", onKey, true);
    const cancel = () => setListening(false);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", cancel);
    };
  }, [listening]);

  const mapScope = tab !== "all" && tab !== "os" && !words.length && scopes.includes(tab) ? tab : null;
  // Holding Ctrl / Shift / Alt shows that layer of the map.
  useEffect(() => {
    if (!mapScope || rec || listening) return;
    const onMod = (e: KeyboardEvent) => {
      if (e.key !== "Control" && e.key !== "Shift" && e.key !== "Alt") return;
      setMods({ ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey });
    };
    window.addEventListener("keydown", onMod);
    window.addEventListener("keyup", onMod);
    return () => {
      window.removeEventListener("keydown", onMod);
      window.removeEventListener("keyup", onMod);
    };
  }, [mapScope, rec, listening]);

  const changedIn = (scope: string) =>
    scope === "os"
      ? OS_KEYS.filter((o) => settings[o.field] !== DEFAULT_SETTINGS[o.field]).length
      : Object.keys(overrides).filter((k) => k.startsWith(`${scope}:`)).length;
  const changed = Object.keys(overrides).length + changedIn("os");
  const osDefaults = (): Partial<AppSettings> => {
    const p: Partial<AppSettings> = {};
    for (const o of OS_KEYS) if (settings[o.field] !== DEFAULT_SETTINGS[o.field]) Object.assign(p, { [o.field]: DEFAULT_SETTINGS[o.field] });
    return p;
  };
  const resetAll = () => {
    onChange({ shortcuts: {}, ...osDefaults() });
    setProblem(null);
  };
  const resetTab = (scope: string) => {
    if (scope === "os") onChange(osDefaults());
    else save(Object.fromEntries(Object.entries(overrides).filter(([k]) => !k.startsWith(`${scope}:`))));
    setProblem(null);
  };

  const problemShown = !!problem && (rows.some((r) => keyOf(r) === problem.key) || osRows.some((o) => `os:${o.field}` === problem.key));

  const renderProblem = () => {
    if (!problem) return null;
    const os = problem.key.startsWith("os:") ? (problem.key.slice(3) as OsField) : null;
    const s = os ? undefined : all.find((x) => keyOf(x) === problem.key);
    return (
      <div
        role="alert"
        className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-red-500/40 bg-red-500/10 px-2.5 py-1.5 text-[11px] text-red-300"
      >
        <span>{problem.text}.</span>
        <span className="flex gap-1.5">
          {problem.others.length > 0 && (
            <button
              type="button"
              onClick={() => (s ? apply(s, problem.combo, problem.add, "replace") : os && applyOs(os, problem.combo, "replace"))}
              title={s ? `${s.label} gets ${problem.combo}; the others lose it` : "The hotkey gets it; the others lose it"}
              className="rounded border border-line bg-surface px-2 py-0.5 text-ink hover:border-accent"
            >
              Replace
            </button>
          )}
          {problem.canKeepBoth && s && (
            <button
              type="button"
              onClick={() => apply(s, problem.combo, problem.add, "both")}
              title={`Both keep ${problem.combo}; inside a tab, that tab's own key wins`}
              className="rounded border border-line bg-surface px-2 py-0.5 text-ink hover:border-accent"
            >
              Keep both
            </button>
          )}
          <button type="button" onClick={() => setProblem(null)} className="rounded px-2 py-0.5 text-ink-3 hover:text-ink">
            Cancel
          </button>
        </span>
      </div>
    );
  };

  const iconBtn = "grid h-6 w-6 place-items-center rounded text-ink-3 hover:bg-surface-2 hover:text-ink disabled:opacity-30";
  const hiddenUntilHover = "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100";

  let lastHead = "";
  return (
    <div className="pb-2">
      {/* Search, key search, reset all */}
      <div className="flex flex-wrap items-center gap-2 py-3">
        {keyQ ? (
          <div className="flex min-w-[200px] flex-1 items-center gap-2 rounded-md border border-accent bg-surface px-2.5 py-1 text-[12px] text-ink">
            <span className="text-ink-3">What does</span>
            <Keys keys={keyQ} />
            <span className="text-ink-3">do?</span>
            <button type="button" onClick={() => setKeyQ(null)} aria-label="Clear the key search" className={cn(iconBtn, "ml-auto")}>
              ×
            </button>
          </div>
        ) : (
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name…"
            aria-label="Search shortcuts"
            className="min-w-[200px] flex-1 rounded-md border border-line bg-surface px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-accent"
          />
        )}
        <button
          type="button"
          onClick={() => {
            setKeyQ(null);
            setListening((l) => !l);
          }}
          aria-pressed={listening}
          title="Press a key to see what it does in every tab"
          className={cn(
            "rounded-md border px-2.5 py-1.5 text-[12px]",
            listening ? "border-accent bg-accent/15 text-accent-fg" : "border-line bg-surface-2 text-ink hover:border-accent",
          )}
        >
          {listening ? "Press a key…" : "Press a key"}
        </button>
        <button
          type="button"
          disabled={!changed}
          onClick={resetAll}
          className="rounded-md border border-line bg-surface-2 px-2.5 py-1.5 text-[12px] text-ink hover:border-accent disabled:opacity-40"
          title="Every key back to how it came"
        >
          Reset all{changed ? ` (${changed})` : ""}
        </button>
      </div>

      {/* Where the keys work */}
      <div role="tablist" aria-label="Where the keys work" className="flex flex-wrap gap-1.5 pb-2">
        {["all", ...scopes, "os"].map((s) => {
          const n = clashCount(s);
          const on = tab === s && !keyQ && !words.length;
          return (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => {
                setTab(s);
                setQ("");
                setKeyQ(null);
              }}
              title={n ? `${n} clash${n === 1 ? "" : "es"}` : undefined}
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px]",
                on ? "border-accent bg-accent/15 text-ink" : "border-line text-ink-3 hover:border-line-3 hover:text-ink",
              )}
            >
              {chipName(s)}
              {n > 0 && <span className="rounded-full bg-red-500/80 px-1.5 text-[9px] font-semibold text-white">{n}</span>}
            </button>
          );
        })}
      </div>

      {mapScope && (
        <KeyMap
          scope={mapScope}
          all={all}
          osHotkeys={osHotkeys}
          mods={mods}
          setMods={setMods}
          picked={keyQ}
          onPick={(c) => setKeyQ((k) => (k === c ? null : c))}
        />
      )}

      <p className="pb-2 text-[11px] text-ink-3">
        Click a key to change it, then press the new one (Escape cancels). Each tab has its own keys; app-wide keys work in every tab. Keys never
        fire while you type in a text box. F1 shows what works where you are.
      </p>

      {problem && !problemShown && renderProblem()}

      {keyQ && osRows.length === 0 && (mapScope ? !rows.some((r) => r.scope === mapScope || r.scope === APP_SCOPE) : rows.length === 0) && (
        <FreeKey combo={keyQ} scope={mapScope} all={all} onGive={(s) => apply(s, keyQ, false)} />
      )}

      <div className="divide-y divide-line/60">
        {rows.map((s) => {
          const head = `${chipName(s.scope)}${s.group ? ` · ${s.group}` : ""}`;
          const showHead = head !== lastHead;
          lastHead = head;
          const k = keyOf(s);
          const isRec = rec?.key === k;
          const custom = k in overrides;
          const mine = clashesOf(k);
          if (s.mouse)
            return (
              <div key={k}>
                {showHead && <div className="pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-4">{head}</div>}
                <div className="flex items-center justify-between gap-3 py-1.5">
                  <span className="min-w-0 text-[12px] text-ink">{s.label}</span>
                  <span className="shrink-0 px-1.5 text-[11px] text-ink-3">{s.keys}</span>
                </div>
              </div>
            );
          return (
            <div key={k}>
              {showHead && <div className="pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-4">{head}</div>}
              <div className="group flex items-center justify-between gap-3 py-1.5">
                <span className="min-w-0 text-[12px]">
                  <span className={cn(mine.length ? "text-red-300" : custom ? "text-accent-fg" : "text-ink")}>{s.label}</span>
                  {custom && <span className="ml-1.5 text-[10px] text-ink-3">changed</span>}
                  {mine.length > 0 && (
                    <span className="block text-[10px] text-red-300">
                      {mine
                        .map((c) => {
                          const o = keyOf(c.a) === k ? c.b : c.a;
                          return `${c.combo} also: ${o.label} (${chipName(o.scope)})`;
                        })
                        .join(" · ")}
                    </span>
                  )}
                </span>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setRec(isRec ? null : { key: k, add: false })}
                    title="Click, then press the new key"
                    aria-label={`Change the key for ${s.label}`}
                    className={cn(
                      "rounded-md border px-1.5 py-1",
                      isRec ? "border-accent bg-accent/15" : mine.length ? "border-red-500/50" : "border-transparent hover:border-line-3",
                    )}
                  >
                    {isRec ? <span className="px-1 text-[11px] text-accent-fg">Press a key…</span> : <Keys keys={s.keys} />}
                  </button>
                  <button
                    type="button"
                    onClick={() => setRec({ key: k, add: true })}
                    title="Add another key"
                    aria-label={`Add another key for ${s.label}`}
                    className={cn(iconBtn, hiddenUntilHover)}
                  >
                    +
                  </button>
                  <button
                    type="button"
                    disabled={!splitKeys(s.keys).length}
                    onClick={() => {
                      const next = { ...overrides };
                      put(next, s, []);
                      save(next);
                    }}
                    title="No key"
                    aria-label={`Remove the keys for ${s.label}`}
                    className={cn(iconBtn, hiddenUntilHover)}
                  >
                    ×
                  </button>
                  <button
                    type="button"
                    disabled={!custom}
                    onClick={() => {
                      const next = { ...overrides };
                      delete next[k];
                      save(next);
                    }}
                    title={`Back to ${s.defaultKeys || "no key"}`}
                    aria-label={`Reset the key for ${s.label}`}
                    className={cn(iconBtn, !custom && hiddenUntilHover)}
                  >
                    ↺
                  </button>
                </div>
              </div>
              {problem?.key === k && renderProblem()}
            </div>
          );
        })}

        {osRows.length > 0 && (
          <div className="pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-4">Windows-wide · work in games too</div>
        )}
        {osRows.map((o) => {
          const k = `os:${o.field}`;
          const isRec = rec?.key === k;
          const custom = settings[o.field] !== DEFAULT_SETTINGS[o.field];
          const mine = clashesOf(k);
          return (
            <div key={k}>
              <div className="group flex items-center justify-between gap-3 py-1.5">
                <span className="min-w-0 text-[12px]">
                  <span className={cn(mine.length ? "text-red-300" : custom ? "text-accent-fg" : "text-ink")}>{o.label}</span>
                  {mine.length > 0 && (
                    <span className="block text-[10px] text-red-300">
                      {mine.map((c) => `also: ${c.b.label} (${chipName(c.b.scope)}), which never gets it`).join(" · ")}
                    </span>
                  )}
                </span>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setRec(isRec ? null : { key: k, add: false })}
                    title="Click, then press the new keys (with Ctrl, Alt, Shift or Win)"
                    aria-label={`Change the key for ${o.label}`}
                    className={cn("rounded-md border px-1.5 py-1", isRec ? "border-accent bg-accent/15" : "border-transparent hover:border-line-3")}
                  >
                    {isRec ? <span className="px-1 text-[11px] text-accent-fg">Press keys with Ctrl, Alt or Shift…</span> : <Keys keys={o.combo} />}
                  </button>
                  <button
                    type="button"
                    disabled={!custom}
                    onClick={() => onChange({ [o.field]: DEFAULT_SETTINGS[o.field] } as Partial<AppSettings>)}
                    title={`Back to ${DEFAULT_SETTINGS[o.field]}`}
                    aria-label={`Reset the key for ${o.label}`}
                    className={cn(iconBtn, !custom && hiddenUntilHover)}
                  >
                    ↺
                  </button>
                </div>
              </div>
              {problem?.key === k && renderProblem()}
            </div>
          );
        })}
      </div>

      {tab !== "all" && !keyQ && !words.length && changedIn(tab) > 0 && (
        <div className="flex justify-end pt-2">
          <button
            type="button"
            onClick={() => resetTab(tab)}
            className="rounded-md border border-line bg-surface-2 px-2.5 py-1 text-[11px] text-ink hover:border-accent"
          >
            Reset {chipName(tab)} ({changedIn(tab)})
          </button>
        </div>
      )}
    </div>
  );
}

/** The chosen tab's keys on a keyboard: this tab, app-wide, Windows-wide, clashes. */
function KeyMap({
  scope,
  all,
  osHotkeys,
  mods,
  setMods,
  picked,
  onPick,
}: {
  scope: string;
  all: ShortcutInfo[];
  osHotkeys: { label: string; combo: string }[];
  mods: Mods;
  setMods: (m: Mods) => void;
  picked: string | null;
  onPick: (combo: string) => void;
}) {
  const uses = useMemo(() => {
    const m = new Map<string, ShortcutInfo[]>();
    for (const s of all)
      for (const c of new Set(splitKeys(s.keys))) {
        const l = m.get(c) ?? [];
        l.push(s);
        m.set(c, l);
      }
    return m;
  }, [all]);

  const stateOf = (combo: string) => {
    const u = uses.get(combo) ?? [];
    const mine = u.filter((s) => s.scope === scope);
    // On the app-wide map, "others" are tabs using an app-wide key; on a tab's map, the app-wide keys.
    const others = scope === APP_SCOPE ? u.filter((s) => s.scope !== APP_SCOPE) : u.filter((s) => s.scope === APP_SCOPE);
    const os = osHotkeys.filter((o) => o.combo === combo);
    const clash =
      mine.length > 1 ||
      (mine.length > 0 && (others.length > 0 || os.length > 0)) ||
      (scope !== APP_SCOPE && (others.length > 1 || (others.length > 0 && os.length > 0)));
    const kind = clash ? "clash" : mine.length ? "mine" : scope !== APP_SCOPE && others.length ? "app" : os.length ? "os" : "free";
    const who = [
      ...mine.map((s) => s.label),
      ...others.map((s) => `${s.label} (${scope === APP_SCOPE ? chipName(s.scope) : "app-wide"})`),
      ...os.map((o) => `${o.label} (Windows-wide)`),
    ];
    return { kind, who };
  };

  const color: Record<string, string> = {
    clash: "border-red-500/70 bg-red-500/25 text-ink",
    mine: "border-accent/70 bg-accent/20 text-ink",
    app: "border-blue-400/60 bg-blue-500/15 text-ink",
    os: "border-amber-500/50 bg-amber-500/10 text-ink",
    free: "border-line bg-surface text-ink-4",
  };
  const mod = (k: keyof Mods, label: string) => (
    <button
      type="button"
      aria-pressed={mods[k]}
      onClick={() => setMods({ ...mods, [k]: !mods[k] })}
      className={cn(
        "rounded border px-2 py-0.5 font-mono text-[10px]",
        mods[k] ? "border-accent bg-accent/20 text-ink" : "border-line text-ink-3 hover:text-ink",
      )}
    >
      {label}
    </button>
  );

  return (
    <div className="mb-3 rounded-lg border border-line bg-surface-2/40 p-2.5" role="group" aria-label={`${chipName(scope)} keyboard`}>
      <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[10px] text-ink-3">
        {mod("ctrl", "Ctrl")}
        {mod("shift", "Shift")}
        {mod("alt", "Alt")}
        <span className="ml-1">or hold them</span>
        <span className="ml-auto flex flex-wrap items-center gap-2">
          <Swatch c={color.mine} t={chipName(scope)} />
          {scope !== APP_SCOPE && <Swatch c={color.app} t="App-wide" />}
          <Swatch c={color.os} t="Windows-wide" />
          <Swatch c={color.clash} t="Clash" />
        </span>
      </div>
      <div className="overflow-x-auto">
        <div className="flex min-w-[520px] flex-col gap-1">
          {KEYBOARD.map((row, i) => (
            <div key={i} className="flex gap-1">
              {row.map((c) => {
                const combo = cellCombo(c, mods);
                const { kind, who } = stateOf(combo);
                const label = c.shifted && mods.shift ? c.shifted : c.label;
                const text = `${combo}: ${who.length ? who.join(", ") : "free"}`;
                return (
                  <button
                    key={c.key}
                    type="button"
                    onClick={() => onPick(combo)}
                    title={text}
                    aria-label={text}
                    data-kind={kind}
                    style={{ flex: `${c.w ?? 1} 1 0` }}
                    className={cn(
                      "h-7 min-w-0 truncate rounded border px-0.5 font-mono text-[10px] hover:brightness-125",
                      color[kind],
                      picked === combo && "ring-2 ring-accent",
                    )}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Swatch({ c, t }: { c: string; t: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className={cn("inline-block h-2.5 w-3.5 rounded-sm border", c)} />
      {t}
    </span>
  );
}

/** A key nobody uses: offer it to one of the tab's actions. */
function FreeKey({
  combo,
  scope,
  all,
  onGive,
}: {
  combo: string;
  scope: string | null;
  all: ShortcutInfo[];
  onGive: (s: ShortcutInfo) => void;
}) {
  const options = all.filter((s) => s.scope === (scope ?? APP_SCOPE));
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface-2/50 px-2.5 py-1.5 text-[11px] text-ink-3">
      <Keys keys={combo} />
      <span>is free{scope ? ` in ${chipName(scope)}` : " everywhere"}.</span>
      <select
        aria-label={`Give ${combo} to`}
        value=""
        onChange={(e) => {
          const s = options.find((x) => keyOf(x) === e.target.value);
          if (s) onGive(s);
        }}
        className="rounded border border-line bg-surface px-1.5 py-0.5 text-[11px] text-ink"
      >
        <option value="">Give it to…</option>
        {options.map((s) => (
          <option key={s.id} value={keyOf(s)}>
            {s.label}
          </option>
        ))}
      </select>
    </div>
  );
}
