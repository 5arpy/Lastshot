import { useState } from "react";
import { cn } from "../utils/cn";
import { PALETTE, type Shape, type Style, type Tool } from "./shapes";

/**
 * Style and arrange controls for annotation objects: colour, fill, width,
 * opacity, text settings, and flip / turn / order / duplicate / lock /
 * delete. With nothing selected they set the style new objects get.
 * Shared by the video editor's inspector and the screenshot window.
 */

export const TOOLS: { id: Tool; label: string; key: string; icon: string }[] = [
  { id: "select", label: "Select and move", key: "V", icon: "M3 2l9 5-4 1.5L6.5 13z" },
  { id: "text", label: "Text", key: "T", icon: "M3 3h10M8 3v10M6 13h4" },
  { id: "rect", label: "Rectangle", key: "R", icon: "M2.5 4h11v8h-11z" },
  { id: "ellipse", label: "Ellipse", key: "E", icon: "M8 3.5c3.3 0 6 2 6 4.5s-2.7 4.5-6 4.5S2 10.5 2 8s2.7-4.5 6-4.5z" },
  { id: "arrow", label: "Arrow", key: "A", icon: "M3 13L13 3M7 3h6v6" },
  { id: "line", label: "Line", key: "Shift+A", icon: "M3 13L13 3" },
  { id: "pen", label: "Pen", key: "P", icon: "M3 13c2-1 3-5 5-6s3 2 5 0" },
  { id: "highlight", label: "Highlighter", key: "H", icon: "M3 11l6-6 3 3-6 6H3zM9 5l2-2 3 3-2 2" },
  { id: "step", label: "Number step", key: "U", icon: "M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM7 6l1.5-1v6" },
  { id: "pixelate", label: "Pixelate (hide names, chat)", key: "Shift+B", icon: "M3 3h3v3H3zM8 3h3v3H8zM5.5 7.5h3v3h-3zM3 10h3v3H3zM10 10h3v3h-3z" },
  { id: "blur", label: "Blur", key: "", icon: "M8 2c2.5 3 4 5 4 7a4 4 0 0 1-8 0c0-2 1.5-4 4-7z" },
  { id: "redact", label: "Black box (redact)", key: "", icon: "M2.5 5h11v6h-11z" },
  { id: "spotlight", label: "Spotlight (dim the rest)", key: "", icon: "M1.5 2.5h13v11h-13zM5 6h6v4H5z" },
];

const WIDTHS = [2, 4, 6, 10, 16];
const SIZES = [24, 36, 48, 64, 96, 140];

export interface ArrangeActions {
  flip: (axis: "x" | "y") => void;
  rotate: (deg: number) => void;
  duplicate: () => void;
  remove: () => void;
  order: (dir: number) => void;
  lock: () => void;
  align?: (how: "left" | "centre" | "right" | "top" | "middle" | "bottom") => void;
}

function Chip({ on, onClick, title, children }: { on?: boolean; onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        "grid h-7 min-w-7 place-items-center rounded-md border px-1.5 text-[11px]",
        on ? "border-accent bg-accent/15 text-accent-fg" : "border-line bg-surface-2 text-ink-2 hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

const svg = (d: string) => (
  <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-none stroke-current" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);

export default function StyleControls({
  selected,
  style,
  onStyle,
  onPatch,
  arrange,
  tool,
}: {
  selected: Shape[];
  style: Style;
  onStyle: (p: Partial<Style>) => void;
  /** Changes every selected object; `commit` false while a slider moves. */
  onPatch: (p: (s: Shape) => Partial<Shape>, commit: boolean, label: string) => void;
  arrange: ArrangeActions;
  tool: Tool;
}) {
  const first = selected[0];
  const hasText = first ? selected.some((s) => s.kind === "text") : tool === "text";
  const hasStroke = first ? selected.some((s) => !["text", "image", "blur", "pixelate", "redact", "step"].includes(s.kind)) : !["text", "select", "blur", "pixelate", "redact", "step"].includes(tool);
  const hasFill = first ? selected.some((s) => s.kind === "rect" || s.kind === "ellipse" || s.kind === "text") : ["rect", "ellipse", "text"].includes(tool);
  const censor = first ? selected.some((s) => s.kind === "blur" || s.kind === "pixelate") : tool === "blur" || tool === "pixelate";
  const color = first?.color ?? style.color;
  const fill = first ? first.fill ?? null : style.fill;
  const width = first?.width ?? style.width;
  const opacity = first?.opacity ?? style.opacity;
  const size = first?.size ?? style.size;
  const [custom, setCustom] = useState(false);

  /** Sets a value on the selection, and as the default for new objects. */
  const set = (p: Partial<Style> & Partial<Shape>, label: string, commit = true) => {
    const styleKeys = ["color", "fill", "width", "opacity", "size", "bold", "italic", "align", "outline", "shadow", "dash"] as const;
    const sp: Partial<Style> = {};
    for (const k of styleKeys) if (k in p) (sp as Record<string, unknown>)[k] = (p as Record<string, unknown>)[k];
    if (Object.keys(sp).length) onStyle(sp);
    if (selected.length) onPatch(() => p as Partial<Shape>, commit, label);
  };

  return (
    <div className="space-y-2.5 text-[11px] text-ink-3">
      {!censor && (
        <div>
          <div className="mb-1">Colour</div>
          <div className="flex flex-wrap items-center gap-1">
            {PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                title={c}
                onClick={() => set({ color: c }, "Colour")}
                className={cn("h-6 w-6 rounded-full border-2", color.toLowerCase() === c ? "border-accent" : "border-line")}
                style={{ background: c }}
              />
            ))}
            <label className="relative h-6 w-6 cursor-pointer overflow-hidden rounded-full border-2 border-dashed border-line" title="Any colour">
              <input type="color" value={/^#[0-9a-f]{6}$/i.test(color) ? color : "#ffffff"} onChange={(e) => set({ color: e.target.value }, "Colour", false)} onBlur={(e) => set({ color: e.target.value }, "Colour")} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" />
              <span className="pointer-events-none grid h-full place-items-center text-[11px] text-ink-3">+</span>
            </label>
            {"EyeDropper" in window && (
              <button
                type="button"
                title="Pick a colour from the screen"
                onClick={() => {
                  const ED = (window as unknown as { EyeDropper: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper;
                  void new ED()
                    .open()
                    .then((r) => set({ color: r.sRGBHex }, "Colour"))
                    .catch(() => undefined);
                }}
                className="grid h-6 w-6 place-items-center rounded-full border-2 border-line text-ink-3 hover:text-ink"
              >
                <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10 2.5l3.5 3.5M11.5 4.5L5 11l-2.5.5.5-2.5L9.5 2.5" />
                </svg>
              </button>
            )}
            <HexField value={color} onCommit={(c) => set({ color: c }, "Colour")} />
          </div>
        </div>
      )}
      {hasFill && (
        <div className="flex items-center gap-1.5">
          <span className="w-14">{hasText && !hasStroke ? "Label" : "Fill"}</span>
          <Chip on={!fill} onClick={() => set({ fill: null }, "Fill")} title="No fill">
            None
          </Chip>
          {["#000000b0", "#ffffff", "#ff4d4f", "#ffc53d", "#4096ff"].map((c) => (
            <button key={c} type="button" title={c} onClick={() => set({ fill: c }, "Fill")} className={cn("h-6 w-6 rounded border-2", fill === c ? "border-accent" : "border-line")} style={{ background: c }} />
          ))}
        </div>
      )}
      {hasStroke && (
        <div className="flex items-center gap-1.5">
          <span className="w-14">Width</span>
          {WIDTHS.map((w) => (
            <Chip key={w} on={Math.round(width) === w} onClick={() => set({ width: w }, "Width")} title={`${w} px`}>
              <span className="rounded-full bg-current" style={{ width: Math.min(14, w + 2), height: Math.min(14, w + 2) }} />
            </Chip>
          ))}
          <Chip on={!!(first ? first.dash : style.dash)} onClick={() => set({ dash: !(first ? first.dash : style.dash) }, "Dashes")} title="Dashed line">
            - -
          </Chip>
        </div>
      )}
      {hasText && (
        <>
          <div className="flex flex-wrap items-center gap-1">
            <span className="w-14">Size</span>
            {SIZES.map((s) => (
              <Chip key={s} on={Math.round(size) === s} onClick={() => set({ size: s }, "Text size")} title={`${s} px`}>
                {s}
              </Chip>
            ))}
            {custom ? (
              <input
                autoFocus
                defaultValue={Math.round(size)}
                onBlur={(e) => {
                  const n = Number(e.target.value);
                  if (n >= 6 && n <= 800) set({ size: n }, "Text size");
                  setCustom(false);
                }}
                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                className="w-12 rounded border border-accent bg-surface px-1 py-0.5 text-ink"
              />
            ) : (
              <Chip onClick={() => setCustom(true)} title="Type a size">
                …
              </Chip>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <span className="w-14">Text</span>
            <Chip on={(first?.bold ?? style.bold) !== false} onClick={() => set({ bold: !((first?.bold ?? style.bold) !== false) }, "Bold")} title="Bold">
              <b>B</b>
            </Chip>
            <Chip on={!!(first?.italic ?? style.italic)} onClick={() => set({ italic: !(first?.italic ?? style.italic) }, "Italic")} title="Italic">
              <i>I</i>
            </Chip>
            {(["left", "center", "right"] as const).map((a) => (
              <Chip key={a} on={(first?.align ?? style.align) === a} onClick={() => set({ align: a }, "Align")} title={`Align ${a}`}>
                {svg(a === "left" ? "M2 4h12M2 8h8M2 12h10" : a === "center" ? "M2 4h12M4 8h8M3 12h10" : "M2 4h12M6 8h8M4 12h10")}
              </Chip>
            ))}
            <Chip on={!!(first ? first.outline : style.outline)} onClick={() => set({ outline: (first ? first.outline : style.outline) ? null : "#000000" }, "Outline")} title="Outline around the letters">
              <span style={{ WebkitTextStroke: "1px currentColor", color: "transparent", fontWeight: 800 }}>O</span>
            </Chip>
            <Chip on={!!(first?.shadow ?? style.shadow)} onClick={() => set({ shadow: !(first?.shadow ?? style.shadow) }, "Shadow")} title="Shadow">
              <span style={{ textShadow: "1px 1px 1px currentColor" }}>S</span>
            </Chip>
          </div>
        </>
      )}
      {censor && first && (
        <label className="block">
          <span className="flex justify-between">
            Strength <span className="font-mono">{Math.round(first.strength ?? 16)}</span>
          </span>
          <input type="range" min={4} max={60} value={first.strength ?? 16} onChange={(e) => onPatch(() => ({ strength: Number(e.target.value) }), false, "Strength")} onPointerUp={(e) => onPatch(() => ({ strength: Number((e.target as HTMLInputElement).value) }), true, "Strength")} className="w-full accent-[var(--color-accent)]" />
        </label>
      )}
      {!censor && (
        <label className="block">
          <span className="flex justify-between">
            Opacity <span className="font-mono">{Math.round(opacity * 100)} %</span>
          </span>
          <input
            type="range"
            min={5}
            max={100}
            value={Math.round(opacity * 100)}
            onChange={(e) => set({ opacity: Number(e.target.value) / 100 }, "Opacity", false)}
            onPointerUp={(e) => set({ opacity: Number((e.target as HTMLInputElement).value) / 100 }, "Opacity")}
            className="w-full accent-[var(--color-accent)]"
          />
        </label>
      )}
      {first && (
        <div className="flex flex-wrap gap-1 pt-1">
          <Chip onClick={() => arrange.flip("x")} title="Flip horizontally (Shift+H)">
            {svg("M8 2v12M6 4L2 12h4zM10 4l4 8h-4z")}
          </Chip>
          <Chip onClick={() => arrange.flip("y")} title="Flip vertically (Shift+V)">
            {svg("M2 8h12M4 6L12 2v4zM4 10l8 4v-4z")}
          </Chip>
          <Chip onClick={() => arrange.rotate(-90)} title="Turn 90° left (Ctrl+Shift+R)">
            {svg("M3 8a5 5 0 1 0 1.5-3.5M3 2v3h3")}
          </Chip>
          <Chip onClick={() => arrange.rotate(90)} title="Turn 90° right (Shift+R)">
            {svg("M13 8a5 5 0 1 1-1.5-3.5M13 2v3h-3")}
          </Chip>
          <Chip onClick={() => arrange.order(Infinity)} title="Bring to front (Ctrl+Shift+])">
            {svg("M2 2h8v8H2zM6 6h8v8H6z")}
          </Chip>
          <Chip onClick={() => arrange.order(-Infinity)} title="Send to back (Ctrl+Shift+[)">
            {svg("M6 6h8v8H6zM2 2h8v8H2z")}
          </Chip>
          <Chip onClick={arrange.duplicate} title="Duplicate (Ctrl+D)">
            {svg("M5 5h8v9H5zM3 11V2h8")}
          </Chip>
          <Chip on={!!first.locked} onClick={arrange.lock} title="Lock / unlock (Ctrl+Shift+L)">
            {svg(first.locked ? "M4 7h8v7H4zM5.5 7V5a2.5 2.5 0 0 1 5 0v2" : "M4 7h8v7H4zM5.5 7V5a2.5 2.5 0 0 1 5-.5")}
          </Chip>
          <Chip onClick={arrange.remove} title="Delete (Del)">
            {svg("M3 4h10M6 4V2.5h4V4M4.5 4l.7 9.5h5.6l.7-9.5")}
          </Chip>
          {arrange.align && selected.length > 0 && (
            <>
              {(
                [
                  ["left", "M2 2v12M5 4h8v3H5zM5 9h5v3H5z", "Align left"],
                  ["centre", "M8 2v12M3 4h10v3H3zM5 9h6v3H5z", "Centre horizontally"],
                  ["right", "M14 2v12M3 4h8v3H3zM6 9h5v3H6z", "Align right"],
                  ["top", "M2 2h12M4 5v8h3V5zM9 5v5h3V5z", "Align top"],
                  ["middle", "M2 8h12M4 3v10h3V3zM9 5v6h3V5z", "Centre vertically"],
                  ["bottom", "M2 14h12M4 3v8h3V3zM9 6v5h3V6z", "Align bottom"],
                ] as const
              ).map(([k, d, t]) => (
                <Chip key={k} onClick={() => arrange.align!(k)} title={`${t} (${selected.length > 1 ? "to each other" : "to the frame"})`}>
                  {svg(d)}
                </Chip>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Colour as text (#rrggbb or #rgb); Enter or leaving the field applies it. */
function HexField({ value, onCommit }: { value: string; onCommit: (c: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const v = draft.trim().replace(/^#?/, "#");
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
    if (m) onCommit(m[1].length === 3 ? `#${[...m[1]].map((c) => c + c).join("")}`.toLowerCase() : v.toLowerCase());
    setDraft(null);
  };
  return (
    <input
      value={draft ?? value}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setDraft(null);
      }}
      title="Colour code (#rrggbb)"
      spellCheck={false}
      className="h-6 w-[72px] rounded border border-line bg-surface-2 px-1.5 font-mono text-[11px] text-ink focus:border-accent focus:outline-none"
    />
  );
}
