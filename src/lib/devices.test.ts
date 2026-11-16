import { describe, expect, it } from "vitest";
import {
  currentDefault,
  deviceName,
  filterLog,
  move,
  pickConnected,
  policyLabel,
  preferredOrder,
  whoLabel,
  withOrder,
  type Endpoint,
  type GuardSettings,
  type GuardView,
  type LogEntry,
} from "./devices";

const settings = (over: Partial<GuardSettings> = {}): GuardSettings => ({
  enabled: true,
  policy: "ask",
  notifyRestores: false,
  strict: false,
  defaults: [],
  apps: [],
  deviceRules: [],
  duck: { enabled: false, thresholdDb: -40, amountDb: 12, releaseMs: 800 },
  micMuteHotkey: "",
  ...over,
});

const ep = (id: string, name: string, flow: "render" | "capture" = "render"): Endpoint => ({ id, name, flow, isDefault: false });

describe("fallback order", () => {
  it("picks the first connected device, by id then by name", () => {
    const order = [
      { id: "arctis", name: "Arctis" },
      { id: "spk", name: "Speakers" },
    ];
    expect(pickConnected(order, [ep("spk", "Speakers")])?.id).toBe("spk");
    expect(pickConnected(order, [ep("spk", "Speakers"), ep("arctis", "Arctis")])?.id).toBe("arctis");
    expect(pickConnected(order, [ep("new-id", "arctis")])?.id).toBe("new-id");
    expect(pickConnected(order, [])).toBeNull();
  });

  it("edits one row's order", () => {
    let s = settings();
    s = withOrder(s, 0, false, [{ id: "a", name: "A" }, { id: "b", name: "B" }]);
    s = withOrder(s, 1, true, [{ id: "m", name: "M" }]);
    expect(preferredOrder(s, 0, false).map((d) => d.id)).toEqual(["a", "b"]);
    expect(preferredOrder(s, 1, true).map((d) => d.id)).toEqual(["m"]);
    expect(preferredOrder(s, 0, true)).toEqual([]);
    s = withOrder(s, 0, false, move(preferredOrder(s, 0, false), 1, -1));
    expect(preferredOrder(s, 0, false).map((d) => d.id)).toEqual(["b", "a"]);
    s = withOrder(s, 0, false, []);
    expect(s.defaults).toHaveLength(1);
    expect(move([1, 2], 0, -1)).toEqual([1, 2]);
  });
});

describe("guard view helpers", () => {
  it("reads current defaults and names", () => {
    const v = {
      defaults: [
        { flow: 0, role: 0, id: "spk", name: "Speakers" },
        { flow: 0, role: 2, id: "hs", name: "Headset" },
      ],
    } as unknown as GuardView;
    expect(currentDefault(v, 0, false)?.name).toBe("Speakers");
    expect(currentDefault(v, 0, true)?.name).toBe("Headset");
    expect(currentDefault(v, 1, false)).toBeNull();
    expect(deviceName(null, [])).toBe("Windows' default");
    expect(deviceName("x", [ep("x", "X")])).toBe("X");
    expect(deviceName("gone", [])).toMatch(/not connected/);
    expect(policyLabel("ask")).toBe("Ask me");
    expect(whoLabel("windows")).toMatch(/Windows/);
  });

  it("filters the log", () => {
    const e = (kind: string, who: LogEntry["who"], what: string): LogEntry => ({ time: 1, kind, who, what, from: "a", to: "b", action: "restored" });
    const log = [e("default", "windows", "Default playback"), e("app-output", "user", "Discord"), e("app-output", "windows", "Spotify")];
    expect(filterLog(log, { kind: "", who: "", text: "" })).toHaveLength(3);
    expect(filterLog(log, { kind: "app-output", who: "", text: "" })).toHaveLength(2);
    expect(filterLog(log, { kind: "app-output", who: "windows", text: "" })[0].what).toBe("Spotify");
    expect(filterLog(log, { kind: "", who: "", text: "discord" })).toHaveLength(1);
  });
});
