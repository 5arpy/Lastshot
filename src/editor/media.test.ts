import { describe, expect, it } from "vitest";
import { MediaStore, type ThumbApi } from "./media";
import type { EdItem } from "./project";

const tick = () => new Promise((r) => setTimeout(r, 60));

function fakeApi(over: Partial<ThumbApi> = {}) {
  const calls: number[][] = [];
  const api: ThumbApi = {
    thumbs: async (_p, times) => {
      calls.push(times);
      return times.map((t) => `pic${t}`.padEnd(100, "x"));
    },
    peaks: async () => ({ rate: 10, data: [0, 128, 64] }),
    ...over,
  };
  return { api, calls };
}

describe("editor media cache", () => {
  it("export waits for peaks, so normalise never uses gain 1 by accident", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const m = new MediaStore({ ...fakeApi().api, peaks: async () => (await gate, { rate: 10, data: [0, 128, 64] }) });
    const it: EdItem = { id: "a", track: "t", kind: "audio", name: "a", path: "C:/a.wav", start: 0, duration: 0.3, srcIn: 0 };
    expect(m.normGain(it)).toBe(1); // still loading
    const wait = m.whenPeaks([it]);
    release();
    await wait;
    expect(m.normGain(it)).toBeCloseTo(0.891 / (128 / 255));
  });

  it("keeps filmstrip pictures to a budget, dropping the least recently shown", async () => {
    const { api } = fakeApi();
    const m = new MediaStore(api, 250);
    m.thumb("f", 1, 1, 40);
    m.thumb("f", 2, 1, 40);
    await tick();
    expect(m.thumb("f", 1, 1, 40)).not.toBeNull(); // 1 is now the most recent
    m.thumb("f", 3, 1, 40);
    await tick();
    expect(m.thumb("f", 3, 1, 40)).not.toBeNull();
    expect(m.thumb("f", 1, 1, 40)).not.toBeNull();
    // 2 went (budget 250 chars = two pictures).
    expect(m.thumb("f", 2, 1, 40)).toBeNull();
  });

  it("skips pictures nobody asks for any more and retries failed ones", async () => {
    let clock = 0;
    const { api, calls } = fakeApi();
    const m = new MediaStore(api, 1e9, () => clock);
    m.thumb("f", 1, 1, 40);
    clock = 10_000; // zoomed away before the request ran
    await tick();
    expect(calls).toEqual([]);
    expect(m.thumb("f", 1, 1, 40)).toBeNull(); // asked again: queued again
    await tick();
    expect(calls).toEqual([[1]]);

    let fail = 2;
    const flaky = new MediaStore({ ...api, thumbs: async (_p, times) => (fail-- > 0 ? Promise.reject(new Error("busy")) : times.map(() => "ok")) }, 1e9, () => 0);
    for (let k = 0; k < 3; k++) {
      flaky.thumb("g", 1, 1, 40);
      await tick();
    }
    expect(flaky.thumb("g", 1, 1, 40)).toBe("ok");
  });
});
