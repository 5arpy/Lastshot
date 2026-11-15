import { useState, type ReactNode } from "react";
import { cn } from "../utils/cn";

/** One labelled settings row: label + hint on the left, control on the right. */
export function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-line py-3.5 last:border-0">
      <div className="min-w-0 pr-2">
        <div className="text-[13px] font-medium text-ink">{label}</div>
        {hint && <div className="mt-0.5 text-[12px] leading-normal text-ink-3">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "group relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out",
        on ? "bg-accent hover:bg-accent-hover" : "bg-ink-5 hover:bg-ink-4",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-sm ring-1 ring-black/10 transition-transform duration-200 ease-in-out",
          on ? "translate-x-5" : "translate-x-0",
        )}
      />
    </button>
  );
}

function readOpen(key: string): boolean {
  try {
    return localStorage.getItem(`lastshot.adv.${key}`) === "1";
  } catch {
    return false;
  }
}

function writeOpen(key: string, open: boolean) {
  try {
    localStorage.setItem(`lastshot.adv.${key}`, open ? "1" : "0");
  } catch {
    /* storage unavailable: the toggle still works for this session */
  }
}

/**
 * A settings card. The everyday options are always visible; anything passed as
 * `advanced` sits behind this section's own "Advanced" button, so each feature
 * keeps its expert knobs out of the way without one global switch.
 */
export function Section({
  id,
  title,
  description,
  children,
  advanced,
  advancedLabel = "Advanced",
}: {
  id: string;
  title: string;
  description?: string;
  children?: ReactNode;
  advanced?: ReactNode;
  advancedLabel?: string;
}) {
  const [open, setOpen] = useState(() => readOpen(id));
  return (
    <section className="panel rounded-xl px-5 pt-4 pb-2">
      <div className="flex items-start justify-between gap-3 border-b border-line pb-3">
        <div className="min-w-0">
          <h3 className="text-[14px] font-semibold text-ink">{title}</h3>
          {description && <p className="mt-0.5 text-[12px] text-ink-3">{description}</p>}
        </div>
        {advanced && (
          <AdvancedButton
            open={open}
            label={advancedLabel}
            onClick={() => {
              setOpen(!open);
              writeOpen(id, !open);
            }}
          />
        )}
      </div>
      {children}
      {advanced && open && (
        <div className="animate-fade -mx-5 mt-1 border-t border-line bg-surface-3/60 px-5 pb-1">
          {advanced}
        </div>
      )}
    </section>
  );
}

/** Small chevron button that shows or hides a feature's advanced options. */
export function AdvancedButton({
  open,
  onClick,
  label = "Advanced",
}: {
  open: boolean;
  onClick: () => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={open}
      className={cn(
        "flex shrink-0 items-center gap-1 rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors",
        open
          ? "border-accent/40 bg-accent/10 text-accent-fg"
          : "border-line bg-surface-2 text-ink-3 hover:text-ink",
      )}
    >
      {label}
      <svg
        viewBox="0 0 12 12"
        className={cn("h-3 w-3 fill-none stroke-current transition-transform", open && "rotate-180")}
        strokeWidth="1.6"
      >
        <path d="M3 4.5l3 3 3-3" />
      </svg>
    </button>
  );
}

/** Persisted open/closed state for an Advanced toggle outside a Section. */
export function useAdvanced(id: string): [boolean, () => void] {
  const [open, setOpen] = useState(() => readOpen(id));
  return [
    open,
    () => {
      setOpen((v) => {
        writeOpen(id, !v);
        return !v;
      });
    },
  ];
}

/** Row of small choice buttons (presets). */
export function Choice<T extends string | number>({
  options,
  value,
  onPick,
}: {
  options: { value: T; label: string }[];
  value: T;
  onPick: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          onClick={() => onPick(o.value)}
          className={cn(
            "rounded border px-2.5 py-1 font-mono text-[11px] transition-colors",
            value === o.value
              ? "border-accent bg-accent font-semibold text-white"
              : "border-line bg-surface-2 text-ink-3 hover:text-ink",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
