import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import {
  audio,
  dbToPos,
  isVoicemeeterDevice,
  toDb,
  type AppOutputRule,
  type AudioApp,
  type RenderDevice,
  type VmLevels,
  type VmStatus,
} from "../lib/audio";
import { lastshot } from "../lib/bridge";
import { cn } from "../utils/cn";

/**
 * Audio: a simple remote for Voicemeeter (faders, mutes, meters, which
 * outputs each input goes to) and "send this app to that output".
 * Voicemeeter does the mixing; Lastshot only reads and sets its controls.
 */

type Toast = (tone: "ok" | "err" | "warn" | "info", title: string, body?: string) => void;

const GAIN_MIN = -60;
const GAIN_MAX = 12;

/** True while this window is shown (not hidden to the tray, not minimised). */
function useWindowShown(): boolean {
  const [shown, setShown] = useState(true);
  useEffect(() => {
    let alive = true;
    const check = async () => {
      if (document.visibilityState !== "visible") return alive && setShown(false);
      const w = window.__TAURI__?.window?.getCurrentWindow() as
        | { isVisible?: () => Promise<boolean>; isMinimized?: () => Promise<boolean> }
        | undefined;
      try {
        const vis = w?.isVisible ? await w.isVisible() : true;
        const min = w?.isMinimized ? await w.isMinimized() : false;
        if (alive) setShown(vis && !min);
      } catch {
        if (alive) setShown(true);
      }
    };
    void check();
    const t = window.setInterval(() => void check(), 1000);
    document.addEventListener("visibilitychange", check);
    return () => {
      alive = false;
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", check);
    };
  }, []);
  return shown;
}

/** Sends at most one value per parameter every 50 ms; the last one always goes. */
function useThrottledSet(onError: (e: unknown) => void) {
  const pending = useRef(new Map<string, number | boolean | string>());
  const timer = useRef<number | null>(null);
  const flush = useCallback(() => {
    timer.current = null;
    const batch = [...pending.current.entries()];
    pending.current.clear();
    for (const [p, v] of batch) audio.vmSet(p, v).catch(onError);
  }, [onError]);
  return useCallback(
    (param: string, value: number | boolean | string) => {
      pending.current.set(param, value);
      if (timer.current == null) timer.current = window.setTimeout(flush, 50);
    },
    [flush],
  );
}

export default function AudioPanel({ active = true, onToast }: { active?: boolean; onToast: Toast }) {
  const [status, setStatus] = useState<VmStatus | null>(null);
  const [levels, setLevels] = useState<VmLevels | null>(null);
  const [apps, setApps] = useState<AudioApp[]>([]);
  const [devices, setDevices] = useState<RenderDevice[]>([]);
  const [rules, setRules] = useState<AppOutputRule[]>([]);
  const [starting, setStarting] = useState(false);
  const shown = useWindowShown();
  const live = active && shown;
  /** No status refresh over a control that is being moved. */
  const editingUntil = useRef(0);

  const onError = useCallback((e: unknown) => onToast("err", "Voicemeeter did not take the change", String(e)), [onToast]);
  const send = useThrottledSet(onError);

  const refreshStatus = useCallback(async () => {
    if (Date.now() < editingUntil.current) return;
    try {
      setStatus(await audio.vmStatus());
    } catch (e) {
      setStatus({ installed: false, running: false, kind: 0, edition: "", error: String(e), strips: [], buses: [] });
    }
  }, []);

  const refreshApps = useCallback(async () => {
    try {
      const [a, d, s] = await Promise.all([audio.listAudioApps(), audio.listRenderDevices(), lastshot.getSettings()]);
      setApps(a);
      setDevices(d);
      setRules(((s as unknown as { appOutputs?: AppOutputRule[] }).appOutputs ?? []) as AppOutputRule[]);
    } catch {
      /* lists stay as they were */
    }
  }, []);

  // Status: on show, then every 2 s while Voicemeeter is not running (to see
  // it start); while running, only when Voicemeeter says something changed.
  useEffect(() => {
    if (!live) return;
    void refreshStatus();
    const t = window.setInterval(() => {
      if (!status?.running) void refreshStatus();
    }, 2000);
    return () => window.clearInterval(t);
  }, [live, status?.running, refreshStatus]);

  // Meters: about 20 times a second, only while this tab is on screen.
  useEffect(() => {
    if (!live || !status?.running) {
      setLevels(null);
      return;
    }
    let busy = false;
    const t = window.setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const l = await audio.vmLevels();
        setLevels(l);
        if (!l.running || l.dirty) void refreshStatus();
      } catch {
        /* next tick */
      } finally {
        busy = false;
      }
    }, 50);
    return () => window.clearInterval(t);
  }, [live, status?.running, refreshStatus]);

  // Apps and outputs: on show and every 5 s.
  useEffect(() => {
    if (!live) return;
    void refreshApps();
    const t = window.setInterval(() => void refreshApps(), 5000);
    return () => window.clearInterval(t);
  }, [live, refreshApps]);

  const change = (param: string, value: number | boolean | string, patch: (s: VmStatus) => VmStatus) => {
    editingUntil.current = Date.now() + 600;
    setStatus((s) => (s ? patch(s) : s));
    send(param, value);
  };

  const setStrip = (i: number, p: Partial<VmStatus["strips"][number]>) => (s: VmStatus) => ({
    ...s,
    strips: s.strips.map((x) => (x.index === i ? { ...x, ...p } : x)),
  });
  const setBus = (i: number, p: Partial<VmStatus["buses"][number]>) => (s: VmStatus) => ({
    ...s,
    buses: s.buses.map((x) => (x.index === i ? { ...x, ...p } : x)),
  });

  const start = async () => {
    setStarting(true);
    try {
      await audio.vmLaunch();
      onToast("info", "Starting Voicemeeter…");
      window.setTimeout(() => void refreshStatus(), 2500);
    } catch (e) {
      onToast("err", "Could not start Voicemeeter", String(e));
    } finally {
      window.setTimeout(() => setStarting(false), 2500);
    }
  };

  const sendApp = async (app: AudioApp, deviceId: string | null) => {
    try {
      await audio.setAppOutput(app.exe, deviceId);
      const name = deviceId ? devices.find((d) => d.id === deviceId)?.name ?? "that output" : "Windows' default output";
      onToast("ok", `${app.exe.replace(/\.exe$/i, "")} now plays on ${name}`);
      void refreshApps();
    } catch (e) {
      onToast("err", "Could not change the app's output", String(e));
    }
  };

  const forget = async (exe: string) => {
    try {
      await audio.setAppOutput(exe, null);
      void refreshApps();
    } catch (e) {
      onToast("err", "Could not forget it", String(e));
    }
  };

  const busTitle = (name: string) => {
    const b = status?.buses.find((x) => x.name === name);
    if (!b) return name;
    const what = b.virtual ? `${b.role} — apps can record it (e.g. as Discord's mic)` : b.device || "a speaker or headset";
    return `${name}${b.label ? ` (${b.label})` : ""}: ${what}`;
  };

  const running = !!status?.running;
  const notRunning = rules.filter((r) => !apps.some((a) => a.exe.toLowerCase() === r.exe.toLowerCase()));

  return (
    <div className="space-y-5">
      {/* Header / banner */}
      <section className="panel rounded-xl p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-ink">Audio</h2>
            <p className="mt-0.5 max-w-[760px] text-[12px] leading-relaxed text-ink-3">
              A simple remote for Voicemeeter. <b className="text-ink-2">Inputs</b> are where sound comes from (your mic,
              or apps sent to a Voicemeeter input). <b className="text-ink-2">A1–A5</b> are your speakers and headsets.{" "}
              <b className="text-ink-2">B1–B3</b> are virtual outputs other apps can record: B1 = what Discord can use
              as a mic (“Voicemeeter Out B1”).
            </p>
          </div>
          {running && (
            <span className="flex items-center gap-1.5 rounded-md border border-line bg-surface-2 px-2.5 py-1 text-[11px] text-ink-3">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              {status?.edition} is running
            </span>
          )}
        </div>
        {status && !running && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3">
            {status.installed ? (
              <>
                <div className="text-[13px] text-ink">
                  <b>Voicemeeter isn't running.</b>{" "}
                  <span className="text-ink-3">Its virtual inputs and outputs only work while it runs.</span>
                </div>
                <button
                  type="button"
                  disabled={starting}
                  onClick={() => void start()}
                  className="rounded-md bg-accent px-3.5 py-1.5 text-[12px] font-semibold text-white hover:bg-accent-hover disabled:opacity-60"
                >
                  {starting ? "Starting…" : "Start it"}
                </button>
              </>
            ) : (
              <div className="text-[13px] text-ink">
                <b>Voicemeeter isn't installed.</b>{" "}
                <span className="text-ink-3">
                  This tab controls Voicemeeter, VB-Audio's virtual mixer (free from vb-audio.com). Sending apps to an
                  output below works without it.
                </span>
              </div>
            )}
          </div>
        )}
      </section>

      {running && status && (
        <>
          {/* Inputs */}
          <section className="panel rounded-xl p-5">
            <SectionHead title="Inputs" hint="Drag a fader, or double-click it for 0 dB. Light up A/B to send that input there." />
            <div className="flex gap-2.5 overflow-x-auto pb-1">
              {status.strips.map((s) => (
                <Channel
                  key={s.index}
                  title={s.label || s.role.replace("Hardware input", "Input")}
                  subtitle={s.label ? s.role : s.virtual ? "Virtual input" : "Hardware input"}
                  gain={s.gain}
                  mute={s.mute}
                  level={levels?.strips[s.index] ?? 0}
                  onRename={(v) => change(`Strip[${s.index}].Label`, v, setStrip(s.index, { label: v }))}
                  onGain={(g) => change(`Strip[${s.index}].Gain`, g, setStrip(s.index, { gain: g }))}
                  onMute={() => change(`Strip[${s.index}].Mute`, !s.mute, setStrip(s.index, { mute: !s.mute }))}
                >
                  {(["A", "B"] as const).map((bank) => (
                    <div key={bank} className="flex gap-1">
                      {s.routes.filter((r) => r.name.startsWith(bank)).map((r) => (
                        <button
                          key={r.name}
                          type="button"
                          title={`Send to ${busTitle(r.name)}`}
                          aria-pressed={r.on}
                          onClick={() =>
                            change(
                              `Strip[${s.index}].${r.name}`,
                              !r.on,
                              setStrip(s.index, {
                                routes: s.routes.map((x) => (x.name === r.name ? { ...x, on: !r.on } : x)),
                              }),
                            )
                          }
                          className={cn(
                            "min-w-0 flex-1 rounded py-0.5 font-mono text-[10px] font-semibold transition-colors",
                            r.on
                              ? r.name.startsWith("A")
                                ? "bg-accent text-white"
                                : "bg-emerald-600 text-white"
                              : "border border-line bg-surface-2 text-ink-4 hover:text-ink",
                          )}
                        >
                          {r.name}
                        </button>
                      ))}
                    </div>
                  ))}
                </Channel>
              ))}
            </div>
          </section>

          {/* Outputs */}
          <section className="panel rounded-xl p-5">
            <SectionHead title="Outputs" hint="A = speakers and headsets. B = virtual outputs that apps like Discord or OBS record." />
            <div className="flex gap-2.5 overflow-x-auto pb-1">
              {status.buses.map((b) => (
                <Channel
                  key={b.index}
                  badge={b.name}
                  title={b.label || b.name}
                  subtitle={b.virtual ? b.role : b.device || "No device chosen"}
                  gain={b.gain}
                  mute={b.mute}
                  level={levels?.buses[b.index] ?? 0}
                  onRename={(v) => change(`Bus[${b.index}].Label`, v, setBus(b.index, { label: v }))}
                  onGain={(g) => change(`Bus[${b.index}].Gain`, g, setBus(b.index, { gain: g }))}
                  onMute={() => change(`Bus[${b.index}].Mute`, !b.mute, setBus(b.index, { mute: !b.mute }))}
                />
              ))}
            </div>
          </section>
        </>
      )}

      {/* Apps */}
      <section className="panel rounded-xl p-5">
        <SectionHead
          title="Apps"
          hint="Send an app's sound to its own output — for example Discord to “Voicemeeter AUX Input” and your game to “Voicemeeter Input”, so each gets its own fader above. Lastshot remembers it and sets it again whenever the app starts."
        />
        {apps.length === 0 ? (
          <p className="py-3 text-[12px] text-ink-4">No app is making sound right now. Apps show up here once they play something.</p>
        ) : (
          <div className="divide-y divide-line">
            {apps.map((a) => (
              <div key={a.exe} className="flex items-center justify-between gap-4 py-2.5">
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    title={a.active ? "Playing now" : "Quiet"}
                    className={cn("h-2 w-2 shrink-0 rounded-full", a.active ? "bg-emerald-400" : "bg-ink-5/50")}
                  />
                  <span className="truncate text-[13px] font-medium text-ink">{a.exe.replace(/\.exe$/i, "")}</span>
                  {a.pids.length > 1 && <span className="font-mono text-[10px] text-ink-4">×{a.pids.length}</span>}
                </div>
                <label className="flex shrink-0 items-center gap-2 text-[12px] text-ink-3">
                  Send to
                  <DeviceSelect devices={devices} value={a.output} onChange={(id) => void sendApp(a, id)} />
                </label>
              </div>
            ))}
          </div>
        )}
        {notRunning.length > 0 && (
          <div className="mt-3 border-t border-line pt-3">
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-4">Remembered, not running now</div>
            {notRunning.map((r) => (
              <div key={r.exe} className="flex items-center justify-between gap-3 py-1 text-[12px]">
                <span className="text-ink-2">
                  {r.exe.replace(/\.exe$/i, "")} → <span className="text-ink-3">{r.deviceName || "an output"}</span>
                </span>
                <button
                  type="button"
                  onClick={() => void forget(r.exe)}
                  className="rounded border border-line bg-surface-2 px-2 py-0.5 text-[11px] text-ink-3 hover:text-ink"
                >
                  Forget
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function SectionHead({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="mb-3 border-b border-line pb-3">
      <h3 className="text-[14px] font-semibold text-ink">{title}</h3>
      <p className="mt-0.5 text-[12px] text-ink-3">{hint}</p>
    </div>
  );
}

function DeviceSelect({
  devices,
  value,
  onChange,
}: {
  devices: RenderDevice[];
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const vm = devices.filter((d) => isVoicemeeterDevice(d.name));
  const other = devices.filter((d) => !isVoicemeeterDevice(d.name));
  const missing = value && !devices.some((d) => d.id === value);
  return (
    <select
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
      className="max-w-[300px] rounded-md border border-line bg-surface-2 px-2 py-1 text-[12px] text-ink"
    >
      <option value="">Default (Windows' output)</option>
      {missing && <option value={value}>A device that is not connected</option>}
      {vm.length > 0 && (
        <optgroup label="Voicemeeter">
          {vm.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </optgroup>
      )}
      {other.length > 0 && (
        <optgroup label="Other outputs">
          {other.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
              {d.isDefault ? " (Windows default)" : ""}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  );
}

/** One channel strip: name, meter + fader, mute, and optional extras. */
function Channel({
  title,
  subtitle,
  badge,
  gain,
  mute,
  level,
  onGain,
  onMute,
  onRename,
  children,
}: {
  title: string;
  subtitle: string;
  badge?: string;
  gain: number;
  mute: boolean;
  level: number;
  onGain: (g: number) => void;
  onMute: () => void;
  onRename: (name: string) => void;
  children?: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="flex w-[112px] shrink-0 flex-col gap-2 rounded-lg border border-line bg-surface-3 p-2">
      <div className="min-h-[34px]">
        {editing ? (
          <input
            autoFocus
            defaultValue={title}
            maxLength={64}
            onBlur={(e) => {
              setEditing(false);
              if (e.target.value.trim() !== title) onRename(e.target.value.trim());
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setEditing(false);
            }}
            className="w-full rounded border border-accent bg-surface px-1 py-0.5 text-[12px] text-ink"
          />
        ) : (
          <button
            type="button"
            title="Rename"
            onClick={() => setEditing(true)}
            className="flex w-full items-center gap-1 text-left"
          >
            {badge && <span className="rounded bg-surface-4 px-1 font-mono text-[10px] font-semibold text-ink-3">{badge}</span>}
            <span className="truncate text-[12px] font-semibold text-ink">{title}</span>
          </button>
        )}
        <div className="truncate text-[10px] text-ink-4" title={subtitle}>
          {subtitle}
        </div>
      </div>
      <div className="flex h-[170px] items-stretch justify-center gap-2">
        <Meter level={level} muted={mute} />
        <Fader value={gain} onChange={onGain} />
      </div>
      <div className="text-center font-mono text-[11px] text-ink-3">
        {gain > 0 ? "+" : ""}
        {gain.toFixed(1)} dB
      </div>
      <button
        type="button"
        aria-pressed={mute}
        onClick={onMute}
        className={cn(
          "rounded-md py-1 text-[11px] font-semibold transition-colors",
          mute ? "bg-red-600 text-white" : "border border-line bg-surface-2 text-ink-3 hover:text-ink",
        )}
      >
        {mute ? "Muted" : "Mute"}
      </button>
      {children}
    </div>
  );
}

function Meter({ level, muted }: { level: number; muted: boolean }) {
  const pos = dbToPos(toDb(level));
  return (
    <div className="relative w-2 overflow-hidden rounded-full bg-surface-4" aria-hidden="true">
      <div
        className={cn("absolute inset-x-0 bottom-0 rounded-full", muted && "opacity-30")}
        style={{
          height: `${pos * 100}%`,
          background: "linear-gradient(to top, #10b981 0%, #10b981 70%, #f59e0b 83%, #ef4444 100%)",
          backgroundSize: `100% ${pos > 0 ? 100 / pos : 100}%`,
          backgroundPosition: "bottom",
          transition: "height 60ms linear",
        }}
      />
      {/* 0 dB mark */}
      <div className="absolute inset-x-0 h-px bg-ink-5/60" style={{ bottom: `${dbToPos(0) * 100}%` }} />
    </div>
  );
}

/** Vertical fader, -60..+12 dB. Arrow keys ±0.5 dB, Page keys ±3 dB, double-click = 0 dB. */
function Fader({ value, onChange }: { value: number; onChange: (db: number) => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const drag = useRef(false);
  const fromY = (clientY: number) => {
    const r = ref.current!.getBoundingClientRect();
    const t = 1 - (clientY - r.top) / r.height;
    const db = GAIN_MIN + Math.min(1, Math.max(0, t)) * (GAIN_MAX - GAIN_MIN);
    return Math.round(db * 2) / 2;
  };
  const set = (db: number) => onChange(Math.min(GAIN_MAX, Math.max(GAIN_MIN, Math.round(db * 10) / 10)));
  const down = (e: PointerEvent<HTMLDivElement>) => {
    drag.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    set(fromY(e.clientY));
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current) set(fromY(e.clientY));
  };
  const up = () => {
    drag.current = false;
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowUp: 0.5, ArrowRight: 0.5, ArrowDown: -0.5, ArrowLeft: -0.5, PageUp: 3, PageDown: -3 }[e.key];
    if (step) {
      e.preventDefault();
      set(value + step);
    } else if (e.key === "Home") set(GAIN_MAX);
    else if (e.key === "End") set(GAIN_MIN);
  };
  const pos = dbToPos(value);
  return (
    <div
      ref={ref}
      role="slider"
      tabIndex={0}
      aria-orientation="vertical"
      aria-valuemin={GAIN_MIN}
      aria-valuemax={GAIN_MAX}
      aria-valuenow={value}
      aria-valuetext={`${value.toFixed(1)} dB`}
      title="Drag, or double-click for 0 dB"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onDoubleClick={() => set(0)}
      onKeyDown={key}
      className="relative w-7 cursor-ns-resize touch-none rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <div className="absolute inset-y-0 left-1/2 w-1.5 -translate-x-1/2 rounded-full bg-surface-4" />
      <div
        className="absolute bottom-0 left-1/2 w-1.5 -translate-x-1/2 rounded-full bg-accent/70"
        style={{ height: `${pos * 100}%` }}
      />
      <div className="absolute inset-x-1 h-px bg-ink-5/60" style={{ bottom: `${dbToPos(0) * 100}%` }} />
      <div
        className="absolute left-1/2 h-3.5 w-6 -translate-x-1/2 translate-y-1/2 rounded-md border border-line-3 bg-surface shadow"
        style={{ bottom: `${pos * 100}%` }}
      />
    </div>
  );
}
