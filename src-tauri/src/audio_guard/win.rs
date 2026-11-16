//! Windows side of the Audio guard: audio sessions (who plays or records
//! where, their volume, mute and level), device and session notifications,
//! device meters and the microphone mute.
//!
//! Notifications only push an [`Event`] into a channel: the guard thread
//! does the work, never the audio service's own callback thread.

use serde::Serialize;

/// One app's audio session on one device.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub pid: u32,
    pub exe: String,
    pub device_id: String,
    pub render: bool,
    pub active: bool,
    pub volume: f32,
    pub mute: bool,
    pub peak: f32,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    /// flow (0 render / 1 capture), role, new default id ("" = none).
    DefaultChanged(u8, u8, String),
    /// A device came, went, or changed state.
    DeviceEvent,
    /// An app opened a new audio session somewhere.
    SessionCreated,
}

#[cfg(windows)]
pub use imp::*;

#[cfg(not(windows))]
mod imp {
    use super::*;
    pub fn sessions(_with_peaks: bool) -> Vec<Session> {
        Vec::new()
    }
    pub fn set_app_volume(_exe: &str, _volume: Option<f32>, _mute: Option<bool>) -> u32 {
        0
    }
    pub fn set_pid_volume(_pid: u32, _volume: Option<f32>, _mute: Option<bool>, _all: bool) -> u32 {
        0
    }
    pub fn device_peaks() -> (f32, f32) {
        (0.0, 0.0)
    }
    pub fn mic_mute(_set: Option<bool>) -> Result<bool, String> {
        Err("Windows only".into())
    }
    pub struct Watcher;
    impl Watcher {
        pub fn start(_tx: std::sync::mpsc::Sender<Event>) -> Result<Watcher, String> {
            Ok(Watcher)
        }
        pub fn rewatch_sessions(&mut self) {}
    }
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::collections::HashMap;
    use std::ffi::c_void;
    use std::sync::mpsc::Sender;

    use parking_lot::Mutex;
    use windows::core::{implement, Interface, GUID, HRESULT, PCWSTR};
    use windows::Win32::Foundation::BOOL;
    use windows::Win32::Media::Audio::Endpoints::{IAudioEndpointVolume, IAudioMeterInformation};
    use windows::Win32::Media::Audio::*;
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};
    use windows::Win32::UI::Shell::PropertiesSystem::PROPERTYKEY;

    /// Marks volume changes Lastshot makes.
    pub const LASTSHOT_CONTEXT: GUID = GUID::from_u128(0x6c617374_7368_6f74_8000_617564696f67);

    fn com() {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
    }

    fn enumerator() -> Option<IMMDeviceEnumerator> {
        com();
        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok() }
    }

    unsafe fn id_of(dev: &IMMDevice) -> Option<String> {
        dev.GetId().ok().and_then(|p| {
            let s = p.to_string().ok();
            windows::Win32::System::Com::CoTaskMemFree(Some(p.0 as *const c_void));
            s
        })
    }

    fn exe_names() -> HashMap<u32, String> {
        crate::audio_routing::app_output::processes().into_iter().collect()
    }

    /// Calls `f` for every app session on every active device.
    fn each_session(mut f: impl FnMut(&str, bool, u32, &IAudioSessionControl2)) {
        let Some(en) = enumerator() else { return };
        unsafe {
            for (flow, render) in [(eRender, true), (eCapture, false)] {
                let Ok(col) = en.EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE) else { continue };
                for i in 0..col.GetCount().unwrap_or(0) {
                    let Ok(dev) = col.Item(i) else { continue };
                    let Some(dev_id) = id_of(&dev) else { continue };
                    let Ok(mgr) = dev.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else { continue };
                    let Ok(list) = mgr.GetSessionEnumerator() else { continue };
                    for j in 0..list.GetCount().unwrap_or(0) {
                        let Ok(s) = list.GetSession(j) else { continue };
                        let Ok(s2) = s.cast::<IAudioSessionControl2>() else { continue };
                        if s2.IsSystemSoundsSession() == HRESULT(0) {
                            continue;
                        }
                        let Ok(pid) = s2.GetProcessId() else { continue };
                        if pid == 0 {
                            continue;
                        }
                        f(&dev_id, render, pid, &s2);
                    }
                }
            }
        }
    }

    /// Every app session (expired ones left out).
    pub fn sessions(with_peaks: bool) -> Vec<Session> {
        let names = exe_names();
        let mut out = Vec::new();
        each_session(|dev, render, pid, s| unsafe {
            let state = s.GetState().unwrap_or(AudioSessionStateExpired);
            if state == AudioSessionStateExpired {
                return;
            }
            let Some(exe) = names.get(&pid) else { return };
            let (volume, mute) = match s.cast::<ISimpleAudioVolume>() {
                Ok(v) => (v.GetMasterVolume().unwrap_or(1.0), v.GetMute().map(|b| b.as_bool()).unwrap_or(false)),
                Err(_) => (1.0, false),
            };
            let peak = if with_peaks {
                s.cast::<IAudioMeterInformation>().ok().and_then(|m| m.GetPeakValue().ok()).unwrap_or(0.0)
            } else {
                0.0
            };
            out.push(Session {
                pid,
                exe: exe.clone(),
                device_id: dev.to_string(),
                render,
                active: state == AudioSessionStateActive,
                volume,
                mute,
                peak,
            });
        });
        out
    }

    fn set_where(pred: impl Fn(u32, bool) -> bool, volume: Option<f32>, mute: Option<bool>) -> u32 {
        let mut n = 0;
        each_session(|_, render, pid, s| unsafe {
            if !pred(pid, render) {
                return;
            }
            let Ok(v) = s.cast::<ISimpleAudioVolume>() else { return };
            let mut ok = true;
            if let Some(x) = volume {
                ok &= v.SetMasterVolume(x.clamp(0.0, 1.0), &LASTSHOT_CONTEXT).is_ok();
            }
            if let Some(m) = mute {
                ok &= v.SetMute(BOOL::from(m), &LASTSHOT_CONTEXT).is_ok();
            }
            if ok {
                n += 1;
            }
        });
        n
    }

    /// Sets volume and/or mute on every playback session of `exe`.
    pub fn set_app_volume(exe: &str, volume: Option<f32>, mute: Option<bool>) -> u32 {
        let names = exe_names();
        set_where(|pid, render| render && names.get(&pid).is_some_and(|e| e.eq_ignore_ascii_case(exe)), volume, mute)
    }

    /// Volume/mute of one process's sessions: playback ones, or also its
    /// recording ones (`all`; muting those silences what it records).
    pub fn set_pid_volume(pid: u32, volume: Option<f32>, mute: Option<bool>, all: bool) -> u32 {
        set_where(|p, render| p == pid && (render || all), volume, mute)
    }

    /// Peak level of the default output and the default microphone.
    pub fn device_peaks() -> (f32, f32) {
        let Some(en) = enumerator() else { return (0.0, 0.0) };
        let peak = |flow| unsafe {
            en.GetDefaultAudioEndpoint(flow, eConsole)
                .ok()
                .and_then(|d| d.Activate::<IAudioMeterInformation>(CLSCTX_ALL, None).ok())
                .and_then(|m| m.GetPeakValue().ok())
                .unwrap_or(0.0)
        };
        (peak(eRender), peak(eCapture))
    }

    /// Reads (None) or sets the default microphone's mute. Returns the state.
    pub fn mic_mute(set: Option<bool>) -> Result<bool, String> {
        let en = enumerator().ok_or("Windows audio is not available")?;
        unsafe {
            let dev = en.GetDefaultAudioEndpoint(eCapture, eConsole).map_err(|_| "There is no microphone".to_string())?;
            let vol = dev.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None).map_err(|e| e.to_string())?;
            if let Some(m) = set {
                vol.SetMute(BOOL::from(m), &LASTSHOT_CONTEXT).map_err(|e| e.to_string())?;
            }
            vol.GetMute().map(|b| b.as_bool()).map_err(|e| e.to_string())
        }
    }

    // -----------------------------------------------------------------------
    // Notifications
    // -----------------------------------------------------------------------

    #[implement(IMMNotificationClient)]
    struct DeviceClient {
        tx: Mutex<Sender<Event>>,
    }

    impl IMMNotificationClient_Impl for DeviceClient_Impl {
        fn OnDeviceStateChanged(&self, _id: &PCWSTR, _s: DEVICE_STATE) -> windows::core::Result<()> {
            let _ = self.tx.lock().send(Event::DeviceEvent);
            Ok(())
        }
        fn OnDeviceAdded(&self, _id: &PCWSTR) -> windows::core::Result<()> {
            let _ = self.tx.lock().send(Event::DeviceEvent);
            Ok(())
        }
        fn OnDeviceRemoved(&self, _id: &PCWSTR) -> windows::core::Result<()> {
            let _ = self.tx.lock().send(Event::DeviceEvent);
            Ok(())
        }
        fn OnDefaultDeviceChanged(&self, flow: EDataFlow, role: ERole, id: &PCWSTR) -> windows::core::Result<()> {
            let id = if id.is_null() { String::new() } else { unsafe { id.to_string().unwrap_or_default() } };
            let _ = self.tx.lock().send(Event::DefaultChanged(flow.0 as u8, role.0 as u8, id));
            Ok(())
        }
        fn OnPropertyValueChanged(&self, _id: &PCWSTR, _k: &PROPERTYKEY) -> windows::core::Result<()> {
            Ok(())
        }
    }

    #[implement(IAudioSessionNotification)]
    struct SessionClient {
        tx: Mutex<Sender<Event>>,
    }

    impl IAudioSessionNotification_Impl for SessionClient_Impl {
        fn OnSessionCreated(&self, _s: Option<&IAudioSessionControl>) -> windows::core::Result<()> {
            let _ = self.tx.lock().send(Event::SessionCreated);
            Ok(())
        }
    }

    /// Device and session notifications, for as long as it lives.
    pub struct Watcher {
        en: IMMDeviceEnumerator,
        client: IMMNotificationClient,
        session_client: IAudioSessionNotification,
        managers: Vec<IAudioSessionManager2>,
    }

    // MTA COM objects; used from the guard thread only.
    unsafe impl Send for Watcher {}

    impl Watcher {
        pub fn start(tx: Sender<Event>) -> Result<Watcher, String> {
            let en = enumerator().ok_or("Windows audio is not available")?;
            let client: IMMNotificationClient = DeviceClient { tx: Mutex::new(tx.clone()) }.into();
            unsafe { en.RegisterEndpointNotificationCallback(&client) }.map_err(|e| e.to_string())?;
            let session_client: IAudioSessionNotification = SessionClient { tx: Mutex::new(tx) }.into();
            let mut w = Watcher { en, client, session_client, managers: Vec::new() };
            w.rewatch_sessions();
            Ok(w)
        }

        /// (Re)subscribes to new sessions on every active device; call after
        /// a device event.
        pub fn rewatch_sessions(&mut self) {
            unsafe {
                for m in self.managers.drain(..) {
                    let _ = m.UnregisterSessionNotification(&self.session_client);
                }
                for flow in [eRender, eCapture] {
                    let Ok(col) = self.en.EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE) else { continue };
                    for i in 0..col.GetCount().unwrap_or(0) {
                        let Ok(dev) = col.Item(i) else { continue };
                        let Ok(mgr) = dev.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else { continue };
                        // Windows only reports new sessions after the list was read once.
                        let _ = mgr.GetSessionEnumerator();
                        if mgr.RegisterSessionNotification(&self.session_client).is_ok() {
                            self.managers.push(mgr);
                        }
                    }
                }
            }
        }
    }

    impl Drop for Watcher {
        fn drop(&mut self) {
            unsafe {
                for m in self.managers.drain(..) {
                    let _ = m.UnregisterSessionNotification(&self.session_client);
                }
                let _ = self.en.UnregisterEndpointNotificationCallback(&self.client);
            }
        }
    }
}
