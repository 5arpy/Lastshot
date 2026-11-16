import { describe, expect, it } from "vitest";
import { dropMode, fileKind, muteIpcNoise, splitExt } from "./files";

describe("files", () => {
  it("drops follow File Explorer's rules", () => {
    const none = { ctrlKey: false, shiftKey: false };
    expect(dropMode("C:\\a\\x.mp4", "C:\\b", none)).toBe("move");
    expect(dropMode("D:\\a\\x.mp4", "C:\\b", none)).toBe("copy");
    expect(dropMode("C:\\a\\x.mp4", "C:\\b", { ctrlKey: true, shiftKey: false })).toBe("copy");
    expect(dropMode("D:\\a\\x.mp4", "C:\\b", { ctrlKey: false, shiftKey: true })).toBe("move");
    expect(dropMode("\\\\nas\\share\\x.mp4", "\\\\nas\\share\\y", none)).toBe("move");
    expect(dropMode("\\\\nas\\share\\x.mp4", "\\\\other\\share", none)).toBe("copy");
  });

  it("names and kinds", () => {
    expect(splitExt("clip.final.mp4")).toEqual(["clip.final", ".mp4"]);
    expect(splitExt(".gitignore")).toEqual([".gitignore", ""]);
    expect(splitExt("folder.v2", true)).toEqual(["folder.v2", ""]);
    expect(fileKind("a.PNG")).toBe("picture");
    expect(fileKind("a.mkv")).toBe("video");
    expect(fileKind("a.bin")).toBe("other");
  });

  it("hides only Tauri's JSON line after a drop message", () => {
    const seen: unknown[][] = [];
    const con = { error: (...a: unknown[]) => void seen.push(a) };
    muteIpcNoise(Date.now(), con);
    con.error("JSON error: expected value at line 1 column 1");
    con.error("Real problem");
    con.error("JSON error: x", 2);
    expect(seen).toEqual([["Real problem"], ["JSON error: x", 2]]);
  });
});
