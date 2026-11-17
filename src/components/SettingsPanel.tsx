import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { lastshot, type HotkeyStatus } from "../lib/bridge";
import type {
  AppSettings,
  AudioDevice,
  EngineStats,
  MonitorInfo,
  PowerState,
  SnipKeyAction,
  SnipKeys,
  UpdateProgress,
} from "../lib/types";
import { formatBytes } from "../lib/format";
import { isIntegratedAdapter } from "../lib/gpu";
import { cn } from "../utils/cn";
import { Choice, Row, Section, Toggle } from "./ui";
import AppAudioPicker from "./AppAudioPicker";
import ShortcutsSettings from "./ShortcutsSettings";
import { acceleratorFromEvent } from "../lib/accelerator";
import { screenshotsDir, shownPath } from "../lib/pathDisplay";
import { getTheme, onThemeChange, setTheme, type ThemeChoice } from "../lib/theme";

interface Props {
  settings: AppSettings;
  stats: EngineStats;
  monitors: MonitorInfo[];
  version: string;
  /** Live battery/RAM snapshot for the ECO telemetry row (null = not read yet). */
  power?: PowerState | null;
  onChange: (patch: Partial<AppSettings>) => void;
  onRestartEngine: () => void;
  onOpenFolder: () => void;
  onChooseFolder: () => void;
  /** Picks a folder to add to "Also show clips from". */
  onAddLibraryFolder: () => void;
  /** Folder picker; resolves to null when cancelled. */
  onPickFolder: (title: string) => Promise<string | null>;
  /** Opens a folder in Explorer. */
  onOpenPath: (path: string) => void;
  updateProgress?: UpdateProgress | null;
  onCheckForUpdates: () => void;
  onOpenScreenshots: () => void;
  native: boolean;
  /** Game profiles editor, shown in the Clips & storage advanced area. */
  profiles?: ReactNode;
  /** Live encoder / pipeline details, shown in the Instant replay advanced area. */
  diagnostics?: ReactNode;
}

const BUFFER_PRESETS = [15, 30, 60, 120, 300];
const FPS_PRESETS = [30, 60, 120, 144];
/** Discord: 10 MB free, 50 MB Nitro Basic, 500 MB Nitro (as of 2025). */
const SHARE_PRESETS = [8, 10, 25, 50, 100, 500];
const CLEANUP_PRESETS = [
  { days: 0, label: "Off" },
  { days: 7, label: "7 days" },
  { days: 14, label: "14 days" },
  { days: 30, label: "30 days" },
  { days: 60, label: "60 days" },
];

/** Click-to-record hotkey badge. */
function HotkeyRecorder({
  value,
  recording,
  onStart,
}: {
  value: string;
  recording: boolean;
  onStart: () => void;
}) {
  const ref = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!recording) return;
    ref.current?.focus();
  }, [recording]);
  return (
    <button
      ref={ref}
      type="button"
      onClick={onStart}
      disabled={recording}
      title="Click, then press the new key combination"
      className={cn(
        "relative rounded border px-3 py-1 font-mono text-[11px] font-semibold tracking-wide transition-colors",
        recording
          ? "border-accent bg-accent/20 text-accent-fg"
          : "border-line-3 bg-surface text-ink hover:border-accent/60 hover:bg-surface-2",
      )}
    >
      {recording ? (
        <>
          <span className="mr-1.5 inline-block h-1.5 w-1.5 animate-rec rounded-full bg-accent align-middle" />
          Press keys…
        </>
      ) : (
        value.toUpperCase()
      )}
    </button>
  );
}

/**
 * The extra screenshot shortcuts (none by default; one click takes the
 * suggested keys). They work from any app, like the main Screenshot key.
 */
const SNIP_KEY_ROWS: { action: SnipKeyAction; label: string; hint: string; suggest: string }[] = [
  { action: "draw", label: "Draw on screen", hint: "Pen, arrows and a spotlight over the live screen.", suggest: "Alt+Shift+D" },
  { action: "text", label: "Copy text from the screen", hint: "Drag a box over text; it is copied (Windows' own text recognition).", suggest: "Alt+Shift+T" },
  { action: "colour", label: "Pick a colour from the screen", hint: "Click a pixel; its colour is copied (HEX, RGB or HSL).", suggest: "Alt+Shift+I" },
  { action: "last", label: "Snip the last area again", hint: "Copies the same area at once, without the overlay.", suggest: "Alt+Shift+S" },
  { action: "window", label: "Snip the window in front", hint: "Copies the active window at once.", suggest: "Alt+Shift+W" },
];

function SnipKeyRows({
  keys,
  recording,
  onRecord,
  onSet,
  status,
  onRetry,
  error,
}: {
  keys: SnipKeys | undefined;
  recording: string | null;
  onRecord: (a: SnipKeyAction) => void;
  onSet: (a: SnipKeyAction, accel: string) => void;
  status: HotkeyStatus | null;
  onRetry: () => void;
  error: string | null;
}) {
  const [open, setOpen] = useState(() => !!keys && Object.values(keys).some(Boolean));
  const set = SNIP_KEY_ROWS.filter((r) => keys?.[r.action]).length;
  return (
    <>
      <Row label="More shortcuts" hint="Text, colour, Draw on screen, the last area or the window in front, straight from any app.">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="rounded border border-line bg-surface-2 px-2.5 py-1 text-[11px] text-ink-2 hover:text-ink"
          data-testid="snip-keys-toggle"
        >
          {open ? "Hide" : set ? `${set} set · show` : "Show"}
        </button>
      </Row>
      {open &&
        SNIP_KEY_ROWS.map((r) => {
          const v = keys?.[r.action] ?? "";
          const rec = recording === `snip-${r.action}`;
          return (
            <Row key={r.action} label={r.label} hint={r.hint}>
              <div className="flex flex-wrap items-center justify-end gap-1.5" data-testid={`snip-key-${r.action}`}>
                {v || rec ? (
                  <HotkeyRecorder value={v} recording={rec} onStart={() => onRecord(r.action)} />
                ) : (
                  <button
                    type="button"
                    onClick={() => onRecord(r.action)}
                    title="Click, then press the new key combination"
                    className="rounded border border-dashed border-line-3 px-3 py-1 text-[11px] text-ink-3 hover:border-accent/60 hover:text-ink"
                  >
                    Not set
                  </button>
                )}
                {!v && !rec && (
                  <button
                    type="button"
                    onClick={() => onSet(r.action, r.suggest)}
                    title={`Use ${r.suggest}`}
                    className="rounded border border-line bg-surface-2 px-2 py-1 font-mono text-[10.5px] text-ink-2 hover:text-ink"
                  >
                    Use {r.suggest}
                  </button>
                )}
                {v && (
                  <button type="button" onClick={() => onSet(r.action, "")} title="Remove this shortcut" className="rounded px-1.5 py-1 text-[11px] text-ink-3 hover:text-ink">
                    ✕
                  </button>
                )}
                <HotkeyBadge status={status} action={`snip-${r.action}`} onRetry={onRetry} />
              </div>
            </Row>
          );
        })}
      {open && error && <div className="px-1 pb-1 text-[11px] text-danger">{error}</div>}
    </>
  );
}

/** Red badge with "Try again" when a shortcut is not ours. */
function HotkeyBadge({ status, action, onRetry }: { status: HotkeyStatus | null; action: string; onRetry: () => void }) {
  const k = status?.keys.find((x) => x.action === action);
  if (!k || k.ok) return null;
  return (
    <span className="flex items-center gap-1.5" data-testid={`hotkey-bad-${action}`}>
      <span
        className="rounded-full bg-danger/15 px-2 py-0.5 text-[10px] font-semibold text-danger"
        title={`${k.accel} is being used by another app, so it does nothing in Lastshot. Pick other keys, or close that app and try again.`}
      >
        Not working
      </span>
      <button type="button" onClick={onRetry} className="rounded border border-line bg-surface-2 px-2 py-0.5 text-[10px] text-ink-2 hover:text-ink">
        Try again
      </button>
    </span>
  );
}

/** Longest instant replay, in seconds (60 min). Matches the backend clamp. */
const MAX_BUFFER_SECONDS = 3600;

function lengthLabel(s: number): string {
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m} min ${r} s` : `${m} min`;
}

/** Replay length: presets plus any number of seconds typed in. */
function BufferLengthInput({ value, onCommit }: { value: number; onCommit: (s: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Math.round(Number(draft.replace(",", ".")));
    if (Number.isFinite(n) && n >= 5) {
      const s = Math.min(MAX_BUFFER_SECONDS, n);
      setDraft(String(s));
      if (s !== value) onCommit(s);
    } else {
      setDraft(String(value));
    }
  };
  return (
    <div className="flex flex-col items-end gap-2">
      <Choice
        options={BUFFER_PRESETS.map((s) => ({ value: s, label: s >= 60 ? `${s / 60} min` : `${s} s` }))}
        value={value}
        onPick={onCommit}
      />
      <label className="flex items-center gap-1.5 text-[12px] text-ink-3">
        or
        <input
          type="number"
          inputMode="numeric"
          min={5}
          max={MAX_BUFFER_SECONDS}
          step={5}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          aria-label="Replay length in seconds"
          className="w-20 rounded border border-line bg-app px-2 py-1 text-right font-mono text-[12px] text-ink outline-none focus:border-accent"
        />
        seconds
      </label>
    </div>
  );
}

/** Size limit input: free number plus quick presets. */
function ShareSizeInput({ value, onCommit }: { value: number; onCommit: (mb: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Number(draft.replace(",", "."));
    if (Number.isFinite(n) && n >= 1 && n <= 2000) {
      onCommit(Math.round(n * 10) / 10);
    } else {
      setDraft(String(value));
    }
  };
  return (
    <div className="flex flex-col items-end gap-2">
      <label className="flex items-center gap-1.5 text-[12px] text-ink-3">
        <input
          type="number"
          inputMode="decimal"
          min={1}
          max={2000}
          step={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          aria-label="Share size limit in MB"
          className="w-20 rounded border border-line bg-app px-2 py-1 text-right font-mono text-[12px] text-ink outline-none focus:border-accent"
        />
        MB
      </label>
      <div className="flex flex-wrap justify-end gap-1">
        {SHARE_PRESETS.map((mb) => (
          <button
            key={mb}
            type="button"
            onClick={() => onCommit(mb)}
            className={cn(
              "rounded border px-2 py-0.5 font-mono text-[10px] transition-colors",
              value === mb
                ? "border-accent bg-accent text-white"
                : "border-line bg-surface-2 text-ink-3 hover:text-ink",
            )}
          >
            {mb}
          </button>
        ))}
      </div>
    </div>
  );
}

/** A folder setting: shows where, with Open / Change / Default. */
function FolderRow({
  label,
  hint,
  path,
  isDefault,
  onOpen,
  onChange,
  onReset,
}: {
  label: string;
  hint?: string;
  path: string;
  isDefault: boolean;
  onOpen: () => void;
  onChange: () => void;
  onReset: () => void;
}) {
  const btn =
    "rounded border border-line bg-surface-2 px-3 py-1 text-[11px] font-medium text-ink hover:border-accent";
  return (
    <Row
      label={label}
      hint={
        <>
          <span className="block truncate font-mono" title={shownPath(path)}>
            {shownPath(path)}
          </span>
          {hint && <span className="block">{hint}</span>}
        </>
      }
    >
      <div className="flex gap-2">
        <button type="button" onClick={onOpen} className={btn}>
          Open
        </button>
        <button type="button" onClick={onChange} className={btn}>
          Change
        </button>
        {!isDefault && (
          <button type="button" onClick={onReset} className={btn} title="Back to the default folder">
            Default
          </button>
        )}
      </div>
    </Row>
  );
}

export default function SettingsPanel({
  settings,
  stats,
  monitors,
  version,
  power,
  onChange,
  onRestartEngine,
  onOpenFolder,
  onChooseFolder,
  onAddLibraryFolder,
  onPickFolder,
  onOpenPath,
  updateProgress,
  onCheckForUpdates,
  onOpenScreenshots,
  native,
  profiles,
  diagnostics,
}: Props) {
  const [recording, setRecording] = useState<"save" | "toggle" | "snip" | "record" | `snip-${SnipKeyAction}` | null>(null);
  const [snipKeyErr, setSnipKeyErr] = useState<string | null>(null);
  const setSnipKey = (action: SnipKeyAction, accel: string) => {
    setSnipKeyErr(null);
    void lastshot.setSnipHotkey(action, accel).catch((e) => setSnipKeyErr(String(e)));
  };
  const [theme, setThemeState] = useState<ThemeChoice>(getTheme);
  useEffect(() => onThemeChange(setThemeState), []);
  const [hotkeyStatus, setHotkeyStatus] = useState<HotkeyStatus | null>(null);
  useEffect(() => {
    let off: (() => void) | undefined;
    let alive = true;
    void lastshot.getHotkeyStatus().then((st) => alive && setHotkeyStatus(st)).catch(() => undefined);
    void lastshot.onHotkeyStatus(setHotkeyStatus).then((u) => (alive ? (off = u) : u()));
    return () => {
      alive = false;
      off?.();
    };
  }, [settings.hotkeySave, settings.hotkeyToggle, settings.hotkeySnip, settings.hotkeyRecord]);
  const retryHotkeys = () => void lastshot.retryHotkeys().then(setHotkeyStatus).catch(() => undefined);
  const [bitrate, setBitrate] = useState(settings.bitrateKbps);
  const [audioDevices, setAudioDevices] = useState<AudioDevice[]>([]);
  const [scanningDevices, setScanningDevices] = useState(false);

  // Engine value wins while recording; before a start we infer from the active
  // monitor's adapter so the Game Mode copy is correct on an idle iGPU laptop.
  const integrated = useMemo(() => {
    if (stats.integrated_gpu) return true;
    const active =
      monitors.find((m) => m.index === settings.monitorIndex) ??
      monitors.find((m) => m.primary) ??
      monitors[0];
    return isIntegratedAdapter(active?.adapter);
  }, [stats.integrated_gpu, monitors, settings.monitorIndex]);

  useEffect(() => {
    setBitrate(settings.bitrateKbps);
  }, [settings.bitrateKbps]);

  const refreshAudioDevices = async () => {
    setScanningDevices(true);
    try {
      setAudioDevices(await lastshot.getAudioInputDevices());
    } catch {
      /* keep the last list */
    } finally {
      setScanningDevices(false);
    }
  };

  useEffect(() => {
    void refreshAudioDevices();
  }, []);

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const accel = acceleratorFromEvent(e);
      if (accel === "__cancel__") {
        setRecording(null);
        return;
      }
      if (!accel) return;
      if (recording.startsWith("snip-")) {
        setSnipKey(recording.slice(5) as SnipKeyAction, accel);
        setRecording(null);
        return;
      }
      const patch =
        recording === "save"
          ? { hotkeySave: accel }
          : recording === "toggle"
            ? { hotkeyToggle: accel }
            : recording === "record"
              ? { hotkeyRecord: accel }
              : { hotkeySnip: accel };
      onChange(patch);
      setRecording(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, onChange]);

  const projectedRam = ((settings.bufferSeconds * settings.bitrateKbps * 1000) / 8) * 1.6;
  // Game Mode caps the *effective* rate without destroying the saved
  // preference. Integrated GPUs share the die with the game and are capped harder.
  const integratedCap = integrated ? 30 : 60;
  const effectiveFps = settings.performanceMode
    ? Math.min(settings.targetFps, integratedCap)
    : settings.targetFps;

  const micName = settings.micDeviceId
    ? audioDevices.find((d) => d.id === settings.micDeviceId)?.name || "Selected device"
    : `Default (${audioDevices.find((d) => d.isDefault)?.name || "system default"})`;

  return (
    <div className="space-y-4">
      {/* ---------------------------------------------------------- Recording */}
      <Section
        id="recording"
        title="Instant replay"
        description="What gets kept in memory, ready to save with a hotkey."
        advanced={
          <>
            <Row label="Video codec" hint="HEVC is smaller at the same quality, but some apps and phones cannot play it.">
              <Choice
                options={[
                  { value: "h264" as const, label: "H.264" },
                  { value: "hevc" as const, label: "HEVC" },
                ]}
                value={settings.codec}
                onPick={(c) => onChange({ codec: c })}
              />
            </Row>
            <Row
              label={`Bitrate: ${(bitrate / 1000).toFixed(0)} Mbit/s`}
              hint={`Memory used by the buffer: about ${formatBytes(projectedRam)}.`}
            >
              <input
                type="range"
                className="cf-range w-44"
                min={3000}
                max={60000}
                step={1000}
                value={bitrate}
                onChange={(e) => setBitrate(Number(e.target.value))}
                onPointerUp={() => onChange({ bitrateKbps: bitrate })}
                onKeyUp={() => onChange({ bitrateKbps: bitrate })}
              />
            </Row>
            <Row
              label="Save power under pressure (ECO)"
              hint="Shortens the buffer on low battery or when RAM runs low."
            >
              <Toggle
                on={settings.adaptiveEco}
                onClick={() => onChange({ adaptiveEco: !settings.adaptiveEco })}
              />
            </Row>
            {settings.adaptiveEco && (
              <>
                <Row label={`Battery at or below ${settings.ecoBatteryThresholdPct}%`}>
                  <input
                    type="range"
                    className="cf-range w-44"
                    min={5}
                    max={100}
                    step={5}
                    value={settings.ecoBatteryThresholdPct}
                    onChange={(e) => onChange({ ecoBatteryThresholdPct: Number(e.target.value) })}
                  />
                </Row>
                <Row
                  label={`Free RAM below ${settings.ecoRamFreeGbs} GiB`}
                  hint={
                    power
                      ? `Now: ${formatBytes(power.availableRamBytes)} free of ${formatBytes(power.totalRamBytes)}${power.onBattery ? `, battery ${power.batteryPercent}%` : ", plugged in"}.`
                      : undefined
                  }
                >
                  <input
                    type="range"
                    className="cf-range w-44"
                    min={1}
                    max={16}
                    step={1}
                    value={settings.ecoRamFreeGbs}
                    onChange={(e) => onChange({ ecoRamFreeGbs: Number(e.target.value) })}
                  />
                </Row>
              </>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2 py-3">
              <span className="text-[11px] text-ink-3">
                Frame rate, codec and screen apply after a restart. Buffer length and bitrate change live.
              </span>
              <button
                type="button"
                onClick={onRestartEngine}
                className="rounded-lg border border-accent/50 bg-accent/15 px-3.5 py-1.5 text-[12px] font-semibold text-accent-fg transition-colors hover:bg-accent/25"
              >
                Apply &amp; restart recording
              </button>
            </div>
            {diagnostics && <div className="pb-3">{diagnostics}</div>}
          </>
        }
      >
        <Row
          label={`Keep the last ${lengthLabel(settings.bufferSeconds)}`}
          hint={
            <>
              Up to 60 minutes. It only uses memory (about {formatBytes(projectedRam)} now), nothing is written
              to disk until you save; then cut out what you need in the editor.
              {power && projectedRam > power.availableRamBytes * 0.8 && (
                <span className="mt-1 block text-warn">
                  That is more than the {formatBytes(power.availableRamBytes)} of RAM free right now. Lastshot keeps
                  as much as fits in half your RAM, so the replay may come out shorter. A lower bitrate (Advanced)
                  fits more.
                </span>
              )}
            </>
          }
        >
          <BufferLengthInput value={settings.bufferSeconds} onCommit={(s) => onChange({ bufferSeconds: s })} />
        </Row>
        <Row
          label="Game Mode"
          hint={
            integrated
              ? "Integrated GPU: records at up to 720p/30 so your game keeps its frames."
              : "Records at up to 1080p/60 with a light encoder setting so your game keeps its frames."
          }
        >
          <Toggle
            on={settings.performanceMode}
            onClick={() => onChange({ performanceMode: !settings.performanceMode })}
          />
        </Row>
        <Row
          label="Frame rate"
          hint={
            settings.performanceMode && settings.targetFps > effectiveFps
              ? `Game Mode caps this at ${effectiveFps} FPS right now. Your choice is kept for when Game Mode is off.`
              : "Smoother clips at 60 and up; 30 halves the work for your PC."
          }
        >
          <div className="flex items-center gap-2">
            <Choice
              options={FPS_PRESETS.map((f) => ({ value: f, label: `${f}` }))}
              value={settings.targetFps}
              onPick={(f) => onChange({ targetFps: f })}
            />
            {stats.target_fps > 0 && stats.target_fps !== effectiveFps && (
              <button
                type="button"
                onClick={onRestartEngine}
                title="The new frame rate starts after a restart"
                className="rounded border border-accent/50 bg-accent/15 px-2 py-1 text-[11px] font-semibold text-accent-fg hover:bg-accent/25"
              >
                Apply
              </button>
            )}
          </div>
        </Row>
        <Row label="Mouse pointer" hint="Show the mouse pointer in recordings and replays.">
          <Toggle
            on={settings.captureCursor !== false}
            onClick={() => onChange({ captureCursor: settings.captureCursor === false })}
          />
        </Row>
        {monitors.length > 1 && (
          <Row label="Screen" hint="Which monitor is recorded. Applies after a restart.">
            <select
              value={settings.monitorIndex}
              onChange={(e) => onChange({ monitorIndex: Number(e.target.value) })}
              className="max-w-[260px] rounded border border-line bg-app px-2.5 py-1.5 text-[11px] text-ink outline-none focus:border-accent"
            >
              {monitors.map((m) => (
                <option key={m.index} value={m.index} className="bg-app">
                  {m.name} ({m.width}×{m.height}){m.primary ? " — primary" : ""}
                </option>
              ))}
            </select>
          </Row>
        )}
        <Row label="Turn on instant replay when Lastshot opens">
          <Toggle
            on={settings.autostartBuffer}
            onClick={() => onChange({ autostartBuffer: !settings.autostartBuffer })}
          />
        </Row>
      </Section>

      {/* -------------------------------------------------------------- Audio */}
      <Section
        id="audio"
        title="Sound"
        description="What you hear in your clips and recordings."
      >
        <Row
          label="PC sound"
          hint="Everything your PC plays: the game, Discord, music, videos."
        >
          <Toggle
            on={settings.captureSystemAudio}
            onClick={() => onChange({ captureSystemAudio: !settings.captureSystemAudio })}
          />
        </Row>
        {settings.captureSystemAudio && (
          <Row
            label="Whose sound"
            hint="Only the game, or everything except a voice chat like Discord. Needs Windows 10 (2004) or newer."
          >
            <AppAudioPicker
              value={settings.appAudio}
              windowExe={settings.captureSource?.kind === "window" ? settings.captureSource.exe : undefined}
              onChange={(v) => onChange({ appAudio: v })}
              className="flex flex-wrap items-center justify-end gap-1.5 text-[12px]"
            />
          </Row>
        )}
        {settings.captureSystemAudio && (
          <Row label={`PC sound volume: ${settings.gameVolume}%`}>
            <input
              type="range"
              className="cf-range w-44"
              min={0}
              max={100}
              step={5}
              value={settings.gameVolume}
              onChange={(e) => onChange({ gameVolume: Number(e.target.value) })}
            />
          </Row>
        )}
        <Row
          label="Microphone"
          hint="Your voice. You can mute it any time from the on-screen control bar."
        >
          <Toggle
            on={settings.captureMicrophone}
            onClick={() => onChange({ captureMicrophone: !settings.captureMicrophone })}
          />
        </Row>
        {settings.captureMicrophone && (
          <>
            <Row label="Which microphone" hint={`In use: ${micName}${stats.audio_mic ? " (active)" : ""}`}>
              <div className="flex items-center gap-2">
                <select
                  className="max-w-[220px] truncate rounded border border-line bg-app px-2.5 py-1.5 text-[11px] text-ink focus:border-accent focus:outline-none"
                  value={settings.micDeviceId || "default"}
                  onChange={(e) => {
                    const val = e.target.value;
                    onChange({ micDeviceId: val === "default" ? null : val });
                  }}
                >
                  <option value="default">Default</option>
                  {audioDevices.map((dev) => (
                    <option key={dev.id} value={dev.id}>
                      {dev.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => void refreshAudioDevices()}
                  title="Look for microphones again"
                  disabled={scanningDevices}
                  className="rounded border border-line bg-surface-2 px-2 py-1 text-[11px] text-ink-3 hover:text-ink disabled:opacity-50"
                >
                  {scanningDevices ? "…" : "Rescan"}
                </button>
              </div>
            </Row>
            <Row
              label={`Microphone volume: ${settings.micVolume}%`}
              hint="No mic sound? Windows Settings › Privacy & security › Microphone must allow desktop apps."
            >
              <input
                type="range"
                className="cf-range w-44"
                min={0}
                max={100}
                step={5}
                value={settings.micVolume}
                onChange={(e) => onChange({ micVolume: Number(e.target.value) })}
              />
            </Row>
            <Row label="Clean up my voice" hint="Turns down background noise between words, cuts rumble and evens out loud and quiet speech.">
              <Toggle on={!!settings.cleanVoice} onClick={() => onChange({ cleanVoice: !settings.cleanVoice })} />
            </Row>
          </>
        )}
      </Section>

      {/* ---------------------------------------------------------- Shortcuts */}
      <Section
        id="hotkeys"
        title="Shortcuts"
        description="These work everywhere, also inside full-screen games. Click one, then press the new keys."
      >
        <Row label="Save replay">
          <div className="flex items-center gap-2">
            <HotkeyRecorder
              value={settings.hotkeySave}
              recording={recording === "save"}
              onStart={() => setRecording("save")}
            />
            <HotkeyBadge status={hotkeyStatus} action="save" onRetry={retryHotkeys} />
          </div>
        </Row>
        <Row label="Start / stop screen recording">
          <div className="flex items-center gap-2">
            <HotkeyRecorder
              value={settings.hotkeyRecord}
              recording={recording === "record"}
              onStart={() => setRecording("record")}
            />
            <HotkeyBadge status={hotkeyStatus} action="record" onRetry={retryHotkeys} />
          </div>
        </Row>
        <Row label="Take a screenshot">
          <div className="flex items-center gap-2">
            <HotkeyRecorder
              value={settings.hotkeySnip}
              recording={recording === "snip"}
              onStart={() => setRecording("snip")}
            />
            <HotkeyBadge status={hotkeyStatus} action="snip" onRetry={retryHotkeys} />
          </div>
        </Row>
        <Row label="Turn instant replay on / off">
          <div className="flex items-center gap-2">
            <HotkeyRecorder
              value={settings.hotkeyToggle}
              recording={recording === "toggle"}
              onStart={() => setRecording("toggle")}
            />
            <HotkeyBadge status={hotkeyStatus} action="toggle" onRetry={retryHotkeys} />
          </div>
        </Row>
      </Section>

      {/* --------------------------------------------------- Screen recording */}
      <Section
        id="screen"
        title="Screen recording"
        description="Records until you stop it. Uses the same quality as instant replay (frame rate here, bitrate under Instant replay › Advanced), and the same sound settings."
      >
        <Row label="Start / stop shortcut">
          <div className="flex items-center gap-2">
            <HotkeyRecorder
              value={settings.hotkeyRecord}
              recording={recording === "record"}
              onStart={() => setRecording("record")}
            />
            <HotkeyBadge status={hotkeyStatus} action="record" onRetry={retryHotkeys} />
          </div>
        </Row>
        <FolderRow
          label="Save recordings to"
          hint={settings.recordingDir ? "Recordings here still show up in Clips." : "The save location (same as replays)."}
          path={settings.recordingDir || settings.outputDir}
          isDefault={!settings.recordingDir}
          onOpen={() => onOpenPath(settings.recordingDir || settings.outputDir)}
          onChange={() =>
            void onPickFolder("Where should screen recordings go?").then(
              (d) => d && onChange({ recordingDir: d }),
            )
          }
          onReset={() => onChange({ recordingDir: "" })}
        />
        <Row
          label="On-screen control bar"
          hint="A small bar at the top of the screen with the timer, pause, stop, mute and screenshot. It never shows up in recordings, replays or screenshots."
        >
          <Choice
            options={[
              { value: "recording" as const, label: "While recording" },
              { value: "always" as const, label: "Always" },
              { value: "off" as const, label: "Off" },
            ]}
            value={settings.controlBar}
            onPick={(v) => onChange({ controlBar: v })}
          />
        </Row>
      </Section>

      {/* ------------------------------------------------------------ Sharing */}
      <Section
        id="sharing"
        title="Sharing"
        description="“Shrink & copy” makes a smaller copy of a clip and puts it on the clipboard, ready to paste into Discord or anywhere else."
      >
        <Row
          label="Size limit"
          hint="Discord allows 10 MB without Nitro, 50 MB with Nitro Basic and 500 MB with Nitro. If Discord changes that, just change this number."
        >
          <ShareSizeInput value={settings.shareSizeMb} onCommit={(mb) => onChange({ shareSizeMb: mb })} />
        </Row>
      </Section>

      {/* -------------------------------------------------------- Screenshots */}
      <Section id="snip" title="Screenshots" description="Drag a box, click a window, or press F for the whole screen. Then draw on it, and press Enter.">
        <Row label="Shortcut">
          <div className="flex items-center gap-2">
            <HotkeyRecorder
              value={settings.hotkeySnip}
              recording={recording === "snip"}
              onStart={() => setRecording("snip")}
            />
            <HotkeyBadge status={hotkeyStatus} action="snip" onRetry={retryHotkeys} />
          </div>
        </Row>
        <SnipKeyRows
          keys={settings.snipKeys}
          recording={recording}
          onRecord={(a) => setRecording(`snip-${a}`)}
          onSet={setSnipKey}
          status={hotkeyStatus}
          onRetry={retryHotkeys}
          error={snipKeyErr}
        />
        {monitors.length > 1 && (
        <Row
          label="Screens"
          hint={
            (settings.snipScope ?? "all") === "all"
              ? "Every monitor at once: a box can cross screens. F takes the screen under the mouse, Shift+F all of them."
              : (settings.snipScope ?? "") === "cursor"
                ? "Only the screen under the mouse."
                : "Always the same screen."
          }
        >
          <select
            className="max-w-[260px] rounded border border-line bg-app px-2.5 py-1.5 text-[11px] text-ink outline-none focus:border-accent"
            value={settings.snipScope ?? "all"}
            onChange={(e) => onChange({ snipScope: e.target.value })}
            aria-label="Screens a snip covers"
          >
            <option value="all">All screens at once</option>
            <option value="cursor">The screen under the mouse</option>
            {monitors.map((m) => (
              <option key={m.index} value={`monitor:${m.index}`} className="bg-app">
                {`${m.name} (${m.width}×${m.height})${m.primary ? " — primary" : ""}`}
              </option>
            ))}
          </select>
        </Row>
        )}
        <Row label="Copy to the clipboard" hint="Ready to paste with Ctrl+V.">
          <Toggle
            on={settings.screenshotCopy}
            onClick={() => onChange({ screenshotCopy: !settings.screenshotCopy })}
          />
        </Row>
        <Row
          label="Also save as a file"
          hint={settings.screenshotCopy ? "Ctrl+S in the screenshot tool always saves." : "On, because the clipboard is off."}
        >
          <Toggle
            on={settings.snipSaveToFolder || !settings.screenshotCopy}
            onClick={() => onChange({ snipSaveToFolder: !settings.snipSaveToFolder })}
          />
        </Row>
        <FolderRow
          label="Save screenshots to"
          path={screenshotsDir(settings)}
          isDefault={!settings.screenshotDir}
          onOpen={onOpenScreenshots}
          onChange={() =>
            void onPickFolder("Where should screenshots go?").then((d) => d && onChange({ screenshotDir: d }))
          }
          onReset={() => onChange({ screenshotDir: "" })}
        />
        <Row
          label="File format"
          hint={settings.screenshotFormat === "png" ? "PNG keeps every pixel." : "JPG files are much smaller. The clipboard copy is always full quality."}
        >
          <Choice
            options={[
              { value: "png" as const, label: "PNG" },
              { value: "jpg" as const, label: "JPG" },
            ]}
            value={settings.screenshotFormat}
            onPick={(f) => onChange({ screenshotFormat: f })}
          />
        </Row>
        {settings.screenshotFormat === "jpg" && (
          <Row label={`JPG quality: ${settings.screenshotQuality}`}>
            <input
              type="range"
              className="cf-range w-44"
              min={50}
              max={100}
              step={5}
              value={settings.screenshotQuality}
              onChange={(e) => onChange({ screenshotQuality: Number(e.target.value) })}
            />
          </Row>
        )}
      </Section>

      {/* ------------------------------------------------------ Clips/storage */}
      <Section
        id="storage"
        title="Clips & storage"
        advancedLabel="Advanced & game profiles"
        advanced={
          <>
            <Row label="Sort clips into a folder per game">
              <Toggle
                on={settings.organizeByGame}
                onClick={() => onChange({ organizeByGame: !settings.organizeByGame })}
              />
            </Row>
            <Row label="Save automatically when a game closes" hint="Keeps the last 30 seconds.">
              <Toggle
                on={settings.autosaveOnGameExit}
                onClick={() => onChange({ autosaveOnGameExit: !settings.autosaveOnGameExit })}
              />
            </Row>
            <Row
              label="Privacy mode"
              hint="Pauses recording and clears the buffer while a non-game window is in front."
            >
              <Toggle
                on={settings.privacyPauseWhenUnfocused}
                onClick={() => onChange({ privacyPauseWhenUnfocused: !settings.privacyPauseWhenUnfocused })}
              />
            </Row>
            <Row
              label="“Open with Lastshot” in Explorer"
              hint="Adds it to the right-click menu of MP4 files, so any video opens in the Lastshot editor. Nothing becomes the default player."
            >
              <Toggle
                on={settings.explorerOpenWith}
                onClick={() => onChange({ explorerOpenWith: !settings.explorerOpenWith })}
              />
            </Row>
            {profiles && <div className="py-3">{profiles}</div>}
          </>
        }
      >
        <Row label="Save location" hint={shownPath(settings.outputDir)}>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onOpenFolder}
              className="rounded border border-line bg-surface-2 px-3 py-1 text-[11px] font-medium text-ink hover:border-accent"
            >
              Open
            </button>
            <button
              type="button"
              onClick={onChooseFolder}
              className="rounded border border-line bg-surface-2 px-3 py-1 text-[11px] font-medium text-ink hover:border-accent"
            >
              Change
            </button>
          </div>
        </Row>
        <Row
          label="Also show clips from"
          hint="Videos in these folders appear in Clips, ready to edit and share. Edits are saved to the save location; auto-delete and Delete all never touch these folders."
        >
          <button
            type="button"
            onClick={onAddLibraryFolder}
            className="rounded border border-line bg-surface-2 px-3 py-1 text-[11px] font-medium text-ink hover:border-accent"
          >
            Add folder
          </button>
        </Row>
        {settings.libraryFolders.length > 0 && (
          <ul className="mb-2 space-y-1">
            {settings.libraryFolders.map((f) => (
              <li
                key={f}
                className="flex items-center justify-between gap-2 rounded-md border border-line bg-surface-2 px-2.5 py-1.5 text-[11px] text-ink-2"
              >
                <span className="truncate" title={shownPath(f)}>
                  📁 {shownPath(f)}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    onChange({ libraryFolders: settings.libraryFolders.filter((x) => x !== f) })
                  }
                  title="Stop showing clips from this folder (the files stay where they are)"
                  className="shrink-0 rounded px-1.5 text-ink-3 hover:text-danger"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <Row label="Delete old clips" hint="Runs when Lastshot starts. Only the save location; starred clips are never deleted.">
          <Choice
            options={CLEANUP_PRESETS.map((p) => ({ value: p.days, label: p.label }))}
            value={settings.autoCleanupDays}
            onPick={(d) => onChange({ autoCleanupDays: d })}
          />
        </Row>
        <Row label="Open the editor after saving a replay">
          <Toggle
            on={settings.openTrimmerAfterSave}
            onClick={() => onChange({ openTrimmerAfterSave: !settings.openTrimmerAfterSave })}
          />
        </Row>
        <Row label="Play a sound when a replay is saved">
          <Toggle
            on={settings.playSaveSound}
            onClick={() => onChange({ playSaveSound: !settings.playSaveSound })}
          />
        </Row>
      </Section>

      {/* ---------------------------------------------------------- Shortcuts */}
      <Section
        id="shortcuts"
        title="Shortcuts"
        description="Keys inside Lastshot's windows. Change, add or remove any of them; the global hotkeys are under Recording and Screenshots."
      >
        <ShortcutsSettings settings={settings} onChange={onChange} />
      </Section>

      {/* ---------------------------------------------------------------- App */}
      <Section
        id="app"
        title="App"
        advanced={
          <>
            <Row label="Keep the window on top">
              <Toggle on={settings.alwaysOnTop} onClick={() => onChange({ alwaysOnTop: !settings.alwaysOnTop })} />
            </Row>
            <Row
              label="Check for a new version at startup"
              hint="One request to github.com. Nothing about you is sent, and nothing installs by itself."
            >
              <Toggle
                on={settings.checkUpdatesOnStartup}
                onClick={() => onChange({ checkUpdatesOnStartup: !settings.checkUpdatesOnStartup })}
                label="Check for a new version at startup"
              />
            </Row>
            <Row label="Quit Lastshot" hint="Stops recording and removes the tray icon too.">
              <button
                type="button"
                onClick={() => void lastshot.quit()}
                className="rounded-lg border border-red-500/30 bg-red-500/10 px-3.5 py-1.5 text-[11px] font-medium text-danger hover:border-red-400 hover:bg-red-500/20"
              >
                Quit
              </button>
            </Row>
          </>
        }
      >
        <Row label="Theme">
          <div role="radiogroup" aria-label="Theme" className="flex rounded-lg border border-line bg-surface-2 p-0.5">
            {(["dark", "light", "system"] as ThemeChoice[]).map((t) => (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={theme === t}
                onClick={() => setTheme(t)}
                className={cn(
                  "rounded-md px-3 py-1 text-[12px] font-medium capitalize transition-colors",
                  theme === t ? "bg-accent text-white shadow-sm" : "text-ink-3 hover:bg-surface-4 hover:text-ink",
                )}
              >
                {t}
              </button>
            ))}
          </div>
        </Row>
        <Row label="Interface size" hint="Every Lastshot window, on every screen. Ctrl+Shift+=, Ctrl+Shift+- and Ctrl+Shift+0 change it too.">
          <Choice
            options={[0.8, 0.9, 1, 1.1, 1.25, 1.5].map((v) => ({ value: v, label: `${Math.round(v * 100)}%` }))}
            value={Math.round((settings.uiScale ?? 1) * 100) / 100}
            onPick={(v) => onChange({ uiScale: v })}
          />
        </Row>
        <Row
          label="Streamer mode"
          hint="Hides folder paths (they can show your Windows user name) while you stream or share your screen. Only folder names are shown."
        >
          <Toggle on={settings.streamerMode} onClick={() => onChange({ streamerMode: !settings.streamerMode })} />
        </Row>
        <Row label="Start with Windows" hint="Opens quietly in the tray when you sign in.">
          <Toggle on={settings.launchAtStartup} onClick={() => onChange({ launchAtStartup: !settings.launchAtStartup })} />
        </Row>
        <Row label="Closing the window keeps Lastshot in the tray">
          <Toggle on={settings.minimizeToTray} onClick={() => onChange({ minimizeToTray: !settings.minimizeToTray })} />
        </Row>
        <Row label={`Version ${version}${native ? "" : " (browser preview)"}`}>
          <button
            type="button"
            onClick={onCheckForUpdates}
            disabled={!!updateProgress}
            className="rounded-lg border border-accent/40 bg-accent/10 px-3.5 py-1.5 text-[12px] font-semibold text-accent-fg transition-colors hover:bg-accent/20 disabled:opacity-50"
          >
            {updateProgress ? "Checking…" : "Check for updates"}
          </button>
        </Row>
      </Section>
    </div>
  );
}
