//! The game / app name in clip, recording and snip file names, and the
//! per-game folder they go to: `Roblox\Roblox 2026-11-16 20-15-03.mp4`.
//!
//! The app is the recorded window's app, or for full screen the app in the
//! foreground at the moment of the save. When that is Lastshot itself, the
//! desktop or the lock screen, the last real app seen in the last ~10 s is
//! used, otherwise "Desktop". Names come from a process snapshot (no
//! OpenProcess on protected or anti-cheat games); the exe's description is
//! read from its file version info only when its path can be queried without
//! elevation.

use std::time::{Duration, Instant};

use parking_lot::Mutex;

/// Well-known games whose exe or description is not a good name.
const KNOWN: &[(&str, &str)] = &[
    ("robloxplayerbeta", "Roblox"),
    ("robloxstudiobeta", "Roblox Studio"),
    ("cs2", "Counter-Strike 2"),
    ("csgo", "Counter-Strike GO"),
    ("valorant-win64-shipping", "Valorant"),
    ("valorant", "Valorant"),
    ("fortniteclient-win64-shipping", "Fortnite"),
    ("fortniteclient-win64-shipping_be", "Fortnite"),
    ("fortniteclient-win64-shipping_eac", "Fortnite"),
    ("fortniteclient-win64-shipping_eac_eos", "Fortnite"),
    ("r5apex", "Apex Legends"),
    ("r5apex_dx12", "Apex Legends"),
    ("leagueoflegends", "League of Legends"),
    ("league of legends", "League of Legends"),
    ("dota2", "Dota 2"),
    ("overwatch", "Overwatch 2"),
    ("rocketleague", "Rocket League"),
    ("minecraft", "Minecraft"),
    ("javaw", "Minecraft"),
    ("gta5", "GTA V"),
    ("gta5_enhanced", "GTA V"),
    ("rdr2", "Red Dead Redemption 2"),
    ("eldenring", "Elden Ring"),
    ("cod", "Call of Duty"),
    ("modernwarfare", "Call of Duty"),
    ("pubg", "PUBG"),
    ("tslgame", "PUBG"),
    ("rainbowsix", "Rainbow Six Siege"),
    ("rainbowsix_be", "Rainbow Six Siege"),
    ("rustclient", "Rust"),
    ("destiny2", "Destiny 2"),
    ("deadlock", "Deadlock"),
    ("marvel-win64-shipping", "Marvel Rivals"),
    ("cyberpunk2077", "Cyberpunk 2077"),
    ("bf2042", "Battlefield 2042"),
    ("eafc25", "EA Sports FC 25"),
    ("chrome", "Chrome"),
    ("msedge", "Edge"),
    ("firefox", "Firefox"),
    ("discord", "Discord"),
    ("obs64", "OBS"),
];

/// Process names that are never "the app" (our own, the shell, lock screen).
pub fn is_not_an_app(exe: &str) -> bool {
    let e = exe.to_ascii_lowercase();
    let stem = e.trim_end_matches(".exe");
    stem.starts_with("lastshot")
        || matches!(
            stem,
            "explorer" | "lockapp" | "logonui" | "searchhost" | "searchapp" | "startmenuexperiencehost"
                | "shellexperiencehost" | "applicationframehost" | "textinputhost" | "dwm" | "consent"
                | "taskmgr" | "systemsettings" | "shellhost" | ""
        )
}

/// Removes characters Windows does not allow in file names, control
/// characters, trailing dots/spaces and reserved device names.
pub fn sanitize(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || c.is_control() { ' ' } else { c })
        .collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out: String = collapsed.trim_end_matches(['.', ' ']).trim().chars().take(60).collect();
    out = out.trim_end_matches(['.', ' ']).to_string();
    let upper = out.to_ascii_uppercase();
    let reserved = ["CON", "PRN", "AUX", "NUL"].contains(&upper.as_str())
        || ((upper.starts_with("COM") || upper.starts_with("LPT")) && upper.len() == 4 && upper.as_bytes()[3].is_ascii_digit());
    if out.is_empty() || reserved {
        format!("App {out}").trim().to_string()
    } else {
        out
    }
}

/// A readable name from an exe name: the built-in map, else the stem with
/// shipping/launcher suffixes removed, split at camel case and title-cased.
pub fn name_from_exe(exe: &str) -> String {
    let lower = exe.to_ascii_lowercase();
    let stem = lower.trim_end_matches(".exe");
    if let Some((_, n)) = KNOWN.iter().find(|(k, _)| *k == stem) {
        return n.to_string();
    }
    // Keep the original case for camel-case splitting.
    let orig = &exe[..stem.len().min(exe.len())];
    let mut s = orig.to_string();
    loop {
        let l = s.to_ascii_lowercase();
        let cut = ["-win64-shipping", "-wingdk-shipping", "-shipping", "_be", "_eac", "_eos", "-win64", "_x64", "-x64", "x64", "_dx12", "_dx11", "dx12", "client", "launcher", "beta"]
            .iter()
            .find(|suf| l.ends_with(*suf) && l.len() > suf.len() + 1);
        match cut {
            Some(suf) => s.truncate(s.len() - suf.len()),
            None => break,
        }
        s = s.trim_end_matches(['-', '_', ' ', '.']).to_string();
    }
    // "RocketLeague" -> "Rocket League", "my_game-name" -> "My Game Name".
    let mut words: Vec<String> = Vec::new();
    let mut cur = String::new();
    let chars: Vec<char> = s.chars().collect();
    for (i, &c) in chars.iter().enumerate() {
        if c == '_' || c == '-' || c == ' ' || c == '.' {
            if !cur.is_empty() {
                words.push(std::mem::take(&mut cur));
            }
            continue;
        }
        let boundary = i > 0 && c.is_uppercase() && chars[i - 1].is_lowercase();
        if boundary && !cur.is_empty() {
            words.push(std::mem::take(&mut cur));
        }
        cur.push(c);
    }
    if !cur.is_empty() {
        words.push(cur);
    }
    let titled: Vec<String> = words
        .into_iter()
        .map(|w| {
            if w.chars().all(|c| c.is_ascii_digit()) || (w.len() <= 4 && w.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())) {
                w
            } else {
                let mut cs = w.chars();
                match cs.next() {
                    Some(f) => f.to_uppercase().collect::<String>() + &cs.as_str().to_lowercase(),
                    None => w,
                }
            }
        })
        .collect();
    let n = titled.join(" ");
    if n.trim().is_empty() {
        "App".into()
    } else {
        n
    }
}

/// The name to show for an app: the built-in map first, then the file
/// description if it is short and clean, else a name made from the exe.
pub fn display_name(exe: &str, description: Option<&str>) -> String {
    let stem = exe.to_ascii_lowercase();
    let stem = stem.trim_end_matches(".exe");
    if KNOWN.iter().any(|(k, _)| *k == stem) {
        return name_from_exe(exe);
    }
    if let Some(d) = description.map(str::trim) {
        let l = d.to_ascii_lowercase();
        let clean = !d.is_empty()
            && d.chars().count() <= 32
            && d.split_whitespace().count() <= 5
            && !d.contains(['(', ')', '®', '™', '©', '/', '\\', ':'])
            && !["launcher", "client", "shipping", "game", "application", "executable", "bootstrapper", "setup", "unreal"]
                .iter()
                .any(|bad| l == *bad || l.ends_with(&format!(" {bad}")) && l.split_whitespace().count() == 1)
            && !l.starts_with("microsoft")
            && !l.contains(".exe");
        if clean {
            return d.to_string();
        }
    }
    name_from_exe(exe)
}

/// File stem for a new file: `Roblox 2026-11-16 20-15-03` or, with a kind,
/// `Roblox Recording 2026-11-16 20-15-03`.
pub fn file_stem(app: &str, kind: Option<&str>, when: chrono::DateTime<chrono::Local>) -> String {
    let t = when.format("%Y-%m-%d %H-%M-%S");
    match kind {
        Some(k) => format!("{} {k} {t}", sanitize(app)),
        None => format!("{} {t}", sanitize(app)),
    }
}

/// What a clip's file name says about it: the app and the kind ("Recording",
/// "Edit", ...). Handles the new names and the old `Lastshot_*` ones.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedName {
    pub app: Option<String>,
    pub kind: Option<String>,
    /// "YYYY-MM-DD HH-MM-SS"
    pub stamp: Option<String>,
}

pub fn parse_file_name(file_name: &str) -> ParsedName {
    let stem = file_name.rsplit_once('.').map(|(a, _)| a).unwrap_or(file_name);
    // Old names: Lastshot_2026-11-16_20-15-03, Lastshot_Recording_..., ClipFlow_...
    for (prefix, kind) in [("Lastshot_Recording_", Some("Recording")), ("Lastshot_Edit_", Some("Edit")), ("Lastshot_", None), ("ClipFlow_", None)] {
        if let Some(rest) = stem.strip_prefix(prefix) {
            let stamp = rest.get(..19).filter(|t| is_stamp(&t.replacen('_', " ", 1))).map(|t| t.replacen('_', " ", 1));
            return ParsedName { app: None, kind: kind.map(String::from), stamp };
        }
    }
    // New names: "<App> [<Kind> ]YYYY-MM-DD HH-MM-SS[ (n)|_n]".
    let mut base = stem;
    if let Some(i) = base.rfind(['_', '(']) {
        let tail = base[i + 1..].trim_end_matches(')');
        if !tail.is_empty() && tail.chars().all(|c| c.is_ascii_digit()) {
            base = base[..i].trim_end();
        }
    }
    if base.len() >= 20 && base.is_char_boundary(base.len() - 19) {
        let (head, stamp) = base.split_at(base.len() - 19);
        if is_stamp(stamp) && head.ends_with(' ') {
            let head = head.trim_end();
            for k in ["Recording", "Edit", "Screenshot"] {
                if let Some(app) = head.strip_suffix(k) {
                    let app = app.trim_end();
                    return ParsedName { app: (!app.is_empty()).then(|| app.to_string()), kind: Some(k.into()), stamp: Some(stamp.into()) };
                }
            }
            return ParsedName { app: (!head.is_empty()).then(|| head.to_string()), kind: None, stamp: Some(stamp.into()) };
        }
    }
    ParsedName { app: None, kind: None, stamp: None }
}

fn is_stamp(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 19
        && b.iter().enumerate().all(|(i, c)| match i {
            4 | 7 => *c == b'-',
            10 => *c == b' ',
            13 | 16 => *c == b'-',
            _ => c.is_ascii_digit(),
        })
}

// --------------------------------------------------------------- tracking

struct Seen {
    name: String,
    at: Instant,
}

static LAST_REAL: Mutex<Option<Seen>> = Mutex::new(None);
/// Names already worked out, by process id (a process keeps its exe).
static NAMES: Mutex<Vec<(u32, String, String)>> = Mutex::new(Vec::new());

/// Remembers the foreground app once a second, so a save made while
/// Lastshot or the desktop has focus can still name the game played a
/// moment ago. One window-handle query per second; the process snapshot
/// only runs when the foreground process changes.
pub fn start_tracker() {
    let _ = std::thread::Builder::new().name("lastshot-appname".into()).spawn(|| {
        let mut last: Option<(u32, String)> = None;
        loop {
            if let Some(pid) = foreground_pid() {
                let exe = match &last {
                    Some((p, e)) if *p == pid => Some(e.clone()),
                    _ => snapshot_exe(pid),
                };
                if let Some(exe) = exe {
                    if !is_not_an_app(&exe) {
                        let name = app_name_for(pid, &exe);
                        *LAST_REAL.lock() = Some(Seen { name, at: Instant::now() });
                    }
                    last = Some((pid, exe));
                }
            }
            std::thread::sleep(Duration::from_secs(1));
        }
    });
}

/// Name for an app by pid + exe (file description when readable). Cached per
/// process so the version info is read once.
pub fn app_name_for(pid: u32, exe: &str) -> String {
    if let Some((_, _, n)) = NAMES.lock().iter().find(|(p, e, _)| *p == pid && e == exe) {
        return n.clone();
    }
    let desc = description_for_pid(pid);
    let name = display_name(exe, desc.as_deref());
    let mut names = NAMES.lock();
    if names.len() >= 64 {
        names.remove(0);
    }
    names.push((pid, exe.to_string(), name.clone()));
    name
}

/// The app to name a save after when recording full screen.
pub fn foreground_app() -> String {
    if let Some(pid) = foreground_pid() {
        if let Some(exe) = snapshot_exe(pid) {
            if !is_not_an_app(&exe) {
                return app_name_for(pid, &exe);
            }
        }
    }
    match LAST_REAL.lock().as_ref() {
        Some(s) if s.at.elapsed() <= Duration::from_secs(10) => s.name.clone(),
        _ => "Desktop".into(),
    }
}

/// The app that owns a window (window capture), or a name from its exe.
pub fn window_app(hwnd: isize, exe: &str) -> String {
    match window_pid(hwnd) {
        Some(pid) => app_name_for(pid, snapshot_exe(pid).as_deref().unwrap_or(exe)),
        None => display_name(exe, None),
    }
}

#[cfg(windows)]
fn window_pid(hwnd: isize) -> Option<u32> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(HWND(hwnd as *mut _), Some(&mut pid)) };
    (pid != 0).then_some(pid)
}

#[cfg(not(windows))]
fn window_pid(_hwnd: isize) -> Option<u32> {
    None
}

#[cfg(windows)]
pub(crate) fn foreground_pid() -> Option<u32> {
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.is_invalid() {
        return None;
    }
    window_pid(hwnd.0 as isize)
}

#[cfg(not(windows))]
pub(crate) fn foreground_pid() -> Option<u32> {
    None
}

/// Exe file name from a process snapshot (never opens the process).
#[cfg(not(windows))]
pub fn snapshot_exe(_pid: u32) -> Option<String> {
    None
}

/// Exe file name from a process snapshot (never opens the process).
#[cfg(windows)]
pub fn snapshot_exe(pid: u32) -> Option<String> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok()?;
        let mut e = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut out = None;
        if Process32FirstW(snap, &mut e).is_ok() {
            loop {
                if e.th32ProcessID == pid {
                    let len = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len());
                    out = Some(String::from_utf16_lossy(&e.szExeFile[..len]));
                    break;
                }
                if Process32NextW(snap, &mut e).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
        out
    }
}

/// FileDescription from the exe's version info, when its path can be read
/// with a limited query (fails quietly for protected processes).
#[cfg(windows)]
fn description_for_pid(pid: u32) -> Option<String> {
    use windows::core::{HSTRING, PWSTR};
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW};
    use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = vec![0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
        let _ = CloseHandle(h);
        if !ok {
            return None;
        }
        let path = HSTRING::from_wide(&buf[..len as usize]).ok()?;
        let size = GetFileVersionInfoSizeW(&path, None);
        if size == 0 || size > 4 * 1024 * 1024 {
            return None;
        }
        let mut data = vec![0u8; size as usize];
        GetFileVersionInfoW(&path, 0, size, data.as_mut_ptr() as *mut _).ok()?;
        // First language / code page from the translation table.
        let mut p: *mut std::ffi::c_void = std::ptr::null_mut();
        let mut n = 0u32;
        let mut sub = String::from("\\StringFileInfo\\040904b0\\FileDescription");
        if VerQueryValueW(data.as_ptr() as *const _, &HSTRING::from("\\VarFileInfo\\Translation"), &mut p, &mut n).as_bool() && n >= 4 {
            let t = std::slice::from_raw_parts(p as *const u16, 2);
            sub = format!("\\StringFileInfo\\{:04x}{:04x}\\FileDescription", t[0], t[1]);
        }
        if !VerQueryValueW(data.as_ptr() as *const _, &HSTRING::from(sub), &mut p, &mut n).as_bool() || n == 0 {
            return None;
        }
        let s = std::slice::from_raw_parts(p as *const u16, n as usize);
        let end = s.iter().position(|&c| c == 0).unwrap_or(s.len());
        let d = String::from_utf16_lossy(&s[..end]).trim().to_string();
        (!d.is_empty()).then_some(d)
    }
}

#[cfg(not(windows))]
fn description_for_pid(_pid: u32) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_games_and_suffix_cleanup() {
        assert_eq!(name_from_exe("RobloxPlayerBeta.exe"), "Roblox");
        assert_eq!(name_from_exe("cs2.exe"), "Counter-Strike 2");
        assert_eq!(name_from_exe("VALORANT-Win64-Shipping.exe"), "Valorant");
        assert_eq!(name_from_exe("FortniteClient-Win64-Shipping.exe"), "Fortnite");
        assert_eq!(name_from_exe("r5apex.exe"), "Apex Legends");
        assert_eq!(name_from_exe("RocketLeague.exe"), "Rocket League");
        assert_eq!(name_from_exe("MyGame-Win64-Shipping.exe"), "My Game");
        assert_eq!(name_from_exe("SomeGame_BE.exe"), "Some Game");
        assert_eq!(name_from_exe("coolgameClient.exe"), "Coolgame");
        assert_eq!(name_from_exe("game_x64.exe"), "Game");
        assert_eq!(name_from_exe("tradingview.exe"), "Tradingview");
        assert_eq!(name_from_exe("my_cool-app.exe"), "My Cool App");
        assert_eq!(name_from_exe("GTA5.exe"), "GTA V");
        assert_eq!(name_from_exe("ABC2.exe"), "ABC2");
    }

    #[test]
    fn description_used_only_when_clean() {
        assert_eq!(display_name("tv.exe", Some("TradingView")), "TradingView");
        assert_eq!(display_name("RobloxPlayerBeta.exe", Some("Roblox Game Client")), "Roblox");
        assert_eq!(display_name("x.exe", Some("Microsoft® Windows® Operating System")), "X");
        assert_eq!(display_name("thing.exe", Some("A very long description that says far too much")), "Thing");
        assert_eq!(display_name("thing.exe", Some("")), "Thing");
        assert_eq!(display_name("thing.exe", None), "Thing");
    }

    #[test]
    fn sanitizing_for_file_names() {
        assert_eq!(sanitize("Half-Life: Alyx"), "Half-Life Alyx");
        assert_eq!(sanitize("a/b\\c*d?e\"f<g>h|i"), "a b c d e f g h i");
        assert_eq!(sanitize("Name. . "), "Name");
        assert_eq!(sanitize("CON"), "App CON");
        assert_eq!(sanitize("com1"), "App com1");
        assert_eq!(sanitize("   "), "App");
        assert_eq!(sanitize("tab\there"), "tab here");
        assert!(sanitize(&"x".repeat(200)).len() <= 60);
    }

    #[test]
    fn own_and_shell_processes_are_not_apps() {
        assert!(is_not_an_app("lastshot.exe"));
        assert!(is_not_an_app("Lastshot_test_2026-11-16_recorder.exe"));
        assert!(is_not_an_app("explorer.exe"));
        assert!(is_not_an_app("LockApp.exe"));
        assert!(!is_not_an_app("cs2.exe"));
    }

    #[test]
    fn stems_and_parsing_round_trip() {
        use chrono::TimeZone;
        let t = chrono::Local.with_ymd_and_hms(2026, 11, 16, 20, 15, 3).unwrap();
        assert_eq!(file_stem("Roblox", None, t), "Roblox 2026-11-16 20-15-03");
        assert_eq!(file_stem("Roblox", Some("Recording"), t), "Roblox Recording 2026-11-16 20-15-03");
        let p = parse_file_name("Roblox 2026-11-16 20-15-03.mp4");
        assert_eq!((p.app.as_deref(), p.kind.as_deref(), p.stamp.as_deref()), (Some("Roblox"), None, Some("2026-11-16 20-15-03")));
        let p = parse_file_name("Counter-Strike 2 Recording 2026-11-16 20-15-03_2.mp4");
        assert_eq!((p.app.as_deref(), p.kind.as_deref()), (Some("Counter-Strike 2"), Some("Recording")));
        let p = parse_file_name("Lastshot_Recording_2026-11-16_20-15-03.mp4");
        assert_eq!((p.app, p.kind.as_deref(), p.stamp.as_deref()), (None, Some("Recording"), Some("2026-11-16 20-15-03")));
        let p = parse_file_name("Lastshot_2026-01-02_03-04-05_2.mp4");
        assert_eq!(p.stamp.as_deref(), Some("2026-01-02 03-04-05"));
        assert_eq!(parse_file_name("holiday.mp4"), ParsedName { app: None, kind: None, stamp: None });
    }
}
