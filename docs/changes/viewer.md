# Viewer and pop-out frames (feat/viewer)

Changelog lines for this branch. They go into CHANGELOG.md when the branch is merged.

## Viewer (clip editor and snip editor)
- **Zoom to single pixels.** The wheel zooms at the cursor from fit up to 6400 %. Above 100 % pixels are drawn square and sharp, and from about 1200 % a faint pixel grid appears. Fit, 1:1 and Fill buttons; keys 0, 1, 2, + and −.
- **Pan** by dragging (the clip editor), Space+drag or the middle button (everywhere).
- **Turn and flip:** [ and ] turn 90°, { and } turn 15°, Alt+wheel turns freely (snaps to right angles). H mirrors left↔right as you see it, even when turned (the artist's mirror check); Shift+H flips upside down. Ctrl+0 resets.
- **Frame by frame:** , and . step one frame (Shift: 10), Ctrl+wheel scrubs, J/K/L slow down, reset and speed up (0.1×–4×), Shift+L loops the clip, A and B loop a part.
- **Colour picker:** C shows x, y, hex, RGB, HSL and value under the cursor; a click copies the hex and keeps it in a row of swatches.
- **Measure:** D, then drag a line for its length, width × height and angle in pixels (Shift: 45° steps).
- **Crop the view:** Shift+C, then drag a box.
- **Compare:** W makes the current frame "B" (or pick a file, or paste one), then cycles wipe (drag the line), difference and side by side.
- **Artist helpers:** value check (M, shows only light and dark), grids (G: thirds or your own columns × rows, any colour and opacity, optional diagonals), colour adjustments (E: brightness, contrast, saturation, hue, grayscale, invert, tint).
- **Onion skin** (N): while paused, the frames before (red) and after (green) show as ghosts, 1 or 2 each way.
- **Frame out:** Ctrl+C copies the current frame as a picture; Ctrl+S saves it as a lossless PNG in the Screenshots folder.
- The snip editor gets the same viewer: zoom in to mark up single pixels, check colours, measure, mirror. Markup works at any zoom.
- Every button has a tooltip with its shortcut, and "?" lists them all.
- Fast at 4K: the picture is drawn once per change on a canvas through a GPU transform, colour adjustments and difference compare run in the GPU compositor, and nothing is decoded again when zooming.

## Pop-out frames (work in progress, not usable yet)

Done so far (not wired into the app, not built into an exe, not tested in the real app):
- Rust `src-tauri/src/frames.rs`: borderless see-through frame windows (`frame-<id>`), shown without taking focus, saved in `%APPDATA%\Lastshot\frames.json` with their pictures in `frames\`, opacity / on top / click-through / hide, fullscreen, raise, close, click-through-all shortcut (default Ctrl+Alt+Shift+X, never registered in test instances), tray submenu, frame from clipboard. Test instances always place frames at x = -20000. Rust tests pass in the free build and with `--features pro-board`.
- Frontend: `src/popout/frames.ts` (API), `src/popout/snap.ts` (resize with shape kept, Shift frees it, snapping; unit tested), `src/popout/FrameWindow.tsx` (window contents: move bar, opacity, toggles, resize edges, viewer; typechecks, never run).
- Open-core seam: Cargo feature `pro-board` (`src-tauri/src/pro_board.rs`, behind `#[cfg(feature = "pro-board")]` in `lib.rs` and `frames.rs`), and the `lastshot-pro` import alias in `vite.config.ts` / `tsconfig.json` (`src/popout/pro-api.ts`, `src/popout/no-pro.ts`; `src/pro/index.ts` with `VITE_PRO_BOARD=1`).

To do:
1. Route `frame-*` window labels in `src/main.tsx` to a lazy `FrameWindow`.
2. Pop-outs panel in the main window (`src/popout/FramesPanel.tsx`, one line in `App.tsx`): list frames with every toggle and slider, click-through all, hide all, close all, shortcut editor, frame from clipboard, open a picture, drop or paste pictures onto the main window. Opens on the `lastshot://frames-panel` event.
3. "Pop out" buttons: clip trimmer (`viewerExtra`: this frame / the playing clip), snip editor (`snipExtra`, Ctrl+P), and a library right-click hook for the recorder's `ClipsExplorer.tsx` (`popOutClip`).
4. Build the exe (free) under the build lock, measure its size (must stay under 10 MB), copy it to `D:\Others\Lastshot\Lastshot_test_2026-11-16_viewer.exe`.
5. Off-screen e2e test (isolated profile, `LASTSHOT_TEST_INSTANCE=1`, CDP port 9336): check WS_EX_TRANSPARENT|WS_EX_LAYERED, that a click-through frame is still drawn (tao adds WS_EX_LAYERED without SetLayeredWindowAttributes; if the frame goes blank, call SetLayeredWindowAttributes(255, LWA_ALPHA)), WindowFromPoint hit test, no focus taken, RAM per frame window. If a WebView frame costs much more than 20–30 MB, make picture pins native (layered window) and keep WebView for video frames and boards.
6. Lastshot Pro: Reference board (`src/pro/board/`) and live pop-outs. Not started beyond the Rust side (`board_keep_picture`, `board_allow`, tray entry).
7. Extras (drag a frame out as a file, floating thumbnail after a snip, pixel ruler), and the "Pop-out frames and viewer" section in `docs/ROADMAP.md`.
