import type { ReactNode } from "react";
import type { AppSettings, BarState, DiskInfo, EngineStats } from "../lib/types";
import { formatBytes } from "../lib/format";
import { cn } from "../utils/cn";
import { clockTime } from "./ControlBar";

interface Props {
  stats: EngineStats;
  settings: AppSettings;
  bar: BarState | null;
  busy?: boolean;
  eco?: { active: boolean; reason: "battery" | "ram" | "off" } | null;
  /** Space on the drive clips are saved to. */
  disk?: DiskInfo | null;
  /** Live seconds of the running recording (ticks locally). */
  recordingSeconds: number;
  onToggleReplay: () => void;
  onSaveReplay: () => void;
  onSelectDuration: (seconds: number) => void;
  onStartRecording: () => void;
  onStopRecording: () => void;
  onPauseRecording: (paused: boolean) => void;
  onScreenshot: () => void;
  onOpenSettings: (section: string) => void;
  onControlBar: (mode: AppSettings["controlBar"]) => void;
  onOpenClips: () => void;
}

const DURATIONS = [15, 30, 60, 120, 300];

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded-md border border-line-3 bg-surface-2 px-2 py-0.5 font-mono text-[12px] font-semibold text-ink shadow-[0_1px_0_var(--color-line-3)]">
      {children}
    </kbd>
  );
}

function ActionCard({
  title,
  hint,
  hotkey,
  children,
  tone = "plain",
}: {
  title: string;
  hint: string;
  hotkey: string;
  children: ReactNode;
  tone?: "plain" | "live";
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-xl border p-4",
        tone === "live" ? "border-red-500/40 bg-red-500/[0.06]" : "border-line bg-surface",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-[14px] font-semibold text-ink">{title}</h3>
          <p className="mt-0.5 text-[12px] leading-snug text-ink-3">{hint}</p>
        </div>
        <Kbd>{hotkey}</Kbd>
      </div>
      <div className="mt-auto space-y-2.5">{children}</div>
    </div>
  );
}

function SoundPill({
  icon,
  name,
  what,
  on,
  problem,
  onClick,
}: {
  icon: ReactNode;
  name: string;
  what: string;
  on: boolean;
  problem?: string | null;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={problem ?? `${name}: ${what}. Click to change.`}
      className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg border border-line bg-surface px-3 py-2 text-left transition-colors hover:border-accent/60"
    >
      <span className="text-ink-2">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-[12px] font-semibold text-ink">
          {name}
          <span
            className={cn(
              "rounded-full px-1.5 py-px text-[10px] font-medium",
              problem
                ? "bg-amber-500/15 text-warn"
                : on
                  ? "bg-emerald-500/15 text-ok"
                  : "bg-surface-3 text-ink-3",
            )}
          >
            {problem ? "Problem" : on ? "On" : "Off"}
          </span>
        </span>
        <span className="block truncate text-[11px] text-ink-3">{problem ?? what}</span>
      </span>
      <span className="text-[11px] text-ink-3">›</span>
    </button>
  );
}

/**
 * Home: the three things Lastshot does, each with its shortcut in plain
 * sight, plus what sound goes into clips.
 */
export default function HomeDashboard({
  stats,
  settings,
  bar,
  busy,
  eco,
  disk,
  recordingSeconds,
  onToggleReplay,
  onSaveReplay,
  onSelectDuration,
  onStartRecording,
  onStopRecording,
  onPauseRecording,
  onScreenshot,
  onOpenSettings,
  onControlBar,
  onOpenClips,
}: Props) {
  const on = stats.state === "buffering" || stats.state === "flushing";
  const starting = stats.state === "starting" || stats.state === "recovering";
  const rec = bar?.recording ?? null;
  const err = (stats.audio_error ?? "").toLowerCase();
  const micProblem = stats.audio_mic && /mic/.test(err) ? stats.audio_error : null;
  const pcProblem = stats.audio_system && stats.audio_error && !micProblem ? stats.audio_error : null;
  const lowDisk = disk && (disk.freeBytes < 5e9 || disk.freeBytes / disk.totalBytes < 0.05);

  const status = stats.privacy_active
    ? { dot: "bg-amber-400", text: "Instant replay is paused by privacy mode (no game in front)" }
    : stats.state === "error"
      ? { dot: "bg-red-400", text: stats.last_error ?? "Recording is unavailable" }
      : starting
        ? { dot: "bg-blue-400 animate-rec", text: "Starting…" }
        : on
          ? {
              dot: "bg-emerald-400",
              text: `Instant replay is on · always keeping the last ${
                stats.buffer_seconds >= 60 ? `${stats.buffer_seconds / 60} min` : `${stats.buffer_seconds} s`
              }`,
            }
          : { dot: "bg-ink-4", text: "Instant replay is off · nothing is being kept" };

  return (
    <section className="space-y-3">
      {/* Status line */}
      <div className="panel flex flex-wrap items-center justify-between gap-3 rounded-xl px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", status.dot)} />
          <span className="truncate text-[13px] font-medium text-ink">{status.text}</span>
          {on && stats.width > 0 && (
            <span className="hidden font-mono text-[11px] text-ink-3 md:inline">
              {stats.width}×{stats.height} · {stats.target_fps} fps
            </span>
          )}
          {eco?.active && (
            <span className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 font-mono text-[10px] text-warn">
              ECO ({eco.reason === "battery" ? "battery" : "low RAM"})
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onToggleReplay}
          disabled={busy || starting}
          title={`Shortcut: ${settings.hotkeyToggle}`}
          className={cn(
            "rounded-lg border px-3.5 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50",
            on
              ? "border-line-3 bg-surface-2 text-ink hover:border-red-500/50 hover:text-danger"
              : "border-accent bg-accent text-white hover:bg-accent-hover",
          )}
        >
          {on ? "Turn off" : "Turn on instant replay"}
        </button>
      </div>

      {/* The three actions */}
      <div className="grid gap-3 md:grid-cols-3">
        <ActionCard
          title="Save replay"
          hint="Something cool just happened? Save the last moments as a clip."
          hotkey={settings.hotkeySave}
        >
          <button
            type="button"
            onClick={onSaveReplay}
            disabled={!on || busy}
            className="w-full rounded-lg bg-accent px-3 py-2.5 text-[13px] font-semibold text-white shadow-sm transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-ink-3 disabled:shadow-none"
          >
            {busy ? "Saving…" : on ? `Save the last ${stats.buffer_seconds >= 60 ? `${stats.buffer_seconds / 60} min` : `${stats.buffer_seconds} s`}` : "Turn on instant replay first"}
          </button>
          <div className="flex items-center gap-1" role="group" aria-label="How much to keep">
            <span className="mr-1 text-[11px] text-ink-3">Keep</span>
            {DURATIONS.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => onSelectDuration(d)}
                className={cn(
                  "flex-1 rounded-md border py-1 font-mono text-[11px] transition-colors",
                  settings.bufferSeconds === d
                    ? "border-accent bg-accent/15 text-accent-fg"
                    : "border-line bg-surface-2 text-ink-3 hover:text-ink",
                )}
              >
                {d >= 60 ? `${d / 60}m` : `${d}s`}
              </button>
            ))}
            <button
              type="button"
              onClick={() => onOpenSettings("recording")}
              title="Type any length up to 60 minutes in Settings"
              className={cn(
                "flex-1 rounded-md border py-1 font-mono text-[11px] transition-colors",
                !DURATIONS.includes(settings.bufferSeconds)
                  ? "border-accent bg-accent/15 text-accent-fg"
                  : "border-line bg-surface-2 text-ink-3 hover:text-ink",
              )}
            >
              {DURATIONS.includes(settings.bufferSeconds)
                ? "…"
                : settings.bufferSeconds >= 60
                  ? `${Math.round(settings.bufferSeconds / 6) / 10}m`
                  : `${settings.bufferSeconds}s`}
            </button>
          </div>
        </ActionCard>

        <ActionCard
          title="Record screen"
          hint={rec ? "Recording. Press the shortcut again to stop." : "Records until you stop it. No time limit."}
          hotkey={settings.hotkeyRecord}
          tone={rec ? "live" : "plain"}
        >
          {rec ? (
            <div className="flex items-center gap-2">
              <span className="flex flex-1 items-center gap-2 font-mono text-[18px] font-semibold tabular-nums text-ink">
                <span className={cn("h-3 w-3 rounded-full", rec.paused ? "bg-amber-400" : "animate-pulse bg-red-500")} />
                {clockTime(recordingSeconds)}
                {rec.paused && <span className="text-[11px] font-medium text-warn">paused</span>}
              </span>
              <button
                type="button"
                onClick={() => onPauseRecording(!rec.paused)}
                className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-[12px] font-medium text-ink hover:border-line-3"
              >
                {rec.paused ? "Resume" : "Pause"}
              </button>
              <button
                type="button"
                onClick={onStopRecording}
                disabled={busy}
                className="rounded-lg bg-red-500 px-3 py-2 text-[12px] font-semibold text-white hover:bg-red-600 disabled:opacity-50"
              >
                Stop &amp; save
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={onStartRecording}
              disabled={busy || starting}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-red-500/50 bg-red-500/10 px-3 py-2.5 text-[13px] font-semibold text-danger transition-colors hover:bg-red-500/20 disabled:opacity-50"
            >
              <span className="h-2.5 w-2.5 rounded-full bg-red-500" />
              Start recording
            </button>
          )}
          <label className="flex items-center justify-between gap-2 text-[11px] text-ink-3" title="A small bar with a timer, pause, stop, mute and screenshot. It never shows up in your recordings.">
            <span>On-screen control bar</span>
            <select
              value={settings.controlBar}
              onChange={(e) => onControlBar(e.target.value as AppSettings["controlBar"])}
              className="rounded-md border border-line bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink outline-none focus:border-accent"
            >
              <option value="recording">While recording</option>
              <option value="always">Always</option>
              <option value="off">Off</option>
            </select>
          </label>
        </ActionCard>

        <ActionCard
          title="Screenshot"
          hint="Drag a box, click a window, or press F for the whole screen. Then draw on it and copy."
          hotkey={settings.hotkeySnip}
        >
          <button
            type="button"
            onClick={onScreenshot}
            className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-[13px] font-semibold text-ink transition-colors hover:border-accent"
          >
            Take a screenshot
          </button>
          <button
            type="button"
            onClick={() => onOpenSettings("snip")}
            className="w-full text-left text-[11px] text-ink-3 hover:text-ink"
          >
            Screenshots go to the clipboard{settings.snipSaveToFolder ? " and the Screenshots folder" : ""} ›
          </button>
        </ActionCard>
      </div>

      {/* What sound goes into clips */}
      <div className="flex flex-col gap-2 sm:flex-row">
        <SoundPill
          icon={
            <svg viewBox="0 0 16 16" className="h-4 w-4 fill-none stroke-current" strokeWidth="1.5">
              <path d="M2.5 6.5h2.5l3.5-3.5v10L5 9.5H2.5v-3z" />
              <path d="M11 5.5a3.5 3.5 0 0 1 0 5" strokeLinecap="round" />
            </svg>
          }
          name="PC sound"
          what="Everything you hear: game, Discord, music"
          on={settings.captureSystemAudio}
          problem={pcProblem}
          onClick={() => onOpenSettings("audio")}
        />
        <SoundPill
          icon={
            <svg viewBox="0 0 16 16" className="h-4 w-4 fill-none stroke-current" strokeWidth="1.5">
              <rect x="5.5" y="2" width="5" height="8" rx="2.5" />
              <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.5M5.5 14.5h5" strokeLinecap="round" />
            </svg>
          }
          name="Microphone"
          what={bar?.micMuted ? "Muted from the control bar" : "Your voice"}
          on={settings.captureMicrophone && !bar?.micMuted}
          problem={micProblem}
          onClick={() => onOpenSettings("audio")}
        />
      </div>

      {lowDisk && disk && (
        <button
          type="button"
          onClick={onOpenClips}
          className="w-full rounded-lg border border-amber-500/40 bg-amber-500/10 px-3.5 py-2 text-left text-[12px] text-warn"
        >
          Only {formatBytes(disk.freeBytes)} free on {disk.root}. Clips may fail to save. See what takes space in Clips ›
        </button>
      )}
    </section>
  );
}
