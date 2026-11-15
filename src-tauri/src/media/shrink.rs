//! "Shrink to fit": re-encodes a clip so the file stays under a size limit
//! (Discord's free upload cap by default), using only Windows' built-in Media
//! Foundation. No ffmpeg, so the app stays small.
//!
//! The bitrate is derived from the size budget and the clip length. Resolution
//! and frame rate step down when the budget is tight, because a sharp 480p30
//! clip looks better than a blocky 1080p60 one at the same size. If the
//! encoder still overshoots, the export is retried at a lower bitrate.
//!
//! The same engine powers the clip editor: `export` joins any number of
//! segments (cut-outs of one clip, or several clips), optionally crops the
//! picture, and targets either a size limit or high quality.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::recorder::{RecorderError, RResult, HNS_PER_SECOND};

/// AAC in Media Foundation only takes a few fixed bitrates; 96 kbit/s is the
/// smallest and is plenty for game audio.
pub const AUDIO_BPS: u32 = 96_000;
/// AAC bitrate for full-quality exports.
pub const QUALITY_AUDIO_BPS: u32 = 160_000;
/// Share of the size budget the encoder aims for; the rest absorbs MP4
/// overhead and rate-control overshoot.
const BUDGET_FILL: f64 = 0.90;
/// Below this the picture is unwatchable at any resolution.
const MIN_VIDEO_BPS: u32 = 120_000;
/// Bits per pixel per frame that still looks clean for game footage in H.264.
const MIN_BPP: f64 = 0.04;
const MAX_ATTEMPTS: u32 = 3;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShrinkResult {
    pub path: String,
    pub file_name: String,
    pub size_bytes: u64,
    pub duration_seconds: f32,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub video_kbps: u32,
    pub elapsed_ms: f32,
    pub attempts: u32,
}

/// What the encoder will be asked to do.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ShrinkPlan {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub video_bps: u32,
    pub audio_bps: u32,
}

/// Picks bitrate, resolution and frame rate for a size budget.
///
/// Errors when the clip is too long for the budget even at the lowest
/// usable quality, and says how long a clip would fit.
pub fn plan(
    src_w: u32,
    src_h: u32,
    src_fps: u32,
    duration_s: f64,
    target_bytes: u64,
    has_audio: bool,
) -> RResult<ShrinkPlan> {
    let duration_s = duration_s.max(0.1);
    let audio_bps = if has_audio { AUDIO_BPS } else { 0 };
    let total_bps = target_bytes as f64 * 8.0 * BUDGET_FILL / duration_s;
    let video_bps = total_bps - audio_bps as f64;
    if video_bps < MIN_VIDEO_BPS as f64 {
        let fits = target_bytes as f64 * 8.0 * BUDGET_FILL / (MIN_VIDEO_BPS + audio_bps) as f64;
        return Err(RecorderError::Other(format!(
            "This clip is too long for {:.0} MB. Trim it to about {:.0} s or less first, or raise the size limit in Settings.",
            target_bytes as f64 / 1_000_000.0,
            fits.floor()
        )));
    }
    let video_bps = video_bps as u32;

    let src_fps = src_fps.clamp(1, 240);
    // Under ~2.5 Mbit/s, spending bits on 60 fps makes every frame worse.
    let fps = if video_bps < 2_500_000 && src_fps > 30 { 30 } else { src_fps.min(60) };

    let src_h = src_h.max(2);
    let src_w = src_w.max(2);
    let mut height = src_h;
    for h in [src_h.min(1080), 720, 540, 480, 360, 240] {
        if h > src_h {
            continue;
        }
        height = h;
        let w = scaled_width(src_w, src_h, h);
        let bpp = video_bps as f64 / (w as f64 * h as f64 * fps as f64);
        if bpp >= MIN_BPP {
            break;
        }
    }
    let width = scaled_width(src_w, src_h, height);
    Ok(ShrinkPlan {
        width,
        height: height & !1,
        fps,
        video_bps,
        audio_bps,
    })
}

fn scaled_width(src_w: u32, src_h: u32, h: u32) -> u32 {
    let w = (src_w as f64 * h as f64 / src_h as f64).round() as u32;
    (w.max(2)) & !1
}

/// `<stem>_10MB.mp4` (or `_10MB2.mp4`, ...) in `dir`.
pub fn output_path(dir: &Path, source: &Path, target_bytes: u64) -> PathBuf {
    let stem = source
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "clip".into());
    let mb = (target_bytes as f64 / 1_000_000.0).round().max(1.0) as u64;
    let mut candidate = dir.join(format!("{stem}_{mb}MB.mp4"));
    let mut n = 2;
    while candidate.exists() {
        candidate = dir.join(format!("{stem}_{mb}MB{n}.mp4"));
        n += 1;
    }
    candidate
}

/// One piece of the output: `path[start..end]` (`end: None` = to the end).
/// Several pieces, from one clip or many, are joined in order.
#[derive(Debug, Clone, Deserialize)]
pub struct Segment {
    pub path: PathBuf,
    pub start: f32,
    pub end: Option<f32>,
}

/// Part of the picture to keep, as fractions (0-1) of the source frame.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct Crop {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl Crop {
    fn clamped(self) -> Crop {
        let w = self.w.clamp(0.05, 1.0);
        let h = self.h.clamp(0.05, 1.0);
        Crop {
            x: self.x.clamp(0.0, 1.0 - w),
            y: self.y.clamp(0.0, 1.0 - h),
            w,
            h,
        }
    }
    fn is_full(&self) -> bool {
        self.w >= 0.999 && self.h >= 0.999
    }
}

/// What the export aims for.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Target {
    /// Stay under this many bytes (sharing).
    Size(u64),
    /// Keep the source resolution and frame rate at a generous bitrate.
    Quality,
}

/// Frame geometry of an export: the decoder scales every source frame to
/// `read_w x read_h`, then the `plan.width x plan.height` window at
/// `(crop_x, crop_y)` is cut out (no cut when they are equal).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Layout {
    pub plan: ShrinkPlan,
    pub read_w: u32,
    pub read_h: u32,
    pub crop_x: u32,
    pub crop_y: u32,
}

impl Layout {
    pub fn crops(&self) -> bool {
        self.read_w != self.plan.width || self.read_h != self.plan.height
    }
}

/// A size: even and at least 2.
fn even(v: f64) -> u32 {
    ((v.round() as u32).max(2)) & !1
}

/// A position: even, may be 0.
fn offset(v: f64) -> u32 {
    (v.round().max(0.0) as u32) & !1
}

/// Bitrate plan for `Target::Quality`: source size and frame rate (60 max),
/// ~0.09 bits per pixel per frame, which is visually clean for game footage.
pub fn quality_plan(w: u32, h: u32, fps: u32, has_audio: bool) -> ShrinkPlan {
    let fps = fps.clamp(1, 60);
    let w = w.max(2) & !1;
    let h = h.max(2) & !1;
    let bps = (w as f64 * h as f64 * fps as f64 * 0.09).clamp(2_500_000.0, 40_000_000.0) as u32;
    ShrinkPlan {
        width: w,
        height: h,
        fps,
        video_bps: bps,
        audio_bps: if has_audio { QUALITY_AUDIO_BPS } else { 0 },
    }
}

/// Picks the output geometry and bitrate for a source frame, crop and target.
pub fn layout(
    src_w: u32,
    src_h: u32,
    src_fps: u32,
    duration_s: f64,
    crop: Option<Crop>,
    target: Target,
    has_audio: bool,
) -> RResult<Layout> {
    let crop = crop.map(Crop::clamped).filter(|c| !c.is_full());
    let (cw, ch) = match crop {
        Some(c) => (even(src_w as f64 * c.w as f64), even(src_h as f64 * c.h as f64)),
        None => (src_w.max(2) & !1, src_h.max(2) & !1),
    };
    let plan = match target {
        Target::Size(bytes) => plan(cw, ch, src_fps, duration_s, bytes, has_audio)?,
        Target::Quality => quality_plan(cw, ch, src_fps, has_audio),
    };
    Ok(match crop {
        None => Layout { plan, read_w: plan.width, read_h: plan.height, crop_x: 0, crop_y: 0 },
        Some(c) => {
            // Scale the whole frame so the crop window comes out at plan size.
            // Never larger than the source: rounding must not cause an upscale.
            let read_w = even(plan.width as f64 / c.w as f64).min(src_w & !1).max(plan.width);
            let read_h = even(plan.height as f64 / c.h as f64).min(src_h & !1).max(plan.height);
            let crop_x = offset(c.x as f64 * read_w as f64).min(read_w - plan.width) & !1;
            let crop_y = offset(c.y as f64 * read_h as f64).min(read_h - plan.height) & !1;
            Layout { plan, read_w, read_h, crop_x, crop_y }
        }
    })
}

/// Re-encodes `source[start..end]` into `dest` so it is at most
/// `target_bytes`. `progress` gets 0.0-1.0.
pub fn shrink_to_size(
    source: &Path,
    dest: &Path,
    target_bytes: u64,
    start: f32,
    end: Option<f32>,
    progress: &mut dyn FnMut(f32),
) -> RResult<ShrinkResult> {
    let seg = Segment { path: source.to_path_buf(), start, end };
    export(&[seg], None, Target::Size(target_bytes), dest, progress)
}

/// A segment checked against the real file.
pub(crate) struct Resolved {
    pub path: PathBuf,
    pub start: f32,
    pub end: f32,
}

/// Cuts, joins and crops clips into one new MP4.
///
/// The first segment decides the frame size and frame rate; other clips are
/// scaled to match. Audio is kept when every segment has some.
pub fn export(
    segments: &[Segment],
    crop: Option<Crop>,
    target: Target,
    dest: &Path,
    progress: &mut dyn FnMut(f32),
) -> RResult<ShrinkResult> {
    if segments.is_empty() {
        return Err(RecorderError::Other("nothing to export".into()));
    }
    let t0 = std::time::Instant::now();
    let mut resolved = Vec::with_capacity(segments.len());
    let mut first = None;
    let mut has_audio = true;
    for s in segments {
        if !s.path.exists() {
            return Err(RecorderError::Io(format!("clip not found: {}", s.path.display())));
        }
        let probe = super::library::probe(&s.path)?;
        let start = s.start.max(0.0).min((probe.duration_seconds - 0.1).max(0.0));
        let end = s
            .end
            .filter(|e| *e > start)
            .unwrap_or(probe.duration_seconds)
            .min(probe.duration_seconds.max(start + 0.1));
        if end - start < 0.05 {
            continue;
        }
        has_audio &= probe.has_audio;
        if first.is_none() {
            first = Some(probe);
        }
        resolved.push(Resolved { path: s.path.clone(), start, end });
    }
    let first = first.ok_or_else(|| RecorderError::Other("the selection is empty".into()))?;
    let duration: f64 = resolved.iter().map(|r| (r.end - r.start) as f64).sum::<f64>().max(0.1);
    let fps = first.fps.max(1);

    let mut lay = layout(first.width, first.height, fps, duration, crop, target, has_audio)?;
    let mut attempts = 0;
    loop {
        attempts += 1;
        let tries = if matches!(target, Target::Size(_)) { MAX_ATTEMPTS } else { 1 };
        let base = (attempts - 1) as f32 / tries as f32;
        let mut sub = |p: f32| progress((base + p / tries as f32).min(0.99));
        imp::encode(&resolved, dest, &lay, &mut sub)?;
        let size = std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0);
        let fits = match target {
            Target::Size(limit) => size <= limit,
            Target::Quality => true,
        };
        if fits {
            progress(1.0);
            return Ok(ShrinkResult {
                path: dest.to_string_lossy().to_string(),
                file_name: dest
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default(),
                size_bytes: size,
                duration_seconds: duration as f32,
                width: lay.plan.width,
                height: lay.plan.height,
                fps: lay.plan.fps,
                video_kbps: lay.plan.video_bps / 1000,
                elapsed_ms: t0.elapsed().as_secs_f32() * 1000.0,
                attempts,
            });
        }
        let Target::Size(limit) = target else { unreachable!() };
        // Overshot: scale the video bitrate by how far over we were, with a
        // little extra margin, and re-plan the resolution for it.
        let next_video = (lay.plan.video_bps as f64 * limit as f64 / size as f64 * 0.93) as u32;
        if attempts >= MAX_ATTEMPTS || next_video < MIN_VIDEO_BPS {
            let _ = std::fs::remove_file(dest);
            return Err(RecorderError::Other(format!(
                "Could not get this under {:.0} MB. Make it shorter and try again.",
                limit as f64 / 1_000_000.0
            )));
        }
        let budget =
            (next_video as u64 + lay.plan.audio_bps as u64) as f64 * duration / 8.0 / BUDGET_FILL;
        lay = layout(first.width, first.height, fps, duration, crop, Target::Size(budget as u64), has_audio)?;
    }
}

// ===========================================================================
//                        WINDOWS IMPLEMENTATION
// ===========================================================================

#[cfg(all(windows, not(feature = "headless-sim")))]
mod imp {
    use super::*;
    use windows::core::{Interface, PCWSTR};
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

    unsafe fn set_codec_u32(api: &ICodecAPI, key: &windows::core::GUID, value: u32) {
        let v = windows::core::VARIANT::from(value);
        let _ = api.SetValue(key, &v);
    }

    struct Streams {
        video: u32,
        audio: Option<u32>,
    }

    unsafe fn find_streams(reader: &IMFSourceReader) -> RResult<Streams> {
        let mut video = None;
        let mut audio = None;
        for i in 0..16 {
            let Ok(t) = reader.GetNativeMediaType(i, 0) else { continue };
            let Ok(major) = t.GetGUID(&MF_MT_MAJOR_TYPE) else { continue };
            if major == MFMediaType_Video && video.is_none() {
                video = Some(i);
            } else if major == MFMediaType_Audio && audio.is_none() {
                audio = Some(i);
            }
        }
        Ok(Streams {
            video: video.ok_or_else(|| RecorderError::Other("no video stream".into()))?,
            audio,
        })
    }

    /// One encode pass. Tries the GPU encoder first and falls back to
    /// Windows' software H.264 encoder if the hardware path will not set up.
    pub(super) fn encode(
        segs: &[Resolved],
        dest: &Path,
        lay: &Layout,
        progress: &mut dyn FnMut(f32),
    ) -> RResult<()> {
        let _mf = Mf::enter()?;
        match unsafe { encode_once(segs, dest, lay, true, progress) } {
            Ok(()) => Ok(()),
            Err(e) => {
                log::warn!("[lastshot] hardware export failed ({e}); retrying in software");
                let _ = std::fs::remove_file(dest);
                unsafe { encode_once(segs, dest, lay, false, progress) }
            }
        }
    }

    struct Source {
        reader: IMFSourceReader,
        video: u32,
        audio: Option<u32>,
        video_type: IMFMediaType,
        audio_type: Option<IMFMediaType>,
    }

    /// Opens one clip, decoding video to NV12 at the layout's read size and
    /// audio to 16-bit PCM (`pcm` forces rate and channels so every segment
    /// matches the first).
    unsafe fn open_source(
        path: &Path,
        lay: &Layout,
        hardware: bool,
        want_audio: bool,
        pcm: Option<(u32, u32)>,
    ) -> RResult<Source> {
        let ra = attrs(3)?;
        ra.SetUINT32(&MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING, 1)
            .map_err(err)?;
        if hardware {
            let _ = ra.SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1);
        }
        let src = wide(path);
        let reader = MFCreateSourceReaderFromURL(PCWSTR(src.as_ptr()), &ra).map_err(err)?;
        let streams = find_streams(&reader)?;
        reader
            .SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS.0 as u32, false)
            .map_err(err)?;
        reader.SetStreamSelection(streams.video, true).map_err(err)?;

        let nv12 = MFCreateMediaType().map_err(err)?;
        nv12.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(err)?;
        nv12.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12).map_err(err)?;
        nv12.SetUINT64(&MF_MT_FRAME_SIZE, pack(lay.read_w, lay.read_h))
            .map_err(err)?;
        reader
            .SetCurrentMediaType(streams.video, None, &nv12)
            .map_err(err)?;
        let video_type = reader.GetCurrentMediaType(streams.video).map_err(err)?;

        let audio = if want_audio { streams.audio } else { None };
        let audio_type = match audio {
            Some(idx) => {
                reader.SetStreamSelection(idx, true).map_err(err)?;
                let t = MFCreateMediaType().map_err(err)?;
                t.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio).map_err(err)?;
                t.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_PCM).map_err(err)?;
                t.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16).map_err(err)?;
                if let Some((rate, ch)) = pcm {
                    t.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, rate).map_err(err)?;
                    t.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, ch).map_err(err)?;
                    t.SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, ch * 2).map_err(err)?;
                    t.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, rate * ch * 2)
                        .map_err(err)?;
                }
                reader.SetCurrentMediaType(idx, None, &t).map_err(|e| {
                    RecorderError::Other(format!(
                        "These clips have different sound formats and cannot be joined ({})",
                        e.message()
                    ))
                })?;
                Some(reader.GetCurrentMediaType(idx).map_err(err)?)
            }
            None => None,
        };
        Ok(Source { reader, video: streams.video, audio, video_type, audio_type })
    }

    /// Copies the layout's crop window out of a decoded NV12 frame.
    unsafe fn crop_nv12(sample: &IMFSample, lay: &Layout) -> RResult<IMFSample> {
        let (sw, sh) = (lay.read_w as usize, lay.read_h as usize);
        let (ow, oh) = (lay.plan.width as usize, lay.plan.height as usize);
        let (cx, cy) = (lay.crop_x as usize, lay.crop_y as usize);

        let input = sample.ConvertToContiguousBuffer().map_err(err)?;
        let mut src: *mut u8 = std::ptr::null_mut();
        let mut len = 0u32;
        input.Lock(&mut src, None, Some(&mut len)).map_err(err)?;
        // Contiguous NV12 has a stride equal to the width; the Y plane may be
        // padded to more rows than the picture, so derive its real height.
        let rows_y = (len as usize * 2 / 3) / sw;
        if rows_y < sh || src.is_null() {
            let _ = input.Unlock();
            return Err(RecorderError::Other(format!(
                "unexpected frame buffer ({len} bytes for {sw}x{sh})"
            )));
        }
        let out_len = ow * oh * 3 / 2;
        let out = MFCreateMemoryBuffer(out_len as u32).map_err(err)?;
        let mut dst: *mut u8 = std::ptr::null_mut();
        if let Err(e) = out.Lock(&mut dst, None, None) {
            let _ = input.Unlock();
            return Err(err(e));
        }
        let s = std::slice::from_raw_parts(src, len as usize);
        let d = std::slice::from_raw_parts_mut(dst, out_len);
        for r in 0..oh {
            let from = (cy + r) * sw + cx;
            d[r * ow..r * ow + ow].copy_from_slice(&s[from..from + ow]);
        }
        let uv_src = rows_y * sw;
        let uv_dst = ow * oh;
        for r in 0..oh / 2 {
            let from = uv_src + (cy / 2 + r) * sw + cx;
            d[uv_dst + r * ow..uv_dst + r * ow + ow].copy_from_slice(&s[from..from + ow]);
        }
        let _ = out.Unlock();
        let _ = input.Unlock();
        out.SetCurrentLength(out_len as u32).map_err(err)?;
        let cropped = MFCreateSample().map_err(err)?;
        cropped.AddBuffer(&out).map_err(err)?;
        Ok(cropped)
    }

    unsafe fn encode_once(
        segs: &[Resolved],
        dest: &Path,
        lay: &Layout,
        hardware: bool,
        progress: &mut dyn FnMut(f32),
    ) -> RResult<()> {
        let plan = &lay.plan;
        let want_audio = plan.audio_bps > 0;
        let first = open_source(&segs[0].path, lay, hardware, want_audio, None)?;
        let pcm = first.audio_type.as_ref().map(|t| {
            (
                t.GetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND).unwrap_or(48_000),
                t.GetUINT32(&MF_MT_AUDIO_NUM_CHANNELS).unwrap_or(2),
            )
        });

        // ---- writer: H.264 + AAC in MP4 ----
        let wa = attrs(3)?;
        wa.SetGUID(&MF_TRANSCODE_CONTAINERTYPE, &MFTranscodeContainerType_MPEG4)
            .map_err(err)?;
        let _ = wa.SetUINT32(&MF_SINK_WRITER_DISABLE_THROTTLING, 1);
        let _ = wa.SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, hardware as u32);
        let out = wide(dest);
        let writer = MFCreateSinkWriterFromURL(PCWSTR(out.as_ptr()), None, &wa).map_err(err)?;

        let h264 = MFCreateMediaType().map_err(err)?;
        h264.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(err)?;
        h264.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264).map_err(err)?;
        h264.SetUINT32(&MF_MT_AVG_BITRATE, plan.video_bps).map_err(err)?;
        h264.SetUINT64(&MF_MT_FRAME_SIZE, pack(plan.width, plan.height))
            .map_err(err)?;
        h264.SetUINT64(&MF_MT_FRAME_RATE, pack(plan.fps, 1)).map_err(err)?;
        h264.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1)).map_err(err)?;
        h264.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)
            .map_err(err)?;
        let _ = h264.SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_Main.0 as u32);
        let v_out = writer.AddStream(&h264).map_err(err)?;

        // The encoder's input: the decoder's own type, or a plain NV12 type at
        // the crop size when frames are cut down first.
        let video_in = if lay.crops() {
            let t = MFCreateMediaType().map_err(err)?;
            t.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(err)?;
            t.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12).map_err(err)?;
            t.SetUINT64(&MF_MT_FRAME_SIZE, pack(plan.width, plan.height))
                .map_err(err)?;
            t.SetUINT32(&MF_MT_DEFAULT_STRIDE, plan.width).map_err(err)?;
            t.SetUINT32(&MF_MT_ALL_SAMPLES_INDEPENDENT, 1).map_err(err)?;
            t
        } else {
            first.video_type.clone()
        };
        let _ = video_in.SetUINT64(&MF_MT_FRAME_RATE, pack(plan.fps, 1));
        let _ = video_in.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32);
        let _ = video_in.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1));
        writer
            .SetInputMediaType(v_out, &video_in, None)
            .map_err(err)?;

        // Constant bitrate keeps the file size predictable.
        let mut api_ptr: *mut core::ffi::c_void = std::ptr::null_mut();
        if writer
            .GetServiceForStream(v_out, &windows::core::GUID::zeroed(), &ICodecAPI::IID, &mut api_ptr)
            .is_ok()
            && !api_ptr.is_null()
        {
            let api = ICodecAPI::from_raw(api_ptr);
            set_codec_u32(&api, &CODECAPI_AVEncCommonRateControlMode, eAVEncCommonRateControlMode_CBR.0 as u32);
            set_codec_u32(&api, &CODECAPI_AVEncCommonMeanBitRate, plan.video_bps);
            set_codec_u32(&api, &CODECAPI_AVEncMPVGOPSize, plan.fps * 2);
        }

        let a_out = match first.audio_type.as_ref() {
            Some(pcm_in) => {
                let rate = pcm_in.GetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND).unwrap_or(48_000);
                let ch = pcm_in.GetUINT32(&MF_MT_AUDIO_NUM_CHANNELS).unwrap_or(2).min(2);
                let aac = MFCreateMediaType().map_err(err)?;
                aac.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio).map_err(err)?;
                aac.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_AAC).map_err(err)?;
                aac.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16).map_err(err)?;
                aac.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, rate).map_err(err)?;
                aac.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, ch).map_err(err)?;
                aac.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, plan.audio_bps / 8)
                    .map_err(err)?;
                let s = writer.AddStream(&aac).map_err(err)?;
                writer.SetInputMediaType(s, pcm_in, None).map_err(err)?;
                Some(s)
            }
            None => None,
        };

        writer.BeginWriting().map_err(err)?;

        // ---- pump every segment onto one timeline ----
        let total_hns: i64 = segs
            .iter()
            .map(|s| ((s.end - s.start) as f64 * HNS_PER_SECOND as f64) as i64)
            .sum::<i64>()
            .max(1);
        let frame_hns = HNS_PER_SECOND / plan.fps.max(1) as i64;
        let mut offset: i64 = 0;
        let mut next_frame: i64 = 0;
        let mut last_report = -1i64;
        let mut first = Some(first);

        for seg in segs {
            let src = match first.take() {
                Some(s) => s,
                None => open_source(&seg.path, lay, hardware, a_out.is_some(), pcm)?,
            };
            let start_hns = (seg.start as f64 * HNS_PER_SECOND as f64) as i64;
            let end_hns = (seg.end as f64 * HNS_PER_SECOND as f64) as i64;
            if start_hns > 0 {
                let var = windows::core::PROPVARIANT::from(start_hns);
                src.reader
                    .SetCurrentPosition(&windows::core::GUID::zeroed(), &var)
                    .map_err(err)?;
            }
            let audio_stream = if a_out.is_some() { src.audio } else { None };
            let mut video_done = false;
            let mut audio_done = audio_stream.is_none();

            while !(video_done && audio_done) {
                let mut stream_index = 0u32;
                let mut flags = 0u32;
                let mut ts = 0i64;
                let mut sample: Option<IMFSample> = None;
                src.reader
                    .ReadSample(
                        MF_SOURCE_READER_ANY_STREAM.0 as u32,
                        0,
                        Some(&mut stream_index),
                        Some(&mut flags),
                        Some(&mut ts),
                        Some(&mut sample),
                    )
                    .map_err(err)?;
                let is_video = stream_index == src.video;
                let finished = (flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32) != 0
                    || (sample.is_some() && ts > end_hns);
                if finished {
                    if is_video {
                        video_done = true;
                    } else {
                        audio_done = true;
                    }
                    // Stop reading a finished stream so ANY_STREAM keeps moving.
                    let _ = src.reader.SetStreamSelection(stream_index, false);
                    continue;
                }
                let Some(sample) = sample else { continue };
                // Decoded frames are exact, so cuts are frame-accurate.
                if ts < start_hns {
                    continue;
                }
                let out_ts = offset + (ts - start_hns);

                if is_video {
                    // Frame-rate step-down: keep one frame per output slot.
                    if out_ts < next_frame {
                        continue;
                    }
                    next_frame += frame_hns;
                    while next_frame <= out_ts {
                        next_frame += frame_hns;
                    }
                    let frame = if lay.crops() { crop_nv12(&sample, lay)? } else { sample };
                    frame.SetSampleTime(out_ts).map_err(err)?;
                    frame.SetSampleDuration(frame_hns).map_err(err)?;
                    writer.WriteSample(v_out, &frame).map_err(err)?;

                    let pct = out_ts * 100 / total_hns;
                    if pct != last_report {
                        last_report = pct;
                        progress((pct as f32 / 100.0).clamp(0.0, 1.0));
                    }
                } else if let (Some(a), Some(_)) = (a_out, audio_stream) {
                    sample.SetSampleTime(out_ts).map_err(err)?;
                    writer.WriteSample(a, &sample).map_err(err)?;
                }
            }
            offset += end_hns - start_hns;
        }

        writer.Finalize().map_err(err)?;
        Ok(())
    }
}

#[cfg(any(not(windows), feature = "headless-sim"))]
mod imp {
    use super::*;
    pub(super) fn encode(
        _segs: &[Resolved],
        _dest: &Path,
        _lay: &Layout,
        _progress: &mut dyn FnMut(f32),
    ) -> RResult<()> {
        Err(RecorderError::Other("exporting requires Windows".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_clip_keeps_full_quality() {
        // 8 s into 10 MB is ~8.9 Mbit/s of video: keep 1080p60.
        let p = plan(1920, 1080, 60, 8.0, 10_000_000, true).unwrap();
        assert_eq!((p.width, p.height, p.fps), (1920, 1080, 60));
        // 15 s is ~4.7 Mbit/s: too thin for 1080p60 game footage, 720p60 looks better.
        let p = plan(1920, 1080, 60, 15.0, 10_000_000, true).unwrap();
        assert_eq!((p.width, p.height, p.fps), (1280, 720, 60));
        assert!(p.video_bps > 4_000_000 && p.video_bps < 5_000_000);
    }

    #[test]
    fn long_clip_steps_down_resolution_and_fps() {
        // 120 s into 10 MB is ~500 kbit/s: 30 fps and well below 1080p.
        let p = plan(1920, 1080, 60, 120.0, 10_000_000, true).unwrap();
        assert_eq!(p.fps, 30);
        assert!(p.height <= 480, "height {}", p.height);
        assert_eq!(p.width % 2, 0);
        assert_eq!(p.height % 2, 0);
        // Total budget stays under the limit.
        let bytes = (p.video_bps + p.audio_bps) as f64 * 120.0 / 8.0;
        assert!(bytes < 10_000_000.0);
    }

    #[test]
    fn too_long_clip_explains_how_long_fits() {
        let e = plan(1920, 1080, 60, 3600.0, 10_000_000, true).unwrap_err();
        let msg = e.to_string();
        assert!(msg.contains("Trim it to about"), "{msg}");
    }

    #[test]
    fn never_upscales_small_sources() {
        let p = plan(1280, 720, 30, 5.0, 50_000_000, false).unwrap();
        assert_eq!((p.width, p.height), (1280, 720));
        assert_eq!(p.audio_bps, 0);
    }

    #[test]
    fn output_path_never_reuses_a_file() {
        let dir = std::env::temp_dir().join(format!("lastshot-shrink-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("clip.mp4");
        let first = output_path(&dir, &src, 10_000_000);
        assert_eq!(first, dir.join("clip_10MB.mp4"));
        std::fs::write(&first, b"x").unwrap();
        assert_eq!(output_path(&dir, &src, 10_000_000), dir.join("clip_10MB2.mp4"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn vertical_crop_of_1080p_for_quality() {
        // 9:16 window of a 16:9 frame, centred.
        let w = 1080.0 * 9.0 / 16.0 / 1920.0;
        let crop = Crop { x: (1.0 - w) / 2.0, y: 0.0, w, h: 1.0 };
        let l = layout(1920, 1080, 60, 20.0, Some(crop), Target::Quality, true).unwrap();
        assert_eq!((l.plan.width, l.plan.height, l.plan.fps), (608, 1080, 60));
        assert_eq!((l.read_w, l.read_h), (1920, 1080));
        assert!(l.crop_x % 2 == 0 && l.crop_x + l.plan.width <= l.read_w);
        assert!((655..=657).contains(&l.crop_x), "{}", l.crop_x);
        assert_eq!(l.crop_y, 0);
        assert!(l.crops());
    }

    #[test]
    fn crop_with_size_target_scales_the_read_frame() {
        let crop = Crop { x: 0.5, y: 0.5, w: 0.5, h: 0.5 };
        let l = layout(1920, 1080, 60, 120.0, Some(crop), Target::Size(10_000_000), true).unwrap();
        assert!(l.plan.height < 540);
        assert!(l.read_w >= l.plan.width * 2 - 2 && l.read_h >= l.plan.height * 2 - 2);
        assert!(l.crop_x + l.plan.width <= l.read_w);
        assert!(l.crop_y + l.plan.height <= l.read_h);
    }

    #[test]
    fn full_crop_is_no_crop() {
        let crop = Crop { x: 0.0, y: 0.0, w: 1.0, h: 1.0 };
        let l = layout(1920, 1080, 60, 10.0, Some(crop), Target::Quality, false).unwrap();
        assert!(!l.crops());
        assert_eq!((l.plan.width, l.plan.height), (1920, 1080));
        assert_eq!(l.plan.audio_bps, 0);
    }

    #[test]
    fn quality_keeps_a_generous_bitrate() {
        let p = quality_plan(1920, 1080, 60, true);
        assert!(p.video_bps >= 10_000_000 && p.video_bps <= 14_000_000, "{}", p.video_bps);
        assert_eq!(p.audio_bps, QUALITY_AUDIO_BPS);
        assert_eq!(quality_plan(2560, 1440, 144, false).fps, 60);
    }

    /// Real encode, run by hand:
    /// `LASTSHOT_TEST_CLIP=path\to.mp4 cargo test --release shrink_real -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn shrink_real_clip() {
        let Ok(src) = std::env::var("LASTSHOT_TEST_CLIP") else { return };
        let src = PathBuf::from(src);
        let out_dir = std::env::temp_dir().join("lastshot-shrink-real");
        std::fs::create_dir_all(&out_dir).unwrap();
        let target = std::env::var("LASTSHOT_TEST_MB")
            .ok()
            .and_then(|v| v.parse::<f64>().ok())
            .unwrap_or(10.0);
        let target_bytes = (target * 1_000_000.0) as u64;
        let dest = output_path(&out_dir, &src, target_bytes);
        let mut last = 0.0;
        let r = shrink_to_size(&src, &dest, target_bytes, 0.0, None, &mut |p| last = p).unwrap();
        println!("{r:#?} progress={last}");
        assert!(r.size_bytes <= target_bytes);
        assert!(r.size_bytes > target_bytes / 4, "suspiciously small output");
    }

    /// Real edit export, run by hand: two cut-out parts of LASTSHOT_TEST_CLIP
    /// plus all of LASTSHOT_TEST_CLIP2 (if set), cropped to 9:16.
    #[test]
    #[ignore]
    fn export_real_edit() {
        let Ok(a) = std::env::var("LASTSHOT_TEST_CLIP") else { return };
        let a = PathBuf::from(a);
        let mut segs = vec![
            Segment { path: a.clone(), start: 2.0, end: Some(6.0) },
            Segment { path: a.clone(), start: 20.0, end: Some(25.0) },
        ];
        if let Ok(b) = std::env::var("LASTSHOT_TEST_CLIP2") {
            segs.push(Segment { path: PathBuf::from(b), start: 0.0, end: Some(4.0) });
        }
        let w = 1080.0 * 9.0 / 16.0 / 1920.0;
        let crop = Crop { x: (1.0 - w) / 2.0, y: 0.0, w, h: 1.0 };
        let out_dir = std::env::temp_dir().join("lastshot-shrink-real");
        std::fs::create_dir_all(&out_dir).unwrap();
        let dest = out_dir.join("edit_test.mp4");
        let _ = std::fs::remove_file(&dest);
        let r = export(&segs, Some(crop), Target::Quality, &dest, &mut |_| {}).unwrap();
        println!("{r:#?}");
        let probe = super::super::library::probe(&dest).unwrap();
        println!("probe: {}x{} {} fps {:.2} s audio={}", probe.width, probe.height, probe.fps, probe.duration_seconds, probe.has_audio);
        assert_eq!((probe.width, probe.height), (r.width, r.height));
        let want: f32 = segs.iter().map(|s| s.end.unwrap() - s.start).sum();
        assert!((probe.duration_seconds - want).abs() < 0.5, "{} vs {want}", probe.duration_seconds);
    }
}
