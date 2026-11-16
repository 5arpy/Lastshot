import { describe, expect, it } from "vitest";
import {
  type EdItem,
  type EdProject,
  accepts,
  audioJob,
  dropTrack,
  freeTrack,
  mainTrack,
  newProject,
  renderJob,
  trackLimit,
  tracksOf,
  withSpare,
} from "./project";
import { picturesAt, shapesAt } from "./compose";
import { moveItems, pasteItems, removeItems, splitAt } from "../timeline/ops";

const spareOf = (p: EdProject) => tracksOf(p.tl, "spare")[0].id;

function project(items: Partial<EdItem>[]): EdProject {
  const p = newProject();
  const v = mainTrack(p.tl)!;
  p.tl = {
    ...p.tl,
    items: items.map((x, k) => ({ id: `i${k}`, track: v, kind: "video", name: "c", path: "C:/a.mp4", start: 0, duration: 10, srcIn: 0, srcDuration: 30, width: 1920, height: 1080, hasAudio: true, ...x }) as EdItem),
  };
  return p;
}

const job = (p: EdProject) =>
  renderJob(p, {
    range: { start: 0, end: 10 },
    targetMb: null,
    norm: () => 1,
    still: async () => "still.png",
    raster: () => ({ png: "shape.png", x: 0, y: 0 }),
  });

describe("free track limit and the spare track", () => {
  it("a new project has one track of each kind plus a spare lane above the video", () => {
    const p = newProject();
    expect(p.tl.tracks.map((t) => t.kind)).toEqual(["overlay", "spare", "video", "audio"]);
    expect(tracksOf(p.tl, "spare")[0].name).toBe("Spare: drop anything");
    expect(trackLimit("video")).toBe(1);
    expect(trackLimit("audio")).toBe(1);
    expect(trackLimit("spare", 8)).toBe(1);
    // Pro raises the per-kind limit through the Pro module.
    expect(trackLimit("overlay", 4)).toBe(4);
  });

  it("the spare track takes clips, pictures, sound and objects", () => {
    for (const kind of ["video", "image", "audio", "shape"] as const) expect(accepts("spare", { kind })).toBe(true);
    expect(accepts("audio", { kind: "video" })).toBe(false);
    expect(accepts("overlay", { kind: "image" })).toBe(false);
  });

  it("older projects get a spare track above their video tracks", () => {
    const p = newProject();
    const old = { ...p.tl, tracks: p.tl.tracks.filter((t) => t.kind !== "spare") };
    const tl = withSpare(old);
    expect(tl.tracks.map((t) => t.kind)).toEqual(["overlay", "spare", "video", "audio"]);
    expect(withSpare(tl)).toBe(tl);
  });

  it("a drop onto a busy full track goes to the spare lane instead", () => {
    const p = project([{ id: "a", start: 0, duration: 10 }]);
    const main = mainTrack(p.tl)!;
    const r = dropTrack(p.tl, { kind: "video" }, main, 4, 8);
    expect(r.track).toBe(spareOf(p));
    expect(r.tl.tracks.length).toBe(p.tl.tracks.length);
    // Free there: it stays where it was dropped; Ctrl (insert) keeps the track too.
    expect(dropTrack(p.tl, { kind: "video" }, main, 10, 12).track).toBe(main);
    expect(dropTrack(p.tl, { kind: "video" }, main, 4, 8, { insert: true }).track).toBe(main);
    // Sound and objects fall back the same way.
    const aud = tracksOf(p.tl, "audio")[0].id;
    const withSound = { ...p.tl, items: [...p.tl.items, { ...p.tl.items[0], id: "m", kind: "audio" as const, track: aud }] };
    expect(freeTrack(withSound, "audio", 2, 3).track).toBe(spareOf(p));
    // With the spare lane busy too, the drop overwrites the track it was dropped on.
    const full = { ...withSound, items: [...withSound.items, { ...p.tl.items[0], id: "s", track: spareOf(p) }] };
    expect(dropTrack(full, { kind: "video" }, main, 4, 8).track).toBe(main);
    // Pro: a second video track is added instead.
    const pro = dropTrack(p.tl, { kind: "video" }, main, 4, 8, { perKind: 3 });
    expect(tracksOf(pro.tl, "video").length).toBe(2);
    expect(pro.track).toBe(tracksOf(pro.tl, "video")[0].id);
  });

  it("export draws a clip on the spare lane above the main video and mixes its sound", async () => {
    const p = project([
      { id: "a", start: 0, duration: 10 },
      { id: "b", start: 2, duration: 4, path: "C:/b.mp4" },
      { id: "m", kind: "audio", path: "C:/m.mp3", start: 1, duration: 3, hasAudio: undefined },
      { id: "t", kind: "shape", start: 0, duration: 2, path: undefined, shape: { id: "t", kind: "rect", x: 0, y: 0, w: 10, h: 10, rotation: 0, style: {} } as never },
    ]);
    const sp = spareOf(p);
    p.tl = { ...p.tl, items: p.tl.items.map((i) => (i.id === "a" ? i : { ...i, track: sp })) };
    const j = await job(p);
    const za = j.video.find((v) => v.path === "C:/a.mp4")!.z;
    const zb = j.video.find((v) => v.path === "C:/b.mp4")!.z;
    expect(zb).toBeGreaterThan(za);
    expect(j.audio.map((a) => a.path).sort()).toEqual(["C:/a.mp4", "C:/b.mp4", "C:/m.mp3"]);
    expect(j.overlays.length).toBe(1);
    expect(audioJob(p, p.tl.items, () => 1, null).length).toBe(3);
    // The preview agrees: main first (bottom), then the spare clip; the object shows.
    expect(picturesAt(p, 3).map((i) => i.id)).toEqual(["a", "b"]);
    expect(shapesAt(p, 1).map((x) => x.item.id)).toEqual(["t"]);
    // A hidden spare lane is left out of the picture.
    p.tl = { ...p.tl, tracks: p.tl.tracks.map((t) => (t.id === sp ? { ...t, hidden: true } : t)) };
    expect((await job(p)).video.length).toBe(1);
  });

  it("split, move, paste and ripple delete work on the spare lane", () => {
    const p = project([{ id: "a", start: 0, duration: 10 }]);
    const sp = spareOf(p);
    let tl = { ...p.tl, items: [...p.tl.items, { ...p.tl.items[0], id: "b", track: sp, start: 2, duration: 4 }] };
    tl = splitAt(tl, 4, ["b"]).tl;
    const onSpare = () => tl.items.filter((i) => i.track === sp).sort((x, y) => x.start - y.start);
    expect(onSpare().map((i) => [i.start, i.duration])).toEqual([
      [2, 2],
      [4, 2],
    ]);
    tl = removeItems(tl, [onSpare()[0].id], true);
    expect(onSpare().map((i) => i.start)).toEqual([2]);
    tl = moveItems(tl, [{ id: onSpare()[0].id, start: 3, track: sp }]);
    expect(onSpare()[0].start).toBe(3);
    const pasted = pasteItems(tl, [onSpare()[0]], 7, () => sp, "overwrite");
    expect(pasted.tl.items.filter((i) => i.track === sp).length).toBe(2);
  });
});
