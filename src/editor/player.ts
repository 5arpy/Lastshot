/**
 * Preview playback: a clock, a small pool of <video>/<audio> elements (one
 * per item under or just ahead of the playhead, so cuts do not stall), and
 * a Web Audio graph per element for volume above 100 %, fades, pan and EQ.
 *
 * The clock is the master; a playing video only nudges it (so picture and
 * sound stay together without drifting). Time listeners are called every
 * frame without React re-rendering the editor.
 */
import { end } from "../timeline/model";
import { endRoom } from "../timeline/view";
import { type EdItem, type EdProject, effectiveAudio, kindOf, pictureTracks } from "./project";
import { media } from "./media";

interface Entry {
  el: HTMLVideoElement | HTMLAudioElement;
  path: string;
  item: EdItem;
  gain: GainNode | null;
  pan: StereoPannerNode | null;
  eq: BiquadFilterNode[];
  source: MediaElementAudioSourceNode | null;
  lastUse: number;
}

const PRELOAD = 2.5;

export class Player {
  time = 0;
  playing = false;
  rate = 1;
  loop: { a: number; b: number } | null = null;
  private project: EdProject | null = null;
  private pool = new Map<string, Entry>();
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private raf = 0;
  private last = 0;
  private listeners = new Set<(t: number, playing: boolean) => void>();
  /** Called when a frame should be drawn (time moved or media arrived). */
  onFrame: (() => void) | null = null;
  onEnded: (() => void) | null = null;
  scrubAudio = false;

  constructor(private urlOf: (path: string) => string) {}

  subscribe(fn: (t: number, playing: boolean) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const l of this.listeners) l(this.time, this.playing);
    this.onFrame?.();
  }

  setProject(p: EdProject) {
    this.project = p;
    this.sync(true);
  }

  length(): number {
    let e = 0;
    for (const i of this.project?.tl.items ?? []) if (!i.disabled) e = Math.max(e, end(i));
    return e;
  }

  /** Past the last clip is allowed (the room after the end shows black). */
  seek(t: number) {
    this.time = Math.max(0, Math.min(endRoom(this.length()), t));
    this.sync(true);
    this.emit();
  }

  play(rate = 1) {
    this.ensureAudio();
    void this.ctx?.resume();
    this.rate = rate;
    const len = this.length();
    if (len <= 0) return;
    if (rate > 0 && this.time >= len - 0.02) this.time = this.loop?.a ?? 0;
    if (this.loop && rate > 0 && (this.time < this.loop.a || this.time >= this.loop.b - 0.02)) this.time = this.loop.a;
    this.playing = true;
    this.last = performance.now();
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.tick);
    this.sync(true);
    this.emit();
  }

  pause() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.sync(true);
    this.emit();
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play(1);
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    for (const e of this.pool.values()) this.drop(e);
    this.pool.clear();
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }

  /** The video element showing `item` now, if it has a frame ready. */
  videoOf(item: EdItem): HTMLVideoElement | null {
    const e = this.pool.get(item.id);
    if (!e || !(e.el instanceof HTMLVideoElement)) return null;
    return e.el.readyState >= 2 ? e.el : null;
  }

  private tick = () => {
    if (!this.playing) return;
    const now = performance.now();
    const dt = Math.min(0.25, (now - this.last) / 1000);
    this.last = now;
    let t = this.time + dt * this.rate;
    // A playing video nudges the clock (it is what the eye follows).
    if (this.rate === 1) {
      const lead = this.leader(t);
      if (lead) {
        const vt = lead.item.start + (lead.el.currentTime - lead.item.srcIn);
        if (Math.abs(vt - t) < 0.12) t = t + (vt - t) * 0.2;
      }
    }
    const len = this.length();
    if (this.loop && this.rate > 0 && t >= this.loop.b) t = this.loop.a;
    if (t >= len || t < 0) {
      this.time = Math.max(0, Math.min(len, t));
      this.playing = false;
      this.sync(true);
      this.emit();
      this.onEnded?.();
      return;
    }
    this.time = t;
    this.sync(false);
    this.emit();
    this.raf = requestAnimationFrame(this.tick);
  };

  private leader(t: number): Entry | null {
    const p = this.project;
    if (!p) return null;
    const order = pictureTracks(p.tl).filter((tr) => !tr.hidden).map((tr) => tr.id);
    for (const trId of order) {
      for (const e of this.pool.values()) {
        const it = e.item;
        if (it.track === trId && it.kind === "video" && t >= it.start && t < end(it) && !e.el.paused && e.el.readyState >= 3) return e;
      }
    }
    return null;
  }

  private ensureAudio() {
    if (this.ctx) return;
    try {
      this.ctx = new AudioContext({ latencyHint: "playback" });
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
    } catch {
      this.ctx = null;
    }
  }

  private make(it: EdItem): Entry | null {
    if (!it.path) return null;
    const el = it.kind === "audio" ? new Audio() : document.createElement("video");
    el.crossOrigin = "anonymous";
    el.preload = "auto";
    if (el instanceof HTMLVideoElement) {
      el.playsInline = true;
      el.muted = false;
    }
    el.src = this.urlOf(it.path);
    el.addEventListener("loadeddata", () => this.onFrame?.());
    el.addEventListener("seeked", () => this.onFrame?.());
    const e: Entry = { el, path: it.path, item: it, gain: null, pan: null, eq: [], source: null, lastUse: performance.now() };
    this.wire(e);
    return e;
  }

  /** Routes the element's sound through gain → EQ → pan (Web Audio). */
  private wire(e: Entry) {
    this.ensureAudio();
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    try {
      e.source = ctx.createMediaElementSource(e.el);
      e.gain = ctx.createGain();
      const low = ctx.createBiquadFilter();
      low.type = "lowshelf";
      low.frequency.value = 200;
      const mid = ctx.createBiquadFilter();
      mid.type = "peaking";
      mid.frequency.value = 1000;
      mid.Q.value = 0.8;
      const high = ctx.createBiquadFilter();
      high.type = "highshelf";
      high.frequency.value = 5000;
      e.eq = [low, mid, high];
      e.pan = ctx.createStereoPanner();
      e.source.connect(e.gain).connect(low).connect(mid).connect(high).connect(e.pan).connect(this.master);
    } catch {
      // Without Web Audio the element plays straight (volume up to 100 %).
      e.source = null;
    }
  }

  private drop(e: Entry) {
    try {
      e.el.pause();
      e.source?.disconnect();
      e.el.removeAttribute("src");
      e.el.load();
    } catch {
      /* already gone */
    }
  }

  /** Puts every element where the playhead says. `hard`: seek precisely. */
  sync(hard: boolean) {
    const p = this.project;
    if (!p) return;
    const t = this.time;
    const tl = p.tl;
    const wanted = new Map<string, EdItem>();
    for (const it of tl.items) {
      if (it.disabled || !it.path || (it.kind !== "video" && it.kind !== "audio")) continue;
      const k = kindOf(tl, it.track);
      const hiddenPic = (k === "video" || k === "spare") && tl.tracks.find((x) => x.id === it.track)?.hidden;
      const sounds = !!effectiveAudio(tl, it);
      if (hiddenPic && !sounds) continue;
      const inside = t >= it.start - 0.001 && t < end(it);
      const soon = this.playing && this.rate > 0 && it.start > t && it.start - t < PRELOAD;
      if (inside || soon) wanted.set(it.id, it);
    }
    const now = performance.now();
    for (const [id, it] of wanted) {
      let e = this.pool.get(id);
      if (e && e.path !== it.path) {
        this.drop(e);
        this.pool.delete(id);
        e = undefined;
      }
      if (!e) {
        const made = this.make(it);
        if (!made) continue;
        e = made;
        this.pool.set(id, e);
      }
      e.item = it;
      e.lastUse = now;
      const inside = t >= it.start - 0.001 && t < end(it);
      const want = it.srcIn + Math.max(0, t - it.start);
      const el = e.el;
      const fx = effectiveAudio(tl, it, media.normGain(it));
      // Sound level now (fades are drawn from the item's own edges).
      let g = fx ? fx.volume : 0;
      if (fx) {
        const off = t - it.start;
        if (fx.fadeIn > 0 && off < fx.fadeIn) g *= Math.max(0, off / fx.fadeIn);
        if (fx.fadeOut > 0 && it.duration - off < fx.fadeOut) g *= Math.max(0, (it.duration - off) / fx.fadeOut);
      }
      if (e.gain) {
        e.gain.gain.value = g;
        if (e.pan) e.pan.pan.value = fx?.pan ?? 0;
        const eq = fx?.eq ?? [0, 0, 0];
        e.eq.forEach((f, k) => (f.gain.value = eq[k]));
        el.volume = 1;
      } else {
        el.volume = Math.max(0, Math.min(1, g));
      }
      if (!inside) {
        // Ready the next piece at its first frame.
        if (!el.paused) el.pause();
        if (Math.abs(el.currentTime - it.srcIn) > 0.05 && el.readyState >= 1) el.currentTime = it.srcIn;
        continue;
      }
      const forward = this.playing && this.rate > 0;
      if (forward) {
        if (Math.abs(el.playbackRate - this.rate) > 0.01) el.playbackRate = this.rate;
        el.muted = this.rate > 2;
        if (el.paused) {
          el.currentTime = want;
          void el.play().catch(() => undefined);
        } else if (Math.abs(el.currentTime - want) > 0.3) {
          el.currentTime = want;
        }
      } else {
        if (!el.paused) el.pause();
        el.muted = false;
        const tol = hard ? 1 / 240 : 1 / 60;
        if (Math.abs(el.currentTime - want) > tol && el.readyState >= 1) el.currentTime = want;
      }
    }
    // Let go of elements nobody needs; keep a few spare for scrubbing back.
    const idle = [...this.pool.entries()].filter(([id]) => !wanted.has(id)).sort((a, b) => b[1].lastUse - a[1].lastUse);
    idle.forEach(([id, e], k) => {
      if (!e.el.paused) e.el.pause();
      if (k >= 4) {
        this.drop(e);
        this.pool.delete(id);
      }
    });
  }
}
