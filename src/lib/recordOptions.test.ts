import { describe, expect, it } from "vitest";
import {
  DEFAULT_RECORD_NAME,
  RECORD_NAME_TOKENS,
  backendFound,
  codecInUse,
  codecNote,
  codecSupport,
  countdownShown,
  hardwareEncoders,
  insertToken,
  minutesText,
  recordLimitText,
  recordNameError,
  renderRecordName,
  timeLeftText,
  vendorsFound,
} from "./recordOptions";
import type { EncoderCaps } from "./types";

const at = new Date(2026, 10, 17, 20, 15, 3);
const ctx = { app: "Roblox", at, width: 1920, height: 1080, fps: 60, codec: "h264" as const, ext: "mp4" };

describe("recording file names", () => {
  it("the default pattern gives the name Clips reads", () => {
    expect(renderRecordName(DEFAULT_RECORD_NAME, ctx)).toBe("Roblox Recording 2026-11-17 20-15-03.mp4");
  });
  it("fills every token, keeps unknown ones as typed", () => {
    expect(renderRecordName("{year}{month}{day}_{hour}{minute}{second}", ctx)).toBe("20261117_201503.mp4");
    expect(renderRecordName("{app} {res} {fps}fps {codec} {nope}", { ...ctx, codec: "hevc", ext: "mkv" })).toBe(
      "Roblox 1920x1080 60fps HEVC {nope}.mkv",
    );
    expect(renderRecordName("{codec}", ctx)).toBe("H264.mp4");
    expect(renderRecordName("{codec}", { ...ctx, codec: "av1" })).toBe("AV1.mp4");
    expect(renderRecordName("{APP}", ctx)).toBe("Roblox.mp4");
  });
  it("drops trailing dots and spaces, and never gives an empty name", () => {
    expect(renderRecordName("  clip  ...  ", ctx)).toBe("clip.mp4");
    expect(renderRecordName("...", ctx)).toBe("Recording.mp4");
  });
  it("says why a pattern can't be a file name", () => {
    expect(recordNameError(DEFAULT_RECORD_NAME)).toBeNull();
    expect(recordNameError("   ")).toMatch(/Type a name/);
    for (const c of [":", "*", "?", '"', "<", ">", "|", "/", "\\"]) expect(recordNameError(`a${c}b`), c).toMatch(/can't contain/);
    expect(recordNameError("{app} {dat}")).toMatch(/Unknown name part \{dat\}/);
    expect(recordNameError("{APP} {Fps}fps")).toBeNull();
  });
  it("every token is listed once and is in braces", () => {
    const t = RECORD_NAME_TOKENS.map((x) => x.token);
    expect(new Set(t).size).toBe(t.length);
    for (const x of t) expect(x).toMatch(/^\{[a-z]+\}$/);
    expect(t).toEqual(expect.arrayContaining(["{app}", "{date}", "{time}", "{res}", "{fps}", "{codec}"]));
  });
  it("puts a token at the cursor or over the selection", () => {
    expect(insertToken("ab", 1, 1, "{x}")).toEqual({ text: "a{x}b", caret: 4 });
    expect(insertToken("a SEL b", 2, 5, "{x}")).toEqual({ text: "a {x} b", caret: 5 });
    // Backwards selection, and positions past the end.
    expect(insertToken("a SEL b", 5, 2, "{x}")).toEqual({ text: "a {x} b", caret: 5 });
    expect(insertToken("ab", 9, 9, "{x}")).toEqual({ text: "ab{x}", caret: 5 });
    expect(insertToken("", 0, 0, "{app}")).toEqual({ text: "{app}", caret: 5 });
  });
});

const caps: EncoderCaps = {
  codecs: [
    { codec: "h264", hardware: ["NVIDIA NVENC"], software: true },
    { codec: "hevc", hardware: [], software: true },
    { codec: "av1", hardware: [], software: false },
  ],
  sessions: 3,
};

describe("encoder caps", () => {
  it("knows hardware, CPU-only and missing codecs", () => {
    expect(codecSupport(caps, "h264")).toBe("hardware");
    expect(codecSupport(caps, "hevc")).toBe("software");
    expect(codecSupport(caps, "av1")).toBe("none");
    expect(codecSupport({ codecs: [], sessions: 0 }, "h264")).toBe("none");
  });
  it("falls back AV1 -> HEVC -> H.264, as the app does", () => {
    expect(codecInUse(caps, "av1")).toBe("hevc");
    const noHevc: EncoderCaps = { ...caps, codecs: caps.codecs.map((c) => (c.codec === "hevc" ? { ...c, software: false } : c)) };
    expect(codecInUse(noHevc, "av1")).toBe("h264");
    expect(codecInUse(noHevc, "hevc")).toBe("h264");
    expect(codecInUse({ codecs: [], sessions: 0 }, "av1")).toBe("h264");
  });
  it("labels choices without blocking them", () => {
    expect(codecNote(null, "av1")).toBeNull();
    expect(codecNote(caps, "h264")).toBeNull();
    expect(codecNote(caps, "hevc")).toMatch(/CPU/);
    expect(codecNote(caps, "av1")).toBe("Not available on this PC - uses HEVC instead.");
  });
  it("finds which graphics card makers have an encoder", () => {
    const many: EncoderCaps = {
      codecs: [
        { codec: "h264", hardware: ["NVIDIA NVENC", "AMD AMF", "Intel Quick Sync Video"], software: true },
        { codec: "av1", hardware: ["Intel(R) Arc A770 AV1 Encoder", "NVIDIA NVENC"], software: false },
      ],
      sessions: 0,
    };
    expect(hardwareEncoders(many)).toEqual(["NVIDIA NVENC", "AMD AMF", "Intel Quick Sync Video", "Intel(R) Arc A770 AV1 Encoder"]);
    expect([...vendorsFound(many)].sort()).toEqual(["amd", "intel", "nvidia"]);
    expect([...vendorsFound(caps)]).toEqual(["nvidia"]);
    // "arc" inside another word is not Intel Arc.
    expect([...vendorsFound({ codecs: [{ codec: "h264", hardware: ["Research Encoder"], software: false }], sessions: 0 })]).toEqual([]);
    expect(backendFound(null, "nvidia")).toBeNull();
    expect(backendFound(caps, "auto")).toBe(true);
    expect(backendFound(caps, "nvidia")).toBe(true);
    expect(backendFound(caps, "amd")).toBe(false);
    expect(backendFound(caps, "software")).toBe(true);
  });
});

describe("recording times", () => {
  it("time left reads plainly", () => {
    expect(timeLeftText(45)).toBe("45 s left");
    expect(timeLeftText(44.2)).toBe("45 s left");
    expect(timeLeftText(-3)).toBe("0 s left");
    expect(timeLeftText(90)).toBe("2 min left");
    expect(timeLeftText(12 * 60)).toBe("12 min left");
    expect(timeLeftText(3600)).toBe("1 h left");
    expect(timeLeftText(80 * 60)).toBe("1 h 20 min left");
  });
  it("the countdown counts whole seconds and never shows 0", () => {
    expect(countdownShown(3, 0)).toBe(3);
    expect(countdownShown(3, 0.4)).toBe(3);
    expect(countdownShown(3, 1)).toBe(2);
    expect(countdownShown(3, 2.9)).toBe(1);
    expect(countdownShown(3, 9)).toBe(1);
    expect(countdownShown(2.5, -1)).toBe(3);
  });
  it("limits read plainly", () => {
    expect(minutesText(0)).toBe("Off");
    expect(minutesText(30)).toBe("30 min");
    expect(minutesText(60)).toBe("1 h");
    expect(minutesText(90)).toBe("1 h 30 min");
    expect(recordLimitText(0, 0)).toBe("No time limit.");
    expect(recordLimitText(30, 0)).toBe("Stops by itself after 30 min.");
    expect(recordLimitText(120, 4)).toBe("Stops by itself after 2 h or at 4 GB.");
    expect(recordLimitText(0, 2.5)).toBe("Stops by itself at 2.5 GB.");
  });
});
