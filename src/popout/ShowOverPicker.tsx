/**
 * "Show over" for one frame: a small button that says which apps
 * ("Every app", "Blender", "Blender, Krita (+1)"); a click opens a checklist
 * of open apps (and apps already picked, also when closed), a box to type an
 * exe name, and "Every app".
 */
import { useEffect, useRef, useState } from "react";
import { cn } from "../utils/cn";
import { appName, normApp, showOverChoices, showOverLabel, toggleApp } from "./showOver";

export default function ShowOverPicker({
  value,
  known,
  open: openList,
  onChange,
  frameTitle,
}: {
  value: string[];
  /** Apps picked on other frames. */
  known: string[];
  /** Apps with a window now. */
  open: { exe: string; title: string }[];
  onChange: (list: string[]) => void;
  frameTitle: string;
}) {
  const [shown, setShown] = useState(false);
  const [typed, setTyped] = useState("");
  const box = useRef<HTMLDivElement | null>(null);

  // Closes on a click elsewhere or Escape.
  useEffect(() => {
    if (!shown) return;
    const down = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setShown(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShown(false);
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key);
    };
  }, [shown]);

  const choices = showOverChoices(value, known, openList);
  const addTyped = () => {
    const n = normApp(typed);
    if (!n) return;
    if (!value.some((a) => a.toLowerCase() === n.toLowerCase())) onChange(toggleApp(value, n));
    setTyped("");
  };

  return (
    <div ref={box} className="relative mt-1.5 flex items-center gap-2 text-[11px] text-ink-3">
      <span className="w-12 shrink-0">Show over</span>
      <button
        type="button"
        data-testid="frame-row-show-over"
        aria-haspopup="dialog"
        aria-expanded={shown}
        onClick={() => setShown((s) => !s)}
        title={
          value.length
            ? `Shown only while ${value.map(appName).join(", ")} or Lastshot is in front.`
            : "Shown over every app, except an app that is full screen on the frame's screen (a game, a video)."
        }
        className="h-6 min-w-0 flex-1 truncate rounded border border-line bg-surface px-2 text-left text-[11px] text-ink hover:border-line-2"
      >
        {showOverLabel(value)}
        <span className="float-right text-ink-4">▾</span>
      </button>

      {shown && (
        <div
          role="dialog"
          aria-label={`Show ${frameTitle} over`}
          data-testid="frame-show-over"
          className="absolute left-12 right-0 top-7 z-30 rounded-lg border border-line-2 bg-surface-2 p-1.5 shadow-xl"
        >
          <label className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 hover:bg-surface">
            <input type="checkbox" checked={value.length === 0} onChange={() => onChange([])} data-testid="frame-show-over-every" />
            <span className="text-ink">Every app</span>
            <span className="ml-auto text-[10px] text-ink-4">not over full screen</span>
          </label>
          <div className="my-1 h-px bg-line" />
          <div className="max-h-48 overflow-y-auto">
            {choices.length === 0 && <div className="px-1.5 py-1 text-ink-4">No other apps are open.</div>}
            {choices.map((c) => (
              <label
                key={c.exe.toLowerCase()}
                className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 hover:bg-surface"
                title={c.title ? `${c.exe}: ${c.title}` : c.exe}
                data-testid="frame-show-over-app"
              >
                <input type="checkbox" checked={c.chosen} onChange={() => onChange(toggleApp(value, c.exe))} />
                <span className={cn("shrink-0", c.open ? "text-ink" : "text-ink-3")}>{appName(c.exe)}</span>
                <span className="min-w-0 truncate text-[10px] text-ink-4">{c.open ? c.title : "not open"}</span>
              </label>
            ))}
          </div>
          <div className="my-1 h-px bg-line" />
          <form
            className="flex items-center gap-1 px-1 py-0.5"
            onSubmit={(e) => {
              e.preventDefault();
              addTyped();
            }}
          >
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="Type an exe name, e.g. krita.exe"
              spellCheck={false}
              data-testid="frame-show-over-typed"
              className="h-6 min-w-0 flex-1 rounded border border-line bg-surface px-1.5 text-[11px] text-ink"
            />
            <button type="submit" disabled={!normApp(typed)} className="h-6 rounded border border-line px-2 text-ink-2 disabled:opacity-40">
              Add
            </button>
          </form>
          <p className="px-1.5 pt-1 text-[10px] leading-snug text-ink-4">Lastshot itself never hides frames. A chosen app keeps its frames even when it is full screen.</p>
        </div>
      )}
    </div>
  );
}
