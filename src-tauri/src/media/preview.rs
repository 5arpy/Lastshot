//! Live preview for Studio: the frame that goes to the encoder, shrunk on
//! the GPU to 640 pixels wide, about 10 times a second, only while Studio
//! asks for it. No second encode; when nobody looks it costs nothing.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use parking_lot::Mutex;

/// A preview picture, RGBA, tightly packed.
#[derive(Clone, Default)]
pub struct PreviewFrame {
    pub width: u32,
    pub height: u32,
    pub seq: u32,
    pub rgba: Vec<u8>,
}

impl PreviewFrame {
    /// 12-byte header (width, height, sequence; little endian) + RGBA.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(12 + self.rgba.len());
        out.extend_from_slice(&self.width.to_le_bytes());
        out.extend_from_slice(&self.height.to_le_bytes());
        out.extend_from_slice(&self.seq.to_le_bytes());
        out.extend_from_slice(&self.rgba);
        out
    }
}

pub struct PreviewShared {
    epoch: Instant,
    /// Milliseconds since `epoch` of the last request.
    asked_ms: AtomicU64,
    frame: Mutex<Option<PreviewFrame>>,
}

impl Default for PreviewShared {
    fn default() -> Self {
        Self { epoch: Instant::now(), asked_ms: AtomicU64::new(0), frame: Mutex::new(None) }
    }
}

impl PreviewShared {
    /// Studio asks for the newest frame (and keeps the preview running).
    pub fn request(&self) -> Option<PreviewFrame> {
        self.asked_ms.store(self.epoch.elapsed().as_millis() as u64 + 1, Ordering::Release);
        self.frame.lock().clone()
    }

    fn since_asked_ms(&self) -> u64 {
        let asked = self.asked_ms.load(Ordering::Acquire);
        if asked == 0 {
            return u64::MAX;
        }
        (self.epoch.elapsed().as_millis() as u64 + 1).saturating_sub(asked)
    }

    /// Keep making preview frames (someone asked in the last 1.5 s).
    pub fn wanted(&self) -> bool {
        self.since_asked_ms() < 1_500
    }

    /// Keep the GPU objects for a little while after the last request.
    pub fn recently_wanted(&self) -> bool {
        self.since_asked_ms() < 30_000
    }

    pub fn publish(&self, f: PreviewFrame) {
        *self.frame.lock() = Some(f);
    }

    pub fn clear(&self) {
        *self.frame.lock() = None;
    }
}

/// Preview size for a frame: at most 640 wide and 640 high, even numbers.
pub fn preview_size(w: u32, h: u32) -> (u32, u32) {
    if w == 0 || h == 0 {
        return (2, 2);
    }
    let s = (640.0 / w as f32).min(640.0 / h as f32).min(1.0);
    let pw = ((w as f32 * s).round() as u32).max(2) & !1;
    let ph = ((h as f32 * s).round() as u32).max(2) & !1;
    (pw, ph)
}

/// BGRA rows (with pitch) to tightly packed RGBA.
pub fn bgra_to_rgba(src: &[u8], w: usize, h: usize, pitch: usize) -> Vec<u8> {
    let mut out = vec![0u8; w * h * 4];
    for y in 0..h {
        let row = &src[y * pitch..y * pitch + w * 4];
        let o = &mut out[y * w * 4..(y + 1) * w * 4];
        for x in 0..w {
            o[x * 4] = row[x * 4 + 2];
            o[x * 4 + 1] = row[x * 4 + 1];
            o[x * 4 + 2] = row[x * 4];
            o[x * 4 + 3] = 255;
        }
    }
    out
}

#[cfg(windows)]
pub use imp::*;

#[cfg(windows)]
mod imp {
    use super::{bgra_to_rgba, preview_size, PreviewFrame, PreviewShared};
    use crate::media::compositor::{Compositor, Crop, Rect, SourceTexture};
    use std::time::{Duration, Instant};
    use windows::core::Interface;
    use windows::Win32::Graphics::Direct3D11::*;
    use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};

    pub struct Previewer {
        device: ID3D11Device,
        context: ID3D11DeviceContext,
        comp: Option<Compositor>,
        /// Two staging copies: one is written while the other is read.
        staging: Vec<ID3D11Texture2D>,
        src: Option<(SourceTexture, usize)>,
        next: usize,
        pending: Option<usize>,
        last: Instant,
        seq: u32,
    }

    impl Previewer {
        pub fn new(device: &ID3D11Device, context: &ID3D11DeviceContext) -> Result<Self, String> {
            Ok(Self {
                device: device.clone(),
                context: context.clone(),
                comp: None,
                staging: Vec::new(),
                src: None,
                next: 0,
                pending: None,
                last: Instant::now() - Duration::from_secs(1),
                seq: 0,
            })
        }

        fn ensure(&mut self, w: u32, h: u32) -> Result<(), String> {
            if self.comp.as_ref().map(|c| c.width == w && c.height == h).unwrap_or(false) {
                return Ok(());
            }
            self.comp = Some(Compositor::new(&self.device, &self.context, w, h)?);
            self.staging.clear();
            self.pending = None;
            for _ in 0..2 {
                let desc = D3D11_TEXTURE2D_DESC {
                    Width: w,
                    Height: h,
                    MipLevels: 1,
                    ArraySize: 1,
                    Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                    SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                    Usage: D3D11_USAGE_STAGING,
                    BindFlags: 0,
                    CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                    MiscFlags: 0,
                };
                let mut t = None;
                unsafe { self.device.CreateTexture2D(&desc, None, Some(&mut t)) }.map_err(|e| e.to_string())?;
                self.staging.push(t.ok_or("staging: none")?);
            }
            Ok(())
        }

        /// Called with every encoded frame; does work at most 10 times a second.
        pub fn capture(&mut self, frame: &ID3D11Texture2D, shared: &PreviewShared) {
            if self.last.elapsed() < Duration::from_millis(100) {
                return;
            }
            self.last = Instant::now();
            // Read the copy made last time (it is done by now).
            if let (Some(i), Some(comp)) = (self.pending.take(), self.comp.as_ref()) {
                let (w, h) = (comp.width, comp.height);
                let mut m = D3D11_MAPPED_SUBRESOURCE::default();
                let flags = D3D11_MAP_FLAG_DO_NOT_WAIT.0 as u32;
                if unsafe { self.context.Map(&self.staging[i], 0, D3D11_MAP_READ, flags, Some(&mut m)) }.is_ok() {
                    let pitch = m.RowPitch as usize;
                    let data = unsafe { std::slice::from_raw_parts(m.pData as *const u8, pitch * h as usize) };
                    let rgba = bgra_to_rgba(data, w as usize, h as usize, pitch);
                    unsafe { self.context.Unmap(&self.staging[i], 0) };
                    self.seq = self.seq.wrapping_add(1);
                    shared.publish(PreviewFrame { width: w, height: h, seq: self.seq, rgba });
                }
            }
            let mut d = D3D11_TEXTURE2D_DESC::default();
            unsafe { frame.GetDesc(&mut d) };
            let (pw, ph) = preview_size(d.Width, d.Height);
            if self.ensure(pw, ph).is_err() {
                return;
            }
            let key = frame.as_raw() as usize;
            if self.src.as_ref().map(|s| s.1) != Some(key) {
                self.src = SourceTexture::wrap(&self.device, frame).ok().map(|s| (s, key));
            }
            let (Some((src, _)), Some(comp)) = (self.src.as_ref(), self.comp.as_ref()) else { return };
            comp.begin([0.0, 0.0, 0.0, 1.0]);
            comp.draw(src, Rect { x: 0.0, y: 0.0, w: pw as f32, h: ph as f32 }, Crop::NONE, 1.0, true);
            comp.end();
            let i = self.next;
            unsafe { self.context.CopyResource(&self.staging[i], comp.canvas()) };
            self.pending = Some(i);
            self.next = (i + 1) % 2;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_size_keeps_shape_and_caps() {
        assert_eq!(preview_size(1920, 1080), (640, 360));
        assert_eq!(preview_size(802, 632), (640, 504));
        assert_eq!(preview_size(320, 200), (320, 200));
        assert_eq!(preview_size(1080, 1920), (360, 640));
        assert_eq!(preview_size(0, 10), (2, 2));
    }

    #[test]
    fn swizzle_and_header() {
        let px = [1u8, 2, 3, 9, 4, 5, 6, 9, 0, 0, 0, 0];
        assert_eq!(bgra_to_rgba(&px, 2, 1, 12), vec![3, 2, 1, 255, 6, 5, 4, 255]);
        let f = PreviewFrame { width: 2, height: 1, seq: 7, rgba: vec![1; 8] };
        let b = f.to_bytes();
        assert_eq!(&b[..12], &[2, 0, 0, 0, 1, 0, 0, 0, 7, 0, 0, 0]);
        assert_eq!(b.len(), 20);
    }

    #[test]
    fn wanted_only_after_a_request() {
        let s = PreviewShared::default();
        assert!(!s.wanted());
        assert!(s.request().is_none());
        assert!(s.wanted() && s.recently_wanted());
    }
}
