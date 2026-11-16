# Recorder changes (for CHANGELOG.md, Unreleased)

Lines for the next release notes, written by the recorder work. Merge them into
`CHANGELOG.md` under *Unreleased* when the branch lands.

### Added

- **Studio layers are now part of the video itself.** Pictures, text, the clock, the recording timer and your webcam are drawn by the recorder into replays, recordings and window recordings. They are no longer shown on top of your screen, and they work when Lastshot starts in the tray without its window.
- **Live preview in Studio.** Studio shows what is being recorded, with the layers, about eight times a second (marked *LIVE*). It only runs while Studio is open.
- **Window capture method.** When recording one window, *Window capture method* in Studio picks *Automatic* (default), *Crop from screen* (cuts the window out of the full screen, never touches the app, needs it visible) or *Graphics Capture* (works when the window is covered). *Automatic* crops while the window is visible and switches by itself when it is covered or off screen.
- **Full screen: a second way to capture.** If the usual full-screen capture cannot start (some laptops with two graphics chips, some remote sessions), Lastshot switches to Windows Graphics Capture by itself. Home shows which one is in use.
- **Black picture check.** If the full-screen picture stays black (a game or app that blocks capture), Lastshot tries the other capture method by itself, without losing the replay, and Home shows a short notice when the picture stays black.
- **Clips are named after the game.** New clips are called like `Roblox 2026-11-16 20-15-03.mp4`, recordings `Roblox Recording 2026-11-16 20-15-03.mp4`, and screenshots get the app name too. The name is the recorded window's app, or for full screen the app in front when you save (or the game you played a few seconds before, when Lastshot or the desktop is in front). Names come from a list of well-known games (Roblox, Counter-Strike 2, Valorant, Fortnite, Apex Legends and more) or from the app itself. Existing clips keep their names.
- **A folder per game, on by default.** New clips, recordings and screenshots go into a folder named after the game (`Videos\Lastshot\Roblox\`). Turn it off with *Sort clips into a folder per game* in Settings. Clips from the desktop stay in the main folder.
- **Clips works like File Explorer.** The Clips tab opens on your game folders (with how many clips, their size and the newest clip's picture) and the clips that are not in a folder, old *Lastshot_* clips included. Double-click a folder to open it; the path bar, back / forward (Alt+Left / Alt+Right, mouse side buttons) and Backspace move around. *All clips* lists everything newest first and *Recent* the last 7 days. Pick *Grid* (with a picture-size slider) or *Details* (name, game, date, length, size, resolution; click a column to sort). Search this folder or, with *All*, every folder.
- **Organise clips.** Select with click, Ctrl+click, Shift+click, Ctrl+A or by dragging a box. *New folder*, *Rename* (F2), *Move to…*, drag clips onto a folder (hold Ctrl to copy), cut / copy / paste (Ctrl+X / Ctrl+C / Ctrl+V), *Show in File Explorer* and *Copy for Discord*, also from the right-click menu. Nothing is ever overwritten: a name that is taken gets "(2)".
- The library updates by itself when clips are added, removed or renamed in File Explorer.
- **Always on, in the tray.** With *Launch at startup* on, Lastshot now starts with Windows straight into the tray, with the replay buffer armed and no window (the window is only made when you open it, so it uses less memory). If Lastshot crashes, it starts again by itself (after 2 s, 10 s, then 30 s; it stops trying after three crashes in a row), and Windows starts it again after an update restart. A normal Quit is never undone. Starting it a second time never opens a second copy.
- **Scenes in Studio.** Save what you record plus its layers as a scene (*+ Scene*), then switch with one click; double-click to rename. Changes you make go into the scene that is on. Switching between scenes of the same source only swaps the layers, instantly and without losing the replay, also while recording. A scene with another source changes what is recorded (the replay starts again; not while recording).
- **Crop pictures and the webcam** in Studio (left, right, top, bottom).
- **Portable mode.** Put an empty file called `portable` next to `lastshot.exe` and Lastshot keeps its settings and everything else it stores in a `Lastshot data` folder beside it (for example on a USB stick). Clips still go to the folder set in Settings.
- **Sound meters in Studio** for PC sound and the microphone, showing what goes into the recording.
- **Clean up my voice** (Settings › Sound and Studio, off by default): turns down background noise between words, cuts low rumble, evens out loud and quiet speech and never clips. Applies live.

### Changed

- **Deleting clips moves them to the Recycle Bin** (Delete key, the menu, *Delete all* and batch delete), so they can be restored. Automatic cleanup of old clips still frees the space for good.

### Fixed

- **Shortcuts like Alt+C could stop working for good** when one of them was briefly taken by another app at start-up: then none of them were set up and nothing said so. Each shortcut is now set up on its own and retried every 3 seconds, Lastshot checks every 10 seconds (and after sleep, unlocking the PC or an Explorer restart) that they still work and takes them back if not. If one stays taken for 15 seconds, a Windows notification says so, and Settings shows *Not working* with *Try again* next to it.
- The microphone volume slider in Studio set the volume to almost nothing when moved.
- Quitting Lastshot left its tray icon behind until the mouse passed over it.
- Replays and recordings could drop frames or play unevenly at 60 fps when the graphics driver asked for frames in bursts. Every frame now goes to the encoder, and frames are placed on an even 60 fps grid, so players show a steady picture.
