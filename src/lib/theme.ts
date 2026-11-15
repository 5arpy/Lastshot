/**
 * Appearance theme. Stored per machine in the WebView's localStorage (it is a
 * display preference, not engine config) and applied to <html data-theme>
 * before React renders, so there is no flash of the wrong palette.
 */
export type ThemeChoice = "dark" | "light" | "system";

const KEY = "clipflow.theme";
const listeners = new Set<(t: ThemeChoice) => void>();
let media: MediaQueryList | null = null;

export function getTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "dark" || v === "light" || v === "system") return v;
  } catch {
    /* storage unavailable: fall back to the default */
  }
  return "dark";
}

function resolve(choice: ThemeChoice): "dark" | "light" {
  if (choice !== "system") return choice;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function applyTheme(choice: ThemeChoice = getTheme()): void {
  document.documentElement.dataset.theme = resolve(choice);
}

export function setTheme(choice: ThemeChoice): void {
  try {
    localStorage.setItem(KEY, choice);
  } catch {
    /* not persisted, still applied for this session */
  }
  applyTheme(choice);
  listeners.forEach((l) => l(choice));
}

export function onThemeChange(l: (t: ThemeChoice) => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Applies the saved theme and follows the OS when the choice is "system". */
export function initTheme(): void {
  applyTheme();
  media = window.matchMedia?.("(prefers-color-scheme: light)") ?? null;
  media?.addEventListener("change", () => {
    if (getTheme() === "system") applyTheme("system");
  });
}

/** Reads a theme token (e.g. "--color-accent") for canvas drawing. */
export function themeColor(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
