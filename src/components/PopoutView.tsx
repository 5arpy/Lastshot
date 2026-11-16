import { useCallback, useEffect, useRef, useState } from "react";
import { lastshot } from "../lib/bridge";
import { popout, type PopView } from "../lib/audio";
import type { AppSettings, BarState, ClipMetadata, MonitorInfo } from "../lib/types";
import { cn } from "../utils/cn";
import AudioPanel from "./AudioPanel";
import EditorView from "../editor/EditorView";
import StudioPanel from "./StudioPanel";

/**
 * A tab in a window of its own (`pop-audio`, `pop-editor`, `pop-studio`).
 * It carries only what that tab needs; instant replay, hotkeys and the rest
 * stay with the main window. Closing this window docks the tab back.
 */

type Tone = "ok" | "err" | "warn" | "info";
interface Toast {
  id: number;
  tone: Tone;
  title: string;
  body?: string;
}

const TONES: Record<Tone, string> = {
  ok: "border-emerald-500/40",
  warn: "border-amber-500/40",
  err: "border-red-500/40",
  info: "border-accent/40",
};

const NAMES: Record<PopView, string> = { audio: "Audio", editor: "Editor", studio: "Studio" };

export default function PopoutView({ view }: { view: PopView }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(0);
  const pushToast = useCallback((tone: Tone, title: string, body?: string) => {
    const id = ++next.current;
    setToasts((t) => [...t, { id, tone, title, body }].slice(-4));
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);

  useEffect(() => {
    document.title = `Lastshot – ${NAMES[view]}`;
  }, [view]);

  return (
    <div className="relative flex h-screen w-screen flex-col overflow-hidden bg-app text-ink">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-line bg-surface px-4 select-none">
        <span className="text-[12px] font-semibold text-ink-2">{NAMES[view]}</span>
        <button
          type="button"
          onClick={() => void popout.close(view)}
          title="Close this window and show the tab in the main window again"
          className="flex items-center gap-1.5 rounded-md border border-line bg-surface-2 px-2.5 py-1 text-[11px] font-medium text-ink-3 hover:text-ink"
        >
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-none stroke-current" strokeWidth="1.5">
            <path d="M6 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5V10M9 7l5-5M9 7V3.5M9 7h3.5" />
          </svg>
          Back to the main window
        </button>
      </div>
      <main className="flex-1 overflow-y-auto">
        {view === "audio" ? (
          <div className="mx-auto max-w-[1440px] p-5">
            <AudioPanel active onToast={pushToast} />
          </div>
        ) : view === "editor" ? (
          <EditorHost onToast={pushToast} />
        ) : (
          <StudioHost onToast={pushToast} />
        )}
      </main>
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[320px] flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn("animate-toast pointer-events-auto rounded-xl border bg-surface px-3.5 py-2.5 text-ink shadow-xl", TONES[t.tone])}
          >
            <div className="text-[12px] font-semibold tracking-wide">{t.title}</div>
            {t.body && <div className="mt-1 break-words text-[11px] text-ink-3">{t.body}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

function EditorHost({ onToast }: { onToast: (tone: Tone, title: string, body?: string) => void }) {
  const [clips, setClips] = useState<ClipMetadata[]>([]);
  useEffect(() => {
    const load = () =>
      lastshot
        .getClips(false)
        .then(setClips)
        .catch(() => undefined);
    void load();
    let off: (() => void) | undefined;
    void Promise.resolve(lastshot.onClipSaved(() => void load())).then((u) => (off = u));
    return () => off?.();
  }, []);
  return (
    <div className="h-full min-h-[560px]">
      <EditorView
        clips={clips}
        incoming={null}
        onToast={onToast}
        onRendered={(c) => setClips((prev) => [c, ...prev.filter((x) => x.path !== c.path)])}
        onClipsChanged={() =>
          void lastshot
            .getClips(false)
            .then(setClips)
            .catch(() => undefined)
        }
      />
    </div>
  );
}

function StudioHost({ onToast }: { onToast: (tone: Tone, title: string, body?: string) => void }) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [bar, setBar] = useState<BarState | null>(null);
  useEffect(() => {
    void lastshot.getSettings().then(setSettings).catch((e) => onToast("err", "Could not load settings", String(e)));
    void lastshot.getMonitors().then(setMonitors).catch(() => undefined);
    void lastshot.getBarState().then(setBar).catch(() => undefined);
    let off: (() => void) | undefined;
    void Promise.resolve(lastshot.onRecording(setBar)).then((u) => (off = u));
    return () => off?.();
  }, [onToast]);
  if (!settings) return null;
  return (
    <div className="mx-auto max-w-[1440px] p-5">
      <StudioPanel
        settings={settings}
        monitors={monitors}
        bar={bar}
        onToast={onToast}
        onPatch={(p) =>
          void lastshot
            .updateSettings(p)
            .then(setSettings)
            .catch((e) => onToast("err", "Could not save", String(e)))
        }
      />
    </div>
  );
}
