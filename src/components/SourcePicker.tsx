import { useCallback, useEffect, useState } from "react";
import { lastshot } from "../lib/bridge";
import type { CaptureSource, MonitorInfo, WindowInfo } from "../lib/types";
import { cn } from "../utils/cn";

/** Short label for the current source ("Full screen", "Roblox"). */
export function sourceLabel(src: CaptureSource | undefined): string {
  if (!src || src.kind === "display") return "Full screen";
  return src.title.length > 32 ? `${src.title.slice(0, 31)}…` : src.title;
}

/**
 * Lists what can be recorded: the full screen, every open window/app, and
 * an area of the screen. Picking one calls `onPick` (record it, or just
 * make it the source, depending on where the picker is used).
 */
export default function SourcePicker({
  current,
  monitor,
  onPick,
  onArea,
  onClose,
  actionLabel = "Record",
}: {
  current: CaptureSource;
  monitor?: MonitorInfo;
  onPick: (src: CaptureSource) => void;
  onArea?: () => void;
  onClose: () => void;
  actionLabel?: string;
}) {
  const [windows, setWindows] = useState<WindowInfo[] | null>(null);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      setWindows(await lastshot.listWindows());
    } catch (e) {
      setError(String(e));
      setWindows([]);
    }
  }, []);

  useEffect(() => {
    void load();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [load, onClose]);

  const q = filter.trim().toLowerCase();
  const shown = (windows ?? []).filter(
    (w) => !q || w.title.toLowerCase().includes(q) || w.exe.toLowerCase().includes(q),
  );
  const isCurrent = (w: WindowInfo) => current.kind === "window" && current.hwnd === w.hwnd;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-label="What to record"
        className="flex max-h-[80vh] w-full max-w-[560px] flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div>
            <div className="text-[14px] font-semibold text-ink">What to record</div>
            <div className="text-[11px] text-ink-3">Instant replay records the same thing.</div>
          </div>
          <button type="button" onClick={onClose} className="rounded-md px-2 py-1 text-ink-3 hover:bg-surface-2 hover:text-ink" aria-label="Close">
            ✕
          </button>
        </div>

        <div className="grid grid-cols-2 gap-2 p-3">
          <button
            type="button"
            onClick={() => onPick({ kind: "display" })}
            className={cn(
              "rounded-lg border px-3 py-2.5 text-left hover:border-accent",
              current.kind === "display" ? "border-accent bg-accent/10" : "border-line bg-surface-2",
            )}
          >
            <div className="text-[13px] font-semibold text-ink">Full screen</div>
            <div className="truncate text-[11px] text-ink-3">
              {monitor ? `${monitor.name.replace(/^\\\\\.\\/, "")} · ${monitor.width}×${monitor.height}` : "The screen picked in Settings"}
            </div>
          </button>
          {onArea && (
            <button
              type="button"
              onClick={onArea}
              className="rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-left hover:border-accent"
            >
              <div className="text-[13px] font-semibold text-ink">Area of the screen</div>
              <div className="text-[11px] text-ink-3">Drag a box. Esc cancels.</div>
            </button>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-line px-3 pt-3">
          <div className="text-[12px] font-semibold text-ink-2">Window or app</div>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search"
            className="ml-auto w-40 rounded-md border border-line bg-surface-2 px-2 py-1 text-[12px] text-ink outline-none focus:border-accent"
          />
          <button type="button" onClick={() => void load()} className="rounded-md border border-line bg-surface-2 px-2 py-1 text-[12px] text-ink-2 hover:border-accent" title="Refresh the list">
            ↻
          </button>
        </div>
        <div className="min-h-[120px] flex-1 overflow-y-auto p-3 pt-2">
          {windows == null && <div className="py-6 text-center text-[12px] text-ink-3">Looking for windows…</div>}
          {error && <div className="py-2 text-[12px] text-danger">{error}</div>}
          {windows != null && shown.length === 0 && !error && (
            <div className="py-6 text-center text-[12px] text-ink-3">{q ? "No window matches." : "No windows found."}</div>
          )}
          <ul className="space-y-1">
            {shown.map((w) => (
              <li key={w.hwnd}>
                <button
                  type="button"
                  onClick={() => onPick({ kind: "window", hwnd: w.hwnd, exe: w.exe, title: w.title })}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left hover:border-accent",
                    isCurrent(w) ? "border-accent bg-accent/10" : "border-transparent bg-surface-2",
                  )}
                  title={`${actionLabel}: ${w.title}`}
                >
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-surface-3 text-[13px] font-bold uppercase text-ink-2">
                    {(w.exe || w.title).slice(0, 1)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-ink">{w.title}</span>
                    <span className="block truncate text-[11px] text-ink-3">
                      {w.exe || "app"}
                      {w.width > 0 ? ` · ${w.width}×${w.height}` : ""}
                    </span>
                  </span>
                  <span className="shrink-0 text-[11px] font-semibold text-accent">{actionLabel}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className="border-t border-line px-4 py-2 text-[11px] text-ink-3">
          A window is recorded even when it is covered or on another screen, and nothing else gets in. If the app restarts, Lastshot finds it again.
        </div>
      </div>
    </div>
  );
}
