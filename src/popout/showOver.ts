/**
 * "Show over": the apps a frame shows over (exe names). Empty = every app.
 * The same rules as `norm_app` / `front_matches` in `src-tauri/src/frames.rs`.
 */

/** At most this many apps per frame (as in Rust). */
export const MAX_SHOW_OVER = 32;

/** A typed or listed app as stored: the exe file name, trimmed, with ".exe". */
export function normApp(a: string): string | null {
  const name = (a.trim().split(/[\\/]/).pop() ?? "").trim();
  if (!name || name.length > 80 || /[<>:"|?*\u0000-\u001f]/.test(name)) return null;
  return /\.exe$/i.test(name) ? name : `${name}.exe`;
}

const key = (exe: string) => exe.toLowerCase().replace(/\.exe$/, "");

export const sameApp = (a: string, b: string) => key(a) === key(b);

/** How an app shows: "blender.exe" -> "Blender", "PureRef.exe" -> "PureRef". */
export function appName(exe: string): string {
  const n = exe.replace(/\.exe$/i, "");
  return n === n.toLowerCase() ? n.charAt(0).toUpperCase() + n.slice(1) : n;
}

/** The button's text: "Every app", "Blender", "Blender, Krita", "Blender, Krita (+1)". */
export function showOverLabel(list: string[]): string {
  if (list.length === 0) return "Every app";
  const names = list.slice(0, 2).map(appName).join(", ");
  return list.length > 2 ? `${names} (+${list.length - 2})` : names;
}

/** Adds or removes one app. */
export function toggleApp(list: string[], exe: string): string[] {
  if (list.some((a) => sameApp(a, exe))) return list.filter((a) => !sameApp(a, exe));
  const n = normApp(exe);
  return n && list.length < MAX_SHOW_OVER ? [...list, n] : list;
}

export interface AppChoice {
  exe: string;
  /** A window title of the running app ("" when it is not open now). */
  title: string;
  open: boolean;
  chosen: boolean;
}

/**
 * The checklist: the frame's apps first (also when they are closed), then
 * apps picked on other frames, then the open apps; each app once.
 */
export function showOverChoices(chosen: string[], known: string[], open: { exe: string; title: string }[]): AppChoice[] {
  const out: AppChoice[] = [];
  const titleOf = (exe: string) => open.find((o) => sameApp(o.exe, exe))?.title ?? "";
  const add = (exe: string) => {
    if (!exe || out.some((c) => sameApp(c.exe, exe))) return;
    const t = titleOf(exe);
    out.push({ exe, title: t, open: open.some((o) => sameApp(o.exe, exe)), chosen: chosen.some((a) => sameApp(a, exe)) });
  };
  chosen.forEach(add);
  known.forEach(add);
  [...open].sort((a, b) => appName(a.exe).localeCompare(appName(b.exe))).forEach((o) => add(o.exe));
  return out;
}

/** Open apps worth listing (one per exe, Lastshot left out: it never hides frames). */
export function openApps(windows: { exe: string; title: string }[]): { exe: string; title: string }[] {
  const seen = new Map<string, { exe: string; title: string }>();
  for (const w of windows) {
    if (!w.exe || /^lastshot/i.test(w.exe)) continue;
    const k = key(w.exe);
    if (!seen.has(k) || (!seen.get(k)!.title && w.title)) seen.set(k, { exe: w.exe, title: w.title });
  }
  return [...seen.values()];
}
