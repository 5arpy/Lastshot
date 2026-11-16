//! Timeline render for the Editor panel: picture tracks (clips and still
//! images, each placed with its crop, quarter turn, flip, size and position),
//! blur/pixelate boxes, overlays on top (images and text, which the window
//! rasterises to PNG), and any number of audio pieces (clip sound, music,
//! voice-overs) mixed together with pan, EQ and a noise gate. Uses only Media
//! Foundation for decoding and encoding, like `shrink`, so the app stays small.
//!
//! Frames are produced at a constant rate: for each output frame every
//! picture active at that moment is drawn bottom track first onto a black
//! NV12 canvas (`compose_px`), the boxes are blurred or pixelated, overlays
//! are blended on top, and the frame goes to the H.264 encoder. Audio is
//! mixed first into 48 kHz stereo and written alongside.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::compose_fx;
use super::compose_px::{self, CropF, Pose};
use super::recorder::{RecorderError, RResult, HNS_PER_SECOND};

/// Output audio format.
pub const MIX_RATE: u32 = 48_000;
/// Longest project the mixer takes (the mix lives in RAM: ~11 MB a minute).
pub const MAX_SECONDS: f64 = 3.0 * 3600.0;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    /// Picture pieces of every video track (`z` orders the tracks).
    pub video: Vec<VideoItem>,
    #[serde(default)]
    pub overlays: Vec<Overlay>,
    /// Blur / pixelate boxes, applied after the pictures, under overlays.
    #[serde(default)]
    pub regions: Vec<Region>,
    /// Every sound: clip sound of picture clips and separate audio.
    #[serde(default)]
    pub audio: Vec<AudioItem>,
    /// Aim for this file size (MB) instead of full quality.
    #[serde(default)]
    pub target_mb: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoItem {
    /// A video file (its picture), or None for a still image.
    #[serde(default)]
    pub path: Option<PathBuf>,
    /// Still image: PNG data URL (placed like a video of that size).
    #[serde(default)]
    pub png: Option<String>,
    /// Where it sits on the timeline, seconds.
    pub start: f64,
    pub duration: f64,
    /// Where in the source file it starts, seconds.
    #[serde(default)]
    pub src_in: f64,
    /// Track order: 0 = bottom, higher is drawn on top.
    #[serde(default)]
    pub z: i32,
    /// Part of the source shown, as fractions.
    #[serde(default)]
    pub crop: Option<CropF>,
    #[serde(default)]
    pub flip_h: bool,
    #[serde(default)]
    pub flip_v: bool,
    /// Clockwise quarter turn: 0, 90, 180, 270.
    #[serde(default)]
    pub rot90: f64,
    /// 1 = fit the frame (cover with `fill`).
    #[serde(default = "one64")]
    pub scale: f64,
    /// Centre, as fractions of the frame.
    #[serde(default = "half")]
    pub cx: f64,
    #[serde(default = "half")]
    pub cy: f64,
    #[serde(default)]
    pub fill: bool,
}

impl VideoItem {
    pub fn pose(&self) -> Pose {
        let fin = |v: f64, d: f64| if v.is_finite() { v } else { d };
        Pose {
            crop: self.crop.and_then(|c| {
                let x = fin(c.x, 0.0).clamp(0.0, 1.0);
                let y = fin(c.y, 0.0).clamp(0.0, 1.0);
                let w = fin(c.w, 1.0).clamp(0.0, 1.0 - x);
                let h = fin(c.h, 1.0).clamp(0.0, 1.0 - y);
                (w > 1e-4 && h > 1e-4).then_some(CropF { x, y, w, h })
            }),
            rot90: compose_px::norm_rot(fin(self.rot90, 0.0)),
            flip_h: self.flip_h,
            flip_v: self.flip_v,
            scale: if self.scale.is_finite() && self.scale > 0.0 { self.scale.clamp(0.01, 50.0) } else { 1.0 },
            cx: fin(self.cx, 0.5),
            cy: fin(self.cy, 0.5),
            fill: self.fill,
        }
    }

    pub fn active(&self, t: f64) -> bool {
        t >= self.start && t < self.start + self.duration
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Overlay {
    /// PNG data URL at its exact pixel size in the output.
    pub png: String,
    pub start: f64,
    pub duration: f64,
    /// Top-left corner, as fractions of the output frame.
    pub x: f32,
    pub y: f32,
    #[serde(default = "one")]
    pub opacity: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RegionKind {
    Pixelate,
    Blur,
}

/// A box (fractions of the frame) blurred or pixelated for a while.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Region {
    pub kind: RegionKind,
    pub start: f64,
    pub duration: f64,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    /// Pixelate: block size; blur: radius. Output pixels.
    #[serde(default = "sixteen")]
    pub strength: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioItem {
    pub path: PathBuf,
    pub start: f64,
    pub duration: f64,
    #[serde(default)]
    pub src_in: f64,
    /// Linear, up to 4.
    #[serde(default = "one")]
    pub volume: f32,
    #[serde(default)]
    pub fade_in: f64,
    #[serde(default)]
    pub fade_out: f64,
    /// -1 (left) .. 1 (right).
    #[serde(default)]
    pub pan: f32,
    /// Low shelf 200 Hz, peaking 1 kHz, high shelf 5 kHz, in dB.
    #[serde(default)]
    pub eq: [f32; 3],
    /// Noise gate threshold, dBFS (None = off).
    #[serde(default)]
    pub gate: Option<f32>,
}

fn one() -> f32 {
    1.0
}
fn one64() -> f64 {
    1.0
}
fn half() -> f64 {
    0.5
}
fn sixteen() -> f64 {
    16.0
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderResult {
    pub path: String,
    pub size_bytes: u64,
    pub duration_seconds: f64,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub elapsed_ms: f64,
    pub video_kbps: u32,
}

/// What a file is, for adding it to the timeline.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    /// "video" or "audio"
    pub kind: String,
    pub duration: f64,
    pub width: u32,
    pub height: u32,
    pub has_audio: bool,
    /// Frames per second (videos only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fps: Option<f64>,
}

impl Project {
    /// Length of the result: the end of the last piece of any kind (gaps
    /// and a tail without pictures are black).
    pub fn duration(&self) -> f64 {
        let v = self.video.iter().map(|v| v.start + v.duration).fold(0.0, f64::max);
        let o = self.overlays.iter().map(|v| v.start + v.duration).fold(0.0, f64::max);
        let r = self.regions.iter().map(|v| v.start + v.duration).fold(0.0, f64::max);
        let a = self.audio.iter().map(|v| v.start + v.duration).fold(0.0, f64::max);
        v.max(o).max(r).max(a)
    }

    /// Checks sizes and lengths, and drops empty pieces.
    pub fn validate(&mut self) -> RResult<()> {
        let bad = |m: &str| Err(RecorderError::Other(m.to_string()));
        if self.width < 16 || self.height < 16 || self.width > 7680 || self.height > 4320 {
            return bad("The output size is not valid.");
        }
        self.width &= !1;
        self.height &= !1;
        self.fps = self.fps.clamp(1, 120);
        let ok = |s: f64, d: f64| s.is_finite() && d.is_finite() && d > 0.01;
        self.video.retain(|v| ok(v.start, v.duration));
        self.overlays.retain(|v| ok(v.start, v.duration));
        self.regions.retain(|v| ok(v.start, v.duration) && v.w > 0.0 && v.h > 0.0);
        self.audio.retain(|v| ok(v.start, v.duration));
        let d = self.duration();
        if d < 0.1 {
            return bad("The timeline is empty.");
        }
        if d > MAX_SECONDS {
            return bad("The timeline is longer than 3 hours.");
        }
        for v in &self.video {
            if v.path.is_none() && v.png.is_none() {
                return bad("A piece on the video track has no picture.");
            }
        }
        Ok(())
    }

    /// Picture pieces in drawing order: bottom track first, then list order.
    pub fn draw_order(&self) -> Vec<usize> {
        let mut order: Vec<usize> = (0..self.video.len()).collect();
        order.sort_by_key(|&i| (self.video[i].z, i));
        order
    }
}

// ------------------------------------------------------------------ pictures

/// Decodes a `data:image/png;base64,...` URL to RGBA.
pub fn decode_png(data_url: &str) -> RResult<image::RgbaImage> {
    use base64::Engine;
    let b64 = data_url.split_once(',').map(|(_, b)| b).unwrap_or(data_url);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .map_err(|e| RecorderError::Other(format!("picture data: {e}")))?;
    let img = image::load_from_memory_with_format(&bytes, image::ImageFormat::Png)
        .map_err(|e| RecorderError::Other(format!("picture: {e}")))?;
    Ok(img.to_rgba8())
}

/// BT.709, limited range (what H.264 game footage uses).
#[inline]
pub(crate) fn yuv(r: f32, g: f32, b: f32) -> (f32, f32, f32) {
    (
        16.0 + 0.1826 * r + 0.6142 * g + 0.0620 * b,
        128.0 - 0.1006 * r - 0.3386 * g + 0.4392 * b,
        128.0 + 0.4392 * r - 0.3989 * g - 0.0403 * b,
    )
}

/// An overlay picture in NV12 terms: luma + alpha per pixel, chroma + alpha
/// per 2x2 block, placed at an even position.
pub struct Layer {
    pub x: usize,
    pub y: usize,
    pub w: usize,
    pub h: usize,
    pub luma: Vec<u8>,
    pub alpha: Vec<u8>,
    /// Interleaved U, V per 2x2 block.
    pub chroma: Vec<u8>,
    pub calpha: Vec<u8>,
}

impl Layer {
    /// `x, y`: top-left in output pixels. The picture is clipped to the frame.
    pub fn from_rgba(img: &image::RgbaImage, x: i64, y: i64, opacity: f32, fw: usize, fh: usize) -> Option<Layer> {
        let x0 = (x.max(0) as usize) & !1;
        let y0 = (y.max(0) as usize) & !1;
        let skip_x = (x0 as i64 - x).max(0) as usize;
        let skip_y = (y0 as i64 - y).max(0) as usize;
        let iw = img.width() as usize;
        let ih = img.height() as usize;
        let w = iw.saturating_sub(skip_x).min(fw.saturating_sub(x0)) & !1;
        let h = ih.saturating_sub(skip_y).min(fh.saturating_sub(y0)) & !1;
        if w == 0 || h == 0 {
            return None;
        }
        let op = opacity.clamp(0.0, 1.0);
        let mut luma = vec![0u8; w * h];
        let mut alpha = vec![0u8; w * h];
        let mut chroma = vec![0u8; w * h / 2];
        let mut calpha = vec![0u8; w * h / 4];
        let raw = img.as_raw();
        for r in 0..h {
            for c in 0..w {
                let i = ((r + skip_y) * iw + (c + skip_x)) * 4;
                let (yy, _, _) = yuv(raw[i] as f32, raw[i + 1] as f32, raw[i + 2] as f32);
                luma[r * w + c] = yy.round().clamp(0.0, 255.0) as u8;
                alpha[r * w + c] = (raw[i + 3] as f32 * op).round() as u8;
            }
        }
        for r in 0..h / 2 {
            for c in 0..w / 2 {
                let (mut su, mut sv, mut sa, mut wsum) = (0.0f32, 0.0f32, 0.0f32, 0.0f32);
                for (dy, dx) in [(0, 0), (0, 1), (1, 0), (1, 1)] {
                    let i = ((r * 2 + dy + skip_y) * iw + (c * 2 + dx + skip_x)) * 4;
                    let a = raw[i + 3] as f32;
                    let (_, u, v) = yuv(raw[i] as f32, raw[i + 1] as f32, raw[i + 2] as f32);
                    su += u * a;
                    sv += v * a;
                    sa += a;
                    wsum += 1.0;
                }
                let k = r * (w / 2) + c;
                if sa > 0.0 {
                    chroma[k * 2] = (su / sa).round().clamp(0.0, 255.0) as u8;
                    chroma[k * 2 + 1] = (sv / sa).round().clamp(0.0, 255.0) as u8;
                } else {
                    chroma[k * 2] = 128;
                    chroma[k * 2 + 1] = 128;
                }
                calpha[k] = (sa / wsum * op).round() as u8;
            }
        }
        Some(Layer { x: x0, y: y0, w, h, luma, alpha, chroma, calpha })
    }

    /// Blends onto an NV12 frame `fw x fh` (stride = width).
    pub fn blend(&self, frame: &mut [u8], fw: usize, fh: usize) {
        let mix = |dst: &mut u8, src: u8, a: u8| {
            if a == 255 {
                *dst = src;
            } else if a > 0 {
                let a = a as u32;
                *dst = ((src as u32 * a + *dst as u32 * (255 - a) + 127) / 255) as u8;
            }
        };
        for r in 0..self.h {
            let row = (self.y + r) * fw + self.x;
            for c in 0..self.w {
                mix(&mut frame[row + c], self.luma[r * self.w + c], self.alpha[r * self.w + c]);
            }
        }
        let uv0 = fw * fh;
        for r in 0..self.h / 2 {
            let row = uv0 + (self.y / 2 + r) * fw + self.x;
            for c in 0..self.w / 2 {
                let k = r * (self.w / 2) + c;
                let a = self.calpha[k];
                mix(&mut frame[row + c * 2], self.chroma[k * 2], a);
                mix(&mut frame[row + c * 2 + 1], self.chroma[k * 2 + 1], a);
            }
        }
    }
}

/// A full `fw x fh` NV12 frame from an RGBA picture of that size.
pub fn rgba_to_nv12(img: &image::RgbaImage, fw: usize, fh: usize) -> Vec<u8> {
    let mut frame = black_frame(fw, fh);
    if let Some(l) = Layer::from_rgba(img, 0, 0, 1.0, fw, fh) {
        l.blend(&mut frame, fw, fh);
    }
    frame
}

pub fn black_frame(fw: usize, fh: usize) -> Vec<u8> {
    let mut f = vec![16u8; fw * fh * 3 / 2];
    f[fw * fh..].fill(128);
    f
}

/// Biggest even size with the source's shape that fits in `w x h`.
pub fn fit(src_w: u32, src_h: u32, w: u32, h: u32) -> (u32, u32) {
    if src_w == 0 || src_h == 0 {
        return (w, h);
    }
    let s = (w as f64 / src_w as f64).min(h as f64 / src_h as f64);
    let fw = ((src_w as f64 * s).round() as u32).min(w).max(2) & !1;
    let fh = ((src_h as f64 * s).round() as u32).min(h).max(2) & !1;
    (fw, fh)
}

// ------------------------------------------------------------------ audio

/// Interleaved stereo f32 mix of the whole timeline.
pub struct Mix {
    pub samples: Vec<f32>,
}

impl Mix {
    pub fn new(seconds: f64) -> Mix {
        Mix { samples: vec![0.0; (seconds * MIX_RATE as f64).ceil() as usize * 2] }
    }

    /// Adds stereo frames (`MIX_RATE`) starting at timeline second `at`,
    /// with the item's volume and fades. `offset` = seconds into the item.
    pub fn add(&mut self, at: f64, item: &AudioItem, offset: f64, frames: &[[f32; 2]]) {
        let first = ((at + offset) * MIX_RATE as f64).round() as i64;
        for (i, f) in frames.iter().enumerate() {
            let pos = first + i as i64;
            if pos < 0 {
                continue;
            }
            let idx = pos as usize * 2;
            if idx + 1 >= self.samples.len() {
                break;
            }
            let t = offset + i as f64 / MIX_RATE as f64;
            let g = gain(item, t);
            self.samples[idx] += f[0] * g;
            self.samples[idx + 1] += f[1] * g;
        }
    }

    /// 16-bit PCM bytes of frames `from..to`, soft-limited.
    pub fn pcm16(&self, from: usize, to: usize) -> Vec<u8> {
        let to = to.min(self.samples.len() / 2);
        let mut out = Vec::with_capacity((to.saturating_sub(from)) * 4);
        for s in &self.samples[from * 2..to * 2] {
            let v = s.clamp(-1.0, 1.0);
            out.extend_from_slice(&((v * 32767.0) as i16).to_le_bytes());
        }
        out
    }

    pub fn frames(&self) -> usize {
        self.samples.len() / 2
    }
}

/// Volume at `t` seconds into an audio piece, with fade in/out.
pub fn gain(item: &AudioItem, t: f64) -> f32 {
    let mut g = item.volume.clamp(0.0, 4.0);
    if item.fade_in > 0.0 && t < item.fade_in {
        g *= (t / item.fade_in).clamp(0.0, 1.0) as f32;
    }
    let left = item.duration - t;
    if item.fade_out > 0.0 && left < item.fade_out {
        g *= (left / item.fade_out).clamp(0.0, 1.0) as f32;
    }
    g
}

/// Streaming linear resampler to `MIX_RATE` stereo.
pub struct Resampler {
    step: f64,
    pos: f64,
    pending: Vec<[f32; 2]>,
}

impl Resampler {
    pub fn new(in_rate: u32) -> Resampler {
        Resampler { step: in_rate.max(1) as f64 / MIX_RATE as f64, pos: 0.0, pending: Vec::new() }
    }

    /// Feeds input frames, returns the output frames ready so far.
    pub fn push(&mut self, input: &[[f32; 2]]) -> Vec<[f32; 2]> {
        self.pending.extend_from_slice(input);
        let mut out = Vec::new();
        while self.pos + 1.0 < self.pending.len() as f64 {
            let i = self.pos as usize;
            let f = (self.pos - i as f64) as f32;
            let (a, b) = (self.pending[i], self.pending[i + 1]);
            out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
            self.pos += self.step;
        }
        let used = (self.pos as usize).min(self.pending.len().saturating_sub(1));
        self.pending.drain(..used);
        self.pos -= used as f64;
        out
    }
}

/// 16-bit interleaved PCM with `ch` channels to stereo frames.
pub fn to_stereo(bytes: &[u8], ch: usize) -> Vec<[f32; 2]> {
    let ch = ch.max(1);
    let n = bytes.len() / 2 / ch;
    let s = |i: usize| i16::from_le_bytes([bytes[i * 2], bytes[i * 2 + 1]]) as f32 / 32768.0;
    (0..n)
        .map(|f| {
            let l = s(f * ch);
            let r = if ch > 1 { s(f * ch + 1) } else { l };
            [l, r]
        })
        .collect()
}

pub fn render(project: &Project, dest: &Path, progress: &mut dyn FnMut(f32)) -> RResult<RenderResult> {
    let mut p = project.clone();
    p.validate()?;
    let t0 = std::time::Instant::now();
    let video_bps = imp::render(&p, dest, progress)?;
    progress(1.0);
    Ok(RenderResult {
        path: dest.to_string_lossy().to_string(),
        size_bytes: std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0),
        duration_seconds: p.duration(),
        width: p.width,
        height: p.height,
        fps: p.fps,
        elapsed_ms: t0.elapsed().as_secs_f64() * 1000.0,
        video_kbps: video_bps / 1000,
    })
}

pub fn media_info(path: &Path) -> RResult<MediaInfo> {
    imp::media_info(path)
}

/// Waveform of a file's sound: `(buckets per second, peak 0-255 each)`.
/// Empty for files without sound.
pub fn audio_peaks(path: &Path) -> RResult<(f64, Vec<u8>)> {
    imp::audio_peaks(path)
}

/// PNG data URLs of the frames at `times` (source seconds), `height` px
/// tall; "" where a frame could not be read.
pub fn video_thumbs(path: &Path, times: &[f64], height: u32) -> RResult<Vec<String>> {
    imp::video_thumbs(path, times, height)
}

/// Sound export formats this PC can write.
pub fn audio_formats() -> Vec<String> {
    let mut v = vec!["wav".to_string(), "m4a".to_string()];
    if imp::mp3_available() {
        v.push("mp3".into());
    }
    v
}

/// Mixes `items` (with pan, EQ, gate, fades, volume) over `duration`
/// seconds and writes `dest`: `.wav` (16-bit 48 kHz stereo), `.m4a` (AAC),
/// or `.mp3` when Windows has an MP3 encoder.
pub fn export_audio(items: &[AudioItem], duration: f64, dest: &Path, progress: &mut dyn FnMut(f32)) -> RResult<()> {
    let bad = |m: String| Err(RecorderError::Other(m));
    if !duration.is_finite() || duration < 0.05 {
        return bad("There is no sound to export.".into());
    }
    if duration > MAX_SECONDS {
        return bad("The sound is longer than 3 hours.".into());
    }
    let ext = dest.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    if !matches!(ext.as_str(), "wav" | "m4a" | "mp3") {
        return bad(format!("Lastshot cannot write .{ext} sound files (use wav, m4a or mp3)."));
    }
    let items: Vec<AudioItem> =
        items.iter().filter(|a| a.duration.is_finite() && a.start.is_finite() && a.duration > 0.01).cloned().collect();
    imp::export_audio(&items, duration, dest, &ext, progress)
}

/// Writes the mix as a 16-bit PCM WAV file.
pub fn write_wav(mix: &Mix, dest: &Path) -> RResult<()> {
    use std::io::Write;
    let io = |e: std::io::Error| RecorderError::Io(e.to_string());
    let frames = mix.frames();
    if frames as u64 * 4 + 36 > u32::MAX as u64 {
        return Err(RecorderError::Other("The sound is too long for a WAV file.".into()));
    }
    let mut f = std::io::BufWriter::new(std::fs::File::create(dest).map_err(io)?);
    f.write_all(&compose_fx::wav_header(frames as u32, MIX_RATE, 2)).map_err(io)?;
    let step = MIX_RATE as usize;
    let mut at = 0;
    while at < frames {
        f.write_all(&mix.pcm16(at, at + step)).map_err(io)?;
        at += step;
    }
    f.flush().map_err(io)
}

/// Threads for drawing frames: leave one core for the encoder and the app.
fn draw_threads() -> usize {
    std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).saturating_sub(1).clamp(1, 8)
}

// ===========================================================================
//                        WINDOWS IMPLEMENTATION
// ===========================================================================

#[cfg(all(windows, not(feature = "headless-sim")))]
mod imp {
    use super::compose_px::{composite, decode_size, placement, region_box, Draw, Placement, Planes, Src};
    use super::*;
    use super::compose_fx::Fx;
    use windows::core::PCWSTR;
    use windows::Win32::Media::MediaFoundation::*;
    use windows::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_MULTITHREADED};

    struct Mf;
    impl Mf {
        fn enter() -> RResult<Self> {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
                MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET).map_err(err)?;
            }
            Ok(Mf)
        }
    }
    impl Drop for Mf {
        fn drop(&mut self) {
            unsafe {
                let _ = MFShutdown();
                CoUninitialize();
            }
        }
    }

    fn err(e: windows::core::Error) -> RecorderError {
        RecorderError::Win(format!("{} (0x{:08X})", e.message(), e.code().0 as u32))
    }

    fn wide(p: &Path) -> Vec<u16> {
        use std::os::windows::ffi::OsStrExt;
        p.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
    }

    fn pack(hi: u32, lo: u32) -> u64 {
        ((hi as u64) << 32) | lo as u64
    }

    unsafe fn attrs(n: u32) -> RResult<IMFAttributes> {
        let mut a: Option<IMFAttributes> = None;
        MFCreateAttributes(&mut a, n).map_err(err)?;
        a.ok_or_else(|| RecorderError::Other("MF attributes".into()))
    }

    unsafe fn reader(path: &Path, video_processing: bool) -> RResult<IMFSourceReader> {
        let ra = attrs(2)?;
        if video_processing {
            ra.SetUINT32(&MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING, 1).map_err(err)?;
        }
        let src = wide(path);
        MFCreateSourceReaderFromURL(PCWSTR(src.as_ptr()), &ra).map_err(|e| {
            RecorderError::Other(format!("Could not open {}: {}", path.display(), e.message()))
        })
    }

    unsafe fn stream_of(r: &IMFSourceReader, kind: windows::core::GUID) -> Option<u32> {
        for i in 0..16 {
            let Ok(t) = r.GetNativeMediaType(i, 0) else { continue };
            if t.GetGUID(&MF_MT_MAJOR_TYPE).ok() == Some(kind) {
                return Some(i);
            }
        }
        None
    }

    unsafe fn seek(r: &IMFSourceReader, seconds: f64) -> RResult<()> {
        if seconds > 0.0 {
            let var = windows::core::PROPVARIANT::from((seconds * HNS_PER_SECOND as f64) as i64);
            r.SetCurrentPosition(&windows::core::GUID::zeroed(), &var).map_err(err)?;
        }
        Ok(())
    }

    /// Seeks to `hns` (also back to 0).
    unsafe fn seek_hns(r: &IMFSourceReader, hns: i64) -> RResult<()> {
        let var = windows::core::PROPVARIANT::from(hns.max(0));
        r.SetCurrentPosition(&windows::core::GUID::zeroed(), &var).map_err(err)
    }

    unsafe fn duration_of(r: &IMFSourceReader) -> f64 {
        r.GetPresentationAttribute(MF_SOURCE_READER_MEDIASOURCE.0 as u32, &MF_PD_DURATION)
            .ok()
            .and_then(|v| windows::Win32::System::Com::StructuredStorage::PropVariantToInt64(&v).ok())
            .unwrap_or(0) as f64
            / HNS_PER_SECOND as f64
    }

    /// Copies a sample's bytes out.
    unsafe fn sample_bytes(sample: &IMFSample) -> RResult<Vec<u8>> {
        let buf = sample.ConvertToContiguousBuffer().map_err(err)?;
        let mut ptr: *mut u8 = std::ptr::null_mut();
        let mut len = 0u32;
        buf.Lock(&mut ptr, None, Some(&mut len)).map_err(err)?;
        let bytes = std::slice::from_raw_parts(ptr, len as usize).to_vec();
        let _ = buf.Unlock();
        Ok(bytes)
    }

    pub(super) fn media_info(path: &Path) -> RResult<MediaInfo> {
        let _mf = Mf::enter()?;
        unsafe {
            let r = reader(path, false)?;
            let video = stream_of(&r, MFMediaType_Video);
            let audio = stream_of(&r, MFMediaType_Audio);
            if video.is_none() && audio.is_none() {
                return Err(RecorderError::Other("This file has no picture or sound Lastshot can read.".into()));
            }
            let dur = duration_of(&r);
            let (mut w, mut h, mut fps) = (0, 0, None);
            if let Some(v) = video {
                if let Ok(t) = r.GetNativeMediaType(v, 0) {
                    if let Ok(s) = t.GetUINT64(&MF_MT_FRAME_SIZE) {
                        w = (s >> 32) as u32;
                        h = (s & 0xffff_ffff) as u32;
                    }
                    if let Ok(f) = t.GetUINT64(&MF_MT_FRAME_RATE) {
                        let (num, den) = ((f >> 32) as u32, (f & 0xffff_ffff) as u32);
                        if num > 0 && den > 0 {
                            fps = Some(num as f64 / den as f64);
                        }
                    }
                }
            }
            Ok(MediaInfo {
                kind: if video.is_some() { "video" } else { "audio" }.into(),
                duration: dur,
                width: w,
                height: h,
                has_audio: audio.is_some(),
                fps,
            })
        }
    }

    /// A reader giving 16-bit PCM of the first sound stream:
    /// `(reader, stream, rate, channels)`. None without sound.
    unsafe fn pcm_reader(path: &Path) -> RResult<Option<(IMFSourceReader, u32, u32, usize)>> {
        let r = reader(path, false)?;
        let Some(idx) = stream_of(&r, MFMediaType_Audio) else { return Ok(None) };
        r.SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS.0 as u32, false).map_err(err)?;
        r.SetStreamSelection(idx, true).map_err(err)?;
        let t = MFCreateMediaType().map_err(err)?;
        t.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio).map_err(err)?;
        t.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_PCM).map_err(err)?;
        t.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16).map_err(err)?;
        r.SetCurrentMediaType(idx, None, &t).map_err(err)?;
        let cur = r.GetCurrentMediaType(idx).map_err(err)?;
        let rate = cur.GetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND).unwrap_or(48_000);
        let ch = cur.GetUINT32(&MF_MT_AUDIO_NUM_CHANNELS).unwrap_or(2) as usize;
        Ok(Some((r, idx, rate, ch)))
    }

    /// Decodes one audio piece into the mix.
    unsafe fn mix_in(mix: &mut Mix, item: &AudioItem) -> RResult<()> {
        let Some((r, idx, rate, ch)) = pcm_reader(&item.path)? else { return Ok(()) };
        seek(&r, item.src_in)?;
        let start_hns = (item.src_in * HNS_PER_SECOND as f64) as i64;
        let end_hns = ((item.src_in + item.duration) * HNS_PER_SECOND as f64) as i64;
        let mut rs = Resampler::new(rate);
        let mut fx = Fx::new(item.pan, item.eq, item.gate, MIX_RATE as f64);
        let mut written = 0usize; // output frames added so far
        let mut started = false;
        loop {
            let mut flags = 0u32;
            let mut ts = 0i64;
            let mut sample: Option<IMFSample> = None;
            r.ReadSample(idx, 0, None, Some(&mut flags), Some(&mut ts), Some(&mut sample))
                .map_err(err)?;
            if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
                break;
            }
            let Some(sample) = sample else { continue };
            if ts >= end_hns {
                break;
            }
            let mut bytes = sample_bytes(&sample)?;
            // Drop what lies before the in-point (seeking lands on a packet edge).
            if !started {
                started = true;
                if ts < start_hns {
                    let skip = ((start_hns - ts) as f64 / HNS_PER_SECOND as f64 * rate as f64) as usize * ch * 2;
                    bytes.drain(..skip.min(bytes.len()));
                }
            }
            let mut out = rs.push(&to_stereo(&bytes, ch));
            let at = written as f64 / MIX_RATE as f64;
            let keep = ((item.duration - at) * MIX_RATE as f64).max(0.0) as usize;
            out.truncate(keep);
            fx.process(&mut out);
            mix.add(item.start, item, at, &out);
            written += out.len();
            if written as f64 >= item.duration * MIX_RATE as f64 {
                break;
            }
        }
        Ok(())
    }

    /// Every piece mixed into one `duration`-second track.
    fn build_mix(items: &[AudioItem], duration: f64, progress: &mut dyn FnMut(f32)) -> RResult<Mix> {
        let mut m = Mix::new(duration);
        for (i, a) in items.iter().enumerate() {
            unsafe { mix_in(&mut m, a) }
                .map_err(|e| RecorderError::Other(format!("Sound of {}: {e}", a.path.display())))?;
            progress((i + 1) as f32 / items.len() as f32);
        }
        Ok(m)
    }

    // -------------------------------------------------------------- peaks

    pub(super) fn audio_peaks(path: &Path) -> RResult<(f64, Vec<u8>)> {
        let _mf = Mf::enter()?;
        unsafe {
            let Some((r, idx, rate, ch)) = pcm_reader(path)? else { return Ok((100.0, Vec::new())) };
            let rate_b = compose_fx::peaks_rate(duration_of(&r));
            let mut pb = compose_fx::PeakBucketer::new(rate, rate_b);
            let mut first = true;
            loop {
                let mut flags = 0u32;
                let mut ts = 0i64;
                let mut sample: Option<IMFSample> = None;
                r.ReadSample(idx, 0, None, Some(&mut flags), Some(&mut ts), Some(&mut sample))
                    .map_err(err)?;
                if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
                    break;
                }
                let Some(sample) = sample else { continue };
                if first {
                    first = false;
                    if ts > 0 {
                        pb.offset((ts as f64 / HNS_PER_SECOND as f64 * rate as f64) as u64);
                    }
                }
                let buf = sample.ConvertToContiguousBuffer().map_err(err)?;
                let mut ptr: *mut u8 = std::ptr::null_mut();
                let mut len = 0u32;
                buf.Lock(&mut ptr, None, Some(&mut len)).map_err(err)?;
                pb.push_pcm16(std::slice::from_raw_parts(ptr, len as usize), ch);
                let _ = buf.Unlock();
            }
            Ok((rate_b, pb.finish()))
        }
    }

    // -------------------------------------------------------------- thumbs

    /// One decoded RGB32 frame (top-down BGRA, tight rows).
    type Frame = (i64, Vec<u8>);

    pub(super) fn video_thumbs(path: &Path, times: &[f64], height: u32) -> RResult<Vec<String>> {
        let _mf = Mf::enter()?;
        unsafe {
            let r = reader(path, true)?;
            let stream = stream_of(&r, MFMediaType_Video)
                .ok_or_else(|| RecorderError::Other(format!("{} has no picture", path.display())))?;
            let native = r.GetNativeMediaType(stream, 0).map_err(err)?;
            let size = native.GetUINT64(&MF_MT_FRAME_SIZE).map_err(err)?;
            let (nw, nh) = (((size >> 32) as u32).max(2), ((size & 0xffff_ffff) as u32).max(2));
            let th = (height.clamp(8, 1080) & !1).min(nh & !1).max(2);
            let tw = (((nw as f64 * th as f64 / nh as f64).round() as u32) & !1).clamp(2, 4096);
            // Decode at twice the size when the source allows, then average
            // 2x2: sharper than one big scale step.
            let two = nh >= th * 2 && nw >= tw * 2;
            let (dw, dh) = if two { (tw * 2, th * 2) } else { (tw, th) };
            r.SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS.0 as u32, false).map_err(err)?;
            r.SetStreamSelection(stream, true).map_err(err)?;
            let t = MFCreateMediaType().map_err(err)?;
            t.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(err)?;
            t.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_RGB32).map_err(err)?;
            t.SetUINT64(&MF_MT_FRAME_SIZE, pack(dw, dh)).map_err(err)?;
            r.SetCurrentMediaType(stream, None, &t).map_err(err)?;
            let stride = r
                .GetCurrentMediaType(stream)
                .ok()
                .and_then(|c| c.GetUINT32(&MF_MT_DEFAULT_STRIDE).ok())
                .map(|s| s as i32)
                .unwrap_or((dw * 4) as i32);
            let (dw, dh) = (dw as usize, dh as usize);

            let read = |r: &IMFSourceReader| -> RResult<Option<Frame>> {
                loop {
                    let mut flags = 0u32;
                    let mut ts = 0i64;
                    let mut sample: Option<IMFSample> = None;
                    r.ReadSample(stream, 0, None, Some(&mut flags), Some(&mut ts), Some(&mut sample))
                        .map_err(err)?;
                    if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
                        return Ok(None);
                    }
                    let Some(s) = sample else { continue };
                    let raw = sample_bytes(&s)?;
                    let row = stride.unsigned_abs() as usize;
                    if row < dw * 4 || raw.len() < row * (dh - 1) + dw * 4 {
                        return Err(RecorderError::Other("unexpected frame buffer".into()));
                    }
                    let mut px = vec![0u8; dw * dh * 4];
                    for y in 0..dh {
                        let sy = if stride < 0 { dh - 1 - y } else { y };
                        px[y * dw * 4..(y + 1) * dw * 4].copy_from_slice(&raw[sy * row..sy * row + dw * 4]);
                    }
                    return Ok(Some((ts, px)));
                }
            };

            let eps = HNS_PER_SECOND / 1000;
            let jump = 2 * HNS_PER_SECOND;
            let mut last: Option<Frame> = None;
            let mut pending: Option<Frame> = None;
            let mut eos = false;
            let mut out = Vec::with_capacity(times.len());
            for &t in times {
                if !t.is_finite() || t < 0.0 {
                    out.push(String::new());
                    continue;
                }
                let want = (t * HNS_PER_SECOND as f64) as i64;
                let anchor = last.as_ref().or(pending.as_ref()).map(|f| f.0);
                let need_seek = match anchor {
                    None => true,
                    Some(a) => want < a || want > a + jump,
                };
                if need_seek {
                    if seek_hns(&r, want).is_err() {
                        out.push(String::new());
                        continue;
                    }
                    last = None;
                    pending = None;
                    eos = false;
                }
                let mut failed = false;
                loop {
                    if let Some(p) = &pending {
                        if p.0 <= want + eps {
                            last = pending.take();
                        } else {
                            break;
                        }
                    }
                    if eos {
                        break;
                    }
                    match read(&r) {
                        Ok(Some(f)) => pending = Some(f),
                        Ok(None) => eos = true,
                        Err(_) => {
                            failed = true;
                            break;
                        }
                    }
                }
                if failed {
                    last = None;
                    pending = None;
                    out.push(String::new());
                    continue;
                }
                let pick = last.as_ref().or(pending.as_ref());
                out.push(pick.map(|f| thumb_png(&f.1, dw, dh, two).unwrap_or_default()).unwrap_or_default());
            }
            Ok(out)
        }
    }

    /// BGRA (optionally halved with a 2x2 average) to a PNG data URL.
    fn thumb_png(bgra: &[u8], w: usize, h: usize, halve: bool) -> Option<String> {
        let (ow, oh) = if halve { (w / 2, h / 2) } else { (w, h) };
        let mut rgb = vec![0u8; ow * oh * 3];
        for y in 0..oh {
            for x in 0..ow {
                let d = (y * ow + x) * 3;
                if halve {
                    for c in 0..3 {
                        let at = |yy: usize, xx: usize| bgra[(yy * w + xx) * 4 + c] as u32;
                        let s = at(y * 2, x * 2) + at(y * 2, x * 2 + 1) + at(y * 2 + 1, x * 2) + at(y * 2 + 1, x * 2 + 1);
                        rgb[d + 2 - c] = ((s + 2) / 4) as u8;
                    }
                } else {
                    let i = (y * w + x) * 4;
                    rgb[d] = bgra[i + 2];
                    rgb[d + 1] = bgra[i + 1];
                    rgb[d + 2] = bgra[i];
                }
            }
        }
        let mut png = Vec::new();
        let enc = image::codecs::png::PngEncoder::new_with_quality(
            &mut png,
            image::codecs::png::CompressionType::Fast,
            image::codecs::png::FilterType::Adaptive,
        );
        image::ImageEncoder::write_image(enc, &rgb, ow as u32, oh as u32, image::ExtendedColorType::Rgb8).ok()?;
        use base64::Engine;
        Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(&png)))
    }

    // -------------------------------------------------------------- sound files

    unsafe fn pcm_type() -> RResult<IMFMediaType> {
        let pcm = MFCreateMediaType().map_err(err)?;
        pcm.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio).map_err(err)?;
        pcm.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_PCM).map_err(err)?;
        pcm.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16).map_err(err)?;
        pcm.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, MIX_RATE).map_err(err)?;
        pcm.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, 2).map_err(err)?;
        pcm.SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, 4).map_err(err)?;
        pcm.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, MIX_RATE * 4).map_err(err)?;
        Ok(pcm)
    }

    unsafe fn aac_type(bps: u32) -> RResult<IMFMediaType> {
        let aac = MFCreateMediaType().map_err(err)?;
        aac.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio).map_err(err)?;
        aac.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_AAC).map_err(err)?;
        aac.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16).map_err(err)?;
        aac.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, MIX_RATE).map_err(err)?;
        aac.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, 2).map_err(err)?;
        aac.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, bps / 8).map_err(err)?;
        Ok(aac)
    }

    /// Registered MP3 encoders (Windows ships one on most editions).
    unsafe fn mp3_encoders() -> Vec<IMFActivate> {
        let info = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Audio, guidSubtype: MFAudioFormat_MP3 };
        let flags = MFT_ENUM_FLAG(
            MFT_ENUM_FLAG_SYNCMFT.0
                | MFT_ENUM_FLAG_ASYNCMFT.0
                | MFT_ENUM_FLAG_LOCALMFT.0
                | MFT_ENUM_FLAG_TRANSCODE_ONLY.0
                | MFT_ENUM_FLAG_SORTANDFILTER.0,
        );
        let mut arr: *mut Option<IMFActivate> = std::ptr::null_mut();
        let mut n = 0u32;
        if MFTEnumEx(MFT_CATEGORY_AUDIO_ENCODER, flags, None, Some(&info), &mut arr, &mut n).is_err() || arr.is_null() {
            return Vec::new();
        }
        let mut out = Vec::new();
        for i in 0..n as usize {
            if let Some(a) = (*arr.add(i)).take() {
                out.push(a);
            }
        }
        CoTaskMemFree(Some(arr as *const _));
        out
    }

    pub(super) fn mp3_available() -> bool {
        let Ok(_mf) = Mf::enter() else { return false };
        unsafe { !mp3_encoders().is_empty() }
    }

    /// An MP3 output type the encoder offers for 48 kHz stereo, about
    /// 192 kbps (or the best it has below 320).
    unsafe fn mp3_type() -> RResult<IMFMediaType> {
        let none = || RecorderError::Other("MP3 is not available on this PC (Windows has no MP3 encoder here).".into());
        let encoders = mp3_encoders();
        if encoders.is_empty() {
            return Err(none());
        }
        let pcm = pcm_type()?;
        for act in &encoders {
            let Ok(mft) = act.ActivateObject::<IMFTransform>() else { continue };
            let _ = mft.SetInputType(0, &pcm, 0);
            let mut best: Option<(u32, IMFMediaType)> = None;
            for i in 0..256 {
                let Ok(t) = mft.GetOutputAvailableType(0, i) else { break };
                let rate = t.GetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND).unwrap_or(0);
                let ch = t.GetUINT32(&MF_MT_AUDIO_NUM_CHANNELS).unwrap_or(0);
                let bytes = t.GetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND).unwrap_or(0);
                if rate != MIX_RATE || ch != 2 || bytes == 0 || bytes > 40_000 {
                    continue;
                }
                // Closest to 24000 bytes/s (192 kbps), preferring above.
                let score = if bytes >= 24_000 { bytes - 24_000 } else { (24_000 - bytes) * 2 };
                if best.as_ref().map_or(true, |b| score < b.0) {
                    best = Some((score, t));
                }
            }
            let _ = act.ShutdownObject();
            if let Some((_, t)) = best {
                return Ok(t);
            }
        }
        // The encoder lists no types: describe one by hand.
        let t = MFCreateMediaType().map_err(err)?;
        t.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio).map_err(err)?;
        t.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_MP3).map_err(err)?;
        t.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, MIX_RATE).map_err(err)?;
        t.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, 2).map_err(err)?;
        t.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 24_000).map_err(err)?;
        t.SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, 1).map_err(err)?;
        Ok(t)
    }

    pub(super) fn export_audio(
        items: &[AudioItem],
        duration: f64,
        dest: &Path,
        ext: &str,
        progress: &mut dyn FnMut(f32),
    ) -> RResult<()> {
        let _mf = Mf::enter()?;
        // Check the encoder before the (slow) mix.
        let mp3 = if ext == "mp3" { Some(unsafe { mp3_type() }?) } else { None };
        let mix = build_mix(items, duration, &mut |x| progress(x * 0.8))?;
        let r = match ext {
            "wav" => write_wav(&mix, dest),
            _ => unsafe {
                let (container, out) = match mp3 {
                    Some(t) => (MFTranscodeContainerType_MP3, t),
                    None => (MFTranscodeContainerType_MPEG4, aac_type(192_000)?),
                };
                write_sound(&mix, dest, &container, &out, &mut |x| progress(0.8 + x * 0.2))
            },
        };
        if r.is_err() {
            let _ = std::fs::remove_file(dest);
        }
        progress(1.0);
        r
    }

    unsafe fn write_sound(
        mix: &Mix,
        dest: &Path,
        container: &windows::core::GUID,
        out_type: &IMFMediaType,
        progress: &mut dyn FnMut(f32),
    ) -> RResult<()> {
        let wa = attrs(2)?;
        wa.SetGUID(&MF_TRANSCODE_CONTAINERTYPE, container).map_err(err)?;
        let _ = wa.SetUINT32(&MF_SINK_WRITER_DISABLE_THROTTLING, 1);
        let out = wide(dest);
        let writer = MFCreateSinkWriterFromURL(PCWSTR(out.as_ptr()), None, &wa).map_err(err)?;
        let s = writer.AddStream(out_type).map_err(err)?;
        writer.SetInputMediaType(s, &pcm_type()?, None).map_err(err)?;
        writer.BeginWriting().map_err(err)?;
        let chunk = (MIX_RATE / 2) as usize;
        let mut at = 0;
        while at < mix.frames() {
            let to = (at + chunk).min(mix.frames());
            write_audio(&writer, s, mix, at, to)?;
            at = to;
            progress(at as f32 / mix.frames().max(1) as f32);
        }
        writer.Finalize().map_err(err)
    }

    // -------------------------------------------------------------- pictures

    /// The decoder of a picture clip being drawn.
    struct Clip {
        reader: IMFSourceReader,
        stream: u32,
        fw: usize,
        fh: usize,
        /// Decoded frame waiting to be shown, with its source time.
        next: Option<(i64, Vec<u8>)>,
        /// Frame on screen now.
        current: Option<Vec<u8>>,
        ended: bool,
    }

    /// Opens `path` decoding NV12 at `w x h` (MF scales), from `src_in`.
    unsafe fn open_clip(path: &Path, src_in: f64, w: u32, h: u32) -> RResult<Clip> {
        let r = reader(path, true)?;
        let stream = stream_of(&r, MFMediaType_Video)
            .ok_or_else(|| RecorderError::Other(format!("{} has no picture", path.display())))?;
        r.SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS.0 as u32, false).map_err(err)?;
        r.SetStreamSelection(stream, true).map_err(err)?;
        let nv12 = MFCreateMediaType().map_err(err)?;
        nv12.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(err)?;
        nv12.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12).map_err(err)?;
        nv12.SetUINT64(&MF_MT_FRAME_SIZE, pack(w, h)).map_err(err)?;
        r.SetCurrentMediaType(stream, None, &nv12).map_err(err)?;
        seek(&r, src_in)?;
        Ok(Clip { reader: r, stream, fw: w as usize, fh: h as usize, next: None, current: None, ended: false })
    }

    /// Copies a decoded NV12 sample (stride = width) into a tight buffer.
    unsafe fn sample_nv12(sample: &IMFSample, w: usize, h: usize) -> RResult<Vec<u8>> {
        let buf = sample.ConvertToContiguousBuffer().map_err(err)?;
        let mut ptr: *mut u8 = std::ptr::null_mut();
        let mut len = 0u32;
        buf.Lock(&mut ptr, None, Some(&mut len)).map_err(err)?;
        let s = std::slice::from_raw_parts(ptr, len as usize);
        let rows_y = (len as usize * 2 / 3) / w.max(1);
        if rows_y < h {
            let _ = buf.Unlock();
            return Err(RecorderError::Other(format!("unexpected frame buffer ({len} bytes for {w}x{h})")));
        }
        let mut out = vec![0u8; w * h * 3 / 2];
        out[..w * h].copy_from_slice(&s[..w * h]);
        let uv = rows_y * w;
        out[w * h..].copy_from_slice(&s[uv..uv + w * h / 2]);
        let _ = buf.Unlock();
        Ok(out)
    }

    impl Clip {
        /// Decodes up to the frame shown at source time `src_hns`.
        unsafe fn advance(&mut self, src_hns: i64) -> RResult<()> {
            loop {
                if let Some((ts, _)) = &self.next {
                    if *ts <= src_hns {
                        self.current = self.next.take().map(|(_, f)| f);
                        continue;
                    }
                    break;
                }
                if self.ended {
                    break;
                }
                let mut flags = 0u32;
                let mut ts = 0i64;
                let mut sample: Option<IMFSample> = None;
                self.reader
                    .ReadSample(self.stream, 0, None, Some(&mut flags), Some(&mut ts), Some(&mut sample))
                    .map_err(err)?;
                if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
                    self.ended = true;
                    continue;
                }
                if let Some(s) = sample {
                    self.next = Some((ts, sample_nv12(&s, self.fw, self.fh)?));
                }
            }
            Ok(())
        }

        /// The frame on screen (or the first one, if the source starts a
        /// little after the in-point).
        fn picture(&self) -> Option<&Vec<u8>> {
            self.current.as_ref().or(self.next.as_ref().map(|n| &n.1))
        }

        fn src<'a>(&self, pic: &'a [u8]) -> Src<'a> {
            let n = self.fw * self.fh;
            Src { w: self.fw, h: self.fh, y: &pic[..n], uv: &pic[n..], a: None, ca: None }
        }
    }

    /// A picture piece being drawn.
    enum Source {
        /// `plain`: whole, centred, fitted; decoded at the fitted size.
        Video { clip: Clip, pl: Placement, plain: bool },
        Still { planes: Planes, pl: Placement },
        Nothing,
    }

    unsafe fn open_source(item: &VideoItem, w: u32, h: u32) -> RResult<Source> {
        let pose = item.pose();
        if let Some(path) = &item.path {
            let info = super::super::library::probe(path)?;
            let (nw, nh) = (info.width.max(2), info.height.max(2));
            let pl = placement(&pose, nw as f64, nh as f64, w as f64, h as f64);
            let plain = pose.is_plain();
            let (dw, dh) = if plain { fit(nw, nh, w, h) } else { decode_size(&pl, nw, nh) };
            let clip = open_clip(path, item.src_in, dw, dh)?;
            let pl = pl.rescaled_source(dw as f64 / nw as f64, dh as f64 / nh as f64);
            return Ok(Source::Video { clip, pl, plain });
        }
        let Some(png) = &item.png else { return Ok(Source::Nothing) };
        let mut img = decode_png(png)?;
        let (nw, nh) = (img.width().max(1), img.height().max(1));
        let pl = placement(&pose, nw as f64, nh as f64, w as f64, h as f64);
        // Big pictures are scaled down once, with a good filter.
        let (dw, dh) = decode_size(&pl, nw, nh);
        if dw < nw & !1 || dh < nh & !1 {
            img = image::imageops::resize(&img, dw, dh, image::imageops::FilterType::Triangle);
        }
        let Some(planes) = Planes::from_rgba(&img) else { return Ok(Source::Nothing) };
        let pl = pl.rescaled_source(img.width() as f64 / nw as f64, img.height() as f64 / nh as f64);
        Ok(Source::Still { planes, pl })
    }

    /// Puts a `fw x fh` NV12 picture in the middle of a `w x h` frame.
    fn place(frame: &mut [u8], w: usize, h: usize, pic: &[u8], fw: usize, fh: usize) {
        let ox = ((w - fw) / 2) & !1;
        let oy = ((h - fh) / 2) & !1;
        for r in 0..fh {
            let d = (oy + r) * w + ox;
            frame[d..d + fw].copy_from_slice(&pic[r * fw..r * fw + fw]);
        }
        let (duv, suv) = (w * h, fw * fh);
        for r in 0..fh / 2 {
            let d = duv + (oy / 2 + r) * w + ox;
            frame[d..d + fw].copy_from_slice(&pic[suv + r * fw..suv + r * fw + fw]);
        }
    }

    /// Renders; returns the video bitrate used.
    pub(super) fn render(p: &Project, dest: &Path, progress: &mut dyn FnMut(f32)) -> RResult<u32> {
        let _mf = Mf::enter()?;
        // Sound first: every piece mixed into one track.
        let duration = p.duration();
        let mix = if p.audio.is_empty() {
            None
        } else {
            Some(build_mix(&p.audio, duration, &mut |x| progress(0.1 * x))?)
        };
        let mut sub = |x: f32| progress(0.1 + x * 0.9);
        let r = unsafe { encode(p, dest, mix.as_ref(), true, &mut sub) };
        match r {
            Ok(bps) => Ok(bps),
            Err(e) => {
                log::warn!("[lastshot] hardware render failed ({e}); retrying in software");
                let _ = std::fs::remove_file(dest);
                unsafe { encode(p, dest, mix.as_ref(), false, &mut sub) }
            }
        }
    }

    unsafe fn encode(
        p: &Project,
        dest: &Path,
        mix: Option<&Mix>,
        hardware: bool,
        progress: &mut dyn FnMut(f32),
    ) -> RResult<u32> {
        let (w, h) = (p.width as usize, p.height as usize);
        let duration = p.duration();
        let has_audio = mix.is_some();
        let plan = super::super::shrink::quality_plan(p.width, p.height, p.fps, has_audio);
        let audio_bps = if has_audio { plan.audio_bps } else { 0 };
        let video_bps = match p.target_mb {
            Some(mb) if mb > 0.0 => {
                let budget = mb * 1_000_000.0 * 8.0 * 0.9 / duration.max(0.1) - audio_bps as f64;
                if budget < 150_000.0 {
                    return Err(RecorderError::Other(format!(
                        "{mb:.0} MB is too small for {duration:.0} s. Make it shorter or pick a bigger size."
                    )));
                }
                (budget as u32).min(plan.video_bps)
            }
            _ => plan.video_bps,
        };

        let wa = attrs(3)?;
        wa.SetGUID(&MF_TRANSCODE_CONTAINERTYPE, &MFTranscodeContainerType_MPEG4).map_err(err)?;
        let _ = wa.SetUINT32(&MF_SINK_WRITER_DISABLE_THROTTLING, 1);
        let _ = wa.SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, hardware as u32);
        let out = wide(dest);
        let writer = MFCreateSinkWriterFromURL(PCWSTR(out.as_ptr()), None, &wa).map_err(err)?;

        let h264 = MFCreateMediaType().map_err(err)?;
        h264.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(err)?;
        h264.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264).map_err(err)?;
        h264.SetUINT32(&MF_MT_AVG_BITRATE, video_bps).map_err(err)?;
        h264.SetUINT64(&MF_MT_FRAME_SIZE, pack(p.width, p.height)).map_err(err)?;
        h264.SetUINT64(&MF_MT_FRAME_RATE, pack(p.fps, 1)).map_err(err)?;
        h264.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1)).map_err(err)?;
        h264.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32).map_err(err)?;
        let _ = h264.SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_Main.0 as u32);
        let v_out = writer.AddStream(&h264).map_err(err)?;

        let vin = MFCreateMediaType().map_err(err)?;
        vin.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(err)?;
        vin.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12).map_err(err)?;
        vin.SetUINT64(&MF_MT_FRAME_SIZE, pack(p.width, p.height)).map_err(err)?;
        vin.SetUINT32(&MF_MT_DEFAULT_STRIDE, p.width).map_err(err)?;
        vin.SetUINT32(&MF_MT_ALL_SAMPLES_INDEPENDENT, 1).map_err(err)?;
        vin.SetUINT64(&MF_MT_FRAME_RATE, pack(p.fps, 1)).map_err(err)?;
        vin.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32).map_err(err)?;
        vin.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1)).map_err(err)?;
        writer.SetInputMediaType(v_out, &vin, None).map_err(err)?;

        let a_out = if has_audio {
            let s = writer.AddStream(&aac_type(audio_bps)?).map_err(err)?;
            writer.SetInputMediaType(s, &pcm_type()?, None).map_err(err)?;
            Some(s)
        } else {
            None
        };
        writer.BeginWriting().map_err(err)?;

        // Overlays, converted once.
        let mut layers = Vec::new();
        for o in &p.overlays {
            let img = decode_png(&o.png)?;
            let x = (o.x as f64 * w as f64).round() as i64;
            let y = (o.y as f64 * h as f64).round() as i64;
            if let Some(l) = Layer::from_rgba(&img, x, y, o.opacity, w, h) {
                layers.push((o.start, o.start + o.duration, l));
            }
        }

        let frame_hns = HNS_PER_SECOND / p.fps as i64;
        let total_frames = (duration * p.fps as f64).round().max(1.0) as i64;
        let order = p.draw_order();
        let threads = draw_threads();
        let mut sources: Vec<Option<Source>> = p.video.iter().map(|_| None).collect();
        let mut frame = black_frame(w, h);
        let mut scratch: Vec<f32> = Vec::new();
        let mut audio_sent = 0usize;
        let chunk = (MIX_RATE / 2) as usize;
        let mut last_pct = -1i64;

        for k in 0..total_frames {
            let t = k as f64 / p.fps as f64;
            // Decoders exist only while their piece is on screen.
            for (i, v) in p.video.iter().enumerate() {
                if !v.active(t) {
                    sources[i] = None;
                } else if sources[i].is_none() {
                    sources[i] = Some(open_source(v, p.width, p.height)?);
                }
            }
            let active: Vec<usize> = order.iter().copied().filter(|&i| sources[i].is_some()).collect();
            for &i in &active {
                if let Some(Source::Video { clip, .. }) = &mut sources[i] {
                    let v = &p.video[i];
                    clip.advance(((v.src_in + (t - v.start)) * HNS_PER_SECOND as f64) as i64)?;
                }
            }

            frame[..w * h].fill(16);
            frame[w * h..].fill(128);
            // Fast path: a bottom clip shown whole is decoded at its fitted
            // size and copied in; only what lies above it is sampled.
            let mut above = &active[..];
            if let Some((&i, rest)) = active.split_first() {
                if let Some(Source::Video { clip, plain: true, .. }) = &sources[i] {
                    if let Some(pic) = clip.picture() {
                        place(&mut frame, w, h, pic, clip.fw, clip.fh);
                    }
                    above = rest;
                }
            }
            if !above.is_empty() {
                let draws: Vec<Draw> = above
                    .iter()
                    .filter_map(|&i| match sources[i].as_ref()? {
                        Source::Video { clip, pl, .. } => Draw::new(clip.src(clip.picture()?), pl, w, h),
                        Source::Still { planes, pl } => Draw::new(planes.src(), pl, w, h),
                        Source::Nothing => None,
                    })
                    .collect();
                composite(&mut frame, w, h, &draws, threads);
            }
            for r in &p.regions {
                if t < r.start || t >= r.start + r.duration {
                    continue;
                }
                let Some(bx) = region_box(r.x, r.y, r.w, r.h, w, h) else { continue };
                match r.kind {
                    RegionKind::Pixelate => compose_px::pixelate(&mut frame, w, h, bx, r.strength),
                    RegionKind::Blur => compose_px::blur(&mut frame, w, h, bx, r.strength, &mut scratch),
                }
            }
            for (s, e, l) in &layers {
                if t >= *s && t < *e {
                    l.blend(&mut frame, w, h);
                }
            }

            let buf = MFCreateMemoryBuffer(frame.len() as u32).map_err(err)?;
            let mut dst: *mut u8 = std::ptr::null_mut();
            buf.Lock(&mut dst, None, None).map_err(err)?;
            std::ptr::copy_nonoverlapping(frame.as_ptr(), dst, frame.len());
            let _ = buf.Unlock();
            buf.SetCurrentLength(frame.len() as u32).map_err(err)?;
            let sample = MFCreateSample().map_err(err)?;
            sample.AddBuffer(&buf).map_err(err)?;
            sample.SetSampleTime(k * frame_hns).map_err(err)?;
            sample.SetSampleDuration(frame_hns).map_err(err)?;
            writer.WriteSample(v_out, &sample).map_err(err)?;

            // Keep the sound about half a second ahead of the picture.
            if let (Some(a), Some(m)) = (a_out, mix) {
                let want = (((t + 0.5) * MIX_RATE as f64) as usize).min(m.frames());
                while audio_sent < want {
                    let to = (audio_sent + chunk).min(m.frames());
                    write_audio(&writer, a, m, audio_sent, to)?;
                    audio_sent = to;
                }
            }
            let pct = k * 100 / total_frames;
            if pct != last_pct {
                last_pct = pct;
                progress(pct as f32 / 100.0);
            }
        }
        if let (Some(a), Some(m)) = (a_out, mix) {
            while audio_sent < m.frames() {
                let to = (audio_sent + chunk).min(m.frames());
                write_audio(&writer, a, m, audio_sent, to)?;
                audio_sent = to;
            }
        }
        drop(sources);
        writer.Finalize().map_err(err)?;
        Ok(video_bps)
    }

    unsafe fn write_audio(writer: &IMFSinkWriter, stream: u32, m: &Mix, from: usize, to: usize) -> RResult<()> {
        let bytes = m.pcm16(from, to);
        if bytes.is_empty() {
            return Ok(());
        }
        let buf = MFCreateMemoryBuffer(bytes.len() as u32).map_err(err)?;
        let mut dst: *mut u8 = std::ptr::null_mut();
        buf.Lock(&mut dst, None, None).map_err(err)?;
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), dst, bytes.len());
        let _ = buf.Unlock();
        buf.SetCurrentLength(bytes.len() as u32).map_err(err)?;
        let s = MFCreateSample().map_err(err)?;
        s.AddBuffer(&buf).map_err(err)?;
        s.SetSampleTime(from as i64 * HNS_PER_SECOND / MIX_RATE as i64).map_err(err)?;
        s.SetSampleDuration((to - from) as i64 * HNS_PER_SECOND / MIX_RATE as i64).map_err(err)?;
        writer.WriteSample(stream, &s).map_err(err)?;
        Ok(())
    }
}

#[cfg(any(not(windows), feature = "headless-sim"))]
mod imp {
    use super::*;
    fn no<T>() -> RResult<T> {
        Err(RecorderError::Other("requires Windows".into()))
    }
    pub(super) fn render(_p: &Project, _dest: &Path, _progress: &mut dyn FnMut(f32)) -> RResult<u32> {
        no()
    }
    pub(super) fn media_info(_path: &Path) -> RResult<MediaInfo> {
        no()
    }
    pub(super) fn audio_peaks(_path: &Path) -> RResult<(f64, Vec<u8>)> {
        no()
    }
    pub(super) fn video_thumbs(_path: &Path, _times: &[f64], _height: u32) -> RResult<Vec<String>> {
        no()
    }
    pub(super) fn mp3_available() -> bool {
        false
    }
    pub(super) fn export_audio(
        _items: &[AudioItem],
        _duration: f64,
        _dest: &Path,
        _ext: &str,
        _progress: &mut dyn FnMut(f32),
    ) -> RResult<()> {
        no()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(volume: f32, duration: f64, fade_in: f64, fade_out: f64) -> AudioItem {
        AudioItem {
            path: PathBuf::new(),
            start: 0.0,
            duration,
            src_in: 0.0,
            volume,
            fade_in,
            fade_out,
            pan: 0.0,
            eq: [0.0; 3],
            gate: None,
        }
    }

    #[test]
    fn fades_ramp_volume() {
        let a = item(0.5, 10.0, 2.0, 4.0);
        assert_eq!(gain(&a, 0.0), 0.0);
        assert!((gain(&a, 1.0) - 0.25).abs() < 1e-6);
        assert!((gain(&a, 5.0) - 0.5).abs() < 1e-6);
        assert!((gain(&a, 8.0) - 0.25).abs() < 1e-6);
    }

    #[test]
    fn resampler_keeps_length() {
        let mut r = Resampler::new(44_100);
        let input = vec![[0.5f32, -0.5]; 44_100];
        let mut n = 0;
        for c in input.chunks(1000) {
            n += r.push(c).len();
        }
        assert!((n as i64 - 48_000).abs() < 4, "{n}");
        let mut same = Resampler::new(48_000);
        assert_eq!(same.push(&[[1.0, 1.0]; 10]).len(), 9);
    }

    #[test]
    fn mix_adds_at_the_right_place() {
        let mut m = Mix::new(2.0);
        let a = item(1.0, 1.0, 0.0, 0.0);
        let mut at = a.clone();
        at.start = 1.0;
        m.add(at.start, &at, 0.0, &[[0.25, 0.5]; 10]);
        let i = MIX_RATE as usize * 2;
        assert_eq!(m.samples[i], 0.25);
        assert_eq!(m.samples[i + 1], 0.5);
        assert_eq!(m.samples[i - 2], 0.0);
        let pcm = m.pcm16(MIX_RATE as usize, MIX_RATE as usize + 1);
        assert_eq!(i16::from_le_bytes([pcm[0], pcm[1]]), (0.25 * 32767.0) as i16);
    }

    #[test]
    fn stereo_from_mono_and_stereo() {
        let mono = [16384i16.to_le_bytes(), (-16384i16).to_le_bytes()].concat();
        assert_eq!(to_stereo(&mono, 1), vec![[0.5, 0.5], [-0.5, -0.5]]);
        let st = [16384i16.to_le_bytes(), 0i16.to_le_bytes()].concat();
        assert_eq!(to_stereo(&st, 2), vec![[0.5, 0.0]]);
    }

    #[test]
    fn fit_keeps_shape_and_even() {
        assert_eq!(fit(1920, 1080, 1080, 1920), (1080, 608));
        assert_eq!(fit(1080, 1920, 1920, 1080), (608, 1080));
        assert_eq!(fit(1920, 1080, 1280, 720), (1280, 720));
    }

    #[test]
    fn opaque_white_layer_turns_frame_white() {
        let img = image::RgbaImage::from_pixel(4, 4, image::Rgba([255, 255, 255, 255]));
        let mut f = black_frame(8, 8);
        Layer::from_rgba(&img, 2, 2, 1.0, 8, 8).unwrap().blend(&mut f, 8, 8);
        assert_eq!(f[2 * 8 + 2], 235);
        assert_eq!(f[0], 16);
        // Chroma of white stays neutral.
        assert_eq!(f[64 + 8 + 2], 128);
        // Half-transparent: halfway.
        let mut g = black_frame(8, 8);
        Layer::from_rgba(&img, 0, 0, 0.5, 8, 8).unwrap().blend(&mut g, 8, 8);
        assert!((124..=127).contains(&g[0]), "{}", g[0]);
    }

    #[test]
    fn layer_is_clipped_to_the_frame() {
        let img = image::RgbaImage::from_pixel(10, 10, image::Rgba([0, 0, 0, 255]));
        let l = Layer::from_rgba(&img, -4, 6, 1.0, 8, 8).unwrap();
        assert_eq!((l.x, l.y, l.w, l.h), (0, 6, 6, 2));
        assert!(Layer::from_rgba(&img, 9, 0, 1.0, 8, 8).is_none());
    }

    #[test]
    fn project_duration_and_checks() {
        let mut p: Project = serde_json::from_str(
            r#"{"width":1281,"height":720,"fps":500,
                "video":[{"path":"a.mp4","start":2,"duration":3,"srcIn":0,"z":0}],
                "overlays":[],"regions":[],
                "audio":[{"path":"a.mp4","start":0,"duration":9,"srcIn":0,"volume":1,"fadeIn":0,"fadeOut":0,"pan":0,"eq":[0,0,0],"gate":null}],
                "targetMb":null}"#,
        )
        .unwrap();
        p.validate().unwrap();
        assert_eq!((p.width, p.fps), (1280, 120));
        // The sound runs past the picture: the tail is black.
        assert_eq!(p.duration(), 9.0);
        p.audio.clear();
        assert_eq!(p.duration(), 5.0);
        p.video.clear();
        assert!(p.validate().is_err());
    }

    #[test]
    fn render_job_json_uses_camel_case() {
        let p: Project = serde_json::from_str(
            r#"{"width":1920,"height":1080,"fps":60,
                "video":[
                  {"path":"a.mp4","start":0,"duration":5,"srcIn":1.5,"z":1,"crop":{"x":0.1,"y":0,"w":0.5,"h":1},
                   "flipH":true,"flipV":false,"rot90":270,"scale":0.5,"cx":0.25,"cy":0.75,"fill":true},
                  {"png":"data:image/png;base64,AAAA","start":0,"duration":5,"srcIn":0,"z":0,"scale":1,"cx":0.5,"cy":0.5},
                  {"path":"b.mp4","start":5,"duration":1,"srcIn":0,"z":0,"crop":null}],
                "overlays":[{"png":"data:,","start":0,"duration":1,"x":0.1,"y":0.2,"opacity":0.5}],
                "regions":[{"kind":"blur","start":0,"duration":2,"x":0.1,"y":0.1,"w":0.2,"h":0.2,"strength":12},
                           {"kind":"pixelate","start":1,"duration":2,"x":0,"y":0,"w":1,"h":1,"strength":16}],
                "audio":[{"path":"m.mp3","start":0,"duration":5,"srcIn":0,"volume":2,"fadeIn":1,"fadeOut":1,
                          "pan":-0.5,"eq":[3,-2,1],"gate":-45}],
                "targetMb":9.5}"#,
        )
        .unwrap();
        let v = &p.video[0];
        assert_eq!((v.z, v.src_in, v.flip_h, v.fill), (1, 1.5, true, true));
        let pose = v.pose();
        assert_eq!(pose.rot90, 270);
        assert_eq!(pose.crop.unwrap().w, 0.5);
        assert_eq!((pose.scale, pose.cx, pose.cy), (0.5, 0.25, 0.75));
        let still = p.video[1].pose();
        assert!(still.is_plain());
        assert!(p.video[2].pose().is_plain());
        assert_eq!(p.draw_order(), vec![1, 2, 0]);
        assert_eq!(p.regions[0].kind, RegionKind::Blur);
        assert_eq!(p.regions[1].kind, RegionKind::Pixelate);
        let a = &p.audio[0];
        assert_eq!((a.pan, a.eq, a.gate), (-0.5, [3.0, -2.0, 1.0], Some(-45.0)));
        assert_eq!(p.target_mb, Some(9.5));
        // Old jobs (no new keys) still parse with defaults.
        let old: Project = serde_json::from_str(
            r#"{"width":1280,"height":720,"fps":30,"video":[{"path":"a.mp4","start":0,"duration":2}],
                "audio":[{"path":"a.mp4","start":0,"duration":2}]}"#,
        )
        .unwrap();
        assert!(old.video[0].pose().is_plain());
        assert!(old.regions.is_empty());
        assert_eq!((old.audio[0].volume, old.audio[0].pan, old.audio[0].gate), (1.0, 0.0, None));
    }

    #[test]
    fn wav_file_round_trip() {
        let mut m = Mix::new(0.5);
        m.samples[0] = 0.5;
        m.samples[1] = -0.5;
        let dir = std::env::temp_dir().join(format!("lastshot-wav-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("t.wav");
        write_wav(&m, &f).unwrap();
        let bytes = std::fs::read(&f).unwrap();
        assert_eq!(bytes.len(), 44 + 24_000 * 4);
        assert_eq!(i16::from_le_bytes([bytes[44], bytes[45]]), 16383);
        assert_eq!(i16::from_le_bytes([bytes[46], bytes[47]]), -16383);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
