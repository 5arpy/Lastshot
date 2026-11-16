//! A small remote for Voicemeeter (VB-Audio), through its free Remote API.
//!
//! `VoicemeeterRemote64.dll` is loaded at run time from the user's own
//! Voicemeeter install (never bundled). All calls go through one worker
//! thread: the API asks for levels to be read from a single thread, and one
//! thread also keeps the login/logout pairing simple.
//!
//! Only a fixed list of parameters can be written (see [`check_param`]):
//! strip and bus gain, mute, label, and a strip's A1-A5 / B1-B3 routing.

use serde::Serialize;

/// Strips and buses of one Voicemeeter edition.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Layout {
    /// 1 = Voicemeeter, 2 = Banana, 3 = Potato (`VBVMR_GetVoicemeeterType`).
    pub kind: i32,
    pub hw_strips: usize,
    pub virt_strips: usize,
    pub a_buses: usize,
    pub b_buses: usize,
}

/// Layout for a `VBVMR_GetVoicemeeterType` value (VoicemeeterRemote.h,
/// "STRIP/BUS INDEX ASSIGNMENT").
pub fn layout_for(kind: i32) -> Option<Layout> {
    let (hw_strips, virt_strips, a_buses, b_buses) = match kind {
        1 => (2, 1, 1, 1),
        2 => (3, 2, 3, 2),
        3 => (5, 3, 5, 3),
        _ => return None,
    };
    Some(Layout { kind, hw_strips, virt_strips, a_buses, b_buses })
}

impl Layout {
    pub fn name(&self) -> &'static str {
        match self.kind {
            1 => "Voicemeeter",
            2 => "Voicemeeter Banana",
            3 => "Voicemeeter Potato",
            _ => "Voicemeeter",
        }
    }

    pub fn strips(&self) -> usize {
        self.hw_strips + self.virt_strips
    }

    pub fn buses(&self) -> usize {
        self.a_buses + self.b_buses
    }

    pub fn is_virtual_strip(&self, i: usize) -> bool {
        i >= self.hw_strips
    }

    pub fn is_virtual_bus(&self, i: usize) -> bool {
        i >= self.a_buses
    }

    /// "A1".."A5", then "B1".."B3".
    pub fn bus_name(&self, i: usize) -> String {
        if i < self.a_buses {
            format!("A{}", i + 1)
        } else {
            format!("B{}", i - self.a_buses + 1)
        }
    }

    /// The routing switches of every strip: A1..An, B1..Bn.
    pub fn route_names(&self) -> Vec<String> {
        (0..self.buses()).map(|i| self.bus_name(i)).collect()
    }

    /// What Windows calls the strip's input, in plain words.
    pub fn strip_role(&self, i: usize) -> String {
        if !self.is_virtual_strip(i) {
            return format!("Hardware input {}", i + 1);
        }
        match i - self.hw_strips {
            0 => "Voicemeeter Input".into(),
            1 => "Voicemeeter AUX Input".into(),
            _ => "Voicemeeter VAIO3 Input".into(),
        }
    }

    /// What other apps see a B bus as (a recording device / "microphone").
    pub fn bus_role(&self, i: usize) -> String {
        if self.is_virtual_bus(i) {
            format!("Voicemeeter Out {}", self.bus_name(i))
        } else {
            "Speakers / headset".into()
        }
    }

    /// The left and right `VBVMR_GetLevel` input channels of strip `i`.
    /// Hardware strips have 2 channels, virtual strips 8.
    pub fn strip_level_channels(&self, i: usize) -> [usize; 2] {
        let start = if i < self.hw_strips {
            2 * i
        } else {
            2 * self.hw_strips + 8 * (i - self.hw_strips)
        };
        [start, start + 1]
    }

    /// The left and right output channels of bus `i` (8 per bus).
    pub fn bus_level_channels(&self, i: usize) -> [usize; 2] {
        [8 * i, 8 * i + 1]
    }
}

/// Which edition is installed, from the program files in its folder (newest
/// edition first). Used to start Voicemeeter when it is not running.
pub fn kind_from_files<S: AsRef<str>>(names: &[S]) -> Option<i32> {
    let has = |want: &[&str]| {
        names
            .iter()
            .any(|n| want.iter().any(|w| n.as_ref().eq_ignore_ascii_case(w)))
    };
    if has(&["voicemeeter8x64.exe", "voicemeeter8.exe"]) {
        Some(3)
    } else if has(&["voicemeeterpro_x64.exe", "voicemeeterpro.exe"]) {
        Some(2)
    } else if has(&["voicemeeter_x64.exe", "voicemeeter.exe"]) {
        Some(1)
    } else {
        None
    }
}

/// The install folder from the uninstall entry's `UninstallString`, which is
/// the setup program's path (possibly quoted, possibly with arguments).
pub fn folder_from_uninstall(s: &str) -> Option<std::path::PathBuf> {
    let s = s.trim();
    let exe = if let Some(rest) = s.strip_prefix('"') {
        rest.split('"').next()?
    } else {
        // Unquoted: cut at ".exe" so arguments after it are dropped.
        match s.to_ascii_lowercase().find(".exe") {
            Some(i) => &s[..i + 4],
            None => s,
        }
    };
    let p = std::path::Path::new(exe.trim());
    let dir = p.parent()?;
    if dir.as_os_str().is_empty() {
        None
    } else {
        Some(dir.to_path_buf())
    }
}

/// What kind of value a writable parameter takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParamKind {
    /// dB, -60..+12.
    Gain,
    /// 0 or 1 (mute, routing).
    Switch,
    /// Text (strip/bus name).
    Label,
}

pub const GAIN_MIN: f32 = -60.0;
pub const GAIN_MAX: f32 = 12.0;
pub const LABEL_MAX: usize = 64;

/// Checks a parameter name against the whitelist for this layout and returns
/// its canonical spelling. Allowed: `Strip[i].Gain|Mute|Label|A1..An|B1..Bn`
/// and `Bus[i].Gain|Mute|Label`, with `i` inside the layout.
pub fn check_param(name: &str, layout: &Layout) -> Result<(String, ParamKind), String> {
    let bad = || format!("Not an allowed Voicemeeter setting: {name}");
    let lower = name.trim().to_ascii_lowercase();
    let (is_strip, rest) = if let Some(r) = lower.strip_prefix("strip[") {
        (true, r)
    } else if let Some(r) = lower.strip_prefix("bus[") {
        (false, r)
    } else {
        return Err(bad());
    };
    let close = rest.find(']').ok_or_else(bad)?;
    let idx_str = &rest[..close];
    if idx_str.is_empty() || !idx_str.bytes().all(|b| b.is_ascii_digit()) || idx_str.len() > 2 {
        return Err(bad());
    }
    let idx: usize = idx_str.parse().map_err(|_| bad())?;
    let field = rest[close + 1..].strip_prefix('.').ok_or_else(bad)?;
    let limit = if is_strip { layout.strips() } else { layout.buses() };
    if idx >= limit {
        return Err(bad());
    }
    let head = if is_strip { "Strip" } else { "Bus" };
    let (canon, kind) = match field {
        "gain" => ("Gain".to_string(), ParamKind::Gain),
        "mute" => ("Mute".to_string(), ParamKind::Switch),
        "label" => ("Label".to_string(), ParamKind::Label),
        f if is_strip && f.len() == 2 => {
            let (bank, n) = f.split_at(1);
            let n: usize = n.parse().map_err(|_| bad())?;
            let max = match bank {
                "a" => layout.a_buses,
                "b" => layout.b_buses,
                _ => return Err(bad()),
            };
            if n == 0 || n > max {
                return Err(bad());
            }
            (format!("{}{n}", bank.to_ascii_uppercase()), ParamKind::Switch)
        }
        _ => return Err(bad()),
    };
    Ok((format!("{head}[{idx}].{canon}"), kind))
}

/// A checked value ready for the DLL.
#[derive(Debug, Clone, PartialEq)]
pub enum VmValue {
    Float(f32),
    Text(String),
}

/// Validates and normalises a value from the UI for a parameter kind.
pub fn check_value(kind: ParamKind, v: &serde_json::Value) -> Result<VmValue, String> {
    match kind {
        ParamKind::Gain => {
            let f = v.as_f64().ok_or("The gain must be a number")? as f32;
            if !f.is_finite() {
                return Err("The gain must be a number".into());
            }
            Ok(VmValue::Float(f.clamp(GAIN_MIN, GAIN_MAX)))
        }
        ParamKind::Switch => {
            let on = match v {
                serde_json::Value::Bool(b) => *b,
                serde_json::Value::Number(n) => match n.as_f64() {
                    Some(x) if x == 0.0 => false,
                    Some(x) if x == 1.0 => true,
                    _ => return Err("A switch is on (1) or off (0)".into()),
                },
                _ => return Err("A switch is on (1) or off (0)".into()),
            };
            Ok(VmValue::Float(if on { 1.0 } else { 0.0 }))
        }
        ParamKind::Label => {
            let s = v.as_str().ok_or("A name must be text")?;
            let clean: String = s.chars().filter(|c| !c.is_control()).take(LABEL_MAX).collect();
            Ok(VmValue::Text(clean.trim().to_string()))
        }
    }
}

// ---------------------------------------------------------------------------
// What the UI gets
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VmRoute {
    pub name: String,
    pub on: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VmStrip {
    pub index: usize,
    pub label: String,
    /// "Hardware input 1", "Voicemeeter Input"...
    pub role: String,
    #[serde(rename = "virtual")]
    pub is_virtual: bool,
    pub gain: f32,
    pub mute: bool,
    pub routes: Vec<VmRoute>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VmBus {
    pub index: usize,
    /// "A1", "B2"...
    pub name: String,
    pub label: String,
    pub role: String,
    #[serde(rename = "virtual")]
    pub is_virtual: bool,
    pub gain: f32,
    pub mute: bool,
    /// The output device of a hardware bus, when Voicemeeter reports it.
    pub device: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VmStatus {
    pub installed: bool,
    pub running: bool,
    /// 0 when not running, else 1/2/3.
    pub kind: i32,
    pub edition: String,
    pub error: Option<String>,
    pub strips: Vec<VmStrip>,
    pub buses: Vec<VmBus>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VmLevels {
    pub running: bool,
    /// Something changed in Voicemeeter (fetch the status again).
    pub dirty: bool,
    /// Post-fader peak per strip, linear (1.0 = 0 dB).
    pub strips: Vec<f32>,
    /// Output peak per bus, linear.
    pub buses: Vec<f32>,
}

#[cfg(windows)]
pub use imp::{launch, levels, set, shutdown, status};

#[cfg(not(windows))]
mod fallback {
    use super::*;
    pub fn status() -> VmStatus {
        VmStatus::default()
    }
    pub fn levels() -> VmLevels {
        VmLevels::default()
    }
    pub fn set(_name: &str, _v: &serde_json::Value) -> Result<(), String> {
        Err("Voicemeeter is Windows only".into())
    }
    pub fn launch() -> Result<(), String> {
        Err("Voicemeeter is Windows only".into())
    }
    pub fn shutdown() {}
}
#[cfg(not(windows))]
pub use fallback::{launch, levels, set, shutdown, status};

#[cfg(windows)]
mod imp {
    use super::*;
    use std::path::PathBuf;
    use std::sync::mpsc;
    use std::sync::OnceLock;
    use std::time::{Duration, Instant};

    use parking_lot::Mutex;
    use windows::core::{PCSTR, PCWSTR};
    use windows::Win32::Foundation::HMODULE;
    use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};

    const UNINSTALL_KEY: &str =
        r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\VB:Voicemeeter {17359A74-1236-5467}";
    const DEFAULT_DIR: &str = r"C:\Program Files (x86)\VB\Voicemeeter";
    const DLL_NAME: &str = "VoicemeeterRemote64.dll";

    // VoicemeeterRemote.h: every function is `long __stdcall`, and `long` is
    // 32 bits on Windows. Parameter names are `char*` (ASCII, NUL-ended);
    // wide strings are `unsigned short*` with a 512-character buffer.
    type FnVoid = unsafe extern "system" fn() -> i32;
    type FnLong = unsafe extern "system" fn(i32) -> i32;
    type FnPLong = unsafe extern "system" fn(*mut i32) -> i32;
    type FnGetF = unsafe extern "system" fn(*const u8, *mut f32) -> i32;
    type FnSetF = unsafe extern "system" fn(*const u8, f32) -> i32;
    type FnGetSW = unsafe extern "system" fn(*const u8, *mut u16) -> i32;
    type FnSetSW = unsafe extern "system" fn(*const u8, *const u16) -> i32;
    type FnLevel = unsafe extern "system" fn(i32, i32, *mut f32) -> i32;

    struct Dll {
        _module: HMODULE,
        login: FnVoid,
        logout: FnVoid,
        run: FnLong,
        get_type: FnPLong,
        dirty: FnVoid,
        get_f: FnGetF,
        set_f: FnSetF,
        get_sw: FnGetSW,
        set_sw: FnSetSW,
        level: FnLevel,
    }

    // The function pointers live as long as the DLL, which is never unloaded.
    unsafe impl Send for Dll {}

    #[derive(Default)]
    struct Vm {
        dll: Option<Dll>,
        dir: Option<PathBuf>,
        error: Option<String>,
        next_try: Option<Instant>,
        logged_in: bool,
        last_kind: i32,
    }

    fn reg_string(key: &str, value: &str) -> Option<String> {
        let k: Vec<u16> = key.encode_utf16().chain([0]).collect();
        let v: Vec<u16> = value.encode_utf16().chain([0]).collect();
        let mut buf = vec![0u16; 1024];
        let mut bytes = (buf.len() * 2) as u32;
        let r = unsafe {
            RegGetValueW(
                HKEY_LOCAL_MACHINE,
                PCWSTR(k.as_ptr()),
                PCWSTR(v.as_ptr()),
                RRF_RT_REG_SZ,
                None,
                Some(buf.as_mut_ptr() as *mut _),
                Some(&mut bytes),
            )
        };
        if r.is_err() {
            return None;
        }
        let n = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Some(String::from_utf16_lossy(&buf[..n]))
    }

    /// Voicemeeter's folder: from its uninstall entry, else the default.
    fn install_dir() -> Option<PathBuf> {
        if let Some(dir) = reg_string(UNINSTALL_KEY, "UninstallString").and_then(|s| folder_from_uninstall(&s)) {
            if dir.join(DLL_NAME).is_file() {
                return Some(dir);
            }
        }
        let d = PathBuf::from(DEFAULT_DIR);
        d.join(DLL_NAME).is_file().then_some(d)
    }

    unsafe fn sym<T: Copy>(m: HMODULE, name: &str) -> Result<T, String> {
        let c: Vec<u8> = name.bytes().chain([0]).collect();
        let p = GetProcAddress(m, PCSTR(c.as_ptr())).ok_or_else(|| format!("{DLL_NAME} has no {name}"))?;
        Ok(std::mem::transmute_copy(&p))
    }

    fn cname(name: &str) -> Vec<u8> {
        name.bytes().filter(|&b| b != 0).chain([0]).collect()
    }

    impl Vm {
        /// Loads the DLL and logs in (once). A failed load is retried at
        /// most every 10 s, so a later install is picked up.
        fn ensure(&mut self) -> Result<(), String> {
            if self.dll.is_some() && self.logged_in {
                return Ok(());
            }
            if self.dll.is_none() {
                if let Some(t) = self.next_try {
                    if Instant::now() < t {
                        return Err(self.error.clone().unwrap_or_else(|| "Voicemeeter is not installed".into()));
                    }
                }
                self.next_try = Some(Instant::now() + Duration::from_secs(10));
                let Some(dir) = install_dir() else {
                    self.error = Some("Voicemeeter is not installed".into());
                    return Err(self.error.clone().unwrap());
                };
                let path: Vec<u16> = dir.join(DLL_NAME).as_os_str().encode_wide_nul();
                let dll = unsafe {
                    let m = LoadLibraryW(PCWSTR(path.as_ptr()))
                        .map_err(|e| format!("Could not load {DLL_NAME}: {e}"))?;
                    Dll {
                        _module: m,
                        login: sym(m, "VBVMR_Login")?,
                        logout: sym(m, "VBVMR_Logout")?,
                        run: sym(m, "VBVMR_RunVoicemeeter")?,
                        get_type: sym(m, "VBVMR_GetVoicemeeterType")?,
                        dirty: sym(m, "VBVMR_IsParametersDirty")?,
                        get_f: sym(m, "VBVMR_GetParameterFloat")?,
                        set_f: sym(m, "VBVMR_SetParameterFloat")?,
                        get_sw: sym(m, "VBVMR_GetParameterStringW")?,
                        set_sw: sym(m, "VBVMR_SetParameterStringW")?,
                        level: sym(m, "VBVMR_GetLevel")?,
                    }
                };
                self.dll = Some(dll);
                self.dir = Some(dir);
                self.error = None;
            }
            let dll = self.dll.as_ref().unwrap();
            // 0 = ok, 1 = ok but Voicemeeter is not running (the link comes
            // up by itself once it starts), <0 = error.
            let r = unsafe { (dll.login)() };
            if r < 0 {
                let e = format!("Voicemeeter login failed ({r})");
                self.error = Some(e.clone());
                return Err(e);
            }
            self.logged_in = true;
            // The first parameter read needs a refresh first.
            unsafe { (dll.dirty)() };
            Ok(())
        }

        fn dll(&self) -> &Dll {
            self.dll.as_ref().expect("ensure() first")
        }

        fn kind(&mut self) -> Option<i32> {
            let mut t = 0i32;
            let r = unsafe { (self.dll().get_type)(&mut t) };
            if r == 0 && (1..=3).contains(&t) {
                self.last_kind = t;
                Some(t)
            } else {
                None
            }
        }

        fn get_f(&self, name: &str) -> Option<f32> {
            let n = cname(name);
            let mut v = 0f32;
            let r = unsafe { (self.dll().get_f)(n.as_ptr(), &mut v) };
            (r == 0 && v.is_finite()).then_some(v)
        }

        fn get_s(&self, name: &str) -> Option<String> {
            let n = cname(name);
            let mut buf = [0u16; 512];
            let r = unsafe { (self.dll().get_sw)(n.as_ptr(), buf.as_mut_ptr()) };
            if r != 0 {
                return None;
            }
            let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
            Some(String::from_utf16_lossy(&buf[..len]))
        }

        fn level(&self, kind: i32, ch: usize) -> f32 {
            let mut v = 0f32;
            let r = unsafe { (self.dll().level)(kind, ch as i32, &mut v) };
            if r == 0 && v.is_finite() { v.max(0.0) } else { 0.0 }
        }

        fn logout(&mut self) {
            if self.logged_in {
                if let Some(d) = &self.dll {
                    unsafe { (d.logout)() };
                }
                self.logged_in = false;
            }
        }
    }

    trait WideNul {
        fn encode_wide_nul(&self) -> Vec<u16>;
    }
    impl WideNul for std::ffi::OsStr {
        fn encode_wide_nul(&self) -> Vec<u16> {
            use std::os::windows::ffi::OsStrExt;
            self.encode_wide().chain([0]).collect()
        }
    }

    type Job = Box<dyn FnOnce(&mut Vm) + Send>;
    static WORKER: OnceLock<Mutex<mpsc::Sender<Job>>> = OnceLock::new();

    /// Runs `f` on the Voicemeeter thread and waits for its answer.
    fn call<R: Send + 'static>(f: impl FnOnce(&mut Vm) -> R + Send + 'static) -> Result<R, String> {
        let tx = WORKER.get_or_init(|| {
            let (tx, rx) = mpsc::channel::<Job>();
            let _ = std::thread::Builder::new().name("voicemeeter".into()).spawn(move || {
                let mut vm = Vm::default();
                for job in rx {
                    job(&mut vm);
                }
                vm.logout();
            });
            Mutex::new(tx)
        });
        let (rtx, rrx) = mpsc::sync_channel(1);
        tx.lock()
            .send(Box::new(move |vm: &mut Vm| {
                let _ = rtx.send(f(vm));
            }))
            .map_err(|_| "The Voicemeeter link has stopped".to_string())?;
        rrx.recv_timeout(Duration::from_secs(5))
            .map_err(|_| "Voicemeeter did not answer".to_string())
    }

    fn installed_now() -> bool {
        install_dir().is_some()
    }

    pub fn status() -> VmStatus {
        call(|vm| {
            let mut st = VmStatus::default();
            if let Err(e) = vm.ensure() {
                st.installed = vm.dll.is_some() || installed_now();
                st.error = Some(e);
                return st;
            }
            st.installed = true;
            unsafe { (vm.dll().dirty)() };
            let Some(kind) = vm.kind() else { return st };
            let Some(l) = layout_for(kind) else { return st };
            st.running = true;
            st.kind = kind;
            st.edition = l.name().into();
            let routes = l.route_names();
            for i in 0..l.strips() {
                let p = |f: &str| format!("Strip[{i}].{f}");
                st.strips.push(VmStrip {
                    index: i,
                    label: vm.get_s(&p("Label")).unwrap_or_default(),
                    role: l.strip_role(i),
                    is_virtual: l.is_virtual_strip(i),
                    gain: vm.get_f(&p("Gain")).unwrap_or(0.0),
                    mute: vm.get_f(&p("Mute")).unwrap_or(0.0) >= 0.5,
                    routes: routes
                        .iter()
                        .filter_map(|r| vm.get_f(&p(r)).map(|v| VmRoute { name: r.clone(), on: v >= 0.5 }))
                        .collect(),
                });
            }
            for i in 0..l.buses() {
                let p = |f: &str| format!("Bus[{i}].{f}");
                st.buses.push(VmBus {
                    index: i,
                    name: l.bus_name(i),
                    label: vm.get_s(&p("Label")).unwrap_or_default(),
                    role: l.bus_role(i),
                    is_virtual: l.is_virtual_bus(i),
                    gain: vm.get_f(&p("Gain")).unwrap_or(0.0),
                    mute: vm.get_f(&p("Mute")).unwrap_or(0.0) >= 0.5,
                    device: if l.is_virtual_bus(i) {
                        None
                    } else {
                        vm.get_s(&p("device.name")).filter(|s| !s.trim().is_empty())
                    },
                });
            }
            st
        })
        .unwrap_or_else(|e| VmStatus { error: Some(e), ..Default::default() })
    }

    pub fn levels() -> VmLevels {
        call(|vm| {
            let mut out = VmLevels::default();
            if vm.ensure().is_err() {
                return out;
            }
            let Some(kind) = vm.kind() else { return out };
            let Some(l) = layout_for(kind) else { return out };
            out.running = true;
            out.dirty = unsafe { (vm.dll().dirty)() } == 1;
            // 1 = post-fader input levels, 3 = output levels.
            out.strips = (0..l.strips())
                .map(|i| l.strip_level_channels(i).iter().map(|&c| vm.level(1, c)).fold(0.0, f32::max))
                .collect();
            out.buses = (0..l.buses())
                .map(|i| l.bus_level_channels(i).iter().map(|&c| vm.level(3, c)).fold(0.0, f32::max))
                .collect();
            out
        })
        .unwrap_or_default()
    }

    pub fn set(name: &str, value: &serde_json::Value) -> Result<(), String> {
        let name = name.to_string();
        let value = value.clone();
        call(move |vm| {
            vm.ensure()?;
            let kind = vm.kind().ok_or("Voicemeeter is not running")?;
            let l = layout_for(kind).ok_or("Unknown Voicemeeter edition")?;
            let (canon, pk) = check_param(&name, &l)?;
            let v = check_value(pk, &value)?;
            let n = cname(&canon);
            let r = match &v {
                VmValue::Float(f) => unsafe { (vm.dll().set_f)(n.as_ptr(), *f) },
                VmValue::Text(s) => {
                    let w: Vec<u16> = s.encode_utf16().chain([0]).collect();
                    unsafe { (vm.dll().set_sw)(n.as_ptr(), w.as_ptr()) }
                }
            };
            match r {
                0 => Ok(()),
                -2 => Err("Voicemeeter is not running".into()),
                -3 => Err(format!("This Voicemeeter has no {canon}")),
                e => Err(format!("Voicemeeter refused {canon} ({e})")),
            }
        })?
    }

    pub fn launch() -> Result<(), String> {
        call(|vm| {
            vm.ensure()?;
            let kind = match vm.kind().or((vm.last_kind > 0).then_some(vm.last_kind)) {
                Some(k) => k,
                None => {
                    let names: Vec<String> = vm
                        .dir
                        .as_ref()
                        .and_then(|d| std::fs::read_dir(d).ok())
                        .map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect())
                        .unwrap_or_default();
                    kind_from_files(&names).ok_or("No Voicemeeter program found in its folder")?
                }
            };
            // 4/5/6 = the 64-bit programs; older DLLs only know 1/2/3.
            let mut r = unsafe { (vm.dll().run)(kind + 3) };
            if r == -2 {
                r = unsafe { (vm.dll().run)(kind) };
            }
            match r {
                0 => Ok(()),
                -1 => Err("Voicemeeter is not installed".into()),
                e => Err(format!("Could not start Voicemeeter ({e})")),
            }
        })?
    }

    /// Logs out (app exit). Only if the link was ever used.
    pub fn shutdown() {
        if WORKER.get().is_some() {
            let _ = call(|vm| vm.logout());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layouts_match_the_sdk() {
        let v = layout_for(1).unwrap();
        assert_eq!((v.strips(), v.buses()), (3, 2));
        assert_eq!(v.route_names(), ["A1", "B1"]);
        let b = layout_for(2).unwrap();
        assert_eq!((b.hw_strips, b.virt_strips, b.a_buses, b.b_buses), (3, 2, 3, 2));
        assert_eq!(b.route_names(), ["A1", "A2", "A3", "B1", "B2"]);
        let p = layout_for(3).unwrap();
        assert_eq!((p.strips(), p.buses()), (8, 8));
        assert_eq!(p.route_names(), ["A1", "A2", "A3", "A4", "A5", "B1", "B2", "B3"]);
        assert!(layout_for(0).is_none() && layout_for(4).is_none());
        assert!(p.is_virtual_strip(5) && !p.is_virtual_strip(4));
        assert_eq!(p.strip_role(7), "Voicemeeter VAIO3 Input");
        assert_eq!(p.bus_role(5), "Voicemeeter Out B1");
    }

    #[test]
    fn level_channels_follow_the_header_tables() {
        // Potato: strips 1-5 use 0..9, Virtual Input 10..17, AUX 18..25, VAIO3 26..33.
        let p = layout_for(3).unwrap();
        assert_eq!(p.strip_level_channels(0), [0, 1]);
        assert_eq!(p.strip_level_channels(4), [8, 9]);
        assert_eq!(p.strip_level_channels(5), [10, 11]);
        assert_eq!(p.strip_level_channels(7), [26, 27]);
        // B1 starts at 40.
        assert_eq!(p.bus_level_channels(5), [40, 41]);
        // Banana: Virtual Input AUX 14..21; Voicemeeter: virtual input 4..11.
        assert_eq!(layout_for(2).unwrap().strip_level_channels(4), [14, 15]);
        assert_eq!(layout_for(1).unwrap().strip_level_channels(2), [4, 5]);
        assert_eq!(layout_for(1).unwrap().bus_level_channels(1), [8, 9]);
    }

    #[test]
    fn whitelist_accepts_only_known_params() {
        let p = layout_for(3).unwrap();
        assert_eq!(check_param("strip[0].gain", &p).unwrap(), ("Strip[0].Gain".into(), ParamKind::Gain));
        assert_eq!(check_param("Strip[7].B3", &p).unwrap(), ("Strip[7].B3".into(), ParamKind::Switch));
        assert_eq!(check_param("Strip[2].a5", &p).unwrap().0, "Strip[2].A5");
        assert_eq!(check_param("Bus[7].Mute", &p).unwrap(), ("Bus[7].Mute".into(), ParamKind::Switch));
        assert_eq!(check_param("Bus[0].Label", &p).unwrap().1, ParamKind::Label);
        for bad in [
            "Strip[8].Gain",
            "Bus[8].Gain",
            "Strip[0].A6",
            "Strip[0].B4",
            "Strip[0].A0",
            "Bus[0].A1",
            "Strip[0].Comp",
            "Strip[0].device.wdm",
            "Command.Shutdown",
            "Strip[-1].Gain",
            "Strip[].Gain",
            "Strip[0]Gain",
            "Strip[0].Gain;Command.Restart=1",
            "Strip[0].Gain\0",
            "Strip[001].Gain",
        ] {
            assert!(check_param(bad, &p).is_err(), "{bad} should be refused");
        }
        // Voicemeeter (standard) has no A2 or B2.
        let v = layout_for(1).unwrap();
        assert!(check_param("Strip[0].A2", &v).is_err());
        assert!(check_param("Strip[0].B1", &v).is_ok());
        assert!(check_param("Strip[3].Mute", &v).is_err());
    }

    #[test]
    fn values_are_checked_and_clamped() {
        use serde_json::json;
        assert_eq!(check_value(ParamKind::Gain, &json!(-80)).unwrap(), VmValue::Float(-60.0));
        assert_eq!(check_value(ParamKind::Gain, &json!(3.5)).unwrap(), VmValue::Float(3.5));
        assert!(check_value(ParamKind::Gain, &json!("loud")).is_err());
        assert_eq!(check_value(ParamKind::Switch, &json!(true)).unwrap(), VmValue::Float(1.0));
        assert_eq!(check_value(ParamKind::Switch, &json!(0)).unwrap(), VmValue::Float(0.0));
        assert!(check_value(ParamKind::Switch, &json!(0.5)).is_err());
        assert_eq!(
            check_value(ParamKind::Label, &json!(" Game\n ")).unwrap(),
            VmValue::Text("Game".into())
        );
        let long = "x".repeat(200);
        match check_value(ParamKind::Label, &json!(long)).unwrap() {
            VmValue::Text(s) => assert_eq!(s.len(), LABEL_MAX),
            _ => unreachable!(),
        }
    }

    #[test]
    fn edition_from_files_and_folder_from_uninstall() {
        assert_eq!(kind_from_files(&["voicemeeter.exe", "voicemeeter8x64.exe"]), Some(3));
        assert_eq!(kind_from_files(&["VoicemeeterPro.exe"]), Some(2));
        assert_eq!(kind_from_files(&["voicemeeter_x64.exe"]), Some(1));
        assert_eq!(kind_from_files::<&str>(&[]), None);
        assert_eq!(
            folder_from_uninstall(r"C:\Program Files (x86)\VB\Voicemeeter\Voicemeeter8Setup.exe").unwrap(),
            std::path::PathBuf::from(r"C:\Program Files (x86)\VB\Voicemeeter")
        );
        assert_eq!(
            folder_from_uninstall(r#""D:\Apps\VB\Voicemeeter8Setup.exe" -u"#).unwrap(),
            std::path::PathBuf::from(r"D:\Apps\VB")
        );
        assert_eq!(
            folder_from_uninstall(r"D:\VM\setup.EXE /uninstall").unwrap(),
            std::path::PathBuf::from(r"D:\VM")
        );
        assert!(folder_from_uninstall("setup.exe").is_none());
    }
}
