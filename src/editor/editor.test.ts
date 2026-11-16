import { describe, expect, it } from "vitest";
import { type EdItem, type EdProject, DEFAULT_FX, effectiveAudio, exportRange, exportRoute, mainTrack, newProject, outputSize, tracksOf } from "./project";
import { editorKeymap, keyName, normKeys, type EditorActions } from "./keys";
import { migrate } from "./store";
import { placement, placedBox } from "./compose";
import { flip, moveBy, resize, rotateTo, type Shape } from "../annotate/shapes";

function project(items: Partial<EdItem>[]): EdProject {
  const p = newProject();
  const v = mainTrack(p.tl)!;
  p.tl = {
    ...p.tl,
    items: items.map((x, k) => ({ id: `i${k}`, track: v, kind: "video", name: "c", path: "C:/a.mp4", start: 0, duration: 10, srcIn: 0, srcDuration: 30, width: 1920, height: 1080, hasAudio: true, ...x }) as EdItem),
  };
  return p;
}

describe("export routes", () => {
  it("one plain clip is a lossless copy of its piece", () => {
    const p = project([{ srcIn: 5, duration: 10 }]);
    expect(exportRoute(p)).toEqual({ kind: "copy", path: "C:/a.mp4", start: 5, end: 15 });
  });
  it("in/out narrows the copy", () => {
    const p = project([{ srcIn: 5, duration: 10 }]);
    p.tl = { ...p.tl, inPoint: 2, outPoint: 4 };
    expect(exportRange(p)).toEqual({ start: 2, end: 4 });
    expect(exportRoute(p)).toEqual({ kind: "copy", path: "C:/a.mp4", start: 7, end: 9 });
  });
  it("back-to-back pieces with one crop use the segment export", () => {
    const crop = { x: 0.2, y: 0, w: 0.6, h: 1 };
    const p = project([
      { id: "a", srcIn: 0, duration: 3, pic: { crop } },
      { id: "b", start: 3, srcIn: 10, duration: 2, pic: { crop } },
    ]);
    const r = exportRoute(p);
    expect(r.kind).toBe("segments");
    if (r.kind === "segments") {
      expect(r.segments).toEqual([
        { path: "C:/a.mp4", start: 0, end: 3 },
        { path: "C:/a.mp4", start: 10, end: 12 },
      ]);
      expect(r.crop).toEqual(crop);
    }
  });
  it("a gap, a volume change, an overlay or a picture change needs the full render", () => {
    expect(exportRoute(project([{ start: 1 }])).kind).toBe("render");
    expect(exportRoute(project([{ audio: { ...DEFAULT_FX, volume: 2 } }])).kind).toBe("render");
    expect(exportRoute(project([{ pic: { flipH: true } }])).kind).toBe("render");
    const p = project([{}]);
    const o = tracksOf(p.tl, "overlay")[0];
    p.tl.items.push({ id: "s", track: o.id, kind: "shape", name: "t", start: 0, duration: 1, srcIn: 0 } as EdItem);
    expect(exportRoute(p).kind).toBe("render");
  });
});

describe("detached sound", () => {
  it("a clip whose sound was detached (and deleted) is rendered, not copied with its sound", () => {
    const p = project([{ srcIn: 5, duration: 10, hasAudio: false, srcAudio: true }]);
    expect(exportRoute(p).kind).toBe("render");
    // Unknown (older project): render to be safe; a silent file may still copy.
    expect(exportRoute(project([{ hasAudio: false }])).kind).toBe("render");
    expect(exportRoute(project([{ hasAudio: false, srcAudio: false }])).kind).toBe("copy");
    // Muted copies render too.
    expect(exportRoute(project([{ srcAudio: true, audio: { ...DEFAULT_FX, muted: true } }])).kind).toBe("render");
  });
});

describe("sound", () => {
  it("track volume, solo and mute shape what is heard", () => {
    const p = project([{ audio: { ...DEFAULT_FX, volume: 0.5 } }]);
    const v = mainTrack(p.tl)!;
    p.tl = { ...p.tl, tracks: p.tl.tracks.map((t) => (t.id === v ? { ...t, volume: 2 } : t)) };
    expect(effectiveAudio(p.tl, p.tl.items[0])?.volume).toBe(1);
    p.tl = { ...p.tl, tracks: p.tl.tracks.map((t) => (t.id === v ? { ...t, muted: true } : t)) };
    expect(effectiveAudio(p.tl, p.tl.items[0])).toBeNull();
  });
});

describe("output size", () => {
  it("auto follows the first clip after crop and turn", () => {
    const p = project([{ pic: { crop: { x: 0, y: 0, w: 0.5, h: 1 }, rot90: 90 } }]);
    expect(outputSize(p)).toEqual({ w: 1080, h: 960 });
  });
});

describe("picture placement", () => {
  it("fits, fills and scales around the centre", () => {
    const it = { pic: {} } as EdItem;
    expect(placedBox(placement(it, 1920, 1080, 1080, 1920))).toEqual({ x: 0, y: 960 - 303.75, w: 1080, h: 607.5 });
    const fill = placement({ pic: { fill: true } } as EdItem, 1920, 1080, 1080, 1920);
    expect(Math.round(fill.dh)).toBe(1920);
    const pip = placedBox(placement({ pic: { scale: 0.25, cx: 0.75, cy: 0.25 } } as EdItem, 1920, 1080, 1920, 1080));
    expect(pip).toEqual({ x: 1440 - 240, y: 270 - 135, w: 480, h: 270 });
  });
});

describe("old editor projects", () => {
  it("move onto tracks", () => {
    const p = migrate({
      width: 1920,
      height: 1080,
      fps: 60,
      main: [
        { id: "m1", kind: "video", path: "C:/a.mp4", name: "a", srcIn: 1, duration: 4, srcDuration: 10, width: 1920, height: 1080, hasAudio: true, volume: 0.5, muted: false },
        { id: "m2", kind: "image", path: "C:/b.png", name: "b", srcIn: 0, duration: 3, srcDuration: 3, width: 800, height: 600, hasAudio: false, volume: 1, muted: false },
      ],
      overlays: [{ id: "o", kind: "text", name: "t", text: "Hi", start: 1, duration: 2, x: 0.1, y: 0.1, w: 0.2, aspect: 0.5, opacity: 1 }],
      audio: [{ id: "a", path: "C:/m.mp3", name: "m", start: 0, srcIn: 0, duration: 7, srcDuration: 60, volume: 1, fadeIn: 1, fadeOut: 2 }],
    })!;
    const kinds = p.tl.items.map((i) => [i.kind, i.start]);
    expect(kinds).toEqual([
      ["video", 0],
      ["image", 4],
      ["shape", 1],
      ["audio", 0],
    ]);
    expect(p.tl.items[0].audio?.volume).toBe(0.5);
    expect(p.tl.items[2].shape?.text).toBe("Hi");
  });
});

describe("keys", () => {
  it("names key presses the way bindings are written", () => {
    const ev = (key: string, m: Partial<KeyboardEvent> = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...m }) as KeyboardEvent;
    expect(keyName(ev("z", { ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+Z");
    expect(keyName(ev("<", { shiftKey: true }))).toBe("Shift+,");
    expect(keyName(ev("+", { shiftKey: true }))).toBe("+");
    expect(keyName(ev(" "))).toBe("Space");
    expect(normKeys("shift+ctrl+z")).toBe("Ctrl+Shift+Z");
  });
  it("has no two unconditional bindings on one key", () => {
    const noop = () => undefined;
    const a = new Proxy({} as EditorActions, { get: () => noop });
    const seen = new Map<string, string>();
    for (const s of editorKeymap(a)) {
      if (s.when) continue;
      const k = normKeys(s.keys);
      if (seen.has(k)) expect(`${k}: ${seen.get(k)}`).toBe(`${k}: ${s.label}`);
      seen.set(k, s.label);
    }
  });
});

describe("annotation objects", () => {
  const box: Shape = { id: "a", kind: "rect", x: 10, y: 10, w: 100, h: 50, rot: 0, color: "#f00", width: 4, opacity: 1 };
  it("move, flip and turn with Shift snapping to 15°", () => {
    expect(moveBy(box, 5, -5)).toMatchObject({ x: 15, y: 5 });
    expect(flip(box, "x").flipX).toBe(true);
    const r = rotateTo(box, [160, 35], [60, 135], true);
    expect(r.rot % 15).toBe(0);
  });
  it("resize keeps the opposite corner", () => {
    const r = resize(box, "se", [210, 110]);
    expect(r).toMatchObject({ x: 10, y: 10, w: 200, h: 100 });
  });
});
