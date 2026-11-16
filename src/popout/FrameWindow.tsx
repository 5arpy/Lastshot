/**
 * The inside of a pop-out frame window (`frame-<id>`): a borderless,
 * see-through window showing a picture, a clip frame or a playing clip in the
 * full viewer, with a thin move bar that shows only while the mouse is over
 * it, resize edges (shape kept; Shift frees it), snapping to screen edges and
 * other frames, opacity, "Always on top" and "Click-through".
 *
 * Everything here can also be changed from the main window (Pop-outs panel),
 * the tray and the click-through shortcut, because a click-through frame
 * cannot be clicked.
 */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import pro from "lastshot-pro";
import Viewer, { DEFAULT_SETTINGS, type ViewerApi, type ViewerSettings } from "../viewer/Viewer";
import { Btn, Icon } from "../viewer/ui";
import { actualView, fitView, flipScreenH, flipScreenV, zoomAt, type View } from "../viewer/math";
import { naturalSize } from "../viewer/render";
import { assetUrl } from "../lib/bridge";
import NumberField from "../components/NumberField";
import { cn } from "../utils/cn";
import {
  badgesOf,
  closeFrame,
  frames,
  isPictureType,
  MANY_FRAMES,
  onFlush,
  pickEcho,
  popOutMany,
  popOutPicture,
  type Frame,
  type FrameCmd,
  type FrameViewState,
  type Layout,
} from "./frames";
import { dragRect, snapRect, snapTargets, type Edge, type R } from "./snap";

const SNAP_PX = 10;
const HIDE_MS = 1600;

export const FI = {
  pin: "M6 2h4l-.5 4 2.5 2.5H4L6.5 6zM8 8.5V14",
  through: "M4 2l9 5-4 1 3 5-1.5.8-3-5L4 11z",
  full: "M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4",
  hide: "M2 8s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4zM2 2l12 12",
  close: "M4 4l8 8M12 4l-8 8",
  opacity: "M8 2a6 6 0 1 0 0 12zM8 2a6 6 0 0 1 0 12",
  panel: "M2 3h12v10H2zM2 6h12M5 9h6",
};

/** A yes/no question shown inside the frame window (frames have no dialogs). */
export interface Ask {
  text: string;
  yes: string;
  onYes: () => void;
}

export default function FrameWindow({ id }: { id: string }) {
  const [frame, setFrame] = useState<Frame | null>(null);
  const [gone, setGone] = useState(false);
  const [status, setStatus] = useState("");
  const [ask, setAsk] = useState<Ask | null>(null);
  const statusTimer = useRef(0);
  const say = useCallback((msg: string) => {
    setStatus(msg);
    window.clearTimeout(statusTimer.current);
    statusTimer.current = window.setTimeout(() => setStatus(""), msg.length > 60 ? 5000 : 2200);
  }, []);
  // When the opacity was last changed here: older values echoed back by the
  // app do not move the slider back.
  const opacityAt = useRef(0);

  // A see-through window: no page background.
  useEffect(() => {
    for (const el of [document.documentElement, document.body, document.getElementById("root")]) {
      if (el) el.style.background = "transparent";
    }
    // A picture dropped on a frame pops out as a frame of its own (and the
    // window never navigates to the file).
    const over = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (!files.length) return;
      e.preventDefault();
      const pics = files.filter((f) => isPictureType(f.type));
      if (!pics.length) return say("Only pictures (PNG, JPG, GIF, WebP, BMP) pop out as frames");
      const open = () => void popOutMany(pics, (f) => popOutPicture(f), () => true, say);
      if (pics.length > MANY_FRAMES)
        setAsk({ text: `Pop out ${pics.length} pictures? Each opens a frame of its own.`, yes: `Open ${pics.length}`, onYes: open });
      else open();
    };
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [say]);

  useEffect(() => {
    let off: (() => void) | undefined;
    let alive = true;
    void frames.list().then((l) => {
      if (!alive) return;
      const f = l.find((x) => x.id === id) ?? null;
      setFrame(f);
      if (!f) setGone(true);
    });
    void frames
      .onChange((l) => {
        // Change events carry no views: only update a frame that has loaded
        // its own (a board must never start from an empty view).
        const f = l.find((x) => x.id === id);
        if (f)
          setFrame((old) =>
            old ? { ...f, view: old.view, opacity: pickEcho(old.opacity, f.opacity, opacityAt.current, Date.now()) } : old,
          );
      })
      .then((u) => (alive ? (off = u) : u()));
    return () => {
      alive = false;
      off?.();
    };
  }, [id]);

  useEffect(() => {
    if (frame) document.title = `${frame.title} – Lastshot`;
  }, [frame?.title]); // eslint-disable-line react-hooks/exhaustive-deps

  if (gone) return <div className="grid h-screen place-items-center bg-black/70 text-[12px] text-white/70">This frame is closed.</div>;
  if (!frame) return null;
  return (
    <>
      <FrameChrome
        frame={frame}
        setFrame={setFrame}
        status={status}
        say={say}
        setAsk={setAsk}
        markOpacity={() => (opacityAt.current = Date.now())}
      />
      {ask && <AskBox ask={ask} onDone={() => setAsk(null)} />}
    </>
  );
}

function AskBox({ ask, onDone }: { ask: Ask; onDone: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== "Escape" && e.key !== "Enter") return;
      e.preventDefault();
      e.stopPropagation();
      onDone();
      if (e.key === "Enter") ask.onYes();
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [ask, onDone]);
  return (
    <div
      className="absolute inset-0 z-[60] grid place-items-center bg-black/55 p-3"
      data-testid="frame-ask"
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <div className="max-w-[340px] rounded-lg border border-white/15 bg-[#14161c] p-3 text-[12px] text-white/85 shadow-2xl">
        <p className="leading-relaxed">{ask.text}</p>
        <div className="mt-3 flex justify-end gap-1.5">
          <button type="button" className="rounded px-2.5 py-1 text-white/70 hover:bg-white/10 hover:text-white" onClick={onDone}>
            Cancel
          </button>
          <button
            type="button"
            data-testid="frame-ask-yes"
            className="rounded bg-red-500/80 px-2.5 py-1 font-semibold text-white hover:bg-red-500"
            onClick={() => {
              onDone();
              ask.onYes();
            }}
          >
            {ask.yes}
          </button>
        </div>
      </div>
    </div>
  );
}

function FrameChrome({
  frame,
  setFrame,
  status,
  say,
  setAsk,
  markOpacity,
}: {
  frame: Frame;
  setFrame: (f: Frame) => void;
  status: string;
  say: (m: string) => void;
  setAsk: (a: Ask | null) => void;
  markOpacity: () => void;
}) {
  const id = frame.id;
  // Picture and clip frames never take the keyboard (the app you trace in
  // keeps it); a board does once clicked, so only boards have keys.
  const takesKeys = frame.kind === "board";
  // The click-through shortcut, as set in the Pop-outs panel.
  const [hotkey, setHotkey] = useState("");
  const loadHotkey = useCallback(() => void frames.getHotkey().then(setHotkey, () => undefined), []);
  useEffect(loadHotkey, [loadHotkey]);
  const [full, setFull] = useState(false);
  const [awake, setAwake] = useState(true);
  const [overBar, setOverBar] = useState(false);
  const hideTimer = useRef(0);
  const wake = useCallback(() => {
    setAwake(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setAwake(false), HIDE_MS);
  }, []);
  useEffect(() => {
    wake();
    const leave = () => setAwake(false);
    document.documentElement.addEventListener("mouseleave", leave);
    return () => document.documentElement.removeEventListener("mouseleave", leave);
  }, [wake]);

  const patch = useCallback(
    (p: Partial<Pick<Frame, "opacity" | "onTop" | "clickThrough" | "hidden">>) => {
      if (p.opacity !== undefined) markOpacity();
      setFrame({ ...frame, ...p });
      void frames.update(id, p).catch((e) => say(String(e)));
    },
    [frame, id, markOpacity, say, setFrame],
  );

  const toggleFull = useCallback(() => {
    void frames.fullscreen(id).then(setFull);
  }, [id]);
  // A frame holding things (a board's pictures) asks first; what it owned
  // goes to "Recently closed" in the Pop-outs panel for 7 days.
  const items = frame.items ?? 0;
  const askClose = useCallback(() => {
    const what = items ? ` with its ${items} picture${items === 1 ? "" : "s"}` : "";
    setAsk({
      text: `Close “${frame.title}”${what}? You can reopen it for 7 days from Recently closed in Lastshot's Pop-outs panel.`,
      yes: "Close",
      onYes: () => void closeFrame(id, true).catch((e) => say(String(e))),
    });
  }, [frame.title, id, items, say, setAsk]);
  const close = useCallback(() => {
    void closeFrame(id)
      .then((closed) => {
        if (!closed) askClose();
      })
      .catch((e) => say(String(e)));
  }, [askClose, id, say]);
  useEffect(() => {
    let off: (() => void) | undefined;
    let alive = true;
    void frames.onAskClose(askClose).then((u) => (alive ? (off = u) : u()));
    return () => {
      alive = false;
      off?.();
    };
  }, [askClose]);

  // ---------------------------------------------------------------- moving / resizing
  // The frame follows the cursor's physical position (asked from the app), so
  // a move onto a monitor with other scaling does not jump.
  const drag = useRef<{ edge: Edge; pointer: number; cx: number; cy: number; start: R; layout: Layout; aspect: number } | null>(null);
  const dragToken = useRef(0);
  const mods = useRef({ shift: false, alt: false });
  const raf = useRef(0);
  const stepping = useRef(false);
  const again = useRef(false);
  const step = useCallback(async () => {
    if (stepping.current) {
      again.current = true;
      return;
    }
    stepping.current = true;
    try {
      do {
        again.current = false;
        const d = drag.current;
        if (!d) break;
        const c = await frames.cursor().catch(() => null);
        if (!c || drag.current !== d) break;
        let r = dragRect(d.start, d.edge, c[0] - d.cx, c[1] - d.cy, { aspect: mods.current.shift ? null : d.aspect });
        if (!mods.current.alt) {
          const others = d.layout.frames.map(([, x, y, w, h]) => ({ x, y, w, h }));
          r = snapRect(r, d.edge, snapTargets(d.layout.screens, others), SNAP_PX * (d.layout.scale || 1));
        }
        await frames.setRect(id, r.x, r.y, r.w, r.h).catch(() => undefined);
      } while (again.current);
    } finally {
      stepping.current = false;
    }
  }, [id]);
  const endDrag = useCallback((e?: React.PointerEvent) => {
    if (e && drag.current && e.pointerId !== drag.current.pointer) return;
    dragToken.current++;
    drag.current = null;
    if (e && e.type !== "lostpointercapture") {
      const el = e.currentTarget as HTMLElement;
      if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
    }
  }, []);
  const startDrag = useCallback(
    (edge: Edge) => (e: React.PointerEvent) => {
      if (e.button !== 0 || full) return;
      e.preventDefault();
      e.stopPropagation();
      const el = e.currentTarget as HTMLElement;
      const pointer = e.pointerId;
      el.setPointerCapture(pointer);
      const token = ++dragToken.current;
      mods.current = { shift: e.shiftKey, alt: e.altKey };
      // Where the cursor is inside the window (CSS px). The window does not
      // move before the drag starts, so this gives the physical start point.
      const ox = e.clientX;
      const oy = e.clientY;
      void frames.layout(id).then(
        (layout) => {
          // A quick click may be over already: never start a drag after the button is up.
          if (token !== dragToken.current || !el.hasPointerCapture(pointer)) return;
          const scale = layout.scale || window.devicePixelRatio || 1;
          const me = layout.me ?? [frame.x, frame.y, frame.w, frame.h];
          const start = { x: me[0], y: me[1], w: me[2], h: me[3] };
          drag.current = { edge, pointer, cx: me[0] + ox * scale, cy: me[1] + oy * scale, start, layout, aspect: start.w / Math.max(1, start.h) };
        },
        () => undefined,
      );
    },
    [frame.x, frame.y, frame.w, frame.h, full, id],
  );
  const onDragMove = useCallback(
    (e: React.PointerEvent) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.pointer) return;
      // The button came up where we did not hear about it.
      if (e.buttons === 0) return endDrag(e);
      mods.current = { shift: e.shiftKey, alt: e.altKey };
      if (!raf.current)
        raf.current = requestAnimationFrame(() => {
          raf.current = 0;
          void step();
        });
    },
    [endDrag, step],
  );
  const handle = (edge: Edge, cls: string) => (
    <div
      key={edge}
      onPointerDown={startDrag(edge)}
      onPointerMove={onDragMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      style={{ cursor: `${edge}-resize` }}
      className={cn("absolute z-40", cls)}
    />
  );

  // ---------------------------------------------------------------- keys and wheel
  // Only frames that take the keyboard (boards) have keys; the bar's
  // tooltips name them there.
  useEffect(() => {
    if (!takesKeys) return;
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const lower = e.key.toLowerCase();
      const plain = !e.ctrlKey && !e.altKey && !e.metaKey;
      const done = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (e.ctrlKey && !e.shiftKey && lower === "w") return done(), close();
      if (!plain) return;
      if (lower === "f" && !e.shiftKey) return done(), toggleFull();
      if (e.key === "Escape" && full) return done(), void frames.fullscreen(id, false).then(setFull);
      if (lower === "t" && !e.shiftKey) return done(), patch({ onTop: !frame.onTop });
      if (lower === "x" && !e.shiftKey) return done(), patch({ clickThrough: true });
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [close, frame.onTop, full, id, patch, takesKeys, toggleFull]);
  const k = (key: string) => (takesKeys ? ` (${key})` : "");

  const opacityRef = useRef(frame.opacity);
  opacityRef.current = frame.opacity;
  const wrap = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (!e.shiftKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      const d = e.deltaY || e.deltaX;
      const next = Math.min(1, Math.max(0.05, Math.round((opacityRef.current + (d > 0 ? -0.05 : 0.05)) * 100) / 100));
      patch({ opacity: next });
      say(`Opacity ${Math.round(next * 100)}%`);
    };
    el.addEventListener("wheel", wheel, { passive: false, capture: true });
    return () => el.removeEventListener("wheel", wheel, { capture: true });
  }, [patch, say]);

  const barShown = (awake || overBar) && !frame.clickThrough;
  const Body = frame.kind === "board" || frame.kind === "live" ? pro.FrameBody : null;

  return (
    <div
      ref={wrap}
      className="group/frame relative h-screen w-screen overflow-hidden"
      onPointerMove={wake}
      onPointerDown={wake}
    >
      {/* The picture. Opacity applies to the content only, so the bar stays readable. */}
      <div className="absolute inset-0" style={{ opacity: frame.opacity }}>
        {frame.kind === "image" || frame.kind === "video" ? (
          <MediaBody frame={frame} say={say} onFullscreen={toggleFull} />
        ) : Body ? (
          <Suspense fallback={null}>
            <Body frame={frame} status={say} />
          </Suspense>
        ) : (
          <div className="grid h-full place-items-center bg-black/70 p-4 text-center text-[12px] text-white/75">
            This frame needs Lastshot Pro.
          </div>
        )}
      </div>

      {/* A faint outline so a see-through frame can be found while the mouse is over it. */}
      {!full && (
        <div
          className={cn(
            "pointer-events-none absolute inset-0 z-30 border transition-colors",
            barShown ? "border-white/25" : "border-transparent",
          )}
        />
      )}

      {/* Move bar. */}
      <div
        onPointerEnter={() => {
          setOverBar(true);
          loadHotkey();
        }}
        onPointerLeave={() => setOverBar(false)}
        className={cn(
          "absolute inset-x-0 top-0 z-50 transition-opacity duration-150",
          barShown ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      >
        <div className="flex h-8 items-center gap-1 bg-[#14161c]/88 pl-1 pr-1 text-white backdrop-blur">
          <div
            data-tauri-drag-region-ignore
            onPointerDown={startDrag("move")}
            onPointerMove={onDragMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onLostPointerCapture={endDrag}
            onDoubleClick={toggleFull}
            title="Drag to move (snaps to screen edges and other frames; hold Alt to stop snapping). Double-click: full screen."
            className="flex h-full min-w-0 flex-1 cursor-move items-center gap-1.5 px-1.5"
          >
            <span className="h-3 w-1 shrink-0 rounded-sm bg-white/30" />
            <span className="truncate text-[11px] text-white/80">{frame.title}</span>
          </div>
          <label
            className="flex items-center gap-1 px-1"
            title="Opacity of the picture (Shift + mouse wheel anywhere on the frame)"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <span className="text-white/60">
              <Icon d={FI.opacity} />
            </span>
            <input
              type="range"
              min={5}
              max={100}
              step={1}
              value={Math.round(frame.opacity * 100)}
              onChange={(e) => patch({ opacity: Number(e.target.value) / 100 })}
              className="h-1 w-20 accent-[#7d8ff0]"
              aria-label="Opacity"
            />
            {takesKeys ? (
              // A frame that takes the keyboard: type any value (Enter sets it).
              <>
                <NumberField
                  value={Math.round(frame.opacity * 100)}
                  min={5}
                  max={100}
                  step={1}
                  digits={0}
                  onChange={(v) => patch({ opacity: Math.round(v) / 100 })}
                  aria-label="Opacity, percent"
                  title="Type any opacity from 5 to 100 %"
                  testid="frame-opacity"
                  className="w-7 rounded border border-transparent bg-transparent px-0.5 text-right font-mono text-[10px] text-white/80 hover:border-white/20 focus:border-white/30 focus:bg-black/40 focus:outline-none"
                />
                <span className="-ml-1 font-mono text-[10px] text-white/60">%</span>
              </>
            ) : (
              // Picture and clip frames never take the keyboard: exact values are typed in the Pop-outs panel.
              <span className="w-8 text-right font-mono text-[10px] text-white/70" title="Type an exact value in Lastshot's Pop-outs panel">
                {Math.round(frame.opacity * 100)}%
              </span>
            )}
          </label>
          <Btn title={`Always on top${k("T")}`} on={frame.onTop} onClick={() => patch({ onTop: !frame.onTop })}>
            <Icon d={FI.pin} />
          </Btn>
          <Btn
            title={`Click-through${k("X")}: clicks go to the app below and this frame cannot be clicked. Turn it off from the Pop-outs panel in Lastshot, the tray menu${hotkey ? `, or ${hotkey}` : ""}.`}
            on={frame.clickThrough}
            onClick={() => patch({ clickThrough: true })}
          >
            <Icon d={FI.through} />
          </Btn>
          <Btn
            title={full ? `Leave full screen (double-click the bar${takesKeys ? " or Esc" : ""})` : `Full screen${k("F")}, or double-click the bar`}
            on={full}
            onClick={toggleFull}
          >
            <Icon d={FI.full} />
          </Btn>
          <Btn title="Show the Pop-outs panel in Lastshot" onClick={() => void frames.showPanel()}>
            <Icon d={FI.panel} />
          </Btn>
          <Btn title="Hide (bring it back from the Pop-outs panel or the tray)" onClick={() => patch({ hidden: true })}>
            <Icon d={FI.hide} />
          </Btn>
          <Btn title={`Close${k("Ctrl+W")}`} onClick={close} className="hover:bg-red-500/70">
            <Icon d={FI.close} />
          </Btn>
        </div>
      </div>

      {status && (
        <div className="pointer-events-none absolute left-1/2 top-10 z-50 -translate-x-1/2 rounded-md bg-black/75 px-2.5 py-1 text-[11px] text-white">
          {status}
        </div>
      )}

      {/* Resize edges and corners (hidden in full screen and click-through). */}
      {!full && !frame.clickThrough && (
        <>
          {handle("n", "inset-x-3 top-0 h-1.5")}
          {handle("s", "inset-x-3 bottom-0 h-1.5")}
          {handle("w", "inset-y-3 left-0 w-1.5")}
          {handle("e", "inset-y-3 right-0 w-1.5")}
          {handle("nw", "left-0 top-0 h-3 w-3")}
          {handle("ne", "right-0 top-0 h-3 w-3")}
          {handle("sw", "bottom-0 left-0 h-3 w-3")}
          {handle("se", "bottom-0 right-0 h-3 w-3")}
        </>
      )}
    </div>
  );
}

/** A picture or a playing clip in the viewer; remembers its view and settings. */
function MediaBody({ frame, say, onFullscreen }: { frame: Frame; say: (m: string) => void; onFullscreen: () => void }) {
  const saved = useMemo(() => (frame.view ?? {}) as FrameViewState, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [settings, setSettings] = useState<ViewerSettings>({ ...DEFAULT_SETTINGS, ...(saved.s ?? {}) });
  const [source, setSource] = useState<HTMLImageElement | HTMLVideoElement | null>(null);
  const [error, setError] = useState("");
  const state = useRef<FrameViewState>({ ...saved, s: settings });
  const saveTimer = useRef(0);
  const dirty = useRef(false);
  // Saves the view (and the panel's badges) now, if anything waits.
  const saveNow = useCallback(() => {
    window.clearTimeout(saveTimer.current);
    if (!dirty.current) return Promise.resolve();
    dirty.current = false;
    return frames.update(frame.id, { view: state.current, badges: badgesOf(state.current) }).catch(() => undefined);
  }, [frame.id]);
  const save = useCallback(
    (p: Partial<FrameViewState>) => {
      state.current = { ...state.current, ...p };
      dirty.current = true;
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => void saveNow(), 700);
    },
    [saveNow],
  );
  // Before the frame closes or the page goes away, nothing waits.
  useEffect(() => {
    const off = onFlush(saveNow);
    const gone = () => void saveNow();
    window.addEventListener("pagehide", gone);
    window.addEventListener("beforeunload", gone);
    return () => {
      off();
      window.removeEventListener("pagehide", gone);
      window.removeEventListener("beforeunload", gone);
      void saveNow();
    };
  }, [saveNow]);
  const url = useMemo(() => assetUrl(frame.src) || frame.src, [frame.src]);

  // The Pop-outs panel in the main window drives the view (a click-through
  // frame cannot be clicked).
  const api = useRef<ViewerApi | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const sourceRef = useRef(source);
  sourceRef.current = source;
  useEffect(() => {
    let off: (() => void) | undefined;
    let alive = true;
    const setS = (s: ViewerSettings) => {
      setSettings(s);
      save({ s });
    };
    const run = (cmd: FrameCmd) => {
      const a = api.current;
      const s = settingsRef.current;
      if (cmd === "gray") return setS({ ...s, adjust: { ...s.adjust, grayscale: s.adjust.grayscale >= 0.5 ? 0 : 1 } });
      if (cmd === "grid")
        return setS({ ...s, grid: { ...s.grid, kind: s.grid.kind === "off" ? (s.grid.cols === 4 && s.grid.rows === 4 ? "thirds" : "custom") : "off" } });
      if (!a) return;
      const v = a.getView();
      const st = a.stage();
      const n = naturalSize(sourceRef.current);
      const c = n.w > 0 && n.h > 0 ? n : null;
      const dpr = window.devicePixelRatio || 1;
      const centre = { x: st.w / 2, y: st.h / 2 };
      if (cmd === "zoomIn") a.setView(zoomAt(v, centre, 1.25, dpr));
      else if (cmd === "zoomOut") a.setView(zoomAt(v, centre, 1 / 1.25, dpr, c ? fitView(c, st).scale / 4 : undefined));
      else if (cmd === "fit") a.fit();
      else if (cmd === "actual") a.setView(actualView(st, v, dpr));
      else if (cmd === "flipH") a.setView(flipScreenH(v));
      else if (cmd === "flipV") a.setView(flipScreenV(v));
      else if (cmd === "reset") {
        setS({ ...s, adjust: { ...s.adjust, grayscale: 0 }, grid: { ...s.grid, kind: "off" } });
        if (c) a.setView(fitView(c, st));
      }
    };
    void frames.onCommand(frame.id, run).then((u) => (alive ? (off = u) : u()));
    return () => {
      alive = false;
      off?.();
    };
  }, [frame.id, save]);

  useEffect(() => {
    if (frame.kind !== "image") return;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.onload = () => setSource(img);
    img.onerror = () => setError("This picture could not be loaded (was the file moved?).");
    img.src = url;
    return () => {
      img.onload = null;
      img.onerror = null;
    };
  }, [frame.kind, url]);

  const videoRef = useCallback(
    (v: HTMLVideoElement | null) => {
      if (!v) return;
      setSource(v);
      v.muted = saved.muted ?? true;
      v.addEventListener(
        "loadedmetadata",
        () => {
          if (saved.t && saved.t < v.duration) v.currentTime = saved.t;
          if (saved.playing !== false) void v.play().catch(() => undefined);
        },
        { once: true },
      );
      v.addEventListener("pause", () => save({ t: v.currentTime, playing: false }));
      v.addEventListener("play", () => save({ playing: true }));
    },
    [save, saved],
  );

  const toggle = useCallback(() => {
    const v = source instanceof HTMLVideoElement ? source : null;
    if (!v) return;
    if (v.paused) void v.play().catch(() => undefined);
    else v.pause();
  }, [source]);

  if (error) return <div className="grid h-full place-items-center bg-black/70 p-4 text-center text-[12px] text-white/75">{error}</div>;
  return (
    <>
      {frame.kind === "video" && (
        <video
          ref={videoRef}
          src={url}
          crossOrigin="anonymous"
          playsInline
          preload="auto"
          onError={() => setError("This clip could not be played (was the file moved?).")}
          className="pointer-events-none absolute left-0 top-0 h-px w-px opacity-0"
        />
      )}
      <Viewer
        className="absolute inset-0"
        source={source}
        video={source instanceof HTMLVideoElement ? source : null}
        fps={60}
        name={frame.title}
        background="none"
        bar="auto"
        barPlace="bottom"
        videoBar={frame.kind === "video"}
        apiRef={api}
        initialView={(saved.v as View | undefined) ?? null}
        onViewChange={(v) => save({ v })}
        settings={settings}
        onSettingsChange={(s) => {
          setSettings(s);
          save({ s });
        }}
        onTap={frame.kind === "video" ? toggle : undefined}
        onDoubleClick={onFullscreen}
        onStatus={say}
      />
    </>
  );
}
