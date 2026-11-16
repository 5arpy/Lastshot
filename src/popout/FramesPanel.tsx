/**
 * The Pop-outs panel in the main window: every pop-out frame with all of its
 * settings, so a click-through frame (which cannot be clicked) can still be
 * changed. Opens from the nav bar, the tray, a frame's own bar or the
 * `lastshot://frames-panel` event.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import pro from "lastshot-pro";
import { assetUrl, lastshot } from "../lib/bridge";
import NumberField from "../components/NumberField";
import { cn } from "../utils/cn";
import ShowOverPicker from "./ShowOverPicker";
import { openApps } from "./showOver";
import { frames, pickEcho, popOutMany, popOutPicturePath, viewFlags, type ClosedFrame, type Frame, type FrameCmd } from "./frames";

/** What the panel's view buttons can do for image and clip frames. */
const MEDIA_CMDS: FrameCmd[] = ["zoomOut", "zoomIn", "fit", "actual", "flipH", "flipV", "gray", "grid"];

/** "3 min ago" for the Recently closed list. */
export function ago(ms: number, now = Date.now()): string {
  const m = Math.max(0, Math.round((now - ms) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

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
  const [closed, setClosed] = useState<ClosedFrame[]>([]);
  const [hotkey, setHotkey] = useState("");
  const [recording, setRecording] = useState(false);
  const [notice, setNotice] = useState("");
  const [askAll, setAskAll] = useState(false);
  // Apps with a window, for "Show over" (refreshed when the panel opens).
  const [apps, setApps] = useState<{ exe: string; title: string }[]>([]);
  useEffect(() => {
    if (!open) return;
    void lastshot
      .listWindows()
      .then((w) => setApps(openApps(w)))
      .catch(() => undefined);
  }, [open]);
  // Apps picked on any frame stay offered, also while they are closed.
  const known = [...new Map(list.flatMap((f) => f.showOver ?? []).map((a) => [a.toLowerCase(), a] as const)).values()];

  useEffect(() => {
    const offs: Array<() => void> = [];
    let alive = true;
    const keep = (p: Promise<() => void>) => void p.then((u) => (alive ? offs.push(u) : u()));
    void frames.list().then((l) => alive && setList(l));
    void frames.getHotkey().then((k) => alive && setHotkey(k)).catch(() => undefined);
    keep(frames.onChange((l) => setList(l)));
    // The tray's "Close all frames" kept boards with pictures open.
    keep(frames.onNotice((m) => setNotice(m)));
    return () => {
      alive = false;
      offs.forEach((u) => u());
    };
  }, []);

  // Recently closed frames (the trash), while the panel is open.
  const loadClosed = useCallback(() => void frames.closed().then(setClosed, () => undefined), []);
  useEffect(() => {
    if (open) loadClosed();
  }, [open, list, loadClosed]);

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
    const paths = (Array.isArray(p) ? p : p ? [p] : []).map(String);
    await popOutMany(
      paths,
      popOutPicturePath,
      (n) => window.confirm(`Pop out ${n} pictures? Each opens a frame of its own.`),
      (m) => onToast("warn", "Pop-out", m),
    );
  };

  const allThrough = list.length > 0 && list.every((f) => f.clickThrough);
  const throughCount = list.filter((f) => f.clickThrough && !f.hidden).length;
  const allHidden = list.length > 0 && list.every((f) => f.hidden);
  const holding = list.filter((f) => (f.items ?? 0) > 0);
  const closeAll = (force: boolean) => {
    setAskAll(false);
    void frames
      .closeAll(force)
      .then((r) => {
        // Something reported its pictures only now: ask about the rest.
        if (r.kept) setAskAll(true);
      })
      .catch(fail);
  };
  const reopen = (c: ClosedFrame) =>
    void frames
      .reopen(c.key)
      .then(loadClosed)
      .catch((e) => {
        fail(e);
        loadClosed();
      });

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

        {throughCount > 0 && (
          // The way back from click-through, where nobody can miss it.
          <div className="flex flex-wrap items-center gap-2 border-b border-line bg-accent/15 px-4 py-2.5 text-[11.5px] text-ink-2" data-testid="frames-through-banner">
            <span className="min-w-0 flex-1">
              {throughCount === 1 ? "1 frame ignores" : `${throughCount} frames ignore`} the mouse (click-through). Hold <b>Ctrl+Alt</b> over a frame to use
              it for a moment{hotkey ? <>, or press <b>{hotkey}</b></> : null}.
            </span>
            <button
              type="button"
              data-testid="frames-through-off"
              className="rounded-md bg-accent px-2.5 py-1 text-[11.5px] font-semibold text-white hover:brightness-110"
              onClick={() => void frames.clickThroughAll(false).catch(fail)}
            >
              Turn off click-through
            </button>
          </div>
        )}

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
          <button
            type="button"
            data-testid="frames-close-all"
            className={cn(btn, "hover:border-red-500/60 hover:text-red-400")}
            disabled={!list.length}
            onClick={() => (holding.length ? setAskAll(true) : closeAll(false))}
          >
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

        {askAll && (
          <div className="flex flex-wrap items-center gap-2 border-b border-line bg-red-500/10 px-4 py-2.5 text-[11.5px] text-ink-2" data-testid="frames-close-all-ask">
            <span className="min-w-0 flex-1">
              Close all {list.length} frames? {holding.length === 1 ? "One holds pictures; it goes" : `${holding.length || "Some"} hold pictures; they go`} to
              Recently closed below for 7 days.
            </span>
            <button type="button" className={btn} onClick={() => setAskAll(false)}>
              Cancel
            </button>
            <button type="button" data-testid="frames-close-all-yes" className={cn(btn, "border-red-500/60 text-red-400")} onClick={() => closeAll(true)}>
              Close all
            </button>
          </div>
        )}
        {notice && (
          <div className="flex items-center gap-2 border-b border-line bg-amber-500/10 px-4 py-2 text-[11.5px] text-ink-2" data-testid="frames-notice">
            <span className="min-w-0 flex-1">{notice}</span>
            <button type="button" className="text-ink-4 hover:text-ink" title="Dismiss" onClick={() => setNotice("")}>
              ✕
            </button>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {!list.length && (
            <div className="rounded-lg border border-dashed border-line-3 px-4 py-6 text-center text-[12px] leading-relaxed text-ink-3">
              No frames yet. Pop one out with <b>Pop out</b> in the clip editor or the snip editor, <b>right-click a clip › Pop out</b>, drop a
              picture on Lastshot, or paste one with <b>Ctrl+V</b>.
            </div>
          )}
          {list.map((f) => (
            <FrameRow key={f.id} f={f} upd={upd} cmd={cmd} fail={fail} apps={apps} known={known} />
          ))}

          {closed.length > 0 && (
            <section className="mt-3" data-testid="frames-closed">
              <div className="mb-1 px-1 text-[11px] font-semibold uppercase tracking-wide text-ink-4" title="Closed frames that held pictures are kept for 7 days">
                Recently closed
              </div>
              {closed.map((c) => (
                <div key={c.key} className="mb-1 flex items-center gap-2 rounded-md border border-line bg-surface px-2.5 py-1.5" data-testid="frames-closed-row">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12px] text-ink-2" title={c.title}>
                      {c.title}
                    </div>
                    <div className="text-[10.5px] text-ink-4">
                      {c.pictures} picture{c.pictures === 1 ? "" : "s"} · closed {ago(c.closedMs)}
                    </div>
                  </div>
                  <button type="button" className={btn} data-testid="frames-reopen" onClick={() => reopen(c)}>
                    Reopen
                  </button>
                </div>
              ))}
              <p className="px-1 text-[10.5px] text-ink-4">Kept for 7 days after closing.</p>
            </section>
          )}
        </div>

        <footer className="border-t border-line px-4 py-2.5 text-[11px] leading-relaxed text-ink-4">
          On a frame: drag the top bar to move, the edges to resize (Shift: any shape), the wheel to zoom, Shift+wheel for opacity. Picture
          and clip frames never take the keyboard from the app you work in; frames made for typing in (a reference board) take it once
          you click them.
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
  apps,
  known,
}: {
  apps: { exe: string; title: string }[];
  /** Apps picked on any frame (they stay offered while closed). */
  known: string[];
  f: Frame;
  upd: (f: Frame, p: Parameters<typeof frames.update>[1]) => void;
  cmd: (f: Frame, c: FrameCmd) => void;
  fail: (e: unknown) => void;
}) {
  const flags = viewFlags(f);
  const [full, setFull] = useState(false);
  const [asking, setAsking] = useState(false);
  const thumb = f.kind === "image" && f.src ? assetUrl(f.src) : "";
  // Slider: show the value at once, send at most every 40 ms. Values that
  // come back from the app right after a local change are older echoes.
  const [op, setOp] = useState(Math.round(f.opacity * 100));
  const opTimer = useRef(0);
  const opAt = useRef(0);
  useEffect(() => setOp((local) => pickEcho(local, Math.round(f.opacity * 100), opAt.current, Date.now())), [f.opacity]);
  const setOpacity = (v: number, wait: number) => {
    opAt.current = Date.now();
    setOp(v);
    window.clearTimeout(opTimer.current);
    opTimer.current = window.setTimeout(() => upd(f, { opacity: v / 100 }), wait);
  };
  // The view buttons this kind of frame handles (a Pro board names its own).
  const cmds = f.kind === "image" || f.kind === "video" ? MEDIA_CMDS : (pro.frameCommands?.[f.kind] ?? []);
  const has = (c: FrameCmd) => cmds.includes(c);
  const items = f.items ?? 0;
  const close = (force: boolean) =>
    void frames
      .close(f.id, force)
      .then((ok) => setAsking(!ok))
      .catch(fail);
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
          data-testid="frame-row-close"
          className="grid h-7 w-7 place-items-center rounded-md text-ink-3 hover:bg-red-500/15 hover:text-red-400"
          title="Close this frame"
          onClick={() => close(false)}
        >
          ✕
        </button>
      </div>
      {asking && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 rounded-md bg-red-500/10 px-2 py-1.5 text-[11px] text-ink-2" data-testid="frame-row-ask">
          <span className="min-w-0 flex-1">
            Close it{items ? ` with its ${items} picture${items === 1 ? "" : "s"}` : ""}? It stays in Recently closed for 7 days.
          </span>
          <button type="button" className={btn} onClick={() => setAsking(false)}>
            Keep
          </button>
          <button type="button" data-testid="frame-row-ask-yes" className={cn(btn, "border-red-500/60 text-red-400")} onClick={() => close(true)}>
            Close
          </button>
        </div>
      )}

      <label className="mt-2 flex items-center gap-2 text-[11px] text-ink-3">
        <span className="w-12">Opacity</span>
        <input
          type="range"
          min={5}
          max={100}
          value={op}
          onChange={(e) => setOpacity(Number(e.target.value), 40)}
          className="h-1 flex-1 accent-[var(--color-accent,#5d72db)]"
          aria-label={`Opacity of ${f.title}`}
        />
        {/* Any value: type it (Enter or leaving the field sets it), or arrows / wheel. */}
        <NumberField
          value={op}
          min={5}
          max={100}
          step={1}
          digits={0}
          onChange={(v) => setOpacity(Math.round(v), 0)}
          aria-label={`Opacity of ${f.title}, percent`}
          title="Type any opacity from 5 to 100 %"
          testid="frame-row-opacity"
          className="w-9 rounded border border-transparent bg-transparent px-0.5 text-right font-mono text-[10.5px] text-ink-2 hover:border-line focus:border-line focus:bg-surface-2 focus:outline-none"
        />
        <span className="-ml-1.5 font-mono text-[10.5px] text-ink-3">%</span>
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

      <ShowOverPicker value={f.showOver ?? []} known={known} open={apps} frameTitle={f.title} onChange={(l) => upd(f, { showOver: l })} />

      {cmds.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1" data-testid="frame-row-view">
          {has("zoomOut") && (
            <button type="button" className={chip(false)} onClick={() => cmd(f, "zoomOut")} title="Zoom out">
              −
            </button>
          )}
          {has("zoomIn") && (
            <button type="button" className={chip(false)} onClick={() => cmd(f, "zoomIn")} title="Zoom in">
              +
            </button>
          )}
          {has("fit") && (
            <button type="button" className={chip(false)} onClick={() => cmd(f, "fit")} title={f.kind === "board" ? "Fit everything in the frame" : "Fit the picture in the frame"}>
              Fit
            </button>
          )}
          {has("actual") && (
            <button type="button" className={chip(false)} onClick={() => cmd(f, "actual")} title="100 %: one picture pixel per screen pixel">
              1:1
            </button>
          )}
          <span className="mx-0.5 h-4 w-px bg-line" />
          {has("flipH") && (
            <button type="button" className={chip(flags.flipH)} onClick={() => cmd(f, "flipH")} title={f.kind === "board" ? "Mirror the selection, or every picture" : "Mirror left↔right"}>
              Flip ↔
            </button>
          )}
          {has("flipV") && (
            <button type="button" className={chip(flags.flipV)} onClick={() => cmd(f, "flipV")} title="Flip upside down">
              Flip ↕
            </button>
          )}
          {has("gray") && (
            <button type="button" className={chip(flags.gray)} onClick={() => cmd(f, "gray")} title={f.kind === "board" ? "Grey the selection, or every picture" : "Grayscale"}>
              Gray
            </button>
          )}
          {has("grid") && (
            <button type="button" className={chip(flags.grid)} onClick={() => cmd(f, "grid")} title="Grid over the picture">
              Grid
            </button>
          )}
        </div>
      )}
    </div>
  );
}
