/**
 * Settings → Shortcuts: every in-app shortcut by area. Click a key to record
 * a new one (Escape cancels), add a second key, remove keys, or reset. A key
 * that another shortcut in the same area (or everywhere) already uses is
 * refused with its name, with a one-click "Use it here instead".
 *
 * The global hotkeys (save a replay, screenshot…) live in Recording and
 * Screenshots; their combos are refused here too, because Windows hands them
 * to Lastshot before any window sees them.
 */
import { useEffect, useMemo, useState } from "react";
import type { AppSettings } from "../lib/types";
import { allShortcuts, comboFromEvent, conflictsFor, normalizeCombo, onShortcutsChange, splitKeys, type ShortcutInfo } from "../lib/shortcuts";
import { cn } from "../utils/cn";
import { Keys, scopeName } from "./ShortcutsOverlay";

const MODIFIER_KEYS = new Set(["Control", "Alt", "Shift", "Meta", "CapsLock", "NumLock", "ScrollLock", "AltGraph"]);

const keyOf = (s: ShortcutInfo) => `${s.scope}:${s.id}`;

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
  /** Recording a key for this shortcut ("add" keeps the old keys). */
  const [rec, setRec] = useState<{ key: string; add: boolean } | null>(null);
  const [problem, setProblem] = useState<{ key: string; combo: string; add: boolean; text: string; others: ShortcutInfo[] } | null>(null);
  const overrides = useMemo(() => settings.shortcuts ?? {}, [settings.shortcuts]);

  const list = useMemo(() => {
    void ver;
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return allShortcuts()
      .filter((s) => {
        const hay = `${s.label} ${s.keys} ${s.group ?? ""} ${scopeName(s.scope)}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      })
      .sort(
        (a, b) =>
          (a.scope === "global" ? -1 : 0) - (b.scope === "global" ? -1 : 0) ||
          scopeName(a.scope).localeCompare(scopeName(b.scope)) ||
          (a.group ?? "").localeCompare(b.group ?? ""),
      );
  }, [q, ver]);

  const globalHotkeys = useMemo(
    () =>
      [
        ["Save a replay", settings.hotkeySave],
        ["Instant replay on/off", settings.hotkeyToggle],
        ["Screenshot", settings.hotkeySnip],
        ["Record", settings.hotkeyRecord],
      ].filter(([, k]) => !!k) as [string, string][],
    [settings.hotkeySave, settings.hotkeyToggle, settings.hotkeySnip, settings.hotkeyRecord],
  );

  const save = (next: Record<string, string>) => onChange({ shortcuts: next });
  const setKeys = (s: ShortcutInfo, keys: string[]) => {
    const value = keys.join(" | ");
    const next = { ...overrides };
    if (value === s.defaultKeys) delete next[keyOf(s)];
    else next[keyOf(s)] = value;
    save(next);
  };

  const apply = (s: ShortcutInfo, combo: string, add: boolean, force = false) => {
    const c = normalizeCombo(combo);
    const hot = globalHotkeys.find(([, k]) => normalizeCombo(k.replace(/\bWin\b/, "Meta")) === c);
    if (hot) {
      setProblem({ key: keyOf(s), combo: c, add, text: `'${c}' is already the global shortcut for ${hot[0]}`, others: [] });
      return;
    }
    const others = conflictsFor(s.scope, s.id, c);
    if (others.length && !force) {
      const names = others.map((o) => `${o.label}${o.scope !== s.scope ? ` (${scopeName(o.scope)})` : ""}`).join(", ");
      setProblem({ key: keyOf(s), combo: c, add, text: `'${c}' is already the shortcut for ${names}`, others });
      return;
    }
    const next = { ...overrides };
    // "Use it here instead": the key leaves the others.
    for (const o of force ? others : []) {
      const left = splitKeys(o.keys).filter((k) => k !== c).join(" | ");
      if (left === o.defaultKeys) delete next[keyOf(o)];
      else next[keyOf(o)] = left;
    }
    const mine = add ? [...splitKeys(s.keys).filter((k) => k !== c), c] : [c];
    const value = mine.join(" | ");
    if (value === s.defaultKeys) delete next[keyOf(s)];
    else next[keyOf(s)] = value;
    save(next);
    setProblem(null);
  };

  // Recording: the next key press (with its modifiers) becomes the shortcut.
  useEffect(() => {
    if (!rec) return;
    const s = list.find((x) => keyOf(x) === rec.key) ?? allShortcuts().find((x) => keyOf(x) === rec.key);
    const onKey = (e: KeyboardEvent) => {
      if (MODIFIER_KEYS.has(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        setRec(null);
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

  const changed = Object.keys(overrides).length;
  let lastHead = "";
  return (
    <div className="pb-2">
      <div className="flex flex-wrap items-center gap-2 py-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by name or key…"
          aria-label="Search shortcuts"
          className="min-w-[200px] flex-1 rounded-md border border-line bg-surface px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-accent"
        />
        <button
          type="button"
          disabled={!changed}
          onClick={() => {
            save({});
            setProblem(null);
          }}
          className="rounded-md border border-line bg-surface-2 px-2.5 py-1.5 text-[12px] text-ink hover:border-accent disabled:opacity-40"
          title="Every shortcut back to its built-in key"
        >
          Reset all{changed ? ` (${changed})` : ""}
        </button>
      </div>
      <p className="pb-2 text-[11px] text-ink-3">
        Click a key to change it, then press the new one (Escape cancels). Shortcuts never fire while you type in a text box. Press ? or F1 anywhere to see what works where you are.
      </p>
      <div className="divide-y divide-line/60">
        {list.map((s) => {
          const head = `${scopeName(s.scope)}${s.group ? ` · ${s.group}` : ""}`;
          const showHead = head !== lastHead;
          lastHead = head;
          const k = keyOf(s);
          const isRec = rec?.key === k;
          const custom = k in overrides;
          return (
            <div key={k}>
              {showHead && <div className="pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-4">{head}</div>}
              <div className="flex items-center justify-between gap-3 py-1.5">
                <span className={cn("min-w-0 text-[12px]", custom ? "text-accent-fg" : "text-ink")}>
                  {s.label}
                  {custom && <span className="ml-1.5 text-[10px] text-ink-3">changed</span>}
                </span>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setRec(isRec ? null : { key: k, add: false })}
                    title="Click, then press the new key"
                    aria-label={`Change the key for ${s.label}`}
                    className={cn(
                      "rounded-md border px-1.5 py-1",
                      isRec ? "border-accent bg-accent/15" : "border-transparent hover:border-line-3",
                    )}
                  >
                    {isRec ? <span className="px-1 text-[11px] text-accent-fg">Press a key…</span> : <Keys keys={s.keys} />}
                  </button>
                  <button
                    type="button"
                    onClick={() => setRec({ key: k, add: true })}
                    title="Add another key"
                    aria-label={`Add another key for ${s.label}`}
                    className="grid h-6 w-6 place-items-center rounded text-ink-3 hover:bg-surface-2 hover:text-ink"
                  >
                    +
                  </button>
                  <button
                    type="button"
                    disabled={!splitKeys(s.keys).length}
                    onClick={() => setKeys(s, [])}
                    title="No key"
                    aria-label={`Remove the keys for ${s.label}`}
                    className="grid h-6 w-6 place-items-center rounded text-ink-3 hover:bg-surface-2 hover:text-ink disabled:opacity-30"
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
                    className="grid h-6 w-6 place-items-center rounded text-ink-3 hover:bg-surface-2 hover:text-ink disabled:opacity-30"
                  >
                    ↺
                  </button>
                </div>
              </div>
              {problem?.key === k && (
                <div role="alert" className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-warn">
                  <span>{problem.text}.</span>
                  <span className="flex gap-1.5">
                    {problem.others.length > 0 && (
                      <button
                        type="button"
                        onClick={() => apply(s, problem.combo, problem.add, true)}
                        className="rounded border border-line bg-surface px-2 py-0.5 text-ink hover:border-accent"
                      >
                        Use it here instead
                      </button>
                    )}
                    <button type="button" onClick={() => setProblem(null)} className="rounded px-2 py-0.5 text-ink-3 hover:text-ink">
                      OK
                    </button>
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
