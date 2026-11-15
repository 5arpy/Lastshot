import { useEffect, useMemo, useRef, useState } from "react";
import type { EngineStats } from "../lib/types";
import { VENDOR_LABEL } from "../lib/types";
import { formatBytes, formatDuration } from "../lib/format";
import { cn } from "../utils/cn";
import { themeColor } from "../lib/theme";

/** "#rrggbb" -> "rgba(r, g, b, a)" for canvas gradients. */
function withAlpha(hex: string, a: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return `rgba(37, 99, 235, ${a})`;
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${a})`;
}

interface Props {
  stats: EngineStats;
  hotkey: string;
  busy?: boolean;
  eco?: { active: boolean; reason: "battery" | "ram" | "off" } | null;
  onToggle: () => void;
  onSave: () => void;
  onSelectDuration?: (seconds: number) => void;
  onOpenSettings?: () => void;
}

/** Pre-set instant replay durations commonly used in gaming */
const REPLAY_DURATIONS = [15, 30, 60, 120];

/** Minimalist sparkline showing per-frame hardware encode latency */
function LatencySparkline({ value }: { value: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const history = useRef<number[]>([]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    history.current.push(value);
    if (history.current.length > 60) history.current.shift();

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const data = history.current;
    const max = Math.max(2.5, ...data) * 1.2;

    ctx.beginPath();
    data.forEach((v, i) => {
      const x = (i / Math.max(data.length - 1, 1)) * w;
      const y = h - (v / max) * h;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    const accent = themeColor("--color-accent-fg", "#2563eb");
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, withAlpha(accent, 0.16));
    grad.addColorStop(1, withAlpha(accent, 0));
    ctx.fillStyle = grad;
    ctx.fill();
  }, [value]);

  return <canvas ref={ref} className="h-7 w-full" aria-label="Encode latency graph" />;
}

export default function BufferStatusCard({
  stats,
  hotkey,
  busy,
  eco,
  onToggle,
  onSave,
  onSelectDuration,
  onOpenSettings,
}: Props) {
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const armed = stats.state === "buffering" || stats.state === "flushing";

  // Friendly plain-language recording state
  const statusConfig = useMemo(() => {
    if (stats.privacy_active) {
      return {
        badge: "Recording paused",
        tone: "text-warn border-amber-500/30 bg-amber-500/10",
        dot: "bg-amber-400",
        summary: "Privacy mode active — capture paused while desktop or browser is focused.",
        actionReady: false,
      };
    }
    switch (stats.state) {
      case "buffering":
        return {
          badge: "Recording buffer active",
          tone: "text-ok border-emerald-500/30 bg-emerald-500/10",
          dot: "bg-emerald-400",
          summary: "Continuously caching recent gameplay into memory. Press hotkey to save.",
          actionReady: true,
        };
      case "flushing":
        return {
          badge: "Saving clip to disk…",
          tone: "text-accent-fg border-blue-400/30 bg-blue-500/10",
          dot: "bg-blue-400 animate-rec",
          summary: "Packaging replay buffer into an MP4 video file in under 50 ms.",
          actionReady: false,
        };
      case "starting":
        return {
          badge: "Initializing recorder…",
          tone: "text-accent-fg border-blue-400/30 bg-blue-500/10",
          dot: "bg-blue-400 animate-rec",
          summary: "Connecting to D3D11 display duplication and spinning up hardware encoder.",
          actionReady: false,
        };
      case "recovering":
        return {
          badge: "Reconnecting capture…",
          tone: "text-warn border-amber-500/30 bg-amber-500/10",
          dot: "bg-amber-400 animate-rec",
          summary: "Display resolution changed or GPU reset. Re-establishing capture stream.",
          actionReady: false,
        };
      case "error":
        return {
          badge: "Recording unavailable",
          tone: "text-danger border-red-500/30 bg-red-500/10",
          dot: "bg-red-400",
          summary: stats.last_error ?? "Capture pipeline encountered an error. Check settings.",
          actionReady: false,
        };
      case "idle":
      default:
        return {
          badge: "Ready to record",
          tone: "text-ink-3 border-line bg-surface",
          dot: "bg-ink-4",
          summary: "Replay buffer is on standby. Arm the buffer to start capturing gameplay.",
          actionReady: false,
        };
    }
  }, [stats.state, stats.privacy_active, stats.last_error]);

  // Audio health status calculations
  const audioInfo = useMemo(() => {
    const rawErr = stats.audio_error?.toLowerCase() ?? "";
    const isMicError = rawErr.includes("microphone") || rawErr.includes("mic");
    const isSysError = rawErr.includes("loopback") || rawErr.includes("system") || rawErr.includes("render");
    const isGeneralErr = Boolean(stats.audio_error && !isMicError && !isSysError);

    const gameAudio = !stats.audio_system
      ? {
          status: "Disabled",
          tone: "text-ink-3 bg-surface-2 border-line",
          dot: "bg-ink-4",
          message: "Game audio capture is turned off in settings.",
          isError: false,
        }
      : stats.audio_error && (isSysError || isGeneralErr)
        ? {
            status: "Device unavailable",
            tone: "text-danger bg-red-500/10 border-red-500/30",
            dot: "bg-red-400",
            message: stats.audio_error,
            isError: true,
          }
        : armed
          ? {
              status: "Capturing game audio",
              tone: "text-ok bg-emerald-500/10 border-emerald-500/30",
              dot: "bg-emerald-400",
              message: "48 kHz stereo loopback recording cleanly.",
              isError: false,
            }
          : {
              status: "Ready on standby",
              tone: "text-ink-3 bg-surface-2 border-line",
              dot: "bg-emerald-500/70",
              message: "Will capture game audio once buffer is armed.",
              isError: false,
            };

    const microphone = !stats.audio_mic
      ? {
          status: "Disabled",
          tone: "text-ink-3 bg-surface-2 border-line",
          dot: "bg-ink-4",
          message: "Microphone recording is turned off in settings.",
          isError: false,
        }
      : stats.audio_error && (isMicError || isGeneralErr)
        ? {
            status: "Microphone unavailable",
            tone: "text-warn bg-amber-500/10 border-amber-500/30",
            dot: "bg-amber-400",
            message: stats.audio_error,
            isError: true,
          }
        : armed
          ? {
              status: "Microphone active",
              tone: "text-ok bg-emerald-500/10 border-emerald-500/30",
              dot: "bg-emerald-400",
              message: "Voice commentary mixed directly into clip.",
              isError: false,
            }
          : {
              status: "Ready on standby",
              tone: "text-ink-3 bg-surface-2 border-line",
              dot: "bg-emerald-500/70",
              message: "Will record voice once buffer is armed.",
              isError: false,
            };

    return { gameAudio, microphone };
  }, [stats.audio_system, stats.audio_mic, stats.audio_error, armed]);

  // Buffer fill fraction
  const fillPercent = useMemo(() => {
    if (!stats.buffer_seconds || stats.buffer_seconds <= 0) return 0;
    return Math.min(100, Math.round((stats.buffered_seconds / stats.buffer_seconds) * 100));
  }, [stats.buffered_seconds, stats.buffer_seconds]);

  return (
    <section className="panel rounded-xl p-5 space-y-5">
      {/* ------------------------------------------------ Top: Recording Status Banner */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
        <div className="flex items-start gap-3">
          <span className={cn("mt-1.5 h-3 w-3 shrink-0 rounded-full", statusConfig.dot)} />
          <div>
            <div className="flex flex-wrap items-center gap-2.5">
              <span className={cn("rounded-full border px-3 py-0.5 text-[12px] font-semibold tracking-wide", statusConfig.tone)}>
                {statusConfig.badge}
              </span>

              {eco?.active && (
                <span className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 font-mono text-[10px] text-warn">
                  ECO Mode ({eco.reason === "battery" ? "Battery" : "RAM saver"})
                </span>
              )}
            </div>

            <p className="mt-1 text-[13px] text-ink-3">
              {statusConfig.summary}
            </p>

            <div className="mt-1.5 flex flex-wrap items-center gap-2 font-mono text-[11px] text-ink-3">
              <span>{stats.width > 0 ? `${stats.width}×${stats.height}` : "1080p display"}</span>
              <span>·</span>
              <span>{stats.target_fps} FPS target</span>
              <span>·</span>
              <span>{stats.encoder.hardware ? stats.encoder.friendly_name : "Software Encoder"}</span>
              {stats.capture_fps > 0 && (
                <>
                  <span>·</span>
                  <span className="text-ink-3">{stats.capture_fps.toFixed(0)} FPS live</span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Arm / Disarm Buffer Toggle */}
        <button
          type="button"
          onClick={onToggle}
          disabled={busy}
          className={cn(
            "rounded-lg border px-4 py-2 font-medium text-[12px] transition-colors",
            armed
              ? "border-line-3 bg-surface-2 text-ink hover:border-red-500/50 hover:bg-red-500/10 hover:text-danger"
              : "border-accent/40 bg-accent/10 text-accent-fg hover:bg-accent/20 hover:border-accent",
            busy && "cursor-wait opacity-60",
          )}
        >
          {armed ? "Pause Buffer" : "Start Buffer"}
        </button>
      </div>

      {/* ------------------------------------------------ Center: Primary Action & Replay Duration */}
      <div className="grid gap-4 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] items-stretch">
        {/* Main CTA: Save Clip Button */}
        <div className="rounded-xl border border-line bg-surface p-4 flex flex-col justify-between gap-3">
          <div>
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold tracking-wider uppercase text-ink-3">
                Instant Replay
              </span>
              <span className="font-mono text-[11px] text-ink-3">
                Hotkey: <kbd className="rounded border border-line-3 bg-surface-2 px-1.5 py-0.5 font-semibold text-ink">{hotkey.toUpperCase()}</kbd>
              </span>
            </div>

            <p className="mt-1.5 text-[12px] leading-relaxed text-ink-3">
              Saves the last {stats.buffer_seconds} seconds of gameplay directly to an MP4 video file.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onSave}
              disabled={!statusConfig.actionReady || busy}
              className={cn(
                "flex-1 flex items-center justify-center gap-2.5 rounded-lg py-3 px-4 font-semibold text-[13px] transition-all",
                statusConfig.actionReady && !busy
                  ? "bg-accent text-white shadow-md hover:bg-accent-hover active:scale-[0.99] cursor-pointer"
                  : "bg-surface-2 text-ink-3 border border-line cursor-not-allowed",
              )}
            >
              {busy ? (
                <>
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-ink border-t-transparent" />
                  <span>Saving Clip…</span>
                </>
              ) : (
                <>
                  <svg viewBox="0 0 16 16" className="h-4 w-4 fill-current">
                    <path d="M3 2.5a.5.5 0 0 1 .5-.5h9a.5.5 0 0 1 .5.5v11a.5.5 0 0 1-.8.4L8 10.333l-4.2 3.567a.5.5 0 0 1-.8-.4v-11z" />
                  </svg>
                  <span>Save Last {stats.buffer_seconds} Seconds</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Replay Duration Selector */}
        <div className="rounded-xl border border-line bg-surface p-4 flex flex-col justify-between gap-3">
          <div>
            <div className="text-[11px] font-semibold tracking-wider uppercase text-ink-3">
              Replay Duration
            </div>
            <p className="mt-1 text-[12px] text-ink-3">
              Choose how much recent gameplay to keep in high-speed RAM.
            </p>
          </div>

          <div className="flex items-center gap-2">
            {REPLAY_DURATIONS.map((dur) => {
              const active = stats.buffer_seconds === dur;
              return (
                <button
                  key={dur}
                  type="button"
                  onClick={() => onSelectDuration?.(dur)}
                  disabled={busy}
                  className={cn(
                    "flex-1 rounded-lg border py-2 text-center font-mono text-[12px] font-semibold transition-all",
                    active
                      ? "border-accent bg-accent/15 text-accent-fg"
                      : "border-line bg-surface-2 text-ink-3 hover:border-line-3 hover:text-ink",
                  )}
                >
                  {dur >= 60 ? `${dur / 60}m` : `${dur}s`}
                </button>
              );
            })}
          </div>

          <div className="flex items-center justify-between font-mono text-[11px] text-ink-3">
            <span>Buffer capacity:</span>
            <span className="text-ink font-medium">
              {formatDuration(stats.buffered_seconds)} / {stats.buffer_seconds}s ({fillPercent}%)
            </span>
          </div>
        </div>
      </div>

      {/* ------------------------------------------------ Audio Health Cards (Split Game Audio & Mic) */}
      <div className="grid gap-3 sm:grid-cols-2">
        {/* Game Audio */}
        <div className="rounded-xl border border-line bg-surface p-3.5 flex items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-2 text-ink">
            <svg viewBox="0 0 16 16" className="h-4 w-4 fill-none stroke-current" strokeWidth="1.5">
              <path d="M2.5 6.5h2.5l3.5-3.5v10L5 9.5H2.5v-3z" />
              <path d="M11 5.5a3.5 3.5 0 0 1 0 5" strokeLinecap="round" />
            </svg>
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12px] font-semibold text-ink">Game Audio</span>
              <div className="flex items-center gap-1.5">
                <span className={cn("flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium", audioInfo.gameAudio.tone)}>
                  <span className={cn("h-1.5 w-1.5 rounded-full", audioInfo.gameAudio.dot)} />
                  {audioInfo.gameAudio.status}
                </span>
                {onOpenSettings && (audioInfo.gameAudio.isError || !stats.audio_system) && (
                  <button
                    type="button"
                    onClick={onOpenSettings}
                    className="text-[10px] font-medium text-accent-fg hover:underline cursor-pointer"
                  >
                    Setup →
                  </button>
                )}
              </div>
            </div>
            <p className="mt-1 text-[11px] text-ink-3 leading-normal truncate">
              {audioInfo.gameAudio.message}
            </p>
          </div>
        </div>

        {/* Microphone */}
        <div className="rounded-xl border border-line bg-surface p-3.5 flex items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-2 text-ink">
            <svg viewBox="0 0 16 16" className="h-4 w-4 fill-none stroke-current" strokeWidth="1.5">
              <rect x="5.5" y="2" width="5" height="8" rx="2.5" />
              <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.5M5.5 14.5h5" strokeLinecap="round" />
            </svg>
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12px] font-semibold text-ink">Microphone</span>
              <div className="flex items-center gap-1.5">
                <span className={cn("flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium", audioInfo.microphone.tone)}>
                  <span className={cn("h-1.5 w-1.5 rounded-full", audioInfo.microphone.dot)} />
                  {audioInfo.microphone.status}
                </span>
                {onOpenSettings && (audioInfo.microphone.isError || !stats.audio_mic) && (
                  <button
                    type="button"
                    onClick={onOpenSettings}
                    className="text-[10px] font-medium text-accent-fg hover:underline cursor-pointer"
                  >
                    Setup →
                  </button>
                )}
              </div>
            </div>
            <p className="mt-1 text-[11px] text-ink-3 leading-normal truncate">
              {audioInfo.microphone.message}
            </p>
          </div>
        </div>
      </div>

      {/* ------------------------------------------------ Expandable Technical Diagnostics */}
      <div className="rounded-lg border border-line/70 bg-surface-3 overflow-hidden">
        <button
          type="button"
          onClick={() => setShowDiagnostics((v) => !v)}
          className="w-full flex items-center justify-between px-3.5 py-2.5 text-left transition-colors hover:bg-surface-2"
        >
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-semibold tracking-wide text-ink-3">
              Technical Diagnostics & System Details
            </span>
            <span className="font-mono text-[10px] text-ink-3">
              ({stats.encode_ms_avg.toFixed(1)} ms latency · {formatBytes(stats.process_rss_bytes, 0)} RAM)
            </span>
          </div>

          <span className="font-mono text-[11px] text-ink-3">
            {showDiagnostics ? "Hide Details ▲" : "View Details ▼"}
          </span>
        </button>

        {showDiagnostics && (
          <div className="border-t border-line p-4 space-y-3.5 animate-fade">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 font-mono text-[11px]">
              <div className="rounded border border-line bg-surface p-2.5">
                <div className="text-[10px] text-ink-3 uppercase">Display Acquire</div>
                <div className="mt-1 font-semibold text-ink">
                  {stats.gpu_submit_ms_avg.toFixed(2)} ms
                </div>
                <div className="text-[10px] text-ink-3 mt-0.5">DXGI duplication latency</div>
              </div>

              <div className="rounded border border-line bg-surface p-2.5">
                <div className="text-[10px] text-ink-3 uppercase">Encoding Latency</div>
                <div className="mt-1 font-semibold text-accent-fg">
                  {stats.encode_ms_avg.toFixed(2)} ms / frame
                </div>
                <div className="text-[10px] text-ink-3 mt-0.5">{stats.encoder.codec} hardware MFT</div>
              </div>

              <div className="rounded border border-line bg-surface p-2.5">
                <div className="text-[10px] text-ink-3 uppercase">Memory Footprint</div>
                <div className="mt-1 font-semibold text-ink">
                  {formatBytes(stats.process_rss_bytes, 0)}
                </div>
                <div className="text-[10px] text-ink-3 mt-0.5">{formatBytes(stats.ring_bytes)} ring buffer</div>
              </div>

              <div className="rounded border border-line bg-surface p-2.5">
                <div className="text-[10px] text-ink-3 uppercase">Dropped Frames</div>
                <div className={cn("mt-1 font-semibold", stats.dropped_frames > 0 ? "text-warn" : "text-ink")}>
                  {stats.dropped_frames} frames
                </div>
                <div className="text-[10px] text-ink-3 mt-0.5">{stats.device_resets} device resets</div>
              </div>
            </div>

            {/* Hardware Encoder Info & Latency Sparkline */}
            <div className="rounded border border-line bg-surface p-3">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold text-ink">
                  {VENDOR_LABEL[stats.encoder.vendor]} · {stats.encoder.friendly_name}
                </span>
                <span className="font-mono text-[10px] text-ink-3">
                  {stats.encoder.adapter_name}
                </span>
              </div>
              <div className="mt-2">
                <LatencySparkline value={stats.encode_ms_avg} />
              </div>
            </div>

            {stats.last_error && (
              <div className="rounded border border-red-500/30 bg-red-500/10 p-2.5 font-mono text-[11px] text-danger">
                <span className="font-semibold text-danger">Last Engine Fault: </span>
                {stats.last_error}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
