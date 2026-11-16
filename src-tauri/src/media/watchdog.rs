//! Black-frame watchdog (CAP-017, CAP-018).
//!
//! Once a second the frame about to be encoded is shrunk on the GPU to 32x18
//! and read back (2 KB). If it stays black, the engine checks the same
//! monitor through Graphics Capture: when that one has a picture, desktop
//! duplication is the broken part (hybrid-GPU laptops, some drivers) and the
//! engine switches over in place, without restarting the encoder or losing
//! the replay. When both are black the screen really is black, or it shows
//! protected video, which every recorder gets as black; the deck then says
//! so and the buffer keeps running.

/// BGRA pixels -> share of dark pixels (0.0-1.0).
pub fn dark_fraction(bgra: &[u8], width: usize, height: usize, pitch: usize) -> f32 {
    let mut dark = 0usize;
    let mut total = 0usize;
    for y in 0..height {
        let row = &bgra[y * pitch..];
        for x in 0..width {
            let p = &row[x * 4..x * 4 + 4];
            let luma = 0.0722 * p[0] as f32 + 0.7152 * p[1] as f32 + 0.2126 * p[2] as f32;
            if luma < 16.0 {
                dark += 1;
            }
            total += 1;
        }
    }
    if total == 0 {
        0.0
    } else {
        dark as f32 / total as f32
    }
}

/// A frame counts as black when almost every sample is dark (a mouse pointer
/// on a black screen still counts as black).
pub fn is_black(dark_fraction: f32) -> bool {
    dark_fraction >= 0.985
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WatchAction {
    None,
    /// Check the other capture method once.
    ProbeOther,
    /// Tell the user (stats `notice`).
    Notice,
    ClearNotice,
}

/// Decides what to do from one sample per second.
#[derive(Debug, Default)]
pub struct BlackWatch {
    black_secs: u32,
    secs_since_probe: Option<u32>,
    notice: bool,
}

impl BlackWatch {
    pub const PROBE_AFTER: u32 = 4;
    pub const NOTICE_AFTER: u32 = 10;
    /// At most one probe per this many seconds (a long black video should
    /// not spin up a capture session again and again).
    pub const PROBE_EVERY: u32 = 120;

    pub fn on_sample(&mut self, black: bool) -> WatchAction {
        if let Some(s) = self.secs_since_probe.as_mut() {
            *s += 1;
        }
        if !black {
            self.black_secs = 0;
            if self.notice {
                self.notice = false;
                return WatchAction::ClearNotice;
            }
            return WatchAction::None;
        }
        self.black_secs += 1;
        let may_probe = self.secs_since_probe.map(|s| s >= Self::PROBE_EVERY).unwrap_or(true);
        if self.black_secs >= Self::PROBE_AFTER && may_probe {
            self.secs_since_probe = Some(0);
            return WatchAction::ProbeOther;
        }
        if self.black_secs >= Self::NOTICE_AFTER && !self.notice {
            self.notice = true;
            return WatchAction::Notice;
        }
        WatchAction::None
    }
}

pub const BLACK_NOTICE: &str = "The picture has been black for a while. Protected video (streaming sites, some players) is black in every recorder. The replay keeps running.";

#[cfg(windows)]
pub use imp::*;

#[cfg(windows)]
mod imp {
    use crate::media::compositor::{Compositor, Crop, Rect, SourceTexture};
    use windows::Win32::Graphics::Direct3D11::*;
    use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};

    const W: u32 = 32;
    const H: u32 = 18;

    /// Shrinks a frame to 32x18 and reads it back without stalling the GPU:
    /// the copy made on one call is read on the next.
    pub struct LumaProbe {
        comp: Compositor,
        staging: ID3D11Texture2D,
        src: Option<(SourceTexture, usize)>,
        pending: bool,
    }

    impl LumaProbe {
        pub fn new(device: &ID3D11Device, context: &ID3D11DeviceContext) -> Result<Self, String> {
            let comp = Compositor::new(device, context, W, H)?;
            let desc = D3D11_TEXTURE2D_DESC {
                Width: W,
                Height: H,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                Usage: D3D11_USAGE_STAGING,
                BindFlags: 0,
                CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                MiscFlags: 0,
            };
            let mut staging = None;
            unsafe { device.CreateTexture2D(&desc, None, Some(&mut staging)) }.map_err(|e| e.to_string())?;
            Ok(Self { comp, staging: staging.ok_or("staging: none")?, src: None, pending: false })
        }

        fn draw(&mut self, tex: &ID3D11Texture2D) -> bool {
            use windows::core::Interface;
            let key = tex.as_raw() as usize;
            if self.src.as_ref().map(|s| s.1) != Some(key) {
                self.src = SourceTexture::wrap(self.comp.device(), tex).ok().map(|s| (s, key));
            }
            let Some((src, _)) = self.src.as_ref() else { return false };
            self.comp.begin([0.0, 0.0, 0.0, 1.0]);
            self.comp.draw(src, Rect { x: 0.0, y: 0.0, w: W as f32, h: H as f32 }, Crop::NONE, 1.0, true);
            self.comp.end();
            unsafe { self.comp.context().CopyResource(&self.staging, self.comp.canvas()) };
            true
        }

        fn read(&mut self, wait: bool) -> Option<f32> {
            let ctx = self.comp.context();
            let mut m = D3D11_MAPPED_SUBRESOURCE::default();
            let flags = if wait { 0 } else { D3D11_MAP_FLAG_DO_NOT_WAIT.0 as u32 };
            unsafe { ctx.Map(&self.staging, 0, D3D11_MAP_READ, flags, Some(&mut m)) }.ok()?;
            let pitch = m.RowPitch as usize;
            let data = unsafe { std::slice::from_raw_parts(m.pData as *const u8, pitch * H as usize) };
            let f = super::dark_fraction(data, W as usize, H as usize, pitch);
            unsafe { ctx.Unmap(&self.staging, 0) };
            Some(f)
        }

        /// Call about once a second with the frame being encoded. Returns the
        /// dark share of the frame from the previous call.
        pub fn sample(&mut self, tex: &ID3D11Texture2D) -> Option<f32> {
            let mut out = None;
            if self.pending {
                out = self.read(false);
                if out.is_some() {
                    self.pending = false;
                }
            }
            if !self.pending {
                self.pending = self.draw(tex);
            }
            out
        }

        /// Measures one frame right away (one short GPU wait).
        pub fn measure_now(&mut self, tex: &ID3D11Texture2D) -> Option<f32> {
            self.pending = false;
            if !self.draw(tex) {
                return None;
            }
            self.read(true)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dark_fraction_counts_dark_pixels() {
        // 2x2: black, near-black, white, mid grey; pitch with padding.
        let px = [0, 0, 0, 255, 10, 10, 10, 255, 0, 0, /* pad */ 255, 255, 255, 255, 128, 128, 128, 255, 0, 0];
        assert_eq!(dark_fraction(&px, 2, 2, 10), 0.5);
        assert!(is_black(dark_fraction(&[0u8; 32 * 18 * 4], 32, 18, 128)));
        // A pointer (a few bright samples) on a black screen is still black.
        let mut img = vec![0u8; 32 * 18 * 4];
        for i in 0..4 {
            img[i * 4..i * 4 + 3].copy_from_slice(&[255, 255, 255]);
        }
        assert!(is_black(dark_fraction(&img, 32, 18, 128)));
        // A dark game scene with some detail is not.
        for i in 0..40 {
            img[i * 8..i * 8 + 3].copy_from_slice(&[40, 40, 40]);
        }
        assert!(!is_black(dark_fraction(&img, 32, 18, 128)));
    }

    #[test]
    fn watch_probes_then_notifies_then_clears() {
        let mut w = BlackWatch::default();
        let acts: Vec<_> = (0..12).map(|_| w.on_sample(true)).collect();
        assert_eq!(acts[BlackWatch::PROBE_AFTER as usize - 1], WatchAction::ProbeOther);
        assert_eq!(acts.iter().filter(|a| **a == WatchAction::ProbeOther).count(), 1);
        assert_eq!(acts[BlackWatch::NOTICE_AFTER as usize - 1], WatchAction::Notice);
        assert_eq!(w.on_sample(false), WatchAction::ClearNotice);
        assert_eq!(w.on_sample(false), WatchAction::None);
        // Black again soon after: no second probe within PROBE_EVERY.
        let again: Vec<_> = (0..12).map(|_| w.on_sample(true)).collect();
        assert!(!again.contains(&WatchAction::ProbeOther));
        assert!(again.contains(&WatchAction::Notice));
    }

    #[test]
    fn short_dark_moments_do_nothing() {
        let mut w = BlackWatch::default();
        for _ in 0..3 {
            assert_eq!(w.on_sample(true), WatchAction::None);
        }
        assert_eq!(w.on_sample(false), WatchAction::None);
    }
}
