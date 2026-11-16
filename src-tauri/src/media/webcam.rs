//! Webcam for the Studio webcam layer, through Media Foundation (no WebView,
//! no permission prompt, works in the tray). A worker thread reads frames as
//! BGRA; the capture thread uploads the newest one. The camera is only open
//! while a visible webcam layer is in use.

use serde::Serialize;

/// A camera the user can pick. `id` is the Media Foundation symbolic link.
#[derive(Debug, Clone, Serialize)]
pub struct CameraInfo {
    pub id: String,
    pub name: String,
}

/// Copies an RGB32 frame (BGRX) with `stride` (negative = bottom-up) into
/// tightly packed, opaque BGRA.
pub fn rgb32_to_bgra(src: &[u8], w: usize, h: usize, stride: isize) -> Option<Vec<u8>> {
    let row = w * 4;
    let abs = stride.unsigned_abs();
    if abs < row || src.len() < abs * (h.max(1) - 1) + row {
        return None;
    }
    let mut out = vec![0u8; row * h];
    for y in 0..h {
        let sy = if stride < 0 { h - 1 - y } else { y };
        let s = &src[sy * abs..sy * abs + row];
        let o = &mut out[y * row..(y + 1) * row];
        o.copy_from_slice(s);
        for p in o.chunks_exact_mut(4) {
            p[3] = 255;
        }
    }
    Some(out)
}

#[cfg(windows)]
pub use imp::*;

#[cfg(not(windows))]
pub fn list_cameras() -> Vec<CameraInfo> {
    Vec::new()
}

#[cfg(windows)]
mod imp {
    use super::{rgb32_to_bgra, CameraInfo};
    use parking_lot::Mutex;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use windows::core::PWSTR;
    use windows::Win32::Media::MediaFoundation::*;
    use windows::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_MULTITHREADED};

    type Frame = (u32, u32, u64, Vec<u8>);

    pub struct Camera {
        device: Option<String>,
        latest: Arc<Mutex<Option<Frame>>>,
        stop: Arc<AtomicBool>,
    }

    impl Camera {
        /// Starts reading the camera (`id` = symbolic link; None or unknown =
        /// the first camera). Never blocks the caller.
        pub fn open(id: Option<String>) -> Self {
            let latest = Arc::new(Mutex::new(None));
            let stop = Arc::new(AtomicBool::new(false));
            let (l2, s2, id2) = (Arc::clone(&latest), Arc::clone(&stop), id.clone());
            let _ = std::thread::Builder::new().name("lastshot-webcam".into()).spawn(move || {
                if let Err(e) = unsafe { read_loop(id2, &l2, &s2) } {
                    log::warn!("[lastshot] webcam: {e}");
                }
            });
            Self { device: id, latest, stop }
        }

        pub fn device(&self) -> Option<&str> {
            self.device.as_deref()
        }

        /// The newest frame if it is newer than `seq`.
        pub fn latest_if_newer(&self, seq: u64) -> Option<Frame> {
            let g = self.latest.lock();
            match g.as_ref() {
                Some(f) if f.2 > seq => Some(f.clone()),
                _ => None,
            }
        }
    }

    impl Drop for Camera {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Release);
        }
    }

    unsafe fn devices() -> windows::core::Result<Vec<(IMFActivate, CameraInfo)>> {
        let mut attrs: Option<IMFAttributes> = None;
        MFCreateAttributes(&mut attrs, 1)?;
        let attrs = attrs.ok_or_else(|| windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?;
        attrs.SetGUID(&MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE, &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID)?;
        let mut arr: *mut Option<IMFActivate> = std::ptr::null_mut();
        let mut n = 0u32;
        MFEnumDeviceSources(&attrs, &mut arr, &mut n)?;
        let mut out = Vec::new();
        if !arr.is_null() {
            for a in std::slice::from_raw_parts(arr, n as usize).iter().flatten() {
                let s = |key: &windows::core::GUID| {
                    let mut p = PWSTR::null();
                    let mut len = 0u32;
                    if a.GetAllocatedString(key, &mut p, &mut len).is_ok() {
                        let v = p.to_string().unwrap_or_default();
                        CoTaskMemFree(Some(p.0 as *const _));
                        v
                    } else {
                        String::new()
                    }
                };
                let info = CameraInfo {
                    id: s(&MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK),
                    name: s(&MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME),
                };
                out.push((a.clone(), info));
            }
            CoTaskMemFree(Some(arr as *const _));
        }
        Ok(out)
    }

    /// The cameras on this PC (names only; nothing is opened).
    pub fn list_cameras() -> Vec<CameraInfo> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let _ = MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET);
            let v = devices().map(|d| d.into_iter().map(|x| x.1).collect()).unwrap_or_default();
            let _ = MFShutdown();
            v
        }
    }

    unsafe fn read_loop(id: Option<String>, latest: &Mutex<Option<Frame>>, stop: &AtomicBool) -> Result<(), String> {
        let e = |x: windows::core::Error| x.message().to_string();
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET).map_err(e)?;
        let result = (|| -> Result<(), String> {
            let list = devices().map_err(e)?;
            let chosen = list
                .iter()
                .find(|(_, i)| Some(&i.id) == id.as_ref())
                .or_else(|| list.first())
                .ok_or("no webcam found")?;
            let source: IMFMediaSource = chosen.0.ActivateObject().map_err(e)?;
            let mut attrs: Option<IMFAttributes> = None;
            MFCreateAttributes(&mut attrs, 2).map_err(e)?;
            let attrs = attrs.ok_or("attributes")?;
            // Lets the reader convert whatever the camera gives to RGB32.
            attrs.SetUINT32(&MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING, 1).map_err(e)?;
            let reader = MFCreateSourceReaderFromMediaSource(&source, &attrs).map_err(e)?;
            let stream = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;

            // Pick the native mode closest to 1280x720 (enough for a corner
            // webcam; less work than 1080p).
            let mut best: Option<(u64, IMFMediaType)> = None;
            let mut i = 0u32;
            while let Ok(t) = reader.GetNativeMediaType(stream, i) {
                i += 1;
                if let Ok(size) = t.GetUINT64(&MF_MT_FRAME_SIZE) {
                    let (w, h) = ((size >> 32) as i64, (size & 0xffff_ffff) as i64);
                    let score = ((w - 1280).abs() + (h - 720).abs()) as u64;
                    if best.as_ref().map(|b| score < b.0).unwrap_or(true) {
                        best = Some((score, t));
                    }
                }
            }
            if let Some((_, t)) = best {
                let _ = reader.SetCurrentMediaType(stream, None, &t);
            }
            let out = MFCreateMediaType().map_err(e)?;
            out.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(e)?;
            out.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_RGB32).map_err(e)?;
            reader.SetCurrentMediaType(stream, None, &out).map_err(e)?;
            let cur = reader.GetCurrentMediaType(stream).map_err(e)?;
            let size = cur.GetUINT64(&MF_MT_FRAME_SIZE).map_err(e)?;
            let (w, h) = ((size >> 32) as u32, (size & 0xffff_ffff) as u32);
            let stride = cur.GetUINT32(&MF_MT_DEFAULT_STRIDE).map(|s| s as i32 as isize).unwrap_or(w as isize * 4);

            let mut seq = 0u64;
            while !stop.load(Ordering::Acquire) {
                let mut flags = 0u32;
                let mut sample: Option<IMFSample> = None;
                reader
                    .ReadSample(stream, 0, None, Some(&mut flags), None, Some(&mut sample))
                    .map_err(e)?;
                if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 || flags & MF_SOURCE_READERF_ERROR.0 as u32 != 0 {
                    break;
                }
                let Some(sample) = sample else { continue };
                let buf = sample.ConvertToContiguousBuffer().map_err(e)?;
                let mut p: *mut u8 = std::ptr::null_mut();
                let mut len = 0u32;
                buf.Lock(&mut p, None, Some(&mut len)).map_err(e)?;
                let px = rgb32_to_bgra(std::slice::from_raw_parts(p, len as usize), w as usize, h as usize, stride);
                let _ = buf.Unlock();
                if let Some(px) = px {
                    seq += 1;
                    *latest.lock() = Some((w, h, seq, px));
                }
            }
            let _ = source.Shutdown();
            Ok(())
        })();
        let _ = MFShutdown();
        CoUninitialize();
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rgb32_rows_are_flipped_for_bottom_up() {
        // 1x2 frame, stride 4: bottom-up means row 0 in memory is the bottom.
        let src = [1, 2, 3, 0, 4, 5, 6, 0];
        assert_eq!(rgb32_to_bgra(&src, 1, 2, 4).unwrap(), vec![1, 2, 3, 255, 4, 5, 6, 255]);
        assert_eq!(rgb32_to_bgra(&src, 1, 2, -4).unwrap(), vec![4, 5, 6, 255, 1, 2, 3, 255]);
        // Padded stride and short buffers.
        let padded = [9, 9, 9, 0, 7, 7, 8, 8, 8, 0, 7, 7];
        assert_eq!(rgb32_to_bgra(&padded, 1, 2, 6).unwrap(), vec![9, 9, 9, 255, 8, 8, 8, 255]);
        assert!(rgb32_to_bgra(&src, 2, 2, 8).is_none());
    }
}
