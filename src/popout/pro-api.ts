/**
 * The one seam between the free app and Lastshot Pro (open core).
 *
 * `import pro from "lastshot-pro"` resolves (vite.config.ts alias) to
 * `src/pro/index.ts` when built with `VITE_PRO=1` (or `VITE_PRO_BOARD=1`),
 * and to `src/popout/no-pro.ts` otherwise, so a free build never sees Pro code
 * and builds fine when `src/pro/` is missing. Both export a `ProModule`.
 */
import type { ComponentType } from "react";
import type { Frame, FrameCmd } from "./frames";

export interface FrameBodyProps {
  frame: Frame;
  /** Shows a short status line in the frame. */
  status: (msg: string) => void;
}

export interface ProAction {
  label: string;
  title: string;
  run: () => void | Promise<unknown>;
}

/** The app's toast, as the Audio tab's sections get it. */
export type ProToast = (tone: "ok" | "err" | "warn" | "info", title: string, body?: string) => void;

/** Props of an extra Audio tab section: `live` is true while the tab is on screen. */
export interface AudioSectionProps {
  live: boolean;
  onToast: ProToast;
}

export interface ProModule {
  /** Draws the inside of a frame of a Pro kind ("board", "live"). */
  FrameBody: ComponentType<FrameBodyProps> | null;
  /** Extra buttons in the Pop-outs panel ("New reference board", …). */
  panelActions: ProAction[];
  /** The Pop-outs panel's view buttons a Pro frame kind handles (by kind). */
  frameCommands?: Partial<Record<string, FrameCmd[]>>;
  /** Extra sections at the end of the Audio tab, in this order. */
  audioSections: ComponentType<AudioSectionProps>[];
}
