# Changelog

All notable changes to **Lastshot** (and, before 1.7.1, to **ClipFlow**, which Lastshot is forked from) are documented here. The project follows [Keep a Changelog](https://keepachangelog.com/) and [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Record one window or app.** Home's *Record screen* has *Full screen* and *Window / app*; Studio has *What to record*. Pick any open window from a searchable list. Lastshot records just that window (Windows Graphics Capture, no yellow border on Windows 11), even when it is covered by other windows, and finds the app again if its window is re-created. Instant replay follows the same choice.
- **Mouse pointer in recordings.** Full-screen recordings and replays now show the mouse pointer (drawn on the GPU at no measurable cost; the text cursor gets an outline so it shows on any background). Turn it off with *Mouse pointer* in Studio or Settings › Instant replay. Window recordings follow the same setting.
- **Audio tab: a simple remote for Voicemeeter.** If you have Voicemeeter, Banana or Potato, the new *Audio* tab shows every input and output as a channel with a fader, a live meter, mute and its name (click to rename). Light up A1–A5 / B1–B3 on an input to send it there; short hints say what each one is (A = speakers and headsets, B1 = what Discord can use as a mic). Lastshot only uses Voicemeeter's free remote: your mixing still runs in Voicemeeter, also with Lastshot closed. If Voicemeeter isn't running, a *Start it* button starts it.
- **Send an app to its own output.** The Audio tab lists the apps that make sound, each with *Send to*: Windows' default, a Voicemeeter input (Input, AUX, VAIO3) or any other output, like Windows' own *App volume and device preferences*. Lastshot remembers the choice and sets it again whenever the app starts. Works without Voicemeeter too.
- **Pop out a tab.** *Pop out* (next to the tabs) opens Audio, Editor or Studio in a window of its own, with its own taskbar button. It remembers its size and place. The main window shows where the tab went, with *Bring back*; closing the window brings the tab back as well.
- **Whose sound.** *PC sound* can now be *Everything*, *Only one app* (just the game) or *Everything except one app* (leave out Discord), in Studio and Settings › Sound. The sound follows the app when it starts or restarts. Needs Windows 10 (2004) or newer.

- **Studio layers are part of the video.** Pictures, text, the clock, the timer and the webcam are drawn into replays and recordings by the recorder, also when Lastshot runs in the tray without its window. Studio shows a live preview while it is open.
- **Window capture method** in Studio: *Automatic*, *Crop from screen* or *Graphics Capture*. Full screen falls back to Graphics Capture by itself when the usual capture can't start or stays black.
- **Clips named after the game** (`Roblox 2026-11-16 20-15-03.mp4`), in **a folder per game** (on by default; Settings › *Sort clips into a folder per game*).
- **Clips works like File Explorer:** game folders, path bar, back / forward, *All clips*, *Recent*, grid or details view, search. Select several clips, make folders, rename (F2), move, drag onto a folder, cut / copy / paste, *Show in File Explorer*, *Copy for Discord*. It updates by itself when files change in Explorer.
- **Always on, in the tray.** With *Launch at startup*, Lastshot starts in the tray with instant replay on and no window. It restarts itself after a crash (up to three times in a row) and after a Windows update restart.
- **Scenes in Studio:** save a source plus its layers and switch with one click. **Crop** pictures and the webcam.
- **Portable mode:** an empty file named `portable` next to `lastshot.exe` keeps all settings in a `Lastshot data` folder beside it.
- **Sound meters** in Studio, and **Clean up my voice** (off by default): less background noise, steadier level, no clipping.
- **Audio → Devices:** default playback and recording devices with a fallback order; per app: microphone, volume, mute, solo and a meter.
- **Audio guard** (off by default): when Windows or an app changes a default device or moves an app, Lastshot asks, puts it back, or only logs it. Automatic backups of the audio setup, named setups, a change history, auto-duck and a mic-mute shortcut.
- **Audio → Cables (Lastshot Pro):** Lastshot's own virtual audio cables, without Voicemeeter. Not in the free build.
- **Viewer: zoom to single pixels** (up to 6400 %, sharp pixels, pixel grid), pan, turn and flip (H mirrors), frame by frame (`,` and `.`), slow motion and loops, colour picker (C), measure (D), crop the view, compare (wipe, difference, side by side), value check, grids, colour adjustments, onion skin. Ctrl+C copies the frame, Ctrl+S saves it as a PNG. The snip editor has the same viewer. "?" lists every key.
- **Pop-out frames.** Pop out a snip, a picture, a clip's current frame or the playing clip into a borderless window that stays on top, to trace or copy from in another app (Blender, a drawing app). Opacity down to 5 %, click-through (clicks go to the app below), zoom and pan inside the frame, flip, grayscale and a grid, free resize with the shape kept (Shift frees it). Frames snap to screen edges and to each other, never take the keyboard focus, and remember their place, size and settings. *Show over: only Blender* (any app) shows a frame only while that app or Lastshot is in front. Control them all from the *Pop-outs* panel (top bar), the tray, or **Ctrl+Alt+Shift+X** (click-through on / off for every frame). Drop a picture on Lastshot or paste one (Ctrl+V) to pop it out.

### Changed

- **Deleting clips moves them to the Recycle Bin**, so they can be restored. Automatic cleanup of old clips still frees the space for good.

### Fixed

- A recording started right after Lastshot started (or right after a settings change) could have no sound at all. It now always gets its sound track, from the first frame.
- Changing what to record and pressing *Record* straight away could record with the old setting and then cut the recording short.
- **Shortcuts like Alt+C could stop working for good** when another app briefly held one at start-up. Each shortcut is now set up on its own, retried every 3 seconds and checked every 10 seconds (and after sleep or unlocking). If one stays taken, a notification says so, and Settings shows *Not working* with *Try again*.
- The microphone slider in Studio set the volume to almost nothing.
- Quitting left the tray icon behind until the mouse passed over it.
- 60 fps replays and recordings could drop frames or play unevenly; frames are now placed on an even 60 fps grid.

## [1.9.0] - 2026-11-15

### Added

- **Editor panel: a timeline video editor.** A new *Editor* tab with a video track, an overlay track and a music/sound track. Add your clips, other videos, pictures, text and music; drag parts along the timeline, trim their ends, split at the playhead (**S**), delete, undo/redo and zoom. Pictures and text on top can be moved and resized right on the preview, with opacity and fades for sound. *Render video* makes one MP4 (pick size, frame rate and full quality or a target size in MB) and adds it to Clips. Rendering is built in (Windows Media Foundation on your GPU), so the app stays small. Any clip in the clip editor has *Open in Editor*, and videos dropped on the window while the Editor is open go onto its timeline.
- **Studio panel: recording with layers.** A new *Studio* tab puts pictures, text, your webcam (round, rounded or square, mirrored, with a border), a clock and a recording timer on top of your screen, OBS-style. Place and size them on a live picture of the screen; the layers are drawn over that screen, so recordings, instant replays and screenshots include them. Show them only while recording (default), always, or never. The tab also holds the recording options (screen, frame rate, PC sound, microphone and its volume, control bar) and the record buttons.
- **Draw while recording.** *Draw* on the control bar opens pen, highlighter, arrow and box tools in five colours, with undo and clear, like the snipping tool. The drawing is part of the recording. *Use PC* lets clicks go through to your apps while the drawing stays; *Done* removes it.
- **Control bar can come back.** *–* shrinks the bar to a small pill with the timer (click to expand); *✕* hides it. Bring it back with *Show bar* on Home or *Show the control bar* in the tray, while recording.
- **Saving notice.** While a recording is being saved (and cut to the area), a notice with a progress bar sits where *Clip saved* appears, then turns into it.
- **Custom crop.** The clip editor's crop has *Custom*: drag any corner or side of the box to any size. Fixed shapes (16:9, 9:16, 1:1, 4:3) can be resized from their corners too.
- **Screen recording.** Press **Alt+R** (or **Start recording** on Home) to record the screen until you stop, with pause and resume and no time limit. Recordings land in Clips like replays. Turning instant replay off or quitting finishes a running recording first.
- **Snip bar: Screenshot | Record.** **Alt+S** opens the snipping overlay with a bar at the top to switch between *Screenshot* and *Record*. In Record, drag a box or click a window (or *Full screen*), then **Start recording**: only that area is kept. Also on Home (*Record screen › Area / window*), on the control bar (*Area*) and in the tray (*Snip: record an area*). The area is cut out when you stop (on the GPU, full quality); if that fails, the whole-screen recording is kept.
- **On-screen control bar** with the timer, pause, stop, microphone mute, screenshot and a button back to Lastshot. While recording it also shows the area and the file size so far, and has **Mark moment** (marks show on the editor timeline), **Delete** (asks first) and a button to hide it until the next recording. Windows leaves it out of every capture, so it never appears in recordings, replays or screenshots. Show it while recording (default), always, or never (Settings › Screen recording, or right on Home).
- **New Home.** Three clear actions, each with its shortcut in view: *Save replay* (with how much to keep), *Record screen* and *Screenshot*. A status line says whether instant replay is on. Compact *PC sound* and *Microphone* tiles explain what they record and open their settings when clicked.
- **Folders and space in Clips.** A sidebar lists all clips, the Lastshot folder and its game subfolders, and your extra folders, each with its clip count and size, plus a bar per drive showing clips, other files and free space. Click a folder to show only its clips; open it in Explorer or remove it from there. Home warns when the drive with your clips runs low.
- **Move to Lastshot folder** in the editor for clips from an extra folder (keeps stars and tags, works across drives).
- **Open any video.** Drop an MP4/MOV/M4V on the window, or turn on **Open with Lastshot** (Settings › Clips & storage › Advanced) to get it in Explorer's right-click menu.
- Clips refreshes by itself while it is open and when you come back to the window.
- Tray menu: *Start / stop screen recording*.
- **Parts in the editor.** Press **S** (or *Split here*) to split the clip into parts, drag parts to change their order, and play, save, share or remove any single part. Playback and *Save as new clip* follow your order. (The old *Split* button, which saves two files, is now *Split into 2 files*.)
- **Instant replay up to 60 minutes.** Type any length in seconds (Settings › Instant replay), next to the presets. It only uses RAM; Settings shows how much and warns when it is more than is free. The memory cap is now half your RAM instead of a fixed 1.5 GB.
- **Screenshot settings:** your own folder, PNG or JPG (with quality), and whether to copy to the clipboard. The shortcut can be changed right there too.
- **Screen recording settings:** your own folder for recordings (they still show up in Clips), and the shortcut.
- **Streamer mode** (Settings › App) hides folder paths everywhere in the window, since they can show your Windows user name. Only folder names are shown.
- *Open screenshots folder* on Home shows where that is.

- **More folders in Clips.** Settings › Clips & storage › *Also show clips from*: add any folder (another recorder's clips, an old archive, a second drive). Its videos show up in Clips with a 📁 badge and a folder filter, and can be edited, shared, starred and joined like your own. Lastshot keeps saving only to its save location; edits of those clips land there too, and auto-delete / Delete all never touch the extra folders.

### Changed

- **Settings are easier to find.** Frame rate and screen are main settings now; Sound has no hidden part (volumes and microphone choice are right there, with what each one records). Shortcuts list all four actions. Labels say "instant replay" instead of "buffer".
- App icon: the play triangle is centred between the corner marks.
- **Lastshot is fully separate from ClipFlow.** It no longer copies ClipFlow's settings, favorites or tags on first run, no longer has access to the ClipFlow clips folder, and new installs save to `Videos\Lastshot`. Existing Lastshot settings are kept; to see old ClipFlow clips, add `Videos\ClipFlow` as an extra folder.

### Fixed

- Alt+Tab away from Lastshot needed two presses while the control bar was up: the bar (and the snip overlay) are no longer in the Alt+Tab list.
- Recordings are titled "Recording …" in Clips instead of "Clip Recording_…".
- Privacy mode now recognises Lastshot's own window (it still looked for ClipFlow's).

## [1.8.0] - 2026-11-15

### Added

- **Clip editor.** The trimmer is now an editor:
  - **Cut out** any part (select it, press **X**). Cuts show on the timeline, and playback skips them. Undo a cut from its chip.
  - **Crop** to 16:9, 9:16 (TikTok, Shorts), 1:1 or 4:3. Drag the box to place it, and use the size slider to zoom.
  - **Save as new clip** stays lossless and instant for a plain trim. With cuts or a crop, it re-encodes once at full quality on the GPU (about a third of real time). The original is never changed.
  - **Shrink & copy** shares the edit, cuts and crop included.
- **Join clips.** Select two or more clips in Clips, then press **Join**. They are joined oldest first into a new clip in the clips folder.

## [1.7.1] - 2026-11-15 — first Lastshot release

(1.7.0 was tagged but never published: its release build stopped on a workflow ordering mistake. 1.7.1 has the same app code.)

### Added

- **Screenshot tool.** Press **Alt+S** (or the Screenshot button), then drag a box, click a window, or press **F** for the whole screen. Mark it up with a box, arrow, pen or blur (blur pixelates from the original picture, so it cannot be reversed), then **Enter** copies it and **Ctrl+S** saves it too. Screenshots can also be saved to `Videos\Lastshot\Screenshots` automatically.
- **Shrink & copy.** One click makes a clip (or the part selected in the editor) small enough for Discord and puts it on the clipboard. The size limit is a setting (10 MB by default, with presets for Nitro), so a Discord policy change needs no app update. Lastshot chooses the resolution and frame rate for the size and duration, re-encodes on the GPU, and retries with a lower bitrate if the result comes out too big. Clips already under the limit are copied as they are.
- **Drag clips out** of Lastshot into Discord, a browser upload box or Explorer.
- **Soft dark theme**, now the default, with Dark / Light / System in Settings.
- Starred clips are **never deleted** by automatic cleanup.

### Changed

- **Simpler layout.** Home, Clips and Settings only. Home has quick actions instead of encoder statistics. Clips shows search, sort and starred, and a **More** button reveals the rest (game filter, select, compact view, library statistics). Every Settings section has its own **Advanced** button. Game profiles and pipeline diagnostics moved into those advanced areas.
- **Updates.** The broken self-updater is gone. With the startup check turned on, Lastshot asks GitHub for the newest version and opens the download page. Nothing downloads in the background.
- New name, icon and app ID. Settings live in `%APPDATA%\Lastshot`. ClipFlow settings, stars and tags are imported on first start.

### Fixed

- **Memory leak in the audio encoder.** Every AAC output sample was leaked (a windows-rs `ManuallyDrop` field that was never released), so ClipFlow grew by about 0.5–0.8 GB per hour while recording. Memory now stays flat: once the replay buffer had filled, a 90-minute recording test stayed between 200 and 240 MB the whole time.
- **60 FPS recordings came out at 30 FPS.** With asynchronous hardware encoders, every other frame was submitted while the encoder was not ready and silently dropped. Frames are now handed over only when the encoder asks for input, and real drops are counted. Measured: 7158 frames in 119.3 s = 60.0 FPS.

## [1.6.0] - unreleased

### Fixed

- **Saving could leave the engine stuck in "Saving…" forever.** `flush_to_disk` set the engine to `Flushing` and then used `?` on folder creation and the mux, returning *before* restoring the previous state. One disk-full, locked-file or unmounted-folder error left the deck showing "Saving clip to disk…" with the Save button disabled until the engine was restarted — which also dropped the buffer. Every failure path now restores the state and deletes the partial MP4.
- **Longer replay buffers silently delivered less than requested.** `RollingRingBuffer::set_window` changed the time window but never updated the byte ceiling that enforces it, so going 60 s → 300 s kept the 60 s cap (~141 MB at 12 Mbps) and held roughly 96 s. The ceiling is now recomputed from `(window, bitrate)` on every change.
- **Concurrent saves could overwrite each other.** The flush lock lived in the hotkey path only, so a deck save racing `Alt + C` could mux into the same second-resolution filename. The lock now belongs to the engine and covers every entry point (deck, hotkey, tray, auto-save), and filenames get a numeric suffix on collision instead of silently replacing the earlier clip.
- **Tray "Save last 30 s" saved a clip nobody could see.** It wrote the file without building metadata or emitting the save event, so the gallery did not refresh and no confirmation appeared. It now routes through the same shared path as the deck and the hotkey.
- **Clip previews broke after changing the output folder.** The `asset:` protocol scope is a static glob in `tauri.conf.json`, so a library moved to e.g. `D:\Clips` still listed thumbnails (they are data URLs from Rust) while the trimmer's `<video>` refused to load. The scope is now widened at runtime to the configured folder.
- **Settings could be half-applied.** `update_settings` mutated the live settings as it went, so a failure partway through (folder creation, autostart registry, disk full on save) left memory and `settings.json` disagreeing — a new hotkey registered with Windows but never persisted would silently revert on restart. The patch is now applied to a clone and committed only after the save succeeds.
- **Privacy mode leaked audio into the buffer.** The gate cleared the ring, but the audio thread never checked it, and `prune()` anchored audio eviction to the (now empty) video queue — so audio accumulated without bound while the user was alt-tabbed. The audio thread now honours the gate and the ring bounds the audio track independently.
- **Batch operations froze the window.** Deleting, renaming, snapshotting, and enumerating monitors or audio devices ran on the main thread; a batch delete of hundreds of clips locked the whole UI. They now run on the blocking pool.
- **Snapshots overwrote each other.** Two frame grabs from the same clip resolved to the same PNG name and the first was lost; collisions now get a suffix.
- **`CHANGELOG.md` contained corrupted emoji** (broken surrogate pairs from an earlier encoding round-trip), and the file carried a double BOM. Both are cleaned up.

### Changed

- **Update checks are now opt-in.** ClipFlow described itself as having "no background updater" while calling the updater on every launch, which opens an HTTPS connection to GitHub before the user has read anything. The startup probe now defaults to **off** and can be enabled in Settings. README and the bundle description were corrected to match.
- **The window is now single-instance.** The code claimed it, but the plugin was never added, so a second launch fought the first over DXGI Desktop Duplication and failed with a confusing capture error. Launching again now focuses the existing window.

### Known limitation

- **Automatic updates are disabled in this build.** The `TAURI_SIGNING_PRIVATE_KEY` secret does not match the minisign public key embedded in `tauri.conf.json`, so no signed `latest.json` can be produced — every release since v1.4.2 failed at the signing step for this reason. This release ships plain installers with `createUpdaterArtifacts: false`. The **Check for Updates** button now says so plainly and opens the Releases page instead of surfacing a raw plugin error. Recording, saving, trimming and the library are unaffected. Restoring auto-update requires a valid key pair; the steps are documented at the top of `.github/workflows/release.yml`, and users on the old key will need one manual reinstall.

### Removed

- **GIF export** — `media/gif.rs` (825 lines, 16 tests) and the `export_clip_gif` command were unreachable from the UI since 1.5.0. Removed together with the `gif` and `color_quant` crates.
- **HUD overlay leftovers** — `set_hud_visible`, `force_topmost`, `set_window_excluded_from_capture`, `hud_enabled` and `hud_position`. The window itself was already gone; these were dead weight that made the overlay look supported.
- **Unused IPC commands** — `read_clip_as_data_url`, `get_system_report`, `get_output_dir`, `show_main_window`, `set_save_hotkey`, `set_toggle_hotkey`. None had a caller.
- **Unused dependencies, features and capabilities** — `once_cell`, `crossbeam-channel`, ten unused `windows` features, the `fs:` permissions and `tauri-plugin-fs` (the frontend never imported it), and the non-existent `trimmer` window from the capability list.

### Tests

- **New ring-buffer suite (15 tests)** covering the logic that decides whether a clip can be saved at all: GOP-aligned eviction, "last N seconds" snapshots, generation isolation, the byte ceiling tracking the window, and audio hygiene. `prune`/`snapshot` previously had **zero** coverage while the removed GIF module had sixteen.
- Rust suite: 43 passing. Frontend: 61 passing. `cargo check` is warning-free.

## [1.5.0] - 2026-10-24

### Performance

- **Game Mode is now the default** — capture is capped at **1080p / 60 FPS**, the hardware encoder is biased toward speed (`CODECAPI_AVEncCommonQuality = 55` + `AVEncCommonQualityVsSpeed = 80`, B-frames off), >1080p monitors are downscaled with the correct aspect ratio, and the video processor runs in `OPTIMAL_SPEED` mode. The 60 FPS cap is now enforced on **every** start path (deck ARM, Apply & Restart, profile switch and hotkey), not just at launch. Clip audio and lossless trimming are unaffected. A toggle in **Settings → Performance & Game Mode** restores native-resolution capture if wanted.
- **Integrated-GPU awareness** — when the capture adapter is an integrated GPU (Intel Iris Xe/UHD, AMD Radeon Graphics), Game Mode tightens automatically to **720p / 30 FPS / 6 Mbps**: the game and the encoder share one chip and its memory bandwidth, so this is the setting that actually protects frame rate. The deck shows "Integrated GPU detected" with the adapter name, and turning Game Mode off still gives full native resolution.
- **Removed the frame-drop sources** — the always-on-top HUD overlay window is gone, gallery cards no longer autoplay a decoded video on hover, GIF export was removed from the trimmer, and the "Simulate GPU Reset" test button is gone.
- **Gentler thread scheduling** — in Game Mode the capture thread runs at `THREAD_PRIORITY_NORMAL` and the audio thread at `NORMAL` (polling at 10 ms) so the game always wins a scheduling race; with Game Mode off they stay at `ABOVE_NORMAL`. Neither uses MMCSS or `TIME_CRITICAL` any more, and the capture loop no longer spin-waits the last 0.4 ms of every frame.
- **No decode spike when a clip is saved** — thumbnails are no longer generated synchronously on the save hotkey. The gallery and Home "Recent Replays" decode them lazily, only while the ClipFlow window is actually visible, and share one cache.
- **Background work goes quiet** — engine stats are emitted at 1 Hz and only while the main window is visible (and one failed emit can no longer kill the heartbeat); the recording pulse animation pauses while the deck is hidden or unfocused; battery/RAM polling runs only when ECO is enabled; foreground focus polling runs only when auto-switch, privacy mode or auto-save-on-exit is enabled, and at 5 s instead of 2 s; per-game folder resolution no longer reads cross-process window titles.
- **Gallery** — thumbnails stay static (click to open the trimmer and decode there), so browsing never competes with the game for the video decoder.

### Changed

- **☀ New soft off-white UI theme** — the whole app (deck, gallery, trimmer, settings, dialogs, toasts) is now a low-glare gray off-white: `#e9ecef` background, `#f8f9fa` cards, `#d3d9e0` borders, dark slate text and a blue accent. Nothing is pure white any more, so long sessions in a dark room are easier on the eyes; focus rings, inputs, sliders and hover states were retuned for contrast.
- **Friendlier home screen** — the technical "Recording Pipeline" card became a plain-language **Performance** card (Game Mode status, capture/encoder/audio health) with diagnostics behind a disclosure.
- **Audio clipping and video trimming remain first-class** — game audio, microphone mixing and keyframe stream-copy trim/split are untouched by the performance work.

### Removed

- HUD overlay window, hover video previews, GIF export and the GPU-reset simulation button.

## [1.4.2] - 2026-08-11

### Added

- **The overlay is now a real control panel** — stays on top of games reliably (`SetWindowPos(HWND_TOPMOST)` after show + a 2 s re-assert in the stats heartbeat, which fixes WebView2 silently dropping the topmost style), is **draggable**anywhere on its surface, and its position **persists across launches** (`settings.hudPosition`, saved throttled on move and exactly on hide).
- **⎙ SAVE from the overlay** — save the instant replay without alt-tabbing: behaves like the hotkey (the deck is never raised, no trimmer opens) with `SAVING… / ✓ SAVED / ✕ FAILED` feedback, dimmed with an explanatory tooltip while the buffer is disarmed or privacy mode is active.
- **▶ ARM / ■ STOP from the overlay** — arm with the persisted capture settings or stop the buffer, no need to open the deck. The HUD now stays up whenever enabled (STANDBY state when disarmed) so it doubles as a control panel; tooltips show your real rebound hotkeys.
- **ℹ Richer pill** — live `buffered/total` seconds, `resolution@fps` and the configured `bitrate` (`· 12Mb/s`, new `bitrate_kbps` in engine stats), plus a PRIV chip while privacy mode is paused.
- **GIF quality overhaul** — each frame now gets its own **frame-accurate 256-colour palette** (per-frame NeuQuant local colour table) instead of one global average, so GIFs keep their colours and the dithering noise mostly disappears. The global palette pool/sample was bumped for the header.

### Removed

- **ECO simulation** — the SIMULATE battery/RAM buttons and injection are gone; the live battery/RAM telemetry row in Settings stays.

## [1.4.1] - 2026-08-11

### Added

- **Batch library management** — multi-select mode (plain click, Ctrl-click, Shift-click ranges and an ALL button) with a contextual bar: favourite / unfavourite, add / remove tags, copy paths as a file drop and bulk delete. Selections span pages and survive through the virtualised grid.
- **Adaptive capture (ECO)** — when battery is low or free RAM is tight, the rolling buffer shrinks to a preset (30 s) with an fps cap and restores itself as soon as conditions clear, live on the running engine (the persisted setting is never touched). Settings shows a live battery/RAM telemetry row and **SIMULATE BATTERY 15% / SIMULATE LOW RAM**buttons so the whole loop is testable on a desktop.
- **GIF export** — the trimmer exports the selection as an animated GIF (160–720 px, 5–30 fps) straight from the clip via Media Foundation + pure-Rust encoding: no ffmpeg, no temp files, two-pass bounded memory.
- **⚡ Probe cache + lazy thumbnails** — the gallery scan keys on (size, mtime) in a persistent cache (`probe_cache.json` in AppData), so a library of thousands of clips rescans as a stat-call walk instead of opening Media Foundation per file. Orphaned entries are pruned and the cache saves atomically (temp-file + rename). Thumbnails decode lazily per visible card with a capped LRU cache.
- **LOAD MORE pagination + infinite scroll** — the gallery renders clips in pages of 60 with a **LOAD MORE · +N / LOAD ALL**fallback row, and auto-loads the next page as you scroll near the bottom (IntersectionObserver sentinel, 480 px pre-load). The page resets when the filter/sort set changes; batch selection still works across unloaded pages.

### Fixed

- **GIFs looked smeared and banded** — bilinear resampling replaces nearest-neighbour and Floyd-Steinberg dithering (NeuQuant's O(1) lookup on the export path) kills the banding on gradients; the palette is sampled from more frames.
- **GIF toast reported wrong numbers** — the export confirmation now shows the real playback fps (100/delay), duration, frame count and file size.
- **The REC HUD appeared inside clips** — the overlay window is excluded from screen capture via `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`, so gameplay clips never contain it.

### Tests

- Suite grown to **36 Rust + 61 frontend** (97 total): GIF pixel math (bilinear blends, dithering bounds), probe-cache mechanics (miss persists, hit without rewrite, re-probe on change, orphan pruning, atomic save), ClipMetaStore batch methods, windowing math, privacy-gate and ECO hysteresis.

## [1.3.1] - 2026-08-11

### Performance

- **⚡ Virtualised clip gallery** — the grid now only mounts the rows near the scroll viewport (windowed rendering with an overscan buffer), so a library with thousands of clips keeps a viewport-full of cards in the DOM instead of thousands of `<img>`/`<video>` nodes. The windowing math lives in a pure, unit-tested module (`src/hooks/useVirtualGrid.ts`); row height is measured once and re-measured on column changes; an IntersectionObserver re-windows when the grid becomes visible again.
- **Memoised cards + stable handlers** — `GalleryGrid` and `ClipCard` are memoised and receive `useCallback` handlers directly (the old inline lambda wrappers made the memo never hit), so the 2 s stats poll, toasts and tab switches no longer re-render the whole gallery. `deleteClip` reads `activeClip` through a ref to stay referentially stable.
- **Lazy/async thumbnails** — gallery thumbnails decode off the main thread (`decoding="async"`, `loading="lazy"`) and hover handlers are stable `useCallback`s.

### UX

- **Gallery scroll restored** — opening a clip remembers where you were and closing the trimmer puts the scroll exactly back, even after a trim/split refreshed the list. The gallery is scroll-locked while the modal is up (the overlay is its own scroll container, so the trimmer stays reachable on short windows).
- **Gallery view persists across restarts** — query, game filter, favourites-only, audio-only, tag filter, sort key and compact mode are saved to localStorage and restored on launch (`src/lib/galleryState.ts`, sanitised per-field, corrupt blobs fall back to defaults). A persisted filter pointing at a game/tag that no longer exists falls back gracefully instead of showing an empty library.

### CI

- **CI gates every PR and release** — new `ci.yml` runs `tsc --noEmit`, `vitest` and `vite build` (frontend job) plus `cargo test` (Rust job) on every pull request and push to main, with per-branch concurrency. The release workflow now also runs typecheck + unit tests before publishing — a PR with compile errors can no longer pass (SonarCloud alone was not enough).

### Tests

- Test suite grown from 20 to **43** (8 Rust + 35 frontend): 14 windowing-math tests (`computeVisibleRows`, column/breakpoint and gap helpers) and 9 gallery-state persistence tests (sanitisation, round-trip, corrupt storage).

## [1.3.0] - 2026-08-10

### Added

- **Privacy mode** — with *Privacy mode* on, capture pauses whenever **no game has focus**: the ring buffer is cleared and the engine stops feeding the encoder, so clips can only ever contain gameplay. The gate turns on at startup, when the setting changes, and live via the foreground poll; the deck shows *PRIVACY PAUSED* while active. Saving (hotkey / UI / tray) while paused shows a clear explanation instead of a bare "empty buffer".
- **Game/mic mix balance** — two new sliders (*Game audio %* / *Microphone %*, 0–100) in Settings → Capture Engine, applied per-source in the audio mixer **live, without an engine restart**. The default is byte-identical to the old fixed −3 dB mix.
- **⭐ Favourites + manual tags** — star any clip from its card or the trimmer (gold ★ badge), and add custom tags (`#clutch`, `#fails`…) in the trimmer. New ★ FAVS filter and clickable tag chips in the library. All metadata lives in a private local sidecar (`clip_meta.json` in AppData) — no cloud, no telemetry.

### Fixed

- **Privacy mode could block Alt+C mid-match** — games running elevated or behind anti-cheat deny `OpenProcess` from a non-admin ClipFlow, so the game was "not detected" and privacy stayed paused (empty ring + blocked saves). Foreground detection now resolves the exe through a **process snapshot** (`CreateToolhelp32Snapshot`) that needs no handle to the target, and the gate flipped to an **optimistic default**: pause only when the foreground is positively ClipFlow or the desktop — a failed query keeps recording so Alt+C never breaks.
- **Split at playhead was flaky** — two back-to-back Media Foundation trim sessions raced startup/shutdown and failed in bursts. Splitting now runs as **one native task** (probe duration, two sequential stream-copy trims with a beat between sessions); a failed split cleans up both half-files so no stray `.mp4` lingers.
- **App sluggish with privacy on** — the 2 s foreground poll could flap the gate and wipe the ring buffer repeatedly. The gate now has a **5 s hysteresis window**: a quick alt-tab or detection blip never pauses, clears or spams toasts; turning privacy off un-gates immediately.

### Tests

- First unit-test suite: **8 Rust tests** (`cargo test`) for the split policy (`split_at_seconds`) and collision-free trim naming (`suggested_trim_path`), plus **12 frontend tests** (`npm test`, new vitest setup) for the privacy-gate hysteresis state machine and the optimistic foreground default.

## [1.2.0] - 2026-08-09

### Added

- **Clips tagged with their game** — every save is tagged with the game in the foreground (`cs2`, `eldenring`...). The tag survives restarts because it is derived from the clip's folder, no sidecar files. The gallery gains a per-game **filter dropdown**and each card shows a game badge.
- **Per-game folders** — with *Organize clips by game* on, clips land in `Videos/ClipFlow/<game>/`. The library scan is recursive, so old root clips and new sub-folder clips appear together. Stats and cleanup cover the whole tree.
- **Stats dashboard** — a new **STATS** tab: total clips, storage used, this-week counters, games tagged, plus a per-game breakdown with bytes bars.
- **On-screen REC HUD** — an always-on-top, click-through indicator (● REC · buffered seconds) pinned to the corner of the screen while the buffer is armed. Toggle in Settings → Workflow.
- **✂ Split at playhead** — the trimmer can cut a clip in two at the current frame (two stream-copy trims, no re-encode) with the new **SPLIT AT PLAYHEAD**button.
- **Auto-save on game exit** — when the focused game closes or loses focus (10 s minimum focus, 60 s cooldown), the last 30 s are saved automatically and tagged with the game that just left.

### Fixed

- **Audio capture retries + visible errors** — games holding the audio device in *exclusive mode* made the WASAPI loopback fail with `AUDCLNT_E_DEVICE_IN_USE` and ClipFlow would silently record clips with no audio track. The audio thread now retries every second until the device is free, and the real reason is surfaced on the deck (red *WASAPI loopback* stage in the pipeline + toast on change).
- **Alt+C no longer steals focus from games** — saving with the hotkey used to raise and focus the ClipFlow window, which minimised or paused fullscreen-exclusive games. Now, when a game has focus, the save happens without touching the window and is confirmed with a native Windows toast (toasts don't steal focus). Auto-saves and tray saves never open the trimmer either.

## [1.1.3] - 2026-08-09

### Added

- **Three-tab navigation** — the side rail is now PIPELINE · PROFILES · SETTINGS. The capture profiles moved to their own tab, so Settings no longer scrolls forever.
- **Quick profile switch in the deck** — one-click profile chips (Default / Competitivo / Cine) under the GAME · PROFILE indicator, no Settings needed.
- **Native notification on auto profile switch** — Windows toast when the foreground game changes your capture profile (manual applies stay quiet).
- **Launch at startup** — Settings → Workflow: start ClipFlow hidden to tray at Windows sign-in (registry Run key, kept in sync with the setting).
- **Auto cleanup** — Settings → Workflow: delete clips older than 7/14/30/60 days at every launch to keep the folder tidy.

## [1.1.2] - 2026-08-09

### Added

- **Per-game capture profiles** — make a few generic presets (e.g. *Default*, *Competitivo* with a short buffer, *Cine* with HEVC + long buffer) and map foreground games to them. The buffer window applies live the moment a profile is applied; fps, bitrate and codec apply on the next engine start.
- **Auto-switch by foreground game** — with the toggle on, ClipFlow watches which window has focus and applies the mapped profile automatically (2 s poll, anti-flap cooldown). Unmapped games and the desktop fall back to the *Default* profile. Focus detection is a single cheap Win32 query (`GetForegroundWindow` + process image name), polled off the main thread.
- **Game mapping editor** — Settings → CAPTURE PROFILES: add/rename/delete profiles, and map any executable (e.g. `cs2.exe`) to a profile. The deck shows the current **GAME · PROFILE**chip at a glance.

## [1.1.1] - 2026-08-09

### Added

- **Session counter** in the Instant Replay panel: clips + bytes saved during the current run.
- Release pipeline now ships the **portable exe** on every release (`ClipFlow_vX.Y.Z_Portable.exe`).

### Fixed

- CI release creation permission (`contents: write` at job level) so the pipeline can publish releases automatically.

## [1.1.0] - 2026-08-09

### Added

- **Automatic updates via GitHub Releases** — signed installers (`.sig` + `latest.json`), checked on demand from Settings → About & Updates or silently at launch, with a one-click download & install + restart flow. Still no background updater service.
- **Custom hotkeys** — click the hotkey badge in Settings and press any new combination. Both the *save* (default `Alt+C`) and *arm/disarm* (default `Alt+Shift+C`) shortcuts rebind live and persist across restarts. Combos without a modifier are rejected (Windows reserves bare keys for typing).
- **HEVC (H.265) codec** — new toggle in Settings. Roughly halves file size while keeping hardware encoding (NVENC/AMF/QSV); applies on engine restart.
- **Open in external player** — new `▶` button on gallery cards and in the trimmer to play a clip in your default media player.
- **Rename clips** — inline rename in the trimmer (the header filename becomes editable).
- **PNG snapshots** — `◉ SNAPSHOT PNG` in the trimmer captures the current frame (hardware decode) into the ClipFlow output folder.
- **Gallery sort & filters** — sort by newest/oldest/largest/smallest/longest/shortest, an `♪ AUDIO` filter, and a `▦ COMPACT` grid view.
- **Clear library** — `✕ CLEAR` removes every clip with an explicit confirmation dialog.
- **Save confirmation sound** — the `playSaveSound` setting now actually works: a short locally-generated shutter blip on every flush.
- **Always-on-top** — pin the control deck above full-screen games from Settings.
- **Flush statistics** — the Instant Replay panel tracks last / average / best flush latency for the session.
- **First-run onboarding** — a dismissible overlay teaches the two hotkeys and the output folder on first launch.
- **Check for updates** — manual `RELEASES ↗` button in Settings opens the GitHub Releases page. Still zero background updater, zero telemetry.

### Fixed

- Hotkey validation at startup prevents a corrupt `settings.json` from registering dangerous bare-key shortcuts.
- `Settings` deserialization is now forward-compatible (`#[serde(default)]` on new fields), so existing `settings.json` files survive the upgrade.

## [1.0.0] - 2026-07-20

### Added

- Sub-50 ms instant replay flush (`Alt+C`) from a GPU-encoded rolling ring buffer.
- DXGI Desktop Duplication + Direct3D 11 capture with hardware H.264 MFT encoding (NVENC / AMF / QSV).
- WASAPI system audio loopback + microphone mixing, AAC-LC 48 kHz on a unified QPC clock.
- Key-frame stream-copy trimmer (lossless, no re-encode).
- Tray icon with Capture / Show / Folder / Quit menu.
- Gallery with hover-preview, copy-to-clipboard (CF_HDROP), reveal-in-Explorer and delete.
- Single portable binary, no account, no telemetry, no background updater.
