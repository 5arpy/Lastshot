// The snip overlay's screens: which monitor a point is on, in the frozen
// picture's physical pixels (the Rust side's snip_geo has the desktop rules).
import type { SnipCapture } from "../lib/types";

export type Box = { x: number; y: number; w: number; h: number };

/** The monitors in the picture; older or single-screen captures are one screen. */
export function monitorsOf(c: Pick<SnipCapture, "width" | "height" | "monitors"> | null): Box[] {
  if (!c) return [];
  const m = (c.monitors ?? []).filter((r) => r.w > 0 && r.h > 0);
  return m.length ? m : [{ x: 0, y: 0, w: c.width, h: c.height }];
}

/** The monitor under the point, else the nearest one (the black between monitors). */
export function monitorAt(mons: Box[], x: number, y: number): number {
  let best = 0;
  let bestD = Infinity;
  mons.forEach((m, i) => {
    const dx = Math.max(m.x - x, 0, x - (m.x + m.w - 1));
    const dy = Math.max(m.y - y, 0, y - (m.y + m.h - 1));
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}
