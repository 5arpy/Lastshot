/** Small building blocks for the viewer's floating bars (dark, over pictures). */
import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "../utils/cn";

export function Btn({
  title,
  on,
  onClick,
  children,
  disabled,
  wide,
  className,
}: {
  title: string;
  on?: boolean;
  onClick: (e: React.MouseEvent) => void;
  children: ReactNode;
  disabled?: boolean;
  wide?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={on}
      disabled={disabled}
      onClick={onClick}
      onPointerDown={(e) => e.stopPropagation()}
      className={cn(
        "grid h-7 shrink-0 place-items-center rounded-md text-[11px] font-medium transition-colors disabled:opacity-35",
        wide ? "px-2" : "w-7",
        on ? "bg-[#5d72db] text-white" : "text-white/80 hover:bg-white/12 hover:text-white",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Icon({ d, fill }: { d: string; fill?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" className={cn("h-4 w-4", fill ? "fill-current" : "fill-none stroke-current")} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

export const Sep = () => <span className="mx-0.5 h-5 w-px shrink-0 bg-white/15" />;

/** A panel that opens under a bar button and closes on outside clicks / Esc. */
export function Pop({ open, onClose, children, className }: { open: boolean; onClose: () => void; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
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
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div
      ref={ref}
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      className={cn(
        "viewer-pop absolute z-30 mt-1 min-w-[220px] rounded-lg border border-white/10 bg-[#1c1e25]/97 p-2.5 text-[11px] text-white/85 shadow-2xl backdrop-blur",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  fmt,
  title,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  fmt?: (v: number) => string;
  title?: string;
}) {
  return (
    <label className="flex items-center gap-2 py-0.5" title={title}>
      <span className="w-[74px] shrink-0 text-white/65">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onDoubleClick={() => onChange(Number(((min + max) / 2).toFixed(4)))}
        className="h-1 min-w-0 flex-1 accent-[#7d8ff0]"
      />
      <span className="w-10 shrink-0 text-right font-mono text-[10px] text-white/70">{fmt ? fmt(value) : value}</span>
    </label>
  );
}

export function Chip({ on, onClick, children, title }: { on?: boolean; onClick: () => void; children: ReactNode; title?: string }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        "rounded px-2 py-0.5 text-[11px] transition-colors",
        on ? "bg-[#5d72db] text-white" : "bg-white/8 text-white/75 hover:bg-white/15",
      )}
    >
      {children}
    </button>
  );
}

/** Icon paths (16×16 grid). */
export const I = {
  fit: "M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4",
  fill: "M2 2h12v12H2zM5 5h6v6H5z",
  rotL: "M3 8a5 5 0 1 0 1.5-3.5M3 2v3h3",
  rotR: "M13 8a5 5 0 1 1-1.5-3.5M13 2v3h-3",
  free: "M3 13h10M3 13L11 4M7 13a4 4 0 0 0-1-3",
  mirror: "M8 2v12M6 4L2 12h4zM10 4l4 8h-4z",
  flipV: "M2 8h12M4 6L12 2v4zM4 10l8 4v-4z",
  value: "M8 2a6 6 0 1 0 0 12zM8 2a6 6 0 0 1 0 12",
  grid: "M2 2h12v12H2zM6 2v12M10 2v12M2 6h12M2 10h12",
  picker: "M10 2l4 4-7 7H3v-4zM8.5 3.5l4 4",
  measure: "M2 11l9-9 3 3-9 9zM5 8l1.5 1.5M7 6l1.5 1.5M9 4l1.5 1.5",
  crop: "M4 1v11h11M1 4h11v11",
  compare: "M8 1v14M2 3h4v10H2zM10 3h4v10h-4z",
  colour: "M8 2c3 3.5 4.5 5.8 4.5 8a4.5 4.5 0 0 1-9 0C3.5 7.8 5 5.5 8 2z",
  copy: "M5 5h8v9H5zM3 11V2h8",
  save: "M3 2h8l2 2v10H3zM5 2v4h5V2M5 14V9h6v5",
  reset: "M2.5 8a5.5 5.5 0 1 0 2-4.2M2 2v3h3",
  undo: "M5 4 2 7l3 3M2 7h7.5a4 4 0 0 1 0 8H7",
  redo: "M11 4l3 3-3 3M14 7H6.5a4 4 0 0 0 0 8H9",
  help: "M6 6a2 2 0 1 1 3 1.7c-.6.4-1 .8-1 1.6M8 12v.5",
  popout: "M9 2h5v5M14 2L7 9M12 10v4H2V4h4",
  onion: "M8 3a5 5 0 1 0 0 10A5 5 0 0 0 8 3zM5 3.5a5 5 0 0 0 0 9M11 3.5a5 5 0 0 1 0 9",
  prev: "M10 3L5 8l5 5",
  next: "M6 3l5 5-5 5",
  prev10: "M8 3L3 8l5 5M13 3L8 8l5 5",
  next10: "M3 3l5 5-5 5M8 3l5 5-5 5",
  loop: "M3 7V6a2 2 0 0 1 2-2h7l-2-2M13 9v1a2 2 0 0 1-2 2H4l2 2",
  play: "M5 3l8 5-8 5z",
  pause: "M5 3h2v10H5zM9 3h2v10H9z",
};
