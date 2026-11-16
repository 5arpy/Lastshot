/**
 * The Pop-outs panel in the main window: every pop-out frame with all of its
 * settings, so a click-through frame (which cannot be clicked) can still be
 * changed. Opens from the nav bar, the tray, a frame's own bar or the
 * `lastshot://frames-panel` event.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import pro from "lastshot-pro";
import { assetUrl } from "../lib/bridge";
import { cn } from "../utils/cn";
import { frames, popOutPicturePath, viewFlags, type Frame, type FrameCmd } from "./frames";

/** Ctrl+Alt+Shift+X style accelerator from a key press (null: keep waiting). */
export function accelFromKey(e: KeyboardEvent): string | null {
  if (e.key === "Escape") return "";
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Win");
  const k = e.key;
  let token: string | null = null;
  if (/^[a-z0-9]$/i.test(k)) token = k.toUpperCase();
  else if (/^F([1-9]|1[0-9]|2[0-4])$/i.test(k)) token = k.toUpperCase();
  else if (k === " ") token = "Space";
  if (!token || !mods.length) return null;
  return [...mods, token].join("+");
}

const btn =
  "inline-flex h-7 items-center justify-center gap-1 rounded-md border border-line bg-surface px-2 text-[11px] font-medium text-ink-2 transition-colors hover:border-line-3 hover:text-ink disabled:opacity-40";
const chip = (on: boolean) =>
  cn(
    "inline-flex h-6 min-w-6 items-center justify-center rounded px-1.5 text-[10.5px] font-semibold transition-colors",
    on ? "bg-accent text-white" : "bg-surface-2 text-ink-3 hover:text-ink",
  );

export default function FramesPanel({
  open,
  onClose,
  onToast,
}: {
  open: boolean;
  onClose: () => void;
  onToast: (tone: "ok" | "warn" | "info", title: string, body?: string) => void;
}) {
  const [list, setList] = useState<Frame[]>([]);
  const [hotkey, setHotkey] = useState("");
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    let off: (() => void) | undefined;
    let alive = true;
    void frames.list().then((l) => alive && setList(l));
    void frames.getHotkey().then((k) => alive && setHotkey(k)).catch(() => undefined);
    void frames.onChange((l) => setList(l)).then((u) => (alive ? (off = u) : u()));
    return () => {
      alive = false;
      off?.();
    };
  }, []);

  useEffect(() => {
    if (!recording) return;
    const key = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const a = accelFromKey(e);
      if (a === null) return;
      setRecording(false);
      if (a === "") return;
      void frames
        .setHotkey(a)
        .then((k) => {
          setHotkey(k);
          onToast("ok", "Shortcut changed", `${k} turns click-through on or off for every frame.`);
        })
        .catch((err) => onToast("warn", "Shortcut not changed", String(err)));
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [recording, onToast]);

  const fail = useCallback((e: unknown) => onToast("warn", "Pop-out", String(e)), [onToast]);
  const upd = (f: Frame, p: Parameters<typeof frames.update>[1]) => {
    setList((l) => l.map((x) => (x.id === f.id ? { ...x, ...p } : x)));
    void frames.update(f.id, p).catch(fail);
  };
  const cmd = (f: Frame, c: FrameCmd) => void frames.command(f.id, c).catch(fail);

  const openPicture = async () => {
    const p = await openDialog({
      multiple: true,
      filters: [{ name: "Pictures", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] }],
    }).catch(() => null);
    const paths = Array.isArray(p) ? p : p ? [p] : [];
    for (const path of paths) await popOutPicturePath(String(path)).catch(fail);
  };

  const allThrough = list.length > 0 && list.every((f) => f.clickThrough);
  const allHidden = list.length > 0 && list.every((f) => f.hidden);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[52] flex justify-end" onPointerDown={onClose}>
      <aside
        onPointerDown={(e) => e.stopPropagation()}
        className="animate-fade flex h-full w-[400px] max-w-full flex-col border-l border-line bg-app shadow-2xl"
        aria-label="Pop-outs"
      >
        <header className="flex items-center gap-2 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-semibold text-ink">Pop-outs</div>
            <div className="text-[11.5px] text-ink-3">
              See-through frames that stay on top, to trace in Blender or a drawing app.
            </div>
          </div>
          <button type="button" className={btn} onClick={onClose} title="Close (Esc)">
            ✕
          </button>
        </header>

        <div className="flex flex-wrap gap-1.5 border-b border-line px-4 py-2.5">
          <button type="button" className={btn} onClick={() => void frames.fromClipboard().catch(fail)} title="Pop out the picture on the clipboard (or press Ctrl+V in Lastshot)">
            Paste picture
          </button>
          <button type="button" className={btn} onClick={() => void openPicture()} title="Pop out picture files (or drop them on Lastshot)">
            Open picture…
          </button>
          {pro.panelActions.map((a) => (
            <button key={a.label} type="button" className={btn} title={a.title} onClick={() => void Promise.resolve(a.run()).catch(fail)}>
              {a.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-4 py-2.5">
          <button
            type="button"
            className={cn(btn, allThrough && "border-accent/50 text-accent-fg")}
            disabled={!list.length}
            onClick={() => void frames.clickThroughAll(!allThrough).catch(fail)}
            title="Clicks go through every frame to the app below"
          >
            {allThrough ? "Click-through: on" : "Click-through all"}
          </button>
          <button type="button" className={btn} disabled={!list.length} onClick={() => void frames.hideAll(!allHidden).catch(fail)}>
            {allHidden ? "Show all" : "Hide all"}
          </button>
          <button type="button" className={cn(btn, "hover:border-red-500/60 hover:text-red-400")} disabled={!list.length} onClick={() => void frames.closeAll().catch(fail)}>
            Close all
          </button>
          <span className="ml-auto flex items-center gap-1.5 text-[11px] text-ink-3" title="Turns click-through on or off for every frame, from any app">
            Shortcut
            <button
              type="button"
              onClick={() => setRecording(true)}
              className={cn(
                "rounded border px-2 py-0.5 font-mono text-[10.5px] font-semibold",
                recording ? "border-accent bg-accent/20 text-accent-fg" : "border-line-3 bg-surface text-ink hover:border-accent/60",
              )}
            >
              {recording ? "Press keys… (Esc)" : hotkey || "none"}
            </button>
            {hotkey && !recording && (
              <button type="button" className="text-ink-4 hover:text-ink" title="No shortcut" onClick={() => void frames.setHotkey("").then(setHotkey).catch(fail)}>
                ✕
              </button>
            )}
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {!list.length && (
            <div className="rounded-lg border border-dashed border-line-3 px-4 py-6 text-center text-[12px] leading-relaxed text-ink-3">
              No frames yet. Pop one out with <b>Pop out</b> in the clip editor or the snip editor, <b>right-click a clip › Pop out</b>, drop a
              picture on Lastshot, or paste one with <b>Ctrl+V</b>.
            </div>
          )}
          {list.map((f) => (
            <FrameRow key={f.id} f={f} upd={upd} cmd={cmd} fail={fail} />
          ))}
        </div>

        <footer className="border-t border-line px-4 py-2.5 text-[11px] leading-relaxed text-ink-4">
          On a frame: drag the top bar to move, the edges to resize (Shift: any shape), the wheel to zoom, Shift+wheel for opacity. Frames
          never take the keyboard from the app you work in.
        </footer>
      </aside>
    </div>
  );
}

function FrameRow({
  f,
  upd,
  cmd,
  fail,
}: {
  f: Frame;
  upd: (f: Frame, p: Parameters<typeof frames.update>[1]) => void;
  cmd: (f: Frame, c: FrameCmd) => void;
  fail: (e: unknown) => void;
}) {
  const flags = viewFlags(f);
  const [full, setFull] = useState(false);
  const thumb = f.kind === "image" && f.src ? assetUrl(f.src) : "";
  // Slider: show the value at once, send at most every 50 ms.
  const [op, setOp] = useState(Math.round(f.opacity * 100));
  const opTimer = useRef(0);
  useEffect(() => setOp(Math.round(f.opacity * 100)), [f.opacity]);
  return (
    <div className={cn("mb-2 rounded-lg border bg-surface p-2.5", f.hidden ? "border-line opacity-70" : "border-line-2")}>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="grid h-10 w-14 shrink-0 place-items-center overflow-hidden rounded bg-black/40 text-[10px] text-white/60"
          title="Bring to front"
          onClick={() => void frames.raise(f.id).catch(fail)}
        >
          {thumb ? <img src={thumb} alt="" className="h-full w-full object-contain" draggable={false} /> : f.kind === "video" ? "▶ clip" : f.kind}
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] font-medium text-ink" title={f.title}>
            {f.title}
          </div>
          <div className="text-[10.5px] text-ink-4">
            {f.w} × {f.h}
            {f.clickThrough ? " · click-through" : ""}
            {f.hidden ? " · hidden" : ""}
          </div>
        </div>
        <button
          type="button"
          className="grid h-7 w-7 place-items-center rounded-md text-ink-3 hover:bg-red-500/15 hover:text-red-400"
          title="Close this frame"
          onClick={() => void frames.close(f.id).catch(fail)}
        >
          ✕
        </button>
      </div>

      <label className="mt-2 flex items-center gap-2 text-[11px] text-ink-3">
        <span className="w-12">Opacity</span>
        <input
          type="range"
          min={5}
          max={100}
          value={op}
          onChange={(e) => {
            const v = Number(e.target.value);
            setOp(v);
            window.clearTimeout(opTimer.current);
            opTimer.current = window.setTimeout(() => upd(f, { opacity: v / 100 }), 40);
          }}
          className="h-1 flex-1 accent-[var(--color-accent,#5d72db)]"
          aria-label={`Opacity of ${f.title}`}
        />
        <span className="w-9 text-right font-mono text-[10.5px] text-ink-2">{op}%</span>
      </label>

      <div className="mt-2 flex flex-wrap items-center gap-1">
        <button type="button" className={chip(f.onTop)} onClick={() => upd(f, { onTop: !f.onTop })} title="Always on top">
          On top
        </button>
        <button type="button" className={chip(f.clickThrough)} onClick={() => upd(f, { clickThrough: !f.clickThrough })} title="Clicks go through this frame to the app below">
          Click-through
        </button>
        <button type="button" className={chip(f.hidden)} onClick={() => upd(f, { hidden: !f.hidden })} title="Hide / show">
          {f.hidden ? "Hidden" : "Hide"}
        </button>
        <button
          type="button"
          className={chip(full)}
          onClick={() => void frames.fullscreen(f.id).then(setFull).catch(fail)}
          title="Full screen on its screen"
        >
          Full screen
        </button>
      </div>

      {(f.kind === "image" || f.kind === "video") && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          <button type="button" className={chip(false)} onClick={() => cmd(f, "zoomOut")} title="Zoom out">
            −
          </button>
          <button type="button" className={chip(false)} onClick={() => cmd(f, "zoomIn")} title="Zoom in">
            +
          </button>
          <button type="button" className={chip(false)} onClick={() => cmd(f, "fit")} title="Fit the picture in the frame">
            Fit
          </button>
          <button type="button" className={chip(false)} onClick={() => cmd(f, "actual")} title="100 %: one picture pixel per screen pixel">
            1:1
          </button>
          <span className="mx-0.5 h-4 w-px bg-line" />
          <button type="button" className={chip(flags.flipH)} onClick={() => cmd(f, "flipH")} title="Mirror left↔right">
            Flip ↔
          </button>
          <button type="button" className={chip(flags.flipV)} onClick={() => cmd(f, "flipV")} title="Flip upside down">
            Flip ↕
          </button>
          <button type="button" className={chip(flags.gray)} onClick={() => cmd(f, "gray")} title="Grayscale">
            Gray
          </button>
          <button type="button" className={chip(flags.grid)} onClick={() => cmd(f, "grid")} title="Grid over the picture">
            Grid
          </button>
        </div>
      )}
    </div>
  );
}
