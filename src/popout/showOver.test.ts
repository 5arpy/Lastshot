import { describe, expect, it } from "vitest";
import { MAX_SHOW_OVER, appName, normApp, openApps, sameApp, showOverChoices, showOverLabel, toggleApp } from "./showOver";

describe("show over", () => {
  it("names apps the way Rust stores them", () => {
    expect(normApp(" blender ")).toBe("blender.exe");
    expect(normApp("Krita.EXE")).toBe("Krita.EXE");
    expect(normApp("C:\\Tools\\PureRef.exe")).toBe("PureRef.exe");
    expect(normApp("")).toBeNull();
    expect(normApp("a<b")).toBeNull();
    expect(sameApp("blender", "Blender.exe")).toBe(true);
    expect(sameApp("blender.exe", "blender-launcher.exe")).toBe(false);
  });

  it("labels the button briefly", () => {
    expect(showOverLabel([])).toBe("Every app");
    expect(showOverLabel(["blender.exe"])).toBe("Blender");
    expect(showOverLabel(["blender.exe", "krita.exe"])).toBe("Blender, Krita");
    expect(showOverLabel(["blender.exe", "krita.exe", "PureRef.exe"])).toBe("Blender, Krita (+1)");
    expect(appName("PureRef.exe")).toBe("PureRef");
  });

  it("toggles apps on and off", () => {
    expect(toggleApp([], "blender")).toEqual(["blender.exe"]);
    expect(toggleApp(["blender.exe", "krita.exe"], "Blender.exe")).toEqual(["krita.exe"]);
    expect(toggleApp([], "  ")).toEqual([]);
    const full = Array.from({ length: MAX_SHOW_OVER }, (_, i) => `a${i}.exe`);
    expect(toggleApp(full, "one-more.exe")).toBe(full);
  });

  it("keeps chosen apps listed when they are closed, each app once", () => {
    const open = [
      { exe: "krita.exe", title: "Krita - sketch.kra" },
      { exe: "Discord.exe", title: "Discord" },
      { exe: "blender.exe", title: "Blender" },
    ];
    const c = showOverChoices(["PureRef.exe", "blender.exe"], ["obs64.exe", "pureref.exe"], open);
    expect(c.map((x) => x.exe)).toEqual(["PureRef.exe", "blender.exe", "obs64.exe", "Discord.exe", "krita.exe"]);
    expect(c[0]).toEqual({ exe: "PureRef.exe", title: "", open: false, chosen: true });
    expect(c[1]).toEqual({ exe: "blender.exe", title: "Blender", open: true, chosen: true });
    expect(c[2].chosen).toBe(false);
    expect(c[4].title).toBe("Krita - sketch.kra");
  });

  it("lists each open app once, never Lastshot", () => {
    const w = openApps([
      { exe: "chrome.exe", title: "" },
      { exe: "Chrome.exe", title: "Docs" },
      { exe: "lastshot.exe", title: "Lastshot" },
      { exe: "", title: "x" },
    ]);
    expect(w).toEqual([{ exe: "Chrome.exe", title: "Docs" }]);
  });
});
