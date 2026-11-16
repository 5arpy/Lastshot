/**
 * Turns a raw keydown into a global-shortcut accelerator string ("Ctrl+Shift+S"),
 * "__cancel__" for Escape, or null when the combo is not a valid global hotkey
 * (no modifier, or a modifier key alone).
 */
export function acceleratorFromEvent(e: KeyboardEvent): string | null {
  if (e.key === "Escape") return "__cancel__";
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Win");

  const key = e.key;
  if (["Control", "Alt", "Shift", "Meta", "CapsLock", "Tab"].includes(key)) return null;

  let token: string | null = null;
  if (/^[a-z0-9]$/i.test(key)) token = key.toUpperCase();
  else if (/^F([1-9]|1[0-9]|2[0-4])$/i.test(key)) token = key.toUpperCase();
  else if (key === " ") token = "Space";
  else return null;

  if (mods.length === 0) return null;
  return [...mods, token].join("+");
}
