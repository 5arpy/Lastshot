import { describe, expect, it } from "vitest";
import { dbToPos, isVoicemeeterDevice, toDb } from "./audio";

describe("audio helpers", () => {
  it("maps levels and gains onto the meter scale", () => {
    expect(toDb(1)).toBeCloseTo(0);
    expect(toDb(0)).toBe(-60);
    expect(toDb(0.5)).toBeCloseTo(-6.02, 1);
    expect(dbToPos(-60)).toBe(0);
    expect(dbToPos(12)).toBe(1);
    expect(dbToPos(0)).toBeCloseTo(60 / 72);
    expect(dbToPos(40)).toBe(1);
  });

  it("spots Voicemeeter's devices", () => {
    expect(isVoicemeeterDevice("VB1 (VB-Audio Voicemeeter VAIO)")).toBe(true);
    expect(isVoicemeeterDevice("Voicemeeter AUX Input")).toBe(true);
    expect(isVoicemeeterDevice("Speakers (Realtek(R) Audio)")).toBe(false);
  });
});
