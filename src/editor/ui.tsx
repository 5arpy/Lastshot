/** Small building blocks for the editor (theme-aware, compact). */
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "../utils/cn";

export function Ico({ d, className }: { d: string; className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={cn("h-4 w-4 shrink-0 fill-none stroke-current", className)} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

export const I = {
  play: "M4.5 3v10l8-5z",
  pause: "M5 3v10M11 3v10",
  undo: "M5 4L2 7l3 3M2 7h7a4 4 0 0 1 0 8H7",
  redo: "M11 4l3 3-3 3M14 7H7a4 4 0 0 0 0 8h2",
  split: "M8 1v14M4 4l-2 4 2 4M12 4l2 4-2 4",
  blade: "M3 13L13 3M9 3h4v4",
  slip: "M2 4h12v8H2zM5 8h6M5 8l1.5-1.5M5 8l1.5 1.5M11 8l-1.5-1.5M11 8l-1.5 1.5",
  select: "M3 2l9 5-4 1.5L6.5 13z",
  trash: "M3 4h10M6 4V2.5h4V4M4.5 4l.7 9.5h5.6l.7-9.5",
  ripple: "M2 8h5M9 5l-3 3 3 3M14 3v10",
  magnet: "M4 3v5a4 4 0 0 0 8 0V3M4 6h2.5M9.5 6H12M6.5 3v3M9.5 3v3",
  snap: "M2 13h12M8 2v9M5 8l3 3 3-3",
  marker: "M4 2h8v8l-4 4-4-4z",
  zoomIn: "M7 3a4 4 0 1 0 0 8a4 4 0 1 0 0-8M13.5 13.5L10 10M5 7h4M7 5v4",
  zoomOut: "M7 3a4 4 0 1 0 0 8a4 4 0 1 0 0-8M13.5 13.5L10 10M5 7h4",
  fit: "M2 5V2h3M11 2h3v3M14 11v3h-3M5 14H2v-3",
  crop: "M4 1v11h11M1 4h11v11",
  text: "M3 3h10M8 3v10M6 13h4",
  pen: "M3 13c2-1 3-5 5-6s3 2 5 0",
  camera: "M2 5h3l1-2h4l1 2h3v8H2zM8 7a2 2 0 1 0 0 4 2 2 0 0 0 0-4",
  popout: "M6 3H3v10h10v-3M9 2h5v5M14 2L7 9",
  exportI: "M8 10V2M5 5l3-3 3 3M3 10v4h10v-4",
  discord: "M3 4.5C4.5 3.5 6 3 8 3s3.5.5 5 1.5c1 2 1.5 4 1.3 6.5-1.3 1-2.5 1.5-3.6 1.8l-.8-1.3M2.7 11c1.3 1 2.5 1.5 3.6 1.8l.8-1.3M6 8.5h.01M10 8.5h.01",
  media: "M2 3h12v10H2zM2 6h12M6 3v3M10 3v3",
  panel: "M2 3h12v10H2zM10 3v10",
  plus: "M8 3v10M3 8h10",
  eye: "M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5zM8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4",
  eyeOff: "M2 2l12 12M6.5 6.6A2 2 0 0 0 9.4 9.5M4 4.6C2.2 5.8 1 8 1 8s2.5 5 7 5c1.4 0 2.6-.5 3.6-1.1M7 3.1c.3 0 .7-.1 1-.1 4.5 0 7 5 7 5s-.6 1.2-1.7 2.4",
  lock: "M4 7h8v7H4zM5.5 7V5a2.5 2.5 0 0 1 5 0v2",
  unlock: "M4 7h8v7H4zM5.5 7V5a2.5 2.5 0 0 1 5-.5",
  speaker: "M2 6h3l4-3v10l-4-3H2zM11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.8a6 6 0 0 1 0 8.4",
  mute: "M2 6h3l4-3v10l-4-3H2zM11 6l4 4M15 6l-4 4",
  more: "M3 8h.01M8 8h.01M13 8h.01",
  loop: "M3 6a4 4 0 0 1 4-3h4l-2-2M13 10a4 4 0 0 1-4 3H5l2 2",
  close: "M4 4l8 8M12 4l-8 8",
  folder: "M2 4h4l1.5 1.5H14V13H2z",
  star: "M8 2l1.8 3.8 4.2.5-3.1 2.9.8 4.1L8 11.3 4.3 13.3l.8-4.1L2 6.3l4.2-.5z",
  file: "M4 2h5l3 3v9H4zM9 2v3h3",
  music: "M6 12V3l7-1v9M6 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM13 11a2 2 0 1 1-4 0 2 2 0 0 1 4 0z",
  annotate: "M2 14l2.5-.5 8-8-2-2-8 8zM9.5 4.5l2 2",
  rotate: "M13 8a5 5 0 1 1-1.5-3.5M13 2v3h-3",
  flipH: "M8 2v12M6 4L2 12h4zM10 4l4 8h-4z",
  flipV: "M2 8h12M4 6L12 2v4zM4 10l8 4v-4z",
  front: "M2 2h8v8H2zM6 6h8v8H6z",
  copy: "M5 5h8v9H5zM3 11V2h8",
  gap: "M2 4v8M14 4v8M5 8h6M7 6l-2 2 2 2M9 6l2 2-2 2",
  keyboard: "M1.5 4h13v8h-13zM4 6.5h.01M6.5 6.5h.01M9 6.5h.01M11.5 6.5h.01M4.5 9.5h7",
};

export function Btn({
  title,
  onClick,
  children,
  on,
  disabled,
  className,
  wide,
  tone,
}: {
  title: string;
  onClick: (e: React.MouseEvent) => void;
  children: ReactNode;
  on?: boolean;
  disabled?: boolean;
  className?: string;
  wide?: boolean;
  tone?: "accent" | "danger";
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={on}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-md text-[11.5px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-35",
        wide ? "px-2.5" : "w-7",
        tone === "accent"
          ? "bg-accent text-white hover:bg-accent-hover"
          : on
            ? "bg-accent/20 text-accent-fg ring-1 ring-accent/40"
            : tone === "danger"
              ? "text-ink-2 hover:bg-red-500/15 hover:text-danger"
              : "text-ink-2 hover:bg-surface-4 hover:text-ink",
        className,
      )}
    >
      {children}
    </button>
  );
}

export const Sep = () => <span className="mx-1 h-5 w-px shrink-0 bg-line" />;

export interface MenuItem {
  label: string;
  key?: string;
  run?: () => void;
  disabled?: boolean;
  danger?: boolean;
  checked?: boolean;
  sep?: boolean;
  sub?: MenuItem[];
  hint?: string;
}

/** A menu at a screen point (context menu or dropdown). Closes on outside click / Esc. */
export function Menu({ at, items, onClose, minWidth = 220 }: { at: { x: number; y: number }; items: MenuItem[]; onClose: () => void; minWidth?: number }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState(at);
  const [open, setOpen] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.max(4, Math.min(at.x, window.innerWidth - r.width - 4)),
      y: Math.max(4, Math.min(at.y, window.innerHeight - r.height - 4)),
    });
  }, [at]);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);
  return createPortal(
    <div
      ref={ref}
      role="menu"
      className="animate-pop fixed z-[80] rounded-lg border border-line-2 bg-surface py-1 text-[12px] shadow-2xl"
      style={{ left: pos.x, top: pos.y, minWidth }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, k) =>
        it.sep ? (
          <div key={k} className="my-1 h-px bg-line" />
        ) : (
          <div key={k} className="relative" onMouseEnter={() => setOpen(it.sub ? k : null)}>
            <button
              type="button"
              role="menuitem"
              disabled={it.disabled}
              title={it.hint}
              onClick={() => {
                if (it.sub) return setOpen(k);
                onClose();
                it.run?.();
              }}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-4 disabled:opacity-40",
                it.danger ? "text-danger" : "text-ink",
              )}
            >
              <span className="w-3 text-accent-fg">{it.checked ? "✓" : ""}</span>
              <span className="flex-1">{it.label}</span>
              {it.key && <kbd className="font-mono text-[10px] text-ink-4">{it.key}</kbd>}
              {it.sub && <span className="text-ink-4">›</span>}
            </button>
            {it.sub && open === k && (
              <div className="absolute left-full top-0 rounded-lg border border-line-2 bg-surface py-1 shadow-2xl" style={{ minWidth: 200 }}>
                {it.sub.map((s, j) => (
                  <button
                    key={j}
                    type="button"
                    disabled={s.disabled}
                    onClick={() => {
                      onClose();
                      s.run?.();
                    }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-ink hover:bg-surface-4 disabled:opacity-40"
                  >
                    <span className="w-3 text-accent-fg">{s.checked ? "✓" : ""}</span>
                    <span className="flex-1">{s.label}</span>
                    {s.key && <kbd className="font-mono text-[10px] text-ink-4">{s.key}</kbd>}
                  </button>
                ))}
              </div>
            )}
          </div>
        ),
      )}
    </div>,
    document.body,
  );
}

/** A slider with its value typed next to it (custom value one click away). */
export function Slide({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
  onCommit,
  digits,
  title,
  reset,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (v: number) => void;
  onCommit: (v: number) => void;
  digits?: number;
  title?: string;
  reset?: number;
}) {
  const d = digits ?? (step < 1 ? (step < 0.1 ? 2 : 1) : 0);
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label className="block" title={title}>
      <span className="flex items-center justify-between gap-2 text-[11px] text-ink-3">
        <span onDoubleClick={() => reset !== undefined && onCommit(reset)} title={reset !== undefined ? "Double-click to reset" : undefined}>
          {label}
        </span>
        <span className="flex items-center gap-0.5">
          <input
            value={draft ?? value.toFixed(d)}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={(e) => e.target.select()}
            onBlur={() => {
              if (draft !== null) {
                const n = Number(draft.replace(",", "."));
                if (Number.isFinite(n)) onCommit(Math.max(min, Math.min(max * 4, n)));
              }
              setDraft(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") {
                setDraft(null);
                (e.target as HTMLInputElement).blur();
              }
            }}
            className="w-12 rounded border border-transparent bg-transparent px-1 text-right font-mono text-[11px] text-ink-2 hover:border-line focus:border-accent focus:outline-none"
          />
          {unit && <span className="font-mono text-[10px] text-ink-4">{unit}</span>}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={Math.min(max, Math.max(min, value))}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={(e) => onCommit(Number((e.target as HTMLInputElement).value))}
        onKeyUp={(e) => onCommit(Number((e.target as HTMLInputElement).value))}
        className="w-full accent-[var(--color-accent)]"
      />
    </label>
  );
}

/** A section with a title that opens and closes (remembered). */
export function Section({ id, title, children, extra, defaultOpen = true }: { id: string; title: string; children: ReactNode; extra?: ReactNode; defaultOpen?: boolean }) {
  const key = `lastshot.editor.sec.${id}`;
  const [open, setOpen] = useState(() => {
    try {
      const v = localStorage.getItem(key);
      return v === null ? defaultOpen : v === "1";
    } catch {
      return defaultOpen;
    }
  });
  return (
    <div className="border-b border-line py-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            setOpen(!open);
            try {
              localStorage.setItem(key, open ? "0" : "1");
            } catch {
              /* private */
            }
          }}
          className="flex flex-1 items-center gap-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-3 hover:text-ink"
        >
          <span className="w-2.5 text-[9px]">{open ? "▼" : "▶"}</span>
          {title}
        </button>
        {extra}
      </div>
      {open && <div className="mt-2 space-y-2.5">{children}</div>}
    </div>
  );
}

export function Seg<T extends string | number>({ value, options, onChange, title }: { value: T; options: { v: T; label: string; title?: string }[]; onChange: (v: T) => void; title?: string }) {
  return (
    <div className="flex flex-wrap gap-1" title={title}>
      {options.map((o) => (
        <button
          key={String(o.v)}
          type="button"
          title={o.title}
          onClick={() => onChange(o.v)}
          className={cn(
            "rounded-md border px-2 py-1 text-[11px]",
            o.v === value ? "border-accent bg-accent/15 text-accent-fg" : "border-line bg-surface-2 text-ink-2 hover:text-ink",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Remembers a small UI state in localStorage (panels open, sizes). */
export function usePersist<T>(key: string, init: T): [T, (v: T | ((p: T) => T)) => void] {
  const k = `lastshot.editor.ui.${key}`;
  const [v, setV] = useState<T>(() => {
    try {
      const s = localStorage.getItem(k);
      return s === null ? init : (JSON.parse(s) as T);
    } catch {
      return init;
    }
  });
  const set = (x: T | ((p: T) => T)) =>
    setV((prev) => {
      const next = typeof x === "function" ? (x as (p: T) => T)(prev) : x;
      try {
        localStorage.setItem(k, JSON.stringify(next));
      } catch {
        /* private */
      }
      return next;
    });
  return [v, set];
}
