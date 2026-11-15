import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { assetUrl, clipflow } from "../lib/bridge";
import type { ClipMetadata, CropRect, ExportSegment } from "../lib/types";
import {
  addCut,
  CROP_ASPECTS,
  cropRect,
  isFullFrame,
  keptRanges,
  skipCuts,
  totalLength,
  type CropAspect,
  type CropState,
  type Range,
} from "../lib/edit";
import { clamp, formatBytes, formatTimecode } from "../lib/format";
import { cn } from "../utils/cn";

type Thumb = "start" | "end" | "playhead" | null;

export interface TrimmerAction {
  type: "copy" | "save" | "discard" | "reveal";
}

interface Props {
  clip: ClipMetadata;
  flushMs?: number;
  busy?: boolean;
  /** Trim + save. Resolves once the backend stream-copy finishes. */
  onSaveTrimmed: (start: number, end: number) => Promise<void> | void;
  onCopy: () => Promise<void> | void;
  onReveal: () => Promise<void> | void;
  onOpenExternal: () => Promise<void> | void;
  onRename: (newName: string) => Promise<void> | void;
  /** Current frame → PNG data URL (hardware decode on native). */
  onSnapshot: (pngBase64: string) => Promise<void> | void;
  /** Cuts the clip in two at the playhead (two stream-copy trims). */
  onSplit: (splitSeconds: number) => Promise<void> | void;
  onDiscard: () => Promise<void> | void;
  onClose: () => void;
  /** Stars / unstars this clip (persisted in the local sidecar store). */
  onToggleFavorite: () => Promise<void> | void;
  /** Replaces this clip's custom tags. */
  onUpdateTags: (tags: string[]) => Promise<void> | void;
  /** Shrinks the selected part under the share limit and copies it. */
  onShare: (start: number, end: number) => Promise<void> | void;
  shareLimitMb: number;
  /** 0-1 while this clip is being shrunk or exported. */
  shareProgress?: number;
  /**
   * Re-encodes the kept parts (after cuts) with an optional crop: `save` as
   * a new full-quality clip, `share` under the size limit onto the clipboard.
   */
  onExport: (
    segments: ExportSegment[],
    crop: CropRect | null,
    mode: "save" | "share",
  ) => Promise<void> | void;
}

const HANDLE_W = 14;

export default function ClipTrimmerModal({
  clip,
  flushMs,
  busy,
  onSaveTrimmed,
  onShare,
  shareLimitMb,
  shareProgress,
  onExport,
  onCopy,
  onReveal,
  onOpenExternal,
  onRename,
  onSnapshot,
  onSplit,
  onDiscard,
  onClose,
  onToggleFavorite,
  onUpdateTags,
}: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);

  const [duration, setDuration] = useState(Math.max(clip.duration_seconds, 0.1));
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(Math.max(clip.duration_seconds, 0.1));
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [dragging, setDragging] = useState<Thumb>(null);
  const [muted, setMuted] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(clip.file_name);
  const [tagDraft, setTagDraft] = useState("");
  const [cuts, setCuts] = useState<Range[]>([]);
  const [crop, setCrop] = useState<CropState | null>(null);
  const [exportKind, setExportKind] = useState<"save" | "share">("share");
  const viewRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState({ w: 0, h: 0 });

  const src = clip.preview_url ?? assetUrl(clip.path);
  const hasVideo = src.length > 0;

  useEffect(() => {
    setStart(0);
    setEnd(Math.max(clip.duration_seconds, 0.1));
    setPlayhead(0);
    setDuration(Math.max(clip.duration_seconds, 0.1));
    setNameDraft(clip.file_name);
    setRenaming(false);
    setCuts([]);
    setCrop(null);
  }, [clip.id, clip.duration_seconds, clip.file_name]);

  // Size of the player area, to place the crop box over the picture.
  useEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setView({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    return () => {
      const v = videoRef.current;
      if (v) {
        v.pause();
        v.removeAttribute("src");
        v.load();
      }
    };
  }, []);

  const commitRename = useCallback(() => {
    const next = nameDraft.trim();
    if (!next || next === clip.file_name) {
      setNameDraft(clip.file_name);
      setRenaming(false);
      return;
    }
    void run("Renaming…", async () => {
      try {
        await onRename(next);
      } finally {
        setRenaming(false);
      }
    });
  }, [clip.file_name, nameDraft, onRename]);

  const handleLoadedMetadata = () => {
    const v = videoRef.current;
    if (!v) return;
    const reported = v.duration;
    if (Number.isFinite(reported) && reported > 0) {
      setDuration(reported);
      setEnd((cur) => (cur > reported ? reported : cur));
    } else if (clip.duration_seconds > 0) {
      // Some sources (streams, partially-indexed MP4s, the browser sim) report
      // Infinity until fully parsed. Fall back to the duration the recorder
      // wrote into the clip metadata so the ruler/timecodes stay finite.
      const fallback = clip.duration_seconds;
      setDuration(fallback);
      setEnd((cur) => (cur > fallback ? fallback : cur));
    }
  };

  const seek = useCallback(
    (time: number) => {
      const clamped = clamp(time, 0, duration);
      setPlayhead(clamped);
      const v = videoRef.current;
      if (v) v.currentTime = clamped;
    },
    [duration],
  );

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      if (v.currentTime >= end - 0.05 || v.currentTime < start) v.currentTime = start;
      v.currentTime = skipCuts(v.currentTime, cuts);
      void v.play().catch(() => undefined);
    } else {
      v.pause();
    }
  }, [cuts, end, start]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let raf: number;
    const loop = () => {
      if (!v.paused) {
        let cur = v.currentTime;
        const jump = skipCuts(cur, cuts);
        if (jump !== cur) {
          v.currentTime = jump;
          cur = jump;
        }
        setPlayhead(cur);
        if (cur >= end) {
          v.pause();
          v.currentTime = start;
          setPlayhead(start);
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [cuts, end, start]);

  const positionFromEvent = useCallback(
    (clientX: number): number => {
      const el = trackRef.current;
      if (!el) return 0;
      const rect = el.getBoundingClientRect();
      const ratio = (clientX - rect.left) / rect.width;
      return clamp(ratio * duration, 0, duration);
    },
    [duration],
  );

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => {
      const t = positionFromEvent(e.clientX);
      if (dragging === "start") {
        const nextStart = clamp(t, 0, end - 0.2);
        setStart(nextStart);
        seek(nextStart);
      } else if (dragging === "end") {
        const nextEnd = clamp(t, start + 0.2, duration);
        setEnd(nextEnd);
        seek(nextEnd);
      } else if (dragging === "playhead") {
        seek(clamp(t, start, end));
      }
    };
    const onUp = () => setDragging(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [dragging, duration, end, positionFromEvent, seek, start]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "i" || e.key === "I") {
        setStart(clamp(playhead, 0, end - 0.2));
      } else if (e.key === "o" || e.key === "O") {
        setEnd(clamp(playhead, start + 0.2, duration));
      } else if (e.key === "x" || e.key === "X" || e.key === "Delete") {
        e.preventDefault();
        cutOutRef.current();
      } else if (e.key === "ArrowLeft") {
        seek(clamp(playhead - (e.shiftKey ? 1 : 1 / 60), start, end));
      } else if (e.key === "ArrowRight") {
        seek(clamp(playhead + (e.shiftKey ? 1 : 1 / 60), start, end));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, togglePlay, playhead, start, end, duration, seek]);

  const kept = useMemo(() => keptRanges(start, end, cuts), [start, end, cuts]);
  const selectionSeconds = totalLength(kept);
  const estimatedBytes = useMemo(
    () =>
      clip.duration_seconds > 0
        ? Math.round(clip.size_bytes * (selectionSeconds / clip.duration_seconds))
        : clip.size_bytes,
    [clip.size_bytes, clip.duration_seconds, selectionSeconds],
  );

  const srcW = clip.width || videoRef.current?.videoWidth || 1920;
  const srcH = clip.height || videoRef.current?.videoHeight || 1080;
  const cropBox = crop ? cropRect(srcW, srcH, crop) : null;
  const activeCrop = cropBox && !isFullFrame(cropBox) ? cropBox : null;
  /** One plain range and no crop: the lossless stream-copy path still works. */
  const simple = !activeCrop && kept.length <= 1;
  const plainRange = kept[0] ?? { start, end };
  const segments: ExportSegment[] = kept.map((r) => ({
    path: clip.path,
    start: r.start,
    end: r.end,
  }));

  // Where the picture sits inside the (letterboxed) player.
  const pic = useMemo(() => {
    if (!view.w || !view.h) return null;
    const scale = Math.min(view.w / srcW, view.h / srcH);
    const w = srcW * scale;
    const h = srcH * scale;
    return { x: (view.w - w) / 2, y: (view.h - h) / 2, w, h };
  }, [view, srcW, srcH]);

  const cutOut = () => {
    // Cutting everything that is left would leave nothing: refuse.
    const next = addCut(cuts, start, end);
    if (end - start < 0.1 || keptRanges(0, duration, next).length === 0) return;
    setCuts(next);
    setStart(0);
    setEnd(duration);
    const after = skipCuts(end, next);
    seek(after >= duration ? 0 : after);
  };
  const cutOutRef = useRef(cutOut);
  cutOutRef.current = cutOut;

  const dragCrop = (e: React.PointerEvent) => {
    if (!crop || !pic) return;
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const y0 = e.clientY;
    // Start from where the box really is (it is clamped at the edges).
    const box = cropRect(srcW, srcH, crop);
    const from = { ...crop, cx: box.x + box.w / 2, cy: box.y + box.h / 2 };
    const move = (ev: PointerEvent) =>
      setCrop({
        ...from,
        cx: from.cx + (ev.clientX - x0) / pic.w,
        cy: from.cy + (ev.clientY - y0) / pic.h,
      });
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const save = () => {
    if (simple) {
      void run("Trimming…", () => onSaveTrimmed(plainRange.start, plainRange.end));
      return;
    }
    setExportKind("save");
    void onExport(segments, activeCrop, "save");
  };
  const share = () => {
    setExportKind("share");
    if (simple) void onShare(plainRange.start, plainRange.end);
    else void onExport(segments, activeCrop, "share");
  };

  const pct = (t: number) => `${clamp((t / duration) * 100, 0, 100)}%`;

  const run = async (label: string, fn: () => Promise<void> | void) => {
    setStatus(label);
    try {
      await fn();
    } finally {
      setStatus(null);
    }
  };

  const takeSnapshot = () => {
    const v = videoRef.current;
    if (!v) return;
    void run("Capturing frame…", () =>
      clipflow
        .extractFramePng(clip.path, playhead, 0)
        .then((png) => onSnapshot(png)),
    );
  };

  const ticks = useMemo(() => {
    const count = 10;
    return Array.from({ length: count + 1 }, (_, i) => (duration * i) / count);
  }, [duration]);

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto p-4">
      <div
        className="animate-fade fixed inset-0 bg-scrim/45 backdrop-blur-sm"
        onClick={onClose}
      />

      <div className="relative flex min-h-full items-center justify-center">
        <div className="animate-pop panel-elevated relative z-10 flex w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-line-2 bg-surface">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-line px-5 py-3">
            <div className="flex items-center gap-3">
              <span className="h-2.5 w-2.5 rounded-full bg-blue-400" />
              <div>
                <div className="font-mono text-[11px] font-semibold tracking-wider text-ink-2">
                  CLIP EDITOR
                </div>
                {renaming ? (
                  <input
                    name="clip-rename"
                    autoFocus
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitRename();
                      } else if (e.key === "Escape") {
                        setNameDraft(clip.file_name);
                        setRenaming(false);
                      }
                    }}
                    onBlur={commitRename}
                    className="mt-0.5 w-full max-w-[42ch] rounded border border-blue-400/50 bg-surface-3 px-2 py-0.5 font-mono text-[11px] text-ink outline-none"
                    spellCheck={false}
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setNameDraft(clip.file_name);
                      setRenaming(true);
                    }}
                    title="Rename clip"
                    className="group mt-0.5 flex items-center gap-1.5 font-mono text-[11px] text-ink-3 transition hover:text-ink-2"
                  >
                    <span className="max-w-[44ch] truncate">{clip.file_name}</span>
                    <span className="text-[10px] text-ink-3 group-hover:text-accent-fg">
                      [Rename]
                    </span>
                  </button>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2.5">
              {typeof flushMs === "number" && (
                <span className="rounded border border-line-2 bg-surface-3 px-2 py-1 font-mono text-[10px] text-ink-3">
                  FLUSHED IN {flushMs.toFixed(1)} MS
                </span>
              )}
              <button
                type="button"
                onClick={() => void onToggleFavorite()}
                title={clip.favorite ? "Remove from favorites" : "Add to favorites"}
                className={cn(
                  "grid h-7 w-7 place-items-center rounded-md border text-[13px] transition-colors",
                  clip.favorite
                    ? "border-amber-400/40 bg-amber-400/10 text-warn"
                    : "border-line-2 bg-surface-3 text-ink-3 hover:text-ink",
                )}
              >
                {clip.favorite ? "★" : "☆"}
              </button>
              <button
                type="button"
                onClick={onClose}
                className="grid h-7 w-7 place-items-center rounded-md border border-line-2 bg-surface-3 text-ink-3 transition-colors hover:border-red-400/50 hover:text-danger"
                aria-label="Close trimmer"
              >
                ✕
              </button>
            </div>
          </div>

          {/* Tags bar */}
          <div className="flex flex-wrap items-center gap-1.5 border-b border-line bg-surface-2 px-5 py-2">
            <span className="font-mono text-[10px] tracking-wider text-ink-3">TAGS</span>
            {clip.tags.map((t) => (
              <span
                key={t}
                className="flex items-center gap-1 rounded border border-line-2 bg-surface-2 px-2 py-0.5 font-mono text-[10px] text-ink-3"
              >
                #{t}
                <button
                  type="button"
                  onClick={() => void onUpdateTags(clip.tags.filter((x) => x !== t))}
                  title={`Remove tag ${t}`}
                  className="text-ink-3 hover:text-danger"
                >
                  ✕
                </button>
              </span>
            ))}
            <input
              value={tagDraft}
              onChange={(e) => setTagDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                const tag = tagDraft.trim();
                if (!tag || clip.tags.includes(tag)) {
                  setTagDraft("");
                  return;
                }
                void onUpdateTags([...clip.tags, tag]);
                setTagDraft("");
              }}
              placeholder="+ add tag…"
              spellCheck={false}
              className="w-24 rounded border border-line-2 bg-surface px-2 py-0.5 font-mono text-[10px] text-ink outline-none placeholder:text-ink-3 focus:border-blue-400"
            />
          </div>

          {/* Player Viewport */}
          <div ref={viewRef} className="relative aspect-video w-full overflow-hidden bg-[#0a0c10]">
            {hasVideo ? (
              <video
                ref={videoRef}
                src={src}
                className="h-full w-full object-contain"
                onLoadedMetadata={handleLoadedMetadata}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onClick={togglePlay}
                muted={muted}
                playsInline
                autoPlay
                loop={false}
              />
            ) : (
              <div className="grid h-full w-full place-items-center text-center">
                <div>
                  <div className="font-mono text-[13px] text-ink-5">NO PREVIEW STREAM</div>
                  <div className="mt-1 font-mono text-[11px] text-ink-5">{clip.path}</div>
                </div>
              </div>
            )}

            {/* Overlay Specs */}
            <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between p-3 font-mono text-[10px] text-white/90">
              <span className="rounded bg-black/75 px-2 py-1 border border-white/10">
                {clip.width}×{clip.height} · {clip.fps} FPS · {clip.has_audio ? "AAC 48 kHz" : "NO AUDIO"}
              </span>
              <span className="rounded bg-black/75 px-2 py-1 border border-white/10">{formatBytes(clip.size_bytes)}</span>
            </div>

            <button
              type="button"
              onClick={togglePlay}
              className={cn(
                "absolute inset-0 grid place-items-center transition-opacity duration-150",
                playing ? "opacity-0 hover:opacity-100" : "opacity-100",
              )}
            >
              <span className="grid h-12 w-12 place-items-center rounded-full border border-white/20 bg-black/60 text-lg text-white backdrop-blur-sm">
                {playing ? "❚❚" : "▶"}
              </span>
            </button>

            {/* Crop box: drag to move; the dimmed part is cut away. */}
            {cropBox && pic && (
              <div className="pointer-events-none absolute inset-0">
                <div
                  onPointerDown={dragCrop}
                  className="pointer-events-auto absolute cursor-move rounded-sm border-2 border-white/90 shadow-[0_0_0_9999px_rgba(0,0,0,0.6)]"
                  style={{
                    left: pic.x + cropBox.x * pic.w,
                    top: pic.y + cropBox.y * pic.h,
                    width: cropBox.w * pic.w,
                    height: cropBox.h * pic.h,
                  }}
                  title="Drag to move the crop"
                >
                  <span className="absolute left-1 top-1 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[10px] text-white">
                    {crop?.aspect} · {Math.round(cropBox.w * srcW) & ~1}×{Math.round(cropBox.h * srcH) & ~1}
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Timeline and scrubber */}
          <div className="space-y-2.5 px-5 pt-3.5 pb-2">
            <div className="flex items-center justify-between font-mono text-[10px] tracking-wider text-ink-3">
              <span>
                IN <span className="text-accent-fg font-semibold">{formatTimecode(start)}</span>
              </span>
              <span>
                SELECTION{" "}
                <span className="text-ink font-semibold">{formatTimecode(selectionSeconds)}</span> ·{" "}
                <span className="text-ink-3">~{formatBytes(estimatedBytes)}</span>
              </span>
              <span>
                OUT <span className="text-accent-fg font-semibold">{formatTimecode(end)}</span>
              </span>
            </div>

            {/* Clean timeline track */}
            <div
              ref={trackRef}
              className="relative h-12 cursor-pointer select-none rounded-lg border border-line-2 bg-surface-2"
              onPointerDown={(e) => {
                const t = positionFromEvent(e.clientX);
                setDragging("playhead");
                seek(clamp(t, start, end));
              }}
            >
              {/* Ruler ticks background */}
              <div className="pointer-events-none absolute inset-0 flex justify-between px-2 pt-1">
                {ticks.map((t, i) => (
                  <div key={i} className="flex flex-col items-center">
                    <span className="h-2 w-px bg-line-3" />
                    <span className="mt-1 font-mono text-[9px] text-ink-3">{t.toFixed(0)}s</span>
                  </div>
                ))}
              </div>

              {/* Dimmed outside selection regions */}
              <div
                className="pointer-events-none absolute inset-y-0 left-0 rounded-l-lg bg-surface/70"
                style={{ width: pct(start) }}
              />
              <div
                className="pointer-events-none absolute inset-y-0 right-0 rounded-r-lg bg-surface/70"
                style={{ width: `${clamp(((duration - end) / duration) * 100, 0, 100)}%` }}
              />

              {/* Selection band */}
              <div
                className="pointer-events-none absolute inset-y-0 border-y-2 border-blue-400 bg-blue-500/15"
                style={{ left: pct(start), width: pct(end - start) }}
              />

              {/* Cut-out parts */}
              {cuts.map((c, i) => (
                <div
                  key={i}
                  className="pointer-events-none absolute inset-y-0 border-x border-red-400/70 bg-[repeating-linear-gradient(135deg,rgba(248,113,113,0.35)_0_6px,rgba(248,113,113,0.12)_6px_12px)]"
                  style={{ left: pct(c.start), width: pct(c.end - c.start) }}
                />
              ))}

              {/* Playhead */}
              <div
                className="pointer-events-none absolute inset-y-0 w-0.5 bg-ink shadow-[0_0_0_1px_rgba(255,255,255,0.9)]"
                style={{ left: pct(playhead) }}
              />

              {/* In Handle */}
              <button
                type="button"
                onPointerDown={(e) => {
                  e.stopPropagation();
                  setDragging("start");
                }}
                className="absolute top-0 h-full cursor-ew-resize rounded-l border-y border-l border-blue-400 bg-blue-500/40 transition hover:bg-blue-400/60"
                style={{ left: `calc(${pct(start)} - ${HANDLE_W / 2}px)`, width: HANDLE_W }}
                aria-label="Trim start"
              >
                <span className="mx-auto block h-5 w-0.5 bg-scrim/80" />
              </button>

              {/* Out Handle */}
              <button
                type="button"
                onPointerDown={(e) => {
                  e.stopPropagation();
                  setDragging("end");
                }}
                className="absolute top-0 h-full cursor-ew-resize rounded-r border-y border-r border-blue-400 bg-blue-500/40 transition hover:bg-blue-400/60"
                style={{ left: `calc(${pct(end)} - ${HANDLE_W / 2}px)`, width: HANDLE_W }}
                aria-label="Trim end"
              >
                <span className="mx-auto block h-5 w-0.5 bg-scrim/80" />
              </button>
            </div>

            {/* Micro controls */}
            <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[10px] text-ink-3">
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setStart(clamp(playhead, 0, end - 0.2))}
                  className="rounded border border-line bg-surface px-2 py-1 text-ink hover:border-accent hover:text-ink"
                >
                  Set In [I]
                </button>
                <button
                  type="button"
                  onClick={() => setEnd(clamp(playhead, start + 0.2, duration))}
                  className="rounded border border-line bg-surface px-2 py-1 text-ink hover:border-accent hover:text-ink"
                >
                  Set Out [O]
                </button>
                {[5, 10, 15, 30].map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => {
                      const nextStart = clamp(duration - s, 0, Math.max(duration - 0.2, 0));
                      setStart(nextStart);
                      setEnd(duration);
                      seek(nextStart);
                    }}
                    className="rounded border border-line bg-surface px-2 py-1 text-ink-3 hover:border-line-3 hover:text-ink"
                  >
                    Last {s}s
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    setStart(0);
                    setEnd(duration);
                    seek(0);
                  }}
                  className="rounded border border-line bg-surface px-2 py-1 text-ink-3 hover:text-ink"
                >
                  Reset
                </button>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setMuted((m) => !m)}
                  className="rounded border border-line bg-surface px-2 py-1 text-ink-3 hover:text-ink"
                >
                  {muted ? "Unmute" : "Mute"}
                </button>
                <span>Space: Play · ←/→: Step · Esc: Close</span>
              </div>
            </div>

            {/* Edit: cut parts out, crop the picture */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2.5 font-mono text-[10px] text-ink-3">
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={cutOut}
                  disabled={end - start < 0.1 || (start <= 0.05 && end >= duration - 0.05)}
                  title="Removes the selected part; playback skips it. Pick the part with the handles (or I / O) first."
                  className="rounded border border-red-400/40 bg-red-500/10 px-2 py-1 text-danger hover:border-red-400 disabled:opacity-40"
                >
                  ✂ Cut out selection [X]
                </button>
                {cuts.map((c, i) => (
                  <span
                    key={i}
                    className="flex items-center gap-1 rounded border border-line-2 bg-surface-2 px-1.5 py-0.5"
                  >
                    {formatTimecode(c.start)}–{formatTimecode(c.end)}
                    <button
                      type="button"
                      onClick={() => setCuts(cuts.filter((_, j) => j !== i))}
                      title="Put this part back"
                      className="hover:text-ink"
                    >
                      ↺
                    </button>
                  </span>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <span>CROP</span>
                <button
                  type="button"
                  onClick={() => setCrop(null)}
                  className={cn(
                    "rounded border px-2 py-1",
                    !crop
                      ? "border-accent bg-accent/15 text-accent-fg"
                      : "border-line bg-surface hover:text-ink",
                  )}
                >
                  Off
                </button>
                {CROP_ASPECTS.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    title={a.hint}
                    onClick={() =>
                      setCrop((c) => ({
                        aspect: a.id as CropAspect,
                        scale: c?.scale ?? 1,
                        cx: c?.cx ?? 0.5,
                        cy: c?.cy ?? 0.5,
                      }))
                    }
                    className={cn(
                      "rounded border px-2 py-1",
                      crop?.aspect === a.id
                        ? "border-accent bg-accent/15 text-accent-fg"
                        : "border-line bg-surface hover:text-ink",
                    )}
                  >
                    {a.id}
                  </button>
                ))}
                {crop && (
                  <label className="flex items-center gap-1.5" title="Crop size (smaller = zoom in)">
                    Size
                    <input
                      type="range"
                      min={30}
                      max={100}
                      value={Math.round(crop.scale * 100)}
                      onChange={(e) => setCrop({ ...crop, scale: Number(e.target.value) / 100 })}
                      className="w-20 accent-[var(--color-accent)]"
                    />
                  </label>
                )}
              </div>
            </div>
          </div>

          {/* Action footer */}
          <div className="mt-2 flex flex-wrap items-center justify-between gap-3 border-t border-line bg-surface px-5 py-3">
            <div className="font-mono text-[11px] text-ink-3">
              {status ? (
                <span className="text-accent-fg font-semibold">{status}</span>
              ) : (
                <span>
                  {simple
                    ? "Save: stream copy, lossless, instant"
                    : `Save: re-encodes at full quality${activeCrop ? " with the crop" : ""} (${kept.length} part${kept.length === 1 ? "" : "s"})`}
                </span>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => run("Discarding…", onDiscard)}
                disabled={busy}
                className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-[11px] font-medium text-danger hover:border-red-400 hover:bg-red-500/20 disabled:opacity-40"
              >
                Discard
              </button>

              <button
                type="button"
                onClick={() => run("Opening in player…", onOpenExternal)}
                disabled={busy}
                className="rounded-lg border border-line bg-surface px-3 py-1.5 text-[11px] text-ink hover:border-line-3 hover:text-ink disabled:opacity-40"
              >
                Play
              </button>

              <button
                type="button"
                onClick={() => run("Revealing file…", onReveal)}
                disabled={busy}
                title="Show in Windows Explorer"
                className="rounded-lg border border-line bg-surface px-3 py-1.5 text-[11px] text-ink hover:border-line-3 hover:text-ink disabled:opacity-40"
              >
                Reveal
              </button>

              <button
                type="button"
                onClick={takeSnapshot}
                disabled={busy}
                className="rounded-lg border border-line bg-surface px-3 py-1.5 text-[11px] text-ink hover:border-line-3 hover:text-ink disabled:opacity-40"
              >
                Snapshot
              </button>

              <button
                type="button"
                onClick={() => run("Copying to clipboard…", onCopy)}
                disabled={busy}
                className="rounded-lg border border-line bg-surface px-3.5 py-1.5 text-[11px] text-ink hover:border-accent hover:text-ink disabled:opacity-40"
              >
                Copy original
              </button>

              <button
                type="button"
                onClick={share}
                disabled={busy || shareProgress !== undefined || selectionSeconds < 0.2}
                title={`Makes a copy of the edit under ${shareLimitMb} MB and puts it on the clipboard, ready to paste into Discord.`}
                className="rounded-lg border border-accent/50 bg-accent/15 px-3.5 py-1.5 text-[12px] font-semibold text-accent-fg hover:bg-accent/25 disabled:opacity-60"
              >
                {shareProgress !== undefined && exportKind === "share"
                  ? `Shrinking ${Math.round(shareProgress * 100)}%`
                  : `Shrink & copy · ${shareLimitMb} MB`}
              </button>

              <button
                type="button"
                onClick={() => run("Splitting at playhead…", () => onSplit(playhead))}
                disabled={busy || playhead < 0.2 || playhead > duration - 0.2}
                title="Cut the clip in two at the playhead without re-encoding"
                className="rounded-lg border border-line bg-surface px-3 py-1.5 text-[11px] text-ink hover:border-amber-400 hover:text-warn disabled:opacity-40"
              >
                Split
              </button>

              <button
                type="button"
                onClick={save}
                disabled={busy || shareProgress !== undefined || selectionSeconds < 0.2}
                title="Saves the edit as a new clip; the original stays as it is."
                className="rounded-lg border border-accent bg-accent px-4 py-1.5 text-[12px] font-semibold text-white shadow-sm hover:bg-accent-hover disabled:opacity-60"
              >
                {shareProgress !== undefined && exportKind === "save"
                  ? `Saving ${Math.round(shareProgress * 100)}%`
                  : "Save as new clip"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
