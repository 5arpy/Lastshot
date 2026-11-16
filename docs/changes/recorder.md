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

### Fixed

- Replays and recordings could drop frames or play unevenly at 60 fps when the graphics driver asked for frames in bursts. Every frame now goes to the encoder, and frames are placed on an even 60 fps grid, so players show a steady picture.
