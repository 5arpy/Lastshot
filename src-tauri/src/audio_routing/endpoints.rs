//! Windows audio endpoints: listing devices, default devices, endpoint
//! labels, finding a USB audio device's endpoints by its serial, and a
//! defaults guard.
//!
//! **Why the guard:** the first time Windows sees a new USB audio device it
//! makes it the default playback, recording and communications device. The
//! guard snapshots the six defaults (render/capture × console/multimedia/
//! communications) and, while a new device's endpoints appear, puts back any
//! default that moves. Restoring uses `IPolicyConfig::SetDefaultEndpoint`,
//! the same undocumented-but-stable call the Sound control panel and
//! EarTrumpet (MIT) use.

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Endpoint {
    pub id: String,
    pub name: String,
    /// "render" or "capture".
    pub flow: &'static str,
    pub is_default: bool,
}

/// An endpoint of a USB audio device.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsbEndpoint {
    pub id: String,
    pub name: String,
    pub render: bool,
    /// The USB serial of the device it belongs to.
    pub serial: String,
}

/// One default: (flow 0 = render / 1 = capture, role 0..2, endpoint id).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DefaultEntry {
    pub flow: u8,
    pub role: u8,
    pub id: String,
}

/// "USB\VID_1209&PID_0001\LS12AB" → "LS12AB" (that VID:PID only).
pub fn serial_from_instance(instance: &str, vid: u16, pid: u16) -> Option<String> {
    let up = instance.to_ascii_uppercase();
    let want = format!("USB\\VID_{vid:04X}&PID_{pid:04X}\\");
    if !up.starts_with(&want) {
        return None;
    }
    let s = &instance[want.len()..];
    (!s.is_empty() && !s.contains('\\') && !s.contains('&')).then(|| s.to_string())
}

/// "{1}.USB\VID_...&MI_00\3&1487&0&0000" → "USB\VID_...&MI_00\3&1487&0&0000".
pub fn strip_devnode_prefix(v: &str) -> &str {
    match v.find("}.") {
        Some(i) if v.starts_with('{') => &v[i + 2..],
        _ => v,
    }
}

#[cfg(windows)]
pub use imp::*;

#[cfg(not(windows))]
mod imp {
    use super::*;
    pub fn list_endpoints(_render: bool) -> Vec<Endpoint> {
        Vec::new()
    }
    pub fn usb_endpoints(_vid: u16, _pid: u16) -> Vec<UsbEndpoint> {
        Vec::new()
    }
    pub fn snapshot_defaults() -> Vec<DefaultEntry> {
        Vec::new()
    }
    pub fn restore_defaults(_s: &[DefaultEntry]) -> Vec<DefaultEntry> {
        Vec::new()
    }
    pub struct Guard;
    impl Guard {
        pub fn start(_s: Vec<DefaultEntry>) -> Result<Guard, String> {
            Ok(Guard)
        }
        pub fn restores(&self) -> u32 {
            0
        }
    }
    pub fn set_endpoint_label(_id: &str, _label: &str) -> Result<(), String> {
        Err("Windows only".into())
    }
    pub fn set_default_endpoint(_id: &str, _role: u8) -> Result<(), String> {
        Err("Windows only".into())
    }
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;

    use parking_lot::Mutex;
    use windows::core::{implement, Interface, GUID, HRESULT, PCWSTR};
    use windows::Win32::Devices::DeviceAndDriverInstallation::{
        CM_Get_Device_IDW, CM_Get_Parent, CM_Locate_DevNodeW, CM_LOCATE_DEVNODE_PHANTOM, CR_SUCCESS,
    };
    use windows::Win32::Media::Audio::*;
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED, STGM};
    use windows::Win32::UI::Shell::PropertiesSystem::PROPERTYKEY;

    pub const PKEY_DEVICE_FRIENDLY_NAME: PROPERTYKEY =
        PROPERTYKEY { fmtid: GUID::from_u128(0xa45c254e_df1c_4efd_8020_67d146a850e0), pid: 14 };
    /// The endpoint's own label ("Speakers"), the part before the brackets.
    pub const PKEY_DEVICE_DESC: PROPERTYKEY =
        PROPERTYKEY { fmtid: GUID::from_u128(0xa45c254e_df1c_4efd_8020_67d146a850e0), pid: 2 };
    /// The device's name (the part in brackets): the USB product string.
    pub const PKEY_DEVICEINTERFACE_FRIENDLY_NAME: PROPERTYKEY =
        PROPERTYKEY { fmtid: GUID::from_u128(0x026e516e_b814_414b_83cd_856d6fef4822), pid: 2 };
    /// "{1}.<instance id of the audio function's devnode>".
    const PKEY_ENDPOINT_DEVNODE: PROPERTYKEY =
        PROPERTYKEY { fmtid: GUID::from_u128(0xb3f8fa53_0004_438e_9003_51a46e139bfc), pid: 2 };

    const CLSID_POLICY_CONFIG: GUID = GUID::from_u128(0x870af99c_171d_4f9e_af0d_e63df40c2bc9);
    const IID_POLICY_CONFIG: GUID = GUID::from_u128(0xf8679f50_850a_41cf_9c72_430f290290c8);
    const SLOT_SET_PROPERTY: usize = 12;
    const SLOT_SET_DEFAULT: usize = 13;

    fn com() {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
    }

    fn enumerator() -> Result<IMMDeviceEnumerator, String> {
        com();
        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }.map_err(|e| e.to_string())
    }

    unsafe fn prop(dev: &IMMDevice, key: &PROPERTYKEY) -> Option<String> {
        let store = dev.OpenPropertyStore(STGM(0)).ok()?;
        let v = store.GetValue(key).ok()?;
        let s = v.to_string();
        (!s.is_empty()).then_some(s)
    }

    unsafe fn id_of(dev: &IMMDevice) -> Option<String> {
        dev.GetId().ok().and_then(|p| {
            let s = p.to_string().ok();
            windows::Win32::System::Com::CoTaskMemFree(Some(p.0 as *const c_void));
            s
        })
    }

    pub fn list_endpoints(render: bool) -> Vec<Endpoint> {
        let mut out = Vec::new();
        let Ok(en) = enumerator() else { return out };
        let flow = if render { eRender } else { eCapture };
        unsafe {
            let default_id = en.GetDefaultAudioEndpoint(flow, eMultimedia).ok().and_then(|d| id_of(&d));
            let Ok(col) = en.EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE) else { return out };
            for i in 0..col.GetCount().unwrap_or(0) {
                let Ok(dev) = col.Item(i) else { continue };
                let Some(id) = id_of(&dev) else { continue };
                let name = prop(&dev, &PKEY_DEVICE_FRIENDLY_NAME).unwrap_or_else(|| "Unknown device".into());
                let is_default = default_id.as_deref() == Some(id.as_str());
                out.push(Endpoint { id, name, flow: if render { "render" } else { "capture" }, is_default });
            }
        }
        out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        out
    }

    /// The USB device (parent of the audio function) behind an endpoint.
    unsafe fn usb_instance_of(dev: &IMMDevice) -> Option<String> {
        let node = prop(dev, &PKEY_ENDPOINT_DEVNODE)?;
        let inst = strip_devnode_prefix(&node);
        let wide: Vec<u16> = inst.encode_utf16().chain(Some(0)).collect();
        let mut dn = 0u32;
        if CM_Locate_DevNodeW(&mut dn, PCWSTR(wide.as_ptr()), CM_LOCATE_DEVNODE_PHANTOM) != CR_SUCCESS {
            return None;
        }
        let mut parent = 0u32;
        if CM_Get_Parent(&mut parent, dn, 0) != CR_SUCCESS {
            return None;
        }
        let mut buf = [0u16; 400];
        if CM_Get_Device_IDW(parent, &mut buf, 0) != CR_SUCCESS {
            return None;
        }
        let n = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Some(String::from_utf16_lossy(&buf[..n]))
    }

    /// Every active endpoint of the USB audio devices with this VID:PID.
    pub fn usb_endpoints(vid: u16, pid: u16) -> Vec<UsbEndpoint> {
        let tag = format!("VID_{vid:04X}&PID_{pid:04X}");
        let mut out = Vec::new();
        let Ok(en) = enumerator() else { return out };
        unsafe {
            for (flow, render) in [(eRender, true), (eCapture, false)] {
                let Ok(col) = en.EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE) else { continue };
                for i in 0..col.GetCount().unwrap_or(0) {
                    let Ok(dev) = col.Item(i) else { continue };
                    // Cheap filter first: only USB audio endpoints of that VID:PID.
                    let Some(node) = prop(&dev, &PKEY_ENDPOINT_DEVNODE) else { continue };
                    if !node.to_ascii_uppercase().contains(&tag) {
                        continue;
                    }
                    let Some(serial) = usb_instance_of(&dev).and_then(|s| serial_from_instance(&s, vid, pid)) else { continue };
                    let Some(id) = id_of(&dev) else { continue };
                    let name = prop(&dev, &PKEY_DEVICE_FRIENDLY_NAME).unwrap_or_default();
                    out.push(UsbEndpoint { id, name, render, serial });
                }
            }
        }
        out
    }

    pub fn snapshot_defaults() -> Vec<DefaultEntry> {
        let mut out = Vec::new();
        let Ok(en) = enumerator() else { return out };
        unsafe {
            for (f, flow) in [(0u8, eRender), (1u8, eCapture)] {
                for (r, role) in [(0u8, eConsole), (1u8, eMultimedia), (2u8, eCommunications)] {
                    if let Some(id) = en.GetDefaultAudioEndpoint(flow, role).ok().and_then(|d| id_of(&d)) {
                        out.push(DefaultEntry { flow: f, role: r, id });
                    }
                }
            }
        }
        out
    }

    /// IPolicyConfig as a raw COM pointer (not in the SDK headers).
    struct Policy(*mut c_void);
    impl Drop for Policy {
        fn drop(&mut self) {
            unsafe {
                let vt = *(self.0 as *const *const usize);
                let release: unsafe extern "system" fn(*mut c_void) -> u32 = std::mem::transmute(*vt.add(2));
                release(self.0);
            }
        }
    }
    impl Policy {
        fn new() -> Result<Self, String> {
            com();
            unsafe {
                let unk: windows::core::IUnknown =
                    CoCreateInstance(&CLSID_POLICY_CONFIG, None, CLSCTX_ALL).map_err(|e| e.to_string())?;
                let mut raw = std::ptr::null_mut();
                unk.query(&IID_POLICY_CONFIG, &mut raw).ok().map_err(|e| e.to_string())?;
                Ok(Policy(raw))
            }
        }
        unsafe fn slot(&self, i: usize) -> usize {
            *(*(self.0 as *const *const usize)).add(i)
        }
        fn set_default(&self, id: &str, role: u8) -> Result<(), String> {
            type F = unsafe extern "system" fn(*mut c_void, PCWSTR, i32) -> HRESULT;
            let w: Vec<u16> = id.encode_utf16().chain(Some(0)).collect();
            unsafe {
                let f: F = std::mem::transmute(self.slot(SLOT_SET_DEFAULT));
                f(self.0, PCWSTR(w.as_ptr()), role as i32).ok().map_err(|e| e.to_string())
            }
        }
        fn set_string(&self, id: &str, key: &PROPERTYKEY, value: &str) -> Result<(), String> {
            #[repr(C)]
            struct PropVar {
                vt: u16,
                r: [u16; 3],
                p: *const u16,
                p2: usize,
            }
            type F = unsafe extern "system" fn(*mut c_void, PCWSTR, i32, *const PROPERTYKEY, *const PropVar) -> HRESULT;
            let w: Vec<u16> = id.encode_utf16().chain(Some(0)).collect();
            let v: Vec<u16> = value.encode_utf16().chain(Some(0)).collect();
            let pv = PropVar { vt: 31, r: [0; 3], p: v.as_ptr(), p2: 0 }; // VT_LPWSTR
            unsafe {
                let f: F = std::mem::transmute(self.slot(SLOT_SET_PROPERTY));
                f(self.0, PCWSTR(w.as_ptr()), 0, key, &pv).ok().map_err(|e| e.to_string())
            }
        }
    }

    /// Puts back every default that differs from the snapshot. Returns what
    /// it changed.
    pub fn restore_defaults(saved: &[DefaultEntry]) -> Vec<DefaultEntry> {
        let now = snapshot_defaults();
        let Ok(p) = Policy::new() else { return Vec::new() };
        let mut fixed = Vec::new();
        for s in saved {
            let cur = now.iter().find(|n| n.flow == s.flow && n.role == s.role);
            if cur.map(|c| c.id != s.id).unwrap_or(true) && p.set_default(&s.id, s.role).is_ok() {
                fixed.push(s.clone());
            }
        }
        fixed
    }

    /// Changes an endpoint's own label (the "Speakers" part of
    /// "Speakers (Lastshot Game)") the way the Sound control panel does.
    pub fn set_endpoint_label(id: &str, label: &str) -> Result<(), String> {
        Policy::new()?.set_string(id, &PKEY_DEVICE_DESC, label)
    }

    /// Makes `id` the default device for one role (0 console, 1 multimedia,
    /// 2 communications). IPolicyConfig is undocumented: a failure here
    /// usually means Windows changed it, and the error says so.
    pub fn set_default_endpoint(id: &str, role: u8) -> Result<(), String> {
        Policy::new()
            .map_err(|e| format!("Windows' default-device switch is not available ({e})"))?
            .set_default(id, role)
    }

    /// Sets any string property on an endpoint through IPolicyConfig.
    pub fn set_endpoint_string(id: &str, key: &PROPERTYKEY, value: &str) -> Result<(), String> {
        Policy::new()?.set_string(id, key, value)
    }

    /// Reads a string property of an endpoint.
    pub fn endpoint_string(id: &str, key: &PROPERTYKEY) -> Option<String> {
        let en = enumerator().ok()?;
        let w: Vec<u16> = id.encode_utf16().chain(Some(0)).collect();
        unsafe {
            let dev = en.GetDevice(PCWSTR(w.as_ptr())).ok()?;
            prop(&dev, key)
        }
    }

    #[implement(IMMNotificationClient)]
    struct Notifier {
        saved: Arc<Vec<DefaultEntry>>,
        restores: Arc<AtomicU32>,
        busy: Arc<Mutex<()>>,
    }

    impl IMMNotificationClient_Impl for Notifier_Impl {
        fn OnDeviceStateChanged(&self, _id: &PCWSTR, _s: DEVICE_STATE) -> windows::core::Result<()> {
            Ok(())
        }
        fn OnDeviceAdded(&self, _id: &PCWSTR) -> windows::core::Result<()> {
            Ok(())
        }
        fn OnDeviceRemoved(&self, _id: &PCWSTR) -> windows::core::Result<()> {
            Ok(())
        }
        fn OnDefaultDeviceChanged(&self, flow: EDataFlow, role: ERole, id: &PCWSTR) -> windows::core::Result<()> {
            let new_id = unsafe { id.to_string().unwrap_or_default() };
            let (f, r) = (flow.0 as u8, role.0 as u8);
            let Some(want) = self.saved.iter().find(|s| s.flow == f && s.role == r).cloned() else { return Ok(()) };
            if want.id == new_id {
                return Ok(());
            }
            // Never call back into the audio service from its own callback.
            let restores = self.restores.clone();
            let busy = self.busy.clone();
            std::thread::spawn(move || {
                let _g = busy.lock();
                if let Ok(p) = Policy::new() {
                    if p.set_default(&want.id, want.role).is_ok() {
                        restores.fetch_add(1, Ordering::Relaxed);
                        log::info!("[audio] put the default device back (flow {}, role {})", want.flow, want.role);
                    }
                }
            });
            Ok(())
        }
        fn OnPropertyValueChanged(&self, _id: &PCWSTR, _k: &PROPERTYKEY) -> windows::core::Result<()> {
            Ok(())
        }
    }

    /// Holds the defaults where they were while it lives.
    pub struct Guard {
        en: IMMDeviceEnumerator,
        client: IMMNotificationClient,
        restores: Arc<AtomicU32>,
        busy: Arc<Mutex<()>>,
    }

    // The enumerator and client are free-threaded (MTA) COM objects.
    unsafe impl Send for Guard {}
    unsafe impl Sync for Guard {}

    impl Guard {
        pub fn start(saved: Vec<DefaultEntry>) -> Result<Guard, String> {
            let en = enumerator()?;
            let restores = Arc::new(AtomicU32::new(0));
            let busy = Arc::new(Mutex::new(()));
            let client: IMMNotificationClient =
                Notifier { saved: Arc::new(saved), restores: restores.clone(), busy: busy.clone() }.into();
            unsafe { en.RegisterEndpointNotificationCallback(&client) }.map_err(|e| e.to_string())?;
            Ok(Guard { en, client, restores, busy })
        }

        pub fn restores(&self) -> u32 {
            self.restores.load(Ordering::Relaxed)
        }
    }

    impl Drop for Guard {
        fn drop(&mut self) {
            unsafe {
                let _ = self.en.UnregisterEndpointNotificationCallback(&self.client);
            }
            // Let a restore that is in flight finish.
            drop(self.busy.lock());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serials_from_instance_ids() {
        assert_eq!(serial_from_instance(r"USB\VID_1209&PID_0001\LSCABLE0001", 0x1209, 0x0001), Some("LSCABLE0001".into()));
        assert_eq!(serial_from_instance(r"usb\vid_1209&pid_0001\ls9f", 0x1209, 0x0001), Some("ls9f".into()));
        assert_eq!(serial_from_instance(r"USB\VID_1209&PID_0001&MI_00\3&1487&0&0000", 0x1209, 0x0001), None);
        assert_eq!(serial_from_instance(r"USB\VID_046D&PID_0A87\ABC", 0x1209, 0x0001), None);
        assert_eq!(serial_from_instance(r"USB\VID_1209&PID_0001\5&2A&0&3", 0x1209, 0x0001), None);
        assert_eq!(
            strip_devnode_prefix(r"{1}.USB\VID_1209&PID_0001&MI_00\3&148706CA&0&0000"),
            r"USB\VID_1209&PID_0001&MI_00\3&148706CA&0&0000"
        );
        assert_eq!(strip_devnode_prefix("plain"), "plain");
    }
}
