/**
 * Pinned folders of the Clips explorer (like File Explorer's Quick access).
 * Kept per PC in localStorage and shared live between all Lastshot windows
 * (the `storage` event fires in the other windows).
 */
import { useEffect, useState } from "react";
import { baseName, samePath } from "./explorer";

const KEY = "lastshot.explorer.pins";
const listeners = new Set<() => void>();

export interface Pin {
  path: string;
  name: string;
}

export function loadPins(): Pin[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((p) => p && typeof p.path === "string").map((p) => ({ path: p.path, name: p.name || baseName(p.path) })) : [];
  } catch {
    return [];
  }
}

function save(pins: Pin[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(pins));
  } catch {
    /* private mode: pins live for this session only */
  }
  listeners.forEach((f) => f());
}

export const isPinned = (path: string, pins = loadPins()) => pins.some((p) => samePath(p.path, path));

export function togglePin(path: string): boolean {
  const pins = loadPins();
  const on = !isPinned(path, pins);
  save(on ? [...pins, { path, name: baseName(path) }] : pins.filter((p) => !samePath(p.path, path)));
  return on;
}

/** After a pinned folder was renamed or moved. */
export function repointPin(from: string, to: string) {
  const pins = loadPins();
  if (!isPinned(from, pins)) return;
  save(pins.map((p) => (samePath(p.path, from) ? { path: to, name: baseName(to) } : p)));
}

export function usePins(): Pin[] {
  const [pins, setPins] = useState(loadPins);
  useEffect(() => {
    const f = () => setPins(loadPins());
    const onStorage = (e: StorageEvent) => e.key === KEY && f();
    listeners.add(f);
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(f);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return pins;
}
