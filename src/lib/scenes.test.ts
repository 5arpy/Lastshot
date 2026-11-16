import { describe, expect, it } from "vitest";
import { nextSceneName, sceneFrom } from "./studio";

describe("scenes", () => {
  it("names new scenes with the first free number", () => {
    expect(nextSceneName([])).toBe("Scene 1");
    const a = sceneFrom("Scene 1", { kind: "display" }, []);
    const b = sceneFrom("scene 3", null, []);
    expect(nextSceneName([a, b])).toBe("Scene 2");
  });
  it("makes unique ids and keeps the source and layers", () => {
    const a = sceneFrom("A", { kind: "display" }, []);
    const b = sceneFrom("B", null, []);
    expect(a.id).not.toBe(b.id);
    expect(a.source).toEqual({ kind: "display" });
    expect(b.source).toBeNull();
  });
});
