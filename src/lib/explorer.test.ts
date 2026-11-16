import { describe, expect, it } from "vitest";
import type { ClipMetadata } from "./types";
import {
  allClips,
  breadcrumb,
  extraHits,
  filterKind,
  mergeListing,
  moveFocus,
  typeAhead,
  entryPath,
  clipGame,
  folderContents,
  go,
  goBack,
  goForward,
  historyStart,
  parseClipName,
  recentClips,
  searchClips,
  sortEntries,
  tilesInRect,
  upOf,
  type Entry,
} from "./explorer";

const ROOT = "C:\\Users\\U\\Videos\\Lastshot";
let n = 0;
function clip(path: string, ms: number, extra: Partial<ClipMetadata> = {}): ClipMetadata {
  const file_name = path.slice(path.lastIndexOf("\\") + 1);
  return {
    id: String(n++),
    path,
    file_name,
    title: file_name.replace(/\.mp4$/, ""),
    duration_seconds: 30,
    size_bytes: 1000,
    created_unix_ms: ms,
    width: 1920,
    height: 1080,
    fps: 60,
    has_audio: true,
    game: null,
    thumbnail: null,
    favorite: false,
    tags: [],
    ...extra,
  } as ClipMetadata;
}

const clips = [
  clip(`${ROOT}\\Lastshot_2026-11-01_10-00-00.mp4`, 1000),
  clip(`${ROOT}\\Roblox\\Roblox 2026-11-16 20-15-03.mp4`, 5000, { game: "Roblox", size_bytes: 3000 }),
  clip(`${ROOT}\\Roblox\\Roblox 2026-11-15 20-15-03.mp4`, 4000, { game: "Roblox" }),
  clip(`${ROOT}\\Roblox\\Best\\Roblox 2026-11-14 20-15-03.mp4`, 3000, { game: "Roblox\\Best" }),
  clip(`${ROOT}\\Valorant Recording 2026-11-16 21-00-00.mp4`, 6000, { duration_seconds: 5 }),
  clip("D:\\More clips\\old.mp4", 500),
];

const names = (es: Entry[]) => es.map((e) => (e.kind === "folder" ? `[${e.name}]` : e.kind === "clip" ? e.clip.file_name : e.name));

describe("folderContents", () => {
  it("shows game folders with counts, sizes and latest clip, then loose clips (old names too)", () => {
    const es = folderContents(clips, [`${ROOT}\\Roblox`, `${ROOT}\\Empty`, `${ROOT}\\Roblox\\Best`], ROOT, ["D:\\More clips"]);
    expect(names(es)).toEqual([
      "[Roblox]",
      "[Empty]",
      "[More clips]",
      "Lastshot_2026-11-01_10-00-00.mp4",
      "Valorant Recording 2026-11-16 21-00-00.mp4",
    ]);
    const roblox = es[0];
    expect(roblox.kind === "folder" && [roblox.count, roblox.bytes, roblox.latest?.created_unix_ms]).toEqual([3, 5000, 5000]);
    const empty = es[1];
    expect(empty.kind === "folder" && empty.count).toBe(0);
    const more = es[2];
    expect(more.kind === "folder" && [more.count, more.external]).toEqual([1, true]);
  });

  it("opens a folder: its subfolders and clips only", () => {
    expect(names(folderContents(clips, [], `${ROOT}\\Roblox`))).toEqual([
      "[Best]",
      "Roblox 2026-11-16 20-15-03.mp4",
      "Roblox 2026-11-15 20-15-03.mp4",
    ]);
    // Letter case and a trailing slash do not matter.
    expect(folderContents(clips, [], `${ROOT.toLowerCase()}\\roblox\\`)).toHaveLength(3);
  });
});

describe("views, search and sorting", () => {
  it("All clips is flat, newest first; Recent is the last 7 days", () => {
    expect(names(allClips(clips))[0]).toBe("Valorant Recording 2026-11-16 21-00-00.mp4");
    expect(allClips(clips)).toHaveLength(6);
    const now = 10 * 24 * 3600 * 1000;
    const recent = recentClips([clip("C:\\a\\new.mp4", now - 1000), clip("C:\\a\\old.mp4", now - 8 * 24 * 3600 * 1000)], now);
    expect(names(recent)).toEqual(["new.mp4"]);
  });

  it("searches the current folder (with subfolders) or everywhere, by name or game", () => {
    expect(searchClips(clips, "roblox", `${ROOT}\\Roblox`)).toHaveLength(3);
    expect(searchClips(clips, "2026-11-14", `${ROOT}\\Roblox`)).toHaveLength(1);
    expect(searchClips(clips, "valorant", null)).toHaveLength(1);
    expect(searchClips(clips, "valorant", `${ROOT}\\Roblox`)).toHaveLength(0);
  });

  it("sorts by any column, folders first", () => {
    const es = folderContents(clips, [], ROOT, ["D:\\More clips"]);
    expect(names(sortEntries(es, { col: "name", desc: false }))).toEqual([
      "[More clips]",
      "[Roblox]",
      "Lastshot_2026-11-01_10-00-00.mp4",
      "Valorant Recording 2026-11-16 21-00-00.mp4",
    ]);
    expect(names(sortEntries(es, { col: "date", desc: true })).slice(2)).toEqual([
      "Valorant Recording 2026-11-16 21-00-00.mp4",
      "Lastshot_2026-11-01_10-00-00.mp4",
    ]);
    expect(names(sortEntries(es, { col: "length", desc: false })).slice(2)[0]).toBe("Valorant Recording 2026-11-16 21-00-00.mp4");
    expect(names(sortEntries(es, { col: "size", desc: true }))[0]).toBe("[Roblox]");
  });
});

describe("names", () => {
  it("parses new and old file names", () => {
    expect(parseClipName("Roblox 2026-11-16 20-15-03.mp4")).toEqual({ app: "Roblox", kind: null, stamp: "2026-11-16 20-15-03" });
    expect(parseClipName("Counter-Strike 2 Recording 2026-11-16 20-15-03 (2).mp4")).toEqual({
      app: "Counter-Strike 2",
      kind: "Recording",
      stamp: "2026-11-16 20-15-03",
    });
    expect(parseClipName("Roblox 2026-11-16 20-15-03_3.mp4").app).toBe("Roblox");
    expect(parseClipName("Lastshot_Recording_2026-11-16_20-15-03.mp4")).toEqual({ app: null, kind: "Recording", stamp: "2026-11-16 20-15-03" });
    expect(parseClipName("Lastshot_2026-11-16_20-15-03_2.mp4").stamp).toBe("2026-11-16 20-15-03");
    expect(parseClipName("my video.mp4")).toEqual({ app: null, kind: null, stamp: null });
  });

  it("game comes from the folder tag, else from the name, never 'Desktop'", () => {
    expect(clipGame(clips[1])).toBe("Roblox");
    expect(clipGame(clips[4])).toBe("Valorant");
    expect(clipGame(clip(`${ROOT}\\Desktop 2026-11-16 20-15-03.mp4`, 1))).toBe("");
    expect(clipGame(clips[0])).toBe("");
  });
});

describe("navigation", () => {
  it("path bar and up", () => {
    const loc = { kind: "folder" as const, path: `${ROOT}\\Roblox\\Best` };
    expect(breadcrumb(loc, ROOT).map((c) => c.label)).toEqual(["Clips", "Roblox", "Best"]);
    expect(breadcrumb({ kind: "folder", path: "D:\\More clips\\x" }, ROOT, ["D:\\More clips"]).map((c) => c.label)).toEqual([
      "Clips",
      "More clips",
      "x",
    ]);
    expect(breadcrumb({ kind: "all" }, ROOT).map((c) => c.label)).toEqual(["Clips", "All clips"]);
    expect(upOf(loc, ROOT)).toEqual({ kind: "folder", path: `${ROOT}\\Roblox` });
    expect(upOf({ kind: "folder", path: ROOT }, ROOT)).toBeNull();
    expect(upOf({ kind: "folder", path: "D:\\More clips" }, ROOT, ["D:\\More clips"])).toEqual({ kind: "folder", path: ROOT });
  });

  it("back and forward like File Explorer", () => {
    const a = { kind: "folder" as const, path: ROOT };
    const b = { kind: "folder" as const, path: `${ROOT}\\Roblox` };
    let h = go(go(historyStart(a), b), { kind: "all" });
    h = goBack(h);
    expect(h.cur).toEqual(b);
    h = goBack(h);
    expect(h.cur).toEqual(a);
    h = goForward(h);
    expect(h.cur).toEqual(b);
    h = go(h, { kind: "recent" });
    expect(h.fwd).toEqual([]);
    expect(go(h, { kind: "recent" })).toBe(h);
  });

  it("rubber-band picks the tiles it touches", () => {
    // 3 columns of 100x80 tiles, 10 px gap.
    expect(tilesInRect({ x0: 50, y0: 50, x1: 160, y1: 100 }, 7, 3, 100, 80, 10)).toEqual([0, 1, 3, 4]);
    expect(tilesInRect({ x0: 101, y0: 0, x1: 109, y1: 300 }, 7, 3, 100, 80, 10)).toEqual([]);
  });
});

describe("real folders", () => {
  const L = (path: string, dir = false, size = 10) => ({ name: path.slice(path.lastIndexOf("\\") + 1), path, dir, size, modifiedMs: 7 });

  it("shows what is really there: gone items go, new folders and files come", () => {
    const base = folderContents(clips, [], ROOT, ["D:\\More clips"]);
    const listing = [
      L(`${ROOT}\\Roblox`, true),
      L(`${ROOT}\\New folder`, true),
      L(`${ROOT}\\Valorant Recording 2026-11-16 21-00-00.mp4`),
      L(`${ROOT}\\shot.png`),
      // Lastshot_2026-11-01_10-00-00.mp4 was deleted outside.
    ];
    const got = mergeListing(base, listing, ROOT);
    const names = got.map((e) => `${e.kind}:${entryPath(e).slice(ROOT.length + 1) || entryPath(e)}`).sort();
    expect(names).toEqual([
      "clip:Valorant Recording 2026-11-16 21-00-00.mp4",
      "file:shot.png",
      "folder:D:\\More clips",
      "folder:New folder",
      "folder:Roblox",
    ]);
    // The scanned folder keeps its clip count.
    expect(got.find((e) => e.kind === "folder" && e.name === "Roblox")).toMatchObject({ count: 3 });
  });

  it("files sort after folders and with clips", () => {
    const es: Entry[] = [
      { kind: "file", path: `${ROOT}\\a.png`, name: "a.png", size: 5, modified: 9000 },
      ...folderContents(clips, [], ROOT),
    ];
    const sorted = sortEntries(es, { col: "date", desc: true });
    expect(sorted[0].kind).toBe("folder");
    expect(entryPath(sorted[1])).toBe(`${ROOT}\\a.png`);
  });

  it("filters by kind but keeps folders", () => {
    const es = mergeListing(folderContents(clips, [], ROOT), [L(`${ROOT}\\Roblox`, true), L(`${ROOT}\\x.png`), L(`${ROOT}\\n.txt`), L(`${ROOT}\\Lastshot_2026-11-01_10-00-00.mp4`)], ROOT);
    expect(filterKind(es, "pictures").map((e) => e.kind)).toEqual(["folder", "file"]);
    expect(filterKind(es, "videos").map((e) => e.kind).sort()).toEqual(["clip", "folder"]);
    expect(filterKind(es, "other").length).toBe(2);
    expect(filterKind(es, "all").length).toBe(4);
  });

  it("search adds files on disk that are not clips", () => {
    const hits = searchClips(clips, "roblox", null);
    const more = extraHits(hits, [L(`${ROOT}\\Roblox`, true), L(`${ROOT}\\Roblox\\Roblox 2026-11-16 20-15-03.mp4`), L(`${ROOT}\\roblox.png`)], new Set());
    expect(more.map((e) => e.kind)).toEqual(["folder", "file"]);
  });
});

describe("keyboard", () => {
  it("type-ahead finds and cycles like File Explorer", () => {
    const names = ["Apex", "Best", "Bingo", "Clips"];
    expect(typeAhead(names, "b", -1)).toBe(1);
    expect(typeAhead(names, "b", 1)).toBe(2);
    expect(typeAhead(names, "bb", 2)).toBe(1);
    expect(typeAhead(names, "bi", 1)).toBe(2);
    expect(typeAhead(names, "be", 1)).toBe(1);
    expect(typeAhead(names, "z", 0)).toBe(-1);
  });

  it("arrows, Home/End and pages move within the grid", () => {
    expect(moveFocus("Right", -1, 10, 4, 2)).toBe(0);
    expect(moveFocus("Down", 1, 10, 4, 2)).toBe(5);
    expect(moveFocus("Down", 8, 10, 4, 2)).toBe(9);
    expect(moveFocus("Up", 2, 10, 4, 2)).toBe(0);
    expect(moveFocus("End", 0, 10, 4, 2)).toBe(9);
    expect(moveFocus("PageUp", 9, 10, 4, 2)).toBe(1);
    expect(moveFocus("Home", 5, 0, 4, 2)).toBe(-1);
  });
});
