//! Per-app sound: record only one app (a game), or everything except one
//! app (Discord), with Windows' process loopback (Windows 10 2004+ / 11).

use serde::{Deserialize, Serialize};

/// Whose sound "PC sound" means.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AppAudio {
    /// Everything the PC plays (default).
    #[default]
    All,
    /// Only this app and the processes it started.
    Only { exe: String },
    /// Everything except this app (e.g. a voice chat).
    Except { exe: String },
}

#[cfg(windows)]
pub use imp::*;

#[cfg(windows)]
mod imp {
    use std::sync::mpsc;
    use windows::core::{implement, Interface, IUnknown, HRESULT, PCWSTR};
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::Media::Audio::*;
    use windows::core::PROPVARIANT;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };

    /// Process ids running `exe` (file name, any case), oldest first.
    pub fn pids_of(exe: &str) -> Vec<u32> {
        let want = exe.to_ascii_lowercase();
        let mut out = Vec::new();
        unsafe {
            let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return out };
            let mut e = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
            let mut ok = Process32FirstW(snap, &mut e).is_ok();
            // Parent first: the tree mode then covers the children too.
            let mut all = Vec::new();
            while ok {
                let n = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len());
                let name = String::from_utf16_lossy(&e.szExeFile[..n]).to_ascii_lowercase();
                all.push((e.th32ProcessID, e.th32ParentProcessID, name));
                ok = Process32NextW(snap, &mut e).is_ok();
            }
            let _ = CloseHandle(snap);
            let matching: Vec<_> = all.iter().filter(|p| p.2 == want).collect();
            // Keep only top-most matches (whose parent is not the same app).
            for p in &matching {
                if !matching.iter().any(|q| q.0 == p.1) {
                    out.push(p.0);
                }
            }
        }
        out
    }

    #[implement(IActivateAudioInterfaceCompletionHandler, windows::Win32::System::Com::IAgileObject)]
    struct Done(mpsc::SyncSender<()>);

    // Agile: Windows may call back on any thread.
    impl windows::Win32::System::Com::IAgileObject_Impl for Done_Impl {}

    impl IActivateAudioInterfaceCompletionHandler_Impl for Done_Impl {
        fn ActivateCompleted(&self, _op: Option<&IActivateAudioInterfaceAsyncOperation>) -> windows::core::Result<()> {
            let _ = self.0.send(());
            Ok(())
        }
    }

    /// An audio client capturing one process tree (or all but it), already
    /// initialised for 48 kHz stereo float and started.
    pub unsafe fn open(pid: u32, include: bool) -> windows::core::Result<(IAudioClient, IAudioCaptureClient)> {
        let mut params = AUDIOCLIENT_ACTIVATION_PARAMS {
            ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
            Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
                ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                    TargetProcessId: pid,
                    ProcessLoopbackMode: if include {
                        PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
                    } else {
                        PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE
                    },
                },
            },
        };
        // PROPVARIANT { vt = VT_BLOB, blob = params }.
        // ManuallyDrop: the wrapper would PropVariantClear (free) our blob,
        // which lives on this stack frame.
        let mut pv: std::mem::ManuallyDrop<PROPVARIANT> = std::mem::ManuallyDrop::new(std::mem::zeroed());
        let raw = &mut *pv as *mut PROPVARIANT as *mut u8;
        *(raw as *mut u16) = 65; // VT_BLOB
        *(raw.add(8) as *mut u32) = std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32;
        *(raw.add(16) as *mut *mut u8) = &mut params as *mut _ as *mut u8;

        let (tx, rx) = mpsc::sync_channel(1);
        let handler: IActivateAudioInterfaceCompletionHandler = Done(tx).into();
        let path: Vec<u16> = "VAD\\Process_Loopback\0".encode_utf16().collect();
        let op = ActivateAudioInterfaceAsync(PCWSTR(path.as_ptr()), &IAudioClient::IID, Some(&*pv as *const PROPVARIANT), &handler)?;
        rx.recv_timeout(std::time::Duration::from_secs(5))
            .map_err(|_| windows::core::Error::from(HRESULT(0x8000_000Au32 as i32)))?; // E_PENDING-ish timeout
        let mut hr = HRESULT(0);
        let mut unk: Option<IUnknown> = None;
        op.GetActivateResult(&mut hr, &mut unk)?;
        hr.ok()?;
        let client: IAudioClient = unk.ok_or_else(|| windows::core::Error::from(HRESULT(0x8000_4003u32 as i32)))?.cast()?;

        // Process loopback has no mix format: ask for 48 kHz stereo float.
        let wf = WAVEFORMATEX {
            wFormatTag: 3, // WAVE_FORMAT_IEEE_FLOAT
            nChannels: 2,
            nSamplesPerSec: 48_000,
            nAvgBytesPerSec: 48_000 * 8,
            nBlockAlign: 8,
            wBitsPerSample: 32,
            cbSize: 0,
        };
        client.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
            20_0000,
            0,
            &wf,
            None,
        )?;
        let capture: IAudioCaptureClient = client.GetService()?;
        client.Start()?;
        Ok((client, capture))
    }
}

#[cfg(test)]
mod tests {
    use super::AppAudio;

    #[test]
    fn app_audio_json_shape() {
        let v: AppAudio = serde_json::from_str(r#"{"kind":"except","exe":"Discord.exe"}"#).unwrap();
        assert_eq!(v, AppAudio::Except { exe: "Discord.exe".into() });
        assert_eq!(serde_json::to_string(&AppAudio::All).unwrap(), r#"{"kind":"all"}"#);
    }
}
