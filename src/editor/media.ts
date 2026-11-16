/**
 * Per-file caches for the editor: waveform peaks and filmstrip pictures.
 * Each is asked for once per file (and per thumbnail time step) and kept for
 * the session, so scrolling and zooming never decode again.
 */
import { editorApi, type Peaks } from "./api";
import type { EdItem } from "./project";

type Listener = () => void;

class Store {
  private peaks = new Map<string, Peaks | "loading" | "none">();
  private thumbs = new Map<string, string | "loading">();
  private listeners = new Set<Listener>();
  private queue: { path: string; times: number[]; h: number }[] = [];
  private busy = false;
  version = 0;

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private bump() {
    this.version++;
    for (const l of this.listeners) l();
  }

  /** Waveform of a file (null until it is decoded). */
  peaksOf(path: string): Peaks | null {
    const v = this.peaks.get(path);
    if (v && typeof v === "object") return v;
    if (!v) {
      this.peaks.set(path, "loading");
      editorApi
        .peaks(path)
        .then((p) => {
          this.peaks.set(path, p.data.length ? p : "none");
          this.bump();
        })
        .catch(() => this.peaks.set(path, "none"));
    }
    return null;
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
    if (v && v !== "loading") return v;
    if (!v) {
      this.thumbs.set(key, "loading");
      const last = this.queue.find((q) => q.path === path && q.h === h && q.times.length < 12);
      if (last) last.times.push(tt);
      else this.queue.push({ path, times: [tt], h });
      void this.pump();
    }
    return null;
  }

  private async pump() {
    if (this.busy) return;
    this.busy = true;
    // Let the frame finish asking for everything it needs first.
    await new Promise((r) => setTimeout(r, 30));
    while (this.queue.length) {
      const job = this.queue.shift()!;
      try {
        const pics = await editorApi.thumbs(job.path, job.times, job.h);
        job.times.forEach((t, k) => {
          if (pics[k]) this.thumbs.set(`${job.path}|${t.toFixed(2)}|${job.h}`, pics[k]);
        });
        this.bump();
      } catch {
        // No pictures for this file: keep the keys as "loading" so we do not retry.
      }
    }
    this.busy = false;
  }
}

export const media = new Store();
