import { useMemo, useState, useSyncExternalStore } from "react";
import { formatDuration, formatRelativeTime } from "../lib/format";
import type { ClipMetadata } from "../lib/types";
import { cn } from "../utils/cn";
import { media } from "./media";
import type { EdProject } from "./project";
import { AUDIO_RE, IMAGE_RE, baseName, urlOf } from "./store";
import { Ico, I } from "./ui";

/**
 * The media list: library clips and the files this project uses. Drag one
 * onto the timeline (it lands where you drop it), double-click or press +
 * to put it at the playhead.
 */

export const DRAG_TYPE = "application/x-lastshot-paths";

function Thumb({ path, src }: { path: string; src?: string | null }) {
  useSyncExternalStore((l) => media.subscribe(l), () => media.version);
  if (IMAGE_RE.test(path)) return <img src={urlOf(path)} alt="" draggable={false} className="h-full w-full object-cover" />;
  if (AUDIO_RE.test(path))
    return (
      <div className="grid h-full w-full place-items-center bg-emerald-900/40 text-emerald-300">
        <Ico d={I.music} className="h-5 w-5" />
      </div>
    );
  const url = src || media.thumb(path, 1, 1, 72);
  return url ? <img src={url} alt="" draggable={false} className="h-full w-full object-cover" /> : <div className="h-full w-full bg-surface-4" />;
}

export default function MediaBin({
  clips,
  p,
  onAdd,
  onImport,
  onDragPaths,
}: {
  clips: ClipMetadata[];
  p: EdProject;
  onAdd: (paths: string[]) => void;
  onImport: () => void;
  onDragPaths: (paths: string[] | null) => void;
}) {
  const [tab, setTab] = useState<"library" | "project">("library");
  const [q, setQ] = useState("");
  const used = useMemo(() => {
    const seen = new Map<string, number>();
    for (const i of p.tl.items) if (i.path) seen.set(i.path, (seen.get(i.path) ?? 0) + 1);
    return seen;
  }, [p.tl.items]);
  const list = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const match = (s: string) => words.every((w) => s.toLowerCase().includes(w));
    if (tab === "library") return clips.filter((c) => match(`${c.title} ${c.file_name} ${c.game ?? ""} ${c.tags.join(" ")}`)).map((c) => ({ path: c.path, name: c.title, sub: `${formatDuration(c.duration_seconds)} · ${formatRelativeTime(c.created_unix_ms)}`, thumb: c.thumbnail, fav: c.favorite }));
    return [...used.keys()].filter((path) => match(baseName(path))).map((path) => ({ path, name: baseName(path), sub: `used ${used.get(path)}×`, thumb: null as string | null, fav: false }));
  }, [tab, clips, used, q]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b border-line px-2 py-1.5">
        {(["library", "project"] as const).map((t) => (
          <button key={t} type="button" onClick={() => setTab(t)} className={cn("rounded-md px-2 py-1 text-[11.5px] font-medium", tab === t ? "bg-surface-4 text-ink" : "text-ink-3 hover:text-ink")}>
            {t === "library" ? "Library" : "In project"}
          </button>
        ))}
        <span className="flex-1" />
        <button type="button" onClick={onImport} title="Add files (Ctrl+I): videos, pictures, music" className="inline-flex h-7 items-center gap-1 rounded-md bg-accent px-2 text-[11.5px] font-semibold text-white hover:bg-accent-hover">
          <Ico d={I.plus} className="h-3.5 w-3.5" /> Add
        </button>
      </div>
      <div className="px-2 py-1.5">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={tab === "library" ? "Search clips, games, tags" : "Search files"}
          className="w-full rounded-md border border-line bg-surface-2 px-2 py-1 text-[11.5px] text-ink placeholder:text-ink-4 focus:border-accent focus:outline-none"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {list.length === 0 && (
          <p className="px-1 py-6 text-center text-[11px] leading-relaxed text-ink-4">
            {tab === "library" ? (q ? "No clips match." : "No clips yet. Save a replay, or press Add for files.") : "Nothing on the timeline yet."}
          </p>
        )}
        <div className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-2">
          {list.map((m) => (
            <div
              key={m.path}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_TYPE, JSON.stringify([m.path]));
                e.dataTransfer.setData("text/plain", m.path);
                e.dataTransfer.effectAllowed = "copy";
                onDragPaths([m.path]);
              }}
              onDragEnd={() => onDragPaths(null)}
              onDoubleClick={() => onAdd([m.path])}
              title={`${m.name}\nDrag onto the timeline, or double-click to add at the playhead`}
              className="group relative cursor-grab overflow-hidden rounded-md border border-line bg-surface-2 hover:border-accent/60"
            >
              <div className="relative aspect-video w-full overflow-hidden">
                <Thumb path={m.path} src={m.thumb} />
                {used.has(m.path) && tab === "library" && <span className="absolute left-1 top-1 rounded bg-black/70 px-1 text-[9px] text-white">in project</span>}
                {m.fav && <span className="absolute right-1 top-1 text-[10px] text-amber-400">★</span>}
                <button
                  type="button"
                  title="Add at the playhead"
                  onClick={(e) => {
                    e.stopPropagation();
                    onAdd([m.path]);
                  }}
                  className="absolute bottom-1 right-1 grid h-6 w-6 place-items-center rounded-full bg-accent text-white opacity-0 shadow group-hover:opacity-100 focus:opacity-100"
                >
                  <Ico d={I.plus} className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="px-1.5 py-1">
                <div className="truncate text-[11px] font-medium text-ink">{m.name}</div>
                <div className="truncate font-mono text-[9.5px] text-ink-4">{m.sub}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
