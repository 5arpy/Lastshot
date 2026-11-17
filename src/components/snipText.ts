/**
 * Text read from a snip (Windows' own OCR, `snip_ocr`): plain text, a table
 * for spreadsheets, the words inside a box, and personal details to hide
 * (Snipping Tool's "Quick redact"). Colours for the colour picker.
 */
import type { OcrLine, OcrResult, OcrWord } from "../lib/types";

type Box = { x: number; y: number; w: number; h: number };

const median = (v: number[]) => {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** The lines with words (recognised lines without words are dropped). */
const linesOf = (r: OcrResult): OcrLine[] => r.lines.filter((l) => l.words.length);

const top = (l: OcrLine) => Math.min(...l.words.map((w) => w.y));
const bottom = (l: OcrLine) => Math.max(...l.words.map((w) => w.y + w.h));
const left = (l: OcrLine) => Math.min(...l.words.map((w) => w.x));

/**
 * Plain text: lines in reading order (top to bottom; lines side by side
 * left to right), an empty line where a paragraph gap is.
 */
export function ocrText(r: OcrResult): string {
  const lines = linesOf(r);
  if (!lines.length) return r.lines.map((l) => l.text).join("\n").trim();
  const lh = median(lines.map((l) => bottom(l) - top(l))) || 1;
  const sorted = [...lines].sort((a, b) => (Math.abs(top(a) - top(b)) < lh / 2 ? left(a) - left(b) : top(a) - top(b)));
  const out: string[] = [];
  let prev: OcrLine | null = null;
  for (const l of sorted) {
    if (prev && top(l) - bottom(prev) > lh * 0.9) out.push("");
    out.push(l.text || l.words.map((w) => w.text).join(" "));
    prev = l;
  }
  return out.join("\n");
}

/**
 * Rows and columns for a spreadsheet (tab-separated, one row per line):
 * words on the same height make a row; a gap wider than about two letters
 * starts a new cell, and cells line up by their left edge across rows.
 */
export function ocrTable(r: OcrResult): string {
  const words = linesOf(r).flatMap((l) => l.words);
  if (!words.length) return "";
  const h = median(words.map((w) => w.h)) || 1;
  // Rows: words whose middles are within half a letter height.
  const rows: OcrWord[][] = [];
  for (const w of [...words].sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2))) {
    const mid = w.y + w.h / 2;
    const row = rows.find((rw) => Math.abs(rw[0].y + rw[0].h / 2 - mid) < h * 0.5);
    if (row) row.push(w);
    else rows.push([w]);
  }
  // Cells in each row.
  const cells = rows.map((row) => {
    row.sort((a, b) => a.x - b.x);
    const out: { x: number; text: string }[] = [];
    let end = -Infinity;
    for (const w of row) {
      if (out.length && w.x - end < h * 1.2) out[out.length - 1].text += ` ${w.text}`;
      else out.push({ x: w.x, text: w.text });
      end = w.x + w.w;
    }
    return out;
  });
  // Columns: left edges of every cell, merged when close.
  const starts = cells.flat().map((c) => c.x).sort((a, b) => a - b);
  const cols: number[] = [];
  for (const x of starts) if (!cols.length || x - cols[cols.length - 1] > h * 1.5) cols.push(x);
  const colOf = (x: number) => {
    let best = 0;
    for (let i = 0; i < cols.length; i++) if (Math.abs(cols[i] - x) < Math.abs(cols[best] - x)) best = i;
    return best;
  };
  return cells
    .map((row) => {
      const line: string[] = [];
      for (const c of row) {
        const i = Math.max(colOf(c.x), line.length);
        while (line.length < i) line.push("");
        line.push(c.text);
      }
      return line.join("\t");
    })
    .join("\n");
}

/** Only the words whose middle is inside `b` (picture px), as a result. */
export function ocrInside(r: OcrResult, b: Box): OcrResult {
  const inside = (w: OcrWord) => {
    const cx = w.x + w.w / 2;
    const cy = w.y + w.h / 2;
    return cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h;
  };
  return {
    language: r.language,
    lines: r.lines
      .map((l) => {
        const words = l.words.filter(inside);
        return { text: words.map((w) => w.text).join(" "), words };
      })
      .filter((l) => l.words.length),
  };
}

/** Counts for the toast: "3 lines" / "1 line". */
export function linesLabel(text: string): string {
  const n = text.split("\n").filter((l) => l.trim()).length;
  return `${n} line${n === 1 ? "" : "s"}`;
}

// ------------------------------------------------------------------ personal details

/** A card number passes the Luhn check. */
export function luhn(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return digits.length > 0 && sum % 10 === 0;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const IBAN = /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/;

/** What a run of text is, if it is a personal detail. */
export function privateKind(text: string): "email" | "phone" | "card" | "ip" | "iban" | null {
  const t = text.replace(/^[(<["']+|[)>\]"'.,;:!?]+$/g, "");
  if (EMAIL.test(t)) return "email";
  if (IPV4.test(t)) return "ip";
  const compact = t.replace(/[\s-]/g, "");
  if (IBAN.test(compact.toUpperCase()) && /^[A-Z]{2}/.test(compact)) return "iban";
  const digits = t.replace(/[\s\-.()/+]/g, "");
  if (/^\d{13,19}$/.test(digits) && luhn(digits)) return "card";
  // A phone: 7-15 digits, only phone punctuation, and not a plain number
  // with no separators shorter than 10 digits (years, prices, counters).
  if (/^\+?[\d\s\-.()/]+$/.test(t) && digits.length >= 7 && digits.length <= 15 && (t.startsWith("+") || /[\s\-.()/]/.test(t) || digits.length >= 10)) return "phone";
  return null;
}

/**
 * The boxes (picture px) to black out: e-mail addresses, phone numbers, card
 * numbers (Luhn-checked), IBANs and IP addresses. Numbers split over several
 * words ("+1 555 123 4567", "4111 1111 1111 1111") are joined first.
 */
export function privateBoxes(r: OcrResult): { kind: string; box: Box }[] {
  const out: { kind: string; box: Box }[] = [];
  for (const l of linesOf(r)) {
    const ws = l.words;
    for (let i = 0; i < ws.length; i++) {
      // Longest run first (a phone in 4 words beats its last word alone).
      let hit: { kind: string; j: number } | null = null;
      for (let j = Math.min(ws.length - 1, i + 5); j >= i; j--) {
        const text = ws
          .slice(i, j + 1)
          .map((w) => w.text)
          .join(" ");
        if (j > i && !/^[+(\d]/.test(text)) continue; // only numbers span words
        const kind = privateKind(text);
        if (kind) {
          hit = { kind, j };
          break;
        }
      }
      if (!hit) continue;
      const run = ws.slice(i, hit.j + 1);
      const x = Math.min(...run.map((w) => w.x));
      const y = Math.min(...run.map((w) => w.y));
      const x2 = Math.max(...run.map((w) => w.x + w.w));
      const y2 = Math.max(...run.map((w) => w.y + w.h));
      out.push({ kind: hit.kind, box: { x, y, w: x2 - x, h: y2 - y } });
      i = hit.j;
    }
  }
  return out;
}

// ------------------------------------------------------------------ colours

export type ColourFormat = "hex" | "rgb" | "hsl";
export const COLOUR_FORMATS: ColourFormat[] = ["hex", "rgb", "hsl"];

export function hexOf(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

export function hslOf(r: number, g: number, b: number): [number, number, number] {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
    h *= 60;
  }
  return [Math.round(h) % 360, Math.round(s * 100), Math.round(l * 100)];
}

/** The colour as text in a format (what the colour picker copies). */
export function colourText(r: number, g: number, b: number, f: ColourFormat): string {
  if (f === "rgb") return `rgb(${r}, ${g}, ${b})`;
  if (f === "hsl") {
    const [h, s, l] = hslOf(r, g, b);
    return `hsl(${h}, ${s}%, ${l}%)`;
  }
  return hexOf(r, g, b);
}
