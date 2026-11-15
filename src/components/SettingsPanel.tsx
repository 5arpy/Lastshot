import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { clipflow } from "../lib/bridge";
import type {
  AppSettings,
  AudioDevice,
  EngineStats,
  MonitorInfo,
  PowerState,
  UpdateProgress,
} from "../lib/types";
import { formatBytes } from "../lib/format";
import { isIntegratedAdapter } from "../lib/gpu";
import { cn } from "../utils/cn";
import { Choice, Row, Section, Toggle } from "./ui";
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

/**
 * Turns a raw keydown into a global-shortcut accelerator string, or null when
 * the combo is not a valid global hotkey (no modifier, or a modifier key alone).
 */
function acceleratorFromEvent(e: KeyboardEvent): string | null {
  if (e.key === "Escape") return "__cancel__";
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Win");

  const key = e.key;
  if (["Control", "Alt", "Shift", "Meta", "CapsLock", "Tab"].includes(key)) return null;

  let token: string | null = null;
  if (/^[a-z0-9]$/i.test(key)) token = key.toUpperCase();
  else if (/^F([1-9]|1[0-9]|2[0-4])$/i.test(key)) token = key.toUpperCase();
  else if (key === " ") token = "Space";
  else return null;

  if (mods.length === 0) return null;
  return [...mods, token].join("+");
}

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
  updateProgress,
  onCheckForUpdates,
  onOpenScreenshots,
  native,
  profiles,
  diagnostics,
}: Props) {
  const [recording, setRecording] = useState<"save" | "toggle" | "snip" | null>(null);
  const [theme, setThemeState] = useState<ThemeChoice>(getTheme);
  useEffect(() => onThemeChange(setThemeState), []);
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
      setAudioDevices(await clipflow.getAudioInputDevices());
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
      const patch =
        recording === "save"
          ? { hotkeySave: accel }
          : recording === "toggle"
            ? { hotkeyToggle: accel }
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
            <Row
              label="Frame rate"
              hint={
                settings.performanceMode && settings.targetFps > effectiveFps
                  ? `Game Mode caps this at ${effectiveFps} FPS right now. Your choice is kept for when Game Mode is off.`
                  : "30 FPS halves the encoder's work; clips still look sharp."
              }
            >
              <Choice
                options={FPS_PRESETS.map((f) => ({ value: f, label: `${f}` }))}
                value={settings.targetFps}
                onPick={(f) => onChange({ targetFps: f })}
              />
            </Row>
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
            <Row label="Monitor" hint="Which screen is recorded.">
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
                Frame rate, codec and monitor apply after a restart. Buffer length and bitrate change live.
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
        <Row label="Keep the last" hint="How much is always ready to save.">
          <Choice
            options={BUFFER_PRESETS.map((s) => ({ value: s, label: s >= 60 ? `${s / 60} min` : `${s} s` }))}
            value={settings.bufferSeconds}
            onPick={(s) => onChange({ bufferSeconds: s })}
          />
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
        <Row label="Start recording when Lastshot opens">
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
        advanced={
          <>
            {settings.captureSystemAudio && (
              <Row label={`Game sound volume: ${settings.gameVolume}%`}>
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
            {settings.captureMicrophone ? (
              <>
                <Row label="Microphone" hint={`In use: ${micName}${stats.audio_mic ? " (active)" : ""}`}>
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
              </>
            ) : (
              <p className="py-3 text-[12px] text-ink-3">Turn on the microphone to pick a device and volume.</p>
            )}
          </>
        }
      >
        <Row label="Record game and PC sound">
          <Toggle
            on={settings.captureSystemAudio}
            onClick={() => onChange({ captureSystemAudio: !settings.captureSystemAudio })}
          />
        </Row>
        <Row label="Record my microphone">
          <Toggle
            on={settings.captureMicrophone}
            onClick={() => onChange({ captureMicrophone: !settings.captureMicrophone })}
          />
        </Row>
      </Section>

      {/* ---------------------------------------------------------- Shortcuts */}
      <Section
        id="hotkeys"
        title="Shortcuts"
        description="These work everywhere, also inside full-screen games. Click one, then press the new keys."
      >
        <Row label="Save replay">
          <HotkeyRecorder
            value={settings.hotkeySave}
            recording={recording === "save"}
            onStart={() => setRecording("save")}
          />
        </Row>
        <Row label="Take a screenshot">
          <HotkeyRecorder
            value={settings.hotkeySnip}
            recording={recording === "snip"}
            onStart={() => setRecording("snip")}
          />
        </Row>
        <Row label="Start / pause recording">
          <HotkeyRecorder
            value={settings.hotkeyToggle}
            recording={recording === "toggle"}
            onStart={() => setRecording("toggle")}
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
      <Section id="snip" title="Screenshots" description="Drag a box, click a window, or press F for the whole screen.">
        <Row label="Also save screenshots to a folder" hint={`${settings.outputDir}\\Screenshots`}>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onOpenScreenshots}
              className="rounded border border-line bg-surface-2 px-3 py-1 text-[11px] font-medium text-ink hover:border-accent"
            >
              Open folder
            </button>
            <Toggle
              on={settings.snipSaveToFolder}
              onClick={() => onChange({ snipSaveToFolder: !settings.snipSaveToFolder })}
            />
          </div>
        </Row>
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
            {profiles && <div className="py-3">{profiles}</div>}
          </>
        }
      >
        <Row label="Save location" hint={settings.outputDir}>
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
        <Row label="Delete old clips" hint="Runs when Lastshot starts. Starred clips are never deleted.">
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
                onClick={() => void clipflow.quit()}
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
