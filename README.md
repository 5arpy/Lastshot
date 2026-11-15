<p align="center">
  <img src="assets/lastshot-icon.svg" width="96" alt="Lastshot icon">
</p>

<h1 align="center">Lastshot</h1>

<p align="center">
  Free instant replay and snipping tool for Windows.<br>
  No account. No uploads. No ads. Small and quiet while you play.
</p>

<p align="center">
  <a href="https://github.com/5arpy/Lastshot/releases/latest"><b>Download for Windows</b></a>
</p>

---

## What it does

**Instant replay.** Lastshot keeps the last few seconds or minutes (up to an hour) of your screen in memory, encoded on your graphics card. Press **Alt+C** and it saves them as an MP4, without leaving your game. Nothing is written to disk until you ask.

**Screen recording.** Press **Alt+R** (or **Start recording** on Home) to record until you stop, with pause and resume. A small control bar with the timer, file size, pause, stop, mark moment, delete, mic mute and screenshot sits at the top of the screen; Windows leaves it out of every capture, so it never shows up in your videos. Choose *while recording*, *always* or *off* in **Settings › Screen recording**.

**Snipping.** Press **Alt+S**, then drag a box, click a window, or press **F** for the whole screen. Mark it up with a box, arrow, pen or blur, and press **Enter**. It is on your clipboard, ready to paste. Switch the bar at the top to **Record** to record just that area or window instead.

**Sharing that fits Discord.** Every clip has a **Shrink & copy** button. It makes a copy small enough for Discord (10 MB by default) and puts it on your clipboard: switch to Discord and press **Ctrl+V**. You can also drag a clip straight out of Lastshot into Discord or a folder. If Discord changes its limit, or you have Nitro, change the number in **Settings › Sharing**. You don't need to wait for an app update.

**A simple editor.** Cut out the boring parts, split the clip into parts and drag them into a new order, save or share any single part, crop to 9:16 for TikTok or Shorts (or 1:1, 4:3), and join several clips into one. Plain trims stay lossless and instant; edits re-encode once at full quality on your GPU. The original clip is never changed.

**Clips you can find again.** Search, sort, star and tag clips, trim them without re-encoding, split them, and grab frames as pictures. Starred clips are never auto-deleted.

**All your videos in one place.** Add other folders (OBS, ShadowPlay, Downloads) in **Settings › Clips & storage** and their videos show up in Clips, ready to edit and share. The Clips page lists every folder with how many clips it holds and how much space they take, plus how full each drive is. Drop any video on the window, or turn on **Open with Lastshot** for Explorer, to open it in the editor.

**Simple by default.** Home, Clips, Settings. Each settings section has its own **Advanced** button for the extra knobs, so you only see them when you want them.

## Download and install

1. Open the [latest release](https://github.com/5arpy/Lastshot/releases/latest).
2. Download `Lastshot_…_x64-setup.exe` and run it. If you'd rather not install anything, download `lastshot_windows_x64.exe`; it runs as is.
3. Windows may say **"Windows protected your PC"** because the installer is not code-signed (signing costs money every year). Click **More info › Run anyway**.

Lastshot checks for updates only if you turn that on in **Settings › App › Advanced**, and even then it only opens the download page. Nothing installs by itself.

**Needs:** Windows 10 or 11 (64-bit) and a GPU with a hardware video encoder (almost any NVIDIA, AMD or Intel GPU from the last ten years).

## Default shortcuts

| Keys | What it does |
| --- | --- |
| Alt+C | Save replay |
| Alt+R | Start / stop screen recording |
| Alt+S | Snip: screenshot, or record an area |
| Alt+Shift+C | Turn instant replay on / off |

Change them in **Settings › Shortcuts**.

## Privacy

Everything stays on your PC: clips in `Videos\Lastshot`, screenshots in `Videos\Lastshot\Screenshots`, settings in `%APPDATA%\Lastshot`. There is no account, no telemetry and no upload feature. The only network request Lastshot can make is the optional update check against GitHub.

**Privacy mode** (Settings › Clips & storage › Advanced) pauses recording while a non-game window is in front, so chats and browser tabs never end up in a replay.

## Coming from ClipFlow?

Lastshot started as a fork of ClipFlow but is a separate app: its own settings (`%APPDATA%\Lastshot`), its own clips folder (`Videos\Lastshot`), nothing shared. To keep your old ClipFlow clips in view, add `Videos\ClipFlow` under **Settings › Clips & storage › Also show clips from**. If both apps run at once, give them different shortcuts.

## Build from source

You need [Node.js 20+](https://nodejs.org/), [Rust](https://rustup.rs/) and the [Tauri prerequisites for Windows](https://v2.tauri.app/start/prerequisites/).

```bash
npm ci
npm run tauri dev      # run with hot reload
npm run tauri build    # build the installer
```

Tests: `npm run typecheck && npm test` and `cargo test --lib` in `src-tauri`.

Tech: Rust and Tauri 2, DXGI desktop duplication, Media Foundation hardware encoders (NVENC / AMF / Quick Sync), WASAPI audio, and a React UI. The installer is a few MB, and memory use while recording is typically 150–250 MB, mostly the replay buffer itself.

## Credits

Lastshot is built on **[ClipFlow](https://github.com/drexjgobgt/ClipFlow-Dev)** by **jaimitus** and **drexjgobgt**, who wrote the capture, encoding and library engine this app runs on. Thank you!

Changes in Lastshot so far: a fix for the audio-encoder memory leak that made ClipFlow grow by about 0.5–0.8 GB per hour, a fix for 60 FPS recordings that came out at 30, the screenshot tool, Discord-sized sharing, drag-out, a soft dark theme, and a simpler layout. See the [changelog](CHANGELOG.md).

## License

MIT, see [LICENSE](LICENSE).
