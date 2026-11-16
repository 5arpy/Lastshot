//! Studio layers drawn by the GPU compositor into the encoded frame:
//! pictures, text, the clock, the recording timer and the webcam.
//!
//! They used to be shown in a transparent window on the user's screen, so the
//! user saw them too and window captures missed them. Now they are drawn onto
//! the frame copy that goes to the encoder (no extra full-frame copy): they
//! appear in replays, recordings and window captures, and never on screen.

use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::Arc;

use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};

/// One layer, as Studio stores it (`src/lib/studio.ts`). Positions and sizes
/// are fractions of the frame.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct LayerSpec {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub visible: bool,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    /// Height / width of the box (pictures, webcam).
    pub aspect: f32,
    pub opacity: f32,
    pub path: Option<String>,
    pub text: Option<String>,
    /// Text height as a fraction of the frame height.
    pub font_size: Option<f32>,
    pub color: Option<String>,
    #[serde(rename = "box")]
    pub box_: Option<bool>,
    pub device_id: Option<String>,
    pub shape: Option<String>,
    pub border: Option<bool>,
    pub mirror: Option<bool>,
    /// Crop of the source picture, fractions per side (S2 transforms).
    pub crop_left: Option<f32>,
    pub crop_top: Option<f32>,
    pub crop_right: Option<f32>,
    pub crop_bottom: Option<f32>,
}

impl LayerSpec {
    pub fn is_picture(&self) -> bool {
        self.kind == "image" || self.kind == "webcam"
    }

    /// Corner radius as a share of the box height.
    pub fn radius(&self) -> f32 {
        match self.shape.as_deref() {
            Some("circle") => 0.5,
            // CSS: 6% of the width.
            Some("rounded") => 0.06 * (1.0 / self.aspect.max(0.01)),
            _ => 0.0,
        }
    }

    pub fn user_crop(&self) -> [f32; 4] {
        let c = |v: Option<f32>| v.unwrap_or(0.0).clamp(0.0, 0.95);
        [c(self.crop_left), c(self.crop_top), c(self.crop_right), c(self.crop_bottom)]
    }
}

/// "#rrggbb" -> (r, g, b); white when it cannot be read.
pub fn parse_color(s: Option<&str>) -> (u8, u8, u8) {
    let s = s.unwrap_or("#ffffff").trim().trim_start_matches('#');
    if s.len() == 6 {
        if let (Ok(r), Ok(g), Ok(b)) = (
            u8::from_str_radix(&s[0..2], 16),
            u8::from_str_radix(&s[2..4], 16),
            u8::from_str_radix(&s[4..6], 16),
        ) {
            return (r, g, b);
        }
    }
    (255, 255, 255)
}

/// Recording time as Studio shows it: m:ss, or h:mm:ss.
pub fn clock_time(seconds: f64) -> String {
    let s = seconds.max(0.0).floor() as u64;
    let (h, m, ss) = (s / 3600, (s % 3600) / 60, s % 60);
    if h > 0 {
        format!("{h}:{m:02}:{ss:02}")
    } else {
        format!("{m}:{ss:02}")
    }
}

/// Combines the "cover" crop (fit the box) with the user's own crop.
pub fn combine_crop(user: [f32; 4], cover: crate::media::compositor::Crop) -> crate::media::compositor::Crop {
    let uw = (1.0 - user[0] - user[2]).max(0.01);
    let vh = (1.0 - user[1] - user[3]).max(0.01);
    crate::media::compositor::Crop {
        left: user[0] + cover.left * uw,
        top: user[1] + cover.top * vh,
        right: user[2] + cover.right * uw,
        bottom: user[3] + cover.bottom * vh,
    }
}

/// Straight-alpha "over": `top` (rgb, a) over `bottom`.
pub fn over(top: [f32; 4], bottom: [f32; 4]) -> [f32; 4] {
    let a = top[3] + bottom[3] * (1.0 - top[3]);
    if a <= 0.0 {
        return [0.0; 4];
    }
    let mix = |i: usize| (top[i] * top[3] + bottom[i] * bottom[3] * (1.0 - top[3])) / a;
    [mix(0), mix(1), mix(2), a]
}

/// Shared between Studio (commands) and the capture thread.
#[derive(Default)]
pub struct LayersShared {
    specs: RwLock<Arc<Vec<LayerSpec>>>,
    version: AtomicU64,
    enabled: AtomicBool,
    /// The running recording's written time (100 ns), for the timer layer.
    timer: Mutex<Option<Arc<AtomicI64>>>,
}

impl LayersShared {
    pub fn set(&self, layers: Vec<LayerSpec>) {
        *self.specs.write() = Arc::new(layers);
        self.version.fetch_add(1, Ordering::AcqRel);
    }

    pub fn get(&self) -> Vec<LayerSpec> {
        self.specs.read().as_ref().clone()
    }

    pub fn snapshot(&self) -> (u64, Arc<Vec<LayerSpec>>) {
        (self.version.load(Ordering::Acquire), Arc::clone(&self.specs.read()))
    }

    pub fn set_enabled(&self, on: bool) {
        self.enabled.store(on, Ordering::Release);
    }

    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::Acquire)
    }

    pub fn set_timer(&self, written_hns: Option<Arc<AtomicI64>>) {
        *self.timer.lock() = written_hns;
    }

    pub fn timer_seconds(&self) -> Option<f64> {
        self.timer.lock().as_ref().map(|t| t.load(Ordering::Relaxed) as f64 / 1e7)
    }
}

#[cfg(windows)]
pub use imp::*;

#[cfg(not(windows))]
#[derive(Default)]
pub struct LayerRenderer;

#[cfg(windows)]
mod imp {
    use super::*;
    use crate::media::compositor::{cover_crop, Compositor, Crop, Rect, SourceTexture};
    use std::collections::HashMap;
    use std::time::{Duration, Instant};
    use windows::core::Interface;
    use windows::Win32::Graphics::Direct3D11::{ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D};
    use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM;

    type Decoded = Arc<Mutex<Option<Result<(u32, u32, Vec<u8>), String>>>>;

    struct Item {
        /// What the texture shows (path, or text + size + colour).
        key: String,
        tex: Option<SourceTexture>,
        decoding: Option<Decoded>,
    }

    #[derive(Default)]
    pub struct LayerRenderer {
        items: HashMap<String, Item>,
        comp: Option<(Compositor, usize)>,
        white: Option<SourceTexture>,
        camera: Option<crate::media::webcam::Camera>,
        camera_tex: Option<SourceTexture>,
        camera_seq: u64,
        camera_unused_since: Option<Instant>,
        version: u64,
    }

    impl LayerRenderer {
        /// Draws the visible layers onto `target` (the frame being encoded).
        pub fn draw_on(&mut self, device: &ID3D11Device, context: &ID3D11DeviceContext, target: &ID3D11Texture2D, shared: &LayersShared) {
            let (version, specs) = shared.snapshot();
            let on = shared.enabled();
            let wants_cam = on && specs.iter().any(|l| l.visible && l.kind == "webcam");
            self.manage_camera(wants_cam, &specs);
            if !on || specs.iter().all(|l| !l.visible) {
                return;
            }
            if version != self.version {
                // Forget the textures of layers that were removed.
                self.version = version;
                self.items.retain(|id, _| specs.iter().any(|l| &l.id == id));
            }
            let key = target.as_raw() as usize;
            if self.comp.as_ref().map(|c| c.1) != Some(key) {
                self.comp = Compositor::on_target(device, context, target.clone()).ok().map(|c| (c, key));
            }
            if self.white.is_none() {
                if let Ok(t) = SourceTexture::new(device, 1, 1, DXGI_FORMAT_B8G8R8A8_UNORM) {
                    t.upload_bgra(context, &[255, 255, 255, 230]);
                    self.white = Some(t);
                }
            }
            // Upload the newest webcam frame.
            if let Some(cam) = self.camera.as_ref() {
                if let Some((w, h, seq, px)) = cam.latest_if_newer(self.camera_seq) {
                    self.camera_seq = seq;
                    if self.camera_tex.as_ref().map(|t| t.width != w || t.height != h).unwrap_or(true) {
                        self.camera_tex = SourceTexture::new(device, w, h, DXGI_FORMAT_B8G8R8A8_UNORM).ok();
                    }
                    if let Some(t) = self.camera_tex.as_ref() {
                        t.upload_bgra(context, &px);
                    }
                }
            }
            let Some((comp, _)) = self.comp.as_ref() else { return };
            let (fw, fh) = (comp.width as f32, comp.height as f32);
            let timer = shared.timer_seconds();

            comp.begin_keep();
            for l in specs.iter().filter(|l| l.visible && l.opacity > 0.0) {
                if l.is_picture() {
                    let tex = if l.kind == "webcam" {
                        self.camera_tex.as_ref()
                    } else {
                        let path = l.path.clone().unwrap_or_default();
                        Self::picture(&mut self.items, device, context, &l.id, &path)
                    };
                    let dst = Rect { x: l.x * fw, y: l.y * fh, w: l.w * fw, h: l.w * fw * l.aspect.max(0.01) };
                    let radius = l.radius();
                    if l.border.unwrap_or(false) {
                        if let Some(w) = self.white.as_ref() {
                            let b = (fh * 0.0025).max(1.0);
                            let outer = Rect { x: dst.x - b, y: dst.y - b, w: dst.w + 2.0 * b, h: dst.h + 2.0 * b };
                            let r = if radius >= 0.5 { 0.5 } else { (radius * dst.h + b) / outer.h };
                            comp.draw_shaped(w, outer, Crop::NONE, l.opacity * 0.9, false, r, false);
                        }
                    }
                    match tex {
                        Some(t) => {
                            let crop = combine_crop(l.user_crop(), {
                                let u = l.user_crop();
                                let sw = t.width as f32 * (1.0 - u[0] - u[2]).max(0.01);
                                let sh = t.height as f32 * (1.0 - u[1] - u[3]).max(0.01);
                                cover_crop(sw, sh, dst.w, dst.h)
                            });
                            let mirror = l.kind == "webcam" && l.mirror.unwrap_or(false);
                            comp.draw_shaped(t, dst, crop, l.opacity, false, radius, mirror);
                        }
                        None if l.kind == "webcam" => {
                            // No camera picture (yet): a dark box.
                            if let Some(w) = self.white.as_ref() {
                                comp.draw_shaped(w, dst, Crop::NONE, l.opacity * 0.12, false, radius, false);
                            }
                        }
                        None => {}
                    }
                    continue;
                }
                // Text, clock, timer.
                let (text, dot) = match l.kind.as_str() {
                    "clock" => (chrono::Local::now().format("%H:%M:%S").to_string(), false),
                    "timer" => (clock_time(timer.unwrap_or(0.0)), true),
                    _ => (l.text.clone().unwrap_or_default(), false),
                };
                if text.trim().is_empty() {
                    continue;
                }
                let px = (l.font_size.unwrap_or(0.05) * fh).clamp(6.0, 400.0).round() as i32;
                let color = parse_color(l.color.as_deref());
                let boxed = l.box_.unwrap_or(false);
                let key = format!("{text}|{px}|{color:?}|{boxed}|{dot}");
                let item = self.items.entry(l.id.clone()).or_insert(Item { key: String::new(), tex: None, decoding: None });
                if item.key != key {
                    item.key = key;
                    item.tex = render_text(&text, px, color, boxed, dot).and_then(|(w, h, bgra)| {
                        let t = SourceTexture::new(device, w, h, DXGI_FORMAT_B8G8R8A8_UNORM).ok()?;
                        t.upload_bgra(context, &bgra);
                        Some(t)
                    });
                }
                if let Some(t) = item.tex.as_ref() {
                    let dst = Rect { x: (l.x * fw).round(), y: (l.y * fh).round(), w: t.width as f32, h: t.height as f32 };
                    comp.draw(t, dst, Crop::NONE, l.opacity, false);
                }
            }
            comp.end();
        }

        /// A picture layer's texture; decoding happens on a worker thread so
        /// a big file never stalls capture.
        fn picture<'a>(items: &'a mut HashMap<String, Item>, device: &ID3D11Device, context: &ID3D11DeviceContext, id: &str, path: &str) -> Option<&'a SourceTexture> {
            let item = items.entry(id.to_string()).or_insert(Item { key: String::new(), tex: None, decoding: None });
            if item.key != path {
                item.key = path.to_string();
                item.tex = None;
                let slot: Decoded = Arc::new(Mutex::new(None));
                let (s2, p2) = (Arc::clone(&slot), path.to_string());
                let _ = std::thread::Builder::new().name("lastshot-picture".into()).spawn(move || {
                    let r = decode_image(&p2);
                    if let Err(e) = &r {
                        log::warn!("[lastshot] picture layer {p2}: {e}");
                    }
                    *s2.lock() = Some(r);
                });
                item.decoding = Some(slot);
            }
            if let Some(slot) = item.decoding.as_ref() {
                let done = slot.lock().take();
                if let Some(r) = done {
                    item.decoding = None;
                    if let Ok((w, h, px)) = r {
                        if let Ok(t) = SourceTexture::new(device, w, h, DXGI_FORMAT_B8G8R8A8_UNORM) {
                            t.upload_bgra(context, &px);
                            item.tex = Some(t);
                        }
                    }
                }
            }
            item.tex.as_ref()
        }

        fn manage_camera(&mut self, wanted: bool, specs: &[LayerSpec]) {
            if wanted {
                self.camera_unused_since = None;
                let dev = specs.iter().find(|l| l.visible && l.kind == "webcam").and_then(|l| l.device_id.clone());
                let reopen = self.camera.as_ref().map(|c| c.device() != dev.as_deref()).unwrap_or(true);
                if reopen {
                    self.camera = Some(crate::media::webcam::Camera::open(dev));
                    self.camera_tex = None;
                    self.camera_seq = 0;
                }
            } else if self.camera.is_some() {
                // Close the camera (its light goes off) 2 s after the last use.
                let since = *self.camera_unused_since.get_or_insert_with(Instant::now);
                if since.elapsed() > Duration::from_secs(2) {
                    self.camera = None;
                    self.camera_tex = None;
                }
            }
        }
    }

    /// Decodes a picture with the Windows codecs (PNG, JPEG, GIF, BMP,
    /// WebP/HEIC when installed) into BGRA, at most 4096 pixels a side.
    pub fn decode_image(path: &str) -> Result<(u32, u32, Vec<u8>), String> {
        use windows::core::{GUID, HSTRING};
        use windows::Win32::Graphics::Imaging::*;
        use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
        let e = |x: windows::core::Error| x.message().to_string();
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let factory: IWICImagingFactory = CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER).map_err(e)?;
            let decoder = factory
                .CreateDecoderFromFilename(&HSTRING::from(path), None, windows::Win32::Foundation::GENERIC_READ, WICDecodeMetadataCacheOnDemand)
                .map_err(e)?;
            let frame = decoder.GetFrame(0).map_err(e)?;
            let mut source: IWICBitmapSource = frame.cast().map_err(e)?;
            let (mut w, mut h) = (0u32, 0u32);
            source.GetSize(&mut w, &mut h).map_err(e)?;
            let max = 4096u32;
            if w > max || h > max {
                let s = (max as f32 / w as f32).min(max as f32 / h as f32);
                let (nw, nh) = (((w as f32 * s) as u32).max(1), ((h as f32 * s) as u32).max(1));
                let scaler = factory.CreateBitmapScaler().map_err(e)?;
                scaler.Initialize(&source, nw, nh, WICBitmapInterpolationModeFant).map_err(e)?;
                source = scaler.cast().map_err(e)?;
                w = nw;
                h = nh;
            }
            let fmt: GUID = GUID_WICPixelFormat32bppBGRA;
            let conv = WICConvertBitmapSource(&fmt, &source).map_err(e)?;
            let mut px = vec![0u8; (w * h * 4) as usize];
            conv.CopyPixels(std::ptr::null(), w * 4, &mut px).map_err(e)?;
            Ok((w, h, px))
        }
    }

    /// Renders text with GDI (Segoe UI, bold, grey-scale antialiasing) into
    /// straight-alpha BGRA, with the dark box or a soft shadow Studio shows.
    pub fn render_text(text: &str, px: i32, color: (u8, u8, u8), boxed: bool, dot: bool) -> Option<(u32, u32, Vec<u8>)> {
        use windows::core::PCWSTR;
        use windows::Win32::Foundation::{COLORREF, RECT};
        use windows::Win32::Graphics::Gdi::*;
        let prefix = if dot { "\u{25CF} " } else { "" };
        let full: Vec<u16> = format!("{prefix}{text}").encode_utf16().collect();
        let dot_w: Vec<u16> = prefix.encode_utf16().collect();
        unsafe {
            let dc = CreateCompatibleDC(None);
            if dc.is_invalid() {
                return None;
            }
            let face: Vec<u16> = "Segoe UI\0".encode_utf16().collect();
            let font = CreateFontW(
                -px, 0, 0, 0, 700, 0, 0, 0,
                DEFAULT_CHARSET.0 as u32,
                OUT_TT_PRECIS.0 as u32,
                CLIP_DEFAULT_PRECIS.0 as u32,
                ANTIALIASED_QUALITY.0 as u32,
                DEFAULT_PITCH.0 as u32,
                PCWSTR(face.as_ptr()),
            );
            let old_font = SelectObject(dc, font);
            let flags = DT_NOPREFIX | DT_LEFT | DT_TOP;
            let mut m = RECT::default();
            let mut buf = full.clone();
            DrawTextW(dc, &mut buf, &mut m, flags | DT_CALCRECT);
            let (tw, th) = (m.right.max(1), m.bottom.max(1));
            let (padx, pady) = if boxed { ((px as f32 * 0.5) as i32, (px as f32 * 0.25) as i32) } else { (px / 8 + 1, px / 8 + 1) };
            let (w, h) = ((tw + 2 * padx) as u32, (th + 2 * pady) as u32);
            if w > 8192 || h > 8192 {
                SelectObject(dc, old_font);
                let _ = DeleteObject(font);
                let _ = DeleteDC(dc);
                return None;
            }
            let bmi = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: w as i32,
                    biHeight: -(h as i32),
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut bits: *mut std::ffi::c_void = std::ptr::null_mut();
            let Ok(dib) = CreateDIBSection(dc, &bmi, DIB_RGB_COLORS, &mut bits, None, 0) else {
                SelectObject(dc, old_font);
                let _ = DeleteObject(font);
                let _ = DeleteDC(dc);
                return None;
            };
            let old_bmp = SelectObject(dc, dib);
            let _ = GdiFlush();
            std::ptr::write_bytes(bits as *mut u8, 0, (w * h * 4) as usize);
            SetBkMode(dc, TRANSPARENT);
            SetTextColor(dc, COLORREF(0x00FF_FFFF));
            let mut r = RECT { left: padx, top: pady, right: padx + tw, bottom: pady + th };
            let mut buf = full.clone();
            DrawTextW(dc, &mut buf, &mut r, flags);
            // Width of the red dot part, to colour it.
            let mut dr = RECT::default();
            let mut db = dot_w.clone();
            let dot_px = if dot {
                DrawTextW(dc, &mut db, &mut dr, flags | DT_CALCRECT);
                padx + dr.right
            } else {
                0
            };
            let _ = GdiFlush();
            let cov: Vec<u8> = std::slice::from_raw_parts(bits as *const u8, (w * h * 4) as usize)
                .chunks_exact(4)
                .map(|p| p[1].max(p[0]).max(p[2]))
                .collect();
            SelectObject(dc, old_bmp);
            SelectObject(dc, old_font);
            let _ = DeleteObject(dib);
            let _ = DeleteObject(font);
            let _ = DeleteDC(dc);

            let (wi, hi) = (w as i32, h as i32);
            let radius = px as f32 * 0.3;
            let shadow_dy = ((px as f32) * 0.04).ceil().max(1.0) as i32;
            let mut out = vec![0u8; (w * h * 4) as usize];
            for y in 0..hi {
                for x in 0..wi {
                    let i = (y * wi + x) as usize;
                    let mut under = [0.0f32, 0.0, 0.0, 0.0];
                    if boxed {
                        // Rounded dark box (rgba 0,0,0,0.55).
                        let cx = (x as f32 + 0.5).clamp(radius, w as f32 - radius);
                        let cy = (y as f32 + 0.5).clamp(radius, h as f32 - radius);
                        let d = ((x as f32 + 0.5 - cx).powi(2) + (y as f32 + 0.5 - cy).powi(2)).sqrt();
                        let a = (radius + 0.5 - d).clamp(0.0, 1.0) * 0.55;
                        under = [0.0, 0.0, 0.0, a];
                    } else {
                        // Soft shadow: the glyphs, moved down, dark.
                        let sy = y - shadow_dy;
                        if sy >= 0 {
                            let mut s = 0u32;
                            let mut n = 0u32;
                            for dx in -1..=1 {
                                let sx = x + dx;
                                if sx >= 0 && sx < wi {
                                    s += cov[(sy * wi + sx) as usize] as u32;
                                    n += 1;
                                }
                            }
                            under = [0.0, 0.0, 0.0, (s as f32 / n.max(1) as f32 / 255.0) * 0.8];
                        }
                    }
                    let c = cov[i] as f32 / 255.0;
                    let (r, g, b) = if dot && x < dot_px { (255u8, 90u8, 95u8) } else { color };
                    let top = [r as f32, g as f32, b as f32, c];
                    let o = over(top, under);
                    out[i * 4] = o[2].round().clamp(0.0, 255.0) as u8;
                    out[i * 4 + 1] = o[1].round().clamp(0.0, 255.0) as u8;
                    out[i * 4 + 2] = o[0].round().clamp(0.0, 255.0) as u8;
                    out[i * 4 + 3] = (o[3] * 255.0).round().clamp(0.0, 255.0) as u8;
                }
            }
            Some((w, h, out))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::compositor::Crop;

    #[test]
    fn reads_layers_written_by_other_tools() {
        // As Windows PowerShell's ConvertTo-Json writes them (integers for
        // whole numbers, odd key order, double spaces).
        let raw = "[
 {
  \"x\":  0.05,
  \"path\":  \"C:\\\\x\\\\l.png\",
  \"id\":  \"img\",
  \"kind\":  \"image\",
  \"visible\":  true,
  \"opacity\":  1,
  \"aspect\":  0.5
 },
 {
  \"id\": \"t\", \"kind\": \"text\", \"box\":  false, \"fontSize\":  0.12, \"text\": \"E2E\"
 }
]";
        let v: Vec<LayerSpec> = serde_json::from_str(raw).unwrap();
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].opacity, 1.0);
        assert_eq!(v[0].path.as_deref(), Some("C:\\x\\l.png"));
        assert_eq!(v[1].box_, Some(false));
    }

    #[test]
    fn colours_and_times() {
        assert_eq!(parse_color(Some("#ff5a5f")), (255, 90, 95));
        assert_eq!(parse_color(Some("nope")), (255, 255, 255));
        assert_eq!(parse_color(None), (255, 255, 255));
        assert_eq!(clock_time(65.9), "1:05");
        assert_eq!(clock_time(3725.0), "1:02:05");
        assert_eq!(clock_time(-3.0), "0:00");
    }

    #[test]
    fn layers_from_studio_json() {
        let j = r##"[{"id":"a","kind":"text","name":"Text","visible":true,"x":0.03,"y":0.85,"w":0.2,"aspect":0.5625,"opacity":1,"text":"Hi","fontSize":0.05,"color":"#ffffff","box":true},
                    {"id":"b","kind":"webcam","name":"Webcam","visible":false,"x":0.7,"y":0.6,"w":0.2,"aspect":1,"opacity":0.8,"shape":"circle","mirror":true,"unknownField":3}]"##;
        let v: Vec<LayerSpec> = serde_json::from_str(j).unwrap();
        assert_eq!(v[0].box_, Some(true));
        assert_eq!(v[0].font_size, Some(0.05));
        assert_eq!(v[1].radius(), 0.5);
        assert!(v[1].is_picture() && !v[1].visible);
        let back = serde_json::to_value(&v[0]).unwrap();
        assert_eq!(back["box"], true);
    }

    #[test]
    fn crop_combines_user_and_cover() {
        let c = combine_crop([0.0; 4], Crop { left: 0.2, top: 0.0, right: 0.2, bottom: 0.0 });
        assert!((c.left - 0.2).abs() < 1e-6 && (c.right - 0.2).abs() < 1e-6);
        // User keeps the right half; cover then cuts 10% of that half per side.
        let c = combine_crop([0.5, 0.0, 0.0, 0.0], Crop { left: 0.1, top: 0.0, right: 0.1, bottom: 0.0 });
        assert!((c.left - 0.55).abs() < 1e-6 && (c.right - 0.05).abs() < 1e-6);
    }

    #[test]
    fn straight_alpha_over() {
        assert_eq!(over([255.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0, 0.5]), [255.0, 0.0, 0.0, 1.0]);
        let o = over([255.0, 255.0, 255.0, 0.5], [0.0, 0.0, 0.0, 0.5]);
        assert!((o[3] - 0.75).abs() < 1e-6 && (o[0] - 170.0).abs() < 0.01);
        assert_eq!(over([0.0; 4], [0.0; 4]), [0.0; 4]);
    }

    #[test]
    fn shared_versions_and_timer() {
        let s = LayersShared::default();
        let (v0, _) = s.snapshot();
        s.set(vec![LayerSpec { id: "x".into(), ..Default::default() }]);
        let (v1, l) = s.snapshot();
        assert!(v1 > v0 && l.len() == 1);
        assert_eq!(s.timer_seconds(), None);
        let t = Arc::new(AtomicI64::new(25_000_000));
        s.set_timer(Some(t));
        assert_eq!(s.timer_seconds(), Some(2.5));
    }

    #[cfg(windows)]
    #[test]
    fn text_renders_with_alpha() {
        let (w, h, px) = render_text("Hi", 32, (255, 0, 0), true, false).unwrap();
        assert!(w > 20 && h > 30);
        // The box corner is transparent (rounded), the middle is not.
        assert_eq!(px[3], 0);
        let mid = ((h / 2 * w + w / 2) * 4) as usize;
        assert!(px[mid + 3] > 100);
        // Some fully covered glyph pixel is red.
        assert!(px.chunks_exact(4).any(|p| p[2] > 200 && p[1] < 40 && p[3] > 200));
    }
}
