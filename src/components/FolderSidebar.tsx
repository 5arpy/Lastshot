import { useMemo } from "react";
import type { ClipMetadata, DiskInfo } from "../lib/types";
import { folderName, formatBytes } from "../lib/format";
import { cn } from "../utils/cn";
import { shownPath } from "../lib/pathDisplay";

/** Folder filter: "all", "save", an extra folder path, or "dir:<path>" (a subfolder of the save folder). */
export type FolderFilter = string;

export function parentDir(path: string): string {
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return i > 0 ? path.slice(0, i) : path;
}

const samePath = (a: string, b: string) =>
  a.replace(/[\\/]+$/, "").toLowerCase() === b.replace(/[\\/]+$/, "").toLowerCase();

/** Whether a clip belongs to the given folder filter. */
export function matchesFolder(c: ClipMetadata, filter: FolderFilter): boolean {
  if (filter === "all") return true;
  if (filter === "save") return !c.folder;
  if (filter.startsWith("dir:")) return !c.folder && samePath(parentDir(c.path), filter.slice(4));
  return c.folder === filter;
}

interface Group {
  key: FolderFilter;
  label: string;
  path: string;
  count: number;
  bytes: number;
}

function sum(list: ClipMetadata[]) {
  return { count: list.length, bytes: list.reduce((a, c) => a + c.size_bytes, 0) };
}

function DiskBar({ disk, used }: { disk: DiskInfo; used: number }) {
  const total = Math.max(1, disk.totalBytes);
  const taken = total - disk.freeBytes;
  const other = Math.max(0, taken - used);
  const low = disk.freeBytes < 5e9 || disk.freeBytes / total < 0.05;
  return (
    <div className="space-y-1.5" title={`${disk.root}: ${formatBytes(taken)} used, ${formatBytes(disk.freeBytes)} free, ${formatBytes(total)} total`}>
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="font-semibold text-ink">Drive {disk.root.replace(/\\$/, "")}</span>
        <span className={cn("font-mono", low ? "text-warn" : "text-ink-3")}>
          {formatBytes(disk.freeBytes)} free
        </span>
      </div>
      <div className="flex h-2 overflow-hidden rounded-full bg-surface-4">
        <div className="h-full bg-accent" style={{ width: `${(used / total) * 100}%` }} />
        <div className={cn("h-full", low ? "bg-amber-500/70" : "bg-ink-4/60")} style={{ width: `${(other / total) * 100}%` }} />
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-ink-3">
        <span className="flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-accent" />
          Clips {formatBytes(used)}
        </span>
        <span className="flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-ink-4/60" />
          Other {formatBytes(other)}
        </span>
        <span>of {formatBytes(total)}</span>
      </div>
    </div>
  );
}

function FolderRow({
  group,
  active,
  depth = 0,
  icon,
  onPick,
  onOpen,
  onRemove,
}: {
  group: Group;
  active: boolean;
  depth?: number;
  icon: string;
  onPick: () => void;
  onOpen?: () => void;
  onRemove?: () => void;
}) {
  return (
    <div
      className={cn(
        "group flex items-center gap-1 rounded-md pr-1 transition-colors",
        active ? "bg-accent/15" : "hover:bg-surface-2",
      )}
      style={{ paddingLeft: 4 + depth * 14 }}
    >
      <button
        type="button"
        onClick={onPick}
        title={shownPath(group.path) || undefined}
        className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-1 text-left"
      >
        <span className="shrink-0 text-[12px]">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className={cn("block truncate text-[12px]", active ? "font-semibold text-accent-fg" : "text-ink")}>
            {group.label}
          </span>
          {depth === 0 && group.path && (
            <span className="block truncate font-mono text-[9.5px] text-ink-4">{shownPath(group.path)}</span>
          )}
        </span>
        <span className="shrink-0 text-right font-mono text-[10px] leading-tight text-ink-3">
          {group.count} {group.count === 1 ? "clip" : "clips"}
          <br />
          {formatBytes(group.bytes)}
        </span>
      </button>
      {(onOpen || onRemove) && (
        <span className="flex shrink-0 flex-col opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          {onOpen && (
            <button
              type="button"
              onClick={onOpen}
              title="Open in Explorer"
              aria-label={`Open ${group.label} in Explorer`}
              className="rounded px-1 text-[11px] leading-4 text-ink-3 hover:text-ink"
            >
              ↗
            </button>
          )}
          {onRemove && (
            <button
              type="button"
              onClick={onRemove}
              title="Stop showing this folder (files stay where they are)"
              aria-label={`Stop showing ${group.label}`}
              className="rounded px-1 text-[11px] leading-4 text-ink-3 hover:text-danger"
            >
              ×
            </button>
          )}
        </span>
      )}
    </div>
  );
}

/**
 * Explorer-like list of where clips live, with how much each folder takes and
 * how full each drive is.
 */
export default function FolderSidebar({
  clips,
  outputDir,
  libraryFolders,
  disks,
  value,
  onChange,
  onOpenFolder,
  onAddFolder,
  onRemoveFolder,
}: {
  clips: ClipMetadata[];
  outputDir: string;
  libraryFolders: string[];
  disks: DiskInfo[];
  value: FolderFilter;
  onChange: (v: FolderFilter) => void;
  onOpenFolder: (path: string) => void;
  onAddFolder: () => void;
  onRemoveFolder: (path: string) => void;
}) {
  const { all, save, subs, extras, perDrive } = useMemo(() => {
    const own = clips.filter((c) => !c.folder);
    const byDir = new Map<string, ClipMetadata[]>();
    for (const c of own) {
      const d = parentDir(c.path);
      if (samePath(d, outputDir)) continue;
      const k = d.toLowerCase();
      byDir.set(k, [...(byDir.get(k) ?? []), c]);
    }
    const subs: Group[] = [...byDir.values()]
      .map((list) => {
        const d = parentDir(list[0].path);
        return { key: `dir:${d}`, label: folderName(d), path: d, ...sum(list) };
      })
      .sort((a, b) => b.bytes - a.bytes);
    const extras: Group[] = libraryFolders.map((f) => ({
      key: f,
      label: folderName(f),
      path: f,
      ...sum(clips.filter((c) => c.folder === f)),
    }));
    const perDrive = new Map<string, number>();
    for (const c of clips) {
      const root = c.path.slice(0, 3).toLowerCase();
      perDrive.set(root, (perDrive.get(root) ?? 0) + c.size_bytes);
    }
    return {
      all: { key: "all", label: "All clips", path: "", ...sum(clips) },
      save: { key: "save", label: "Lastshot folder", path: outputDir, ...sum(own) },
      subs,
      extras,
      perDrive,
    };
  }, [clips, outputDir, libraryFolders]);

  return (
    <aside className="panel flex flex-col gap-3 rounded-xl p-3">
      <div className="space-y-0.5">
        <FolderRow group={all} icon="🎞️" active={value === "all"} onPick={() => onChange("all")} />
        <FolderRow
          group={save}
          icon="📂"
          active={value === "save"}
          onPick={() => onChange("save")}
          onOpen={() => onOpenFolder(outputDir)}
        />
        {subs.map((g) => (
          <FolderRow
            key={g.key}
            group={g}
            icon="📁"
            depth={1}
            active={value === g.key}
            onPick={() => onChange(g.key)}
            onOpen={() => onOpenFolder(g.path)}
          />
        ))}
      </div>

      <div className="space-y-0.5 border-t border-line pt-2">
        <div className="flex items-center justify-between px-1 pb-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">Other folders</span>
          <button
            type="button"
            onClick={onAddFolder}
            title="Show videos from another folder too"
            className="rounded px-1.5 text-[11px] font-medium text-accent-fg hover:bg-accent/10"
          >
            + Add
          </button>
        </div>
        {extras.length === 0 ? (
          <p className="px-1 pb-1 text-[11px] leading-snug text-ink-4">
            Add a folder (OBS, ShadowPlay, Downloads…) to edit and share its videos here.
          </p>
        ) : (
          extras.map((g) => (
            <FolderRow
              key={g.key}
              group={g}
              icon="📁"
              active={value === g.key}
              onPick={() => onChange(g.key)}
              onOpen={() => onOpenFolder(g.path)}
              onRemove={() => onRemoveFolder(g.path)}
            />
          ))
        )}
      </div>

      {disks.length > 0 && (
        <div className="space-y-3 border-t border-line px-1 pt-3">
          {disks.map((d) => (
            <DiskBar key={d.root} disk={d} used={perDrive.get(d.root.slice(0, 3).toLowerCase()) ?? 0} />
          ))}
        </div>
      )}
    </aside>
  );
}
