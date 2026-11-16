import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../viewer/Viewer";
import { badgesOf, ECHO_MS, MANY_FRAMES, pickEcho, popOutMany, viewFlags, type Frame } from "./frames";
import { ago } from "./FramesPanel";

const frame = (p: Partial<Frame>): Frame => ({
  id: "a",
  kind: "image",
  src: "",
  title: "",
  x: 0,
  y: 0,
  w: 100,
  h: 100,
  opacity: 1,
  onTop: true,
  clickThrough: false,
  hidden: false,
  showOver: [],
  view: null,
  owned: false,
  createdMs: 0,
  ...p,
});

describe("slider echoes", () => {
  it("keeps the local value right after a local change", () => {
    expect(pickEcho(0.4, 0.9, 1000, 1000 + 50)).toBe(0.4);
    expect(pickEcho(0.4, 0.9, 1000, 1000 + ECHO_MS - 1)).toBe(0.4);
  });
  it("takes the app's value once the local change has settled (or never happened)", () => {
    expect(pickEcho(0.4, 0.9, 1000, 1000 + ECHO_MS)).toBe(0.9);
    expect(pickEcho(0.4, 0.9, 0, 5000)).toBe(0.9);
  });
});

describe("popping out many pictures", () => {
  it("asks above the limit and opens nothing on no", async () => {
    const opened: number[] = [];
    let asked = 0;
    const n = await popOutMany(
      Array.from({ length: MANY_FRAMES + 1 }, (_, i) => i),
      async (i) => void opened.push(i),
      (k) => (asked = k) > 0 && false,
      () => undefined,
    );
    expect(asked).toBe(MANY_FRAMES + 1);
    expect(n).toBe(0);
    expect(opened).toEqual([]);
  });
  it("does not ask up to the limit and reports failures instead of hiding them", async () => {
    const errors: string[] = [];
    let asked = false;
    const n = await popOutMany(
      [1, 2, 3],
      async (i) => {
        if (i !== 2) throw new Error(`bad ${i}`);
      },
      () => (asked = true),
      (m) => errors.push(m),
    );
    expect(asked).toBe(false);
    expect(n).toBe(1);
    expect(errors).toEqual(["2 of 3 pictures did not open. First: bad 1"]);
  });
});

describe("panel badges", () => {
  it("come from the view and win over it once reported", () => {
    const s = { ...DEFAULT_SETTINGS, adjust: { ...DEFAULT_SETTINGS.adjust, grayscale: 1 } };
    const b = badgesOf({ s, v: { flipH: true } as never });
    expect(b).toEqual(["gray", "flipH"]);
    expect(viewFlags(frame({ badges: b }))).toMatchObject({ gray: true, flipH: true, grid: false, flipV: false });
    // Change events carry no view: the badges still tell.
    expect(viewFlags(frame({ view: null, badges: ["grid"] })).grid).toBe(true);
    expect(viewFlags(frame({ view: { s } })).gray).toBe(true);
  });
});

describe("recently closed times", () => {
  it("reads naturally", () => {
    const now = 10 * 24 * 3600 * 1000;
    expect(ago(now - 10_000, now)).toBe("just now");
    expect(ago(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(ago(now - 3 * 3600_000, now)).toBe("3 h ago");
    expect(ago(now - 26 * 3600_000, now)).toBe("yesterday");
    expect(ago(now - 4 * 24 * 3600_000, now)).toBe("4 days ago");
  });
});
