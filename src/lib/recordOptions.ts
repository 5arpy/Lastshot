/**
 * Screen recording and encoder options, without the DOM: the file name
 * template (tokens, a local preview for the browser, inserting a token at the
 * cursor), what the PC can encode (labels, the codec fallback), and how the
 * time left and the countdown read.
 */
import type { EncoderBackend, EncoderCaps, VideoCodec } from "./types";

// ------------------------------------------------------------- file names

export const DEFAULT_RECORD_NAME = "{app} Recording {date} {time}";

/** The tokens a file name can use, with what each gives. */
export const RECORD_NAME_TOKENS: { token: string; hint: string }[] = [
  { token: "{app}", hint: "The game or app being recorded" },
  { token: "{date}", hint: "Date, like 2026-11-17" },
  { token: "{time}", hint: "Time, like 20-15-03" },
  { token: "{year}", hint: "Year, like 2026" },
  { token: "{month}", hint: "Month, 01-12" },
  { token: "{day}", hint: "Day of the month, 01-31" },
  { token: "{hour}", hint: "Hour, 00-23" },
  { token: "{minute}", hint: "Minute, 00-59" },
  { token: "{second}", hint: "Second, 00-59" },
  { token: "{res}", hint: "Resolution, like 1920x1080" },
  { token: "{fps}", hint: "Frame rate, like 60 (type {fps}fps for 60fps)" },
  { token: "{codec}", hint: "Video codec: H264, HEVC or AV1" },
];

/** Characters Windows does not allow in a file name. */
const BAD_CHARS = /[:*?"<>|/\\]/;

/** Why a template cannot be a file name, in plain words, or null when it can. */
export function recordNameError(template: string): string | null {
  if (!template.trim()) return "Type a name, or press Default.";
  if (BAD_CHARS.test(template)) return 'A file name can\'t contain : * ? " < > | / \\';
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(template)) return "A file name can't contain control characters.";
  // Same words as the app's own check.
  const known = new Set(RECORD_NAME_TOKENS.map((t) => t.token.toLowerCase()));
  const unknown = template.match(/\{[^{}]*\}/g)?.find((t) => !known.has(t.toLowerCase()));
  if (unknown) return `Unknown name part ${unknown}. These work: ${RECORD_NAME_TOKENS.map((t) => t.token).join(" ")}.`;
  return null;
}

export interface NameContext {
  app: string;
  at: Date;
  width: number;
  height: number;
  fps: number;
  codec: VideoCodec;
  ext: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * The file name a template gives (the browser preview; the installed app asks
 * the backend). Unknown tokens stay as typed (recordNameError reports them); trailing dots and spaces go,
 * like Windows does.
 */
export function renderRecordName(template: string, c: NameContext): string {
  const d = c.at;
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  const values: Record<string, string> = {
    app: c.app,
    date,
    time,
    year: String(d.getFullYear()),
    month: pad(d.getMonth() + 1),
    day: pad(d.getDate()),
    hour: pad(d.getHours()),
    minute: pad(d.getMinutes()),
    second: pad(d.getSeconds()),
    res: `${c.width}x${c.height}`,
    fps: String(Math.round(c.fps)),
    // No dot, like the app: "H264".
    codec: CODEC_LABEL[c.codec].replace(".", ""),
  };
  const stem = template
    .replace(/\{([a-z]+)\}/gi, (all, k: string) => values[k.toLowerCase()] ?? all)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "");
  return `${stem || "Recording"}.${c.ext}`;
}

/**
 * Puts `token` in place of the selection [start, end) exactly as it is (no
 * spaces added, so "{year}{month}{day}" stays possible); the caret lands
 * after it.
 */
export function insertToken(text: string, start: number, end: number, token: string): { text: string; caret: number } {
  const a = Math.max(0, Math.min(start, end, text.length));
  const b = Math.max(a, Math.min(Math.max(start, end), text.length));
  return { text: text.slice(0, a) + token + text.slice(b), caret: a + token.length };
}

// --------------------------------------------------------------- encoders

export const CODEC_LABEL: Record<VideoCodec, string> = { h264: "H.264", hevc: "HEVC", av1: "AV1" };

/** What the app tries, in order, when a codec is missing. */
const FALLBACK: Record<VideoCodec, VideoCodec[]> = {
  av1: ["av1", "hevc", "h264"],
  hevc: ["hevc", "h264"],
  h264: ["h264"],
};

/** How this PC encodes a codec: on the graphics card, on the CPU, or not at all. */
export function codecSupport(caps: EncoderCaps, codec: VideoCodec): "hardware" | "software" | "none" {
  const c = caps.codecs.find((x) => x.codec === codec);
  if (!c) return "none";
  if (c.hardware.length) return "hardware";
  return c.software ? "software" : "none";
}

/** The codec that is actually used when `codec` is picked. */
export function codecInUse(caps: EncoderCaps, codec: VideoCodec): VideoCodec {
  return FALLBACK[codec].find((c) => codecSupport(caps, c) !== "none") ?? "h264";
}

/** A short note for a codec choice (null = it simply works). */
export function codecNote(caps: EncoderCaps | null, codec: VideoCodec): string | null {
  if (!caps) return null;
  const s = codecSupport(caps, codec);
  if (s === "hardware") return null;
  if (s === "software") return "Runs on the CPU on this PC (no graphics card encoder for it), which can cost game frames.";
  const use = codecInUse(caps, codec);
  return `Not available on this PC - uses ${CODEC_LABEL[use]} instead.`;
}

/** Every hardware encoder found, once. */
export function hardwareEncoders(caps: EncoderCaps | null): string[] {
  if (!caps) return [];
  return [...new Set(caps.codecs.flatMap((c) => c.hardware))];
}

type Vendor = Exclude<EncoderBackend, "auto" | "software">;
const VENDOR_RE: Record<Vendor, RegExp> = {
  nvidia: /nvidia|nvenc|geforce|\brtx\b|\bgtx\b|quadro/i,
  amd: /\bamd\b|\bamf\b|radeon/i,
  intel: /intel|\bqsv\b|quick ?sync|\barc\b/i,
};

/** Which graphics card makers have an encoder on this PC. */
export function vendorsFound(caps: EncoderCaps | null): Set<Vendor> {
  const out = new Set<Vendor>();
  for (const name of hardwareEncoders(caps))
    for (const v of Object.keys(VENDOR_RE) as Vendor[]) if (VENDOR_RE[v].test(name)) out.add(v);
  return out;
}

/** Whether a backend choice can work here (null = do not know yet). */
export function backendFound(caps: EncoderCaps | null, b: EncoderBackend): boolean | null {
  if (!caps) return null;
  if (b === "auto") return true;
  if (b === "software") return caps.codecs.some((c) => c.software);
  return vendorsFound(caps).has(b);
}

// ------------------------------------------------------------------- time

/** "45 s left", "12 min left", "1 h 20 min left". */
export function timeLeftText(seconds: number): string {
  const s = Math.max(0, seconds);
  if (s < 90) return `${Math.ceil(s)} s left`;
  if (s < 3600) return `${Math.round(s / 60)} min left`;
  const total = Math.round(s / 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m ? `${h} h ${m} min left` : `${h} h left`;
}

/** The whole second a countdown shows, `elapsed` seconds after it said `left`. Never below 1. */
export function countdownShown(left: number, elapsed: number): number {
  return Math.max(1, Math.ceil(left - Math.max(0, elapsed)));
}

/** "Off", "10 min", "1 h", "1 h 30 min" for a length in minutes. */
export function minutesText(min: number): string {
  if (min <= 0) return "Off";
  if (min < 60) return `${+min.toFixed(1)} min`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** "No time limit." or "Stops by itself after 30 min or at 4 GB." */
export function recordLimitText(maxMinutes: number, maxGb: number): string {
  const parts = [maxMinutes > 0 && `after ${minutesText(maxMinutes)}`, maxGb > 0 && `at ${+maxGb.toFixed(1)} GB`].filter(Boolean);
  return parts.length ? `Stops by itself ${parts.join(" or ")}.` : "No time limit.";
}
