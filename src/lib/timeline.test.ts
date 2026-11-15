import { describe, expect, it } from "vitest";
import {
  type AudioItem,
  type MainItem,
  audioGain,
  dropIndex,
  lanes,
  mainAt,
  mainStarts,
  moveTo,
  projectLength,
  splitFree,
  splitMain,
  trimFree,
  trimMain,
} from "./timeline";

const clip = (id: string, duration: number, srcIn = 0, srcDuration = 30): MainItem => ({
  id,
  kind: "video",
  path: `${id}.mp4`,
  name: id,
  srcIn,
  duration,
  srcDuration,
  width: 1920,
  height: 1080,
  hasAudio: true,
  volume: 1,
  muted: false,
});

describe("main track", () => {
  const main = [clip("a", 4), clip("b", 6, 10)];
  it("packs items back to back", () => {
    expect(mainStarts(main)).toEqual([0, 4]);
    expect(mainAt(main, 5)?.item.id).toBe("b");
    expect(mainAt(main, 10)).toBeNull();
    expect(projectLength({ width: 1, height: 1, fps: 30, main, overlays: [], audio: [] })).toBe(10);
  });
  it("splits at the playhead keeping the source in-point right", () => {
    const s = splitMain(main, 6);
    expect(s.map((m) => [m.duration, m.srcIn])).toEqual([
      [4, 0],
      [2, 10],
      [4, 12],
    ]);
  });
  it("trims within the file", () => {
    expect(trimMain(clip("a", 4, 2, 10), "left", -5)).toMatchObject({ srcIn: 0, duration: 6 });
    expect(trimMain(clip("a", 4, 2, 10), "right", 99).duration).toBe(8);
    expect(trimMain(clip("a", 4, 2, 10), "left", 99).duration).toBeCloseTo(0.1);
  });
  it("moves by drop position", () => {
    expect(dropIndex(main, 0, 9)).toBe(1);
    expect(moveTo(main, 0, 1).map((m) => m.id)).toEqual(["b", "a"]);
  });
});

describe("free tracks", () => {
  const music: AudioItem = {
    id: "m",
    path: "m.mp3",
    name: "m",
    start: 2,
    srcIn: 1,
    duration: 5,
    srcDuration: 60,
    volume: 0.8,
    fadeIn: 1,
    fadeOut: 2,
  };
  it("trims the left edge without moving past the file start", () => {
    expect(trimFree(music, "left", -3)).toMatchObject({ start: 1, srcIn: 0, duration: 6 });
    expect(trimFree(music, "left", 2)).toMatchObject({ start: 4, srcIn: 3, duration: 3 });
  });
  it("splits keeping source offsets", () => {
    const s = splitFree([music], "m", 4);
    expect(s.map((x) => [x.start, x.srcIn, x.duration])).toEqual([
      [2, 1, 2],
      [4, 3, 3],
    ]);
  });
  it("stacks overlapping items in lanes", () => {
    const l = lanes([
      { id: "a", start: 0, duration: 5 },
      { id: "b", start: 2, duration: 2 },
      { id: "c", start: 5, duration: 1 },
    ]);
    expect([l.get("a"), l.get("b"), l.get("c")]).toEqual([0, 1, 0]);
  });
  it("fades", () => {
    expect(audioGain(music, 0.5)).toBeCloseTo(0.4);
    expect(audioGain(music, 2)).toBeCloseTo(0.8);
    expect(audioGain(music, 4)).toBeCloseTo(0.4);
  });
});
