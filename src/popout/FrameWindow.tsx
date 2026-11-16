/**
 * The inside of a pop-out frame window (`frame-<id>`): a borderless,
 * see-through window showing a picture, a playing clip or (Pro) a board.
 *
 * - The window is the content. Its tools are a strip that grows the window
 *   *outside* the content while the mouse is over it (below; above near a
 *   screen's bottom), so they never cover the picture. "View tools" adds the
 *   viewer's tool row to that strip.
 * - Resize edges keep the shape (Shift frees it) and the picture follows the
 *   window; the frame snaps to screen edges and other frames (Alt: no snap).
 * - Right-click anywhere: every action in one menu.
 * - Click-through: clicks reach the app below. It says how to get back when
 *   it turns on, keeps a small marker, and holding Ctrl+Alt over the frame
 *   makes it clickable again with "Turn off click-through" in its strip.
 *   The Pop-outs panel, the tray and the shortcut also turn it off.
 */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import pro from "lastshot-pro";
import Viewer, { DEFAULT_SETTINGS, type ViewerApi, type ViewerSettings } from "../viewer/Viewer";
import { Btn, Icon } from "../viewer/ui";
import { actualView, fitView, flipScreenH, flipScreenV, zoomAt, type Size, type View } from "../viewer/math";
import { naturalSize } from "../viewer/render";
import { assetUrl } from "../lib/bridge";
import { useShortcuts } from "../lib/useShortcuts";
import { fk } from "./frameKeys";
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
  type ContentInfo,
  type Frame,
  type FrameCmd,
  type FrameViewState,
  type Layout,
} from "./frames";
import { dragRect, snapRect, snapTargets, type Edge, type R } from "./snap";

const SNAP_PX = 10;
/** How long the strip stays after the mouse left the frame. */
const HIDE_MS = 900;
/** The strip's own row (CSS px); the tool row adds to it. */
export const STRIP_H = 30;
/** How long the "click-through is on" hint stays. */
const HINT_MS = 7000;
const TOOLS_KEY = "lastshot.frame.tools";

export const FI = {
  pin: "M6 2h4l-.5 4 2.5 2.5H4L6.5 6zM8 8.5V14",
  through: "M4 2l9 5-4 1 3 5-1.5.8-3-5L4 11z",
  full: "M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4",
  hide: "M2 8s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4zM2 2l12 12",
  close: "M4 4l8 8M12 4l-8 8",
  opacity: "M8 2a6 6 0 1 0 0 12zM8 2a6 6 0 0 1 0 12",
  panel: "M2 3h12v10H2zM2 6h12M5 9h6",
  more: "M3.5 8h.01M8 8h.01M12.5 8h.01",
  tools: "M2 4h12M2 8h12M2 12h7",
  play: "M5 3.5v9l7-4.5z",
  pause: "M5 3.5v9M11 3.5v9",
  sound: "M3 6h2.5L9 3v10L5.5 10H3zM11.5 5.5a3.5 3.5 0 0 1 0 5",
  mute: "M3 6h2.5L9 3v10L5.5 10H3zM11 6l3.5 4M14.5 6 11 10",
};

/** A yes/no question shown inside the frame window (frames have no dialogs). */
export interface Ask {
  text: string;
  yes: string;
  onYes: () => void;
}

const readTools = () => {
  try {
    return localStorage.getItem(TOOLS_KEY) === "1";
  } catch {
    return false;
  }
};

const fmtTime = (t: number) => {
  if (!Number.isFinite(t) || t < 0) return "0:00";
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
};

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
      className="absolute inset-0 z-[80] grid place-items-center bg-black/55 p-3"
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

/** What the media body hands up for the strip and the menu. */
interface MediaHandle {
  api: ViewerApi | null;
  video: HTMLVideoElement | null;
  run: (cmd: FrameCmd) => void;
}

type FramePatch = Partial<Pick<Frame, "opacity" | "onTop" | "clickThrough" | "hidden">>;

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
  const media = frame.kind === "image" || frame.kind === "video";
  // Picture and clip frames never take the keyboard focus (the app you trace
  // in keeps it); a board does once clicked, so only boards have keys.
  const takesKeys = frame.kind === "board";
  // The click-through shortcut, as set in the Pop-outs panel.
  const [hotkey, setHotkey] = useState("");
  const loadHotkey = useCallback(() => void frames.getHotkey().then(setHotkey, () => undefined), []);
  useEffect(loadHotkey, [loadHotkey]);
  const [full, setFull] = useState(false);

  // ---------------------------------------------------------------- content size and the strip
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);
  const [content, setContent] = useState<{ w: number; h: number }>({ w: frame.w, h: frame.h });
  const [side, setSide] = useState<ContentInfo["side"]>("none");
  const [winW, setWinW] = useState(() => window.innerWidth);
  const [winH, setWinH] = useState(() => window.innerHeight);
  useEffect(() => {
    const r = () => {
      setDpr(window.devicePixelRatio || 1);
      setWinW(window.innerWidth);
      setWinH(window.innerHeight);
    };
    window.addEventListener("resize", r);
    let off: (() => void) | undefined;
    let alive = true;
    void frames
      .onContent((c) => {
        setContent({ w: c.w, h: c.h });
        setSide(c.side);
      })
      .then((u) => (alive ? (off = u) : u()));
    // Asks for the current content size (and drops a strip left from before).
    void frames.chrome(id, 0).then(setSide, () => undefined);
    return () => {
      alive = false;
      off?.();
      window.removeEventListener("resize", r);
    };
  }, [id]);

  const [hover, setHover] = useState(false);
  const leaveTimer = useRef(0);
  const enter = useCallback(() => {
    window.clearTimeout(leaveTimer.current);
    setHover(true);
  }, []);
  const leave = useCallback(() => {
    window.clearTimeout(leaveTimer.current);
    leaveTimer.current = window.setTimeout(() => setHover(false), HIDE_MS);
  }, []);
  useEffect(() => {
    document.documentElement.addEventListener("mouseleave", leave);
    return () => document.documentElement.removeEventListener("mouseleave", leave);
  }, [leave]);

  const [peek, setPeek] = useState(false);
  useEffect(() => {
    let off: (() => void) | undefined;
    let alive = true;
    void frames
      .onPeek((on) => {
        setPeek(on);
        if (on) {
          loadHotkey();
          enter();
        }
      })
      .then((u) => (alive ? (off = u) : u()));
    return () => {
      alive = false;
      off?.();
    };
  }, [enter, loadHotkey]);
  useEffect(() => {
    if (!frame.clickThrough) setPeek(false);
  }, [frame.clickThrough]);

  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [tools, setToolsState] = useState(readTools);
  const setTools = useCallback((on: boolean) => {
    setToolsState(on);
    try {
      localStorage.setItem(TOOLS_KEY, on ? "1" : "0");
    } catch {
      /* a preference only */
    }
  }, []);
  const [dragging, setDragging] = useState(false);

  const stripRef = useRef<HTMLDivElement | null>(null);
  const [stripH, setStripH] = useState(STRIP_H);
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStripH(Math.ceil(el.getBoundingClientRect().height)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [toolTarget, setToolTarget] = useState<HTMLDivElement | null>(null);

  // The strip shows while the mouse is over the frame (and it can be used).
  const usable = !frame.clickThrough || peek;
  const want = !full && usable && (hover || peek || dragging || !!menu);
  const asked = useRef(-1);
  useEffect(() => {
    const h = want ? stripH : 0;
    if (asked.current === h) return;
    asked.current = h;
    void frames.chrome(id, h).then(setSide, () => undefined);
  }, [want, stripH, id]);

  // ---------------------------------------------------------------- settings
  const patch = useCallback(
    (p: FramePatch) => {
      if (p.opacity !== undefined) markOpacity();
      setFrame({ ...frame, ...p });
      void frames.update(id, p).catch((e) => say(String(e)));
    },
    [frame, id, markOpacity, say, setFrame],
  );

  // "Click-through is on": how to get back, said each time it turns on.
  const [hintOn, setHintOn] = useState(false);
  const wasThrough = useRef(frame.clickThrough);
  useEffect(() => {
    const was = wasThrough.current;
    wasThrough.current = frame.clickThrough;
    if (!frame.clickThrough) return setHintOn(false);
    if (was) return;
    loadHotkey();
    setHintOn(true);
    const t = window.setTimeout(() => setHintOn(false), HINT_MS);
    return () => window.clearTimeout(t);
  }, [frame.clickThrough, loadHotkey]);

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
  // a move onto a monitor with other scaling does not jump. Rectangles are
  // the content's; the strip stays outside.
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
    setDragging(false);
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
      setDragging(true);
      void frames.layout(id).then(
        (layout) => {
          // A quick click may be over already: never start a drag after the button is up.
          if (token !== dragToken.current || !el.hasPointerCapture(pointer)) return;
          const me = layout.me ?? [frame.x, frame.y, frame.w, frame.h];
          const start = { x: me[0], y: me[1], w: me[2], h: me[3] };
          // The drag starts where the cursor is now (physical px): the window
          // is the content plus the strip, so window-relative offsets would not do.
          const cur = layout.cursor ?? [me[0], me[1]];
          drag.current = { edge, pointer, cx: cur[0], cy: cur[1], start, layout, aspect: start.w / Math.max(1, start.h) };
        },
        () => setDragging(false),
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
      data-testid={`frame-edge-${edge}`}
    />
  );

  // ---------------------------------------------------------------- media (viewer + video)
  const mediaRef = useRef<MediaHandle>({ api: null, video: null, run: () => undefined });
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [vt, setVt] = useState({ t: 0, d: 0, playing: false, muted: true });
  useEffect(() => {
    if (!video) return;
    const sync = () => setVt({ t: video.currentTime, d: video.duration || 0, playing: !video.paused, muted: video.muted });
    const evs = ["timeupdate", "play", "pause", "loadedmetadata", "volumechange", "seeked"];
    evs.forEach((e) => video.addEventListener(e, sync));
    sync();
    return () => evs.forEach((e) => video.removeEventListener(e, sync));
  }, [video]);
  const playPause = () => {
    if (!video) return;
    if (video.paused) void video.play().catch(() => undefined);
    else video.pause();
  };

  // ---------------------------------------------------------------- keys (boards) and wheel
  // Only frames that take the keyboard (boards) have keys; for picture and
  // clip frames everything is on the strip, the right-click menu and the
  // Pop-outs panel.
  const setOpacityBy = (d: number) => patch({ opacity: Math.min(1, Math.max(0.05, Math.round((frame.opacity + d) * 100) / 100)) });
  useShortcuts(
    "frame",
    [
      { ...fk("close"), run: close },
      { ...fk("full"), run: toggleFull },
      {
        ...fk("leave-full"),
        run: () => void frames.fullscreen(id, false).then(setFull),
        when: () => full,
      },
      { ...fk("on-top"), run: () => patch({ onTop: !frame.onTop }) },
      { ...fk("through"), run: () => patch({ clickThrough: true }) },
      { ...fk("opacity-down"), run: () => setOpacityBy(-0.1) },
      { ...fk("opacity-up"), run: () => setOpacityBy(0.1) },
      { ...fk("menu"), run: () => setMenu({ x: 12, y: 12 }) },
    ],
    takesKeys,
  );
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

  const Body = frame.kind === "board" || frame.kind === "live" ? pro.FrameBody : null;

  // ---------------------------------------------------------------- layout
  // The content keeps its size and place while the window grows around it:
  // anchored to the top when the strip is below, to the bottom when above.
  const contentCssH = full ? Math.max(40, winH - STRIP_H) : Math.max(1, Math.min(winH, content.h / dpr));
  const stripAbove = side === "top" && !full;
  const contentStyle: React.CSSProperties = stripAbove ? { bottom: 0, height: contentCssH } : { top: 0, height: contentCssH };
  const stripStyle: React.CSSProperties = full ? { bottom: 0 } : stripAbove ? { bottom: contentCssH } : { top: contentCssH };
  const narrow = winW < 300;
  const stripBtn = "grid h-6 w-6 shrink-0 place-items-center rounded text-white/80 hover:bg-white/12 hover:text-white";

  return (
    <div
      ref={wrap}
      className="group/frame relative h-screen w-screen overflow-hidden"
      onPointerEnter={enter}
      onPointerMove={enter}
      onPointerDown={enter}
      onPointerLeave={leave}
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest("input, textarea, [data-frame-menu]")) return;
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      {/* The content: the picture or clip, at the frame's own size. */}
      <div className="absolute inset-x-0" style={contentStyle} data-testid="frame-content">
        {/* Opacity applies to the content only, so the strip stays readable. */}
        <div className="absolute inset-0" style={{ opacity: frame.opacity }}>
          {media ? (
            <MediaBody
              frame={frame}
              say={say}
              onFullscreen={toggleFull}
              handle={mediaRef}
              onVideo={setVideo}
              tools={tools}
              toolTarget={toolTarget}
            />
          ) : Body ? (
            <Suspense fallback={null}>
              <Body frame={frame} status={say} />
            </Suspense>
          ) : (
            <div className="grid h-full place-items-center bg-black/70 p-4 text-center text-[12px] text-white/75">This frame needs Lastshot Pro.</div>
          )}
        </div>

        {/* A faint outline so a see-through frame can be found while the mouse is over it. */}
        {!full && (
          <div className={cn("pointer-events-none absolute inset-0 z-30 border transition-colors", want ? "border-white/25" : "border-transparent")} />
        )}

        {/* Click-through: a small, quiet marker while it is on. */}
        {frame.clickThrough && !peek && (
          <div
            className="pointer-events-none absolute right-1 top-1 z-30 grid h-[18px] w-[18px] place-items-center rounded-full bg-black/55 text-white/80 ring-1 ring-white/20"
            data-testid="frame-through-marker"
          >
            <svg viewBox="0 0 16 16" className="h-3 w-3 fill-none stroke-current" strokeWidth="1.6" strokeLinejoin="round">
              <path d={FI.through} />
            </svg>
          </div>
        )}
        {hintOn && frame.clickThrough && !peek && (
          <div
            className="pointer-events-none absolute inset-x-2 bottom-2 z-40 rounded-md bg-black/80 px-2.5 py-1.5 text-[11px] leading-snug text-white shadow-lg"
            data-testid="frame-through-hint"
          >
            <b>Click-through is on:</b> clicks reach the app below. To use this frame again, hold <b>Ctrl+Alt</b> over it
            {hotkey ? (
              <>
                , press <b>{hotkey}</b>
              </>
            ) : null}
            , or use Lastshot's tray › <b>Frames: turn off click-through</b>.
          </div>
        )}

        {status && (
          <div className="pointer-events-none absolute left-1/2 top-2 z-50 max-w-[90%] -translate-x-1/2 rounded-md bg-black/75 px-2.5 py-1 text-center text-[11px] text-white">
            {status}
          </div>
        )}

        {/* Resize edges and corners of the content (not in full screen or click-through). */}
        {!full && usable && (
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

      {/* The strip: outside the content (the window grows to show it). */}
      <div
        ref={stripRef}
        className={cn(
          "absolute inset-x-0 z-50 flex flex-col bg-[#14161c] text-white",
          stripAbove ? "border-b border-white/10" : "border-t border-white/10",
        )}
        style={stripStyle}
        data-testid="frame-strip"
        onPointerEnter={loadHotkey}
      >
        {peek && frame.clickThrough && (
          <div className="flex items-center gap-1.5 bg-[#5d72db]/30 px-1.5 py-1 text-[11px]" data-testid="frame-peek">
            <span className="min-w-0 flex-1 truncate text-white/85">Clickable while the mouse is here</span>
            <button
              type="button"
              data-testid="frame-peek-off"
              onClick={() => patch({ clickThrough: false })}
              className="shrink-0 rounded bg-[#5d72db] px-2 py-0.5 font-semibold text-white hover:bg-[#6f83ea]"
            >
              Turn off click-through
            </button>
          </div>
        )}
        <div className="flex items-center gap-0.5 pl-1 pr-1" style={{ height: STRIP_H }}>
          <div
            onPointerDown={startDrag("move")}
            onPointerMove={onDragMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onLostPointerCapture={endDrag}
            onDoubleClick={toggleFull}
            title="Drag to move (snaps to screen edges and other frames; hold Alt to stop snapping). Double-click: full screen. Right-click: everything."
            className="flex h-full min-w-[24px] flex-1 cursor-move items-center gap-1.5 px-1"
            data-testid="frame-grip"
          >
            <span className="h-3 w-1 shrink-0 rounded-sm bg-white/30" />
            {!narrow && <span className="truncate text-[11px] text-white/80">{frame.title}</span>}
          </div>
          {frame.kind === "video" && video && (
            <>
              <button type="button" className={stripBtn} title={vt.playing ? "Pause" : "Play"} onClick={playPause} data-testid="frame-play">
                <Icon d={vt.playing ? FI.pause : FI.play} />
              </button>
              {winW >= 360 && (
                <input
                  type="range"
                  min={0}
                  max={Math.max(0.01, vt.d)}
                  step={0.01}
                  value={Math.min(vt.t, vt.d || 0)}
                  onChange={(e) => {
                    video.currentTime = Number(e.target.value);
                  }}
                  className="h-1 w-20 shrink accent-[#7d8ff0]"
                  aria-label="Position"
                  title="Position"
                />
              )}
              {winW >= 260 && <span className="shrink-0 px-0.5 font-mono text-[10px] text-white/70">{fmtTime(vt.t)}</span>}
              <button
                type="button"
                className={stripBtn}
                title={vt.muted ? "Sound on" : "Mute"}
                onClick={() => {
                  video.muted = !video.muted;
                }}
              >
                <Icon d={vt.muted ? FI.mute : FI.sound} />
              </button>
            </>
          )}
          {winW >= 420 && (
            <label className="flex shrink-0 items-center gap-1 px-1" title="Opacity of the picture (Shift + mouse wheel anywhere on the frame)">
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
                className="h-1 w-16 accent-[#7d8ff0]"
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
                // Picture and clip frames never take the keyboard: presets are in the menu, exact values in the Pop-outs panel.
                <span className="w-8 text-right font-mono text-[10px] text-white/70" title="Right-click for presets; type an exact value in Lastshot's Pop-outs panel">
                  {Math.round(frame.opacity * 100)}%
                </span>
              )}
            </label>
          )}
          {media && (
            <Btn title={tools ? "Hide the view tools" : "View tools: zoom, turn, mirror, grid, colour, compare…"} on={tools} onClick={() => setTools(!tools)}>
              <Icon d={FI.tools} />
            </Btn>
          )}
          {winW >= 200 && (
            <Btn title={`Always on top${k("T")}`} on={frame.onTop} onClick={() => patch({ onTop: !frame.onTop })}>
              <Icon d={FI.pin} />
            </Btn>
          )}
          <Btn
            title={
              frame.clickThrough
                ? "Click-through is on: turn it off"
                : `Click-through${k("X")}: clicks go to the app below. To get the frame back, hold Ctrl+Alt over it${hotkey ? `, press ${hotkey}` : ""}, or use the tray or the Pop-outs panel.`
            }
            on={frame.clickThrough}
            onClick={() => patch({ clickThrough: !frame.clickThrough })}
          >
            <Icon d={FI.through} />
          </Btn>
          {winW >= 240 && (
            <Btn title={full ? `Leave full screen (double-click the strip${takesKeys ? " or Esc" : ""})` : `Full screen${k("F")}, or double-click`} on={full} onClick={toggleFull}>
              <Icon d={FI.full} />
            </Btn>
          )}
          <Btn
            title="Everything (or right-click the frame)"
            on={!!menu}
            onClick={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setMenu(menu ? null : { x: r.left, y: stripAbove ? r.bottom + 2 : Math.max(0, r.top - 4) });
            }}
          >
            <Icon d={FI.more} />
          </Btn>
          {winW >= 280 && (
            <Btn title="Hide (bring it back from the Pop-outs panel or the tray)" onClick={() => patch({ hidden: true })}>
              <Icon d={FI.hide} />
            </Btn>
          )}
          <Btn title={`Close${k("Ctrl+W")}`} onClick={close} className="hover:bg-red-500/70">
            <Icon d={FI.close} />
          </Btn>
        </div>
        {/* The viewer's tool row, when "View tools" is on. */}
        <div ref={setToolTarget} className={cn(!(tools && media) && "hidden")} data-testid="frame-tools" />
      </div>

      {menu && (
        <FrameMenu
          at={menu}
          onClose={() => setMenu(null)}
          frame={frame}
          full={full}
          tools={tools}
          hotkey={hotkey}
          media={media ? mediaRef.current : null}
          video={video}
          patch={patch}
          setTools={setTools}
          toggleFull={toggleFull}
          close={close}
        />
      )}
    </div>
  );
}

/** The right-click menu: every action of a frame in one place. */
function FrameMenu({
  at,
  onClose,
  frame,
  full,
  tools,
  hotkey,
  media,
  video,
  patch,
  setTools,
  toggleFull,
  close,
}: {
  at: { x: number; y: number };
  onClose: () => void;
  frame: Frame;
  full: boolean;
  tools: boolean;
  hotkey: string;
  media: MediaHandle | null;
  video: HTMLVideoElement | null;
  patch: (p: FramePatch) => void;
  setTools: (on: boolean) => void;
  toggleFull: () => void;
  close: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState(at);
  // Kept inside the window (it scrolls when the window is small).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.max(4, Math.min(at.x, window.innerWidth - r.width - 4)), y: Math.max(4, Math.min(at.y, window.innerHeight - r.height - 4)) });
  }, [at]);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    const blur = () => onClose();
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", blur);
    };
  }, [onClose]);
  const item = (label: string, run: () => void, opts: { on?: boolean; hint?: string; danger?: boolean; testid?: string } = {}): ReactNode => (
    <button
      key={label}
      type="button"
      role="menuitem"
      data-testid={opts.testid}
      onClick={() => {
        onClose();
        run();
      }}
      className={cn(
        "flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[11.5px]",
        opts.danger ? "text-red-300 hover:bg-red-500/25" : "text-white/85 hover:bg-white/10",
      )}
    >
      <span className="w-3 text-center text-[10px] text-[#9fb0ff]">{opts.on ? "✓" : ""}</span>
      <span className="flex-1">{label}</span>
      {opts.hint && <span className="font-mono text-[10px] text-white/40">{opts.hint}</span>}
    </button>
  );
  const sep = (key: string) => <div key={key} className="my-1 h-px bg-white/10" />;
  const a = media?.api ?? null;
  const run = (cmd: FrameCmd) => media?.run(cmd);
  return (
    <div
      ref={ref}
      data-frame-menu
      role="menu"
      className="absolute z-[70] max-h-[calc(100vh-8px)] w-[230px] overflow-y-auto rounded-lg border border-white/15 bg-[#1c1e25] p-1 shadow-2xl"
      style={{ left: pos.x, top: pos.y }}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      data-testid="frame-menu"
    >
      {frame.clickThrough && [item("Turn off click-through", () => patch({ clickThrough: false }), { testid: "frame-menu-through-off" }), sep("ct")]}
      {video && [
        item(video.paused ? "Play" : "Pause", () => (video.paused ? void video.play().catch(() => undefined) : video.pause())),
        item(video.muted ? "Sound on" : "Mute", () => {
          video.muted = !video.muted;
        }),
        sep("v"),
      ]}
      {a && [
        item("Fit", () => a.fit(), { on: a.fitted(), testid: "frame-menu-fit" }),
        item("100 %", () => a.zoom100()),
        item("Zoom in", () => a.zoomBy(1.5), { hint: "wheel" }),
        item("Zoom out", () => a.zoomBy(1 / 1.5)),
        item("Turn right 90°", () => a.turn(90), { testid: "frame-menu-turn" }),
        item("Turn left 90°", () => a.turn(-90)),
        item("Mirror left↔right", () => a.mirror()),
        item("Flip upside down", () => a.flipV()),
        item("Grey", () => run("gray")),
        item("Grid", () => run("grid")),
        item("Undo", () => void a.undo()),
        item("Reset the view", () => a.resetAll()),
        sep("view"),
        item("Copy picture", () => void a.copyFrame()),
        item("Save picture as PNG", () => void a.saveFrame()),
        sep("pic"),
      ]}
      <div className="flex items-center gap-1 px-2 py-1 text-[11px] text-white/60" data-testid="frame-menu-opacity">
        <span className="flex-1">Opacity</span>
        {[100, 75, 50, 25].map((o) => (
          <button
            key={o}
            type="button"
            onClick={() => patch({ opacity: o / 100 })}
            className={cn(
              "rounded px-1.5 py-0.5 font-mono text-[10px]",
              Math.round(frame.opacity * 100) === o ? "bg-[#5d72db] text-white" : "bg-white/10 text-white/80 hover:bg-white/20",
            )}
          >
            {o}
          </button>
        ))}
      </div>
      {item("Always on top", () => patch({ onTop: !frame.onTop }), { on: frame.onTop })}
      {!frame.clickThrough && item("Click-through", () => patch({ clickThrough: true }), { hint: hotkey || undefined, testid: "frame-menu-through" })}
      {item(full ? "Leave full screen" : "Full screen", toggleFull, { on: full, hint: "double-click" })}
      {media && item("View tools in the strip", () => setTools(!tools), { on: tools, testid: "frame-menu-tools" })}
      {sep("frame")}
      {item("Pop-outs panel in Lastshot", () => void frames.showPanel())}
      {item("Hide", () => patch({ hidden: true }))}
      {item("Close", close, { danger: true })}
    </div>
  );
}

/** A picture or a playing clip in the viewer; remembers its view and settings. */
function MediaBody({
  frame,
  say,
  onFullscreen,
  handle,
  onVideo,
  tools,
  toolTarget,
}: {
  frame: Frame;
  say: (m: string) => void;
  onFullscreen: () => void;
  handle: React.MutableRefObject<MediaHandle>;
  onVideo: (v: HTMLVideoElement | null) => void;
  tools: boolean;
  toolTarget: HTMLElement | null;
}) {
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

  // The Pop-outs panel in the main window and the menu drive the view (a
  // click-through frame cannot be clicked).
  const api = useRef<ViewerApi | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const run = useCallback(
    (cmd: FrameCmd) => {
      const setS = (s: ViewerSettings) => {
        setSettings(s);
        save({ s });
      };
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
    },
    [save],
  );
  handle.current.run = run;
  useEffect(() => {
    let off: (() => void) | undefined;
    let alive = true;
    void frames.onCommand(frame.id, run).then((u) => (alive ? (off = u) : u()));
    return () => {
      alive = false;
      off?.();
    };
  }, [frame.id, run]);

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
      handle.current.video = v;
      onVideo(v);
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
      v.addEventListener("volumechange", () => save({ muted: v.muted }));
    },
    [save, saved, handle, onVideo],
  );

  const toggle = useCallback(() => {
    const v = source instanceof HTMLVideoElement ? source : null;
    if (!v) return;
    if (v.paused) void v.play().catch(() => undefined);
    else v.pause();
  }, [source]);

  // A remembered view: a fitted one fits again; a zoomed one is scaled from
  // the stage it was made for (a frame restored at another size or DPI). A
  // view handed in without its stage (older saves) starts fitted, keeping
  // its turn and flips.
  const initialFitted = saved.v ? (saved.fit ?? !saved.st) : undefined;

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
        bar={tools && toolTarget ? "show" : "none"}
        barTarget={tools ? toolTarget : null}
        barPlace="bottom"
        videoBar={frame.kind === "video"}
        keys={false}
        follow="scale"
        apiRef={(a: ViewerApi | null) => {
          api.current = a;
          handle.current.api = a;
        }}
        initialView={(saved.v as View | undefined) ?? null}
        initialStage={(saved.st as Size | undefined) ?? null}
        initialFitted={initialFitted}
        onViewChange={(v, st, _c, fitted) => save({ v, st, fit: fitted })}
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
