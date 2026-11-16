import { useEffect, useRef } from "react";
import { registerShortcuts, type Shortcut } from "./shortcuts";

/**
 * Registers `list` for `scope` while the component is mounted and `enabled`.
 * The latest `run` / `when` closures are always used, so the list can be
 * written inline; it is registered again only when its keys or labels change.
 */
export function useShortcuts(scope: string, list: Shortcut[], enabled = true): void {
  const ref = useRef(list);
  ref.current = list;
  const shape = list.map((s) => `${s.id ?? s.label}\u0001${s.keys}\u0001${s.group ?? ""}\u0001${s.inText ? 1 : 0}\u0001${s.context ?? ""}`).join("\u0002");
  useEffect(() => {
    if (!enabled) return;
    const wrapped: Shortcut[] = ref.current.map((s, i) => ({
      keys: s.keys,
      label: s.label,
      group: s.group,
      id: s.id,
      inText: s.inText,
      context: s.context,
      run: () => ref.current[i]?.run(),
      when: () => {
        const w = ref.current[i]?.when;
        return w ? w() : true;
      },
    }));
    return registerShortcuts(scope, wrapped);
  }, [scope, shape, enabled]);
}
