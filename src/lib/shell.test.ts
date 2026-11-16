import { describe, expect, it } from "vitest";
import { cycleTab, insertIndex, isTabId, myWindow, type ShellLayout } from "./shell";
import { isBrowserKey } from "./browserKeys";

describe("tabs", () => {
  it("cycles through a window's tabs, wrapping", () => {
    expect(cycleTab(["home", "clips", "editor"], "clips", 1)).toBe("editor");
    expect(cycleTab(["home", "clips", "editor"], "editor", 1)).toBe("home");
    expect(cycleTab(["home", "clips", "editor"], "home", -1)).toBe("editor");
    expect(cycleTab(["studio"], "studio", 1)).toBe("studio");
    expect(cycleTab([], "home", 1)).toBe("home");
  });

  it("finds where a dropped tab goes by tab middles", () => {
    const tabs: [number, number][] = [
      [0, 100],
      [100, 200],
      [200, 300],
    ];
    expect(insertIndex(tabs, 10)).toBe(0);
    expect(insertIndex(tabs, 60)).toBe(1);
    expect(insertIndex(tabs, 260)).toBe(3);
    expect(insertIndex([], 50)).toBe(0);
  });

  it("knows tab ids and finds this window", () => {
    expect(isTabId("editor")).toBe(true);
    expect(isTabId("pop-editor")).toBe(false);
    const l: ShellLayout = {
      windows: [
        { label: "main", tabs: ["home"], active: "home" },
        { label: "shell-1", tabs: ["editor", "studio"], active: "studio" },
      ],
    };
    expect(myWindow(l, "shell-1")?.active).toBe("studio");
    expect(myWindow(l, "shell-9")).toBeNull();
  });
});

describe("browser keys", () => {
  it("blocks reload, print, find, zoom, history and new windows", () => {
    for (const k of ["F5", "Ctrl+R", "Ctrl+Shift+R", "Ctrl+F5", "Ctrl+P", "Ctrl+U", "Ctrl+F", "F3", "Ctrl+G", "Ctrl+=", "Ctrl+-", "Ctrl+0", "Ctrl+N", "Ctrl+T", "Ctrl+W", "Ctrl+S", "Alt+Left", "Alt+Right"]) {
      expect(isBrowserKey(k, true, false), k).toBe(true);
    }
  });
  it("blocks devtools in release only", () => {
    expect(isBrowserKey("F12", true, false)).toBe(true);
    expect(isBrowserKey("Ctrl+Shift+I", true, false)).toBe(true);
    expect(isBrowserKey("F12", false, false)).toBe(false);
  });
  it("leaves typing and app keys alone", () => {
    expect(isBrowserKey("Ctrl+C", true, true)).toBe(false);
    expect(isBrowserKey("Ctrl+Z", true, false)).toBe(false);
    expect(isBrowserKey("Alt+Left", true, true)).toBe(false);
    expect(isBrowserKey("", true, false)).toBe(false);
  });
});
