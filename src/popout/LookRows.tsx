/**
 * A pop-out's look: background behind the picture, outline (width and
 * colour) and, in the panel, the edge shadow. Used by a frame's right-click
 * menu and by the Pop-outs panel in the main window.
 *
 * Typed colours need a window that takes the keyboard: the panel and board
 * frames do; picture and clip frames never take the focus (the app you work
 * in keeps it), so their menu offers the presets and a link to the panel.
 */
import type { ReactNode } from "react";
import { cn } from "../utils/cn";
import { hexColor, LOOK_SWATCHES, type FrameLook } from "./frames";

export default function LookRows({
  look,
  set,
  typed,
  variant,
  onTypeElsewhere,
}: {
  look: FrameLook;
  set: (l: FrameLook) => void;
  /** Show the typed #rrggbb fields (only where the keyboard can reach them). */
  typed: boolean;
  variant: "menu" | "panel";
  /** Where typed colours live when this window cannot take them (the menu of a picture frame). */
  onTypeElsewhere?: () => void;
}) {
  const panel = variant === "panel";
  const chip = (label: string, on: boolean, run: () => void, testid?: string, swatch?: string): ReactNode => (
    <button
      key={label}
      type="button"
      title={swatch ? `Colour ${label}` : label}
      data-testid={testid}
      onClick={run}
      className={cn(
        panel ? "inline-flex h-6 min-w-6 items-center justify-center rounded px-1.5 text-[10.5px] font-semibold transition-colors" : "rounded px-1.5 py-0.5 font-mono text-[10px]",
        panel ? (on ? "bg-accent text-white" : "bg-surface-2 text-ink-3 hover:text-ink") : on ? "bg-[#5d72db] text-white" : "bg-white/10 text-white/80 hover:bg-white/20",
      )}
    >
      {swatch ? <span className={cn("block h-2.5 w-2.5 rounded-sm border", panel ? "border-line-3" : "border-white/40")} style={{ background: swatch }} /> : label}
    </button>
  );
  const field = (cur: string, apply: (c: string) => void, label: string, testid: string): ReactNode =>
    typed ? (
      <input
        key={`${label}-${cur}`}
        defaultValue={cur}
        aria-label={label}
        title={`${label}: type #rrggbb, then Enter`}
        placeholder="#rrggbb"
        data-testid={testid}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            const c = hexColor((e.target as HTMLInputElement).value);
            if (c) apply(c);
          }
        }}
        onBlur={(e) => {
          const c = hexColor(e.target.value);
          if (c && c !== cur) apply(c);
        }}
        className={cn(
          "w-[64px] rounded border px-1 font-mono text-[10px] focus:outline-none",
          panel ? "h-6 border-line bg-surface-2 text-ink-2 focus:border-line-3" : "border-white/15 bg-black/30 text-white/85 focus:border-white/40",
        )}
      />
    ) : onTypeElsewhere ? (
      <button
        key={label}
        type="button"
        title={`${label}: type any #rrggbb in Lastshot's Pop-outs panel (this frame never takes the keyboard)`}
        data-testid={testid}
        onClick={onTypeElsewhere}
        className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10px] text-white/70 hover:bg-white/20"
      >
        #…
      </button>
    ) : null;
  const label = (t: string) => <span className={cn("shrink-0", panel ? "w-12" : "w-[62px]")}>{t}</span>;
  const indent = panel ? "pl-14" : "pl-[66px]";
  return (
    <div className={cn(panel ? "mt-2 text-[11px] text-ink-3" : "px-2 py-1 text-[11px] text-white/60")} data-testid={panel ? "frame-row-look" : "frame-menu-look"}>
      <div className="mb-1 flex flex-wrap items-center gap-1">
        {label("Background")}
        {(["none", "dark", "light", "checker"] as const).map((b) => chip(b === "none" ? "None" : b[0].toUpperCase() + b.slice(1), look.bg === b, () => set({ ...look, bg: b }), `frame-bg-${b}`))}
      </div>
      <div className={cn("mb-1 flex flex-wrap items-center gap-1", indent)}>
        {LOOK_SWATCHES.map((c) => chip(c, look.bg === "custom" && look.color === c, () => set({ ...look, bg: "custom", color: c }), undefined, c))}
        {field(look.bg === "custom" ? look.color : "", (c) => set({ ...look, bg: "custom", color: c }), "Background colour", "frame-bg-typed")}
      </div>
      <div className="mb-1 flex flex-wrap items-center gap-1">
        {label("Outline")}
        {[0, 1, 2, 4].map((w) => chip(w === 0 ? "Off" : `${w}px`, look.border === w, () => set({ ...look, border: w }), `frame-border-${w}`))}
        {panel && chip("Shadow", look.shadow, () => set({ ...look, shadow: !look.shadow }), "frame-row-shadow")}
      </div>
      {look.border > 0 && (
        <div className={cn("flex flex-wrap items-center gap-1", indent)}>
          {chip("Auto", !look.borderColor, () => set({ ...look, borderColor: "" }), "frame-border-auto")}
          {LOOK_SWATCHES.slice(1).map((c) => chip(c, look.borderColor === c, () => set({ ...look, borderColor: c }), undefined, c))}
          {field(look.borderColor, (c) => set({ ...look, borderColor: c }), "Outline colour", "frame-border-typed")}
        </div>
      )}
    </div>
  );
}
