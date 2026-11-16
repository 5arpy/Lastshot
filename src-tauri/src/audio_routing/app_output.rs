//! Per-app output device ("send Discord to Voicemeeter AUX"), the way
//! Windows' own "App volume and device preferences" page does it.
//!
//! Windows has no public API for this. Like EarTrumpet (MIT), we use the
//! WinRT activation factory `Windows.Media.Internal.AudioPolicyConfig` and its
//! `IAudioPolicyConfigFactory` interface (the 21H2+ variant, IID
//! ab3d4648-e242-459f-b02f-541c70306324). Its methods sit after IInspectable's
//! and 19 others in the vtable: SetPersistedDefaultAudioEndpoint is slot 25,
//! GetPersistedDefaultAudioEndpoint slot 26. Device ids are passed in their
//! full interface form: `\\?\SWD#MMDEVAPI#<id>#{e6327cad-...}` for outputs.

use serde::Serialize;

const MMDEVAPI_TOKEN: &str = r"\\?\SWD#MMDEVAPI#";
const DEVINTERFACE_AUDIO_RENDER: &str = "#{e6327cad-dcec-4949-ae8a-991e976a79d2}";
const DEVINTERFACE_AUDIO_CAPTURE: &str = "#{2eef81be-33fa-4800-9670-1cd474972c3f}";

/// `{0.0.0.00000000}.{guid}` → the form the policy factory takes.
pub fn pack_device_id(id: &str) -> String {
    format!("{MMDEVAPI_TOKEN}{id}{DEVINTERFACE_AUDIO_RENDER}")
}

/// The policy factory's form → the plain endpoint id (as IMMDevice::GetId).
pub fn unpack_device_id(s: &str) -> String {
    let mut s = s.trim();
    if let Some(r) = s.strip_prefix(MMDEVAPI_TOKEN) {
        s = r;
    }
    for suffix in [DEVINTERFACE_AUDIO_RENDER, DEVINTERFACE_AUDIO_CAPTURE] {
        if s.len() >= suffix.len() && s[s.len() - suffix.len()..].eq_ignore_ascii_case(suffix) {
            s = &s[..s.len() - suffix.len()];
        }
    }
    s.to_string()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

/// One app with sound (all its processes that have audio sessions).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioApp {
    pub exe: String,
    pub pids: Vec<u32>,
    /// Its own output device, or None when it follows Windows' default.
    pub output: Option<String>,
    /// Something is playing right now.
    pub active: bool,
}

#[cfg(windows)]
pub use imp::*;

#[cfg(not(windows))]
mod imp {
    use super::*;
    pub fn list_render_devices() -> Vec<RenderDevice> {
        Vec::new()
    }
    pub fn list_audio_apps() -> Vec<AudioApp> {
        Vec::new()
    }
    pub fn get_output(_pid: u32) -> Result<Option<String>, String> {
        Ok(None)
    }
    pub fn set_output(_pid: u32, _id: Option<&str>) -> Result<(), String> {
        Err("Windows only".into())
    }
    pub fn processes() -> Vec<(u32, String)> {
        Vec::new()
    }
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::collections::BTreeMap;
    use std::ffi::c_void;

    use windows::core::{IInspectable, Interface, GUID, HRESULT, HSTRING};
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::Media::Audio::*;
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED, STGM};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::WinRT::RoGetActivationFactory;
    use windows::Win32::UI::Shell::PropertiesSystem::PROPERTYKEY;

    const PKEY_DEVICE_FRIENDLY_NAME: PROPERTYKEY = PROPERTYKEY {
        fmtid: GUID::from_u128(0xa45c254e_df1c_4efd_8020_67d146a850e0),
        pid: 14,
    };
    const IID_POLICY_FACTORY_21H2: GUID = GUID::from_u128(0xab3d4648_e242_459f_b02f_541c70306324);
    const SLOT_SET: usize = 25;
    const SLOT_GET: usize = 26;

    fn com() {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
    }

    /// All processes: pid → exe file name.
    pub fn processes() -> Vec<(u32, String)> {
        let mut out = Vec::new();
        unsafe {
            let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return out };
            let mut e = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
            let mut ok = Process32FirstW(snap, &mut e).is_ok();
            while ok {
                let n = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len());
                out.push((e.th32ProcessID, String::from_utf16_lossy(&e.szExeFile[..n])));
                ok = Process32NextW(snap, &mut e).is_ok();
            }
            let _ = CloseHandle(snap);
        }
        out
    }

    fn enumerator() -> Result<IMMDeviceEnumerator, String> {
        com();
        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }.map_err(|e| e.to_string())
    }

    pub fn list_render_devices() -> Vec<RenderDevice> {
        let mut out = Vec::new();
        let Ok(en) = enumerator() else { return out };
        unsafe {
            let default_id = en
                .GetDefaultAudioEndpoint(eRender, eMultimedia)
                .ok()
                .and_then(|d| d.GetId().ok())
                .and_then(|p| p.to_string().ok());
            let Ok(col) = en.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE) else { return out };
            for i in 0..col.GetCount().unwrap_or(0) {
                let Ok(dev) = col.Item(i) else { continue };
                let Some(id) = dev.GetId().ok().and_then(|p| p.to_string().ok()) else { continue };
                let name = dev
                    .OpenPropertyStore(STGM(0))
                    .ok()
                    .and_then(|s| s.GetValue(&PKEY_DEVICE_FRIENDLY_NAME).ok())
                    .map(|v| v.to_string())
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| "Unknown output".into());
                let is_default = default_id.as_deref() == Some(id.as_str());
                out.push(RenderDevice { id, name, is_default });
            }
        }
        out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        out
    }

    /// pid → "something is playing" for every process with an audio session
    /// on any active output.
    fn session_pids() -> BTreeMap<u32, bool> {
        let mut pids = BTreeMap::new();
        let Ok(en) = enumerator() else { return pids };
        unsafe {
            let Ok(col) = en.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE) else { return pids };
            for i in 0..col.GetCount().unwrap_or(0) {
                let Ok(dev) = col.Item(i) else { continue };
                let Ok(mgr) = dev.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else { continue };
                let Ok(sessions) = mgr.GetSessionEnumerator() else { continue };
                for j in 0..sessions.GetCount().unwrap_or(0) {
                    let Ok(s) = sessions.GetSession(j) else { continue };
                    let Ok(s2) = s.cast::<IAudioSessionControl2>() else { continue };
                    if s2.IsSystemSoundsSession() == HRESULT(0) {
                        continue;
                    }
                    let Ok(pid) = s2.GetProcessId() else { continue };
                    if pid == 0 {
                        continue;
                    }
                    let active = s.GetState().map(|st| st == AudioSessionStateActive).unwrap_or(false);
                    let e = pids.entry(pid).or_insert(false);
                    *e |= active;
                }
            }
        }
        pids
    }

    pub fn list_audio_apps() -> Vec<AudioApp> {
        let sessions = session_pids();
        let names: BTreeMap<u32, String> = processes().into_iter().collect();
        let mut by_exe: BTreeMap<String, AudioApp> = BTreeMap::new();
        for (pid, active) in sessions {
            let Some(exe) = names.get(&pid) else { continue };
            let app = by_exe.entry(exe.to_lowercase()).or_insert_with(|| AudioApp {
                exe: exe.clone(),
                pids: Vec::new(),
                output: None,
                active: false,
            });
            app.pids.push(pid);
            app.active |= active;
            if app.output.is_none() {
                app.output = get_output(pid).ok().flatten();
            }
        }
        by_exe.into_values().collect()
    }

    /// The policy factory, as a raw COM pointer released on drop.
    struct Factory(*mut c_void);

    impl Drop for Factory {
        fn drop(&mut self) {
            unsafe {
                let vt = *(self.0 as *const *const usize);
                let release: unsafe extern "system" fn(*mut c_void) -> u32 = std::mem::transmute(*vt.add(2));
                release(self.0);
            }
        }
    }

    impl Factory {
        fn new() -> Result<Self, String> {
            com();
            unsafe {
                let insp: IInspectable =
                    RoGetActivationFactory(&HSTRING::from("Windows.Media.Internal.AudioPolicyConfig"))
                        .map_err(|e| format!("Per-app output is not available on this Windows ({e})"))?;
                let mut raw = std::ptr::null_mut();
                insp.query(&IID_POLICY_FACTORY_21H2, &mut raw)
                    .ok()
                    .map_err(|e| format!("Per-app output is not available on this Windows ({e})"))?;
                Ok(Self(raw))
            }
        }

        unsafe fn slot(&self, i: usize) -> usize {
            let vt = *(self.0 as *const *const usize);
            *vt.add(i)
        }

        fn set(&self, pid: u32, role: ERole, id: Option<&HSTRING>) -> Result<(), String> {
            type SetFn = unsafe extern "system" fn(*mut c_void, u32, EDataFlow, ERole, *mut c_void) -> HRESULT;
            unsafe {
                let f: SetFn = std::mem::transmute(self.slot(SLOT_SET));
                let raw: *mut c_void = match id {
                    Some(h) => std::mem::transmute_copy(h),
                    None => std::ptr::null_mut(),
                };
                f(self.0, pid, eRender, role, raw).ok().map_err(|e| e.to_string())
            }
        }

        fn get(&self, pid: u32, role: ERole) -> Result<String, String> {
            type GetFn = unsafe extern "system" fn(*mut c_void, u32, EDataFlow, ERole, *mut *mut c_void) -> HRESULT;
            unsafe {
                let f: GetFn = std::mem::transmute(self.slot(SLOT_GET));
                let mut out: *mut c_void = std::ptr::null_mut();
                f(self.0, pid, eRender, role, &mut out).ok().map_err(|e| e.to_string())?;
                // Take ownership so the string is freed.
                let h: HSTRING = std::mem::transmute(out);
                Ok(h.to_string_lossy())
            }
        }
    }

    /// The app's own output (plain endpoint id), or None for "Windows default".
    pub fn get_output(pid: u32) -> Result<Option<String>, String> {
        let f = Factory::new()?;
        let s = f.get(pid, eMultimedia)?;
        let id = unpack_device_id(&s);
        Ok((!id.is_empty()).then_some(id))
    }

    /// Sets (Some) or clears (None) the app's own output device.
    pub fn set_output(pid: u32, id: Option<&str>) -> Result<(), String> {
        let f = Factory::new()?;
        let h = id.map(|i| HSTRING::from(pack_device_id(i)));
        f.set(pid, eMultimedia, h.as_ref())?;
        f.set(pid, eConsole, h.as_ref())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_ids_round_trip() {
        let id = "{0.0.0.00000000}.{5e3c1b7a-1111-2222-3333-444455556666}";
        let packed = pack_device_id(id);
        assert_eq!(
            packed,
            r"\\?\SWD#MMDEVAPI#{0.0.0.00000000}.{5e3c1b7a-1111-2222-3333-444455556666}#{e6327cad-dcec-4949-ae8a-991e976a79d2}"
        );
        assert_eq!(unpack_device_id(&packed), id);
        assert_eq!(unpack_device_id(id), id);
        assert_eq!(unpack_device_id(""), "");
        assert_eq!(
            unpack_device_id(r"\\?\SWD#MMDEVAPI#{0.0.1.00000000}.{x}#{2eef81be-33fa-4800-9670-1cd474972c3f}"),
            "{0.0.1.00000000}.{x}"
        );
    }
}
