# Changelog lines: cables and devices (for `[Unreleased]`)

### Added
- **Audio → Cables (Lastshot Pro): Lastshot's own virtual audio cables, no Voicemeeter needed.** Up to 8 cables, each shown in Windows as "Name (Lastshot)" twice (Windows may number the part in brackets, e.g. "Name (2- Lastshot)"): an output apps play into and a microphone other apps record (e.g. as Discord's mic). Add, rename and remove them in the Audio tab. Cables attach when Lastshot starts (if turned on) and detach when it quits.
  - Each cable's microphone side can mix its own sound, other cables and real microphones, each with gain and mute. "Listen on" plays a cable on a real output so a game sent into a cable isn't silent for you. Routes that would feed sound back into themselves are refused, with the reason.
  - Meters per cable, updated only while the Audio tab is on screen.
  - Cables also appear in each app's "Send to" list.
  - Buffer setting (5/10/15/20 ms, default 10 ms). Measured on a real PC: 0 glitches in 5 minutes at 10 ms, about 30 ms from an app playing to another app recording.
  - How it works: Lastshot runs a small USB/IP server on 127.0.0.1 that emulates USB audio devices; usbip-win2 (open source, Microsoft-signed drivers) attaches them and Windows' own USB audio driver does the rest. No driver of our own.
  - "Install cable support" downloads the pinned usbip-win2 0.9.8.1 release from GitHub, checks its SHA-256 and its signature, and installs only what cables need, silently and without a restart (one Windows permission prompt). The Audio tab explains how to uninstall it.
  - Windows makes every new USB audio device the default; Lastshot snapshots the defaults before attaching and puts them back within milliseconds.
- **Audio → Devices: Lastshot in place of Windows' sound settings.**
  - Default playback and recording devices (everyday and communications), each with a fallback order ("Arctis, else Speakers").
  - Per app: microphone, volume, mute, solo and a level meter; remembered by .exe name.
  - **Audio guard** (off until turned on): when Windows or another app changes a default or moves an app (its sound, or only its setting in Windows), Lastshot asks ("Restore mine" / "Keep new", as a notification that never takes focus), puts it back at once, or only logs it, globally or per app/device. Strict mode mutes an app while it plays or records on the wrong device. A Lastshot cable never stays a default by Windows' doing.
  - Automatic backups of the whole audio setup before every change (last 100 or 30 days), named setups to switch with one click, a preview of what a restore changes, export/import, and every restore first saves the current setup.
  - History of every change: when, what, from → to, who (Windows, you, Lastshot) and what the guard did, with a filter and "Export log".
  - Auto-duck (lower other apps while the mic is in use), a global mic-mute shortcut, and output/microphone meters.

## Still to do (2026-11-16, work stopped at the usage limit)
- Rebuild the Pro test exe from commit 702c95f (`npx tauri build --no-bundle --features pro-cables`) and re-run the e2e. The exe on D: is from the commit before the open-core seam. Seam: cargo test passes in both modes (93 free / 122 Pro), and the frontend builds with the cable files removed.
- Measure the free exe size (`npx tauri build --no-bundle`, no feature).
- Listen and real-input paths: about 1 short glitch per 1–2 minutes through the WASAPI tap (Listen about 98 ms, input about 51 ms). The plain cable path is clean (30.5 ms).
- "Send to" for apps that open their sound only once (PlaySound/winmm) depends on timing: Windows drops a per-app setting made before the process starts its audio side. The guard fixes the setting, but the sound moves only when the app reopens it.
- Meter polling rate can't be checked in a minimised test window (Chromium throttles timers). The rule that meters stop off-screen and on other tabs is checked.
- Not tested live: default-device Ask toasts, auto-duck, mic mute/hotkey, solo, the install button end to end, sleep/resume, crash re-attach.
- Windows numbers devices with the same name ("Game (2- Lastshot)"). Test runs left about 20 non-present USB\VID_1209&PID_0001 device nodes; removing them needs admin (`pnputil /remove-device <id>`).
- Our own VID/PID (1209:0001 is a test PID), libusbip instead of usbip.exe, multichannel cables.
