import { useCallback, useEffect, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { dbToPos, toDb } from "../lib/audio";
import {
  DEFAULT_ROWS,
  EVT_GUARD,
  KIND_LABELS,
  currentDefault,
  deviceName,
  filterLog,
  guard,
  move,
  pickConnected,
  policyLabel,
  preferredOrder,
  timeLabel,
  whoLabel,
  withOrder,
  type AppView,
  type Change,
  type GuardSettings,
  type GuardView,
  type LogEntry,
  type LogFilter,
  type Policy,
  type SnapshotMeta,
} from "../lib/devices";
import { cn } from "../utils/cn";
import PresetOrCustom from "./PresetOrCustom";

/**
 * Audio → Devices: Lastshot in place of Windows' sound settings. Default
 * devices with a fallback order, per-app microphones / volume / mute / solo,
 * the Audio guard (ask, restore or accept when Windows changes something),
 * auto-duck, a mic shortcut, snapshots ("scenes") and a history.
 */

type Toast = (tone: "ok" | "err" | "warn" | "info", title: string, body?: string) => void;

export default function DevicesSection({ live, onToast }: { live: boolean; onToast: Toast }) {
  const [view, setView] = useState<GuardView | null>(null);
  const [apps, setApps] = useState<AppView[]>([]);
  const [levels, setLevels] = useState({ output: 0, mic: 0 });
  const [tab, setTab] = useState<"devices" | "apps" | "snapshots" | "history">("devices");

  const refresh = useCallback(async () => {
    try {
      setView(await guard.status());
    } catch {
      /* stays */
    }
  }, []);

  useEffect(() => {
    if (!live) return;
    void refresh();
    const t = window.setInterval(() => void refresh(), 3000);
    let un: (() => void) | undefined;
    window.__TAURI__?.event
      ?.listen(EVT_GUARD, () => void refresh())
      .then((u: () => void) => (un = u))
      .catch(() => undefined);
    return () => {
      window.clearInterval(t);
      un?.();
    };
  }, [live, refresh]);

  // Meters and app strips: ~10 times a second, only while on screen.
  useEffect(() => {
    if (!live) return;
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        const [l, a] = await Promise.all([guard.levels(), tab === "apps" ? guard.apps() : Promise.resolve(null)]);
        setLevels(l);
        if (a) setApps(a);
      } catch {
        /* next tick */
      } finally {
        busy = false;
      }
    };
    void tick();
    const t = window.setInterval(() => void tick(), 100);
    return () => window.clearInterval(t);
  }, [live, tab]);

  const saveSettings = async (s: GuardSettings, ok?: string) => {
    try {
      setView(await guard.setSettings(s));
      if (ok) onToast("ok", ok);
    } catch (e) {
      onToast("err", "Not saved", String(e));
      void refresh();
    }
  };

  if (!view) {
    return (
      <section className="panel rounded-xl p-5">
        <Head />
        <p className="text-[12px] text-ink-4">Loading…</p>
      </section>
    );
  }
  const s = view.settings;

  return (
    <section className="panel rounded-xl p-5" data-testid="devices">
      <Head />
      {/* Guard bar */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 text-[12px]" data-testid="guard-status">
          <span
            className={cn(
              "h-2 w-2 shrink-0 rounded-full",
              view.status.tone === "ok" && "bg-emerald-400",
              view.status.tone === "warn" && "bg-amber-400",
              view.status.tone === "err" && "bg-red-500",
              view.status.tone === "info" && "bg-ink-5/60",
            )}
          />
          <span className={cn(view.status.tone === "err" ? "text-red-400" : "text-ink-2")}>{view.status.text}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={s.policy}
            title="What Lastshot does when Windows or another app changes one of your settings"
            onChange={(e) => void saveSettings({ ...s, policy: e.target.value as Policy })}
            className="rounded-md border border-line bg-surface-2 px-2 py-1 text-[12px] text-ink"
          >
            {(["ask", "restore", "accept"] as Policy[]).map((p) => (
              <option key={p} value={p}>
                {policyLabel(p)}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void saveSettings({ ...s, enabled: !s.enabled }, s.enabled ? "Guard off" : "Guard on")}
            className={cn(
              "rounded-md px-3.5 py-1.5 text-[12px] font-semibold",
              s.enabled ? "border border-line bg-surface-2 text-ink-2 hover:text-ink" : "bg-accent text-white hover:bg-accent-hover",
            )}
          >
            {s.enabled ? "Turn guard off" : "Turn guard on"}
          </button>
        </div>
      </div>
      <div className="mb-3 flex flex-wrap gap-4 text-[12px] text-ink-3">
        <Check label="Small notification when Lastshot puts something back" on={s.notifyRestores} onChange={(v) => void saveSettings({ ...s, notifyRestores: v })} />
        <Check
          label="Strict: mute an app while it plays or records on the wrong device"
          on={s.strict}
          onChange={(v) => void saveSettings({ ...s, strict: v })}
        />
      </div>

      {view.pending.length > 0 && (
        <div className="mb-3 space-y-2" data-testid="guard-pending">
          {view.pending.map((p) => (
            <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12px]">
              <span className="text-ink-2">{p.text}</span>
              <span className="flex gap-1.5">
                {(
                  [
                    ["restore", "Restore mine"],
                    ["keep", "Keep new"],
                    ["alwaysRestore", "Always restore"],
                    ["alwaysKeep", "Always keep"],
                  ] as const
                ).map(([c, label]) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() =>
                      guard
                        .answer(p.id, c)
                        .then(setView)
                        .catch((e) => onToast("err", "Could not do that", String(e)))
                    }
                    className={cn(
                      "rounded px-2 py-0.5 font-semibold",
                      c === "restore" ? "bg-accent text-white" : "border border-line bg-surface-2 text-ink-3 hover:text-ink",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="mb-3 flex gap-1 border-b border-line">
        {(
          [
            ["devices", "Default devices"],
            ["apps", "Apps"],
            ["snapshots", "Snapshots"],
            ["history", "History"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={cn(
              "-mb-px border-b-2 px-3 py-1.5 text-[12px] font-semibold",
              tab === k ? "border-accent text-ink" : "border-transparent text-ink-4 hover:text-ink-2",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "devices" && <DefaultsTab view={view} levels={levels} onView={setView} onSave={saveSettings} onToast={onToast} />}
      {tab === "apps" && <AppsTab view={view} apps={apps} onView={setView} onToast={onToast} />}
      {tab === "snapshots" && <SnapshotsTab live={live} onToast={onToast} onChanged={refresh} />}
      {tab === "history" && <HistoryTab live={live} onToast={onToast} />}

      <p className="mt-4 border-t border-line pt-3 text-[11px] leading-relaxed text-ink-4">
        Lastshot can change Windows' defaults and each app's devices from outside. Apps that pick a device in their own
        settings (Discord's own device list, OBS sources) can't be changed from outside: set those to "Default" in the app,
        and the guard keeps the default steady so they land on the right device (strict mode mutes them while they play on
        the wrong one). Some older apps only switch when they next start a sound; the guard still fixes their setting at
        once. Windows has no public API for these
        switches; if a Windows update breaks them, the line above says so.
      </p>
    </section>
  );
}

function Head() {
  return (
    <div className="mb-3 border-b border-line pb-3">
      <h3 className="text-[14px] font-semibold text-ink">Devices</h3>
      <p className="mt-0.5 max-w-[760px] text-[12px] text-ink-3">
        Your default speakers and microphone, each app's devices and volume, and a guard that stops Windows from quietly
        changing them when a device is plugged in, after sleep or a driver update.
      </p>
    </div>
  );
}

function Check({ label, on, onChange }: { label: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-1.5">
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} className="accent-[var(--color-accent,#6366f1)]" />
      {label}
    </label>
  );
}

function Bar({ level, width = "w-24" }: { level: number; width?: string }) {
  const pos = dbToPos(toDb(level));
  return (
    <span className={cn("relative h-1.5 overflow-hidden rounded-full bg-surface-4", width)} aria-hidden="true">
      <span
        className="absolute inset-y-0 left-0 rounded-full"
        style={{
          width: `${pos * 100}%`,
          background: "linear-gradient(to right, #10b981 0%, #10b981 70%, #f59e0b 83%, #ef4444 100%)",
          backgroundSize: `${pos > 0 ? 100 / pos : 100}% 100%`,
          transition: "width 90ms linear",
        }}
      />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Default devices
// ---------------------------------------------------------------------------

function DefaultsTab({
  view,
  levels,
  onView,
  onSave,
  onToast,
}: {
  view: GuardView;
  levels: { output: number; mic: number };
  onView: (v: GuardView) => void;
  onSave: (s: GuardSettings, ok?: string) => Promise<void>;
  onToast: Toast;
}) {
  const s = view.settings;
  const cables = new Set(view.cableIds);
  const [hotkey, setHotkey] = useState(s.micMuteHotkey);
  useEffect(() => setHotkey(s.micMuteHotkey), [s.micMuteHotkey]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-4 rounded-lg border border-line bg-surface-3 px-3 py-2 text-[12px] text-ink-3">
        <span className="flex items-center gap-2">
          Output <Bar level={levels.output} />
        </span>
        <span className="flex items-center gap-2">
          Microphone <Bar level={view.micMuted ? 0 : levels.mic} />
        </span>
        {view.micMuted !== null && (
          <button
            type="button"
            aria-pressed={view.micMuted}
            onClick={() =>
              guard
                .micMute(!view.micMuted)
                .then(() => guard.status().then(onView))
                .catch((e) => onToast("err", "Could not change the mic", String(e)))
            }
            className={cn(
              "rounded-md px-2 py-0.5 text-[11px] font-semibold",
              view.micMuted ? "bg-red-600 text-white" : "border border-line bg-surface-2 text-ink-3 hover:text-ink",
            )}
          >
            {view.micMuted ? "Mic muted" : "Mute mic"}
          </button>
        )}
        <label className="ml-auto flex items-center gap-2" title="A shortcut that mutes and unmutes your default microphone from anywhere.">
          Mic shortcut
          <input
            value={hotkey}
            placeholder="e.g. Ctrl+Alt+M"
            onChange={(e) => setHotkey(e.target.value)}
            onBlur={() => hotkey !== s.micMuteHotkey && void onSave({ ...s, micMuteHotkey: hotkey.trim() }, hotkey.trim() ? `Mic shortcut: ${hotkey.trim()}` : "Mic shortcut removed")}
            className="w-[130px] rounded border border-line bg-surface-2 px-1.5 py-0.5 text-[12px] text-ink"
          />
        </label>
      </div>

      {DEFAULT_ROWS.map((row) => {
        const list = row.flow === 0 ? view.render : view.capture;
        const cur = currentDefault(view, row.flow, row.comm);
        const order = preferredOrder(s, row.flow, row.comm);
        const winner = pickConnected(order, list);
        const setOrder = (o: typeof order) => void onSave(withOrder(s, row.flow, row.comm, o));
        return (
          <div key={`${row.flow}${row.comm}`} className="rounded-lg border border-line bg-surface-3 p-3" data-testid={`default-${row.flow}-${row.comm ? "comm" : "main"}`}>
            <div className="flex flex-wrap items-center gap-3">
              <span className="w-[150px] shrink-0 text-[12px] text-ink-2" title={row.hint}>
                {row.label}
              </span>
              <select
                value={cur?.id ?? ""}
                onChange={(e) =>
                  guard
                    .setDefault(row.flow, row.comm, e.target.value)
                    .then(onView)
                    .catch((err) => onToast("err", "Could not change the default", String(err)))
                }
                className="max-w-[320px] rounded-md border border-line bg-surface-2 px-2 py-1 text-[12px] text-ink"
              >
                {!cur && <option value="">None</option>}
                {list.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                    {cables.has(d.id) ? " (Lastshot cable)" : ""}
                  </option>
                ))}
              </select>
              {s.enabled && winner && cur && winner.id !== cur.id && (
                <span className="text-[11px] text-amber-400">Your first choice that's plugged in is {winner.name}</span>
              )}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-[162px] text-[11px]">
              <span className="text-ink-4">{order.length ? "Order:" : "No fallback order yet."}</span>
              {order.map((d, i) => {
                const here = list.some((e) => e.id === d.id || e.name.toLowerCase() === d.name.toLowerCase());
                return (
                  <span key={d.id} className={cn("flex items-center gap-1 rounded border border-line bg-surface-2 px-1.5 py-0.5", !here && "opacity-60")}>
                    <span className="text-ink-4">{i + 1}.</span>
                    <span className="text-ink-2">{d.name || "A device"}</span>
                    {!here && <span className="text-ink-4">(unplugged)</span>}
                    <button type="button" title="Earlier" disabled={i === 0} onClick={() => setOrder(move(order, i, -1))} className="text-ink-4 hover:text-ink disabled:opacity-30">
                      ↑
                    </button>
                    <button type="button" title="Later" disabled={i === order.length - 1} onClick={() => setOrder(move(order, i, 1))} className="text-ink-4 hover:text-ink disabled:opacity-30">
                      ↓
                    </button>
                    <button type="button" title="Take out" onClick={() => setOrder(order.filter((_, j) => j !== i))} className="text-ink-4 hover:text-ink">
                      ✕
                    </button>
                  </span>
                );
              })}
              <select
                value=""
                onChange={(e) => {
                  const d = list.find((x) => x.id === e.target.value);
                  if (d) setOrder([...order, { id: d.id, name: d.name }]);
                }}
                className="rounded border border-line bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-3"
              >
                <option value="">+ {order.length ? "else…" : "add"}</option>
                {list
                  .filter((d) => !order.some((o) => o.id === d.id))
                  .map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
              </select>
            </div>
          </div>
        );
      })}

      <DuckBox s={s} onSave={onSave} />
    </div>
  );
}

function DuckBox({ s, onSave }: { s: GuardSettings; onSave: (s: GuardSettings, ok?: string) => Promise<void> }) {
  const d = s.duck;
  const set = (p: Partial<typeof d>) => void onSave({ ...s, duck: { ...d, ...p } });
  return (
    <div className="rounded-lg border border-line bg-surface-3 p-3 text-[12px] text-ink-3">
      <Check label="Auto-duck: lower other apps while your microphone is in use" on={d.enabled} onChange={(v) => set({ enabled: v })} />
      {d.enabled && (
        <div className="mt-2 flex flex-wrap items-center gap-4 pl-5">
          <label className="flex items-center gap-2" title="How loud your mic must be to count as talking">
            Starts at
            <input type="range" min={-70} max={-10} step={1} value={d.thresholdDb} onChange={(e) => set({ thresholdDb: Number(e.target.value) })} className="w-[100px]" />
            <span className="w-[52px] font-mono text-[11px]">{d.thresholdDb} dB</span>
          </label>
          <label className="flex items-center gap-2">
            Lower by
            <input type="range" min={3} max={30} step={1} value={d.amountDb} onChange={(e) => set({ amountDb: Number(e.target.value) })} className="w-[100px]" />
            <span className="w-[44px] font-mono text-[11px]">{d.amountDb} dB</span>
          </label>
          <label className="flex items-center gap-2" title="How long after you stop talking the apps come back">
            Back after
            <PresetOrCustom
              value={d.releaseMs}
              presets={[300, 500, 800, 1200, 2000, 3000].map((ms) => ({ value: ms, label: `${ms / 1000} s` }))}
              min={0.1}
              max={5}
              step={0.1}
              scale={1000}
              digits={1}
              unit="s"
              onChange={(ms) => set({ releaseMs: ms })}
              aria-label="Back after"
              className="rounded border border-line bg-surface-2 px-1.5 py-0.5 text-ink"
              fieldClassName="w-12 rounded border border-line bg-surface-2 px-1.5 py-0.5 text-right font-mono text-ink"
            />
          </label>
          <span className="text-[11px] text-ink-4">Apps set to “Never lower” (Apps tab) are left alone. Lastshot reads the mic level, it doesn't record it.</span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Apps
// ---------------------------------------------------------------------------

function AppsTab({
  view,
  apps,
  onView,
  onToast,
}: {
  view: GuardView;
  apps: AppView[];
  onView: (v: GuardView) => void;
  onToast: Toast;
}) {
  const [vol, setVol] = useState<Record<string, number>>({});
  const timers = useRef<Record<string, number>>({});
  const anySolo = apps.some((a) => a.solo);
  if (apps.length === 0) return <p className="py-3 text-[12px] text-ink-4">No app has sound open right now. Apps show up here once they play or record.</p>;
  const err = (title: string) => (e: unknown) => onToast("err", title, String(e));
  return (
    <div className="divide-y divide-line">
      {apps.map((a) => {
        const v = vol[a.exe] ?? a.volume;
        const name = a.exe.replace(/\.exe$/i, "");
        const policy = a.pref?.policy ?? "";
        return (
          <div key={a.exe} className="flex flex-wrap items-center gap-x-4 gap-y-1.5 py-2.5" data-testid={`app-${a.exe}`}>
            <div className="flex w-[160px] min-w-0 items-center gap-2">
              <span className={cn("h-2 w-2 shrink-0 rounded-full", a.playing || a.recording ? "bg-emerald-400" : "bg-ink-5/50")} />
              <span className="truncate text-[13px] font-medium text-ink" title={a.exe}>
                {name}
              </span>
            </div>
            <Bar level={a.mute ? 0 : a.peak} width="w-20" />
            <span className="flex items-center gap-1.5">
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(v * 100)}
                onChange={(e) => {
                  const x = Number(e.target.value) / 100;
                  setVol((m) => ({ ...m, [a.exe]: x }));
                  window.clearTimeout(timers.current[a.exe]);
                  timers.current[a.exe] = window.setTimeout(() => {
                    guard.setAppVolume(a.exe, x, null, true).catch(err("Volume not changed"));
                    setVol((m) => {
                      const { [a.exe]: _drop, ...rest } = m;
                      return rest;
                    });
                  }, 120);
                }}
                className="w-[100px]"
                title="Remembered for next time"
              />
              <span className="w-[34px] font-mono text-[11px] text-ink-3">{Math.round(v * 100)}%</span>
            </span>
            <button
              type="button"
              aria-pressed={a.mute}
              onClick={() => guard.setAppVolume(a.exe, null, !a.mute, true).catch(err("Mute not changed"))}
              className={cn("rounded-md px-2 py-0.5 text-[11px] font-semibold", a.mute ? "bg-red-600 text-white" : "border border-line bg-surface-2 text-ink-3 hover:text-ink")}
            >
              {a.mute ? "Muted" : "Mute"}
            </button>
            <button
              type="button"
              aria-pressed={a.solo}
              title="Hear only this app; click again to undo"
              onClick={() => guard.solo(a.solo ? null : a.exe).catch(err("Solo didn't work"))}
              className={cn(
                "rounded-md px-2 py-0.5 text-[11px] font-semibold",
                a.solo ? "bg-amber-500 text-white" : "border border-line bg-surface-2 text-ink-3 hover:text-ink",
                anySolo && !a.solo && "opacity-60",
              )}
            >
              Solo
            </button>
            <label className="flex items-center gap-1.5 text-[12px] text-ink-3" title="Which microphone this app records">
              Mic
              <select
                value={a.input?.id ?? ""}
                onChange={(e) => {
                  const d = view.capture.find((x) => x.id === e.target.value);
                  guard
                    .setAppInput(a.exe, d ? { id: d.id, name: d.name } : null)
                    .then(() => onToast("ok", `${name} now records ${d?.name ?? "Windows' default microphone"}`))
                    .catch(err("Could not change the app's microphone"));
                }}
                className="max-w-[200px] rounded-md border border-line bg-surface-2 px-1.5 py-0.5 text-[12px] text-ink"
              >
                <option value="">Default</option>
                {view.capture.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>
            <span className="text-[11px] text-ink-4">
              {a.outputNow && <>plays on {deviceName(a.outputNow, view.render)}</>}
              {a.outputNow && a.inputNow && " · "}
              {a.inputNow && <>records {deviceName(a.inputNow, view.capture)}</>}
            </span>
            <span className="ml-auto flex items-center gap-2 text-[11px] text-ink-3">
              <select
                value={policy}
                title="When Windows moves this app"
                onChange={(e) =>
                  guard
                    .setAppOptions(a.exe, (e.target.value || null) as Policy | null, a.pref?.noDuck ?? false)
                    .then(onView)
                    .catch(err("Not saved"))
                }
                className="rounded border border-line bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-3"
              >
                <option value="">If moved: as set above</option>
                <option value="ask">If moved: ask me</option>
                <option value="restore">If moved: move it back</option>
                <option value="accept">If moved: let it be</option>
              </select>
              {view.settings.duck.enabled && (
                <Check
                  label="Never lower"
                  on={a.pref?.noDuck ?? false}
                  onChange={(nd) =>
                    guard
                      .setAppOptions(a.exe, a.pref?.policy ?? null, nd)
                      .then(onView)
                      .catch(err("Not saved"))
                  }
                />
              )}
            </span>
          </div>
        );
      })}
      <p className="pt-2 text-[11px] text-ink-4">
        Outputs (“Send to”) are in the Apps section below. Volume and mute are remembered per app (by its .exe name) and
        set again when it starts.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

function SnapshotsTab({ live, onToast, onChanged }: { live: boolean; onToast: Toast; onChanged: () => void }) {
  const [list, setList] = useState<SnapshotMeta[]>([]);
  const [name, setName] = useState("");
  const [preview, setPreview] = useState<{ id: string; changes: Change[] } | null>(null);
  const [showAuto, setShowAuto] = useState(false);

  const load = useCallback(async () => {
    try {
      setList(await guard.snapshots());
    } catch {
      /* stays */
    }
  }, []);
  useEffect(() => {
    if (live) void load();
  }, [live, load]);

  const scenes = list.filter((x) => x.name);
  const autos = list.filter((x) => !x.name);
  const err = (t: string) => (e: unknown) => onToast("err", t, String(e));

  const row = (m: SnapshotMeta) => (
    <div key={m.id} className="py-1.5">
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <span className="min-w-0 flex-1 truncate">
          <span className="text-ink-2">{m.name ?? m.reason}</span>
          <span className="ml-2 text-[11px] text-ink-4">{timeLabel(m.time)}</span>
        </span>
        <button
          type="button"
          onClick={() =>
            preview?.id === m.id
              ? setPreview(null)
              : guard
                  .preview(m.id)
                  .then((changes) => setPreview({ id: m.id, changes }))
                  .catch(err("Could not read it"))
          }
          className="rounded border border-line bg-surface-2 px-2 py-0.5 text-[11px] text-ink-3 hover:text-ink"
        >
          {preview?.id === m.id ? "Close" : m.name ? "Switch to…" : "Restore…"}
        </button>
        {m.name && (
          <button
            type="button"
            onClick={async () => {
              const p = await save({ defaultPath: `${m.name}.json`, filters: [{ name: "Lastshot audio snapshot", extensions: ["json"] }] });
              if (p) guard.exportSnapshot(m.id, p).then(() => onToast("ok", "Exported")).catch(err("Not exported"));
            }}
            className="rounded border border-line bg-surface-2 px-2 py-0.5 text-[11px] text-ink-3 hover:text-ink"
          >
            Export
          </button>
        )}
        <button
          type="button"
          onClick={() => guard.remove(m.id).then(load).catch(err("Not deleted"))}
          className="rounded border border-line bg-surface-2 px-2 py-0.5 text-[11px] text-ink-4 hover:text-ink"
        >
          Delete
        </button>
      </div>
      {preview?.id === m.id && (
        <div className="mt-1.5 rounded border border-line bg-surface-2 p-2 text-[11px]">
          {preview.changes.length === 0 ? (
            <p className="text-ink-4">Nothing would change: this is how things are now.</p>
          ) : (
            <ul className="space-y-0.5">
              {preview.changes.map((c, i) => (
                <li key={i} className="text-ink-3">
                  <span className="text-ink-2">{c.what}:</span> {c.from} → <span className="text-ink-2">{c.to}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() =>
                guard
                  .restore(m.id)
                  .then((ch) => {
                    onToast("ok", `Restored ${m.name ?? "the snapshot"}`, `${ch.length} change(s). The setup before it was saved, so you can undo this.`);
                    setPreview(null);
                    void load();
                    onChanged();
                  })
                  .catch((e) => {
                    onToast("warn", "Restored in part", String(e));
                    void load();
                    onChanged();
                  })
              }
              className="rounded bg-accent px-2.5 py-0.5 font-semibold text-white"
            >
              Restore this
            </button>
            <span className="text-ink-4">Your current setup is saved first.</span>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="space-y-3 text-[12px]">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={name}
          maxLength={40}
          placeholder="Name this setup, e.g. Gaming"
          onChange={(e) => setName(e.target.value)}
          className="w-[220px] rounded border border-line bg-surface-2 px-2 py-1 text-[12px] text-ink"
        />
        <button
          type="button"
          disabled={!name.trim()}
          onClick={() =>
            guard
              .take(name.trim())
              .then(() => {
                setName("");
                onToast("ok", `Saved “${name.trim()}”`);
                void load();
              })
              .catch(err("Not saved"))
          }
          className="rounded-md bg-accent px-3 py-1 text-[12px] font-semibold text-white disabled:opacity-50"
        >
          Save current setup
        </button>
        <button
          type="button"
          onClick={async () => {
            const p = await open({ multiple: false, filters: [{ name: "Lastshot audio snapshot", extensions: ["json"] }] });
            if (typeof p === "string") guard.importSnapshot(p).then(() => { onToast("ok", "Imported"); void load(); }).catch(err("Not imported"));
          }}
          className="rounded-md border border-line bg-surface-2 px-3 py-1 text-[12px] text-ink-3 hover:text-ink"
        >
          Import…
        </button>
      </div>
      <div>
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-4">Your setups</div>
        {scenes.length === 0 ? <p className="text-ink-4">None yet. Save one per use, like “Gaming” and “Streaming”, to switch with one click.</p> : <div className="divide-y divide-line">{scenes.map(row)}</div>}
      </div>
      <div>
        <button type="button" onClick={() => setShowAuto(!showAuto)} className="text-[11px] font-semibold uppercase tracking-wide text-ink-4 hover:text-ink-2">
          {showAuto ? "▾" : "▸"} Automatic backups ({autos.length}) — taken before every change, last 100 or 30 days
        </button>
        {showAuto && <div className="divide-y divide-line">{autos.map(row)}</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function HistoryTab({ live, onToast }: { live: boolean; onToast: Toast }) {
  const [log, setLog] = useState<LogEntry[]>([]);
  const [f, setF] = useState<LogFilter>({ kind: "", who: "", text: "" });
  const load = useCallback(async () => {
    try {
      setLog(await guard.log(500));
    } catch {
      /* stays */
    }
  }, []);
  useEffect(() => {
    if (!live) return;
    void load();
    let un: (() => void) | undefined;
    window.__TAURI__?.event
      ?.listen(EVT_GUARD, () => void load())
      .then((u: () => void) => (un = u))
      .catch(() => undefined);
    return () => un?.();
  }, [live, load]);
  const shown = filterLog(log, f);
  return (
    <div className="text-[12px]">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} className="rounded border border-line bg-surface-2 px-1.5 py-0.5 text-ink">
          <option value="">Everything</option>
          {Object.entries(KIND_LABELS).map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
        <select value={f.who} onChange={(e) => setF({ ...f, who: e.target.value as LogFilter["who"] })} className="rounded border border-line bg-surface-2 px-1.5 py-0.5 text-ink">
          <option value="">Anyone</option>
          {(["windows", "user", "lastshot", "guard", "restore"] as const).map((w) => (
            <option key={w} value={w}>
              {whoLabel(w)}
            </option>
          ))}
        </select>
        <input value={f.text} placeholder="Search" onChange={(e) => setF({ ...f, text: e.target.value })} className="w-[160px] rounded border border-line bg-surface-2 px-1.5 py-0.5 text-ink" />
        <button
          type="button"
          onClick={async () => {
            const p = await save({ defaultPath: "lastshot-audio-log.jsonl", filters: [{ name: "Log", extensions: ["jsonl", "txt"] }] });
            if (p) guard.exportLog(p).then((n) => onToast("ok", `Exported ${n} entries`)).catch((e) => onToast("err", "Not exported", String(e)));
          }}
          className="ml-auto rounded border border-line bg-surface-2 px-2 py-0.5 text-[11px] text-ink-3 hover:text-ink"
        >
          Export log
        </button>
      </div>
      {shown.length === 0 ? (
        <p className="py-2 text-ink-4">Nothing here yet.</p>
      ) : (
        <div className="max-h-[320px] divide-y divide-line overflow-y-auto">
          {shown.map((e, i) => (
            <div key={i} className="flex flex-wrap gap-x-3 py-1">
              <span className="w-[120px] shrink-0 font-mono text-[11px] text-ink-4">{timeLabel(e.time)}</span>
              <span className="min-w-0 flex-1 text-ink-2">
                {e.what}
                {(e.from || e.to) && (
                  <span className="text-ink-3">
                    : {e.from || "—"} → {e.to || "—"}
                  </span>
                )}
              </span>
              <span className="text-[11px] text-ink-4">{whoLabel(e.who)}</span>
              <span className="text-[11px] text-ink-3">{e.action}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
