import { useEffect, useRef, useState } from "react";
import { lastshot } from "../lib/bridge";
import type { BarState } from "../lib/types";

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

/**
 * The small always-on-top bar shown while recording (or always, if chosen in
 * Settings). Windows leaves it out of every capture, so it never appears in
 * recordings, replays or screenshots.
 */
export default function ControlBar() {
  const [state, setState] = useState<BarState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
  const seconds =
    rec && !rec.paused ? base.current.seconds + (Date.now() - base.current.at) / 1000 : base.current.seconds;

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
      ) : rec ? (
        <>
          <span data-tauri-drag-region className="flex min-w-[78px] items-center gap-1.5 font-mono text-[13px] tabular-nums">
            <span className={`h-2.5 w-2.5 rounded-full ${rec.paused ? "bg-amber-400" : "animate-pulse bg-red-500"}`} />
            {clockTime(seconds)}
          </span>
          <Btn
            title={rec.paused ? "Resume" : "Pause"}
            onClick={() => void run(() => lastshot.pauseRecording(!rec.paused))}
            disabled={busy}
          >
            {rec.paused ? (
              <svg viewBox="0 0 16 16" className="h-4 w-4 fill-current"><path d="M5 3.5v9l7-4.5z" /></svg>
            ) : (
              <svg viewBox="0 0 16 16" className="h-4 w-4 fill-current"><path d="M4.5 3h2.5v10H4.5zM9 3h2.5v10H9z" /></svg>
            )}
          </Btn>
          <Btn
            title={`Stop and save (${state?.hotkeyRecord ?? ""})`}
            tone="red"
            onClick={() => void run(() => lastshot.stopRecording())}
            disabled={busy}
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-current"><rect x="3" y="3" width="10" height="10" rx="1.5" /></svg>
            Stop
          </Btn>
        </>
      ) : (
        <>
          <Btn
            title={`Record the screen (${state?.hotkeyRecord ?? ""})`}
            onClick={() => void run(() => lastshot.startRecording())}
            disabled={busy}
          >
            <span className="h-2.5 w-2.5 rounded-full bg-red-500" />
            Record
          </Btn>
          <Btn
            title={`Save the last moments (${state?.hotkeySave ?? ""})`}
            onClick={() => void run(() => lastshot.saveInstantReplay(undefined, "bar"))}
            disabled={busy || !state?.replayOn}
          >
            Save replay
          </Btn>
        </>
      )}

      <span data-tauri-drag-region className="flex-1 self-stretch" />

      {state?.micOn && (
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
      <Btn title={`Screenshot (${state?.hotkeySnip ?? ""})`} onClick={() => void run(() => lastshot.startSnip())}>
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
    </div>
  );
}
