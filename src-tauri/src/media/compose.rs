//! Timeline render for the Editor panel: a main video track (clips and
//! still images, back to back), overlays on top (images and text, which the
//! window rasterises to PNG), and any number of audio pieces (clip sound,
//! music, voice-overs) mixed together. Uses only Media Foundation for
//! decoding and encoding, like `shrink`, so the app stays small.
//!
//! Frames are produced at a constant rate: for each output frame the main
//! track's frame at that moment is placed (letterboxed) on a black canvas,
//! overlays are blended on top, and the frame goes to the H.264 encoder.
//! Audio is mixed first into 48 kHz stereo and written alongside.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

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
    /// Main track, in time order, not overlapping.
    pub video: Vec<VideoItem>,
    #[serde(default)]
    pub overlays: Vec<Overlay>,
    /// Every sound: clip sound of main-track clips and separate audio.
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
    /// Still image: PNG data URL, already `width x height`.
    #[serde(default)]
    pub png: Option<String>,
    /// Where it sits on the timeline, seconds.
    pub start: f64,
    pub duration: f64,
    /// Where in the source file it starts, seconds.
    #[serde(default)]
    pub src_in: f64,
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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioItem {
    pub path: PathBuf,
    pub start: f64,
    pub duration: f64,
    #[serde(default)]
    pub src_in: f64,
    #[serde(default = "one")]
    pub volume: f32,
    #[serde(default)]
    pub fade_in: f64,
    #[serde(default)]
    pub fade_out: f64,
}

fn one() -> f32 {
    1.0
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
}

impl Project {
    /// Length of the result: the end of the main track (or of anything, when
    /// the main track is empty).
    pub fn duration(&self) -> f64 {
        let main = self.video.iter().map(|v| v.start + v.duration).fold(0.0, f64::max);
        if main > 0.0 {
            return main;
        }
        let o = self.overlays.iter().map(|v| v.start + v.duration).fold(0.0, f64::max);
        let a = self.audio.iter().map(|v| v.start + v.duration).fold(0.0, f64::max);
        o.max(a)
    }

    /// Checks sizes and lengths, and puts the main track in time order.
    pub fn validate(&mut self) -> RResult<()> {
        let bad = |m: &str| Err(RecorderError::Other(m.to_string()));
        if self.width < 16 || self.height < 16 || self.width > 7680 || self.height > 4320 {
            return bad("The output size is not valid.");
        }
        self.width &= !1;
        self.height &= !1;
        self.fps = self.fps.clamp(1, 120);
        self.video.retain(|v| v.duration > 0.01);
        self.overlays.retain(|v| v.duration > 0.01);
        self.audio.retain(|v| v.duration > 0.01);
        self.video.sort_by(|a, b| a.start.total_cmp(&b.start));
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
fn yuv(r: f32, g: f32, b: f32) -> (f32, f32, f32) {
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
    imp::render(&p, dest, progress)?;
    progress(1.0);
    Ok(RenderResult {
        path: dest.to_string_lossy().to_string(),
        size_bytes: std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0),
        duration_seconds: p.duration(),
        width: p.width,
        height: p.height,
        fps: p.fps,
        elapsed_ms: t0.elapsed().as_secs_f64() * 1000.0,
    })
}

pub fn media_info(path: &Path) -> RResult<MediaInfo> {
    imp::media_info(path)
}

// ===========================================================================
//                        WINDOWS IMPLEMENTATION
// ===========================================================================

#[cfg(all(windows, not(feature = "headless-sim")))]
mod imp {
    use super::*;
    use windows::core::PCWSTR;
    use windows::Win32::Media::MediaFoundation::*;
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

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

    pub(super) fn media_info(path: &Path) -> RResult<MediaInfo> {
        let _mf = Mf::enter()?;
        unsafe {
            let r = reader(path, false)?;
            let video = stream_of(&r, MFMediaType_Video);
            let audio = stream_of(&r, MFMediaType_Audio);
            if video.is_none() && audio.is_none() {
                return Err(RecorderError::Other("This file has no picture or sound Lastshot can read.".into()));
            }
            let dur = r
                .GetPresentationAttribute(MF_SOURCE_READER_MEDIASOURCE.0 as u32, &MF_PD_DURATION)
                .ok()
                .and_then(|v| windows::Win32::System::Com::StructuredStorage::PropVariantToInt64(&v).ok())
                .unwrap_or(0) as f64
                / HNS_PER_SECOND as f64;
            let (mut w, mut h) = (0, 0);
            if let Some(v) = video {
                if let Ok(t) = r.GetNativeMediaType(v, 0) {
                    if let Ok(s) = t.GetUINT64(&MF_MT_FRAME_SIZE) {
                        w = (s >> 32) as u32;
                        h = (s & 0xffff_ffff) as u32;
                    }
                }
            }
            Ok(MediaInfo {
                kind: if video.is_some() { "video" } else { "audio" }.into(),
                duration: dur,
                width: w,
                height: h,
                has_audio: audio.is_some(),
            })
        }
    }

    /// Decodes one audio piece into the mix.
    unsafe fn mix_in(mix: &mut Mix, item: &AudioItem) -> RResult<()> {
        let r = reader(&item.path, false)?;
        let Some(idx) = stream_of(&r, MFMediaType_Audio) else { return Ok(()) };
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
        seek(&r, item.src_in)?;
        let start_hns = (item.src_in * HNS_PER_SECOND as f64) as i64;
        let end_hns = ((item.src_in + item.duration) * HNS_PER_SECOND as f64) as i64;
        let mut rs = Resampler::new(rate);
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
            let buf = sample.ConvertToContiguousBuffer().map_err(err)?;
            let mut ptr: *mut u8 = std::ptr::null_mut();
            let mut len = 0u32;
            buf.Lock(&mut ptr, None, Some(&mut len)).map_err(err)?;
            let mut bytes = std::slice::from_raw_parts(ptr, len as usize).to_vec();
            let _ = buf.Unlock();
            // Drop what lies before the in-point (seeking lands on a packet edge).
            if !started {
                started = true;
                if ts < start_hns {
                    let skip = ((start_hns - ts) as f64 / HNS_PER_SECOND as f64 * rate as f64) as usize * ch * 2;
                    bytes.drain(..skip.min(bytes.len()));
                }
            }
            let out = rs.push(&to_stereo(&bytes, ch));
            let at = written as f64 / MIX_RATE as f64;
            let keep = ((item.duration - at) * MIX_RATE as f64).max(0.0) as usize;
            let out = &out[..out.len().min(keep)];
            mix.add(item.start, item, at, out);
            written += out.len();
            if written as f64 >= item.duration * MIX_RATE as f64 {
                break;
            }
        }
        Ok(())
    }

    /// The decoder of the main-track clip being drawn.
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

    unsafe fn open_clip(path: &Path, src_in: f64, w: u32, h: u32) -> RResult<Clip> {
        let info = super::super::library::probe(path)?;
        let (fw, fh) = fit(info.width, info.height, w, h);
        let r = reader(path, true)?;
        let stream = stream_of(&r, MFMediaType_Video)
            .ok_or_else(|| RecorderError::Other(format!("{} has no picture", path.display())))?;
        r.SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS.0 as u32, false).map_err(err)?;
        r.SetStreamSelection(stream, true).map_err(err)?;
        let nv12 = MFCreateMediaType().map_err(err)?;
        nv12.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(err)?;
        nv12.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12).map_err(err)?;
        nv12.SetUINT64(&MF_MT_FRAME_SIZE, pack(fw, fh)).map_err(err)?;
        r.SetCurrentMediaType(stream, None, &nv12).map_err(err)?;
        seek(&r, src_in)?;
        Ok(Clip { reader: r, stream, fw: fw as usize, fh: fh as usize, next: None, current: None, ended: false })
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
        /// The frame to show at source time `src_hns`.
        unsafe fn frame_at(&mut self, src_hns: i64) -> RResult<Option<&Vec<u8>>> {
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
            Ok(self.current.as_ref())
        }
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

    pub(super) fn render(p: &Project, dest: &Path, progress: &mut dyn FnMut(f32)) -> RResult<()> {
        let _mf = Mf::enter()?;
        // Sound first: every piece mixed into one track.
        let duration = p.duration();
        let mut mix = None;
        if !p.audio.is_empty() {
            let mut m = Mix::new(duration);
            for (i, a) in p.audio.iter().enumerate() {
                unsafe { mix_in(&mut m, a) }.map_err(|e| {
                    RecorderError::Other(format!("Sound of {}: {e}", a.path.display()))
                })?;
                progress(0.1 * (i + 1) as f32 / p.audio.len() as f32);
            }
            mix = Some(m);
        }
        let mut sub = |x: f32| progress(0.1 + x * 0.9);
        let r = unsafe { encode(p, dest, mix.as_ref(), true, &mut sub) };
        match r {
            Ok(()) => Ok(()),
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
    ) -> RResult<()> {
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
            let aac = MFCreateMediaType().map_err(err)?;
            aac.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio).map_err(err)?;
            aac.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_AAC).map_err(err)?;
            aac.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16).map_err(err)?;
            aac.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, MIX_RATE).map_err(err)?;
            aac.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, 2).map_err(err)?;
            aac.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, audio_bps / 8).map_err(err)?;
            let s = writer.AddStream(&aac).map_err(err)?;
            let pcm = MFCreateMediaType().map_err(err)?;
            pcm.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio).map_err(err)?;
            pcm.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_PCM).map_err(err)?;
            pcm.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16).map_err(err)?;
            pcm.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, MIX_RATE).map_err(err)?;
            pcm.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, 2).map_err(err)?;
            pcm.SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, 4).map_err(err)?;
            pcm.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, MIX_RATE * 4).map_err(err)?;
            writer.SetInputMediaType(s, &pcm, None).map_err(err)?;
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
        let mut item_idx = 0usize;
        let mut clip: Option<(usize, Clip)> = None;
        let mut still: Option<(usize, Vec<u8>)> = None;
        let mut audio_sent = 0usize;
        let chunk = (MIX_RATE / 2) as usize;
        let mut last_pct = -1i64;

        for k in 0..total_frames {
            let t = k as f64 / p.fps as f64;
            let mut frame = black_frame(w, h);
            while item_idx < p.video.len() && t >= p.video[item_idx].start + p.video[item_idx].duration {
                item_idx += 1;
            }
            if let Some(item) = p.video.get(item_idx).filter(|v| t >= v.start) {
                if let Some(path) = &item.path {
                    if clip.as_ref().map(|c| c.0) != Some(item_idx) {
                        clip = Some((item_idx, open_clip(path, item.src_in, p.width, p.height)?));
                    }
                    let (_, c) = clip.as_mut().unwrap();
                    let src = ((item.src_in + (t - item.start)) * HNS_PER_SECOND as f64) as i64;
                    let (fw, fh) = (c.fw, c.fh);
                    if let Some(pic) = c.frame_at(src)? {
                        place(&mut frame, w, h, pic, fw, fh);
                    }
                } else if let Some(png) = &item.png {
                    if still.as_ref().map(|s| s.0) != Some(item_idx) {
                        let img = decode_png(png)?;
                        let (fw, fh) = fit(img.width(), img.height(), p.width, p.height);
                        let img = if (fw, fh) != (img.width(), img.height()) {
                            image::imageops::resize(&img, fw, fh, image::imageops::FilterType::Triangle)
                        } else {
                            img
                        };
                        let mut f = black_frame(w, h);
                        place(&mut f, w, h, &rgba_to_nv12(&img, fw as usize, fh as usize), fw as usize, fh as usize);
                        still = Some((item_idx, f));
                    }
                    frame.copy_from_slice(&still.as_ref().unwrap().1);
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
        drop(clip);
        writer.Finalize().map_err(err)?;
        Ok(())
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
    pub(super) fn render(_p: &Project, _dest: &Path, _progress: &mut dyn FnMut(f32)) -> RResult<()> {
        Err(RecorderError::Other("rendering requires Windows".into()))
    }
    pub(super) fn media_info(_path: &Path) -> RResult<MediaInfo> {
        Err(RecorderError::Other("requires Windows".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(volume: f32, duration: f64, fade_in: f64, fade_out: f64) -> AudioItem {
        AudioItem { path: PathBuf::new(), start: 0.0, duration, src_in: 0.0, volume, fade_in, fade_out }
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
        let mut p = Project {
            width: 1281,
            height: 720,
            fps: 500,
            video: vec![VideoItem { path: Some(PathBuf::from("a.mp4")), png: None, start: 2.0, duration: 3.0, src_in: 0.0 }],
            overlays: vec![],
            audio: vec![item(1.0, 9.0, 0.0, 0.0)],
            target_mb: None,
        };
        p.validate().unwrap();
        assert_eq!((p.width, p.fps), (1280, 120));
        assert_eq!(p.duration(), 5.0);
        p.video.clear();
        assert_eq!(p.duration(), 9.0);
    }
}
