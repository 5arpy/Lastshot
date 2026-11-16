import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { assetUrl, isTauri, lastshot } from "../lib/bridge";
import type { AppSettings, BarState, CameraInfo, MonitorInfo, ScreenShot, WindowMethod } from "../lib/types";
import { type Layer, type LayerKind, loadLayers, newLayer, restack, saveLayers } from "../lib/studio";
import { LayerView, useRecordingSeconds } from "./StudioLayers";
import { clockTime } from "./ControlBar";
import { cn } from "../utils/cn";
import SourcePicker, { sourceLabel } from "./SourcePicker";
import AppAudioPicker from "./AppAudioPicker";

/**
 * Studio: recording with layers on top, OBS-style. Pictures, text, a webcam,
 * the clock and a recording timer are placed on a picture of your screen
 * here, and shown on the real screen (in a click-through window) so they are
 * in your recordings. Plus the recording options in one place.
 */

interface Props {
  settings: AppSettings;
  monitors: MonitorInfo[];
  bar: BarState | null;
  onToast: (tone: "ok" | "err" | "warn" | "info", title: string, body?: string) => void;
  onPatch: (p: Partial<AppSettings>) => void;
}

const KINDS: { kind: LayerKind; label: string; hint: string }[] = [
  { kind: "image", label: "Picture", hint: "A logo, a frame, a watermark (PNG keeps transparency)" },
  { kind: "text", label: "Text", hint: "A title, your name, a note" },
  { kind: "webcam", label: "Webcam", hint: "Your camera in a corner" },
  { kind: "clock", label: "Clock", hint: "The time of day" },
  { kind: "timer", label: "Recording timer", hint: "How long the recording has run" },
];

export default function StudioPanel({ settings, monitors, bar, onToast, onPatch }: Props) {
  const [layers, setLayers] = useState<Layer[]>(loadLayers);
  const [selected, setSelected] = useState<string | null>(null);
  const [shot, setShot] = useState<ScreenShot | null>(null);
  const [cams, setCams] = useState<CameraInfo[]>([]);
  const [live, setLive] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [picking, setPicking] = useState(false);
  const secs = useRecordingSeconds();
  const previewRef = useRef<HTMLDivElement | null>(null);

  const update = (next: Layer[]) => {
    setLayers(next);
    saveLayers(next);
    void lastshot.setStudioLayers(next).catch(() => undefined);
  };

  // The engine draws the layers into the video. Bring over layers kept only
  // in this window's storage (before the engine had its own copy) once.
  useEffect(() => {
    void lastshot
      .getStudioLayers<Layer>()
      .then((fromEngine) => {
        if (fromEngine === null) {
          if (layers.length) void lastshot.setStudioLayers(layers);
        } else {
          setLayers(fromEngine);
          saveLayers(fromEngine);
        }
      })
      .catch(() => undefined);
    // First load only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live preview from the engine (what is being encoded), ~8 times a second
  // while Studio is on screen. Falls back to a still picture of the screen.
  useEffect(() => {
    let alive = true;
    let lastSeq = -1;
    let misses = 0;
    const tick = async () => {
      if (!alive) return;
      if (document.visibilityState === "visible") {
        try {
          const f = await lastshot.getPreviewFrame();
          if (f && f.seq !== lastSeq && canvasRef.current) {
            lastSeq = f.seq;
            misses = 0;
            const c = canvasRef.current;
            if (c.width !== f.width || c.height !== f.height) {
              c.width = f.width;
              c.height = f.height;
            }
            c.getContext("2d")?.putImageData(new ImageData(f.rgba, f.width, f.height), 0, 0);
            setLive(true);
          } else if (!f && ++misses > 10) {
            setLive(false);
          }
        } catch {
          setLive(false);
        }
      }
      if (alive) window.setTimeout(() => void tick(), 120);
    };
    void tick();
    return () => {
      alive = false;
    };
  }, []);
  const patchLayer = (id: string, p: Partial<Layer>) => update(layers.map((l) => (l.id === id ? { ...l, ...p } : l)));

  const refreshShot = async () => {
    try {
      setShot(await lastshot.screenSnapshot());
    } catch (e) {
      onToast("err", "Could not take a picture of the screen", String(e));
    }
  };
  useEffect(() => {
    void refreshShot();
    // Again when the recorded screen changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.monitorIndex]);

  useEffect(() => {
    if (layers.some((l) => l.path)) void lastshot.allowMedia(layers.flatMap((l) => (l.path ? [l.path] : []))).catch(() => undefined);
    // First load only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadCams = async () => {
    try {
      setCams(await lastshot.listCameras());
    } catch {
      setCams([]);
    }
  };
  useEffect(() => {
    void loadCams();
  }, []);

  const add = async (kind: LayerKind) => {
    if (kind === "image") {
      if (!isTauri()) {
        onToast("info", "Browser preview", "Adding pictures works in the installed app.");
        return;
      }
      const picked = await open({ multiple: false, title: "Pick a picture", filters: [{ name: "Pictures", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }] });
      if (!picked || Array.isArray(picked)) return;
      const path = String(picked);
      await lastshot.allowMedia([path]);
      const img = new Image();
      img.src = assetUrl(path);
      await img.decode().catch(() => undefined);
      const aspect = img.naturalWidth ? img.naturalHeight / img.naturalWidth : 1;
      const l = newLayer("image", { path, name: path.split(/[\\/]/).pop() ?? "Picture", aspect, w: 0.15 });
      update([...layers, l]);
      setSelected(l.id);
      return;
    }
    const l = newLayer(kind);
    update([...layers, l]);
    setSelected(l.id);
    if (kind === "webcam") setTimeout(() => void loadCams(), 1500);
  };

  const drag = (l: Layer, mode: "move" | "size") => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setSelected(l.id);
    const box = previewRef.current?.getBoundingClientRect();
    if (!box) return;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let latest = layers;
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - x0) / box.width;
      const dy = (ev.clientY - y0) / box.height;
      latest = layers.map((x) => {
        if (x.id !== l.id) return x;
        if (mode === "move") return { ...x, x: Math.min(0.99, Math.max(-0.5, l.x + dx)), y: Math.min(0.99, Math.max(-0.5, l.y + dy)) };
        if (l.kind === "image" || l.kind === "webcam") return { ...x, w: Math.max(0.03, l.w + dx) };
        return { ...x, fontSize: Math.max(0.01, (l.fontSize ?? 0.05) + dy) };
      });
      setLayers(latest);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      saveLayers(latest);
      void lastshot.setStudioLayers(latest).catch(() => undefined);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const sel = layers.find((l) => l.id === selected) ?? null;
  const rec = bar?.recording ?? null;
  const mon = monitors.find((m) => m.index === settings.monitorIndex) ?? monitors[0];
  const aspect = live && canvasRef.current
    ? `${canvasRef.current.width} / ${canvasRef.current.height}`
    : shot ? `${shot.width} / ${shot.height}` : mon ? `${mon.width} / ${mon.height}` : "16 / 9";
  // The live picture already shows the layers when the engine draws them.
  const layersInLive = live && (settings.studioLayers === "always" || (settings.studioLayers === "recording" && !!rec));

  return (
    <div className="space-y-4">
      {/* Header + record controls */}
      <div className="panel flex flex-wrap items-center gap-3 rounded-xl px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold text-ink">Studio</h2>
          <p className="text-[12px] text-ink-3">Put pictures, text, your webcam or a clock on top of your recordings.</p>
        </div>
        {rec ? (
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-2 font-mono text-[15px] font-semibold tabular-nums text-ink">
              <span className={cn("h-2.5 w-2.5 rounded-full", rec.paused ? "bg-amber-400" : "animate-pulse bg-red-500")} />
              {clockTime(secs ?? rec.seconds)}
            </span>
            <button type="button" onClick={() => void lastshot.pauseRecording(!rec.paused)} className="rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-[12px] hover:border-line-3">
              {rec.paused ? "Resume" : "Pause"}
            </button>
            <button type="button" onClick={() => void lastshot.stopRecording().catch((e) => onToast("err", "Could not save", String(e)))} className="rounded-lg bg-red-500 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-red-600">
              Stop &amp; save
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void lastshot.startRecording().catch((e) => onToast("err", "Could not start recording", String(e)))}
              className="flex items-center gap-2 rounded-lg bg-red-500 px-3.5 py-1.5 text-[12px] font-semibold text-white hover:bg-red-600"
            >
              <span className="h-2 w-2 rounded-full bg-white" /> Record {sourceLabel(settings.captureSource)}
            </button>
            <button type="button" onClick={() => void lastshot.startSnip("rec")} className="rounded-lg border border-red-500/50 bg-red-500/10 px-3 py-1.5 text-[12px] font-semibold text-danger hover:bg-red-500/20">
              Record area
            </button>
          </div>
        )}
      </div>

      <div className="grid gap-4 xl:grid-cols-[230px_minmax(0,1fr)_270px]">
        {/* Layers */}
        <div className="panel space-y-2 rounded-xl p-3">
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-semibold text-ink">Layers</span>
            <span className="text-[10px] text-ink-3">top = front</span>
          </div>
          {layers.length === 0 && <p className="text-[11px] text-ink-3">No layers yet. Add one below.</p>}
          <div className="space-y-1">
            {[...layers].reverse().map((l) => (
              <div
                key={l.id}
                onClick={() => setSelected(l.id)}
                className={cn(
                  "flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-[11px]",
                  selected === l.id ? "border-accent bg-accent/10" : "border-line bg-surface hover:border-line-3",
                )}
              >
                <button
                  type="button"
                  title={l.visible ? "Hide" : "Show"}
                  onClick={(e) => {
                    e.stopPropagation();
                    patchLayer(l.id, { visible: !l.visible });
                  }}
                  className={cn("w-5 text-center", l.visible ? "text-ink" : "text-ink-4")}
                >
                  {l.visible ? "◉" : "○"}
                </button>
                <span className="min-w-0 flex-1 truncate text-ink">{l.kind === "text" ? `“${l.text}”` : l.name}</span>
                <button type="button" title="Bring forward" onClick={(e) => (e.stopPropagation(), update(restack(layers, l.id, 1)))} className="px-0.5 text-ink-3 hover:text-ink">▲</button>
                <button type="button" title="Send back" onClick={(e) => (e.stopPropagation(), update(restack(layers, l.id, -1)))} className="px-0.5 text-ink-3 hover:text-ink">▼</button>
                <button type="button" title="Remove" onClick={(e) => (e.stopPropagation(), update(layers.filter((x) => x.id !== l.id)))} className="px-0.5 text-ink-3 hover:text-danger">✕</button>
              </div>
            ))}
          </div>
          <div className="pt-1 text-[11px] font-semibold text-ink-3">Add</div>
          <div className="grid grid-cols-2 gap-1.5">
            {KINDS.map((k) => (
              <button key={k.kind} type="button" title={k.hint} onClick={() => void add(k.kind)} className="rounded-md border border-line bg-surface-2 px-2 py-1.5 text-[11px] text-ink-2 hover:border-accent">
                + {k.label}
              </button>
            ))}
          </div>
        </div>

        {/* Preview */}
        <div className="panel space-y-2 rounded-xl p-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-ink-3">
            <span>
              {shot?.name ?? mon?.name ?? "Screen"} · {shot?.width ?? mon?.width}×{shot?.height ?? mon?.height} · drag layers to place them, drag the corner to resize
            </span>
            <button type="button" onClick={() => void refreshShot()} className="rounded-md border border-line bg-surface-2 px-2 py-0.5 hover:border-accent">
              Refresh screen picture
            </button>
          </div>
          <div
            ref={previewRef}
            onPointerDown={() => setSelected(null)}
            className="relative w-full overflow-hidden rounded-lg bg-[#0d0f14]"
            style={{ aspectRatio: aspect, containerType: "size" }}
          >
            <canvas ref={canvasRef} className={cn("absolute inset-0 h-full w-full", !live && "hidden")} />
            {!live && shot?.image && <img src={shot.image} alt="" className="absolute inset-0 h-full w-full object-cover opacity-80" draggable={false} />}
            {live && <span className="absolute right-1.5 top-1.5 z-10 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-semibold text-white">LIVE</span>}
            {layers.map((l) => (
              <div
                key={l.id}
                onPointerDown={drag(l, "move")}
                className={cn("absolute cursor-move", selected === l.id && "outline outline-2 outline-offset-2 outline-accent", !l.visible && "opacity-30")}
                style={{
                  left: `${l.x * 100}%`,
                  top: `${l.y * 100}%`,
                  width: l.kind === "image" || l.kind === "webcam" ? `${l.w * 100}%` : undefined,
                  opacity: layersInLive ? 1 : l.visible ? l.opacity : 0.25,
                }}
              >
                <div style={{ opacity: layersInLive ? 0 : 1 }} className={cn(layersInLive && "outline outline-1 outline-white/40")}>
                  <LayerView layer={l} recordingSeconds={secs} noCamera />
                </div>
                {selected === l.id && (
                  <span onPointerDown={drag(l, "size")} title="Drag to resize" className="absolute -bottom-1.5 -right-1.5 h-3 w-3 cursor-nwse-resize rounded-sm border border-black/40 bg-white" />
                )}
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3 text-[12px]">
            <label className="flex items-center gap-2">
              <span className="text-ink-3">Show layers</span>
              <select
                value={settings.studioLayers}
                onChange={(e) => onPatch({ studioLayers: e.target.value as AppSettings["studioLayers"] })}
                className="rounded-md border border-line bg-surface-2 px-2 py-1 text-ink"
              >
                <option value="recording">While recording</option>
                <option value="always">Always (also in instant replays)</option>
                <option value="off">Off</option>
              </select>
            </label>
            <span className="text-[11px] text-ink-3">
              The recorder draws the layers into the video (replays, recordings and window captures). They are not shown on your screen.
            </span>
          </div>
        </div>

        {/* Properties + recording options */}
        <div className="space-y-4">
          <div className="panel space-y-3 rounded-xl p-3 text-[12px]">
            {!sel ? (
              <p className="text-ink-3">Pick a layer to change it.</p>
            ) : (
              <>
                <div className="font-semibold text-ink">{sel.name}</div>
                {sel.kind === "text" && (
                  <textarea
                    value={sel.text}
                    rows={2}
                    onChange={(e) => patchLayer(sel.id, { text: e.target.value })}
                    className="w-full rounded-md border border-line bg-surface-2 px-2 py-1 text-ink outline-none focus:border-accent"
                  />
                )}
                {(sel.kind === "text" || sel.kind === "clock" || sel.kind === "timer") && (
                  <>
                    <Slider label="Text size" value={(sel.fontSize ?? 0.05) * 100} min={1} max={25} step={0.5} suffix="% of height" onChange={(v) => patchLayer(sel.id, { fontSize: v / 100 })} />
                    <div className="flex items-center gap-2">
                      <input type="color" value={sel.color ?? "#ffffff"} onChange={(e) => patchLayer(sel.id, { color: e.target.value })} />
                      <label className="flex items-center gap-1.5">
                        <input type="checkbox" checked={!!sel.box} onChange={(e) => patchLayer(sel.id, { box: e.target.checked })} /> Dark box behind
                      </label>
                    </div>
                  </>
                )}
                {(sel.kind === "image" || sel.kind === "webcam") && (
                  <Slider label="Size" value={sel.w * 100} min={3} max={100} step={1} suffix="% of width" onChange={(v) => patchLayer(sel.id, { w: v / 100 })} />
                )}
                {sel.kind === "webcam" && (
                  <>
                    <label className="block space-y-1">
                      <span className="text-ink-3">Camera</span>
                      <select
                        value={sel.deviceId ?? ""}
                        onFocus={() => void loadCams()}
                        onChange={(e) => patchLayer(sel.id, { deviceId: e.target.value || undefined })}
                        className="w-full rounded-md border border-line bg-surface-2 px-2 py-1 text-ink"
                      >
                        <option value="">Default camera</option>
                        {cams.map((c, i) => (
                          <option key={c.id || i} value={c.id}>
                            {c.name || `Camera ${i + 1}`}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block space-y-1">
                      <span className="text-ink-3">Shape</span>
                      <select
                        value={sel.shape ?? "rounded"}
                        onChange={(e) => {
                          const shape = e.target.value as Layer["shape"];
                          patchLayer(sel.id, { shape, aspect: shape === "circle" ? 1 : 9 / 16 });
                        }}
                        className="w-full rounded-md border border-line bg-surface-2 px-2 py-1 text-ink"
                      >
                        <option value="rect">Rectangle</option>
                        <option value="rounded">Rounded</option>
                        <option value="circle">Circle</option>
                      </select>
                    </label>
                    <div className="flex gap-3">
                      <label className="flex items-center gap-1.5">
                        <input type="checkbox" checked={!!sel.mirror} onChange={(e) => patchLayer(sel.id, { mirror: e.target.checked })} /> Mirror
                      </label>
                      <label className="flex items-center gap-1.5">
                        <input type="checkbox" checked={!!sel.border} onChange={(e) => patchLayer(sel.id, { border: e.target.checked })} /> Border
                      </label>
                    </div>
                  </>
                )}
                {sel.kind === "image" && (
                  <label className="flex items-center gap-1.5">
                    <input type="checkbox" checked={!!sel.border} onChange={(e) => patchLayer(sel.id, { border: e.target.checked })} /> Border
                  </label>
                )}
                <Slider label="Opacity" value={sel.opacity * 100} min={5} max={100} step={1} suffix="%" onChange={(v) => patchLayer(sel.id, { opacity: v / 100 })} />
              </>
            )}
          </div>

          <div className="panel space-y-2.5 rounded-xl p-3 text-[12px]">
            <div className="font-semibold text-ink">Recording</div>
            <div className="space-y-1">
              <span className="text-ink-3">What to record</span>
              <button
                type="button"
                onClick={() => setPicking(true)}
                disabled={!!rec}
                title={rec ? "Stop the recording to change this" : "Full screen, or one window / app"}
                className="flex w-full items-center justify-between rounded-md border border-line bg-surface-2 px-2 py-1 text-left text-ink hover:border-accent disabled:opacity-50"
              >
                <span className="truncate">{sourceLabel(settings.captureSource)}</span>
                <span className="text-ink-3">Change</span>
              </button>
            </div>
            {settings.captureSource?.kind === "window" && (
              <label className="block space-y-1" title="Crop from screen never touches the app (no added lag), but needs the window visible. Automatic crops while it is visible and switches to Graphics Capture when it is covered.">
                <span className="text-ink-3">Window capture method</span>
                <select
                  value={settings.captureSource.method ?? "auto"}
                  disabled={!!rec}
                  onChange={(e) => settings.captureSource?.kind === "window" && onPatch({ captureSource: { ...settings.captureSource, method: e.target.value as WindowMethod } })}
                  className="w-full rounded-md border border-line bg-surface-2 px-2 py-1 text-ink"
                >
                  <option value="auto">Automatic</option>
                  <option value="crop">Crop from screen</option>
                  <option value="capture">Graphics Capture (works when covered)</option>
                </select>
              </label>
            )}
            {picking && (
              <SourcePicker
                current={settings.captureSource ?? { kind: "display" }}
                monitor={mon}
                actionLabel="Use"
                onPick={(src) => {
                  setPicking(false);
                  onPatch({ captureSource: src });
                }}
                onClose={() => setPicking(false)}
              />
            )}
            <label className="block space-y-1">
              <span className="text-ink-3">Screen</span>
              <select value={settings.monitorIndex} onChange={(e) => onPatch({ monitorIndex: Number(e.target.value) })} className="w-full rounded-md border border-line bg-surface-2 px-2 py-1 text-ink">
                {monitors.map((m) => (
                  <option key={m.index} value={m.index}>
                    {m.name.replace(/^\\\\\.\\/, "")} · {m.width}×{m.height}
                    {m.primary ? " (main)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1">
              <span className="text-ink-3">Frame rate</span>
              <select value={settings.targetFps} onChange={(e) => onPatch({ targetFps: Number(e.target.value) })} className="w-full rounded-md border border-line bg-surface-2 px-2 py-1 text-ink">
                {[30, 60, 120].map((f) => (
                  <option key={f} value={f}>
                    {f} fps
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2" title={rec ? "Stop the recording to change this" : undefined}>
              <input type="checkbox" checked={settings.captureCursor !== false} disabled={!!rec} onChange={(e) => onPatch({ captureCursor: e.target.checked })} /> Mouse pointer
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={settings.captureSystemAudio} onChange={(e) => onPatch({ captureSystemAudio: e.target.checked })} /> PC sound
            </label>
            {settings.captureSystemAudio && (
              <div title={rec ? "Stop the recording to change this" : "Record only the game, or leave out a voice chat"}>
                <AppAudioPicker
                  value={settings.appAudio}
                  disabled={!!rec}
                  windowExe={settings.captureSource?.kind === "window" ? settings.captureSource.exe : undefined}
                  onChange={(v) => onPatch({ appAudio: v })}
                />
              </div>
            )}
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={settings.captureMicrophone} onChange={(e) => onPatch({ captureMicrophone: e.target.checked })} /> Microphone
            </label>
            {settings.captureMicrophone && (
              <Slider label="Microphone volume" value={settings.micVolume * 100} min={0} max={200} step={5} suffix="%" onChange={(v) => onPatch({ micVolume: v / 100 })} />
            )}
            <label className="block space-y-1">
              <span className="text-ink-3">Control bar</span>
              <select value={settings.controlBar} onChange={(e) => onPatch({ controlBar: e.target.value as AppSettings["controlBar"] })} className="w-full rounded-md border border-line bg-surface-2 px-2 py-1 text-ink">
                <option value="recording">While recording</option>
                <option value="always">Always</option>
                <option value="off">Off</option>
              </select>
            </label>
            <p className="text-[11px] text-ink-3">Shortcut: {settings.hotkeyRecord} starts / stops. More in Settings.</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function Slider({ label, value, min, max, step, suffix, onChange }: { label: string; value: number; min: number; max: number; step: number; suffix?: string; onChange: (v: number) => void }) {
  return (
    <label className="block space-y-1">
      <span className="flex justify-between text-ink-3">
        {label}
        <span className="font-mono text-ink-2">
          {Number.isInteger(step) ? Math.round(value) : value.toFixed(1)}
          {suffix}
        </span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-[var(--color-accent)]" />
    </label>
  );
}
