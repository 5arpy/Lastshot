/**
 * The viewer: zoom, pan, rotate and inspect a picture or a playing video.
 * Shared by the clip editor, the snip editor and pop-out frames.
 *
 * - Wheel zooms at the cursor (fit … 6400 %), nearest-neighbour above 100 %.
 * - Drag (or Space+drag, or the middle button) pans.
 * - Ctrl+wheel steps frames, Alt+wheel turns the picture.
 * - Keys: 0 fit · 1 100 % · 2 fill · [ ] turn · H mirror · M value check ·
 *   G grid · C colour picker · D measure · W compare · E colour · Ctrl+0 reset;
 *   video: , . frame (Shift ×10) · J K L speed · A B loop · N onion skin.
 *
 * The picture is drawn on one canvas through a transform (see render.ts);
 * nothing is decoded again when zooming.
 */
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import {
  DEFAULT_GRID,
  IDENTITY,
  NO_ADJUST,
  actualView,
  clampCrop,
  clampPan,
  fillView,
  fitView,
  followStage,
  flipScreenH,
  flipScreenV,
  frameIndex,
  hex,
  hsl,
  isNeutral,
  loopJump,
  luma,
  nextSpeed,
  pixelAt,
  rotateBy,
  sameView,
  snapAngle,
  stepTime,
  toContent,
  wheelFactor,
  zoomAt,
  zoomPercent,
  type Adjust,
  type GridSpec,
  type LoopRange,
  type Pt,
  type Rect,
  type Size,
  type StageFollow,
  type View,
} from "./math";
import {
  canvasPng,
  contentSize,
  cssFilter,
  drawBase,
  drawCompare,
  drawOverlay,
  frameCanvas,
  naturalSize,
  readPixel,
  sideViews,
  type CompareMode,
  type CompareSource,
  type Ghost,
  type Scene,
} from "./render";
import { copyPng, copyText, savePng, stampName } from "./io";
import { Btn, Chip, I, Icon, Pop, Sep, Slider } from "./ui";
import { cn } from "../utils/cn";
import { onShortcutsChange, splitKeys, effectiveKeys, type Shortcut } from "../lib/shortcuts";
import { useShortcuts } from "../lib/useShortcuts";

export interface ViewerSettings {
  adjust: Adjust;
  mono: boolean;
  grid: GridSpec;
  crop: Rect | null;
  speed: number;
  loopAll: boolean;
  ab: LoopRange;
  onion: 0 | 1 | 2;
}

export const DEFAULT_SETTINGS: ViewerSettings = {
  adjust: NO_ADJUST,
  mono: false,
  grid: DEFAULT_GRID,
  crop: null,
  speed: 1,
  loopAll: false,
  ab: { a: null, b: null },
  onion: 0,
};

export interface ViewerApi {
  fit: () => void;
  getView: () => View;
  setView: (v: View) => void;
  /** The current frame (cropped), full resolution. */
  frame: () => HTMLCanvasElement | null;
  copyFrame: () => Promise<void>;
  saveFrame: () => Promise<string | null>;
  redraw: () => void;
  stage: () => Size;
  /** Turns by degrees (keeps a fitted picture fitted). */
  turn: (deg: number) => void;
  /** Zooms around the centre. */
  zoomBy: (f: number) => void;
  zoom100: () => void;
  fill: () => void;
  mirror: () => void;
  flipV: () => void;
  /** Resets zoom, turn, flip, colour and crop. */
  resetAll: () => void;
  undo: () => boolean;
  redo: () => boolean;
  /** Whether the view follows the stage as fitted (not zoomed or panned by the user). */
  fitted: () => boolean;
}

export interface ContentPointer {
  down: (p: Pt, e: React.PointerEvent) => void;
  move: (p: Pt, e: React.PointerEvent) => void;
  up: (p: Pt, e: React.PointerEvent) => void;
}

export interface ViewerProps {
  source: CanvasImageSource | null;
  /** When the source is a video: enables frame tools and redraws per frame. */
  video?: HTMLVideoElement | null;
  fps?: number;
  /** Bump to redraw after the source (a canvas) changed. */
  version?: number;
  /** Base name for saved frames. */
  name?: string;
  /** The "reset" placement; default: fit. */
  homeView?: (content: Size, stage: Size, dpr: number) => View;
  /** Start here instead of the home view (a remembered view). */
  initialView?: View | null;
  /** The stage `initialView` was made for: the view is scaled to the stage it gets now. */
  initialStage?: Size | null;
  /** `initialView` was the fitted placement: fit again (keeping its turn and flips). */
  initialFitted?: boolean;
  /** How a view the user zoomed or panned follows a stage that changes size (default "centre"). */
  follow?: StageFollow;
  /** `fitted`: the view is the fitted placement (it follows the stage as such). */
  onViewChange?: (v: View, stage: Size, content: Size, fitted: boolean) => void;
  settings?: ViewerSettings;
  onSettingsChange?: (s: ViewerSettings) => void;
  /** Left-drag pans (else only Space+drag / middle button). Default true. */
  leftDragPans?: boolean;
  /** Markup on the picture (snip editor): left-button events in picture px. */
  pointer?: ContentPointer;
  /** A click without dragging (e.g. play/pause). */
  onTap?: () => void;
  onDoubleClick?: () => void;
  background?: Scene["background"];
  /** Show the tool bar ("auto": only while the mouse is over the viewer). */
  bar?: "show" | "auto" | "none";
  barPlace?: "top" | "bottom";
  /**
   * "outside" (default): the bar is a row above or below the picture and the
   * picture gets the rest; tools never cover it. "overlay": the bar floats
   * over the picture (only where the picture must fill the whole area, e.g.
   * the snip overlay that lies exactly over the screen).
   */
  barLayout?: "outside" | "overlay";
  /** Space (tapped, not held for panning) plays / pauses the video. */
  spacePlays?: boolean;
  /** Ctrl+Z / Ctrl+Y undo turns, flips, crop and colour (default true). */
  undo?: boolean;
  /** Show the video row (speed, frame step, loop, onion skin). */
  videoBar?: boolean;
  /** Extra buttons at the end of the bar. */
  extra?: ReactNode;
  /** Keyboard shortcuts (on the window). */
  keys?: boolean;
  /** Ctrl+C copies / Ctrl+S saves the frame. */
  exportKeys?: boolean;
  className?: string;
  apiRef?: Ref<ViewerApi>;
  /** Called with a status line (copied, saved, …); default: shown in the viewer. */
  onStatus?: (msg: string) => void;
}

type Drag =
  | { kind: "pan"; x0: number; y0: number; v0: View; moved: boolean; tap: boolean }
  | { kind: "measure"; a: Pt }
  | { kind: "crop"; a: Pt }
  | { kind: "wipe" }
  | { kind: "host" };

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
};

export default function Viewer(props: ViewerProps) {
  const {
    source,
    video,
    fps = 30,
    version = 0,
    name = "Lastshot",
    leftDragPans = true,
    background = "dark",
    bar = "show",
    barPlace = "top",
    videoBar = !!props.video,
    keys = true,
    exportKeys = true,
    barLayout = "outside",
    follow = "centre",
    spacePlays = false,
    undo: undoOn = true,
  } = props;

  const wrapRef = useRef<HTMLDivElement | null>(null);
  // Three stacked canvases: picture (CSS filter), compare B (CSS clip or
  // blend), overlays. Filters and blends then run in the GPU compositor.
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cmpRef = useRef<HTMLCanvasElement | null>(null);
  const ovlRef = useRef<HTMLCanvasElement | null>(null);
  /** Until this time, draw with cheap smoothing (zooming / panning). */
  const busyUntil = useRef(0);
  const settleTimer = useRef(0);
  const [stage, setStage] = useState<Size>({ w: 0, h: 0 });
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);
  const [natural, setNatural] = useState<Size>(() => naturalSize(source));

  // ---------------------------------------------------------------- settings
  const [ownSettings, setOwnSettings] = useState<ViewerSettings>(props.settings ?? DEFAULT_SETTINGS);
  const settings = props.settings ?? ownSettings;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const applySettings = useCallback(
    (next: ViewerSettings) => {
      settingsRef.current = next;
      if (props.onSettingsChange) props.onSettingsChange(next);
      else setOwnSettings(next);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.onSettingsChange],
  );
  // Undo / redo of the things a user sets (colour, grid, crop, turn, flips;
  // not zoom and pan). Slider drags count as one step.
  type Snap = { s: ViewerSettings; rot: number; flipH: boolean; flipV: boolean };
  const undoStack = useRef<Snap[]>([]);
  const redoStack = useRef<Snap[]>([]);
  const lastRemember = useRef(0);
  const viewForSnap = useRef<View | null>(null);
  const remember = useCallback((coalesce = false) => {
    const now = performance.now();
    const merge = coalesce && now - lastRemember.current < 700;
    lastRemember.current = now;
    if (merge) return;
    const v = viewForSnap.current;
    undoStack.current.push({ s: settingsRef.current, rot: v?.rot ?? 0, flipH: !!v?.flipH, flipV: !!v?.flipV });
    if (undoStack.current.length > 100) undoStack.current.shift();
    redoStack.current = [];
  }, []);
  const patch = useCallback(
    (p: Partial<ViewerSettings>) => {
      remember(true);
      applySettings({ ...settingsRef.current, ...p });
    },
    [applySettings, remember],
  );

  const content = useMemo(() => contentSize(natural, settings.crop), [natural, settings.crop]);

  // ---------------------------------------------------------------- view
  const home = useCallback(
    (c: Size, s: Size) => (props.homeView ? props.homeView(c, s, dpr) : fitView(c, s)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.homeView, dpr],
  );
  const [view, setViewState] = useState<View>(IDENTITY);
  const viewRef = useRef<View>(IDENTITY);
  viewForSnap.current = viewRef.current;
  const placed = useRef(false);
  const setView = useCallback(
    (v: View) => {
      viewRef.current = v;
      viewForSnap.current = v;
      setViewState(v);
    },
    [],
  );

  // Tools (not remembered).
  const [inspector, setInspector] = useState(false);
  const [measuring, setMeasuring] = useState(false);
  const [cropping, setCropping] = useState(false);
  const [compare, setCompare] = useState<CompareMode>("off");
  const [compareWith, setCompareWith] = useState<CompareSource | null>(null);
  const [wipe, setWipe] = useState(0.5);
  const [hover, setHover] = useState<{ p: Pt; at: Pt; rgba: [number, number, number, number] | null } | null>(null);
  const [measureLine, setMeasureLine] = useState<{ a: Pt; b: Pt } | null>(null);
  const [cropDraft, setCropDraft] = useState<Rect | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [pop, setPop] = useState<null | "grid" | "colour" | "rotate" | "compare" | "help" | "zoom">(null);
  const [status, setStatusMsg] = useState<string | null>(null);
  const [overBar, setOverBar] = useState(false);
  const [inside, setInside] = useState(false);
  const [ghosts, setGhosts] = useState<Ghost[]>([]);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const dragRef = useRef<Drag | null>(null);
  const spaceRef = useRef(false);

  const say = useCallback(
    (msg: string) => {
      if (props.onStatus) return props.onStatus(msg);
      setStatusMsg(msg);
      window.setTimeout(() => setStatusMsg((m) => (m === msg ? null : m)), 2600);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.onStatus],
  );

  // ---------------------------------------------------------------- size
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setStage({ w: el.clientWidth, h: el.clientHeight });
      setDpr(window.devicePixelRatio || 1);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    setNatural(naturalSize(source));
    if (!video) return;
    const on = () => setNatural(naturalSize(video));
    video.addEventListener("loadedmetadata", on);
    video.addEventListener("resize", on);
    return () => {
      video.removeEventListener("loadedmetadata", on);
      video.removeEventListener("resize", on);
    };
  }, [source, video, version]);

  // First placement, and keeping the picture placed while the stage resizes:
  // a fitted picture stays fitted, a zoomed or panned one follows the stage
  // as `follow` says (frames: it scales with the window).
  const userMoved = useRef(false);
  const lastStage = useRef<Size>({ w: 0, h: 0 });
  /** The fitted placement, keeping the view's turn and flips. */
  const placeHome = useCallback(
    (c: Size, st: Size, v: View) => {
      if (props.homeView) {
        const h = home(c, st);
        return { ...h, rot: v.rot, flipH: v.flipH, flipV: v.flipV };
      }
      return fitView(c, st, v);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.homeView, home],
  );
  useEffect(() => {
    if (stage.w <= 0 || stage.h <= 0 || content.w <= 0 || content.h <= 0) return;
    if (!placed.current) {
      placed.current = true;
      const iv = props.initialView;
      if (iv && props.initialFitted) {
        userMoved.current = false;
        setView(placeHome(content, stage, iv));
      } else if (iv) {
        userMoved.current = true;
        const from = props.initialStage;
        setView(from && from.w > 0 && from.h > 0 ? followStage(iv, from, stage, content, follow) : iv);
      } else setView(home(content, stage));
    } else if (!userMoved.current) {
      setView(placeHome(content, stage, viewRef.current));
    } else if (lastStage.current.w > 0 && (lastStage.current.w !== stage.w || lastStage.current.h !== stage.h)) {
      setView(followStage(viewRef.current, lastStage.current, stage, content, follow));
    }
    lastStage.current = stage;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage.w, stage.h, content.w, content.h]);

  const move = useCallback(
    (v: View) => {
      userMoved.current = true;
      busyUntil.current = performance.now() + 140;
      setView(clampPan(v, content, stage));
    },
    [content, stage, setView],
  );

  useEffect(() => {
    props.onViewChange?.(view, stage, content, !userMoved.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, stage, content]);

  // ---------------------------------------------------------------- drawing
  const raf = useRef(0);
  const sceneRef = useRef<Scene | null>(null);
  sceneRef.current = {
    source,
    natural,
    crop: settings.crop,
    view,
    stage,
    dpr,
    adjust: settings.adjust,
    mono: settings.mono,
    grid: settings.grid,
    background,
    compare,
    compareWith,
    wipe,
    ghosts: playing ? [] : ghosts,
    ghostOpacity: 0.45,
    hoverPixel: inspector && hover ? hover.p : null,
    measureLine,
    cropDraft,
    quality: "high",
  };
  const draw = useCallback(() => {
    raf.current = 0;
    const base = sceneRef.current;
    if (!base) return;
    const now = performance.now();
    const busy = now < busyUntil.current || (!!video && !video.paused);
    const s: Scene = { ...base, quality: busy ? "low" : "high" };
    if (busy && !(video && !video.paused)) {
      // One sharp redraw once things settle.
      window.clearTimeout(settleTimer.current);
      settleTimer.current = window.setTimeout(() => redrawRef.current(), Math.max(16, busyUntil.current - now + 10));
    }
    const W = Math.max(1, Math.round(s.stage.w * s.dpr));
    const H = Math.max(1, Math.round(s.stage.h * s.dpr));
    const layers: [HTMLCanvasElement | null, (g: CanvasRenderingContext2D, s: Scene) => void, boolean][] = [
      [canvasRef.current, drawBase, s.background !== "dark"],
      [cmpRef.current, drawCompare, true],
      [ovlRef.current, drawOverlay, true],
    ];
    for (const [c, fn, alpha] of layers) {
      if (!c) continue;
      if (c.width !== W || c.height !== H) {
        c.width = W;
        c.height = H;
      }
      const g = c.getContext("2d", { alpha });
      if (!g) continue;
      try {
        fn(g, s);
      } catch {
        /* a video with no frame yet */
      }
    }
    drawn.current++;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video]);
  const redrawRef = useRef<() => void>(() => undefined);
  const drawn = useRef(0);
  const redraw = useCallback(() => {
    if (!raf.current) raf.current = requestAnimationFrame(draw);
  }, [draw]);
  redrawRef.current = redraw;
  useEffect(
    () => () => {
      cancelAnimationFrame(raf.current);
      window.clearTimeout(settleTimer.current);
      raf.current = 0;
    },
    [],
  );
  useEffect(redraw);

  // Per video frame while playing.
  useEffect(() => {
    if (!video) return;
    let alive = true;
    type RVFC = (cb: () => void) => number;
    const rvfc = (video as unknown as { requestVideoFrameCallback?: RVFC }).requestVideoFrameCallback?.bind(video);
    const tick = () => {
      if (!alive) return;
      setTime(video.currentTime);
      redraw();
      if (rvfc) rvfc(tick);
    };
    if (rvfc) rvfc(tick);
    const sync = () => {
      setPlaying(!video.paused);
      setTime(video.currentTime);
      redraw();
    };
    const evs = ["play", "pause", "seeked", "loadeddata", "timeupdate", "ratechange"];
    evs.forEach((e) => video.addEventListener(e, sync));
    sync();
    return () => {
      alive = false;
      evs.forEach((e) => video.removeEventListener(e, sync));
    };
  }, [video, redraw]);

  // Speed and loops.
  useEffect(() => {
    if (video) video.playbackRate = settings.speed;
  }, [video, settings.speed]);
  useEffect(() => {
    if (!video) return;
    let id = 0;
    const loop = () => {
      if (!video.paused) {
        const j = loopJump(video.currentTime, video.duration || 0, settings.loopAll, settings.ab);
        if (j !== null) video.currentTime = j;
      }
      id = requestAnimationFrame(loop);
    };
    id = requestAnimationFrame(loop);
    const ended = () => {
      if (settings.loopAll || (settings.ab.a !== null && settings.ab.b !== null)) {
        video.currentTime = settings.ab.a !== null && settings.ab.b !== null ? Math.min(settings.ab.a, settings.ab.b) : 0;
        void video.play().catch(() => undefined);
      }
    };
    video.addEventListener("ended", ended);
    return () => {
      cancelAnimationFrame(id);
      video.removeEventListener("ended", ended);
    };
  }, [video, settings.loopAll, settings.ab]);

  // Onion skin: hidden copies of the video parked on the neighbouring frames.
  const ghostVids = useRef<HTMLVideoElement[]>([]);
  useEffect(() => {
    const n = video ? settings.onion : 0;
    if (!n || !video) {
      ghostVids.current.forEach((g) => {
        g.removeAttribute("src");
        g.load();
      });
      ghostVids.current = [];
      setGhosts([]);
      return;
    }
    const offsets = n === 1 ? [-1, 1] : [-2, -1, 1, 2];
    const vids = offsets.map(() => {
      const g = document.createElement("video");
      g.crossOrigin = "anonymous";
      g.muted = true;
      g.preload = "auto";
      g.src = video.currentSrc || video.src;
      return g;
    });
    ghostVids.current = vids;
    let alive = true;
    const park = () => {
      if (!video.paused) return;
      const dur = video.duration || 0;
      vids.forEach((g, i) => {
        const t = stepTime(video.currentTime, offsets[i], fps, dur);
        if (Math.abs(g.currentTime - t) > 1e-3) g.currentTime = t;
      });
    };
    const ready = () => {
      if (!alive) return;
      setGhosts(
        vids
          .map((g, i) => ({ source: g as CanvasImageSource, offset: offsets[i], ok: g.readyState >= 2 }))
          .filter((g) => g.ok)
          .map(({ source, offset }) => ({ source, offset })),
      );
    };
    vids.forEach((g) => {
      g.addEventListener("seeked", ready);
      g.addEventListener("loadeddata", () => park());
    });
    video.addEventListener("seeked", park);
    video.addEventListener("pause", park);
    park();
    return () => {
      alive = false;
      video.removeEventListener("seeked", park);
      video.removeEventListener("pause", park);
      vids.forEach((g) => {
        g.removeAttribute("src");
        g.load();
      });
    };
  }, [video, settings.onion, fps]);

  // ---------------------------------------------------------------- actions
  const fit = useCallback(() => {
    userMoved.current = false;
    setView(fitView(content, stage, { ...viewRef.current }));
  }, [content, stage, setView]);
  const zoom100 = useCallback(() => move(actualView(stage, viewRef.current, dpr)), [stage, dpr, move]);
  const fill = useCallback(() => move(fillView(content, stage, viewRef.current)), [content, stage, move]);
  const resetAll = useCallback(() => {
    remember();
    userMoved.current = false;
    setView(home(content, stage));
    applySettings({ ...settingsRef.current, adjust: NO_ADJUST, mono: false, crop: null });
    setCompare("off");
  }, [content, stage, home, applySettings, remember, setView]);
  const centre = (): Pt => ({ x: stage.w / 2, y: stage.h / 2 });
  const zoomBy = (f: number, at?: Pt) => move(zoomAt(viewRef.current, at ?? centre(), f, dpr, fitView(content, stage).scale / 4));
  /** A turn or flip: a fitted picture stays fitted. */
  const reorient = (v: View) => {
    if (!userMoved.current) setView(placeHome(content, stage, v));
    else move(v);
  };
  const turn = (deg: number) => {
    remember();
    reorient(rotateBy(viewRef.current, deg));
  };
  const mirror = () => {
    remember();
    setView(flipScreenH(viewRef.current));
  };
  const flipVert = () => {
    remember();
    setView(flipScreenV(viewRef.current));
  };
  const restore = (from: Snap[], to: Snap[]): boolean => {
    const sn = from.pop();
    if (!sn) return false;
    const v = viewRef.current;
    to.push({ s: settingsRef.current, rot: v.rot, flipH: v.flipH, flipV: v.flipV });
    applySettings(sn.s);
    reorient({ ...v, rot: sn.rot, flipH: sn.flipH, flipV: sn.flipV });
    lastRemember.current = 0;
    return true;
  };
  const undoStep = () => {
    const ok = restore(undoStack.current, redoStack.current);
    say(ok ? "Undone" : "Nothing to undo");
    return ok;
  };
  const redoStep = () => {
    const ok = restore(redoStack.current, undoStack.current);
    say(ok ? "Redone" : "Nothing to redo");
    return ok;
  };

  const frame = useCallback((): HTMLCanvasElement | null => {
    if (!source || natural.w <= 0) return null;
    try {
      return frameCanvas(source, natural, settingsRef.current.crop);
    } catch {
      return null;
    }
  }, [source, natural]);

  const copyFrame = useCallback(async () => {
    const c = frame();
    if (!c) return say("Nothing to copy yet");
    try {
      say("Copying…");
      await copyPng(await canvasPng(c));
      say(`Copied ${c.width}×${c.height} picture`);
    } catch (e) {
      say(`Could not copy: ${String(e)}`);
    }
  }, [frame, say]);

  const saveFrame = useCallback(async () => {
    const c = frame();
    if (!c) {
      say("Nothing to save yet");
      return null;
    }
    try {
      say("Saving…");
      const suffix = video ? `f${frameIndex(video.currentTime, fps)}` : "";
      const path = await savePng(await canvasPng(c), stampName(name, suffix));
      say(`Saved ${path.split(/[\\/]/).pop()}`);
      return path;
    } catch (e) {
      say(`Could not save: ${String(e)}`);
      return null;
    }
  }, [frame, say, name, video, fps]);

  useImperativeHandle(
    props.apiRef,
    () => ({
      fit,
      getView: () => viewRef.current,
      setView: (v: View) => move(v),
      frame,
      copyFrame,
      saveFrame,
      redraw,
      stage: () => stage,
      turn,
      zoomBy: (f: number) => zoomBy(f),
      zoom100,
      fill,
      mirror,
      flipV: flipVert,
      resetAll,
      undo: undoStep,
      redo: redoStep,
      fitted: () => !userMoved.current,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fit, move, frame, copyFrame, saveFrame, redraw, stage, content, dpr, zoom100, fill, resetAll],
  );

  // Video helpers
  const step = useCallback(
    (n: number) => {
      if (!video) return;
      video.pause();
      video.currentTime = stepTime(video.currentTime, n, fps, video.duration || 0);
    },
    [video, fps],
  );
  const setSpeed = (s: number) => patch({ speed: s });
  const markA = () => video && patch({ ab: { ...settingsRef.current.ab, a: video.currentTime } });
  const markB = () => video && patch({ ab: { ...settingsRef.current.ab, b: video.currentTime } });

  const takeCompareFromFrame = () => {
    const c = frame();
    if (!c) return;
    setCompareWith({ source: c, size: { w: c.width, h: c.height } });
    if (compare === "off") setCompare("wipe");
    say("Compare: this frame is now B. Move on and look.");
  };
  const loadCompareFile = (f: File | Blob) => {
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.onload = () => {
      setCompareWith({ source: img, size: { w: img.naturalWidth, h: img.naturalHeight } });
      if (compare === "off") setCompare("wipe");
    };
    img.onerror = () => say("That file is not a picture");
    img.src = url;
  };
  const fileInput = useRef<HTMLInputElement | null>(null);

  // ---------------------------------------------------------------- pointer
  const stagePt = (e: { clientX: number; clientY: number }): Pt => {
    const r = wrapRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  /** Stage point → picture px (picture = the uncropped source). */
  const picPt = (p: Pt, v: View = viewRef.current): Pt => {
    let vv = v;
    if (compare === "side" && compareWith) {
      const sv = sideViews(v, stage);
      vv = p.x < sv.half ? sv.left : sv.right;
    }
    const c = toContent(vv, content, p);
    const crop = settingsRef.current.crop;
    return crop ? { x: c.x + crop.x, y: c.y + crop.y } : c;
  };

  const updateHover = (p: Pt) => {
    if (!inspector || !source) {
      if (hover) setHover(null);
      return;
    }
    let vv = viewRef.current;
    if (compare === "side" && compareWith) {
      const sv = sideViews(vv, stage);
      vv = p.x < sv.half ? sv.left : sv.right;
    }
    const px = pixelAt(vv, content, p);
    if (!px) return setHover(null);
    const crop = settingsRef.current.crop;
    const sx = px.x + (crop?.x ?? 0);
    const sy = px.y + (crop?.y ?? 0);
    setHover({ p: px, at: p, rgba: readPixel(source, sx, sy) });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button === 1) e.preventDefault();
    const p = stagePt(e);
    const panning = e.button === 1 || (e.button === 0 && spaceRef.current);
    if (panning) spaceTap.current = false;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    if (panning) {
      dragRef.current = { kind: "pan", x0: e.clientX, y0: e.clientY, v0: viewRef.current, moved: false, tap: false };
      return;
    }
    if (e.button !== 0) return;
    if (compare === "wipe" && compareWith && Math.abs(p.x - wipe * stage.w) < 10) {
      dragRef.current = { kind: "wipe" };
      return;
    }
    if (measuring) {
      const a = picPt(p);
      dragRef.current = { kind: "measure", a };
      setMeasureLine({ a, b: a });
      return;
    }
    if (cropping) {
      const a = toContent(viewRef.current, content, p);
      dragRef.current = { kind: "crop", a };
      setCropDraft({ x: a.x, y: a.y, w: 0, h: 0 });
      return;
    }
    if (props.pointer) {
      dragRef.current = { kind: "host" };
      props.pointer.down(picPt(p), e);
      return;
    }
    dragRef.current = { kind: "pan", x0: e.clientX, y0: e.clientY, v0: viewRef.current, moved: false, tap: true };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    const p = stagePt(e);
    if (!d) return updateHover(p);
    if (d.kind === "pan") {
      const dx = e.clientX - d.x0;
      const dy = e.clientY - d.y0;
      if (!d.moved && Math.hypot(dx, dy) < 4) return;
      if (!leftDragPans && d.tap) return;
      d.moved = true;
      move({ ...d.v0, x: d.v0.x + dx, y: d.v0.y + dy });
      updateHover(p);
    } else if (d.kind === "measure") {
      let b = picPt(p);
      if (e.shiftKey) {
        // Lock to 0/45/90°.
        const ang = Math.atan2(b.y - d.a.y, b.x - d.a.x);
        const snap = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(b.x - d.a.x, b.y - d.a.y);
        b = { x: d.a.x + Math.cos(snap) * len, y: d.a.y + Math.sin(snap) * len };
      }
      setMeasureLine({ a: d.a, b });
    } else if (d.kind === "crop") {
      const b = toContent(viewRef.current, content, p);
      setCropDraft({ x: d.a.x, y: d.a.y, w: b.x - d.a.x, h: b.y - d.a.y });
    } else if (d.kind === "wipe") {
      setWipe(Math.min(1, Math.max(0, p.x / Math.max(1, stage.w))));
    } else if (d.kind === "host") {
      props.pointer?.move(picPt(p), e);
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    const p = stagePt(e);
    if (d.kind === "pan" && !d.moved && d.tap) {
      if (inspector && hover?.rgba) {
        const h = hex(hover.rgba[0], hover.rgba[1], hover.rgba[2]);
        void copyText(h);
        setPicked((l) => [h, ...l.filter((x) => x !== h)].slice(0, 10));
        say(`Copied ${h}`);
      } else props.onTap?.();
    } else if (d.kind === "crop" && cropDraft) {
      const r = cropDraft;
      if (Math.abs(r.w) >= 4 && Math.abs(r.h) >= 4) {
        const base = settingsRef.current.crop;
        const abs = { x: r.x + (base?.x ?? 0), y: r.y + (base?.y ?? 0), w: r.w, h: r.h };
        patch({ crop: clampCrop(abs, natural) });
        userMoved.current = false;
        placed.current = true;
      }
      setCropDraft(null);
      setCropping(false);
    } else if (d.kind === "host") {
      props.pointer?.up(picPt(p), e);
    }
  };

  // After a crop, fit the new content.
  useEffect(() => {
    if (!userMoved.current && stage.w > 0 && content.w > 0) setView(home(content, stage));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.crop]);

  // Wheel: zoom at the cursor; Ctrl = frame scrub; Alt = turn. Non-passive.
  const wheelRef = useRef<(e: WheelEvent) => void>(() => undefined);
  wheelRef.current = (e: WheelEvent) => {
    if ((e.target as HTMLElement | null)?.closest?.("[data-viewer-ui]")) return;
    e.preventDefault();
    const p = stagePt(e);
    if (e.ctrlKey && video) {
      step(e.deltaY > 0 ? (e.shiftKey ? 10 : 1) : e.shiftKey ? -10 : -1);
      return;
    }
    if (e.altKey) {
      const v = rotateBy(viewRef.current, (e.deltaY > 0 ? 1 : -1) * (e.shiftKey ? 1 : 5), p);
      move({ ...v, rot: snapAngle(v.rot, 0.5) });
      return;
    }
    move(zoomAt(viewRef.current, p, wheelFactor(e.deltaY, e.deltaMode), dpr, fitView(content, stage).scale / 4));
    updateHover(p);
  };
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const h = (e: WheelEvent) => wheelRef.current(e);
    el.addEventListener("wheel", h, { passive: false });
    return () => el.removeEventListener("wheel", h);
  }, []);

  // ---------------------------------------------------------------- keys
  // On the app's shortcut registry (scope "viewer"): rebindable in
  // Settings, listed in the cheat sheet, never while typing.
  const toggleVideo = () => {
    if (!video) return;
    if (video.paused) void video.play().catch(() => undefined);
    else video.pause();
  };
  const cycleGrid = () => {
    const order: GridSpec["kind"][] = ["off", "thirds", "custom"];
    const cur = settingsRef.current.grid;
    patch({ grid: { ...cur, kind: order[(order.indexOf(cur.kind) + 1) % 3] } });
  };
  const cycleCompare = () => {
    if (!compareWith) return takeCompareFromFrame();
    const order: CompareMode[] = ["off", "wipe", "diff", "side"];
    setCompare(order[(order.indexOf(compare) + 1) % order.length]);
  };
  const hasVideo = () => !!video;
  const shortcuts: Shortcut[] = [
    { id: "fit", keys: "0", label: "Fit the whole picture", group: "Zoom", run: fit },
    { id: "actual", keys: "1", label: "100 % (one picture pixel per screen pixel)", group: "Zoom", run: zoom100 },
    { id: "fill", keys: "2", label: "Fill the view", group: "Zoom", run: fill },
    { id: "zoom-in", keys: "+ | =", label: "Zoom in", group: "Zoom", run: () => zoomBy(1.5) },
    { id: "zoom-out", keys: "- | _", label: "Zoom out", group: "Zoom", run: () => zoomBy(1 / 1.5) },
    { id: "turn-right", keys: "R | ]", label: "Turn right 90°", group: "Turn and mirror", run: () => turn(90) },
    { id: "turn-left", keys: "Shift+R | [", label: "Turn left 90°", group: "Turn and mirror", run: () => turn(-90) },
    { id: "turn-right-15", keys: "}", label: "Turn right 15°", group: "Turn and mirror", run: () => turn(15) },
    { id: "turn-left-15", keys: "{", label: "Turn left 15°", group: "Turn and mirror", run: () => turn(-15) },
    { id: "mirror", keys: "H", label: "Mirror left↔right", group: "Turn and mirror", run: mirror },
    { id: "flip", keys: "Shift+H", label: "Flip upside down", group: "Turn and mirror", run: flipVert },
    { id: "value", keys: "M", label: "Value check (grey)", group: "Inspect", run: () => patch({ mono: !settingsRef.current.mono }) },
    { id: "grid", keys: "G", label: "Grid: thirds · custom · off", group: "Inspect", run: cycleGrid },
    {
      id: "picker",
      keys: "C",
      label: "Colour picker",
      group: "Inspect",
      run: () => {
        setInspector((v) => !v);
        setMeasuring(false);
      },
    },
    { id: "crop", keys: "Shift+C", label: "Crop", group: "Inspect", run: () => setCropping((c) => !c) },
    {
      id: "measure",
      keys: "D",
      label: "Measure",
      group: "Inspect",
      run: () => {
        setMeasuring((v) => !v);
        setMeasureLine(null);
        setInspector(false);
      },
    },
    { id: "compare", keys: "W", label: "Compare: set B, then cycle wipe · difference · side by side", group: "Inspect", run: cycleCompare },
    { id: "colour", keys: "E", label: "Colour adjustments", group: "Inspect", run: () => setPop((p) => (p === "colour" ? null : "colour")) },
    { id: "copy", keys: "Ctrl+C", label: "Copy this frame as a picture", group: "Picture", run: () => void copyFrame(), when: () => exportKeys && !window.getSelection()?.toString() },
    { id: "save", keys: "Ctrl+S", label: "Save this frame as PNG", group: "Picture", run: () => void saveFrame(), when: () => exportKeys },
    { id: "reset", keys: "Ctrl+0", label: "Reset zoom, turn, flip, colour and crop", group: "Picture", run: resetAll },
    { id: "undo", keys: "Ctrl+Z", label: "Undo (turn, flip, crop, colour, grid)", group: "Picture", run: () => void undoStep(), when: () => undoOn && undoStack.current.length > 0 },
    { id: "redo", keys: "Ctrl+Y | Ctrl+Shift+Z", label: "Redo", group: "Picture", run: () => void redoStep(), when: () => undoOn && redoStack.current.length > 0 },
    { id: "play", keys: "K", label: "Play / pause at normal speed", group: "Video", when: hasVideo, run: () => (setSpeed(1), toggleVideo()) },
    { id: "slower", keys: "J", label: "Slower", group: "Video", when: hasVideo, run: () => setSpeed(nextSpeed(settingsRef.current.speed, -1)) },
    { id: "faster", keys: "L", label: "Faster", group: "Video", when: hasVideo, run: () => setSpeed(nextSpeed(settingsRef.current.speed, 1)) },
    { id: "frame-back", keys: ",", label: "One frame back", group: "Video", when: hasVideo, run: () => step(-1) },
    { id: "frame-on", keys: ".", label: "One frame on", group: "Video", when: hasVideo, run: () => step(1) },
    { id: "frame-back-10", keys: "<", label: "10 frames back", group: "Video", when: hasVideo, run: () => step(-10) },
    { id: "frame-on-10", keys: ">", label: "10 frames on", group: "Video", when: hasVideo, run: () => step(10) },
    { id: "loop", keys: "Shift+L", label: "Loop the whole clip", group: "Video", when: hasVideo, run: () => patch({ loopAll: !settingsRef.current.loopAll }) },
    { id: "loop-a", keys: "A", label: "Loop from here (A)", group: "Video", when: hasVideo, run: () => void markA() },
    { id: "loop-b", keys: "B", label: "Loop to here (B)", group: "Video", when: hasVideo, run: () => void markB() },
    { id: "loop-clear", keys: "Shift+A", label: "Clear the A–B loop", group: "Video", when: hasVideo, run: () => patch({ ab: { a: null, b: null } }) },
    { id: "onion", keys: "N", label: "Onion skin: off · 1 · 2 frames", group: "Video", when: hasVideo, run: () => patch({ onion: ((settingsRef.current.onion + 1) % 3) as 0 | 1 | 2 }) },
  ];
  useShortcuts("viewer", shortcuts, keys);
  // Tooltips follow rebinding.
  const [, setKeysVersion] = useState(0);
  useEffect(() => onShortcutsChange(() => setKeysVersion((n) => n + 1)), []);
  const tip = (id: string, label: string) => {
    const sc = shortcuts.find((x) => x.id === id);
    const first = sc && keys ? splitKeys(effectiveKeys("viewer", sc))[0] : undefined;
    return first ? `${label} (${first})` : label;
  };

  // Space: held, it pans with the left button; tapped, it plays / pauses
  // (with `spacePlays`). Ctrl+V while comparing loads picture B.
  const spaceTap = useRef(false);
  useEffect(() => {
    if (!keys) return;
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || isTyping(e.target)) return;
      spaceRef.current = true;
      if (!e.repeat) spaceTap.current = true;
      if (spacePlays && video) e.preventDefault();
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      spaceRef.current = false;
      const tap = spaceTap.current;
      spaceTap.current = false;
      if (tap && spacePlays && video && !isTyping(e.target)) {
        e.preventDefault();
        if (video.paused) void video.play().catch(() => undefined);
        else video.pause();
      }
    };
    const blur = () => {
      spaceRef.current = false;
      spaceTap.current = false;
    };
    const paste = (e: ClipboardEvent) => {
      if (compare === "off") return;
      const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith("image/"));
      const f = item?.getAsFile();
      if (f) {
        e.preventDefault();
        loadCompareFile(f);
      }
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    window.addEventListener("paste", paste);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
      window.removeEventListener("paste", paste);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys, compare, spacePlays, video]);

  // ---------------------------------------------------------------- render
  const pct = Math.round(zoomPercent(view, dpr));
  const pictureFilter = cssFilter(settings);
  const atHome = stage.w > 0 && content.w > 0 && sameView(view, home(content, stage));
  // Outside the picture the bar keeps its row (the picture never jumps).
  const showBar = bar === "show" || (bar === "auto" && (barLayout === "outside" || inside || overBar || pop !== null));
  const s = settings;
  const fmtPct = (v: number) => `${Math.round(v * 100)}%`;
  const total = video && video.duration ? Math.max(1, Math.round(video.duration * fps)) : 0;
  const outside = barLayout === "outside" && bar !== "none";
  const swatches =
    picked.length > 0 && inspector ? (
      <div data-viewer-ui className={cn("z-20 flex gap-1 rounded-lg border border-white/10 bg-[#14161c]/85 p-1", outside ? "w-fit" : "absolute bottom-2 left-2")} onPointerDown={(e) => e.stopPropagation()}>
        {picked.map((h) => (
          <button
            key={h}
            type="button"
            title={`${h}: click to copy again`}
            onClick={() => {
              void copyText(h);
              say(`Copied ${h}`);
            }}
            className="h-5 w-5 rounded border border-white/30"
            style={{ background: h }}
          />
        ))}
      </div>
    ) : null;
  const hint =
    cropping && !cropDraft ? (
      <div className={cn("pointer-events-none z-20 rounded-md bg-black/75 px-2 py-1 text-[11px] text-white", outside ? "w-fit" : "absolute bottom-2 right-2")}>Drag a box over the part to keep · Esc cancels</div>
    ) : null;
  const barEl =
    bar !== "none" ? (
        <div
          data-viewer-ui
          onPointerEnter={() => setOverBar(true)}
          onPointerLeave={() => setOverBar(false)}
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          className={cn(
            outside
              ? cn("relative z-20 flex shrink-0 flex-col gap-1 bg-[#101217] px-1.5 py-1", barPlace === "top" ? "border-b border-white/10" : "border-t border-white/10")
              : cn("absolute left-2 right-2 z-20 flex flex-col gap-1 transition-opacity duration-150", barPlace === "top" ? "top-2" : "bottom-2"),
            // Menus open upwards from a bar at the bottom.
            barPlace === "bottom" && "[&_.viewer-pop]:bottom-full [&_.viewer-pop]:mb-1 [&_.viewer-pop]:mt-0",
            showBar ? "opacity-100" : "pointer-events-none opacity-0",
          )}
        >
          <div className="relative flex w-fit max-w-full flex-wrap items-center gap-0.5 rounded-lg border border-white/10 bg-[#14161c]/85 p-0.5 text-white shadow-lg backdrop-blur">
            <div className="relative">
              <Btn wide title="Zoom (wheel at the cursor). Click for presets" onClick={() => setPop(pop === "zoom" ? null : "zoom")}>
                <span className="w-11 font-mono">{pct}%</span>
              </Btn>
              <Pop open={pop === "zoom"} onClose={() => setPop(null)} className="min-w-[160px]">
                <div className="flex flex-wrap gap-1">
                  {[25, 50, 100, 200, 400, 800, 1600, 3200, 6400].map((z) => (
                    <Chip key={z} on={pct === z} onClick={() => move(zoomAt(viewRef.current, centre(), z / 100 / dpr / viewRef.current.scale, dpr))}>
                      {z}%
                    </Chip>
                  ))}
                </div>
              </Pop>
            </div>
            <Btn title={tip("fit", "Fit the whole picture")} on={atHome} onClick={fit}>
              <Icon d={I.fit} />
            </Btn>
            <Btn wide title={tip("actual", "100 %: one picture pixel per screen pixel")} on={pct === 100} onClick={zoom100}>
              1:1
            </Btn>
            <Btn title={tip("fill", "Fill the view")} onClick={fill}>
              <Icon d={I.fill} />
            </Btn>
            <Sep />
            <Btn title={tip("turn-left", "Turn left 90°")} onClick={() => turn(-90)}>
              <Icon d={I.rotL} />
            </Btn>
            <Btn title={tip("turn-right", "Turn right 90°")} onClick={() => turn(90)}>
              <Icon d={I.rotR} />
            </Btn>
            <div className="relative">
              <Btn title="Turn freely (Alt+wheel; Shift+Alt+wheel for 1°)" on={view.rot % 90 !== 0} onClick={() => setPop(pop === "rotate" ? null : "rotate")}>
                <Icon d={I.free} />
              </Btn>
              <Pop open={pop === "rotate"} onClose={() => setPop(null)}>
                <Slider label="Angle" value={view.rot} min={-180} max={180} step={0.5} fmt={(v) => `${v}°`} onChange={(v) => move({ ...viewRef.current, rot: v })} />
                <div className="mt-1 flex gap-1">
                  {[-90, -45, -15, 0, 15, 45, 90].map((a) => (
                    <Chip key={a} on={view.rot === a} onClick={() => move({ ...viewRef.current, rot: a })}>
                      {a}°
                    </Chip>
                  ))}
                </div>
              </Pop>
            </div>
            <Btn title={tip("mirror", "Mirror left↔right: an artist's mirror check")} on={view.flipH} onClick={mirror}>
              <Icon d={I.mirror} />
            </Btn>
            <Btn title={tip("flip", "Flip upside down")} on={view.flipV} onClick={flipVert}>
              <Icon d={I.flipV} />
            </Btn>
            <Sep />
            <Btn title={tip("value", "Value check: show only light and dark")} on={s.mono} onClick={() => patch({ mono: !s.mono })}>
              <Icon d={I.value} />
            </Btn>
            <div className="relative">
              <Btn title={tip("grid", "Grid: thirds or your own")} on={s.grid.kind !== "off"} onClick={() => setPop(pop === "grid" ? null : "grid")}>
                <Icon d={I.grid} />
              </Btn>
              <Pop open={pop === "grid"} onClose={() => setPop(null)} className="min-w-[250px]">
                <div className="mb-1.5 flex gap-1">
                  {(["off", "thirds", "custom"] as const).map((k) => (
                    <Chip key={k} on={s.grid.kind === k} onClick={() => patch({ grid: { ...s.grid, kind: k } })}>
                      {k === "off" ? "Off" : k === "thirds" ? "Thirds" : "Custom"}
                    </Chip>
                  ))}
                </div>
                {s.grid.kind === "custom" && (
                  <>
                    <Slider label="Columns" value={s.grid.cols} min={1} max={32} step={1} onChange={(v) => patch({ grid: { ...s.grid, cols: v } })} />
                    <Slider label="Rows" value={s.grid.rows} min={1} max={32} step={1} onChange={(v) => patch({ grid: { ...s.grid, rows: v } })} />
                  </>
                )}
                <Slider label="Opacity" value={s.grid.opacity} min={0.1} max={1} step={0.05} fmt={fmtPct} onChange={(v) => patch({ grid: { ...s.grid, opacity: v } })} />
                <div className="mt-1 flex items-center gap-2">
                  <span className="w-[74px] text-white/65">Colour</span>
                  {["#00e5ff", "#ff3b6b", "#ffd60a", "#7cff6b", "#ffffff", "#000000"].map((c) => (
                    <button
                      key={c}
                      type="button"
                      title={c}
                      onClick={() => patch({ grid: { ...s.grid, color: c } })}
                      className={cn("h-4 w-4 rounded-full border", s.grid.color === c ? "border-white" : "border-white/25")}
                      style={{ background: c }}
                    />
                  ))}
                  <input type="color" value={s.grid.color} onChange={(e) => patch({ grid: { ...s.grid, color: e.target.value } })} className="h-4 w-5 cursor-pointer bg-transparent" title="Any colour" />
                </div>
                <label className="mt-1.5 flex items-center gap-2 text-white/75">
                  <input type="checkbox" checked={s.grid.diagonals} onChange={(e) => patch({ grid: { ...s.grid, diagonals: e.target.checked } })} />
                  Diagonals
                </label>
              </Pop>
            </div>
            <Btn
              title={tip("picker", "Colour picker: hover for x, y and colour; click copies the hex")}
              on={inspector}
              onClick={() => {
                setInspector(!inspector);
                setMeasuring(false);
              }}
            >
              <Icon d={I.picker} />
            </Btn>
            <Btn
              title={tip("measure", "Measure: drag a line for its length and angle in pixels; Shift locks to 45°")}
              on={measuring}
              onClick={() => {
                setMeasuring(!measuring);
                setMeasureLine(null);
                setInspector(false);
              }}
            >
              <Icon d={I.measure} />
            </Btn>
            <Btn title={s.crop ? "Crop: drag a new box, or right-click to remove the crop (Shift+C)" : "Crop: drag a box over the part to keep (Shift+C)"} on={cropping || !!s.crop} onClick={() => setCropping(!cropping)}>
              <span onContextMenu={(e) => (e.preventDefault(), patch({ crop: null }))}>
                <Icon d={I.crop} />
              </span>
            </Btn>
            <div className="relative">
              <Btn title={tip("compare", "Compare two pictures: wipe, difference or side by side")} on={compare !== "off"} onClick={() => setPop(pop === "compare" ? null : "compare")}>
                <Icon d={I.compare} />
              </Btn>
              <Pop open={pop === "compare"} onClose={() => setPop(null)} className="min-w-[260px]">
                <div className="mb-1 text-white/60">Picture B</div>
                <div className="flex flex-wrap gap-1">
                  <Chip onClick={takeCompareFromFrame} title="Use what is shown now as B (W)">
                    This frame
                  </Chip>
                  <Chip onClick={() => fileInput.current?.click()} title="Pick a picture file as B">
                    A file…
                  </Chip>
                  <Chip
                    title="Paste a picture as B (or press Ctrl+V while comparing)"
                    onClick={() =>
                      void navigator.clipboard
                        ?.read?.()
                        .then(async (items) => {
                          for (const it of items) {
                            const t = it.types.find((x) => x.startsWith("image/"));
                            if (t) return loadCompareFile(await it.getType(t));
                          }
                          say("No picture on the clipboard");
                        })
                        .catch(() => say("Press Ctrl+V to paste a picture"))
                    }
                  >
                    Clipboard
                  </Chip>
                </div>
                <div className="mb-1 mt-2 text-white/60">Show</div>
                <div className="flex flex-wrap gap-1">
                  {(["off", "wipe", "diff", "side"] as const).map((m) => (
                    <Chip key={m} on={compare === m} onClick={() => setCompare(m)}>
                      {m === "off" ? "Off" : m === "wipe" ? "Wipe" : m === "diff" ? "Difference" : "Side by side"}
                    </Chip>
                  ))}
                </div>
                {compare === "wipe" && <Slider label="Wipe" value={wipe} min={0} max={1} step={0.01} fmt={fmtPct} onChange={setWipe} title="Or drag the line on the picture" />}
                {!compareWith && compare !== "off" && <div className="mt-1.5 text-amber-300/90">Pick a picture B first.</div>}
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) loadCompareFile(f);
                    e.target.value = "";
                  }}
                />
              </Pop>
            </div>
            <div className="relative">
              <Btn title={tip("colour", "Colour: brightness, contrast, saturation, hue, invert, tint")} on={!isNeutral(s.adjust)} onClick={() => setPop(pop === "colour" ? null : "colour")}>
                <Icon d={I.colour} />
              </Btn>
              <Pop open={pop === "colour"} onClose={() => setPop(null)} className="min-w-[270px]">
                <AdjustPanel value={s.adjust} onChange={(adjust) => patch({ adjust })} />
              </Pop>
            </div>
            <Sep />
            <Btn title={exportKeys ? tip("copy", "Copy this frame as a picture") : "Copy this frame as a picture"} onClick={() => void copyFrame()}>
              <Icon d={I.copy} />
            </Btn>
            <Btn title={exportKeys ? tip("save", "Save this frame as a lossless PNG in the Screenshots folder") : "Save this frame as a lossless PNG"} onClick={() => void saveFrame()}>
              <Icon d={I.save} />
            </Btn>
            <Btn title={tip("undo", "Undo")} disabled={!undoStack.current.length} onClick={() => void undoStep()}>
              <Icon d={I.undo} />
            </Btn>
            <Btn title={tip("redo", "Redo")} disabled={!redoStack.current.length} onClick={() => void redoStep()}>
              <Icon d={I.redo} />
            </Btn>
            <Btn title={tip("reset", "Reset zoom, turn, flip, colour and crop")} onClick={resetAll}>
              <Icon d={I.reset} />
            </Btn>
            {props.extra}
            <div className="relative">
              <Btn title="All shortcuts" on={pop === "help"} onClick={() => setPop(pop === "help" ? null : "help")}>
                <Icon d={I.help} />
              </Btn>
              <Pop open={pop === "help"} onClose={() => setPop(null)} className="right-0 min-w-[300px]">
                <Help video={!!video} list={keys ? shortcuts : []} />
              </Pop>
            </div>
          </div>

          {video && videoBar && (
            <div className="flex w-fit max-w-full flex-wrap items-center gap-0.5 rounded-lg border border-white/10 bg-[#14161c]/85 p-0.5 text-white shadow-lg backdrop-blur">
              <Btn title={tip("frame-back-10", "Back 10 frames")} onClick={() => step(-10)}>
                <Icon d={I.prev10} />
              </Btn>
              <Btn title={tip("frame-back", "Back one frame") + " · Ctrl+wheel scrubs"} onClick={() => step(-1)}>
                <Icon d={I.prev} />
              </Btn>
              <span className="px-1 font-mono text-[10px] text-white/75" title="Frame number">
                {frameIndex(time, fps)}
                {total ? ` / ${total}` : ""}
              </span>
              <Btn title={tip("frame-on", "Forward one frame")} onClick={() => step(1)}>
                <Icon d={I.next} />
              </Btn>
              <Btn title={tip("frame-on-10", "Forward 10 frames")} onClick={() => step(10)}>
                <Icon d={I.next10} />
              </Btn>
              <Sep />
              <Btn title={tip("slower", "Slower")} onClick={() => setSpeed(nextSpeed(s.speed, -1))}>
                −
              </Btn>
              <Btn wide title="Speed; click for normal" on={s.speed !== 1} onClick={() => setSpeed(1)}>
                <span className="font-mono">{s.speed}×</span>
              </Btn>
              <Btn title={tip("faster", "Faster")} onClick={() => setSpeed(nextSpeed(s.speed, 1))}>
                +
              </Btn>
              <Sep />
              <Btn title={tip("loop", "Loop the whole clip")} on={s.loopAll} onClick={() => patch({ loopAll: !s.loopAll })}>
                <Icon d={I.loop} />
              </Btn>
              <Btn wide title={tip("loop-a", "Loop from here: set A")} on={s.ab.a !== null} onClick={markA}>
                A{s.ab.a !== null ? ` ${s.ab.a.toFixed(2)}` : ""}
              </Btn>
              <Btn wide title={tip("loop-b", "Loop to here: set B")} on={s.ab.b !== null} onClick={markB}>
                B{s.ab.b !== null ? ` ${s.ab.b.toFixed(2)}` : ""}
              </Btn>
              {(s.ab.a !== null || s.ab.b !== null) && (
                <Btn title={tip("loop-clear", "Clear the A–B loop")} onClick={() => patch({ ab: { a: null, b: null } })}>
                  ✕
                </Btn>
              )}
              <Sep />
              <Btn wide title={tip("onion", "Onion skin: ghost the frames before (red) and after (green) while paused")} on={s.onion > 0} onClick={() => patch({ onion: ((s.onion + 1) % 3) as 0 | 1 | 2 })}>
                <Icon d={I.onion} />
                {s.onion > 0 && <span className="ml-0.5 font-mono">{s.onion}</span>}
              </Btn>
            </div>
          )}
          {outside && swatches}
          {outside && hint}
        </div>
    ) : null;
  const cursor = dragRef.current?.kind === "pan" && dragRef.current.moved ? "grabbing" : measuring || cropping || inspector || props.pointer ? "crosshair" : leftDragPans ? "grab" : "default";

  const stageEl = (
    <div
      ref={wrapRef}
      className={cn("relative touch-none select-none overflow-hidden", outside ? "min-h-0 w-full flex-1" : "h-full w-full", !outside && props.className)}
      style={{ cursor }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => (dragRef.current = null)}
      onPointerEnter={() => setInside(true)}
      onPointerLeave={() => {
        setInside(false);
        setHover(null);
      }}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest("[data-viewer-ui]")) return;
        if (props.onDoubleClick) return props.onDoubleClick();
        if (props.pointer || measuring || cropping) return;
        const p = stagePt(e);
        if (pct < 99) move(zoomAt(viewRef.current, p, 1 / dpr / viewRef.current.scale, dpr));
        else fit();
      }}
      onContextMenu={(e) => e.preventDefault()}
      data-viewer
    >
      <div className="absolute inset-0" style={{ isolation: "isolate" }}>
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" style={{ filter: pictureFilter === "none" ? undefined : pictureFilter }} />
        <canvas
          ref={cmpRef}
          className="absolute inset-0 h-full w-full"
          style={{
            display: compareWith && (compare === "wipe" || compare === "diff") ? undefined : "none",
            filter: pictureFilter === "none" ? undefined : pictureFilter,
            mixBlendMode: compare === "diff" ? "difference" : undefined,
            clipPath: compare === "wipe" ? `inset(0 0 0 ${(wipe * 100).toFixed(2)}%)` : undefined,
          }}
        />
        <canvas ref={ovlRef} className="absolute inset-0 h-full w-full" />
      </div>
      {!outside && barEl}

      {inspector && hover && hover.rgba && (
        <PixelLabel x={hover.p.x + (s.crop?.x ?? 0)} y={hover.p.y + (s.crop?.y ?? 0)} rgba={hover.rgba} at={hover.at} stage={stage} />
      )}

      {!outside && swatches}

      {status && (
        <div className="pointer-events-none absolute bottom-2 left-1/2 z-30 -translate-x-1/2 rounded-md bg-black/80 px-2.5 py-1 text-[11px] text-white">{status}</div>
      )}
      {!outside && hint}
      <EscCancel active={cropping || measuring} onCancel={() => (setCropping(false), setMeasuring(false), setMeasureLine(null), setCropDraft(null))} />
    </div>
  );
  if (!outside)
    return stageEl;
  return (
    <div className={cn("relative flex h-full w-full flex-col overflow-hidden", props.className)} data-viewer-root>
      {barPlace === "top" && barEl}
      {stageEl}
      {barPlace === "bottom" && barEl}
    </div>
  );
}

function EscCancel({ active, onCancel }: { active: boolean; onCancel: () => void }) {
  useEffect(() => {
    if (!active) return;
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [active, onCancel]);
  return null;
}

function PixelLabel({ x, y, rgba, at, stage }: { x: number; y: number; rgba: [number, number, number, number]; at: Pt; stage: Size }) {
  const [r, g, b, a] = rgba;
  const h = hex(r, g, b);
  const [hh, ss, ll] = hsl(r, g, b);
  const left = at.x + 180 > stage.w ? at.x - 176 : at.x + 18;
  const top = at.y + 96 > stage.h ? at.y - 92 : at.y + 18;
  return (
    <div className="pointer-events-none absolute z-20 w-[160px] rounded-md border border-white/15 bg-black/85 p-1.5 font-mono text-[10px] leading-4 text-white shadow-xl" style={{ left, top }}>
      <div className="flex items-center gap-1.5">
        <span className="h-6 w-6 shrink-0 rounded border border-white/40" style={{ background: h }} />
        <div>
          <div className="text-[11px] font-semibold">{h}</div>
          <div className="text-white/70">
            x {x} · y {y}
          </div>
        </div>
      </div>
      <div className="mt-0.5 text-white/80">
        rgb({r}, {g}, {b}){a < 255 ? ` · a ${a}` : ""}
      </div>
      <div className="text-white/60">
        hsl({hh}, {ss}%, {ll}%) · value {Math.round((luma(r, g, b) / 255) * 100)}%
      </div>
      <div className="text-white/45">click copies the hex</div>
    </div>
  );
}

function AdjustPanel({ value, onChange }: { value: Adjust; onChange: (a: Adjust) => void }) {
  const set = (p: Partial<Adjust>) => onChange({ ...value, ...p });
  const pc = (v: number) => `${Math.round(v * 100)}%`;
  return (
    <div>
      <Slider label="Brightness" value={value.brightness} min={0} max={3} step={0.01} fmt={pc} onChange={(v) => set({ brightness: v })} />
      <Slider label="Contrast" value={value.contrast} min={0} max={3} step={0.01} fmt={pc} onChange={(v) => set({ contrast: v })} />
      <Slider label="Saturation" value={value.saturation} min={0} max={3} step={0.01} fmt={pc} onChange={(v) => set({ saturation: v })} />
      <Slider label="Hue" value={value.hue} min={-180} max={180} step={1} fmt={(v) => `${v}°`} onChange={(v) => set({ hue: v })} />
      <Slider label="Grayscale" value={value.grayscale} min={0} max={1} step={0.01} fmt={pc} onChange={(v) => set({ grayscale: v })} />
      <Slider label="Tint" value={value.tintAmount} min={0} max={1} step={0.01} fmt={pc} onChange={(v) => set({ tintAmount: v })} />
      <div className="mt-1 flex items-center gap-2">
        <label className="flex items-center gap-1.5 text-white/75">
          <input type="checkbox" checked={value.invert} onChange={(e) => set({ invert: e.target.checked })} />
          Invert
        </label>
        <label className="flex items-center gap-1.5 text-white/75" title="Tint colour">
          Tint
          <input type="color" value={value.tint} onChange={(e) => set({ tint: e.target.value, tintAmount: value.tintAmount || 0.4 })} className="h-4 w-6 cursor-pointer bg-transparent" />
        </label>
        <button type="button" onClick={() => onChange(NO_ADJUST)} className="ml-auto rounded bg-white/10 px-2 py-0.5 hover:bg-white/20">
          Reset
        </button>
      </div>
      <div className="mt-1 text-[10px] text-white/45">Double-click a slider to centre it.</div>
    </div>
  );
}

function Help({ video, list }: { video: boolean; list: Shortcut[] }) {
  const mouse: [string, string][] = [
    ["Wheel", "zoom at the cursor"],
    ["Drag · Space+drag · middle", "pan"],
    ["Alt+wheel", "turn freely (Shift: 1°)"],
    ["Double-click", "fit ↔ 100 %"],
  ];
  if (video) mouse.push(["Ctrl+wheel", "scrub frames"]);
  const rows = list.filter((x) => video || x.group !== "Video").map((x) => [splitKeys(effectiveKeys("viewer", x)).join(" · "), x.label] as [string, string]);
  return (
    <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
      {[...mouse, ...rows.filter(([k]) => k)].map(([k, v]) => (
        <div key={k + v} className="contents">
          <span className="whitespace-nowrap font-mono text-[10px] text-white">{k}</span>
          <span className="text-white/65">{v}</span>
        </div>
      ))}
    </div>
  );
}
