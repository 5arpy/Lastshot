/**
 * "Open in editor" requests, app-wide. Any window posts one (the library,
 * a snip, a frame); the editor that is showing, in whichever window, takes
 * each request once. Requests live in localStorage, which every Lastshot
 * window shares, so one made before the main window exists (app started in
 * the tray) waits for it, and a remounted editor never sees an old one again.
 */

export interface EditorRequest {
  id: string;
  paths: string[];
  /** "open": a clip becomes its own project; "add": goes onto the open one. */
  mode?: "open" | "add";
  flushMs?: number;
  at: number;
}

const KEY = "lastshot.editor.inbox";
const WAKE = "lastshot://editor-inbox";
/** Older requests are dropped (an app closed before the editor showed). */
const MAX_AGE = 10 * 60_000;

/** Requests this window could not store (storage full or blocked). */
const local: EditorRequest[] = [];
let seq = 0;

function read(): EditorRequest[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? (v as EditorRequest[]).filter((r) => r && Array.isArray(r.paths)) : [];
  } catch {
    return [];
  }
}

const fresh = (r: EditorRequest) => Date.now() - r.at < MAX_AGE;

/** Queues a request and wakes every window's editor. */
export function postToEditor(paths: string[], opts: { mode?: "open" | "add"; flushMs?: number } = {}): void {
  if (!paths.length) return;
  const req: EditorRequest = { id: `${Date.now().toString(36)}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`, paths, ...opts, at: Date.now() };
  try {
    localStorage.setItem(KEY, JSON.stringify([...read().filter(fresh), req]));
  } catch {
    local.push(req);
  }
  window.dispatchEvent(new Event(WAKE));
  void window.__TAURI__?.event.emit?.(WAKE, null).catch(() => undefined);
}

export function hasEditorRequests(): boolean {
  return local.length > 0 || read().some(fresh);
}

/** Takes (and clears) every waiting request, oldest first. */
export function takeEditorRequests(): EditorRequest[] {
  const list = [...local.splice(0), ...read()];
  if (!list.length) return [];
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing stored */
  }
  return list.filter(fresh);
}

/** Calls `cb` when a request may be waiting (this window, another one, or the backend). */
export function onEditorRequest(cb: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY && e.newValue && e.newValue !== "[]") cb();
  };
  window.addEventListener(WAKE, cb);
  window.addEventListener("storage", onStorage);
  let off: (() => void) | undefined;
  let dead = false;
  void window.__TAURI__?.event
    .listen(WAKE, () => cb())
    .then((u) => (dead ? u() : (off = u)))
    .catch(() => undefined);
  return () => {
    dead = true;
    window.removeEventListener(WAKE, cb);
    window.removeEventListener("storage", onStorage);
    off?.();
  };
}
