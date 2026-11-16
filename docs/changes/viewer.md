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
