/**
 * Streamer mode: folder paths can show the Windows user name, so while it is
 * on, only the last folder name (or the file name) is shown.
 */
let streamer = false;

export function setStreamerMode(on: boolean): void {
  streamer = on;
}

export function isStreamerMode(): boolean {
  return streamer;
}

/** A path as it may be shown on screen right now. */
export function shownPath(path: string | null | undefined): string {
  if (!path) return "";
  if (!streamer) return path;
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.length ? `…\\${parts[parts.length - 1]}` : "…";
}

/** The folder screenshots are saved to. */
export function screenshotsDir(s: { screenshotDir?: string; outputDir: string }): string {
  return s.screenshotDir?.trim() ? s.screenshotDir.trim() : `${s.outputDir}\\Screenshots`;
}
