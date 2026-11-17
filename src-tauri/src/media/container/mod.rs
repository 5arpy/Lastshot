//! Lastshot's own containers, fed with already-encoded samples:
//!
//! * [`mp4`]: the MP4 writer (crash-safe "hybrid" mode for recordings, plain
//!   mode for replays and remuxes) and an MP4 reader (regular, fragmented, and
//!   recordings cut off by a crash).
//! * [`mkv`]: the Matroska writer and reader.
//! * [`remux`]: one place that turns MKV, fragmented or crash-broken MP4 into
//!   a normal MP4 (and repairs our own cut-off recordings in place).
//! * [`codec`]: the codec glue both containers need (Annex B to length
//!   prefixed NAL units, avcC / hvcC / av1C records, AAC config).
//!
//! Pure Rust, no extra crates: the free exe stays small. Every writer keeps
//! its hot path free of per-sample allocations (buffers are reused).

pub mod codec;
pub mod mkv;
pub mod mp4;
pub mod remux;

#[cfg(test)]
pub(crate) mod testdata;

use std::io;

/// Codecs the containers carry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CodecId {
    H264,
    Hevc,
    Av1,
    Aac,
}

impl CodecId {
    pub fn is_video(self) -> bool {
        !matches!(self, CodecId::Aac)
    }
    pub fn label(self) -> &'static str {
        match self {
            CodecId::H264 => "H.264",
            CodecId::Hevc => "HEVC",
            CodecId::Av1 => "AV1",
            CodecId::Aac => "AAC",
        }
    }
}

/// Everything a container needs to describe one track.
#[derive(Debug, Clone, PartialEq)]
pub struct TrackConfig {
    pub codec: CodecId,
    /// Ticks per second of this track's timestamps.
    pub timescale: u32,
    pub width: u32,
    pub height: u32,
    pub sample_rate: u32,
    pub channels: u16,
    /// avcC / hvcC / av1C record (the box payload), or the AAC
    /// AudioSpecificConfig.
    pub config: Vec<u8>,
    /// Average bits per second (0 = unknown).
    pub bitrate: u32,
}

impl TrackConfig {
    pub fn video(codec: CodecId, timescale: u32, width: u32, height: u32, config: Vec<u8>) -> Self {
        Self { codec, timescale, width, height, sample_rate: 0, channels: 0, config, bitrate: 0 }
    }
    pub fn aac(sample_rate: u32, channels: u16, bitrate: u32) -> Self {
        Self {
            codec: CodecId::Aac,
            timescale: sample_rate,
            width: 0,
            height: 0,
            sample_rate,
            channels,
            config: codec::aac_config(sample_rate, channels).to_vec(),
            bitrate,
        }
    }
    pub fn is_video(&self) -> bool {
        self.codec.is_video()
    }
}

/// One stored sample: where its bytes are and its times (track ticks).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SampleRef {
    pub offset: u64,
    pub size: u32,
    /// Decode time.
    pub dts: i64,
    /// Presentation time minus decode time.
    pub cts: i32,
    pub duration: u32,
    pub key: bool,
}

/// A track as read from a file.
#[derive(Debug, Clone)]
pub struct TrackData {
    pub config: TrackConfig,
    pub samples: Vec<SampleRef>,
}

impl TrackData {
    /// Seconds from the first sample's start to the last sample's end.
    pub fn duration_seconds(&self) -> f64 {
        match (self.samples.first(), self.samples.last()) {
            (Some(a), Some(b)) => {
                (b.dts + b.duration as i64 - a.dts) as f64 / self.config.timescale.max(1) as f64
            }
            _ => 0.0,
        }
    }
}

pub(crate) fn bad(msg: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, msg.into())
}

/// Converts `hns` (100 ns units) to ticks of `timescale`, rounding to nearest.
#[inline]
pub fn hns_to_ticks(hns: i64, timescale: u32) -> i64 {
    let v = hns as i128 * timescale as i128;
    let half = if v >= 0 { 5_000_000 } else { -5_000_000 };
    ((v + half) / 10_000_000) as i64
}

/// Converts ticks of `timescale` to hns.
#[inline]
pub fn ticks_to_hns(ticks: i64, timescale: u32) -> i64 {
    (ticks as i128 * 10_000_000 / timescale.max(1) as i128) as i64
}

/// Syncs a file's data and size to the disk (power-loss safety).
pub fn sync_file(f: &std::fs::File) {
    let _ = f.sync_data();
}
