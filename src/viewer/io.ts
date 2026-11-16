/**
 * Getting pictures out of the viewer: the clipboard (as an image, through
 * Rust so every app can paste it) and lossless PNG files.
 */

function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const t = window.__TAURI__;
  if (!t) return Promise.reject(new Error("Tauri API unavailable"));
  return t.core.invoke<T>(cmd, args);
}

const inTauri = () => typeof window !== "undefined" && !!window.__TAURI__;

/** Puts a PNG (data URL) on the clipboard as an image. */
export async function copyPng(dataUrl: string): Promise<void> {
  if (inTauri()) return invoke("viewer_copy_png", { png: dataUrl });
  const blob = await (await fetch(dataUrl)).blob();
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}

/** Saves a PNG (data URL) into the Screenshots folder; returns its path. */
export async function savePng(dataUrl: string, name: string): Promise<string> {
  if (inTauri()) return invoke<string>("viewer_save_png", { png: dataUrl, name });
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = `${name}.png`;
  a.click();
  return `${name}.png`;
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

/** A filesystem-safe base name with the time. */
export function stampName(base: string, suffix = ""): string {
  const clean = base.replace(/\.[a-z0-9]{2,4}$/i, "").replace(/[\\/:*?"<>|]+/g, "_").trim() || "Lastshot";
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const t = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
  return `${clean}${suffix ? "_" + suffix : ""}_${t}`;
}
