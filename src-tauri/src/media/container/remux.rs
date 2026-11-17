//! One place that makes any recording a normal MP4:
//!
//! * our recordings cut off by a crash, a kill or a power cut (fragmented, or
//!   stopped half way through finishing): repaired **in place**, the same way
//!   a clean stop finishes them (fast, no copy, no extra disk space);
//! * MKV, and fragmented MP4 from other apps: remuxed into a new MP4 next to
//!   the original (no re-encode, the original is kept).

use std::fs::{File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::mp4::{self, Layout, Mode, MoovTrack, Mp4Writer, Table};
use super::{bad, mkv, CodecId, SampleRef, TrackConfig, TrackData};

/// What a file needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Need {
    /// A normal MP4 already.
    Nothing,
    /// Our recording, cut off before it was finished: fixed in place.
    RepairInPlace,
    /// MKV or a fragmented MP4: a new MP4 next to it.
    Remux,
    /// Cannot be fixed (no index and nothing to rebuild it from, or empty).
    Unfixable,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnosis {
    pub need: Need,
    /// "mp4" or "mkv".
    pub container: &'static str,
    pub seconds: f64,
    pub video: Option<&'static str>,
    pub audio: bool,
    /// Written by Lastshot.
    pub ours: bool,
    /// Plain words for the user.
    pub message: String,
}

fn head(path: &Path) -> io::Result<Vec<u8>> {
    let mut f = File::open(path)?;
    let mut b = vec![0u8; 64];
    let n = f.read(&mut b)?;
    b.truncate(n);
    Ok(b)
}

fn summary(tracks: &[TrackData]) -> (f64, Option<&'static str>, bool) {
    (
        tracks.iter().map(|t| t.duration_seconds()).fold(0.0, f64::max),
        tracks.iter().find(|t| t.config.is_video()).map(|t| t.config.codec.label()),
        tracks.iter().any(|t| t.config.codec == CodecId::Aac && !t.samples.is_empty()),
    )
}

/// Looks at a file without changing it.
pub fn diagnose(path: &Path) -> io::Result<Diagnosis> {
    let h = head(path)?;
    if h.is_empty() {
        return Ok(Diagnosis {
            need: Need::Unfixable,
            container: "mp4",
            seconds: 0.0,
            video: None,
            audio: false,
            ours: false,
            message: "The file is empty (0 bytes): nothing was recorded into it.".into(),
        });
    }
    if mkv::is_mkv(&h) {
        let info = mkv::read(path)?;
        let (seconds, video, audio) = summary(&info.tracks);
        let fixable = info.tracks.iter().any(|t| !t.samples.is_empty());
        return Ok(Diagnosis {
            need: if fixable { Need::Remux } else { Need::Unfixable },
            container: "mkv",
            seconds,
            video,
            audio,
            ours: false,
            message: if fixable {
                "MKV: makes an MP4 copy next to it (no quality loss) that every editor and phone opens.".into()
            } else {
                "This MKV holds no video or sound Lastshot can read.".into()
            },
        });
    }
    let info = mp4::read_with(path, true)?;
    let (seconds, video, audio) = summary(&info.tracks);
    let (need, message) = match info.layout {
        Layout::Regular => (Need::Nothing, "This file is fine: nothing to repair.".to_string()),
        Layout::HalfFinished => (Need::RepairInPlace, "The recording stopped while it was being saved. Repair finishes it.".into()),
        Layout::Fragmented if info.ours => (
            Need::RepairInPlace,
            format!("The recording was cut off (crash, power loss or a full disk). Repair keeps all {} that reached the disk.", fmt_len(seconds)),
        ),
        Layout::Fragmented => (Need::Remux, "Fragmented MP4: makes a normal MP4 copy next to it (no quality loss).".into()),
        Layout::NoIndex => (
            Need::Unfixable,
            "The file was cut off before its index was written, and it holds nothing to rebuild the index from.".into(),
        ),
        Layout::Empty => (Need::Unfixable, "No video or sound reached this file.".into()),
    };
    Ok(Diagnosis { need, container: "mp4", seconds, video, audio, ours: info.ours, message })
}

fn fmt_len(s: f64) -> String {
    let s = s.max(0.0).round() as u64;
    if s >= 3600 {
        format!("{} h {} min", s / 3600, (s % 3600) / 60)
    } else if s >= 60 {
        format!("{} min {} s", s / 60, s % 60)
    } else {
        format!("{s} s")
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FixResult {
    /// The playable file (the same path after an in-place repair).
    pub path: String,
    pub new_file: bool,
    pub seconds: f64,
    pub message: String,
}

/// Repairs or remuxes `path` as [`diagnose`] says. A remux goes to a new
/// file next to it (`name.mp4`, or `name (fixed).mp4` for an MP4).
pub fn fix(path: &Path, progress: &mut dyn FnMut(f32)) -> io::Result<FixResult> {
    let d = diagnose(path)?;
    match d.need {
        Need::Nothing => Ok(FixResult { path: path.to_string_lossy().into(), new_file: false, seconds: d.seconds, message: d.message }),
        Need::Unfixable => Err(io::Error::new(io::ErrorKind::Other, d.message)),
        Need::RepairInPlace => {
            let seconds = repair_in_place(path)?;
            progress(1.0);
            Ok(FixResult {
                path: path.to_string_lossy().into(),
                new_file: false,
                seconds,
                message: format!("Repaired: {} recovered.", fmt_len(seconds)),
            })
        }
        Need::Remux => {
            let dst = remux_target(path, d.container == "mkv");
            let seconds = remux_to_mp4(path, &dst, progress)?;
            Ok(FixResult {
                path: dst.to_string_lossy().into(),
                new_file: true,
                seconds,
                message: format!("Saved as {}.", dst.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()),
            })
        }
    }
}

/// `clip.mkv` -> `clip.mp4`; `clip.mp4` -> `clip (fixed).mp4`; never an
/// existing file.
pub fn remux_target(src: &Path, from_mkv: bool) -> PathBuf {
    let stem = src.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "video".into());
    let dir = src.parent().map(Path::to_path_buf).unwrap_or_default();
    let base = if from_mkv { stem } else { format!("{stem} (fixed)") };
    let mut p = dir.join(format!("{base}.mp4"));
    let mut n = 2;
    while p.exists() {
        p = dir.join(format!("{base} {n}.mp4"));
        n += 1;
    }
    p
}

/// Finishes one of our recordings that was cut off, in place. Returns the
/// seconds it now holds.
pub fn repair_in_place(path: &Path) -> io::Result<f64> {
    let info = mp4::read_with(path, true)?;
    let mut f = OpenOptions::new().read(true).write(true).open(path)?;
    match info.layout {
        Layout::Regular => Ok(info.duration_seconds()),
        Layout::HalfFinished => {
            // The full moov is there: finish turning the fragments into free space.
            for &m in &info.moofs {
                f.seek(SeekFrom::Start(m + 4))?;
                f.write_all(b"free")?;
            }
            if let Some(p) = info.frag_moov {
                f.seek(SeekFrom::Start(p + 4))?;
                f.write_all(b"free")?;
            }
            f.sync_data()?;
            Ok(info.duration_seconds())
        }
        Layout::Fragmented if info.ours => {
            let mut tracks = info.tracks;
            tracks.retain(|t| !t.samples.is_empty());
            if !tracks.iter().any(|t| t.config.is_video()) {
                return Err(io::Error::new(io::ErrorKind::Other, "No video reached this file before it was cut off."));
            }
            let end = tracks.iter().flat_map(|t| t.samples.iter()).map(|s| s.offset + s.size as u64).max().unwrap_or(0);
            // The last mdat may claim bytes that never reached the disk.
            if let Some(&(start, hdr, _, _)) = info.mdats.iter().find(|m| m.0 < end && end <= m.2.max(m.3)) {
                let size = end - start;
                if hdr == 16 {
                    f.seek(SeekFrom::Start(start + 8))?;
                    f.write_all(&size.to_be_bytes())?;
                } else if size <= u32::MAX as u64 {
                    f.seek(SeekFrom::Start(start))?;
                    f.write_all(&(size as u32).to_be_bytes())?;
                }
            }
            let tables: Vec<Table> = tracks
                .iter_mut()
                .map(|t| {
                    mp4::fix_durations(&mut t.samples);
                    Table::from_samples(&t.samples)
                })
                .collect();
            let list: Vec<MoovTrack> = tracks.iter().zip(&tables).map(|(t, tab)| MoovTrack { cfg: &t.config, table: Some(tab) }).collect();
            let moov = mp4::build_moov(&list);
            // Fragments read from `free` boxes are already free; writing "free" again is harmless.
            let all_moofs: Vec<u64> = info.moofs.clone();
            mp4::finalize_in_place(&mut f, end, &moov, &all_moofs, info.frag_moov)?;
            Ok(tracks.iter().map(|t| t.duration_seconds()).fold(0.0, f64::max))
        }
        _ => Err(io::Error::new(io::ErrorKind::Other, "This file cannot be repaired in place.")),
    }
}

// ------------------------------------------------------------------ remux

/// Decode times for samples that only carry presentation times (MKV): B-frame
/// streams store pictures out of order, so decode times are the sorted
/// presentation times shifted back just enough that no picture is shown
/// before it is decoded.
pub(crate) fn derive_dts(samples: &mut [SampleRef]) {
    let n = samples.len();
    if n < 2 || samples.windows(2).all(|w| w[1].dts > w[0].dts) {
        return;
    }
    let pts: Vec<i64> = samples.iter().map(|s| s.dts).collect();
    let mut sorted = pts.clone();
    sorted.sort_unstable();
    let shift = (0..n).map(|i| sorted[i] - pts[i]).max().unwrap_or(0).max(0);
    let mut prev = i64::MIN;
    for (i, s) in samples.iter_mut().enumerate() {
        let mut dts = sorted[i] - shift;
        if dts <= prev {
            dts = prev + 1;
        }
        prev = dts;
        s.dts = dts;
        s.cts = (pts[i] - dts).clamp(i32::MIN as i64, i32::MAX as i64) as i32;
    }
}

/// Puts a video track read with millisecond times on its frame-rate grid when
/// it is a constant frame rate (clean timing in the MP4); otherwise keeps
/// milliseconds.
fn regrid_video(t: &mut TrackData) {
    if t.config.timescale != 1000 || t.samples.len() < 3 {
        return;
    }
    let mut pts: Vec<i64> = t.samples.iter().map(|s| s.dts + s.cts as i64).collect();
    pts.sort_unstable();
    let mut deltas: Vec<i64> = pts.windows(2).map(|w| w[1] - w[0]).filter(|d| *d > 0).collect();
    if deltas.is_empty() {
        return;
    }
    deltas.sort_unstable();
    let median = deltas[deltas.len() / 2] as f64;
    // Average step over the whole track (ms rounding alternates 16/17).
    let avg = (pts[pts.len() - 1] - pts[0]) as f64 / (pts.len() - 1) as f64;
    let fps = (1000.0 / avg).round();
    if !(1.0..=1000.0).contains(&fps) || (1000.0 / fps - avg).abs() > 0.02 * avg || (median - avg).abs() > 1.0 {
        return;
    }
    let fps = fps as i64;
    let scale = (fps * 1000) as u32;
    for s in &mut t.samples {
        let p = s.dts + s.cts as i64;
        let pn = ((p * fps) as f64 / 1000.0).round() as i64 * 1000;
        let dn = ((s.dts * fps) as f64 / 1000.0).round() as i64 * 1000;
        s.dts = dn;
        s.cts = (pn - dn) as i32;
    }
    t.config.timescale = scale;
}

/// AAC read with millisecond times: count 1024-sample frames on the sample
/// rate, jumping only across real gaps.
fn regrid_aac(t: &mut TrackData) {
    let rate = t.config.sample_rate.max(1);
    let from = t.config.timescale.max(1);
    if from == rate {
        return;
    }
    let mut next: Option<i64> = None;
    for s in &mut t.samples {
        let at = (s.dts as i128 * rate as i128 / from as i128) as i64;
        let dts = match next {
            Some(n) if (at - n).abs() <= 1536 => n,
            _ => at,
        };
        s.dts = dts;
        s.cts = 0;
        s.duration = 1024;
        next = Some(dts + 1024);
    }
    t.config.timescale = rate;
}

/// Copies every sample of `src` (MKV or MP4) into a normal MP4 at `dst`.
/// Returns the seconds written. `dst` is removed again on failure.
pub fn remux_to_mp4(src: &Path, dst: &Path, progress: &mut dyn FnMut(f32)) -> io::Result<f64> {
    let r = remux_inner(src, dst, progress);
    if r.is_err() {
        let _ = std::fs::remove_file(dst);
    }
    r
}

fn remux_inner(src: &Path, dst: &Path, progress: &mut dyn FnMut(f32)) -> io::Result<f64> {
    let h = head(src)?;
    let mut tracks: Vec<TrackData> = if mkv::is_mkv(&h) {
        let mut t = mkv::read(src)?.tracks;
        for tr in &mut t {
            if tr.config.is_video() {
                derive_dts(&mut tr.samples);
                regrid_video(tr);
            } else {
                regrid_aac(tr);
            }
        }
        t
    } else {
        mp4::read_with(src, false)?.tracks
    };
    tracks.retain(|t| !t.samples.is_empty());
    if tracks.is_empty() {
        return Err(bad("no video or sound in this file"));
    }
    // A video track first: players pick the first video.
    tracks.sort_by_key(|t| !t.config.is_video());
    for t in &mut tracks {
        mp4::fix_durations(&mut t.samples);
    }
    let configs: Vec<TrackConfig> = tracks.iter().map(|t| t.config.clone()).collect();
    let mut w = Mp4Writer::create(dst, Mode::Plain, configs)?;
    let mut input = File::open(src)?;
    let total: usize = tracks.iter().map(|t| t.samples.len()).sum();
    let mut idx = vec![0usize; tracks.len()];
    let mut done = 0usize;
    let mut last_report = 0usize;
    let mut err: Option<io::Error> = None;
    loop {
        // Interleave by time: the track whose next sample is earliest.
        let next = (0..tracks.len())
            .filter(|&i| idx[i] < tracks[i].samples.len())
            .min_by(|&a, &b| {
                let ta = tracks[a].samples[idx[a]].dts as f64 / tracks[a].config.timescale as f64;
                let tb = tracks[b].samples[idx[b]].dts as f64 / tracks[b].config.timescale as f64;
                ta.partial_cmp(&tb).unwrap_or(std::cmp::Ordering::Equal)
            });
        let Some(i) = next else { break };
        let s = tracks[i].samples[idx[i]];
        idx[i] += 1;
        w.write_sample(i, s.dts, s.cts, s.key, s.duration, |b| {
            let start = b.len();
            b.resize(start + s.size as usize, 0);
            let r = input.seek(SeekFrom::Start(s.offset)).and_then(|_| input.read_exact(&mut b[start..]));
            if let Err(e) = r {
                b.truncate(start);
                err = Some(e);
            }
        })?;
        if let Some(e) = err.take() {
            return Err(e);
        }
        done += 1;
        if done - last_report >= total / 100 + 1 {
            last_report = done;
            progress(done as f32 / total as f32);
        }
    }
    let fin = w.finish()?;
    progress(1.0);
    Ok(fin.seconds)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::container::mp4::tests::{tmp, write_av};
    use crate::media::container::testdata;

    #[test]
    fn our_cut_off_recording_is_repaired_in_place() {
        let p = tmp("repair-cut.mp4");
        let mut w = write_av(&p, Mode::Hybrid, 3, true);
        w.flush().unwrap();
        drop(w);
        // Cut it in the middle of the last fragment, like a power cut.
        let len = std::fs::metadata(&p).unwrap().len();
        OpenOptions::new().write(true).open(&p).unwrap().set_len(len - 700).unwrap();
        let d = diagnose(&p).unwrap();
        assert_eq!(d.need, Need::RepairInPlace, "{d:?}");
        let before = mp4::read(&p).unwrap().video().unwrap().samples.len();
        let secs = repair_in_place(&p).unwrap();
        assert!(secs > 2.0, "{secs}");
        let info = mp4::read(&p).unwrap();
        assert_eq!(info.layout, Layout::Regular);
        assert_eq!(info.video().unwrap().samples.len(), before);
        assert_eq!(diagnose(&p).unwrap().need, Need::Nothing);
        if let Some(pr) = testdata::probe(&p) {
            assert_eq!(pr.packets("h264"), Some(before as u64), "{pr:?}");
            assert!(pr.stderr.trim().is_empty(), "{}", pr.stderr);
        }
        if let Some(e) = testdata::decode_errors(&p) {
            assert!(e.trim().is_empty(), "{e}");
        }
    }

    /// The writer side of `a_killed_writer_leaves_a_playable_file`: runs in a
    /// child process (this test binary started again) until it is killed.
    #[test]
    #[ignore]
    fn child_writer() {
        let Ok(path) = std::env::var("LASTSHOT_KILL_TEST") else { return };
        use std::io::Write as _;
        let s = testdata::H264Stream::new(64, 48);
        let cfg = super::super::codec::video_config(CodecId::H264, &s.header(), &[]).unwrap();
        let mut w = Mp4Writer::create(
            Path::new(&path),
            Mode::Hybrid,
            vec![TrackConfig::video(CodecId::H264, 30_000, 64, 48, cfg), TrackConfig::aac(48_000, 2, 192_000)],
        )
        .unwrap();
        let (mut a, mut out) = (0i64, std::io::stdout());
        for i in 0..30 * 120u32 {
            let (au, key) = s.frame(i, 30);
            w.write_sample(0, i as i64 * 1000, 0, key, 1000, |b| {
                super::super::codec::append_sample(CodecId::H264, &au, b);
            })
            .unwrap();
            while a * 1024 * 30 < (i as i64 + 1) * 48_000 {
                w.write_sample(1, a * 1024, 0, true, 1024, |b| b.extend_from_slice(&testdata::SILENT_AAC_STEREO)).unwrap();
                a += 1;
            }
            if i % 15 == 14 {
                // Half a second per fragment, like a recording.
                w.flush().unwrap();
                writeln!(out, "FRAG {}", i + 1).unwrap();
                out.flush().unwrap();
                std::thread::sleep(std::time::Duration::from_millis(15));
            }
        }
    }

    /// Crash safety, for real: a writer process is killed (TerminateProcess,
    /// like a crash or End task) at different moments; every file must play
    /// as it is and repair into a normal MP4 with everything flushed so far.
    #[test]
    fn a_killed_writer_leaves_a_playable_file() {
        use std::io::BufRead as _;
        let exe = std::env::current_exe().unwrap();
        // (fragments to wait for, extra delay before the kill in ms)
        for (i, (frags, delay)) in [(0usize, 0u64), (1, 0), (4, 3), (12, 7), (30, 0)].into_iter().enumerate() {
            let p = tmp(&format!("killed-{i}.mp4"));
            let _ = std::fs::remove_file(&p);
            let mut child = std::process::Command::new(&exe)
                .args(["--exact", "media::container::remux::tests::child_writer", "--ignored", "--nocapture", "--test-threads=1"])
                .env("LASTSHOT_KILL_TEST", &p)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null())
                .spawn()
                .unwrap();
            let mut lines = std::io::BufReader::new(child.stdout.take().unwrap()).lines();
            let mut frames_flushed = 0u32;
            let mut seen = 0usize;
            while seen < frags {
                let line = lines.next().expect("child ended early").unwrap();
                // libtest prints "test ... " without a newline first.
                if let Some(at) = line.find("FRAG ") {
                    frames_flushed = line[at + 5..].trim().parse().unwrap();
                    seen += 1;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(delay));
            child.kill().unwrap();
            let _ = child.wait();
            let len = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
            if frags == 0 {
                // Killed at once: no file, or just the header, never a panic.
                if p.exists() {
                    let d = diagnose(&p).unwrap();
                    assert!(matches!(d.need, Need::Unfixable | Need::RepairInPlace), "{d:?}");
                }
                continue;
            }
            let d = diagnose(&p).unwrap();
            assert_eq!(d.need, Need::RepairInPlace, "kill {i}: {d:?} ({len} bytes)");
            // Plays before any repair.
            if let Some(pr) = testdata::probe(&p) {
                assert!(pr.packets("h264").unwrap_or(0) >= frames_flushed as u64, "kill {i}: {pr:?}");
            }
            repair_in_place(&p).unwrap();
            let info = mp4::read(&p).unwrap();
            assert_eq!(info.layout, Layout::Regular, "kill {i}");
            let n = info.video().unwrap().samples.len() as u32;
            assert!(n >= frames_flushed, "kill {i}: {n} frames kept, {frames_flushed} were flushed");
            if let Some(pr) = testdata::probe(&p) {
                assert_eq!(pr.packets("h264"), Some(n as u64), "kill {i}: {pr:?}");
                assert!(pr.stderr.trim().is_empty(), "kill {i}: {}", pr.stderr);
            }
            if let Some(e) = testdata::decode_errors(&p) {
                assert!(e.trim().is_empty(), "kill {i}: {e}");
            }
            eprintln!("kill {i}: {len} bytes, {frames_flushed} frames flushed, {n} recovered");
        }
    }

    #[test]
    fn a_zero_byte_file_is_reported_not_fixed() {
        let p = tmp("zero.mp4");
        std::fs::write(&p, b"").unwrap();
        assert_eq!(diagnose(&p).unwrap().need, Need::Unfixable);
        assert!(fix(&p, &mut |_| {}).is_err());
    }

    #[test]
    fn a_file_killed_before_any_fragment_has_nothing_to_repair() {
        let p = tmp("no-frag.mp4");
        let w = write_av(&p, Mode::Hybrid, 0, true);
        drop(w);
        let d = diagnose(&p).unwrap();
        assert_eq!(d.need, Need::Unfixable, "{d:?}");
    }

    #[test]
    fn b_frame_presentation_times_get_decode_times() {
        // I P B B P B B (pts in frame units).
        let pts = [0i64, 3, 1, 2, 6, 4, 5];
        let mut s: Vec<SampleRef> =
            pts.iter().map(|&p| SampleRef { offset: 0, size: 1, dts: p * 10, cts: 0, duration: 10, key: false }).collect();
        derive_dts(&mut s);
        for (i, x) in s.iter().enumerate() {
            assert_eq!(x.dts + x.cts as i64, pts[i] * 10, "pts kept");
            assert!(x.cts >= 0);
            if i > 0 {
                assert!(x.dts > s[i - 1].dts);
            }
        }
    }

    #[test]
    fn mkv_remuxes_to_a_playable_mp4() {
        let src = tmp("rmx.mkv");
        let s = testdata::H264Stream::new(64, 48);
        let cfg = super::super::codec::video_config(CodecId::H264, &s.header(), &[]).unwrap();
        let mut w = mkv::MkvWriter::create(&src, vec![TrackConfig::video(CodecId::H264, 30_000, 64, 48, cfg), TrackConfig::aac(48_000, 2, 192_000)]).unwrap();
        let mut a = 0i64;
        for i in 0..60u32 {
            let (au, key) = s.frame(i, 30);
            w.write_sample(0, i as i64 * 1000, key, 1000, |b| {
                super::super::codec::append_sample(CodecId::H264, &au, b);
            })
            .unwrap();
            while a * 1024 * 30 < (i as i64 + 1) * 48_000 {
                w.write_sample(1, a * 1024, true, 1024, |b| b.extend_from_slice(&testdata::SILENT_AAC_STEREO)).unwrap();
                a += 1;
            }
        }
        w.finish().unwrap();
        assert_eq!(diagnose(&src).unwrap().need, Need::Remux);
        let r = fix(&src, &mut |_| {}).unwrap();
        assert!(r.new_file && r.path.ends_with("rmx.mp4"), "{r:?}");
        let out = PathBuf::from(&r.path);
        let info = mp4::read(&out).unwrap();
        let v = info.video().unwrap();
        assert_eq!(v.samples.len(), 60);
        assert_eq!(v.config.timescale, 30_000, "30 fps put back on its grid");
        assert!(v.samples.windows(2).all(|w| w[1].dts - w[0].dts == 1000));
        let a = info.tracks.iter().find(|t| t.config.codec == CodecId::Aac).unwrap();
        assert!(a.samples.iter().all(|s| s.duration == 1024));
        if let Some(pr) = testdata::probe(&out) {
            assert_eq!(pr.packets("h264"), Some(60), "{pr:?}");
            assert!(pr.stderr.trim().is_empty(), "{}", pr.stderr);
        }
        let _ = std::fs::remove_file(&out);
    }

    #[test]
    fn ffmpeg_files_with_b_frames_remux_cleanly() {
        let Some(ff) = testdata::ffmpeg() else { return };
        for (name, vcodec, extra) in [
            ("x264.mkv", "libx264", vec!["-bf", "2", "-x264-params", "b-adapt=0"]),
            ("x265.mkv", "libx265", vec!["-x265-params", "log-level=error"]),
            ("frag.mp4", "libx264", vec!["-movflags", "frag_keyframe+empty_moov"]),
        ] {
            let src = tmp(name);
            let st = std::process::Command::new(&ff)
                .args(["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=128x72:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "2", "-c:v", vcodec, "-g", "30"])
                .args(&extra)
                .args(["-c:a", "aac"])
                .arg(&src)
                .status()
                .unwrap();
            if !st.success() {
                continue;
            }
            let dst = remux_target(&src, true);
            remux_to_mp4(&src, &dst, &mut |_| {}).unwrap();
            let info = mp4::read(&dst).unwrap();
            assert_eq!(info.video().unwrap().samples.len(), 60, "{name}");
            if let Some(pr) = testdata::probe(&dst) {
                let v = if vcodec == "libx265" { "hevc" } else { "h264" };
                assert_eq!(pr.packets(v), Some(60), "{name} {pr:?}");
                assert!(pr.stderr.trim().is_empty(), "{name}: {}", pr.stderr);
            }
            if let Some(e) = testdata::decode_errors(&dst) {
                assert!(e.trim().is_empty(), "{name}: {e}");
            }
            let _ = std::fs::remove_file(&dst);
        }
    }
}
