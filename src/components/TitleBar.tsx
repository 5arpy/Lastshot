import { lastshot } from "../lib/bridge";
import { cn } from "../utils/cn";

interface Props {
  armed: boolean;
  native: boolean;
  version: string;
  /**
   * A window of tabs dragged out of the main one: its close button sends the
   * tabs back to the main window (no tray, no quit here).
   */
  onCloseWindow?: () => void;
}

export default function TitleBar({ armed, native, version, onCloseWindow }: Props) {
  return (
    <header
      className="drag-region flex h-10 shrink-0 select-none items-center justify-between border-b border-line bg-app px-3.5"
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest(".no-drag")) return;
        void lastshot.startDragging();
      }}
    >
      <div className="flex items-center gap-2.5">
        {/* App Mark */}
        <div className="flex h-5 w-5 items-center justify-center rounded bg-surface-2 text-accent-fg border border-line">
          <svg viewBox="0 0 16 16" className="h-3 w-3 fill-current" aria-hidden="true">
            <path d="M4 3.5v9l8-4.5-8-4.5z" />
          </svg>
        </div>

        <div className="flex items-baseline gap-1.5">
          <span className="text-[13px] font-semibold tracking-normal text-ink">
            Lastshot
          </span>
          <span className="font-mono text-[10px] text-ink-3">
            v{version}
          </span>
        </div>

        <span
          className={cn(
            "flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium tracking-wide",
            armed
              ? "border border-emerald-500/30 bg-emerald-500/10 text-ok"
              : "border border-line bg-surface text-ink-3",
          )}
        >
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              armed ? "bg-emerald-400 animate-rec" : "bg-ink-4",
            )}
          />
          {armed ? "Instant replay on" : "Instant replay off"}
        </span>

        {!native && (
          <span className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 font-mono text-[10px] text-warn">
            SIMULATED PREVIEW
          </span>
        )}
      </div>

      <div className="no-drag flex items-center gap-1">
        <button
          onClick={() => void lastshot.minimize()}
          className="grid h-7 w-8 place-items-center rounded text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
          title="Minimize"
          aria-label="Minimize"
        >
          <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.25">
            <line x1="2" y1="6" x2="10" y2="6" />
          </svg>
        </button>
        <button
          onClick={() => void lastshot.toggleMaximize()}
          className="grid h-7 w-8 place-items-center rounded text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
          title="Maximize"
          aria-label="Maximize"
        >
          <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.25">
            <rect x="2.5" y="2.5" width="7" height="7" rx="0.5" />
          </svg>
        </button>
        {onCloseWindow ? (
          <button
            onClick={onCloseWindow}
            className="grid h-7 w-8 place-items-center rounded text-ink-3 transition-colors hover:bg-red-500/20 hover:text-danger"
            title="Close this window (its tabs go back to the main window)"
            aria-label="Close window"
          >
            <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.25">
              <line x1="2.5" y1="2.5" x2="9.5" y2="9.5" />
              <line x1="9.5" y1="2.5" x2="2.5" y2="9.5" />
            </svg>
          </button>
        ) : (
          <>
            <button
              onClick={() => void lastshot.hideToTray()}
              className="grid h-7 w-8 place-items-center rounded text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
              title="Hide to tray (keeps recording in background)"
              aria-label="Hide to tray"
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.25">
                <path d="M3 4l4 4 4-4" />
                <line x1="2" y1="11" x2="12" y2="11" />
              </svg>
            </button>
            <button
              onClick={() => void lastshot.quit()}
              className="grid h-7 w-8 place-items-center rounded text-ink-3 transition-colors hover:bg-red-500/20 hover:text-danger"
              title="Quit Lastshot"
              aria-label="Quit"
            >
              <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.25">
                <line x1="2.5" y1="2.5" x2="9.5" y2="9.5" />
                <line x1="9.5" y1="2.5" x2="2.5" y2="9.5" />
              </svg>
            </button>
          </>
        )}
      </div>
    </header>
  );
}
