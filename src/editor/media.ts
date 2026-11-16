/**
 * Per-file caches for the editor: waveform peaks and filmstrip pictures.
 * Peaks are asked for once per file and kept for the session. Filmstrip
 * pictures are kept up to a memory budget (least recently shown go first);
 * a request the timeline stopped asking for (after a zoom or scroll) is
 * skipped, and a failed one is tried again a couple of times.
 */
import { editorApi, type Peaks } from "./api";
import type { EdItem } from "./project";

type Listener = () => void;

/** Filmstrip memory budget, in characters of PNG data URLs (~2 bytes each). */
const THUMB_BUDGET = 24_000_000;
/** A queued picture nobody asked for again within this long is skipped. */
const STALE_MS = 1500;
const RETRIES = 2;

export interface ThumbApi {
  thumbs: (path: string, times: number[], height: number) => Promise<string[]>;
  peaks: (path: string) => Promise<Peaks>;
}

export class MediaStore {
  private peaks = new Map<string, Peaks | "none">();
  private peakJobs = new Map<string, Promise<void>>();
  /** Shown pictures in least-recently-used order. */
  private thumbs = new Map<string, string>();
  private thumbChars = 0;
  /** Queued or running: key -> last time the timeline asked for it. */
  private asked = new Map<string, number>();
  private fails = new Map<string, number>();
  private listeners = new Set<Listener>();
  private queue: { path: string; times: number[]; h: number }[] = [];
  private busy = false;
  version = 0;

  constructor(
    private api: ThumbApi = editorApi,
    private budget = THUMB_BUDGET,
    private now: () => number = () => performance.now(),
  ) {}

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private bump() {
    this.version++;
    for (const l of this.listeners) l();
  }

  private loadPeaks(path: string): Promise<void> {
    let job = this.peakJobs.get(path);
    if (!job) {
      job = this.api
        .peaks(path)
        .then((p) => {
          this.peaks.set(path, p.data.length ? p : "none");
          this.bump();
        })
        .catch(() => {
          this.peaks.set(path, "none");
        });
      this.peakJobs.set(path, job);
    }
    return job;
  }

  /** Waveform of a file (null until it is decoded). */
  peaksOf(path: string): Peaks | null {
    const v = this.peaks.get(path);
    if (v && typeof v === "object") return v;
    if (!v) void this.loadPeaks(path);
    return null;
  }

  /** Resolves once the peaks of these items' files are known (for export). */
  async whenPeaks(items: EdItem[]): Promise<void> {
    await Promise.all([...new Set(items.map((i) => i.path).filter((p): p is string => !!p))].map((p) => this.loadPeaks(p)));
  }

  /** Gain that brings an item's loudest peak to -1 dBFS (1 when unknown). */
  normGain(it: EdItem): number {
    if (!it.path) return 1;
    const p = this.peaksOf(it.path);
    if (!p) return 1;
    const a = Math.max(0, Math.floor(it.srcIn * p.rate));
    const b = Math.min(p.data.length, Math.ceil((it.srcIn + it.duration) * p.rate));
    let peak = 0;
    for (let k = a; k < b; k++) peak = Math.max(peak, p.data[k]);
    if (peak < 2) return 1;
    return Math.min(8, 0.891 / (peak / 255));
  }

  /** A filmstrip picture of `path` at `t` (rounded to `step`), or null while loading. */
  thumb(path: string, t: number, step: number, h: number): string | null {
    const tt = Math.round(t / step) * step;
    const key = `${path}|${tt.toFixed(2)}|${h}`;
    const v = this.thumbs.get(key);
    if (v !== undefined) {
      // Most recently used goes last.
      this.thumbs.delete(key);
      this.thumbs.set(key, v);
      return v;
    }
    if ((this.fails.get(key) ?? 0) > RETRIES) return null;
    const queued = this.asked.has(key);
    this.asked.set(key, this.now());
    if (!queued) {
      const last = this.queue.find((q) => q.path === path && q.h === h && q.times.length < 12);
      if (last) last.times.push(tt);
      else this.queue.push({ path, times: [tt], h });
      void this.pump();
    }
    return null;
  }

  private keep(key: string, pic: string) {
    this.thumbs.set(key, pic);
    this.thumbChars += pic.length;
    for (const [k, old] of this.thumbs) {
      if (this.thumbChars <= this.budget) break;
      this.thumbs.delete(k);
      this.thumbChars -= old.length;
    }
  }

  private async pump() {
    if (this.busy) return;
    this.busy = true;
    // Let the frame finish asking for everything it needs first.
    await new Promise((r) => setTimeout(r, 30));
    while (this.queue.length) {
      const job = this.queue.shift()!;
      const keyOf = (t: number) => `${job.path}|${t.toFixed(2)}|${job.h}`;
      // Skip what the timeline stopped asking for (zoomed or scrolled away).
      const now = this.now();
      const times = job.times.filter((t) => now - (this.asked.get(keyOf(t)) ?? 0) < STALE_MS);
      for (const t of job.times) if (!times.includes(t)) this.asked.delete(keyOf(t));
      if (!times.length) continue;
      let pics: string[] = [];
      try {
        pics = await this.api.thumbs(job.path, times, job.h);
      } catch {
        pics = [];
      }
      times.forEach((t, k) => {
        const key = keyOf(t);
        this.asked.delete(key);
        if (pics[k]) {
          this.fails.delete(key);
          this.keep(key, pics[k]);
        } else this.fails.set(key, (this.fails.get(key) ?? 0) + 1);
      });
      this.bump();
    }
    this.busy = false;
  }
}

export const media = new MediaStore();
