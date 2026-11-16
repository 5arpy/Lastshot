import { beforeEach, describe, expect, it } from "vitest";

// The node test environment has no window or storage: a minimal stand-in.
const store = new Map<string, string>();
const target = new EventTarget();
Object.assign(globalThis, {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
  window: { addEventListener: target.addEventListener.bind(target), removeEventListener: target.removeEventListener.bind(target), dispatchEvent: target.dispatchEvent.bind(target) },
});

const { hasEditorRequests, onEditorRequest, postToEditor, takeEditorRequests } = await import("./inbox");

describe("editor request queue", () => {
  beforeEach(() => store.clear());

  it("hands each request over once, so a remounted editor never replays it", () => {
    postToEditor(["C:/a.mp4", "C:/b.mp4"], { mode: "add" });
    expect(hasEditorRequests()).toBe(true);
    const got = takeEditorRequests();
    expect(got.map((r) => [r.paths, r.mode])).toEqual([[["C:/a.mp4", "C:/b.mp4"], "add"]]);
    // A second editor (or the same one mounted again) finds nothing.
    expect(takeEditorRequests()).toEqual([]);
    expect(hasEditorRequests()).toBe(false);
  });

  it("keeps requests made before any editor is listening, in order", () => {
    postToEditor(["C:/snip.png"], { mode: "open" });
    postToEditor(["C:/clip.mp4"], { mode: "open", flushMs: 5 });
    expect(takeEditorRequests().map((r) => r.paths[0])).toEqual(["C:/snip.png", "C:/clip.mp4"]);
  });

  it("wakes listeners in this window", () => {
    let woke = 0;
    const off = onEditorRequest(() => (woke += 1));
    postToEditor(["C:/a.mp4"]);
    off();
    postToEditor(["C:/b.mp4"]);
    expect(woke).toBe(1);
  });

  it("drops stale requests", () => {
    store.set("lastshot.editor.inbox", JSON.stringify([{ id: "x", paths: ["C:/old.mp4"], at: Date.now() - 60 * 60_000 }]));
    expect(hasEditorRequests()).toBe(false);
    expect(takeEditorRequests()).toEqual([]);
  });
});
