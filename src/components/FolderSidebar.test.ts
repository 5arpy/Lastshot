import { describe, expect, it } from "vitest";
import type { ClipMetadata } from "../lib/types";
import { matchesFolder, parentDir } from "./FolderSidebar";

const clip = (path: string, folder?: string) => ({ path, folder }) as ClipMetadata;

describe("folder filter", () => {
  it("finds the parent folder", () => {
    expect(parentDir("C:\\Videos\\Lastshot\\Valorant\\a.mp4")).toBe("C:\\Videos\\Lastshot\\Valorant");
  });

  it("matches the save folder, its subfolders and extra folders", () => {
    const own = clip("C:\\V\\Lastshot\\a.mp4");
    const game = clip("C:\\V\\Lastshot\\Valorant\\b.mp4");
    const extra = clip("D:\\OBS\\c.mp4", "D:\\OBS");
    const all = [own, game, extra];
    expect(all.filter((c) => matchesFolder(c, "all"))).toHaveLength(3);
    expect(all.filter((c) => matchesFolder(c, "save"))).toEqual([own, game]);
    expect(all.filter((c) => matchesFolder(c, "dir:c:\\v\\lastshot\\valorant\\"))).toEqual([game]);
    expect(all.filter((c) => matchesFolder(c, "D:\\OBS"))).toEqual([extra]);
  });
});
