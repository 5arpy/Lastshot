/**
 * The tab strip, like a browser's: click a tab to show it, drag it along the
 * strip to reorder, drag it off the strip to give it a window of its own,
 * and drop it on any window's strip to dock it there. Right-click (or
 * Shift+F10 / the menu key) has the same moves for keyboard users.
 *
 * Tabs move between windows through src-tauri/src/shell.rs, which owns the
 * layout and moves the dragged window with the real cursor.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "../utils/cn";
import { lastshot } from "../lib/bridge";
import { insertIndex, MAIN, shell, TAB_NAMES, type ShellWin, type TabId } from "../lib/shell";
import { withKeys } from "../lib/shortcuts";
import PopMenu, { type PopMenuItem } from "./PopMenu";

interface Props {
  tabs: TabId[];
  active: TabId;
  /** This window's label. */
  label: string;
  /** All app windows (for "Move to …"). */
  windows: ShellWin[];
  counts?: Partial<Record<TabId, number>>;
  onSelect: (tab: TabId) => void;
  /** A short message for the user (a toast). */
  onNote: (title: string, body?: string) => void;
  /** Turned off in the browser preview (one window only). */
  native: boolean;
}

/** Pixels a press must move before it becomes a drag. */
const DRAG_START = 5;
/** How far off the strip (up or down) a tab tears out. */
const TEAR_OFF = 36;

interface Drag {
  tab: TabId;
  pointer: number;
  x0: number;
  y0: number;
  /** Where the press was inside the tab. */
  off: [number, number];
  mode: "press" | "reorder" | "out";
  /** The other tabs' [left, right] at the start, in order. */
  others: [number, number][];
  from: number;
  /** The dragged window (after a tear-out). */
  win: Promise<string | null> | null;
  ended: boolean;
  /** Main's last tab: said once per drag. */
  warned: boolean;
}

/** A name for a window in menus: its tabs. */
export function windowName(w: ShellWin): string {
  return w.label === MAIN ? "Main window" : `Window with ${w.tabs.map((t) => TAB_NAMES[t]).join(", ")}`;
}

export default function TabStrip({ tabs, active, label, windows, counts, onSelect, onNote, native }: Props) {
  const stripRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef(new Map<TabId, HTMLButtonElement>());
  const drag = useRef<Drag | null>(null);
  /** Removes the window listeners of the drag in progress. */
  const detach = useRef<(() => void) | null>(null);
  const [order, setOrder] = useState<TabId[] | null>(null);
  const [dragging, setDragging] = useState<TabId | null>(null);
  const [hintAt, setHintAt] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ tab: TabId; at: { x: number; y: number } } | null>(null);
  const shown = order ?? tabs;
  const isMain = label === MAIN;

  // A new layout replaces any preview.
  useEffect(() => setOrder(null), [tabs]);

  // Drop hints from a tab dragged over this strip.
  useEffect(() => {
    if (!native) return;
    let off: (() => void) | undefined;
    let alive = true;
    void shell.onHint((i) => setHintAt(i)).then((u) => (alive ? (off = u) : u()));
    return () => {
      alive = false;
      off?.();
    };
  }, [native]);

  // Tell the app where this strip and its tabs are, for drops from other windows.
  const report = useCallback(() => {
    const el = stripRef.current;
    if (!el || !native) return;
    const r = el.getBoundingClientRect();
    const rects = tabs
      .map((t) => tabRefs.current.get(t)?.getBoundingClientRect())
      .filter((x): x is DOMRect => !!x)
      .map((x) => [x.left, x.right] as [number, number]);
    void shell.reportStrip([r.left, r.top, r.right, r.bottom], rects).catch(() => undefined);
  }, [tabs, native]);
  useLayoutEffect(() => {
    report();
    const el = stripRef.current;
    if (!el) return;
    const ro = new ResizeObserver(report);
    ro.observe(el);
    window.addEventListener("resize", report);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", report);
    };
  }, [report]);

  const others = (tab: TabId): [number, number][] =>
    tabs
      .filter((t) => t !== tab)
      .map((t) => tabRefs.current.get(t)?.getBoundingClientRect())
      .filter((x): x is DOMRect => !!x)
      .map((x) => [x.left, x.right]);

  const finish = useCallback(() => {
    drag.current = null;
    detach.current?.();
    detach.current = null;
    setDragging(null);
    setHintAt(null);
  }, []);

  /** The drag left the strip: the tab (or this whole window) follows the cursor. */
  const tearOut = (d: Drag, e: PointerEvent) => {
    if (isMain && tabs.length === 1) {
      if (!d.warned) onNote("The main window keeps one tab", "Drag another tab here first, or move this one from its menu.");
      d.warned = true;
      return;
    }
    d.mode = "out";
    setOrder(null);
    const first = tabRefs.current.get(tabs[0])?.getBoundingClientRect();
    const own = tabRefs.current.get(d.tab)?.getBoundingClientRect();
    const grab: [number, number] = [(first?.left ?? 0) + d.off[0], (own?.top ?? e.clientY) + d.off[1]];
    d.win = shell.tearOut(d.tab, grab).catch((err) => {
      onNote("Could not move the tab", String(err));
      return null;
    });
    void (async () => {
      const win = await d.win;
      if (!win) return finish();
      // Follow the cursor until the button comes up.
      while (drag.current === d && !d.ended) {
        await shell.dragTo(win, grab).catch(() => null);
        await new Promise((r) => requestAnimationFrame(() => r(null)));
      }
    })();
  };

  const onPointerDown = (e: React.PointerEvent, tab: TabId) => {
    if (e.button !== 0) return;
    onSelect(tab);
    if (!native) return;
    const r = e.currentTarget.getBoundingClientRect();
    drag.current = {
      tab,
      pointer: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      off: [e.clientX - r.left, e.clientY - r.top],
      mode: "press",
      others: [],
      from: tabs.indexOf(tab),
      win: null,
      ended: false,
      warned: false,
    };
    // The whole window follows the drag (pointer capture alone can be lost
    // when the strip re-renders, and the pointer leaves the strip to tear out).
    detach.current?.();
    const mv = (ev: PointerEvent) => moveRef.current(ev);
    const up = (ev: PointerEvent) => endRef.current(ev);
    window.addEventListener("pointermove", mv, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    detach.current = () => {
      window.removeEventListener("pointermove", mv, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
    };
    try {
      stripRef.current?.setPointerCapture(e.pointerId);
    } catch {
      /* the window listeners carry the drag */
    }
  };

  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId || d.mode === "out") return;
    if (d.mode === "press") {
      if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < DRAG_START) return;
      d.mode = "reorder";
      d.others = others(d.tab);
      setDragging(d.tab);
    }
    const s = stripRef.current?.getBoundingClientRect();
    const off =
      !!s &&
      (e.clientY < s.top - TEAR_OFF || e.clientY > s.bottom + TEAR_OFF || e.clientX < 0 || e.clientX > window.innerWidth);
    if (off && !(isMain && tabs.length === 1 && d.warned)) {
      tearOut(d, e);
      if ((d.mode as Drag["mode"]) === "out") return;
    }
    const at = insertIndex(d.others, e.clientX);
    const rest = tabs.filter((t) => t !== d.tab);
    const next = [...rest.slice(0, at), d.tab, ...rest.slice(at)];
    setOrder((o) => (o && o.join() === next.join() ? o : next));
  };

  const end = (e: PointerEvent | null) => {
    const d = drag.current;
    if (!d || d.ended || (e && d.pointer !== e.pointerId)) return;
    d.ended = true;
    if (d.mode === "reorder") {
      const now = order ?? tabs;
      if (now.join() !== tabs.join()) void shell.reorder(now).catch(() => setOrder(null));
      else setOrder(null);
      finish();
    } else if (d.mode === "out") {
      const tab = d.tab;
      void (async () => {
        const win = await d.win;
        if (win) await shell.drop(win, tab).catch((err) => onNote("Could not dock the tab", String(err)));
        finish();
      })();
    } else finish();
  };

  const moveRef = useRef(onPointerMove);
  moveRef.current = onPointerMove;
  const endRef = useRef(end);
  endRef.current = end;
  useEffect(() => () => detach.current?.(), []);

  // Escape cancels a drag: the tab goes back where it was.
  useEffect(() => {
    if (!dragging) return;
    const onKey = (e: KeyboardEvent) => {
      const d = drag.current;
      if (e.key !== "Escape" || !d) return;
      e.preventDefault();
      e.stopPropagation();
      d.ended = true;
      setOrder(null);
      if (d.mode === "out") {
        void (async () => {
          const win = await d.win;
          if (win && win !== label) await shell.moveTab(d.tab, label, d.from).catch(() => undefined);
          finish();
        })();
      } else finish();
      try {
        stripRef.current?.releasePointerCapture(d.pointer);
      } catch {
        /* already released */
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [dragging, label, finish]);

  // ------------------------------------------------------------ menu
  const menuItems = (tab: TabId): PopMenuItem[] => {
    const items: PopMenuItem[] = [];
    const alone = tabs.length === 1;
    items.push({
      label: "Move to a new window",
      key: withKeys("", "global", "tab-new-window").replace(/[()]/g, "").trim() || undefined,
      off: alone,
      run: () => void shell.moveTab(tab, "new").catch((e) => onNote("Could not move the tab", String(e))),
    });
    const elsewhere = windows.filter((w) => w.label !== label);
    for (const w of elsewhere) {
      items.push({
        label: w.label === MAIN ? "Move to the main window" : `Move to: ${windowName(w)}`,
        off: isMain && alone,
        run: () => void shell.moveTab(tab, w.label).catch((e) => onNote("Could not move the tab", String(e))),
      });
    }
    const i = tabs.indexOf(tab);
    if (tabs.length > 1) {
      items.push("-");
      items.push({ label: "Move left", off: i <= 0, run: () => void shell.reorder(move(tabs, i, i - 1)) });
      items.push({ label: "Move right", off: i >= tabs.length - 1, run: () => void shell.reorder(move(tabs, i, i + 1)) });
    }
    if (!isMain) {
      items.push("-");
      items.push({ label: "Close window (tabs go back to the main window)", run: () => void shell.closeWindow() });
    }
    return items;
  };

  const openMenuFor = (tab: TabId, x?: number, y?: number) => {
    const r = tabRefs.current.get(tab)?.getBoundingClientRect();
    setMenu({ tab, at: { x: x ?? (r ? r.left : 8), y: y ?? (r ? r.bottom + 2 : 40) } });
  };

  return (
    <div
      ref={stripRef}
      role="tablist"
      aria-label="Tabs"
      className="relative flex h-full min-w-0 items-center gap-1"
      onDoubleClick={(e) => {
        // Double-click on the empty strip, like a title bar.
        if (e.target === e.currentTarget) void lastshot.toggleMaximize();
      }}
    >
      {shown.map((id, i) => (
        <div key={id} className="relative flex items-center">
          {hintAt === i && <span className="pointer-events-none absolute -left-1 top-0 h-full w-0.5 rounded bg-accent" />}
          <button
            ref={(el) => {
              if (el) tabRefs.current.set(id, el);
              else tabRefs.current.delete(id);
            }}
            type="button"
            role="tab"
            aria-selected={active === id}
            data-tab={id}
            tabIndex={active === id ? 0 : -1}
            title={native ? `${TAB_NAMES[id]} — drag off the strip for a window of its own; right-click for more` : TAB_NAMES[id]}
            onPointerDown={(e) => onPointerDown(e, id)}
            onClick={() => onSelect(id)}
            onContextMenu={(e) => {
              e.preventDefault();
              if (native) openMenuFor(id, e.clientX, e.clientY);
            }}
            onKeyDown={(e) => {
              if (native && (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey))) {
                e.preventDefault();
                e.stopPropagation();
                openMenuFor(id);
              } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                // Arrow keys move along the strip (tablist pattern).
                e.preventDefault();
                e.stopPropagation();
                const n = shown[(i + (e.key === "ArrowRight" ? 1 : -1) + shown.length) % shown.length];
                onSelect(n);
                tabRefs.current.get(n)?.focus();
              } else if (e.key === "Home" || e.key === "End") {
                e.preventDefault();
                const n = e.key === "Home" ? shown[0] : shown[shown.length - 1];
                onSelect(n);
                tabRefs.current.get(n)?.focus();
              }
            }}
            className={cn(
              "flex touch-none items-center gap-2 rounded-lg px-3.5 py-1.5 text-[12px] font-semibold transition-colors",
              active === id
                ? "border border-accent/40 bg-accent/15 text-accent-fg shadow-sm"
                : "border border-transparent text-ink-3 hover:bg-surface-2 hover:text-ink",
              dragging === id && "opacity-60 ring-1 ring-accent/50",
            )}
          >
            <span>{TAB_NAMES[id]}</span>
            {counts?.[id] !== undefined && (
              <span
                className={cn(
                  "rounded-full px-1.5 py-0.5 font-mono text-[10px]",
                  active === id ? "bg-accent/25 text-accent-fg" : "bg-surface-2 text-ink-3",
                )}
              >
                {counts[id]}
              </span>
            )}
          </button>
        </div>
      ))}
      {hintAt !== null && hintAt >= shown.length && (
        <span className="pointer-events-none h-6 w-0.5 rounded bg-accent" aria-hidden="true" />
      )}
      {menu && (
        <PopMenu
          at={menu.at}
          label={`${TAB_NAMES[menu.tab]} tab`}
          items={menuItems(menu.tab)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

function move<T>(list: T[], from: number, to: number): T[] {
  const out = [...list];
  const [x] = out.splice(from, 1);
  out.splice(to, 0, x);
  return out;
}
