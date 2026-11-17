import { describe, expect, it } from "vitest";
import { DEFAULT_DRAW_PREFS, DRAW_TOOLS, MAIN_TOOLS, MORE_TOOLS, along, boardCss, clampBar, clampFade, fadeAlpha, parseDrawPrefs, stepWidth, toggleBoard } from "./drawPrefs";

describe("draw on screen", () => {
  it("splits the tools into the bar and More tools, every tool in exactly one", () => {
    expect(MAIN_TOOLS.length).toBeLessThanOrEqual(8);
    expect([...MAIN_TOOLS, ...MORE_TOOLS].sort()).toEqual([...DRAW_TOOLS].sort());
    expect(MORE_TOOLS).toEqual(["select", "line", "ellipse", "step"]);
  });
  it("reads remembered choices and drops bad ones", () => {
    expect(parseDrawPrefs(null)).toEqual(DEFAULT_DRAW_PREFS);
    expect(parseDrawPrefs("not json")).toEqual(DEFAULT_DRAW_PREFS);
    const p = parseDrawPrefs(JSON.stringify({ tool: "arrow", board: "black", fade: 3.33, style: { color: "#4096ff", width: 10 } }));
    expect(p).toMatchObject({ tool: "arrow", board: "black", fade: 3.3 });
    expect(p.style).toMatchObject({ color: "#4096ff", width: 10, bold: true });
    // Tools without a picture under them, unknown boards, silly numbers: defaults.
    const bad = parseDrawPrefs(JSON.stringify({ tool: "blur", board: "pink", fade: -4, style: { width: 0 } }));
    expect(bad).toMatchObject({ tool: "pen", board: "none", fade: 0 });
    expect(bad.style.width).toBe(DEFAULT_DRAW_PREFS.style.width);
    expect(clampFade(99999)).toBe(600);
    expect(clampFade("5")).toBe(5);
  });

  it("steps pen widths from any width", () => {
    expect(stepWidth(4, 1)).toBe(6);
    expect(stepWidth(4, -1)).toBe(2);
    expect(stepWidth(5, 1)).toBe(6);
    expect(stepWidth(5, -1)).toBe(4);
    expect(stepWidth(24, 1)).toBe(24);
    expect(stepWidth(2, -1)).toBe(2);
  });

  it("fades ink over the last third, then it is gone", () => {
    expect(fadeAlpha(10_000, 0)).toBe(1);
    expect(fadeAlpha(0, 3)).toBe(1);
    expect(fadeAlpha(2000, 3)).toBe(1);
    expect(fadeAlpha(2500, 3)).toBeCloseTo(0.5);
    expect(fadeAlpha(3000, 3)).toBe(0);
  });

  it("boards toggle, and the empty board still takes clicks", () => {
    expect(toggleBoard("none", "white")).toBe("white");
    expect(toggleBoard("white", "white")).toBe("none");
    expect(toggleBoard("white", "black")).toBe("black");
    expect(boardCss("none")).not.toBe("transparent");
    expect(boardCss("white")).toBe("#ffffff");
  });

  it("the eraser tests every few pixels of a fast drag", () => {
    const pts = along([0, 0], [100, 0], 8);
    expect(pts.length).toBe(13);
    expect(pts[pts.length - 1]).toEqual([100, 0]);
    expect(along([5, 5], [5, 5], 8)).toEqual([[5, 5]]);
    expect(parseDrawPrefs(JSON.stringify({ tool: "eraser" })).tool).toBe("eraser");
  });

  it("keeps the bar inside the window", () => {
    expect(clampBar(-50, 10, 400, 40, 1920, 1080)).toEqual({ x: 0, y: 10 });
    expect(clampBar(1800, 1070, 400, 40, 1920, 1080)).toEqual({ x: 1520, y: 1040 });
  });
});
