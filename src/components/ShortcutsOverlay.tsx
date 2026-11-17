/**
 * The cheat sheet (? or F1) and command list (Ctrl+Shift+P): every shortcut that
 * works right now in this window, searchable by name or key. Enter or a
 * click runs the highlighted one; "All" also lists keys for parts of the app
 * that are not open.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { activeShortcuts, allShortcuts, onShortcutsChange, splitKeys, type ShortcutInfo } from "../lib/shortcuts";
import { cn } from "../utils/cn";

export const SCOPE_NAMES: Record<string, string> = {
  global: "App-wide",
  clips: "Clips",
  viewer: "Viewer",
  frame: "Frames",
  snip: "Snip",
  editor: "Editor",
};
export const scopeName = (s: string) => SCOPE_NAMES[s] ?? s.charAt(0).toUpperCase() + s.slice(1);

type Row = ShortcutInfo & { run?: () => void };

export function Keys({ keys, dim, mouse }: { keys: string; dim?: boolean; mouse?: boolean }) {
  // Gestures stay as written ("Ctrl+Space+drag" is no key combo).
  const list = mouse ? keys.split("|").map((k) => k.trim()).filter(Boolean) : splitKeys(keys);
  if (!list.length) return <span className="text-[11px] text-ink-4">No key</span>;
  return (
    <span className="flex flex-wrap justify-end gap-1">
      {list.map((k) => (
        <kbd
          key={k}
          className={cn(
            "rounded border border-line-3 bg-surface px-1.5 py-0.5 font-mono text-[10px] font-semibold",
            dim ? "text-ink-4" : "text-ink-2",
          )}
        >
          {k}
        </kbd>
      ))}
    </span>
  );
}

export default function ShortcutsOverlay({
  mode,
  onClose,
  onEdit,
}: {
  mode: "keys" | "commands";
  onClose: () => void;
  /** Opens Settings → Shortcuts. */
  onEdit: () => void;
}) {
  const [q, setQ] = useState("");
  const [all, setAll] = useState(false);
  const [sel, setSel] = useState(0);
  const [ver, setVer] = useState(0);
  const input = useRef<HTMLInputElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);
  useEffect(() => onShortcutsChange(() => setVer((v) => v + 1)), []);
  useEffect(() => input.current?.focus(), []);

  const rows: Row[] = useMemo(() => {
    void ver;
    const active = activeShortcuts();
    const base: Row[] = all
      ? [
          ...active,
          ...allShortcuts().filter((s) => !active.some((a) => a.scope === s.scope && a.id === s.id)),
        ]
      : active;
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = base.filter((s) => {
      const hay = `${s.label} ${s.keys} ${s.group ?? ""} ${scopeName(s.scope)}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    // Commands: things to run first; the cheat sheet keeps groups together.
    return hits.sort((a, b) =>
      mode === "commands" && !!a.run !== !!b.run
        ? a.run
          ? -1
          : 1
        : scopeName(a.scope).localeCompare(scopeName(b.scope)) || (a.group ?? "").localeCompare(b.group ?? ""),
    );
  }, [q, all, ver, mode]);

  useEffect(() => setSel(0), [q, all]);
  useEffect(() => {
    list.current?.querySelector(`[data-row="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const run = (r: Row | undefined) => {
    if (!r?.run || !r.active) return;
    onClose();
    // After the overlay is gone, so the shortcut acts on the app.
    window.setTimeout(() => r.run?.(), 0);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    else if (e.key === "ArrowDown") setSel((s) => Math.min(rows.length - 1, s + 1));
    else if (e.key === "ArrowUp") setSel((s) => Math.max(0, s - 1));
    else if (e.key === "PageDown") setSel((s) => Math.min(rows.length - 1, s + 8));
    else if (e.key === "PageUp") setSel((s) => Math.max(0, s - 8));
    else if (e.key === "Enter") run(rows[sel]);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  let lastHead = "";
  return (
    <div
      className="fixed inset-0 z-[90] flex items-start justify-center bg-black/45 p-6 pt-[8vh]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={onKey}
      role="dialog"
      aria-modal="true"
      aria-label={mode === "commands" ? "Commands" : "Keyboard shortcuts"}
    >
      <div className="panel flex max-h-[78vh] w-full max-w-[640px] flex-col overflow-hidden rounded-xl border border-line-3 shadow-2xl">
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={mode === "commands" ? "Type a command or a key…" : "Search shortcuts…"}
            aria-label="Search"
            className="min-w-0 flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-4"
          />
          <label className="flex shrink-0 items-center gap-1.5 text-[11px] text-ink-3" title="Also list keys for parts of the app that are not open">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
            All
          </label>
        </div>
        <div ref={list} className="min-h-0 flex-1 overflow-y-auto py-1" role="listbox" aria-label="Shortcuts">
          {rows.length === 0 && <div className="px-4 py-6 text-center text-[12px] text-ink-3">Nothing matches “{q}”.</div>}
          {rows.map((r, i) => {
            const head = mode === "commands" ? "" : `${scopeName(r.scope)}${r.group ? ` · ${r.group}` : ""}`;
            const showHead = head && head !== lastHead;
            lastHead = head;
            return (
              <div key={`${r.scope}:${r.id}`}>
                {showHead && <div className="px-4 pt-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-4">{head}</div>}
                <button
                  type="button"
                  role="option"
                  aria-selected={i === sel}
                  data-row={i}
                  disabled={!r.active || !r.run}
                  onMouseMove={() => setSel(i)}
                  onClick={() => run(r)}
                  className={cn(
                    "flex w-full items-center justify-between gap-4 px-4 py-1.5 text-left text-[12px]",
                    i === sel ? "bg-surface-3" : "",
                    r.active ? "text-ink" : "text-ink-4",
                  )}
                >
                  <span className="min-w-0 truncate">
                    {r.label}
                    {mode === "commands" && <span className="ml-2 text-[10px] text-ink-4">{scopeName(r.scope)}</span>}
                  </span>
                  <Keys keys={r.keys} dim={!r.active} mouse={r.mouse} />
                </button>
              </div>
            );
          })}
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-2 text-[11px] text-ink-3">
          <span>↑↓ choose · Enter run · Esc close</span>
          <button
            type="button"
            onClick={() => {
              onClose();
              onEdit();
            }}
            className="rounded-md border border-line bg-surface-2 px-2.5 py-1 font-medium text-ink hover:border-accent"
          >
            Change shortcuts…
          </button>
        </div>
      </div>
    </div>
  );
}
