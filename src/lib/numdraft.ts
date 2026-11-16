/**
 * Typed number fields: what the user types is a draft until Enter or blur,
 * so "440" never turns into "10" on the first key, and "0.5" can be typed
 * through "0.". These helpers are the field's rules, without the DOM.
 */

/** A typed value, clamped to [min, max]; null when it is not a number (yet). */
export function parseNum(s: string, min: number, max: number): number | null {
  const t = s.trim().replace(",", ".").replace(/\s*%$/, "");
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return null;
  const v = Number(t);
  if (!Number.isFinite(v)) return null;
  return Math.min(max, Math.max(min, v));
}

/** One step up (dir 1) or down (-1) from `v`, on the step grid, clamped. */
export function stepNum(v: number, step: number, dir: 1 | -1, min: number, max: number): number {
  const n = Math.round((v + dir * step) / step) * step;
  return Math.min(max, Math.max(min, +n.toFixed(6)));
}

/** How a value shows in the field (at most `digits` decimals, no trailing zeros). */
export const showNum = (v: number, digits = 2): string => String(+v.toFixed(digits));
