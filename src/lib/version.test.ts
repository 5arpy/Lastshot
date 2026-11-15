import { describe, expect, it } from "vitest";
import { isNewerVersion } from "./bridge";

describe("isNewerVersion", () => {
  it("compares numerically, not as text", () => {
    expect(isNewerVersion("1.10.0", "1.9.2")).toBe(true);
    expect(isNewerVersion("1.9.2", "1.10.0")).toBe(false);
  });
  it("accepts a leading v and missing parts", () => {
    expect(isNewerVersion("v1.7.1", "1.7.0")).toBe(true);
    expect(isNewerVersion("v1.7", "1.7.0")).toBe(false);
    expect(isNewerVersion("2", "1.99.99")).toBe(true);
  });
  it("is false for the same version", () => {
    expect(isNewerVersion("v1.7.0", "1.7.0")).toBe(false);
  });
});
