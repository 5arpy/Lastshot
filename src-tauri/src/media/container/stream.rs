//! Encoder packets into a file: what screen recordings and replay saves use.
//!
//! Video arrives as the encoder gives it (Annex B H.264/HEVC, AV1 OBUs) with
//! presentation times in 100 ns; audio as raw AAC frames. The file is made at
//! the first key frame, so a recording that never got one leaves no file.

use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::mkv::MkvWriter;
use super::mp4::{Mode, Mp4Writer};
use super::{codec, hns_to_ticks, CodecId, TrackConfig};

/// Container of a screen recording.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    /// Crash-safe MP4 (fragmented while recording, normal once stopped).
    #[default]
    Mp4,
    /// Matroska, for people used to OBS; converted to MP4 after stop if asked.
    Mkv,
}

impl Format {
    pub fn extension(self) -> &'static str {
        match self {
            Format::Mp4 => "mp4",
            Format::Mkv => "mkv",
        }
    }
}

/// What the stream is, for the file's track setup.
#[derive(Clone, Debug)]
pub struct StreamInfo {
    pub codec: CodecId,
    pub width: u32,
    pub height: u32,
    pub fps_num: u32,
    pub fps_den: u32,
    pub bitrate: u32,
    /// Parameter sets from the encoder (Annex B or OBUs); may be empty when
    /// they only come with the key frames.
    pub header: Vec<u8>,
    /// (sample rate, channels, bitrate) of the AAC track, if any.
    pub audio: Option<(u32, u16, u32)>,
}

enum Out {
    Mp4(Mp4Writer),
    Mkv(MkvWriter),
}

/// What a finished file holds.
#[derive(Debug, Clone, Default)]
pub struct Written {
    pub bytes: u64,
    pub seconds: f64,
    pub video_frames: u64,
    pub audio_frames: u64,
}

pub struct StreamWriter {
    path: PathBuf,
    format: Format,
    mode: Mode,
    info: StreamInfo,
    vts: u32,
    out: Option<Out>,
    video_frames: u64,
    audio_frames: u64,
    /// End of the newest video frame, file time in 100 ns.
    end_hns: i64,
}

/// Video ticks per second: exact frame steps for whole frame rates.
pub fn video_timescale(fps_num: u32, fps_den: u32) -> u32 {
    if fps_den <= 1 && (1..=1000).contains(&fps_num) {
        fps_num * 1000
    } else {
        90_000
    }
}

impl StreamWriter {
    /// Nothing is created on disk until the first key frame.
    pub fn new(path: &Path, format: Format, mode: Mode, info: StreamInfo) -> Self {
        let vts = video_timescale(info.fps_num, info.fps_den);
        Self { path: path.to_path_buf(), format, mode, info, vts, out: None, video_frames: 0, audio_frames: 0, end_hns: 0 }
    }

    /// The file exists (a key frame arrived).
    pub fn started(&self) -> bool {
        self.out.is_some()
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// One video frame at `pts_hns` (file time, 100 ns). Frames before the
    /// first key frame are skipped (`Ok(false)`).
    pub fn write_video(&mut self, data: &[u8], pts_hns: i64, dur_hns: i64, key: bool) -> io::Result<bool> {
        if self.out.is_none() {
            if !key {
                return Ok(false);
            }
            self.open(data)?;
        }
        let codec = self.info.codec;
        let dts = hns_to_ticks(pts_hns, self.vts);
        let dur = hns_to_ticks(dur_hns.max(1), self.vts).clamp(1, u32::MAX as i64) as u32;
        let fill = |b: &mut Vec<u8>| {
            codec::append_sample(codec, data, b);
        };
        match self.out.as_mut() {
            Some(Out::Mp4(w)) => {
                w.write_sample(0, dts, 0, key, dur, fill)?;
            }
            Some(Out::Mkv(w)) => w.write_sample(0, dts, key, dur, fill)?,
            None => return Ok(false),
        }
        self.video_frames += 1;
        self.end_hns = self.end_hns.max(pts_hns + dur_hns.max(0));
        Ok(true)
    }

    /// One AAC frame at `pts_hns` (file time). Skipped before the video starts
    /// and before time 0.
    pub fn write_audio(&mut self, data: &[u8], pts_hns: i64, dur_hns: i64) -> io::Result<bool> {
        let Some((rate, ..)) = self.info.audio else {
            return Ok(false);
        };
        if pts_hns < 0 || data.is_empty() {
            return Ok(false);
        }
        let dts = hns_to_ticks(pts_hns, rate);
        let dur = hns_to_ticks(dur_hns.max(1), rate).clamp(1, u32::MAX as i64) as u32;
        let fill = |b: &mut Vec<u8>| b.extend_from_slice(data);
        match self.out.as_mut() {
            Some(Out::Mp4(w)) => {
                w.write_sample(1, dts, 0, true, dur, fill)?;
            }
            Some(Out::Mkv(w)) => w.write_sample(1, dts, true, dur, fill)?,
            None => return Ok(false),
        }
        self.audio_frames += 1;
        Ok(true)
    }

    fn open(&mut self, keyframe: &[u8]) -> io::Result<()> {
        let i = &self.info;
        let config = codec::video_config(i.codec, &i.header, keyframe)
            .ok_or_else(|| super::bad(format!("the {} encoder gave no stream setup", i.codec.label())))?;
        let (w, h) = codec::config_size(i.codec, &config).unwrap_or((i.width, i.height));
        let mut video = TrackConfig::video(i.codec, self.vts, w, h, config);
        video.bitrate = i.bitrate;
        let mut tracks = vec![video];
        if let Some((rate, channels, bitrate)) = i.audio {
            tracks.push(TrackConfig::aac(rate, channels, bitrate));
        }
        self.out = Some(match self.format {
            Format::Mp4 => Out::Mp4(Mp4Writer::create(&self.path, self.mode, tracks)?),
            Format::Mkv => Out::Mkv(MkvWriter::create(&self.path, tracks)?),
        });
        Ok(())
    }

    /// Writes what is buffered (a fragment / cluster).
    pub fn flush(&mut self) -> io::Result<()> {
        match self.out.as_mut() {
            Some(Out::Mp4(w)) => w.flush(),
            Some(Out::Mkv(w)) => w.flush(),
            None => Ok(()),
        }
    }

    /// File size so far.
    pub fn bytes(&self) -> u64 {
        match self.out.as_ref() {
            Some(Out::Mp4(w)) => w.bytes_written(),
            Some(Out::Mkv(w)) => w.bytes_written(),
            None => 0,
        }
    }

    /// Seconds of video so far.
    pub fn seconds(&self) -> f64 {
        self.end_hns as f64 / 1e7
    }

    /// Finishes the file. `None` when nothing was written (and no file made).
    /// On an error the file keeps what reached the disk: a fragmented MP4 or
    /// an MKV without index, both playable and repairable.
    pub fn finish(self) -> io::Result<Option<Written>> {
        let (video_frames, audio_frames, seconds) = (self.video_frames, self.audio_frames, self.seconds());
        match self.out {
            None => Ok(None),
            Some(Out::Mp4(w)) => {
                let f = w.finish()?;
                Ok(Some(Written { bytes: f.bytes, seconds: f.seconds.max(seconds), video_frames, audio_frames }))
            }
            Some(Out::Mkv(w)) => {
                w.finish()?;
                let bytes = std::fs::metadata(&self.path).map(|m| m.len()).unwrap_or(0);
                Ok(Some(Written { bytes, seconds, video_frames, audio_frames }))
            }
        }
    }
}

/// A write error in plain words (what the user sees when a recording stops).
pub fn describe_write_error(e: &io::Error) -> String {
    match e.raw_os_error() {
        // ERROR_DISK_FULL, ERROR_HANDLE_DISK_FULL
        Some(112) | Some(39) => return "The disk is full".into(),
        // not ready, no longer exists, not connected, file invalid (volume
        // gone), device hardware error, network name gone
        Some(21) | Some(55) | Some(1167) | Some(1006) | Some(483) | Some(64) | Some(59) => {
            return "The drive was removed or stopped responding".into()
        }
        _ => {}
    }
    if e.kind() == io::ErrorKind::StorageFull {
        return "The disk is full".into();
    }
    format!("The file could not be written ({e})")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::container::mp4::{self, tests::tmp, Layout};
    use crate::media::container::testdata::{self, H264Stream, SILENT_AAC_STEREO};

    fn info(audio: bool) -> StreamInfo {
        let s = H264Stream::new(64, 48);
        StreamInfo {
            codec: CodecId::H264,
            width: 64,
            height: 48,
            fps_num: 60,
            fps_den: 1,
            bitrate: 1_000_000,
            header: s.header(),
            audio: audio.then_some((48_000, 2, 192_000)),
        }
    }

    /// Feeds `secs` of 60 fps video (frame stamps as the engine makes them:
    /// whole 100 ns on the fps grid) plus AAC starting `audio_lead` early.
    fn feed(w: &mut StreamWriter, secs: u32, start_frame: u32, audio_lead_hns: i64) {
        let s = H264Stream::new(64, 48);
        let frame = |n: i64| n * 10_000_000 / 60;
        let mut a = 0i64;
        for i in start_frame..start_frame + secs * 60 {
            let (au, key) = s.frame(i, 60);
            w.write_video(&au, frame(i as i64), frame(i as i64 + 1) - frame(i as i64), key).unwrap();
            while (a * 1024 * 10_000_000) / 48_000 - audio_lead_hns < frame(i as i64 + 1) {
                w.write_audio(&SILENT_AAC_STEREO, (a * 1024 * 10_000_000) / 48_000 - audio_lead_hns, 213_333).unwrap();
                a += 1;
            }
        }
    }

    #[test]
    fn engine_packets_make_a_clean_mp4() {
        let p = tmp("stream-rec.mp4");
        let mut w = StreamWriter::new(&p, Format::Mp4, Mode::Hybrid, info(true));
        assert!(!w.started());
        // A delta frame first: skipped, no file yet.
        let s = H264Stream::new(64, 48);
        assert!(!w.write_video(&s.p(1), 0, 166_667, false).unwrap());
        assert!(!w.write_audio(&SILENT_AAC_STEREO, 0, 213_333).unwrap());
        assert!(!p.exists() || std::fs::metadata(&p).unwrap().len() == 0);
        feed(&mut w, 3, 0, 50_000);
        let done = w.finish().unwrap().unwrap();
        assert_eq!(done.video_frames, 180);
        let info = mp4::read(&p).unwrap();
        assert_eq!(info.layout, Layout::Regular);
        let v = info.video().unwrap();
        assert_eq!(v.config.timescale, 60_000);
        // Every frame exactly one 1/60 s step.
        assert!(v.samples.windows(2).all(|x| x[1].dts - x[0].dts == 1000));
        if let Some(pr) = testdata::probe(&p) {
            assert_eq!(pr.packets("h264"), Some(180), "{pr:?}");
            assert!(pr.packets("aac").unwrap_or(0) >= 140, "{pr:?}");
            assert!((pr.format_duration().unwrap() - 3.0).abs() < 0.05, "{pr:?}");
        }
        if let Some(e) = testdata::decode_errors(&p) {
            assert!(e.trim().is_empty(), "{e}");
        }
    }

    #[test]
    fn nothing_written_means_no_file() {
        let p = tmp("stream-none.mp4");
        let _ = std::fs::remove_file(&p);
        let w = StreamWriter::new(&p, Format::Mp4, Mode::Hybrid, info(true));
        assert!(w.finish().unwrap().is_none());
        assert!(!p.exists());
    }

    #[test]
    fn mkv_recordings_play_and_remux() {
        let p = tmp("stream-rec.mkv");
        let mut w = StreamWriter::new(&p, Format::Mkv, Mode::Hybrid, info(true));
        feed(&mut w, 2, 0, 0);
        w.finish().unwrap().unwrap();
        if let Some(pr) = testdata::probe(&p) {
            assert_eq!(pr.packets("h264"), Some(120), "{pr:?}");
        }
        let d = crate::media::container::remux::diagnose(&p).unwrap();
        assert_eq!(d.need, crate::media::container::remux::Need::Remux);
        let r = crate::media::container::remux::fix(&p, &mut |_| {}).unwrap();
        let out = std::path::PathBuf::from(&r.path);
        assert_eq!(out.extension().unwrap(), "mp4");
        let info = mp4::read(&out).unwrap();
        assert_eq!(info.video().unwrap().samples.len(), 120);
    }

    #[test]
    fn odd_frame_rates_get_a_fine_timescale() {
        assert_eq!(video_timescale(60, 1), 60_000);
        assert_eq!(video_timescale(144, 1), 144_000);
        assert_eq!(video_timescale(30_000, 1001), 90_000);
        assert_eq!(video_timescale(0, 1), 90_000);
    }

    #[test]
    fn write_errors_read_plainly() {
        assert_eq!(describe_write_error(&io::Error::from_raw_os_error(112)), "The disk is full");
        assert_eq!(describe_write_error(&io::Error::from_raw_os_error(21)), "The drive was removed or stopped responding");
        assert!(describe_write_error(&io::Error::new(io::ErrorKind::Other, "x")).starts_with("The file could not"));
    }
}
