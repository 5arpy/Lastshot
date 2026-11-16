import { useEffect, useRef } from "react";
import { cn } from "../utils/cn";

/** One menu row; "-" is a divider. */
export type PopMenuItem = { label: string; key?: string; run: () => void; off?: boolean; danger?: boolean } | "-";

/**
 * A small right-click / keyboard menu: opens at a point, arrows and
 * Home/End move, Enter runs, Escape / Tab / a click outside close it, and
 * focus goes back where it was.
 */
export default function PopMenu({
  at,
  items,
  onClose,
  label,
}: {
  at: { x: number; y: number };
  items: PopMenuItem[];
  onClose: () => void;
  label?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const back = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    back.current = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const close = () => closeRef.current();
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      back.current?.focus?.({ preventScroll: true });
    };
  }, []);
  const onKey = (e: React.KeyboardEvent) => {
    const list = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape" || e.key === "Tab") onClose();
    else if (e.key === "ArrowDown") list[(i + 1) % list.length]?.focus();
    else if (e.key === "ArrowUp") list[(i - 1 + list.length) % list.length]?.focus();
    else if (e.key === "Home") list[0]?.focus();
    else if (e.key === "End") list[list.length - 1]?.focus();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const rows = items.filter((m) => m !== "-").length;
  const dividers = items.length - rows;
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={onKey}
      style={{
        left: Math.max(4, Math.min(at.x, window.innerWidth - 264)),
        top: Math.max(4, Math.min(at.y, window.innerHeight - rows * 28 - dividers * 9 - 12)),
      }}
      className="fixed z-[80] w-64 rounded-lg border border-line-3 bg-surface-2 py-1 text-[12px] shadow-xl"
    >
      {items.map((m, i) =>
        m === "-" ? (
          <div key={i} className="my-1 h-px bg-line" />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            disabled={m.off}
            onClick={() => {
              onClose();
              m.run();
            }}
            className={cn(
              "flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left outline-none hover:bg-surface-3 focus:bg-surface-3 disabled:opacity-35",
              m.danger ? "text-danger" : "text-ink",
            )}
          >
            <span className="truncate">{m.label}</span>
            {m.key && <span className="shrink-0 font-mono text-[10px] text-ink-3">{m.key}</span>}
          </button>
        ),
      )}
    </div>
  );
}
