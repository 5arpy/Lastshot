import { describe, expect, it } from "vitest";
import { parseNum, parseNumOr, showNum, stepNum } from "./numdraft";
import { CUSTOM, presetPick } from "../components/PresetOrCustom";

describe("typed numbers", () => {
  it("half-typed values are not numbers yet, so nothing is committed early", () => {
    for (const s of ["", "-", ".", "1e", "abc", "4 4"]) expect(parseNum(s, 10, 20000)).toBeNull();
    // "0." is a number (0) only once committed; while typing the draft stays as it is.
    expect(parseNum("0.", 0.1, 20)).toBe(0.1);
  });
  it("whole values commit clamped", () => {
    expect(parseNum("440", 10, 20000)).toBe(440);
    expect(parseNum("0.5", 0.1, 20)).toBe(0.5);
    expect(parseNum(" 2,5 ", 0, 10)).toBe(2.5);
    expect(parseNum("37%", 5, 100)).toBe(37);
    expect(parseNum("4", 10, 20000)).toBe(10);
    expect(parseNum("99999", 10, 20000)).toBe(20000);
    expect(parseNum("-30", -18, 18)).toBe(-18);
  });
  it("an emptied field means its empty value (e.g. 0 = off) when it has one", () => {
    expect(parseNumOr("", 0, 60, 0)).toBe(0);
    expect(parseNumOr("  ", 1, 60, 0)).toBe(0);
    expect(parseNumOr("", 0, 60)).toBeNull();
    expect(parseNumOr("90", 0, 60, 0)).toBe(60);
    expect(parseNumOr("abc", 0, 60, 0)).toBeNull();
  });
  it("steps on the step grid and stays in range", () => {
    expect(stepNum(7.3, 0.5, 1, -18, 18)).toBe(8);
    expect(stepNum(0.3, 0.1, -1, 0.1, 20)).toBe(0.2);
    expect(stepNum(20000, 1, 1, 10, 20000)).toBe(20000);
    expect(stepNum(37, 1, -1, 5, 100)).toBe(36);
  });
  it("shows at most the given decimals", () => {
    expect(showNum(0.30000000000000004)).toBe("0.3");
    expect(showNum(440)).toBe("440");
    expect(showNum(1.23456, 1)).toBe("1.2");
  });
});

describe("preset or custom", () => {
  const presets = [{ value: 30 }, { value: 60 }, { value: 120 }];
  it("shows the preset when the value is one, else the typed field", () => {
    expect(presetPick(60, presets, false)).toBe("60");
    expect(presetPick(75, presets, false)).toBe(CUSTOM);
    expect(presetPick(60, presets, true)).toBe(CUSTOM);
  });
});
