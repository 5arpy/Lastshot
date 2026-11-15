import { useEffect, useRef, useState } from "react";
import { assetUrl, lastshot } from "../lib/bridge";
import { type Layer, LAYERS_KEY, loadLayers } from "../lib/studio";
import { clockTime } from "./ControlBar";

/**
 * One layer, sized in container units so the same code draws the small
 * preview in Studio and the full-screen layer window.
 */
export function LayerView({
  layer,
  recordingSeconds,
  imageUrl,
}: {
  layer: Layer;
  recordingSeconds: number | null;
  imageUrl?: string;
}) {
  const l = layer;
  const textStyle = {
    fontSize: `${(l.fontSize ?? 0.05) * 100}cqh`,
    color: l.color ?? "#fff",
    background: l.box ? "rgba(0,0,0,0.55)" : undefined,
    padding: l.box ? "0.25em 0.5em" : undefined,
    borderRadius: l.box ? "0.3em" : undefined,
    textShadow: l.box ? undefined : "0 0.04em 0.15em rgba(0,0,0,0.8)",
    fontFamily: '"Segoe UI", system-ui, sans-serif',
    fontWeight: 700,
    lineHeight: 1.2,
    whiteSpace: "pre" as const,
    display: "inline-block",
  };
  if (l.kind === "text") return <div style={textStyle}>{l.text}</div>;
  if (l.kind === "clock") return <Clock style={textStyle} />;
  if (l.kind === "timer")
    return (
      <div style={textStyle}>
        <span style={{ color: "#ff5a5f" }}>● </span>
        {recordingSeconds != null ? clockTime(recordingSeconds) : "0:00"}
      </div>
    );
  const radius = l.shape === "circle" ? "50%" : l.shape === "rounded" ? "6%" : 0;
  const frame = {
    width: "100%",
    aspectRatio: `1 / ${l.aspect}`,
    borderRadius: radius,
    overflow: "hidden" as const,
    boxShadow: l.border ? "0 0 0 0.25cqh rgba(255,255,255,0.9), 0 0.5cqh 2cqh rgba(0,0,0,0.5)" : undefined,
  };
  if (l.kind === "webcam") return <Webcam layer={l} style={frame} />;
  return (
    <div style={frame}>
      <img src={imageUrl ?? (l.path ? assetUrl(l.path) : "")} alt="" draggable={false} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
    </div>
  );
}

function Clock({ style }: { style: React.CSSProperties }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return <div style={style}>{now.toLocaleTimeString()}</div>;
}

function Webcam({ layer, style }: { layer: Layer; style: React.CSSProperties }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stream: MediaStream | null = null;
    let alive = true;
    const start = async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          video: layer.deviceId ? { deviceId: { exact: layer.deviceId }, width: 1280, height: 720 } : { width: 1280, height: 720 },
          audio: false,
        });
        if (!alive) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        setError(null);
        if (ref.current) ref.current.srcObject = s;
      } catch (e) {
        setError(String(e).includes("NotFound") ? "No webcam found" : "Webcam not available");
      }
    };
    void start();
    return () => {
      alive = false;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [layer.deviceId]);
  return (
    <div style={{ ...style, background: "#111" }}>
      {error ? (
        <div style={{ display: "grid", placeItems: "center", height: "100%", color: "#bbb", fontSize: "1.6cqh", fontFamily: "sans-serif" }}>{error}</div>
      ) : (
        <video
          ref={ref}
          autoPlay
          muted
          playsInline
          style={{ width: "100%", height: "100%", objectFit: "cover", transform: layer.mirror ? "scaleX(-1)" : undefined, display: "block" }}
        />
      )}
    </div>
  );
}

/** Live recording seconds from the backend (null when not recording). */
export function useRecordingSeconds(): number | null {
  const [base, setBase] = useState<{ s: number; at: number; paused: boolean } | null>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    const apply = (b: Awaited<ReturnType<typeof lastshot.getBarState>>) =>
      setBase(b.recording ? { s: b.recording.seconds, at: Date.now(), paused: b.recording.paused } : null);
    void lastshot.getBarState().then(apply).catch(() => undefined);
    const off = lastshot.onRecording(apply);
    const t = setInterval(() => tick((x) => x + 1), 500);
    return () => {
      void off.then((f) => f());
      clearInterval(t);
    };
  }, []);
  if (!base) return null;
  return base.paused ? base.s : base.s + (Date.now() - base.at) / 1000;
}

/** The layer window: transparent, click-through, over the recorded screen. */
export default function SceneWindow() {
  const [layers, setLayers] = useState(loadLayers);
  const secs = useRecordingSeconds();
  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    const onStorage = (e: StorageEvent) => {
      if (e.key === LAYERS_KEY) setLayers(loadLayers());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  return (
    <div style={{ position: "fixed", inset: 0, containerType: "size", overflow: "hidden", pointerEvents: "none" }}>
      {layers
        .filter((l) => l.visible)
        .map((l) => (
          <div key={l.id} style={{ position: "absolute", left: `${l.x * 100}%`, top: `${l.y * 100}%`, width: l.kind === "image" || l.kind === "webcam" ? `${l.w * 100}%` : undefined, opacity: l.opacity }}>
            <LayerView layer={l} recordingSeconds={secs} />
          </div>
        ))}
    </div>
  );
}
