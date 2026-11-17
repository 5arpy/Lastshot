import { useEffect, useRef, useState } from "react";
import { lastshot } from "../lib/bridge";
import type { BarState, DrawCommand } from "../lib/types";
import { timeLeftText } from "../lib/recordOptions";
import { useCountdown } from "../lib/useCountdown";

/** "Pause (Alt+Shift+R)", or just "Pause" without a key. */
const withKey = (label: string, key?: string | null) => (key ? `${label} (${key})` : label);

type DrawTool = Extract<DrawCommand, { kind: "tool" }>["tool"];
const DRAW_TOOLS: { id: DrawTool; label: string; icon: string }[] = [
  { id: "pen", label: "Pen", icon: "M3 13c2-1 3-5 5-6s3 2 5 0" },
  { id: "marker", label: "Highlighter", icon: "M3 12h10M4 9l5-5 3 3-5 5H4z" },
  { id: "arrow", label: "Arrow", icon: "M3 13L13 3M7 3h6v6" },
  { id: "box", label: "Box", icon: "M3 4h10v8H3z" },
];
const DRAW_COLORS = ["#ff4d4f", "#ffc53d", "#52c41a", "#4096ff", "#ffffff"];

/** mm:ss, or h:mm:ss past an hour. */
export function clockTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

function Btn({
  title,
  onClick,
  children,
  tone = "plain",
  disabled,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
  tone?: "plain" | "red" | "on";
  disabled?: boolean;
}) {
  const tones = {
    plain: "text-white/85 hover:bg-white/10",
    red: "bg-red-500/90 text-white hover:bg-red-500",
    on: "bg-white/15 text-white",
  };
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-8 min-w-8 items-center justify-center gap-1.5 rounded-md px-2 text-[12px] font-medium transition-colors disabled:opacity-40 ${tones[tone]}`}
    >
      {children}
    </button>
  );
}

const ICON = "h-4 w-4 fill-none stroke-current";

/** 12.3 MB / 1.24 GB */
function sizeText(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  return `${(bytes / 1e6).toFixed(bytes >= 1e8 ? 0 : 1)} MB`;
}

/**
 * The small always-on-top bar shown while recording (or always, if chosen in
 * Settings). Windows leaves it out of every capture, so it never appears in
 * recordings, replays or screenshots.
 */
export default function ControlBar() {
  const [state, setState] = useState<BarState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Discard asks once: the first click arms it for a few seconds.
  const [armed, setArmed] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [compact, setCompact] = useState(false);
  const [draw, setDraw] = useState<{ tool: DrawTool; color: string }>({ tool: "pen", color: DRAW_COLORS[0] });
  // Drawing layer lets the mouse through (drawings stay on screen).
  const [passthrough, setPassthrough] = useState(false);
  // Local clock between backend updates: seconds at `at`.
  const base = useRef({ seconds: 0, at: Date.now() });
  const [, tick] = useState(0);

  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "rgb(24 26 32)";
    const apply = (s: BarState) => {
      setState(s);
      base.current = { seconds: s.recording?.seconds ?? 0, at: Date.now() };
    };
    void lastshot.getBarState().then(apply).catch(() => undefined);
    const off = lastshot.onRecording(apply);
    // Re-sync now and then: the backend count is the truth.
    const sync = setInterval(() => void lastshot.getBarState().then(apply).catch(() => undefined), 3000);
    const t = setInterval(() => tick((n) => n + 1), 250);
    return () => {
      void off.then((f) => f());
      clearInterval(sync);
      clearInterval(t);
    };
  }, []);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(String(e));
      setTimeout(() => setError(null), 4000);
    } finally {
      setBusy(false);
    }
  };

  const rec = state?.recording ?? null;
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3500);
    return () => clearTimeout(t);
  }, [armed]);
  useEffect(() => {
    if (!rec) setArmed(false);
  }, [rec]);

  const mark = () =>
    void run(async () => {
      const n = await lastshot.addMarker();
      setFlash(`Marked (${n})`);
      setTimeout(() => setFlash(null), 1200);
    });
  const sinceUpdate = rec && !rec.paused ? (Date.now() - base.current.at) / 1000 : 0;
  const seconds = base.current.seconds + sinceUpdate;
  const secondsLeft = rec?.seconds_left != null ? Math.max(0, rec.seconds_left - sinceUpdate) : null;
  const countdown = useCountdown(rec ? null : state?.countdown);
  const cancelCountdown = () => void run(() => lastshot.cancelRecordCountdown());

  const drawing = !!state?.drawing;
  useEffect(() => {
    if (!drawing) setPassthrough(false);
  }, [drawing]);
  const pickDraw = (next: { tool: DrawTool; color: string }) => {
    setDraw(next);
    void lastshot.sendDraw({ kind: "tool", ...next });
    if (passthrough) {
      setPassthrough(false);
      void lastshot.setDrawingPassthrough(false);
    }
  };
  const startDrawing = () =>
    void run(async () => {
      await lastshot.setDrawing(true);
      // The layer needs a moment to load before it hears the tool.
      setTimeout(() => void lastshot.sendDraw({ kind: "tool", ...draw }), 700);
    });
  const toggleCompact = (on: boolean) => {
    setCompact(on);
    void lastshot.setBarCompact(on);
  };

  if (compact) {
    return (
      <div
        data-tauri-drag-region
        className="flex h-screen w-screen select-none items-center gap-1 overflow-hidden bg-[rgb(24,26,32)] px-1.5 text-white"
      >
        <span data-tauri-drag-region className="cursor-grab px-0.5 text-white/35" title="Drag to move">
          ⋮⋮
        </span>
        <span data-tauri-drag-region className="flex min-w-0 flex-1 items-center gap-1.5 font-mono text-[13px] tabular-nums">
          {rec ? (
            <>
              <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${rec.paused ? "bg-amber-400" : "animate-pulse bg-red-500"}`} />
              {clockTime(seconds)}
              {rec.notice && (
                <span className="font-sans font-bold text-amber-300" title={rec.notice}>
                  !
                </span>
              )}
            </>
          ) : countdown != null ? (
            <span className="font-sans text-[12px] text-white/85" title="Recording starts in…">
              In <span className="font-mono font-semibold">{countdown}</span>…
            </span>
          ) : state?.finishing != null ? (
            <span className="font-sans text-[11px] text-white/70">Saving…</span>
          ) : (
            <span className="font-sans text-[11px] text-white/60">Lastshot</span>
          )}
        </span>
        {countdown != null && !rec && (
          <Btn title="Cancel the countdown (the recording does not start)" onClick={cancelCountdown}>
            <svg viewBox="0 0 16 16" className={ICON} strokeWidth="1.5">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </Btn>
        )}
        <Btn title="Show the whole bar" onClick={() => toggleCompact(false)}>
          <svg viewBox="0 0 16 16" className={ICON} strokeWidth="1.5">
            <path d="M3 6l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Btn>
      </div>
    );
  }

  return (
    <div
      data-tauri-drag-region
      className="flex h-screen w-screen select-none items-center gap-1 overflow-hidden bg-[rgb(24,26,32)] px-1.5 text-white"
    >
      <span data-tauri-drag-region className="cursor-grab px-1 text-white/35" title="Drag to move">
        ⋮⋮
      </span>

      {error ? (
        <span className="min-w-0 flex-1 truncate text-[11px] text-amber-300" title={error}>
          {error}
        </span>
      ) : state?.finishing != null ? (
        <span className="flex min-w-0 flex-1 items-center gap-2 text-[12px] text-white/85">
          <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-[#6b80e4]" />
          {state.finishingLabel ?? "Saving the recording"}…
          {state.finishingLabel?.startsWith("Cutting") && ` ${Math.round(state.finishing * 100)}%`}
        </span>
      ) : countdown != null && !rec ? (
        <>
          <span data-tauri-drag-region className="flex items-center gap-2 text-[13px] font-medium">
            <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-red-500" />
            Recording in
            <span className="min-w-[1.2em] font-mono text-[17px] font-semibold tabular-nums" aria-live="polite">
              {countdown}
            </span>
          </span>
          <Btn title="Cancel the countdown (the recording does not start)" tone="red" onClick={cancelCountdown} disabled={busy}>
            Cancel
          </Btn>
        </>
      ) : rec && drawing ? (
        <>
          <span data-tauri-drag-region className="flex items-center gap-1.5 font-mono text-[12px] tabular-nums text-white/80">
            <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
            {clockTime(seconds)}
          </span>
          <span className="mx-0.5 h-6 w-px bg-white/15" />
          {DRAW_TOOLS.map((t) => (
            <Btn
              key={t.id}
              title={t.label}
              tone={!passthrough && draw.tool === t.id ? "on" : "plain"}
              onClick={() => pickDraw({ ...draw, tool: t.id })}
            >
              <svg viewBox="0 0 16 16" className={ICON} strokeWidth="1.5">
                <path d={t.icon} strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </Btn>
          ))}
          {DRAW_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              title="Colour"
              onClick={() => pickDraw({ ...draw, color: c })}
              className={`mx-0.5 h-4 w-4 shrink-0 rounded-full border-2 ${draw.color === c ? "border-white" : "border-white/20"}`}
              style={{ background: c }}
            />
          ))}
          <span className="mx-0.5 h-6 w-px bg-white/15" />
          <Btn title="Undo the last drawing (or right-click)" onClick={() => void lastshot.sendDraw({ kind: "undo" })}>
            <svg viewBox="0 0 16 16" className={ICON} strokeWidth="1.5">
              <path d="M5 4L2 7l3 3M2 7h7a4 4 0 0 1 0 8H7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Btn>
          <Btn title="Erase all drawings" onClick={() => void lastshot.sendDraw({ kind: "clear" })}>
            Clear
          </Btn>
          <Btn
            title={passthrough ? "Draw again" : "Keep the drawings but use the mouse normally"}
            tone={passthrough ? "on" : "plain"}
            onClick={() => {
              const next = !passthrough;
              setPassthrough(next);
              void run(() => lastshot.setDrawingPassthrough(next));
            }}
          >
            <svg viewBox="0 0 16 16" className={ICON} strokeWidth="1.5">
              <path d="M4 2l8 6-3.5.8L11 13l-1.5.7-2.4-4.3L4 12z" strokeLinejoin="round" />
            </svg>
            {passthrough ? "Using PC" : "Use PC"}
          </Btn>
          <Btn title="Stop drawing and erase the drawings" tone="red" onClick={() => void run(() => lastshot.setDrawing(false))}>
            Done
          </Btn>
        </>
      ) : rec ? (
        <>
          <span data-tauri-drag-region className="flex min-w-[78px] items-center gap-1.5 font-mono text-[13px] tabular-nums">
            <span className={`h-2.5 w-2.5 rounded-full ${rec.paused ? "bg-amber-400" : "animate-pulse bg-red-500"}`} />
            {clockTime(seconds)}
          </span>
          <span data-tauri-drag-region className="flex min-w-0 max-w-[118px] flex-col leading-tight text-[10px] text-white/50">
            {rec.notice ? (
              <span data-tauri-drag-region className="truncate font-medium text-amber-300" title={rec.notice} role="status">
                ⚠ {rec.notice}
              </span>
            ) : (
              <span data-tauri-drag-region className="truncate" title={state?.area ? "Recording only this area" : "Recording the whole screen"}>
                {state?.area ?? "Full screen"}
              </span>
            )}
            <span
              data-tauri-drag-region
              className={`truncate ${secondsLeft != null && secondsLeft < 60 ? "text-amber-300" : ""}`}
              title={`File size so far: ${sizeText(rec.bytes ?? state?.bytes ?? 0)}${secondsLeft != null ? `. Stops by itself in about ${timeLeftText(secondsLeft).replace(/ left$/, "")}.` : ""}`}
            >
              {secondsLeft != null ? timeLeftText(secondsLeft) : sizeText(rec.bytes ?? state?.bytes ?? 0)}
            </span>
          </span>
          <Btn
            title={withKey(rec.paused ? "Resume" : "Pause", state?.hotkeyPause)}
            onClick={() => void run(() => lastshot.pauseRecording(!rec.paused))}
            disabled={busy}
          >
            {rec.paused ? (
              <svg viewBox="0 0 16 16" className="h-4 w-4 fill-current"><path d="M5 3.5v9l7-4.5z" /></svg>
            ) : (
              <svg viewBox="0 0 16 16" className="h-4 w-4 fill-current"><path d="M4.5 3h2.5v10H4.5zM9 3h2.5v10H9z" /></svg>
            )}
          </Btn>
          <Btn title="Mark this moment (it shows on the editor timeline)" onClick={mark} disabled={busy}>
            <svg viewBox="0 0 16 16" className={ICON} strokeWidth="1.5">
              <path d="M4 14V2.5M4 3h8l-2 3 2 3H4" strokeLinejoin="round" />
            </svg>
            {flash ?? (state?.markers ? state.markers : null)}
          </Btn>
          <Btn title="Draw on the screen (the drawings are in the recording)" onClick={startDrawing} disabled={busy}>
            <svg viewBox="0 0 16 16" className={ICON} strokeWidth="1.5">
              <path d="M10.5 2.5l3 3L6 13H3v-3z M9 4l3 3" strokeLinejoin="round" />
            </svg>
          </Btn>
          <Btn
            title={withKey("Stop and save", state?.hotkeyRecord)}
            tone="red"
            onClick={() => void run(() => lastshot.stopRecording())}
            disabled={busy}
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-current"><rect x="3" y="3" width="10" height="10" rx="1.5" /></svg>
            Stop
          </Btn>
          <Btn
            title={armed ? "Click again to delete this recording" : "Stop and delete (asks first)"}
            tone={armed ? "red" : "plain"}
            onClick={() => (armed ? void run(() => lastshot.discardRecording()) : setArmed(true))}
            disabled={busy}
          >
            <svg viewBox="0 0 16 16" className={ICON} strokeWidth="1.5">
              <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {armed && "Delete?"}
          </Btn>
        </>
      ) : (
        <>
          <Btn
            title={withKey("Record the screen", state?.hotkeyRecord)}
            onClick={() => void run(() => lastshot.startRecording())}
            disabled={busy}
          >
            <span className="h-2.5 w-2.5 rounded-full bg-red-500" />
            Record
          </Btn>
          <Btn title="Pick an area or window, then record only that" onClick={() => void run(() => lastshot.startSnip("rec"))} disabled={busy}>
            <svg viewBox="0 0 16 16" className={ICON} strokeWidth="1.5">
              <path d="M2 5V3a1 1 0 0 1 1-1h2M11 2h2a1 1 0 0 1 1 1v2M14 11v2a1 1 0 0 1-1 1h-2M5 14H3a1 1 0 0 1-1-1v-2" strokeLinecap="round" />
              <circle cx="8" cy="8" r="2.2" className="fill-red-500 stroke-none" />
            </svg>
            Area
          </Btn>
          <Btn
            title={withKey("Save the last moments", state?.hotkeySave)}
            onClick={() => void run(() => lastshot.saveInstantReplay(undefined, "bar"))}
            disabled={busy || !state?.replayOn}
          >
            Save replay
          </Btn>
        </>
      )}

      <span data-tauri-drag-region className="flex-1 self-stretch" />

      {!drawing && state?.micOn && (
        <Btn
          title={state.micMuted ? "Unmute microphone" : "Mute microphone"}
          tone={state.micMuted ? "on" : "plain"}
          onClick={() => void run(() => lastshot.setMicMuted(!state.micMuted))}
        >
          <svg viewBox="0 0 16 16" className={ICON} strokeWidth="1.5">
            <rect x="5.5" y="2" width="5" height="8" rx="2.5" />
            <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.5" strokeLinecap="round" />
            {state.micMuted && <path d="M2.5 2.5l11 11" strokeLinecap="round" className="stroke-red-400" />}
          </svg>
        </Btn>
      )}
      {!drawing && (
        <>
          <Btn title={withKey("Screenshot", state?.hotkeySnip)} onClick={() => void run(() => lastshot.startSnip())}>
            <svg viewBox="0 0 16 16" className={ICON} strokeWidth="1.5">
              <path d="M2 5V3a1 1 0 0 1 1-1h2M11 2h2a1 1 0 0 1 1 1v2M14 11v2a1 1 0 0 1-1 1h-2M5 14H3a1 1 0 0 1-1-1v-2" strokeLinecap="round" />
            </svg>
          </Btn>
          <Btn title="Open Lastshot" onClick={() => void lastshot.showMainWindow()}>
            <svg viewBox="0 0 16 16" className={ICON} strokeWidth="1.5">
              <rect x="2" y="3" width="12" height="10" rx="1.5" />
              <path d="M2 6h12" />
            </svg>
          </Btn>
        </>
      )}
      <Btn title="Make the bar small (timer only)" onClick={() => toggleCompact(true)}>
        <svg viewBox="0 0 16 16" className={ICON} strokeWidth="1.5">
          <path d="M4 8h8" strokeLinecap="round" />
        </svg>
      </Btn>
      <Btn title="Close the bar (bring it back from Home or the tray icon)" onClick={() => void lastshot.hideBar()}>
        <svg viewBox="0 0 16 16" className={ICON} strokeWidth="1.5">
          <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
        </svg>
      </Btn>
    </div>
  );
}
