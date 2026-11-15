import { memo, useCallback, useEffect, useState } from "react";
import { lastshot } from "../lib/bridge";
import type { ClipMetadata } from "../lib/types";
import { formatBytes, formatDuration, formatRelativeTime, folderName } from "../lib/format";
import { cacheThumbnail, getCachedThumbnail } from "../lib/thumbCache";
import { cn } from "../utils/cn";
import { gapFor, useVirtualGrid } from "../hooks/useVirtualGrid";

/** Gallery thumbnails are decoded lazily per visible card and cached in `thumbCache`. */

interface Props {
  clips: ClipMetadata[];
  loading?: boolean;
  compact?: boolean;
  /** Total count of all clips in the library (before filtering) */
  totalClipsCount?: number;
  onResetFilters?: () => void;
  /** Paths currently selected (multi-select), as a Set for O(1) lookups. */
  selectedPaths?: ReadonlySet<string>;
  /** When on, a plain card click selects instead of opening the trimmer. */
  selectMode?: boolean;
  onOpen: (clip: ClipMetadata) => void;
  onSelect: (clip: ClipMetadata, mods: { ctrl: boolean; shift: boolean }) => void;
  onCopy: (clip: ClipMetadata) => void;
  onReveal: (clip: ClipMetadata) => void;
  onOpenExternal: (clip: ClipMetadata) => void;
  onDelete: (clip: ClipMetadata) => void;
  onToggleFavorite: (clip: ClipMetadata) => void;
  /** Shrink under the share limit and copy to the clipboard. */
  onShare: (clip: ClipMetadata) => void;
  /** Share size limit in MB, for the button label. */
  shareLimitMb: number;
  /** Shrink progress (0-1) by clip path, for clips being shrunk right now. */
  shareProgress?: ReadonlyMap<string, number>;
}

/** Starts a native file drag so the clip can be dropped into Discord, Explorer, a browser... */
function startNativeDrag(e: React.DragEvent, path: string) {
  e.preventDefault();
  void lastshot.startClipDrag(path).catch(() => {
    /* drag is a convenience; the copy buttons still work */
  });
}

function IconButton({
  title,
  onClick,
  danger,
  highlight,
  children,
}: {
  title: string;
  onClick: (e: React.MouseEvent) => void;
  danger?: boolean;
  highlight?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={cn(
        "grid h-7 w-7 place-items-center rounded-md border text-[11px] backdrop-blur-sm transition-colors duration-150",
        danger
          ? "border-red-500/40 bg-surface-3/95 text-danger hover:border-red-400 hover:bg-red-500/25"
          : highlight
            ? "border-amber-400/50 bg-surface-3/95 text-warn hover:border-amber-400 hover:bg-amber-400/25"
            : "border-line-3 bg-surface-3/95 text-ink-3 hover:border-accent/70 hover:bg-surface-2 hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

const ClipCard = memo(function ClipCard({
  clip,
  compact,
  selected,
  selectMode,
  onOpen,
  onSelect,
  onCopy,
  onReveal,
  onOpenExternal,
  onDelete,
  onToggleFavorite,
  onShare,
  shareLimitMb,
  progress,
}: {
  clip: ClipMetadata;
  compact?: boolean;
  selected: boolean;
  selectMode: boolean;
  onOpen: (c: ClipMetadata) => void;
  onSelect: (c: ClipMetadata, mods: { ctrl: boolean; shift: boolean }) => void;
  onCopy: (c: ClipMetadata) => void;
  onReveal: (c: ClipMetadata) => void;
  onOpenExternal: (c: ClipMetadata) => void;
  onDelete: (c: ClipMetadata) => void;
  onToggleFavorite: (c: ClipMetadata) => void;
  onShare: (c: ClipMetadata) => void;
  shareLimitMb: number;
  progress: number | undefined;
}) {
  const [thumb, setThumb] = useState(clip.thumbnail);
  const fitsAlready = clip.size_bytes <= shareLimitMb * 1_000_000;

  useEffect(() => {
    if (clip.thumbnail) {
      setThumb(clip.thumbnail);
      return;
    }
    let alive = true;
    let requested = false;
    const load = () => {
      if (!alive || requested || document.visibilityState !== "visible") return;
      const cached = getCachedThumbnail(clip.path);
      if (cached) {
        setThumb(cached);
        requested = true;
        return;
      }
      requested = true;
      void lastshot
        .getClipThumbnail(clip.path, 1)
        .then((t) => {
          if (!alive || !t) return;
          cacheThumbnail(clip.path, t);
          setThumb(t);
        })
        .catch(() => {
          // Allow a retry the next time the deck becomes visible.
          requested = false;
        });
    };
    load();
    document.addEventListener("visibilitychange", load);
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", load);
    };
  }, [clip.path, clip.thumbnail]);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      const mods = { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey };
      if (selectMode || mods.ctrl || mods.shift) {
        onSelect(clip, mods);
      } else {
        onOpen(clip);
      }
    },
    [clip, onOpen, onSelect, selectMode],
  );

  // Keyboard parity with the mouse: Enter/Space opens, `x` toggles selection.
  // The card used to be an un-focusable <article onClick>, so the library was
  // completely unusable without a mouse.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (selectMode) onSelect(clip, { ctrl: true, shift: e.shiftKey });
        else onOpen(clip);
      } else if (e.key === "x" || e.key === "X") {
        e.preventDefault();
        onSelect(clip, { ctrl: true, shift: e.shiftKey });
      }
    },
    [clip, onOpen, onSelect, selectMode],
  );

  return (
    <article
      role="button"
      tabIndex={0}
      aria-label={`${clip.title}, ${formatDuration(clip.duration_seconds)}${
        clip.game ? `, ${clip.game}` : ""
      }${clip.favorite ? ", favourite" : ""}`}
      aria-pressed={selectMode ? selected : undefined}
      onKeyDown={handleKeyDown}
      draggable={!selectMode}
      onDragStart={(e) => startNativeDrag(e, clip.path)}
      title="Click to open. Drag into Discord or a folder to share the file."
      className={cn(
        "panel panel-hover group relative cursor-pointer overflow-hidden rounded-xl transition-all duration-150",
        selected
          ? "border-accent ring-2 ring-accent/40 bg-accent-wash"
          : "hover:border-line-hover",
      )}
      onClick={handleClick}
    >
      {/* Thumbnail Viewport */}
      <div className="relative aspect-video w-full overflow-hidden bg-surface-elevated">
        {thumb ? (
          <img
            src={thumb}
            alt={clip.title}
            loading="lazy"
            decoding="async"
            draggable={false}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="absolute inset-0 grid place-items-center bg-surface-elevated">
            <span className="font-mono text-[10px] text-text-muted">THUMBNAIL…</span>
          </div>
        )}

        {/* Play affordance — decoding starts only in the trimmer, never on hover */}
        <span className="pointer-events-none absolute inset-0 grid place-items-center opacity-0 transition-opacity duration-150 group-hover:opacity-100">
          <span className="grid h-10 w-10 place-items-center rounded-full bg-black/65 text-white shadow-lg backdrop-blur-sm">
            <svg viewBox="0 0 16 16" className="ml-0.5 h-4 w-4 fill-current">
              <path d="M4 2.8v10.4L13 8 4 2.8z" />
            </svg>
          </span>
        </span>

        {/* Readability scrim */}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/55 via-transparent to-transparent" />

        {/* Game badge */}
        {(clip.game || clip.folder) && (
          <div className="absolute left-2.5 top-2.5 flex max-w-[85%] gap-1">
            {clip.folder && (
              <span
                title={`From ${clip.folder}`}
                className="truncate rounded bg-black/75 px-1.5 py-0.5 text-[10px] font-medium text-white border border-white/10"
              >
                📁 {folderName(clip.folder)}
              </span>
            )}
            {clip.game && (
              <span className="rounded bg-black/75 px-1.5 py-0.5 font-mono text-[10px] font-medium tracking-wide text-white border border-white/10">
                {clip.game.toUpperCase()}
              </span>
            )}
          </div>
        )}

        {/* Duration badge */}
        <span className="absolute bottom-2 left-2.5 rounded bg-black/80 px-1.5 py-0.5 font-mono text-[11px] font-medium text-white border border-white/10">
          {formatDuration(clip.duration_seconds)}
        </span>

        {/* Audio availability badge */}
        {clip.has_audio && (
          <span
            className="absolute bottom-2 left-16 rounded bg-black/80 px-1.5 py-0.5 font-mono text-[10px] text-white border border-white/10 flex items-center gap-1"
            title="Recorded with game audio"
          >
            <svg viewBox="0 0 16 16" className="h-2.5 w-2.5 fill-current">
              <path d="M11.536 14.01A8.473 8.473 0 0 0 14.026 8a8.47 8.47 0 0 0-2.49-6.01l-.708.707A7.476 7.476 0 0 1 13.025 8c0 2.071-.84 3.946-2.197 5.303l.708.707z" />
              <path d="M6.717 3.55A.5.5 0 0 1 7 4v8a.5.5 0 0 1-.812.39L3.825 10.5H1.5A.5.5 0 0 1 1 10V6a.5.5 0 0 1 .5-.5h2.325l2.363-1.89a.5.5 0 0 1 .529-.06z" />
            </svg>
            Audio
          </span>
        )}

        {/* Format / resolution badge */}
        <span className="absolute bottom-2 right-2.5 rounded bg-black/80 px-1.5 py-0.5 font-mono text-[10px] text-white border border-white/10">
          {clip.height}p{clip.fps}
        </span>

        {/* Favorite indicator */}
        {clip.favorite && (
          <span
            className="absolute left-2.5 top-8 rounded bg-amber-500/95 px-1.5 py-0.5 font-mono text-[9px] font-bold text-black"
            title="Favorited clip"
          >
            ★
          </span>
        )}

        {/* Action button overlay */}
        <div
          className={cn(
            "absolute right-2 top-2 flex items-center gap-1 transition-opacity duration-150",
            selectMode ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          )}
        >
          {(selectMode || selected) && (
            <IconButton
              title={selected ? "Deselect clip" : "Select clip"}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(clip, { ctrl: true, shift: false });
              }}
            >
              <span className="font-mono text-[12px]">{selected ? "✓" : "☐"}</span>
            </IconButton>
          )}

          <IconButton
            title={clip.favorite ? "Remove from favorites" : "Add to favorites"}
            highlight={clip.favorite}
            onClick={(e) => {
              e.stopPropagation();
              onToggleFavorite(clip);
            }}
          >
            <span>{clip.favorite ? "★" : "☆"}</span>
          </IconButton>

          <IconButton
            title="Open in external player"
            onClick={(e) => {
              e.stopPropagation();
              onOpenExternal(clip);
            }}
          >
            <svg viewBox="0 0 16 16" className="h-3 w-3 fill-current">
              <path d="M4 3.5v9l8-4.5-8-4.5z" />
            </svg>
          </IconButton>

          <IconButton
            title="Copy video file to clipboard"
            onClick={(e) => {
              e.stopPropagation();
              onCopy(clip);
            }}
          >
            <svg viewBox="0 0 16 16" className="h-3 w-3 fill-none stroke-current" strokeWidth="1.5">
              <rect x="5" y="5" width="8" height="8" rx="1.5" />
              <path d="M3 11V3a1 1 0 0 1 1-1h8" />
            </svg>
          </IconButton>

          <IconButton
            title="Reveal in Explorer"
            onClick={(e) => {
              e.stopPropagation();
              onReveal(clip);
            }}
          >
            <svg viewBox="0 0 16 16" className="h-3 w-3 fill-none stroke-current" strokeWidth="1.5">
              <circle cx="7" cy="7" r="4.5" />
              <path d="M10.5 10.5L14 14" />
            </svg>
          </IconButton>

          <IconButton
            title="Delete clip"
            danger
            onClick={(e) => {
              e.stopPropagation();
              onDelete(clip);
            }}
          >
            <svg viewBox="0 0 16 16" className="h-3 w-3 fill-none stroke-current" strokeWidth="1.5">
              <path d="M3 4h10M6 4V2.5A1.5 1.5 0 0 1 7.5 1h1A1.5 1.5 0 0 1 10 2.5V4M5 4v9a1.5 1.5 0 0 0 1.5 1.5h3A1.5 1.5 0 0 0 11 13V4" />
            </svg>
          </IconButton>
        </div>
      </div>

      {/* Card Content Footer */}
      <div className={compact ? "px-2.5 py-2" : "px-3 py-2.5"}>
        <div className="h-5 truncate text-[13px] font-medium text-ink">{clip.title}</div>
        <div className="mt-1 flex h-4 items-center gap-1 overflow-hidden">
          {clip.tags.length > 0 && (
            <>
              {clip.tags.slice(0, 3).map((t) => (
                <span
                  key={t}
                  className="shrink-0 rounded border border-line bg-surface-2 px-1.5 py-px font-mono text-[9px] text-ink-3"
                >
                  #{t}
                </span>
              ))}
              {clip.tags.length > 3 && (
                <span className="shrink-0 font-mono text-[9px] text-ink-3">
                  +{clip.tags.length - 3}
                </span>
              )}
            </>
          )}
        </div>
        <div className="mt-1.5 flex items-center justify-between gap-2 font-mono text-[10px] text-ink-3">
          <span className="truncate">
            {formatRelativeTime(clip.created_unix_ms)} · {formatBytes(clip.size_bytes)}
          </span>
          <button
            type="button"
            disabled={progress !== undefined}
            onClick={(e) => {
              e.stopPropagation();
              onShare(clip);
            }}
            title={
              fitsAlready
                ? `Already under ${shareLimitMb} MB: copies the clip so you can paste it into Discord.`
                : `Makes a copy under ${shareLimitMb} MB and puts it on the clipboard, ready to paste into Discord.`
            }
            className="shrink-0 rounded-md border border-accent/40 bg-accent/10 px-2 py-0.5 font-sans text-[11px] font-semibold text-accent-fg transition-colors hover:bg-accent/20 disabled:cursor-wait disabled:opacity-80"
          >
            {progress !== undefined
              ? `Shrinking ${Math.round(progress * 100)}%`
              : fitsAlready
                ? "Copy to share"
                : `Shrink & copy · ${shareLimitMb} MB`}
          </button>
        </div>
      </div>
      {progress !== undefined && (
        <div className="absolute inset-x-0 bottom-0 h-0.5 bg-line">
          <div className="h-full bg-accent transition-[width] duration-300" style={{ width: `${progress * 100}%` }} />
        </div>
      )}
    </article>
  );
});

const GalleryGrid = memo(function GalleryGrid({
  clips,
  loading,
  compact,
  totalClipsCount,
  onResetFilters,
  selectedPaths,
  selectMode,
  onOpen,
  onSelect,
  onCopy,
  onReveal,
  onOpenExternal,
  onDelete,
  onToggleFavorite,
  onShare,
  shareLimitMb,
  shareProgress,
}: Props) {
  const gap = gapFor(!!compact);
  const { cols, rowPitch, totalHeight, startRow, endRow, containerRef, rowRef } =
    useVirtualGrid({ itemCount: clips.length, compact: !!compact });

  const gridClass = compact
    ? "grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
    : "grid gap-4 sm:grid-cols-2 xl:grid-cols-3";

  let content: React.ReactNode;
  if (loading) {
    content = (
      <div className={gridClass}>
        {Array.from({ length: compact ? 8 : 6 }).map((_, i) => (
          <div key={i} className="panel h-[190px] animate-pulse rounded-xl bg-surface-2" />
        ))}
      </div>
    );
  } else if (clips.length === 0) {
    if (totalClipsCount && totalClipsCount > 0) {
      content = (
        <div className="panel flex flex-col items-center justify-center gap-3 rounded-xl px-6 py-14 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-line bg-surface-2 text-ink-3">
            <svg viewBox="0 0 24 24" className="h-6 w-6 fill-none stroke-current" strokeWidth="1.5">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.35-4.35" />
            </svg>
          </div>
          <div className="text-[14px] font-semibold text-ink">
            No clips match your search
          </div>
          <p className="max-w-sm text-[12px] leading-relaxed text-ink-3">
            No recorded clips match the current search query or game filters.
          </p>
          {onResetFilters && (
            <button
              type="button"
              onClick={onResetFilters}
              className="mt-1 rounded-lg border border-accent/40 bg-accent/10 px-3.5 py-1.5 text-[12px] font-medium text-accent-fg hover:bg-accent/20 transition-colors"
            >
              Clear Search & Filters
            </button>
          )}
        </div>
      );
    } else {
      content = (
        <div className="panel flex flex-col items-center justify-center gap-3 rounded-xl px-6 py-16 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-line bg-surface-2 text-ink-3">
            <svg viewBox="0 0 24 24" className="h-6 w-6 fill-none stroke-current" strokeWidth="1.5">
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="M7 4v16M17 4v16M2 12h20M2 8h5M2 16h5M17 8h5M17 16h5" />
            </svg>
          </div>
          <div className="text-[14px] font-semibold text-ink">
            No clips recorded yet
          </div>
          <p className="max-w-sm text-[12px] leading-relaxed text-ink-3">
            While recording is on, press your Save replay shortcut (Settings › Shortcuts) to keep
            the last moments as a clip.
          </p>
        </div>
      );
    }
  } else {
    const rows: React.ReactNode[] = [];
    for (let r = startRow; r < endRow; r++) {
      const from = r * cols;
      rows.push(
        <div
          key={r}
          ref={r === startRow ? rowRef : undefined}
          className="absolute left-0 right-0 grid"
          style={{
            top: r * rowPitch,
            gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
            gap: `${gap}px`,
          }}
        >
          {clips.slice(from, from + cols).map((clip) => (
            <ClipCard
              key={clip.id}
              clip={clip}
              compact={compact}
              selected={selectedPaths?.has(clip.path) ?? false}
              selectMode={!!selectMode}
              onOpen={onOpen}
              onSelect={onSelect}
              onCopy={onCopy}
              onReveal={onReveal}
              onOpenExternal={onOpenExternal}
              onDelete={onDelete}
              onToggleFavorite={onToggleFavorite}
              onShare={onShare}
              shareLimitMb={shareLimitMb}
              progress={shareProgress?.get(clip.path)}
            />
          ))}
        </div>,
      );
    }
    content = rows;
  }

  return (
    <div ref={containerRef} className="relative" style={{ height: totalHeight || undefined }}>
      {content}
    </div>
  );
});

export default GalleryGrid;
