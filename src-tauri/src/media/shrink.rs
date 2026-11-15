//! "Shrink to fit": re-encodes a clip so the file stays under a size limit
//! (Discord's free upload cap by default), using only Windows' built-in Media
//! Foundation. No ffmpeg, so the app stays small.
//!
//! The bitrate is derived from the size budget and the clip length. Resolution
//! and frame rate step down when the budget is tight, because a sharp 480p30
//! clip looks better than a blocky 1080p60 one at the same size. If the
//! encoder still overshoots, the export is retried at a lower bitrate.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::recorder::{RecorderError, RResult, HNS_PER_SECOND};

/// AAC in Media Foundation only takes a few fixed bitrates; 96 kbit/s is the
/// smallest and is plenty for game audio.
pub const AUDIO_BPS: u32 = 96_000;
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
    if !source.exists() {
        return Err(RecorderError::Io(format!("clip not found: {}", source.display())));
    }
    let t0 = std::time::Instant::now();
    let probe = super::library::probe(source)?;
    let start = start.max(0.0);
    let end = end
        .filter(|e| *e > start)
        .unwrap_or(probe.duration_seconds)
        .min(probe.duration_seconds.max(start + 0.1));
    let duration = (end - start).max(0.1) as f64;

    let mut plan = plan(
        probe.width,
        probe.height,
        probe.fps.max(1),
        duration,
        target_bytes,
        probe.has_audio,
    )?;

    let mut attempts = 0;
    loop {
        attempts += 1;
        let base = (attempts - 1) as f32 / MAX_ATTEMPTS as f32;
        let mut sub = |p: f32| progress((base + p / MAX_ATTEMPTS as f32).min(0.99));
        imp::encode(source, dest, &plan, start, end, &mut sub)?;
        let size = std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0);
        if size <= target_bytes || attempts >= MAX_ATTEMPTS {
            if size > target_bytes {
                let _ = std::fs::remove_file(dest);
                return Err(RecorderError::Other(format!(
                    "Could not get this clip under {:.0} MB. Trim it shorter and try again.",
                    target_bytes as f64 / 1_000_000.0
                )));
            }
            progress(1.0);
            return Ok(ShrinkResult {
                path: dest.to_string_lossy().to_string(),
                file_name: dest
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default(),
                size_bytes: size,
                duration_seconds: duration as f32,
                width: plan.width,
                height: plan.height,
                fps: plan.fps,
                video_kbps: plan.video_bps / 1000,
                elapsed_ms: t0.elapsed().as_secs_f32() * 1000.0,
                attempts,
            });
        }
        // Overshot: scale the video bitrate by how far over we were, with a
        // little extra margin, and re-plan the resolution for it.
        let ratio = target_bytes as f64 / size as f64 * 0.93;
        let next_video = (plan.video_bps as f64 * ratio) as u32;
        if next_video < MIN_VIDEO_BPS {
            let _ = std::fs::remove_file(dest);
            return Err(RecorderError::Other(format!(
                "Could not get this clip under {:.0} MB. Trim it shorter and try again.",
                target_bytes as f64 / 1_000_000.0
            )));
        }
        let budget = (next_video as u64 + plan.audio_bps as u64) as f64 * duration
            / 8.0
            / BUDGET_FILL;
        plan = self::plan(
            probe.width,
            probe.height,
            probe.fps.max(1),
            duration,
            budget as u64,
            probe.has_audio,
        )?;
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
        source: &Path,
        dest: &Path,
        plan: &ShrinkPlan,
        start: f32,
        end: f32,
        progress: &mut dyn FnMut(f32),
    ) -> RResult<()> {
        let _mf = Mf::enter()?;
        match unsafe { encode_once(source, dest, plan, start, end, true, progress) } {
            Ok(()) => Ok(()),
            Err(e) => {
                log::warn!("[lastshot] hardware shrink failed ({e}); retrying in software");
                let _ = std::fs::remove_file(dest);
                unsafe { encode_once(source, dest, plan, start, end, false, progress) }
            }
        }
    }

    unsafe fn encode_once(
        source: &Path,
        dest: &Path,
        plan: &ShrinkPlan,
        start: f32,
        end: f32,
        hardware: bool,
        progress: &mut dyn FnMut(f32),
    ) -> RResult<()> {
        // ---- reader: decoded NV12 scaled to the plan, PCM audio ----
        let ra = attrs(3)?;
        ra.SetUINT32(&MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING, 1)
            .map_err(err)?;
        if hardware {
            let _ = ra.SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1);
        }
        let src = wide(source);
        let reader = MFCreateSourceReaderFromURL(PCWSTR(src.as_ptr()), &ra).map_err(err)?;
        let streams = find_streams(&reader)?;
        let audio = if plan.audio_bps > 0 { streams.audio } else { None };

        reader
            .SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS.0 as u32, false)
            .map_err(err)?;
        reader.SetStreamSelection(streams.video, true).map_err(err)?;

        let nv12 = MFCreateMediaType().map_err(err)?;
        nv12.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(err)?;
        nv12.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12).map_err(err)?;
        nv12.SetUINT64(&MF_MT_FRAME_SIZE, pack(plan.width, plan.height))
            .map_err(err)?;
        reader
            .SetCurrentMediaType(streams.video, None, &nv12)
            .map_err(err)?;
        let video_in = reader.GetCurrentMediaType(streams.video).map_err(err)?;
        let _ = video_in.SetUINT64(&MF_MT_FRAME_RATE, pack(plan.fps, 1));
        let _ = video_in.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32);
        let _ = video_in.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1));

        let audio_in = match audio {
            Some(idx) => {
                reader.SetStreamSelection(idx, true).map_err(err)?;
                let pcm = MFCreateMediaType().map_err(err)?;
                pcm.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio).map_err(err)?;
                pcm.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_PCM).map_err(err)?;
                pcm.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16).map_err(err)?;
                reader.SetCurrentMediaType(idx, None, &pcm).map_err(err)?;
                Some(reader.GetCurrentMediaType(idx).map_err(err)?)
            }
            None => None,
        };

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

        let a_out = match audio_in.as_ref() {
            Some(pcm) => {
                let rate = pcm.GetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND).unwrap_or(48_000);
                let ch = pcm.GetUINT32(&MF_MT_AUDIO_NUM_CHANNELS).unwrap_or(2).min(2);
                let aac = MFCreateMediaType().map_err(err)?;
                aac.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio).map_err(err)?;
                aac.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_AAC).map_err(err)?;
                aac.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16).map_err(err)?;
                aac.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, rate).map_err(err)?;
                aac.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, ch).map_err(err)?;
                aac.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, plan.audio_bps / 8)
                    .map_err(err)?;
                let s = writer.AddStream(&aac).map_err(err)?;
                writer.SetInputMediaType(s, pcm, None).map_err(err)?;
                Some(s)
            }
            None => None,
        };

        writer.BeginWriting().map_err(err)?;

        // ---- pump ----
        let start_hns = (start as f64 * HNS_PER_SECOND as f64) as i64;
        let end_hns = (end as f64 * HNS_PER_SECOND as f64) as i64;
        if start_hns > 0 {
            let var = windows::core::PROPVARIANT::from(start_hns);
            reader
                .SetCurrentPosition(&windows::core::GUID::zeroed(), &var)
                .map_err(err)?;
        }
        let frame_hns = HNS_PER_SECOND / plan.fps.max(1) as i64;
        let span = (end_hns - start_hns).max(1);
        let mut base: Option<i64> = None;
        let mut next_frame: i64 = 0;
        let mut video_done = false;
        let mut audio_done = a_out.is_none();
        let mut last_report = -1i64;

        while !(video_done && audio_done) {
            let mut stream_index = 0u32;
            let mut flags = 0u32;
            let mut ts = 0i64;
            let mut sample: Option<IMFSample> = None;
            reader
                .ReadSample(
                    MF_SOURCE_READER_ANY_STREAM.0 as u32,
                    0,
                    Some(&mut stream_index),
                    Some(&mut flags),
                    Some(&mut ts),
                    Some(&mut sample),
                )
                .map_err(err)?;
            let is_video = stream_index == streams.video;
            if (flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32) != 0 {
                if is_video {
                    video_done = true;
                } else {
                    audio_done = true;
                }
                // Stop reading a finished stream so ANY_STREAM keeps moving.
                let _ = reader.SetStreamSelection(stream_index, false);
                continue;
            }
            let Some(sample) = sample else { continue };

            // Decoded frames are exact, so the cut is frame-accurate.
            if ts < start_hns {
                continue;
            }
            if ts > end_hns {
                if is_video {
                    video_done = true;
                } else {
                    audio_done = true;
                }
                let _ = reader.SetStreamSelection(stream_index, false);
                continue;
            }
            let base_ts = *base.get_or_insert(ts.max(start_hns));
            let rebased = (ts - base_ts).max(0);

            if is_video {
                // Frame-rate step-down: keep one frame per output slot.
                if rebased < next_frame {
                    continue;
                }
                next_frame += frame_hns;
                while next_frame <= rebased {
                    next_frame += frame_hns;
                }
                sample.SetSampleTime(rebased).map_err(err)?;
                sample.SetSampleDuration(frame_hns).map_err(err)?;
                writer.WriteSample(v_out, &sample).map_err(err)?;

                let pct = (ts - start_hns) * 100 / span;
                if pct != last_report {
                    last_report = pct;
                    progress((pct as f32 / 100.0).clamp(0.0, 1.0));
                }
            } else if let Some(a) = a_out {
                sample.SetSampleTime(rebased).map_err(err)?;
                writer.WriteSample(a, &sample).map_err(err)?;
            }
        }

        writer.Finalize().map_err(err)?;
        Ok(())
    }
}

#[cfg(any(not(windows), feature = "headless-sim"))]
mod imp {
    use super::*;
    pub(super) fn encode(
        _source: &Path,
        _dest: &Path,
        _plan: &ShrinkPlan,
        _start: f32,
        _end: f32,
        _progress: &mut dyn FnMut(f32),
    ) -> RResult<()> {
        Err(RecorderError::Other("shrinking requires Windows".into()))
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
}
