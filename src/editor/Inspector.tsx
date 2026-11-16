import { useState } from "react";
import StyleControls, { type ArrangeActions } from "../annotate/StyleControls";
import type { Shape, Style, Tool } from "../annotate/shapes";
import { formatBytes } from "../lib/format";
import { shownPath } from "../lib/pathDisplay";
import type { ClipMetadata } from "../lib/types";
import { timecode, parseTime } from "../timeline/view";
import { cn } from "../utils/cn";
import { DEFAULT_FX, type AudioFx, type EdItem, type EdProject, type Picture, outputFps, outputSize } from "./project";
import { Ico, I, Section, Seg, Slide } from "./ui";

/**
 * The right-hand panel: what the selection is and its settings. Good
 * defaults show first; custom values are typed next to every slider.
 */

export interface InspectorProps {
  p: EdProject;
  sel: EdItem[];
  /** commit false = still dragging (one undo step per drag). */
  patchItems: (fn: (it: EdItem) => Partial<EdItem>, commit: boolean, label: string) => void;
  patchProject: (patch: Partial<EdProject>, label: string) => void;
  /** Places an item at a time / gives it a length (keeps the track tidy). */
  onMoveTo: (id: string, t: number) => void;
  onLength: (id: string, d: number) => void;
  // Annotations
  style: Style;
  onStyle: (p: Partial<Style>) => void;
  tool: Tool;
  arrange: ArrangeActions;
  onCrop: (it: EdItem) => void;
  onDetachAudio: () => void;
  onAudioExport: () => void;
  // The clip the project was opened from
  clip: ClipMetadata | null;
  flushMs?: number;
  clipActions: ClipActions | null;
  fps: number;
}

export interface ClipActions {
  rename: (name: string) => void;
  favorite: () => void;
  tags: (tags: string[]) => void;
  reveal: () => void;
  openExternal: () => void;
  copyFile: () => void;
  moveToLibrary?: () => void;
  splitFile: () => void;
  discard: () => void;
}

const SIZES: { v: string; label: string; w: number; h: number }[] = [
  { v: "1920x1080", label: "1080p wide", w: 1920, h: 1080 },
  { v: "1280x720", label: "720p wide", w: 1280, h: 720 },
  { v: "2560x1440", label: "1440p", w: 2560, h: 1440 },
  { v: "1080x1920", label: "Vertical 9:16", w: 1080, h: 1920 },
  { v: "1080x1080", label: "Square", w: 1080, h: 1080 },
];

function TimeField({ label, value, fps, onCommit }: { label: string; value: number; fps: number; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label className="flex items-center justify-between gap-2 text-[11px] text-ink-3" title="Type a time (1:05.10, 65.2) or +2 / -0.5 to move by that much">
      {label}
      <input
        value={draft ?? timecode(value, fps)}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={() => {
          if (draft !== null) {
            const t = parseTime(draft, value);
            if (t !== null && t >= 0) onCommit(t);
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
        className="w-24 rounded border border-line bg-surface-2 px-1.5 py-0.5 text-right font-mono text-[11px] text-ink focus:border-accent focus:outline-none"
      />
    </label>
  );
}

function Toggle({ on, onClick, children, title }: { on: boolean; onClick: () => void; children: React.ReactNode; title?: string }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn("rounded-md border px-2 py-1 text-[11px]", on ? "border-accent bg-accent/15 text-accent-fg" : "border-line bg-surface-2 text-ink-2 hover:text-ink")}
    >
      {children}
    </button>
  );
}

function AudioSection({ items, patch, onDetach, onExport }: { items: EdItem[]; patch: InspectorProps["patchItems"]; onDetach?: () => void; onExport: () => void }) {
  const fx: AudioFx = { ...DEFAULT_FX, ...items[0].audio };
  const set = (p: Partial<AudioFx>, commit: boolean, label: string) => patch((it) => (it.kind === "audio" || it.hasAudio ? { audio: { ...DEFAULT_FX, ...it.audio, ...p } } : {}), commit, label);
  const eq = fx.eq ?? [0, 0, 0];
  const db = (v: number) => (v > 0 ? 20 * Math.log10(v) : -Infinity);
  return (
    <Section id="audio" title="Sound" extra={<span className="font-mono text-[10px] text-ink-4">{fx.muted ? "muted" : `${Math.round(fx.volume * 100)} %`}</span>}>
      <div className="flex flex-wrap gap-1">
        <Toggle on={!!fx.muted} onClick={() => set({ muted: !fx.muted }, true, "Mute")}>
          {fx.muted ? "Muted" : "Mute"}
        </Toggle>
        <Toggle on={!!fx.normalize} onClick={() => set({ normalize: !fx.normalize }, true, "Normalise")} title="Make it as loud as it can go without clipping (-1 dB peak)">
          Normalise
        </Toggle>
        {onDetach && (
          <Toggle on={false} onClick={onDetach} title="Puts the clip's sound on an audio track of its own (Ctrl+Shift+D)">
            Detach audio
          </Toggle>
        )}
      </div>
      <Slide
        label={`Volume (${Number.isFinite(db(fx.volume)) ? `${db(fx.volume) >= 0 ? "+" : ""}${db(fx.volume).toFixed(1)} dB` : "off"})`}
        value={fx.volume * 100}
        min={0}
        max={400}
        step={1}
        unit="%"
        reset={100}
        onChange={(v) => set({ volume: v / 100 }, false, "Volume")}
        onCommit={(v) => set({ volume: v / 100 }, true, "Volume")}
      />
      <div className="grid grid-cols-2 gap-2">
        <Slide label="Fade in" value={fx.fadeIn} min={0} max={10} step={0.1} unit="s" reset={0} onChange={(v) => set({ fadeIn: v }, false, "Fade in")} onCommit={(v) => set({ fadeIn: v }, true, "Fade in")} />
        <Slide label="Fade out" value={fx.fadeOut} min={0} max={10} step={0.1} unit="s" reset={0} onChange={(v) => set({ fadeOut: v }, false, "Fade out")} onCommit={(v) => set({ fadeOut: v }, true, "Fade out")} />
      </div>
      <Slide
        label={fx.pan === 0 ? "Pan (centre)" : fx.pan < 0 ? "Pan (left)" : "Pan (right)"}
        value={fx.pan * 100}
        min={-100}
        max={100}
        step={1}
        reset={0}
        onChange={(v) => set({ pan: v / 100 }, false, "Pan")}
        onCommit={(v) => set({ pan: v / 100 }, true, "Pan")}
      />
      <Section id="eq" title="Equaliser" defaultOpen={false} extra={eq.some((x) => x) ? <button type="button" className="text-[10.5px] text-ink-4 hover:text-ink" onClick={() => set({ eq: [0, 0, 0] }, true, "EQ")}>Reset</button> : null}>
        <div className="flex flex-wrap gap-1">
          {(
            [
              ["Flat", [0, 0, 0]],
              ["Voice", [-4, 3, 2]],
              ["Less bass", [-8, 0, 0]],
              ["Bass boost", [6, 0, -1]],
              ["Bright", [0, 0, 5]],
            ] as [string, [number, number, number]][]
          ).map(([n, v]) => (
            <Toggle key={n} on={eq.join() === v.join()} onClick={() => set({ eq: v }, true, "EQ")}>
              {n}
            </Toggle>
          ))}
        </div>
        {(["Low (bass)", "Mid (voice)", "High (treble)"] as const).map((n, k) => (
          <Slide
            key={n}
            label={n}
            value={eq[k]}
            min={-12}
            max={12}
            step={0.5}
            unit="dB"
            reset={0}
            onChange={(v) => set({ eq: eq.map((x, j) => (j === k ? v : x)) as [number, number, number] }, false, "EQ")}
            onCommit={(v) => set({ eq: eq.map((x, j) => (j === k ? v : x)) as [number, number, number] }, true, "EQ")}
          />
        ))}
      </Section>
      <Section id="gate" title="Noise gate" defaultOpen={false}>
        <p className="text-[10.5px] leading-snug text-ink-4">Silences the quiet parts (fan hum, keyboard) between words. Applied on export.</p>
        <div className="flex gap-1">
          <Toggle on={fx.gate == null} onClick={() => set({ gate: null }, true, "Noise gate")}>
            Off
          </Toggle>
          <Toggle on={fx.gate != null} onClick={() => set({ gate: fx.gate ?? -45 }, true, "Noise gate")}>
            On
          </Toggle>
        </div>
        {fx.gate != null && (
          <Slide label="Threshold" value={fx.gate} min={-80} max={-10} step={1} unit="dB" reset={-45} onChange={(v) => set({ gate: v }, false, "Noise gate")} onCommit={(v) => set({ gate: v }, true, "Noise gate")} />
        )}
      </Section>
      <button type="button" onClick={onExport} className="flex items-center gap-1.5 text-[11px] text-ink-3 hover:text-ink" title="Save this sound as a WAV, M4A or MP3 file">
        <Ico d={I.music} className="h-3.5 w-3.5" /> Export audio as a file…
      </button>
    </Section>
  );
}

function PictureSection({ items, patch, onCrop }: { items: EdItem[]; patch: InspectorProps["patchItems"]; onCrop: (it: EdItem) => void }) {
  const q: Picture = items[0].pic ?? {};
  const set = (p: Partial<Picture>, commit: boolean, label: string) => patch((it) => (it.kind === "video" || it.kind === "image" ? { pic: { ...it.pic, ...p } } : {}), commit, label);
  const changed = !!(q.crop || q.flipH || q.flipV || q.rot90 || (q.scale ?? 1) !== 1 || (q.cx ?? 0.5) !== 0.5 || (q.cy ?? 0.5) !== 0.5 || q.fill);
  return (
    <Section
      id="picture"
      title="Picture"
      extra={
        changed ? (
          <button type="button" className="text-[10.5px] text-ink-4 hover:text-ink" onClick={() => patch((it) => (it.kind === "video" || it.kind === "image" ? { pic: {} } : {}), true, "Reset picture")}>
            Reset
          </button>
        ) : null
      }
    >
      <div className="flex flex-wrap gap-1">
        <Toggle on={!!q.crop} onClick={() => onCrop(items[0])} title="Crop: 16:9, 9:16, 1:1, 4:3 or free (drag the corners)">
          Crop…
        </Toggle>
        <Toggle on={false} onClick={() => set({ rot90: (((q.rot90 ?? 0) + 270) % 360) as Picture["rot90"] }, true, "Turn")} title="Turn 90° left (Ctrl+Shift+R)">
          ⟲ 90°
        </Toggle>
        <Toggle on={false} onClick={() => set({ rot90: (((q.rot90 ?? 0) + 90) % 360) as Picture["rot90"] }, true, "Turn")} title="Turn 90° right (Shift+R)">
          ⟳ 90°
        </Toggle>
        <Toggle on={!!q.flipH} onClick={() => set({ flipH: !q.flipH }, true, "Flip")} title="Mirror (Shift+H)">
          Flip ↔
        </Toggle>
        <Toggle on={!!q.flipV} onClick={() => set({ flipV: !q.flipV }, true, "Flip")} title="Upside down (Shift+V)">
          Flip ↕
        </Toggle>
      </div>
      <Seg
        value={q.fill ? "fill" : "fit"}
        onChange={(v) => set({ fill: v === "fill" }, true, v === "fill" ? "Fill frame" : "Fit frame")}
        options={[
          { v: "fit", label: "Fit (bars)", title: "Show all of the picture" },
          { v: "fill", label: "Fill (cut edges)", title: "Fill the frame, cutting what sticks out" },
        ]}
      />
      <Slide label="Size" value={(q.scale ?? 1) * 100} min={5} max={300} step={1} unit="%" reset={100} onChange={(v) => set({ scale: v / 100 }, false, "Size")} onCommit={(v) => set({ scale: v / 100 }, true, "Size")} title="Below 100 % makes picture in picture. Drag the corners on the picture too." />
      <div className="grid grid-cols-2 gap-2">
        <Slide label="X" value={(q.cx ?? 0.5) * 100} min={-50} max={150} step={0.5} unit="%" reset={50} onChange={(v) => set({ cx: v / 100 }, false, "Move")} onCommit={(v) => set({ cx: v / 100 }, true, "Move")} />
        <Slide label="Y" value={(q.cy ?? 0.5) * 100} min={-50} max={150} step={0.5} unit="%" reset={50} onChange={(v) => set({ cy: v / 100 }, false, "Move")} onCommit={(v) => set({ cy: v / 100 }, true, "Move")} />
      </div>
      <div className="flex flex-wrap gap-1">
        {(
          [
            ["Top left", 0.25, 0.25, 0.35],
            ["Top right", 0.75, 0.25, 0.35],
            ["Bottom left", 0.25, 0.75, 0.35],
            ["Bottom right", 0.75, 0.75, 0.35],
            ["Centre", 0.5, 0.5, 1],
          ] as [string, number, number, number][]
        ).map(([n, cx, cy, s]) => (
          <button
            key={n}
            type="button"
            className="rounded border border-line px-1.5 py-0.5 text-[10.5px] text-ink-3 hover:text-ink"
            onClick={() => {
              // Picture in picture corners keep a small margin.
              const m = s < 1 ? s / 2 + 0.02 : 0.5;
              set({ scale: s, cx: cx < 0.5 ? m : cx > 0.5 ? 1 - m : 0.5, cy: cy < 0.5 ? m : cy > 0.5 ? 1 - m : 0.5 }, true, "Picture in picture");
            }}
          >
            {n}
          </button>
        ))}
      </div>
    </Section>
  );
}

function ClipFile({ clip, a, flushMs }: { clip: ClipMetadata; a: ClipActions; flushMs?: number }) {
  const [name, setName] = useState<string | null>(null);
  const [tag, setTag] = useState("");
  const [sure, setSure] = useState(false);
  const row = "flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[11.5px] text-ink-2 hover:bg-surface-4 hover:text-ink";
  return (
    <Section id="clipfile" title="Clip file">
      <div className="flex items-center gap-1">
        <input
          value={name ?? clip.title}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            if (name !== null && name.trim() && name.trim() !== clip.title) a.rename(name.trim());
            setName(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") {
              setName(null);
              (e.target as HTMLInputElement).blur();
            }
          }}
          title="Rename the file"
          className="min-w-0 flex-1 rounded border border-line bg-surface-2 px-1.5 py-1 text-[12px] text-ink focus:border-accent focus:outline-none"
        />
        <button type="button" onClick={a.favorite} title={clip.favorite ? "Remove the star" : "Star this clip"} className={cn("grid h-7 w-7 place-items-center rounded", clip.favorite ? "text-amber-400" : "text-ink-4 hover:text-ink")}>
          <svg viewBox="0 0 16 16" className="h-4 w-4" fill={clip.favorite ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.4">
            <path d={I.star} />
          </svg>
        </button>
      </div>
      <div className="font-mono text-[10px] leading-relaxed text-ink-4" title={clip.path}>
        {clip.width}×{clip.height} · {Math.round(clip.fps)} fps · {formatBytes(clip.size_bytes)}
        {typeof flushMs === "number" && <span className="ml-1 rounded bg-emerald-500/15 px-1 text-emerald-300">saved in {flushMs.toFixed(1)} ms</span>}
        <div className="truncate">{shownPath(clip.path)}</div>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {clip.tags.map((t) => (
          <span key={t} className="inline-flex items-center gap-1 rounded-full bg-surface-4 px-2 py-0.5 text-[10.5px] text-ink-2">
            {t}
            <button type="button" title={`Remove ${t}`} className="text-ink-4 hover:text-danger" onClick={() => a.tags(clip.tags.filter((x) => x !== t))}>
              ×
            </button>
          </span>
        ))}
        <input
          value={tag}
          placeholder="+ tag"
          onChange={(e) => setTag(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && tag.trim()) {
              if (!clip.tags.includes(tag.trim())) a.tags([...clip.tags, tag.trim()]);
              setTag("");
            }
          }}
          className="w-20 rounded border border-transparent bg-transparent px-1 text-[11px] text-ink-2 placeholder:text-ink-4 hover:border-line focus:border-accent focus:outline-none"
        />
      </div>
      <div className="-mx-1.5">
        <button type="button" className={row} onClick={a.splitFile} title="Cuts the file in two at the playhead, without re-encoding">
          <Ico d={I.split} className="h-3.5 w-3.5" /> Split the file in two at the playhead
        </button>
        <button type="button" className={row} onClick={a.copyFile} title="Copies the original file (paste it in Discord or Explorer)">
          <Ico d={I.copy} className="h-3.5 w-3.5" /> Copy the original file
        </button>
        <button type="button" className={row} onClick={a.reveal}>
          <Ico d={I.folder} className="h-3.5 w-3.5" /> Show in folder
        </button>
        <button type="button" className={row} onClick={a.openExternal}>
          <Ico d={I.play} className="h-3.5 w-3.5" /> Play in the default player
        </button>
        {a.moveToLibrary && (
          <button type="button" className={row} onClick={a.moveToLibrary}>
            <Ico d={I.folder} className="h-3.5 w-3.5" /> Move to the Lastshot folder
          </button>
        )}
        {!sure ? (
          <button type="button" className={cn(row, "hover:text-danger")} onClick={() => setSure(true)}>
            <Ico d={I.trash} className="h-3.5 w-3.5" /> Discard this clip…
          </button>
        ) : (
          <div className="flex items-center gap-1 px-1.5 py-1 text-[11px]">
            <span className="flex-1 text-danger">Move the file to the Recycle Bin?</span>
            <button type="button" className="rounded bg-red-600 px-2 py-0.5 font-semibold text-white" onClick={a.discard}>
              Discard
            </button>
            <button type="button" className="rounded px-2 py-0.5 text-ink-3 hover:text-ink" onClick={() => setSure(false)}>
              Keep
            </button>
          </div>
        )}
      </div>
    </Section>
  );
}

export default function Inspector(P: InspectorProps) {
  const { p, sel } = P;
  const shapes = sel.filter((i) => i.kind === "shape" && i.shape).map((i) => i.shape!) as Shape[];
  const pics = sel.filter((i) => i.kind === "video" || i.kind === "image");
  const sounds = sel.filter((i) => i.kind === "audio" || (i.kind === "video" && i.hasAudio));
  const out = outputSize(p);
  const sizeKey = p.size === "auto" ? "auto" : `${p.size.w}x${p.size.h}`;
  const [customSize, setCustomSize] = useState(false);

  const header = sel.length === 0 ? "Project" : sel.length === 1 ? sel[0].name || "Item" : `${sel.length} items`;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="truncate border-b border-line px-3 py-2 text-[12px] font-semibold text-ink" title={header}>
        {header}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-6">
        {sel.length === 1 && (
          <Section id="timing" title="Timing">
            <TimeField label="Starts at" value={sel[0].start} fps={P.fps} onCommit={(t) => P.onMoveTo(sel[0].id, t)} />
            <TimeField
              label="Length"
              value={sel[0].duration}
              fps={P.fps}
              onCommit={(t) => P.onLength(sel[0].id, t)}
            />
            {sel[0].disabled && <p className="text-[11px] text-amber-300">This item is turned off (D turns it back on).</p>}
            {sel[0].missing && <p className="text-[11px] text-danger">The file is missing: {sel[0].path}</p>}
          </Section>
        )}
        {(shapes.length > 0 || (sel.length === 0 && P.tool !== "select")) && (
          <Section id="style" title={shapes.length ? "Object" : "New objects"}>
            <StyleControls
              selected={shapes}
              style={P.style}
              onStyle={P.onStyle}
              tool={P.tool}
              arrange={P.arrange}
              onPatch={(fn, commit, label) => P.patchItems((it) => (it.shape ? { shape: { ...it.shape, ...fn(it.shape) } } : {}), commit, label)}
            />
          </Section>
        )}
        {pics.length > 0 && <PictureSection items={pics} patch={P.patchItems} onCrop={P.onCrop} />}
        {sounds.length > 0 && <AudioSection items={sounds} patch={P.patchItems} onDetach={sounds.some((i) => i.kind === "video") ? P.onDetachAudio : undefined} onExport={P.onAudioExport} />}
        {sel.length === 0 && (
          <>
            <Section id="project" title="Output">
              <div className="text-[11px] text-ink-3">Size</div>
              <Seg
                value={customSize ? "custom" : sizeKey}
                onChange={(v) => {
                  if (v === "custom") return setCustomSize(true);
                  setCustomSize(false);
                  if (v === "auto") P.patchProject({ size: "auto" }, "Output size");
                  else {
                    const s = SIZES.find((x) => x.v === v)!;
                    P.patchProject({ size: { w: s.w, h: s.h } }, "Output size");
                  }
                }}
                options={[{ v: "auto", label: "Auto", title: "The first clip's size (after its crop)" }, ...SIZES.map((s) => ({ v: s.v, label: s.label })), { v: "custom", label: "Custom…" }]}
              />
              {(customSize || (p.size !== "auto" && !SIZES.some((s) => s.v === sizeKey))) && (
                <div className="flex items-center gap-1 text-[11px] text-ink-3">
                  <NumIn value={out.w} onCommit={(w) => P.patchProject({ size: { w, h: out.h } }, "Output size")} /> ×
                  <NumIn value={out.h} onCommit={(h) => P.patchProject({ size: { w: out.w, h } }, "Output size")} /> px
                </div>
              )}
              <div className="font-mono text-[10.5px] text-ink-4">
                Now {out.w}×{out.h} · {outputFps(p)} fps
              </div>
              <div className="text-[11px] text-ink-3">Frame rate</div>
              <Seg
                value={p.fps}
                onChange={(v) => P.patchProject({ fps: v }, "Frame rate")}
                options={[
                  { v: "auto", label: "Auto", title: "The highest clip rate" },
                  { v: 24, label: "24", title: "Film" },
                  { v: 25, label: "25", title: "PAL" },
                  { v: 30, label: "30" },
                  { v: 50, label: "50" },
                  { v: 60, label: "60" },
                  { v: 120, label: "120" },
                ]}
              />
            </Section>
            {P.clip && P.clipActions && <ClipFile clip={P.clip} a={P.clipActions} flushMs={P.flushMs} />}
            <Section id="tips" title="Tips" defaultOpen={false}>
              <ul className="list-disc space-y-1 pl-4 text-[11px] leading-snug text-ink-3">
                <li>Drag clips from the media list, your library or Explorer onto the timeline, where you want them.</li>
                <li>S or C splits at the playhead, Shift+Del closes the gap, Q / W trim to the playhead.</li>
                <li>Hold Ctrl while dropping or moving to insert (push the rest along) instead of covering.</li>
                <li>Drag the yellow line on a clip for volume, the dots in its top corners for fades.</li>
                <li>T text, R box, A arrow, P pen, Shift+B pixelate: draw on the picture.</li>
                <li>Press ? for every shortcut.</li>
              </ul>
            </Section>
          </>
        )}
      </div>
    </div>
  );
}

function NumIn({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const [d, setD] = useState<string | null>(null);
  return (
    <input
      value={d ?? String(value)}
      onChange={(e) => setD(e.target.value)}
      onBlur={() => {
        const n = Math.round(Number(d));
        if (d !== null && Number.isFinite(n) && n >= 16 && n <= 7680) onCommit(n);
        setD(null);
      }}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      className="w-16 rounded border border-line bg-surface-2 px-1.5 py-0.5 text-right font-mono text-[11px] text-ink focus:border-accent focus:outline-none"
    />
  );
}
