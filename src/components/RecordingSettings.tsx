/**
 * Settings for how video is encoded (Instant replay › Advanced) and the
 * screen recording options (Screen recording › More options). The best
 * choice is the default and the main control; every value can be typed.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { lastshot } from "../lib/bridge";
import type { AppSettings, EncoderBackend, EncoderCaps, EncoderPreset, EngineStats, RateControl, VideoCodec } from "../lib/types";
import { formatBytes } from "../lib/format";
import {
  CODEC_LABEL,
  DEFAULT_RECORD_NAME,
  RECORD_NAME_TOKENS,
  backendFound,
  codecNote,
  codecSupport,
  hardwareEncoders,
  insertToken,
} from "../lib/recordOptions";
import { cn } from "../utils/cn";
import { AdvancedButton, Choice, Row, Toggle, useAdvanced } from "./ui";
import NumberField from "./NumberField";
import PresetOrCustom from "./PresetOrCustom";

type Patch = (patch: Partial<AppSettings>) => void;

const SELECT = "rounded border border-line bg-app px-2 py-1 text-[11px] text-ink outline-none focus:border-accent";
const FIELD = "w-16 rounded border border-line bg-app px-2 py-1 text-right font-mono text-[12px] text-ink outline-none focus:border-accent";

/** A plain-words error from a rejected command. */
const plainError = (e: unknown) => String(e).replace(/^Error:\s*/, "");

// ------------------------------------------------------------ video quality

const CODECS: VideoCodec[] = ["h264", "hevc", "av1"];

const RATE_HINT: Record<RateControl, string> = {
  vbr: "Variable: about the bitrate below, more when the picture moves a lot. Best for recordings.",
  cbr: "Constant: the same bitrate all the time, like streaming. The file size is predictable.",
  cqp: "Constant quality: the same quality all the time; the file size follows how busy the picture is.",
};

const PRESET_HINT: Record<Exclude<EncoderPreset, "auto">, string> = {
  speed: "Lightest on your PC; a bit less detail at the same bitrate.",
  balanced: "Between speed and quality.",
  quality: "Most detail for the bitrate; works the graphics card harder, which can cost game frames.",
};

const BACKENDS: { value: EncoderBackend; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "nvidia", label: "NVIDIA" },
  { value: "amd", label: "AMD" },
  { value: "intel", label: "Intel" },
  { value: "software", label: "CPU" },
];

/** Bitrate slider range (Mbit/s); the typed field goes further. */
const SLIDER_MAX_MBIT = 60;
const MAX_MBIT = 150;

/**
 * Codec, bitrate mode, bitrate or quality level, keyframes and speed /
 * quality, plus the encoder hardware behind its own Advanced button.
 */
export function VideoQualityRows({ settings, stats, onChange }: { settings: AppSettings; stats: EngineStats; onChange: Patch }) {
  const [caps, setCaps] = useState<EncoderCaps | null>(null);
  useEffect(() => {
    let alive = true;
    void lastshot
      .encoderCaps()
      .then((c) => alive && setCaps(c))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  const [hwOpen, toggleHw] = useAdvanced("encoder-hardware");

  // The slider moves live; the setting changes when it is let go.
  const [bitrate, setBitrate] = useState(settings.bitrateKbps);
  useEffect(() => setBitrate(settings.bitrateKbps), [settings.bitrateKbps]);
  const commitBitrate = () => bitrate !== settings.bitrateKbps && onChange({ bitrateKbps: bitrate });
  const projectedRam = ((settings.bufferSeconds * bitrate * 1000) / 8) * 1.6;

  const codec = settings.codec;
  const note = codecNote(caps, codec);
  const missing = !!caps && codecSupport(caps, codec) === "none";
  const live = stats.state !== "idle" && stats.state !== "error" && stats.encoder.vendor !== "unavailable";
  const inUse = live
    ? `${stats.encoder.friendly_name} · ${stats.encoder.codec}${stats.encoder.hardware ? "" : " (on the CPU)"}`
    : null;
  const found = hardwareEncoders(caps);
  const backendOk = backendFound(caps, settings.encoderBackend);

  return (
    <>
      <Row
        label="Video codec"
        hint={
          <>
            H.264 plays everywhere. HEVC and AV1 make smaller files at the same quality, but some apps and phones can't play them.
            {note && (
              <span className="mt-1 block text-warn" data-testid="codec-note">
                {CODEC_LABEL[codec]}: {note}
                {missing && codec === "av1" && " AV1 needs an RTX 40, RX 7000 or Intel Arc graphics card."}
              </span>
            )}
            {inUse && <span className="mt-1 block">In use now: {inUse}</span>}
          </>
        }
      >
        <Choice
          options={CODECS.map((c) => {
            const n = codecNote(caps, c);
            return { value: c, label: CODEC_LABEL[c], title: n ?? undefined, dim: !!caps && codecSupport(caps, c) === "none" };
          })}
          value={codec}
          onPick={(c) => onChange({ codec: c })}
        />
      </Row>
      <Row label="Bitrate mode" hint={RATE_HINT[settings.rateControl]}>
        <Choice
          options={[
            { value: "vbr" as const, label: "VBR", title: `${RATE_HINT.vbr} (Default)` },
            { value: "cbr" as const, label: "CBR", title: RATE_HINT.cbr },
            { value: "cqp" as const, label: "CQP", title: RATE_HINT.cqp },
          ]}
          value={settings.rateControl}
          onPick={(r) => onChange({ rateControl: r })}
        />
      </Row>
      {settings.rateControl === "cqp" ? (
        <Row
          label="Quality level"
          hint="Lower is better quality and bigger files: 18 looks almost lossless, 23 is a good default, 28 makes small files (1-51)."
        >
          <PresetOrCustom
            value={settings.cqpLevel}
            presets={[
              { value: 18, label: "18 · very high" },
              { value: 23, label: "23 · good (default)" },
              { value: 28, label: "28 · small files" },
            ]}
            min={1}
            max={51}
            step={1}
            onChange={(v) => onChange({ cqpLevel: v })}
            aria-label="Quality level"
            className={SELECT}
            fieldClassName={FIELD}
          />
        </Row>
      ) : (
        <Row
          label={settings.rateControl === "vbr" ? "Bitrate (average)" : "Bitrate"}
          hint={`Memory used by the buffer: about ${formatBytes(projectedRam)}. Up to ${MAX_MBIT} Mbit/s typed.`}
        >
          <div className="flex items-center gap-2">
            <input
              type="range"
              className="cf-range w-36"
              min={1000}
              max={SLIDER_MAX_MBIT * 1000}
              step={1000}
              value={Math.min(bitrate, SLIDER_MAX_MBIT * 1000)}
              aria-label="Bitrate"
              onChange={(e) => setBitrate(Number(e.target.value))}
              onPointerUp={commitBitrate}
              onKeyUp={commitBitrate}
              onBlur={commitBitrate}
            />
            <span className="flex items-center gap-1 text-[12px] text-ink-3">
              <NumberField
                value={bitrate / 1000}
                min={1}
                max={MAX_MBIT}
                step={1}
                digits={1}
                onChange={(v) => onChange({ bitrateKbps: Math.round(v * 1000) })}
                aria-label="Bitrate in Mbit/s"
                className={FIELD}
              />
              Mbit/s
            </span>
          </div>
        </Row>
      )}
      <Row
        label="Keyframe every"
        hint="Shorter: a saved replay starts closer to the moment, and jumping around a clip is snappier. Longer: slightly smaller files. 0.25 to 10 s."
      >
        <PresetOrCustom
          value={settings.keyframeSeconds}
          presets={[
            { value: 0.5, label: "0.5 s" },
            { value: 1, label: "1 s (default)" },
            { value: 2, label: "2 s" },
            { value: 5, label: "5 s" },
          ]}
          min={0.25}
          max={10}
          step={0.25}
          digits={2}
          unit="s"
          onChange={(v) => onChange({ keyframeSeconds: v })}
          aria-label="Keyframe interval"
          className={SELECT}
          fieldClassName={FIELD}
        />
      </Row>
      <Row
        label="Speed or quality"
        hint={
          settings.encoderPreset === "auto"
            ? `Follows Game Mode: Speed while it is on${settings.performanceMode ? " (it is on now)" : ""}, so your game keeps its frames.`
            : PRESET_HINT[settings.encoderPreset]
        }
      >
        <Choice
          options={[
            { value: "auto" as const, label: "Auto", title: "Speed while Game Mode is on (Default)" },
            { value: "speed" as const, label: "Speed", title: PRESET_HINT.speed },
            { value: "balanced" as const, label: "Balanced", title: PRESET_HINT.balanced },
            { value: "quality" as const, label: "Quality", title: PRESET_HINT.quality },
          ]}
          value={settings.encoderPreset}
          onPick={(p) => onChange({ encoderPreset: p })}
        />
      </Row>
      <div className="flex items-center justify-between gap-2 border-b border-line py-2.5">
        <span className="text-[12px] text-ink-3">Which chip encodes the video</span>
        <AdvancedButton open={hwOpen} onClick={toggleHw} label="Encoder hardware" />
      </div>
      {hwOpen && (
        <Row
          label="Encode with"
          hint={
            <>
              {settings.encoderBackend === "auto"
                ? "Auto: the graphics card that draws your screen, then any other one, then the CPU."
                : settings.encoderBackend === "software"
                  ? "The CPU: works everywhere, but costs the most game frames."
                  : "Only this maker's graphics card."}
              {caps && (
                <span className="mt-1 block">
                  Found on this PC: {found.length ? found.join(", ") : "no graphics card encoder"}
                  {caps.codecs.some((c) => c.software) ? ", and the CPU" : ""}.
                </span>
              )}
              {backendOk === false && <span className="mt-1 block text-warn">Not found on this PC.</span>}
            </>
          }
        >
          <Choice
            options={BACKENDS.map((b) => {
              const ok = backendFound(caps, b.value);
              return { ...b, dim: ok === false, title: ok === false ? "Not found on this PC" : undefined };
            })}
            value={settings.encoderBackend}
            onPick={(b) => onChange({ encoderBackend: b })}
          />
        </Row>
      )}
    </>
  );
}

// ------------------------------------------------------------ file name

/** File name pattern with a live preview, a Default button and token chips. */
export function RecordFileNameRow({ value, format, onCommit }: { value: string; format: string; onCommit: (v: string) => void }) {
  const [draft, setDraftState] = useState(value);
  const draftRef = useRef(draft);
  const setDraft = (s: string) => {
    draftRef.current = s;
    setDraftState(s);
  };
  const editing = useRef(false);
  const valueRef = useRef(value);
  valueRef.current = value;
  useEffect(() => {
    if (!editing.current) setDraft(value);
  }, [value]);
  const input = useRef<HTMLInputElement | null>(null);
  /** Where a token goes when the field is not focused (the last caret). */
  const lastSel = useRef<[number, number] | null>(null);
  const [preview, setPreview] = useState<{ name: string } | { err: string } | null>(null);
  /** Shown for a moment after a name that could not be saved. */
  const [rejected, setRejected] = useState<string | null>(null);

  // Live preview, a moment after the last key; the newest answer wins.
  const seq = useRef(0);
  useEffect(() => {
    const n = ++seq.current;
    if (!draft.trim()) {
      setPreview({ err: "Type a name, or press Default." });
      return;
    }
    const t = window.setTimeout(() => {
      lastshot
        .previewRecordFileName(draft)
        .then((name) => n === seq.current && setPreview({ name }))
        .catch((e) => n === seq.current && setPreview({ err: plainError(e) }));
    }, 150);
    return () => window.clearTimeout(t);
  }, [draft, format]);

  useEffect(() => {
    if (!rejected) return;
    const t = window.setTimeout(() => setRejected(null), 6000);
    return () => window.clearTimeout(t);
  }, [rejected]);

  const commit = async (next = draftRef.current.trim()) => {
    if (next === valueRef.current) {
      setDraft(next);
      return;
    }
    if (!next) {
      setDraft(valueRef.current);
      setRejected("Not saved: the name was empty.");
      return;
    }
    try {
      await lastshot.previewRecordFileName(next);
      setRejected(null);
      onCommit(next);
    } catch (e) {
      // Only put the old name back if nothing new was typed meanwhile.
      if (!editing.current) setDraft(valueRef.current);
      setRejected(`Not saved: ${plainError(e)}`);
    }
  };

  // Leaving Settings while typing still keeps a good name.
  const commitRef = useRef(commit);
  commitRef.current = commit;
  useEffect(
    () => () => {
      if (editing.current) void commitRef.current();
    },
    [],
  );

  const addToken = (token: string) => {
    const el = input.current;
    const focused = !!el && document.activeElement === el;
    const [a, b] = focused ? [el!.selectionStart ?? draft.length, el!.selectionEnd ?? draft.length] : (lastSel.current ?? [draft.length, draft.length]);
    const r = insertToken(draftRef.current, a, b, token);
    setDraft(r.text);
    lastSel.current = [r.caret, r.caret];
    editing.current = true;
    el?.focus();
    requestAnimationFrame(() => input.current?.setSelectionRange(r.caret, r.caret));
  };

  const custom = draft.trim() !== DEFAULT_RECORD_NAME;
  return (
    <div className="border-b border-line py-3.5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-ink">File name</div>
          <div className="mt-0.5 text-[12px] leading-normal text-ink-3">
            Click a token to put it at the cursor. Enter saves, Escape undoes.
          </div>
        </div>
        {(value !== DEFAULT_RECORD_NAME || draft !== value) && (
          <button
            type="button"
            // No blur commit of the half-typed name first.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              editing.current = false;
              setDraft(DEFAULT_RECORD_NAME);
              void commit(DEFAULT_RECORD_NAME);
            }}
            title={`Back to ${DEFAULT_RECORD_NAME}`}
            className="shrink-0 rounded border border-line bg-surface-2 px-3 py-1 text-[11px] font-medium text-ink hover:border-accent"
          >
            Default
          </button>
        )}
      </div>
      <input
        ref={input}
        value={draft}
        spellCheck={false}
        autoComplete="off"
        aria-label="Recording file name"
        aria-invalid={!!preview && "err" in preview}
        data-testid="record-file-name"
        onFocus={() => (editing.current = true)}
        onChange={(e) => setDraft(e.target.value)}
        onSelect={(e) => (lastSel.current = [e.currentTarget.selectionStart ?? 0, e.currentTarget.selectionEnd ?? 0])}
        onBlur={() => {
          editing.current = false;
          void commit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            // Saves and keeps the cursor here, like the number fields.
            e.preventDefault();
            void commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setDraft(valueRef.current);
            setRejected(null);
          }
        }}
        className={cn(
          "mt-2 w-full rounded border bg-app px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none",
          preview && "err" in preview ? "border-red-500/60 focus:border-red-400" : "border-line focus:border-accent",
        )}
      />
      <div className="mt-1 min-h-[16px] text-[11px]" aria-live="polite">
        {rejected ? (
          <span className="text-danger">{rejected}</span>
        ) : preview && "err" in preview ? (
          <span className="text-danger">{preview.err}</span>
        ) : preview ? (
          <span className="block truncate text-ink-3" title={preview.name}>
            Gives: <span className="font-mono text-ink-2">{preview.name}</span>
          </span>
        ) : null}
      </div>
      <div className="mt-2 flex flex-wrap gap-1" role="group" aria-label="Tokens">
        {RECORD_NAME_TOKENS.map((t) => (
          <button
            key={t.token}
            type="button"
            title={t.hint}
            // Keeps the cursor (and the selection) in the field.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => addToken(t.token)}
            className="rounded border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-ink-3 hover:border-accent hover:text-ink"
          >
            {t.token}
          </button>
        ))}
      </div>
      {custom && (
        <p className="mt-2 text-[11px] text-ink-3">
          With your own pattern, Clips may show less about a recording: it reads the app and the kind from names like the default one.
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------- screen recording

/**
 * Screen recording › More options: `top` (countdown, pause key), format,
 * name, limits, and the disk reserve under Advanced. The section itself
 * keeps only what most people change: the key, the folder, the bar.
 */
export function ScreenRecordingMore({ settings, onChange, top }: { settings: AppSettings; onChange: Patch; top?: ReactNode }) {
  const [advOpen, toggleAdv] = useAdvanced("screen-disk");
  const mkv = settings.recordingFormat === "mkv";
  return (
    <>
      {top}
      <Row
        label="File format"
        hint={
          mkv
            ? "MKV, for OBS habits. Some players and editors can't open it."
            : "MP4 plays everywhere, and a crash or power cut still leaves a playable file."
        }
      >
        <Choice
          options={[
            { value: "mp4" as const, label: "MP4" },
            { value: "mkv" as const, label: "MKV" },
          ]}
          value={settings.recordingFormat}
          onPick={(f) => onChange({ recordingFormat: f })}
        />
      </Row>
      {mkv && (
        <Row
          label="Convert to MP4 after recording"
          hint={
            settings.remuxMkv
              ? "Takes seconds, without re-encoding. The MKV is removed once the MP4 is checked."
              : "MKV files show in Clips as plain files: to edit one, right-click it › Convert to MP4."
          }
        >
          <Toggle on={settings.remuxMkv} onClick={() => onChange({ remuxMkv: !settings.remuxMkv })} label="Convert to MP4 after recording" />
        </Row>
      )}
      <RecordFileNameRow
        value={settings.recordFileName || DEFAULT_RECORD_NAME}
        format={settings.recordingFormat}
        onCommit={(v) => onChange({ recordFileName: v })}
      />
      <Row
        label="If the file name is taken"
        hint={
          settings.recordIfExists === "overwrite"
            ? "The old file goes to the Recycle Bin."
            : 'Adds " 2", " 3"… to the new name. Nothing is replaced.'
        }
      >
        <Choice
          options={[
            { value: "number" as const, label: "Add a number" },
            { value: "overwrite" as const, label: "Replace" },
          ]}
          value={settings.recordIfExists}
          onPick={(v) => onChange({ recordIfExists: v })}
        />
      </Row>
      <Row
        label="Stop after"
        hint={
          settings.recordMaxMinutes > 0
            ? "The recording stops and saves by itself. Paused time doesn't count."
            : "No time limit: records until you stop it."
        }
      >
        <PresetOrCustom
          value={settings.recordMaxMinutes}
          presets={[
            { value: 0, label: "No limit" },
            { value: 10, label: "10 min" },
            { value: 30, label: "30 min" },
            { value: 60, label: "1 hour" },
            { value: 120, label: "2 hours" },
          ]}
          min={0}
          max={6000}
          step={1}
          emptyValue={0}
          unit="min"
          onChange={(v) => onChange({ recordMaxMinutes: v })}
          aria-label="Stop after minutes"
          className={SELECT}
          fieldClassName={FIELD}
        />
      </Row>
      <Row
        label="Stop at file size"
        hint={
          settings.recordMaxGb > 0
            ? "The recording stops and saves when the file reaches this size. 4 GB fits FAT32 USB drives."
            : "No size limit. FAT32 USB drives can't hold files over 4 GB."
        }
      >
        <PresetOrCustom
          value={settings.recordMaxGb}
          presets={[
            { value: 0, label: "No limit" },
            { value: 2, label: "2 GB" },
            { value: 4, label: "4 GB (FAT32)" },
            { value: 10, label: "10 GB" },
            { value: 50, label: "50 GB" },
          ]}
          min={0}
          max={10000}
          step={0.5}
          digits={1}
          emptyValue={0}
          unit="GB"
          onChange={(v) => onChange({ recordMaxGb: v })}
          aria-label="Stop at file size in GB"
          className={SELECT}
          fieldClassName={FIELD}
        />
      </Row>
      <div className="flex items-center justify-between gap-2 border-b border-line py-2.5 last:border-0">
        <span className="text-[12px] text-ink-3">Free space Lastshot keeps on the drive</span>
        <AdvancedButton open={advOpen} onClick={toggleAdv} />
      </div>
      {advOpen && (
        <Row
          label="Keep free on the drive"
          hint="The recording stops, and keeps what it has, when the drive's free space drops below this, so Windows and your games still have room. A warning shows before that."
        >
          <PresetOrCustom
            value={settings.diskReserveMb}
            presets={[
              { value: 512, label: "0.5 GB" },
              { value: 1024, label: "1 GB (default)" },
              { value: 2048, label: "2 GB" },
              { value: 5120, label: "5 GB" },
              { value: 10240, label: "10 GB" },
            ]}
            min={0.1}
            max={500}
            step={0.5}
            scale={1024}
            digits={2}
            unit="GB"
            onChange={(v) => onChange({ diskReserveMb: v })}
            aria-label="Keep free on the drive in GB"
            className={SELECT}
            fieldClassName={FIELD}
          />
        </Row>
      )}
    </>
  );
}

/** Countdown before a recording starts: Off, 3, 5, 10 s or any number up to 60. */
export function CountdownRow({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <Row
      label="Countdown"
      hint={
        value > 0
          ? `Recording starts ${value} s after you press the shortcut, so you can switch to your game. Cancel it from the control bar or Home.`
          : "Starts at once. A few seconds give you time to switch windows first."
      }
    >
      <PresetOrCustom
        value={value}
        presets={[
          { value: 0, label: "Off" },
          { value: 3, label: "3 s" },
          { value: 5, label: "5 s" },
          { value: 10, label: "10 s" },
        ]}
        min={0}
        max={60}
        step={1}
        emptyValue={0}
        unit="s"
        onChange={onChange}
        aria-label="Countdown in seconds"
        className={SELECT}
        fieldClassName={FIELD}
      />
    </Row>
  );
}
