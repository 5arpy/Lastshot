//! Matroska (MKV / WebM) writer and reader.
//!
//! * Writer, made for recordings: the Segment keeps an "unknown" size until
//!   [`MkvWriter::finish`] and every Cluster is written in one piece with a
//!   known size, so a file cut off at any byte (crash, kill, power loss) still
//!   plays up to its last complete Cluster. `finish` adds the Cues, fills the
//!   SeekHead room kept at the start, the Duration and the Segment size.
//! * Reader: streams through the file (block payloads are seeked over, never
//!   loaded) and returns where every frame is, so a remux copies each byte
//!   once. Files cut off anywhere read up to their last complete block.

use super::{bad, codec, sync_file, CodecId, SampleRef, TrackConfig, TrackData};
use std::fs::File;
use std::io::{self, BufReader, Read, Seek, SeekFrom, Write};
use std::path::Path;

// ---------------------------------------------------------------- element IDs

const EBML: u32 = 0x1A45_DFA3;
const EBML_VERSION: u32 = 0x4286;
const EBML_READ_VERSION: u32 = 0x42F7;
const EBML_MAX_ID_LENGTH: u32 = 0x42F2;
const EBML_MAX_SIZE_LENGTH: u32 = 0x42F3;
const DOC_TYPE: u32 = 0x4282;
const DOC_TYPE_VERSION: u32 = 0x4287;
const DOC_TYPE_READ_VERSION: u32 = 0x4285;
const VOID: u32 = 0xEC;
const SEGMENT: u32 = 0x1853_8067;
const SEEK_HEAD: u32 = 0x114D_9B74;
const SEEK: u32 = 0x4DBB;
const SEEK_ID: u32 = 0x53AB;
const SEEK_POSITION: u32 = 0x53AC;
const INFO: u32 = 0x1549_A966;
const TIMESTAMP_SCALE: u32 = 0x2A_D7B1;
const DURATION: u32 = 0x4489;
const MUXING_APP: u32 = 0x4D80;
const WRITING_APP: u32 = 0x5741;
const TRACKS: u32 = 0x1654_AE6B;
const TRACK_ENTRY: u32 = 0xAE;
const TRACK_NUMBER: u32 = 0xD7;
const TRACK_UID: u32 = 0x73C5;
const TRACK_TYPE: u32 = 0x83;
const FLAG_LACING: u32 = 0x9C;
const LANGUAGE: u32 = 0x22_B59C;
const DEFAULT_DURATION: u32 = 0x23_E383;
const CODEC_ID: u32 = 0x86;
const CODEC_PRIVATE: u32 = 0x63A2;
const CODEC_DELAY: u32 = 0x56AA;
const CONTENT_ENCODINGS: u32 = 0x6D80;
const VIDEO: u32 = 0xE0;
const PIXEL_WIDTH: u32 = 0xB0;
const PIXEL_HEIGHT: u32 = 0xBA;
const AUDIO: u32 = 0xE1;
const SAMPLING_FREQUENCY: u32 = 0xB5;
const CHANNELS: u32 = 0x9F;
const CLUSTER: u32 = 0x1F43_B675;
const TIMESTAMP: u32 = 0xE7;
const SIMPLE_BLOCK: u32 = 0xA3;
const BLOCK_GROUP: u32 = 0xA0;
const BLOCK: u32 = 0xA1;
const BLOCK_DURATION: u32 = 0x9B;
const REFERENCE_BLOCK: u32 = 0xFB;
const CUES: u32 = 0x1C53_BB6B;
const CUE_POINT: u32 = 0xBB;
const CUE_TIME: u32 = 0xB3;
const CUE_TRACK_POSITIONS: u32 = 0xB7;
const CUE_TRACK: u32 = 0xF7;
const CUE_CLUSTER_POSITION: u32 = 0xF1;
const CUE_RELATIVE_POSITION: u32 = 0xF0;
const TAGS: u32 = 0x1254_C367;
const CHAPTERS: u32 = 0x1043_A770;
const ATTACHMENTS: u32 = 0x1941_A469;

/// IDs that end an unknown-size Cluster: the next Segment child (or file).
const TOP_LEVEL: [u32; 10] = [CLUSTER, CUES, TAGS, SEEK_HEAD, INFO, TRACKS, CHAPTERS, ATTACHMENTS, EBML, SEGMENT];

/// "Size unknown" in its 8-byte form (the Segment size until `finish`).
const UNKNOWN_SIZE: [u8; 8] = [0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF];

// --------------------------------------------------------- element writing

fn put_id(b: &mut Vec<u8>, id: u32) {
    let n = 4 - (id.leading_zeros() / 8) as usize;
    b.extend_from_slice(&id.to_be_bytes()[4 - n..]);
}

/// `v` as an `n`-byte EBML variable size integer.
fn put_vint(b: &mut Vec<u8>, v: u64, n: usize) {
    b.extend_from_slice(&(v | 1 << (7 * n)).to_be_bytes()[8 - n..]);
}

fn size_len(v: u64) -> usize {
    // All value bits set means "unknown", so each length holds one value less.
    (1..8).find(|&n| v < (1 << (7 * n)) - 1).unwrap_or(8)
}

fn put_size(b: &mut Vec<u8>, v: u64) {
    put_vint(b, v, size_len(v));
}

fn put_uint(b: &mut Vec<u8>, id: u32, v: u64) {
    let n = (8 - v.leading_zeros() as usize / 8).max(1);
    put_id(b, id);
    put_size(b, n as u64);
    b.extend_from_slice(&v.to_be_bytes()[8 - n..]);
}

fn put_float(b: &mut Vec<u8>, id: u32, v: f64) {
    put_id(b, id);
    b.push(0x88);
    b.extend_from_slice(&v.to_be_bytes());
}

fn put_bytes(b: &mut Vec<u8>, id: u32, data: &[u8]) {
    put_id(b, id);
    put_size(b, data.len() as u64);
    b.extend_from_slice(data);
}

/// Opens a master element with a 4-byte size that [`end`] fills in, so
/// offsets inside it are known while it is being built.
fn begin(b: &mut Vec<u8>, id: u32) -> usize {
    put_id(b, id);
    b.extend_from_slice(&[0x10, 0, 0, 0]);
    b.len()
}

fn end(b: &mut [u8], at: usize) {
    let n = (b.len() - at) as u32;
    debug_assert!(n < (1 << 28) - 1);
    b[at - 4..at].copy_from_slice(&(n | 0x1000_0000).to_be_bytes());
}

/// A Void element of exactly `total` (>= 2) bytes.
fn put_void(b: &mut Vec<u8>, total: usize) {
    let n = if total - 2 <= 126 { 1 } else { 8 };
    b.push(VOID as u8);
    put_vint(b, (total - 1 - n) as u64, n);
    b.resize(b.len() + total - 1 - n, 0);
}

/// DefaultDuration with a fixed 8-byte value: the same 12 bytes as its Void slot.
fn put_default_duration(b: &mut Vec<u8>, ns: u64) {
    put_id(b, DEFAULT_DURATION);
    b.push(0x88);
    b.extend_from_slice(&ns.to_be_bytes());
}

fn put_seek(b: &mut Vec<u8>, id: u32, pos: u64) {
    let m = begin(b, SEEK);
    put_bytes(b, SEEK_ID, &id.to_be_bytes());
    put_uint(b, SEEK_POSITION, pos);
    end(b, m);
}

fn codec_name(c: CodecId) -> &'static str {
    match c {
        CodecId::H264 => "V_MPEG4/ISO/AVC",
        CodecId::Hevc => "V_MPEGH/ISO/HEVC",
        CodecId::Av1 => "V_AV1",
        CodecId::Aac => "A_AAC",
    }
}

/// AAC-LC frames always hold 1024 samples, so their duration is known before
/// the first one (and stays right in a file that is never finished).
fn aac_frame_ns(c: &TrackConfig) -> Option<u64> {
    let lc = c.codec == CodecId::Aac && c.config.first().map(|b| b >> 3) == Some(2);
    let rate = c.sample_rate as u64;
    (lc && rate > 0).then(|| (1024 * 1_000_000_000 + rate / 2) / rate)
}

/// Ticks to milliseconds (the file's TimestampScale), rounded to nearest.
fn ticks_to_ms(ticks: i64, timescale: u32) -> i64 {
    div_round(ticks as i128 * 1000, timescale.max(1) as i128) as i64
}

fn div_round(n: i128, d: i128) -> i128 {
    if n >= 0 {
        (n + d / 2) / d
    } else {
        (n - d / 2) / d
    }
}

// -------------------------------------------------------------------- writer

/// Room kept after the Segment header for the SeekHead `finish` writes (it
/// needs at most 80 bytes; the rest stays a Void).
const SEEK_HEAD_ROOM: usize = 96;
/// Bytes kept in front of a buffered Cluster for its ID and size, so the
/// whole Cluster goes out in one write.
const CLUSTER_HEAD: usize = 12;
const CLUSTER_MAX_MS: i64 = 5_000;
const CLUSTER_MAX_BYTES: usize = 32 << 20;
/// A new Cluster starts at a video keyframe once the open one is this long.
const CLUSTER_KEY_MS: i64 = 1_000;
/// Keyframes closer than this to the previous cue are not indexed, which keeps
/// the Cues small for all-intra video while seeking stays exact enough.
const CUE_SPACING_MS: i64 = 500;
/// Largest block a 4-byte EBML size can describe.
const MAX_BLOCK: usize = (1 << 28) - 2;

pub struct MkvWriter {
    file: File,
    tracks: Vec<WTrack>,
    seg_size_at: u64,
    /// Start of the Segment data (where SeekHead and Cues positions count from,
    /// and where the SeekHead room is).
    seg_start: u64,
    duration_at: u64,
    info_at: u64,
    tracks_at: u64,
    pos: u64,
    /// The open Cluster: CLUSTER_HEAD spare bytes, its Timestamp, its blocks.
    cluster: Vec<u8>,
    /// Length of `cluster` up to its last complete block (a `fill` that
    /// panicked leaves a partial one behind, which is never written).
    cluster_done: usize,
    /// Timestamp (ms) of the open Cluster.
    cluster_ms: Option<i64>,
    cues: Vec<Cue>,
    cue_track: usize,
    next_cue_ms: i64,
    end_ms: i64,
}

struct WTrack {
    timescale: u32,
    video: bool,
    /// File offset of the 12-byte DefaultDuration slot `finish` may fill.
    slot_at: u64,
    last_pts: Option<i64>,
    first_dur: u32,
    // Spread of the pts steps: a constant step becomes the DefaultDuration.
    step_min: i64,
    step_max: i64,
    step_sum: i128,
    steps: u64,
}

impl WTrack {
    fn note(&mut self, pts: i64, dur: u32) {
        match self.last_pts {
            Some(last) => {
                let d = pts.saturating_sub(last);
                self.step_min = self.step_min.min(d);
                self.step_max = self.step_max.max(d);
                self.step_sum += d as i128;
                self.steps += 1;
            }
            None => self.first_dur = dur,
        }
        self.last_pts = Some(pts);
    }

    /// Frame duration (ns) when the track ran at a constant rate. A variable
    /// rate track gets none: a DefaultDuration would then lie about the gaps.
    fn frame_ns(&self) -> Option<u64> {
        let (sum, n) = if self.steps == 0 {
            (self.first_dur as i128, 1)
        } else if self.step_min > 0 && self.step_max.saturating_sub(self.step_min) <= 1 {
            (self.step_sum, self.steps as i128)
        } else {
            return None;
        };
        let den = n * self.timescale as i128;
        (sum > 0).then(|| div_round(sum * 1_000_000_000, den) as u64)
    }
}

struct Cue {
    ms: u64,
    track: u64,
    /// Cluster position (from the Segment data start) and block position
    /// inside the Cluster data.
    cluster: u64,
    rel: u64,
}

impl MkvWriter {
    /// Writes the EBML header, Segment (unknown size), a Void reserved for the
    /// SeekHead, Info, Tracks.
    pub fn create(path: &Path, tracks: Vec<TrackConfig>) -> io::Result<Self> {
        if tracks.is_empty() || tracks.len() > 126 {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "an MKV file takes 1 to 126 tracks"));
        }
        let mut b = Vec::with_capacity(1024 + tracks.iter().map(|t| t.config.len()).sum::<usize>());
        let m = begin(&mut b, EBML);
        put_uint(&mut b, EBML_VERSION, 1);
        put_uint(&mut b, EBML_READ_VERSION, 1);
        put_uint(&mut b, EBML_MAX_ID_LENGTH, 4);
        put_uint(&mut b, EBML_MAX_SIZE_LENGTH, 8);
        put_bytes(&mut b, DOC_TYPE, b"matroska");
        put_uint(&mut b, DOC_TYPE_VERSION, 4);
        put_uint(&mut b, DOC_TYPE_READ_VERSION, 2);
        end(&mut b, m);
        put_id(&mut b, SEGMENT);
        let seg_size_at = b.len() as u64;
        b.extend_from_slice(&UNKNOWN_SIZE);
        let seg_start = b.len() as u64;
        put_void(&mut b, SEEK_HEAD_ROOM);

        let info_at = b.len() as u64;
        let m = begin(&mut b, INFO);
        put_uint(&mut b, TIMESTAMP_SCALE, 1_000_000);
        put_bytes(&mut b, MUXING_APP, b"Lastshot");
        put_bytes(&mut b, WRITING_APP, b"Lastshot");
        // Duration must be > 0, so it stays a Void until `finish` knows it.
        let duration_at = b.len() as u64;
        put_void(&mut b, 11);
        end(&mut b, m);

        let tracks_at = b.len() as u64;
        let m = begin(&mut b, TRACKS);
        let mut wt = Vec::with_capacity(tracks.len());
        for (i, c) in tracks.iter().enumerate() {
            let e = begin(&mut b, TRACK_ENTRY);
            let number = i as u64 + 1;
            put_uint(&mut b, TRACK_NUMBER, number);
            put_uint(&mut b, TRACK_UID, number);
            put_uint(&mut b, TRACK_TYPE, if c.is_video() { 1 } else { 2 });
            put_uint(&mut b, FLAG_LACING, 0);
            put_bytes(&mut b, LANGUAGE, b"und");
            put_bytes(&mut b, CODEC_ID, codec_name(c.codec).as_bytes());
            if !c.config.is_empty() {
                put_bytes(&mut b, CODEC_PRIVATE, &c.config);
            }
            let slot_at = b.len() as u64;
            match aac_frame_ns(c) {
                Some(ns) => put_default_duration(&mut b, ns),
                None => put_void(&mut b, 12),
            }
            if c.is_video() {
                let v = begin(&mut b, VIDEO);
                put_uint(&mut b, PIXEL_WIDTH, c.width as u64);
                put_uint(&mut b, PIXEL_HEIGHT, c.height as u64);
                end(&mut b, v);
            } else {
                let a = begin(&mut b, AUDIO);
                put_float(&mut b, SAMPLING_FREQUENCY, c.sample_rate as f64);
                put_uint(&mut b, CHANNELS, c.channels.max(1) as u64);
                end(&mut b, a);
            }
            end(&mut b, e);
            wt.push(WTrack {
                timescale: c.timescale.max(1),
                video: c.is_video(),
                slot_at,
                last_pts: None,
                first_dur: 0,
                step_min: i64::MAX,
                step_max: i64::MIN,
                step_sum: 0,
                steps: 0,
            });
        }
        end(&mut b, m);

        let mut file = File::create(path)?;
        file.write_all(&b)?;
        let cue_track = wt.iter().position(|t| t.video).unwrap_or(0);
        Ok(Self {
            file,
            tracks: wt,
            seg_size_at,
            seg_start,
            duration_at,
            info_at,
            tracks_at,
            pos: b.len() as u64,
            cluster: Vec::new(),
            cluster_done: 0,
            cluster_ms: None,
            cues: Vec::new(),
            cue_track,
            next_cue_ms: i64::MIN,
            end_ms: 0,
        })
    }

    /// One sample. `pts` is in the track's own ticks (TrackConfig.timescale);
    /// samples of one track arrive in decode order. `fill` appends the sample
    /// bytes (already length-prefixed NALs / AV1 OBUs / raw AAC) to the buffer
    /// it is given.
    pub fn write_sample(&mut self, track: usize, pts: i64, key: bool, dur_hint: u32, fill: impl FnOnce(&mut Vec<u8>)) -> io::Result<()> {
        let Some(t) = self.tracks.get_mut(track) else {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "no such track"));
        };
        t.note(pts, dur_hint);
        let ms = ticks_to_ms(pts, t.timescale);
        self.end_ms = self.end_ms.max(ticks_to_ms(pts.saturating_add(dur_hint as i64), t.timescale));
        let video = t.video;
        let key = key || !video; // every AAC frame is a sync point

        if let Some(start) = self.cluster_ms {
            let span = ms.saturating_sub(start);
            if i16::try_from(span).is_err()
                || span >= CLUSTER_MAX_MS
                || (video && key && span >= CLUSTER_KEY_MS)
                || self.cluster.len() >= CLUSTER_MAX_BYTES
            {
                self.close_cluster()?;
            }
        }
        let start = match self.cluster_ms {
            Some(s) => s,
            None => self.open_cluster(ms),
        };
        // Cluster times are unsigned, so only a time below -32.768 s gets clamped.
        let rel = ms.saturating_sub(start).clamp(i16::MIN as i64, i16::MAX as i64) as i16;
        self.cluster.truncate(self.cluster_done);
        let at = self.cluster.len();
        let [r0, r1] = rel.to_be_bytes();
        // SimpleBlock, 4-byte size filled below, track number, timestamp, flags.
        self.cluster.extend_from_slice(&[0xA3, 0x10, 0, 0, 0, 0x81 + track as u8, r0, r1, if key { 0x80 } else { 0 }]);
        fill(&mut self.cluster);
        let size = self.cluster.len() - at - 5;
        if size > MAX_BLOCK {
            self.cluster.truncate(at);
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "sample larger than 256 MB"));
        }
        self.cluster[at + 1..at + 5].copy_from_slice(&(size as u32 | 0x1000_0000).to_be_bytes());
        self.cluster_done = self.cluster.len();

        if track == self.cue_track && key && ms >= self.next_cue_ms {
            self.cues.push(Cue {
                ms: ms.max(0) as u64,
                track: track as u64 + 1,
                cluster: self.pos - self.seg_start,
                rel: (at - CLUSTER_HEAD) as u64,
            });
            self.next_cue_ms = ms.saturating_add(CUE_SPACING_MS);
        }
        Ok(())
    }

    fn open_cluster(&mut self, ms: i64) -> i64 {
        // Cluster timestamps are unsigned.
        let start = ms.max(0);
        self.cluster.clear();
        self.cluster.resize(CLUSTER_HEAD, 0);
        put_uint(&mut self.cluster, TIMESTAMP, start as u64);
        self.cluster_done = self.cluster.len();
        self.cluster_ms = Some(start);
        start
    }

    fn close_cluster(&mut self) -> io::Result<()> {
        if self.cluster_ms.take().is_none() {
            return Ok(());
        }
        self.cluster.truncate(self.cluster_done);
        let size = (self.cluster.len() - CLUSTER_HEAD) as u64;
        let n = size_len(size);
        let from = CLUSTER_HEAD - 4 - n;
        let head = &mut self.cluster[from..CLUSTER_HEAD];
        head[..4].copy_from_slice(&CLUSTER.to_be_bytes());
        head[4..].copy_from_slice(&(size | 1 << (7 * n)).to_be_bytes()[8 - n..]);
        let res = self.file.write_all(&self.cluster[from..]);
        self.pos += (self.cluster.len() - from) as u64;
        self.cluster.clear();
        res
    }

    /// Writes the buffered cluster to the file now (crash safety: the caller
    /// calls this every ~0.5 s). It reaches the OS, not the disk: a killed
    /// process loses nothing written, power loss needs `sync_file`.
    pub fn flush(&mut self) -> io::Result<()> {
        self.close_cluster()
    }

    /// Bytes written so far (file size).
    pub fn bytes_written(&self) -> u64 {
        self.pos
    }

    /// Writes Cues, fills the SeekHead into the reserved Void, the Segment
    /// size and Info/Duration; syncs.
    pub fn finish(mut self) -> io::Result<()> {
        self.close_cluster()?;
        let mut b = std::mem::take(&mut self.cluster);
        b.clear();
        let cues_at = self.pos;
        if !self.cues.is_empty() {
            let m = begin(&mut b, CUES);
            for c in &self.cues {
                let p = begin(&mut b, CUE_POINT);
                put_uint(&mut b, CUE_TIME, c.ms);
                let t = begin(&mut b, CUE_TRACK_POSITIONS);
                put_uint(&mut b, CUE_TRACK, c.track);
                put_uint(&mut b, CUE_CLUSTER_POSITION, c.cluster);
                put_uint(&mut b, CUE_RELATIVE_POSITION, c.rel);
                end(&mut b, t);
                end(&mut b, p);
            }
            end(&mut b, m);
            self.file.write_all(&b)?;
            self.pos += b.len() as u64;
        }

        b.clear();
        let m = begin(&mut b, SEEK_HEAD);
        put_seek(&mut b, INFO, self.info_at - self.seg_start);
        put_seek(&mut b, TRACKS, self.tracks_at - self.seg_start);
        if !self.cues.is_empty() {
            put_seek(&mut b, CUES, cues_at - self.seg_start);
        }
        end(&mut b, m);
        let room = SEEK_HEAD_ROOM - b.len();
        put_void(&mut b, room);
        self.write_at(self.seg_start, &b)?;

        if self.end_ms > 0 {
            b.clear();
            put_float(&mut b, DURATION, self.end_ms as f64);
            self.write_at(self.duration_at, &b)?;
        }
        let slots: Vec<(u64, u64)> = self.tracks.iter().filter_map(|t| Some((t.slot_at, t.frame_ns()?))).collect();
        for (at, ns) in slots {
            b.clear();
            put_default_duration(&mut b, ns);
            self.write_at(at, &b)?;
        }
        // The Segment size goes last: until here the file stays a valid
        // unknown-size Segment whatever happens.
        let mut size = UNKNOWN_SIZE;
        size[1..].copy_from_slice(&(self.pos - self.seg_start).to_be_bytes()[1..]);
        self.write_at(self.seg_size_at, &size)?;
        sync_file(&self.file);
        Ok(())
    }

    fn write_at(&mut self, at: u64, data: &[u8]) -> io::Result<()> {
        self.file.seek(SeekFrom::Start(at))?;
        self.file.write_all(data)
    }
}

impl Drop for MkvWriter {
    /// A writer dropped without `finish` (error path, unwinding) still writes
    /// what it buffered; the file then reads like one cut after that Cluster.
    fn drop(&mut self) {
        let _ = self.close_cluster();
    }
}

// -------------------------------------------------------------------- reader

/// What [`read`] found.
#[derive(Debug, Clone)]
pub struct MkvInfo {
    pub tracks: Vec<TrackData>,
    /// Codec IDs of the tracks left out (unsupported codec, or frames stored
    /// compressed / encrypted).
    pub skipped: Vec<String>,
    /// The file ends inside an element or runs into unreadable data (a crash
    /// or a cut copy); everything before that is in `tracks`.
    pub truncated: bool,
    pub duration_seconds: f64,
}

/// True when the data starts with the EBML magic.
pub fn is_mkv(head: &[u8]) -> bool {
    head.starts_with(&EBML.to_be_bytes())
}

/// Reads a Matroska / WebM file's tracks and frame positions.
pub fn read(path: &Path) -> io::Result<MkvInfo> {
    let f = File::open(path)?;
    let len = f.metadata()?.len();
    parse(f, len)
}

/// Element reads are capped so garbage sizes cannot make us allocate.
const MAX_HEADER_ELEMENT: u64 = 64 << 20;
const MAX_CODEC_PRIVATE: usize = 16 << 20;
/// Placeholder for "duration not known" while blocks are collected.
const UNKNOWN_DUR: u32 = u32::MAX;

fn eof() -> io::Error {
    io::Error::new(io::ErrorKind::UnexpectedEof, "file ends inside an element")
}

/// Value of an EBML variable size integer at the start of `d`: (value
/// without the length marker, length, all value bits set = "unknown").
fn vint(d: &[u8]) -> Option<(u64, usize, bool)> {
    let first = *d.first()?;
    let len = first.leading_zeros() as usize + 1;
    if len > 8 || d.len() < len {
        return None;
    }
    let v = d[1..len].iter().fold(first as u64 & (0xFF >> len), |a, &b| a << 8 | b as u64);
    Some((v, len, v == (1 << (7 * len)) - 1))
}

/// Element ID (marker bits kept, as the IDs are written) and its length.
fn id_at(d: &[u8]) -> Option<(u32, usize)> {
    let len = d.first()?.leading_zeros() as usize + 1;
    if len > 4 || d.len() < len {
        return None;
    }
    Some((d[..len].iter().fold(0, |a, &b| a << 8 | b as u32), len))
}

/// Children of an in-memory master element; stops at the first broken one.
fn elems<'a>(mut d: &'a [u8]) -> impl Iterator<Item = (u32, &'a [u8])> + 'a {
    std::iter::from_fn(move || {
        let (id, a) = id_at(d)?;
        let (n, b, unknown) = vint(&d[a..])?;
        let body = &d[a + b..];
        let n = if unknown { body.len() } else { usize::try_from(n).ok().filter(|&n| n <= body.len())? };
        let (v, rest) = body.split_at(n);
        d = rest;
        Some((id, v))
    })
}

fn uint(v: &[u8]) -> Option<u64> {
    (v.len() <= 8).then(|| v.iter().fold(0, |a, &b| a << 8 | b as u64))
}

fn float(v: &[u8]) -> Option<f64> {
    match v.len() {
        4 => Some(f32::from_be_bytes(v.try_into().ok()?) as f64),
        8 => Some(f64::from_be_bytes(v.try_into().ok()?)),
        _ => None,
    }
}

fn string(v: &[u8]) -> String {
    String::from_utf8_lossy(v).trim_end_matches('\0').to_string()
}

/// Buffered reading with the position kept, bounded by the file length.
struct Src<R> {
    r: BufReader<R>,
    pos: u64,
    len: u64,
}

impl<R: Read + Seek> Src<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<()> {
        if self.pos + buf.len() as u64 > self.len {
            return Err(eof());
        }
        self.r.read_exact(buf)?;
        self.pos += buf.len() as u64;
        Ok(())
    }

    fn u8(&mut self) -> io::Result<u8> {
        let mut b = [0];
        self.read(&mut b)?;
        Ok(b[0])
    }

    fn vint(&mut self) -> io::Result<(u64, usize, bool)> {
        let mut b = [0u8; 8];
        b[0] = self.u8()?;
        let len = b[0].leading_zeros() as usize + 1;
        if len > 8 {
            return Err(bad("broken EBML number"));
        }
        self.read(&mut b[1..len])?;
        vint(&b[..len]).ok_or_else(|| bad("broken EBML number"))
    }

    fn id(&mut self) -> io::Result<u32> {
        let mut b = [0u8; 4];
        b[0] = self.u8()?;
        let len = b[0].leading_zeros() as usize + 1;
        if len > 4 {
            return Err(bad("broken element ID"));
        }
        self.read(&mut b[1..len])?;
        Ok(b[..len].iter().fold(0, |a, &x| a << 8 | x as u32))
    }

    /// Element size; None = unknown.
    fn size(&mut self) -> io::Result<Option<u64>> {
        let (v, _, unknown) = self.vint()?;
        Ok((!unknown).then_some(v))
    }

    fn known_size(&mut self) -> io::Result<u64> {
        self.size()?.ok_or_else(|| bad("unknown size where it is not allowed"))
    }

    fn skip(&mut self, n: u64) -> io::Result<()> {
        let to = self.pos.checked_add(n).filter(|&t| t <= self.len).ok_or_else(eof)?;
        self.r.seek_relative(i64::try_from(n).map_err(|_| eof())?)?;
        self.pos = to;
        Ok(())
    }

    fn bytes(&mut self, n: u64, cap: u64) -> io::Result<Vec<u8>> {
        if n > cap {
            return Err(bad("element too large"));
        }
        if self.pos + n > self.len {
            return Err(eof());
        }
        let mut v = vec![0; n as usize];
        self.read(&mut v)?;
        Ok(v)
    }

    fn uint(&mut self, n: u64) -> io::Result<u64> {
        if n > 8 {
            return Err(bad("integer longer than 8 bytes"));
        }
        let mut b = [0u8; 8];
        self.read(&mut b[8 - n as usize..])?;
        Ok(u64::from_be_bytes(b))
    }
}

struct RTrack {
    number: u64,
    name: String,
    /// None when the track is skipped.
    config: Option<TrackConfig>,
    default_ns: Option<u64>,
    delay_ns: u64,
}

fn track_entry(e: &[u8]) -> RTrack {
    let (mut number, mut name, mut private, mut default_ns, mut problem) = (0, String::new(), None, None, None);
    let mut delay_ns = 0;
    let (mut width, mut height, mut rate, mut channels) = (0, 0, 8000.0, 1);
    for (id, v) in elems(e) {
        match id {
            TRACK_NUMBER => number = uint(v).unwrap_or(0),
            CODEC_ID => name = string(v),
            CODEC_PRIVATE if v.len() > MAX_CODEC_PRIVATE => problem = Some("CodecPrivate too large"),
            CODEC_PRIVATE => private = Some(v),
            DEFAULT_DURATION => default_ns = uint(v).filter(|&d| d > 0),
            // Encoder priming (ffmpeg writes it for AAC): block times include it.
            CODEC_DELAY => delay_ns = uint(v).unwrap_or(0),
            // Header stripping or encryption: the stored bytes are not the frames.
            CONTENT_ENCODINGS => problem = Some("content encoding"),
            VIDEO => {
                for (id, v) in elems(v) {
                    match id {
                        PIXEL_WIDTH => width = uint(v).and_then(|x| u32::try_from(x).ok()).unwrap_or(0),
                        PIXEL_HEIGHT => height = uint(v).and_then(|x| u32::try_from(x).ok()).unwrap_or(0),
                        _ => {}
                    }
                }
            }
            AUDIO => {
                for (id, v) in elems(v) {
                    match id {
                        SAMPLING_FREQUENCY => rate = float(v).unwrap_or(rate),
                        CHANNELS => channels = uint(v).and_then(|x| u16::try_from(x).ok()).unwrap_or(1),
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    let codec = match name.as_str() {
        "V_MPEG4/ISO/AVC" => Some(CodecId::H264),
        "V_MPEGH/ISO/HEVC" => Some(CodecId::Hevc),
        "V_AV1" => Some(CodecId::Av1),
        n if n.starts_with("A_AAC") => Some(CodecId::Aac),
        _ => None,
    };
    let config = match (codec, problem) {
        (Some(codec), None) => {
            let audio = codec == CodecId::Aac;
            let sample_rate = if audio { rate.round() as u32 } else { 0 };
            let channels = if audio { channels } else { 0 };
            let config = match private.filter(|p: &&[u8]| !p.is_empty()) {
                Some(p) => p.to_vec(),
                // Old A_AAC/MPEG4/LC style IDs carry no AudioSpecificConfig.
                None if audio => codec::aac_config(sample_rate, channels).to_vec(),
                None => Vec::new(),
            };
            // The timescale is set once Info's TimestampScale is surely known.
            Some(TrackConfig { codec, timescale: 0, width, height, sample_rate, channels, config, bitrate: 0 })
        }
        _ => None,
    };
    let name = match problem {
        Some(p) => format!("{name} ({p})"),
        None => name,
    };
    RTrack { number, name, config, default_ns, delay_ns }
}

/// One Block's header; its frame sizes are in `State::laces`.
struct Blk {
    track: u64,
    rel: i16,
    flags: u8,
    /// File offset of the first frame.
    data: u64,
}

struct State {
    scale: u64,
    duration: Option<f64>,
    tracks: Option<Vec<RTrack>>,
    /// Frames per track number. Until `into_info` their times are raw: `dts`
    /// is the block timestamp, `duration` the BlockDuration (or UNKNOWN_DUR),
    /// and `cts` the place in a lace (index << 9 | count, 0 = not laced).
    blocks: Vec<(u64, Vec<SampleRef>)>,
    laces: Vec<u64>,
    truncated: bool,
}

/// Reads a whole file from any seekable source of `len` bytes.
fn parse<R: Read + Seek>(r: R, len: u64) -> io::Result<MkvInfo> {
    let mut s = Src { r: BufReader::with_capacity(32 << 10, r), pos: 0, len };
    let mut magic = [0u8; 4];
    if s.read(&mut magic).is_err() || !is_mkv(&magic) {
        return Err(bad("not a Matroska file"));
    }
    let n = s.known_size()?;
    let head = s.bytes(n, 1 << 16)?;
    let doc = elems(&head).find(|e| e.0 == DOC_TYPE).map(|e| string(e.1)).unwrap_or_else(|| "matroska".into());
    if doc != "matroska" && doc != "webm" {
        return Err(bad(format!("not a Matroska file (DocType {doc})")));
    }
    let seg_end = loop {
        let id = s.id()?;
        let size = s.size()?;
        if id == SEGMENT {
            break size.map_or(u64::MAX, |n| s.pos.saturating_add(n));
        }
        s.skip(size.ok_or_else(|| bad("unknown size before the Segment"))?)?;
    };
    let mut st = State { scale: 1_000_000, duration: None, tracks: None, blocks: Vec::new(), laces: Vec::new(), truncated: false };
    match segment(&mut s, &mut st, seg_end) {
        Ok(()) => {}
        // A cut or garbage tail: keep what came before, once the tracks are known.
        Err(e) if st.tracks.is_some() && matches!(e.kind(), io::ErrorKind::UnexpectedEof | io::ErrorKind::InvalidData) => {
            st.truncated = true
        }
        Err(e) => return Err(e),
    }
    if st.tracks.is_none() {
        return Err(bad("Matroska file without a track list"));
    }
    Ok(st.into_info())
}

fn segment<R: Read + Seek>(s: &mut Src<R>, st: &mut State, end: u64) -> io::Result<()> {
    let mut pending = None;
    while s.pos < end {
        let id = match pending.take() {
            Some(id) => id,
            None if end == u64::MAX && s.pos >= s.len => return Ok(()),
            None => s.id()?,
        };
        let size = s.size()?;
        match id {
            CLUSTER => pending = cluster(s, st, size, end)?,
            INFO | TRACKS => {
                let n = size.ok_or_else(|| bad("unknown-size Info or Tracks"))?;
                let data = s.bytes(n, MAX_HEADER_ELEMENT)?;
                if id == INFO {
                    for (id, v) in elems(&data) {
                        match id {
                            TIMESTAMP_SCALE => st.scale = uint(v).filter(|&x| x > 0).unwrap_or(st.scale),
                            DURATION => st.duration = float(v),
                            _ => {}
                        }
                    }
                } else if st.tracks.is_none() {
                    st.tracks = Some(elems(&data).filter(|e| e.0 == TRACK_ENTRY).map(|e| track_entry(e.1)).collect());
                }
            }
            // A second file glued on: only the first one is read.
            EBML | SEGMENT => return Ok(()),
            _ => s.skip(size.ok_or_else(|| bad("unknown size where it is not allowed"))?)?,
        }
    }
    Ok(())
}

/// Reads one Cluster. An unknown-size Cluster ends where a top-level element
/// starts; that element's ID is returned for the Segment loop.
fn cluster<R: Read + Seek>(s: &mut Src<R>, st: &mut State, size: Option<u64>, seg_end: u64) -> io::Result<Option<u32>> {
    let end = size.map_or(seg_end, |n| s.pos.saturating_add(n).min(seg_end));
    let mut ts = 0i64;
    while s.pos < end {
        if size.is_none() && s.pos >= s.len {
            return Ok(None);
        }
        let id = s.id()?;
        if size.is_none() && TOP_LEVEL.contains(&id) {
            return Ok(Some(id));
        }
        let n = s.known_size()?;
        let child_end = s.pos.checked_add(n).ok_or_else(|| bad("element size overflows"))?;
        // Only complete elements count: a block cut off by a crash is dropped.
        if child_end > s.len {
            return Err(eof());
        }
        if child_end > end {
            return Err(bad("element runs past its Cluster"));
        }
        match id {
            TIMESTAMP => ts = s.uint(n)? as i64,
            SIMPLE_BLOCK => {
                let b = block(s, &mut st.laces, child_end)?;
                st.push(&b, ts, None, b.flags & 0x80 != 0);
            }
            BLOCK_GROUP => group(s, st, ts, child_end)?,
            _ => s.skip(n)?,
        }
    }
    Ok(None)
}

fn group<R: Read + Seek>(s: &mut Src<R>, st: &mut State, ts: i64, end: u64) -> io::Result<()> {
    let (mut blk, mut dur, mut referenced) = (None, None, false);
    while s.pos < end {
        let id = s.id()?;
        let n = s.known_size()?;
        let child_end = s.pos.checked_add(n).filter(|&e| e <= end).ok_or_else(|| bad("element runs past its BlockGroup"))?;
        match id {
            BLOCK => blk = Some(block(s, &mut st.laces, child_end)?),
            BLOCK_DURATION => dur = Some(s.uint(n)?),
            REFERENCE_BLOCK => {
                referenced = true;
                s.skip(n)?
            }
            _ => s.skip(n)?,
        }
    }
    if let Some(b) = blk {
        st.push(&b, ts, dur, !referenced);
    }
    Ok(())
}

/// Reads a Block / SimpleBlock header and its lace sizes, then seeks past the
/// frames.
fn block<R: Read + Seek>(s: &mut Src<R>, laces: &mut Vec<u64>, end: u64) -> io::Result<Blk> {
    let broken = || bad("broken block");
    let track = s.vint()?.0;
    let mut h = [0u8; 3];
    s.read(&mut h)?;
    let (rel, flags) = (i16::from_be_bytes([h[0], h[1]]), h[2]);
    laces.clear();
    let lacing = (flags >> 1) & 3;
    if lacing != 0 {
        let count = s.u8()? as u64 + 1;
        let room = end.checked_sub(s.pos).ok_or_else(broken)?;
        match lacing {
            // Xiph: each size is a run of 255s plus a last byte below 255.
            1 => {
                for _ in 1..count {
                    let mut v = 0u64;
                    loop {
                        if s.pos >= end {
                            return Err(broken());
                        }
                        let b = s.u8()?;
                        v += b as u64;
                        if b != 255 {
                            break;
                        }
                    }
                    laces.push(v);
                }
            }
            // EBML: the first size, then signed differences to the previous one.
            3 if count > 1 => {
                let mut v = s.vint()?.0 as i64;
                laces.push(v as u64);
                for _ in 2..count {
                    let (raw, len, _) = s.vint()?;
                    v += raw as i64 - ((1i64 << (7 * len - 1)) - 1);
                    if v < 0 || v as u64 > room {
                        return Err(broken());
                    }
                    laces.push(v as u64);
                }
            }
            _ => {}
        }
        let rest = end.checked_sub(s.pos).ok_or_else(broken)?;
        if lacing == 2 {
            if rest % count != 0 {
                return Err(broken());
            }
            laces.resize(count as usize, rest / count);
        } else {
            let used = laces.iter().fold(0u64, |a, &b| a.saturating_add(b));
            laces.push(rest.checked_sub(used).ok_or_else(broken)?);
        }
    } else {
        laces.push(end.checked_sub(s.pos).ok_or_else(broken)?);
    }
    if laces.iter().any(|&n| n > u32::MAX as u64) {
        return Err(broken());
    }
    let data = s.pos;
    s.skip(end - data)?;
    Ok(Blk { track, rel, flags, data })
}

impl State {
    fn push(&mut self, b: &Blk, cluster_ts: i64, dur: Option<u64>, key: bool) {
        let i = match self.blocks.iter().position(|e| e.0 == b.track) {
            Some(i) => i,
            None => {
                self.blocks.push((b.track, Vec::new()));
                self.blocks.len() - 1
            }
        };
        let count = self.laces.len();
        let duration = dur.map_or(UNKNOWN_DUR, |d| d.min(UNKNOWN_DUR as u64 - 1) as u32);
        let mut offset = b.data;
        for (k, &size) in self.laces.iter().enumerate() {
            self.blocks[i].1.push(SampleRef {
                offset,
                size: size as u32,
                dts: cluster_ts.saturating_add(b.rel as i64),
                cts: if count > 1 { (k << 9 | count) as i32 } else { 0 },
                duration,
                key,
            });
            offset += size;
        }
    }

    fn into_info(mut self) -> MkvInfo {
        // Ticks per second; a TimestampScale that does not divide 1 s maps to µs.
        let timescale = if self.scale <= 1_000_000_000 && 1_000_000_000 % self.scale == 0 {
            (1_000_000_000 / self.scale) as u32
        } else {
            1_000_000
        };
        let mut out = MkvInfo { tracks: Vec::new(), skipped: Vec::new(), truncated: self.truncated, duration_seconds: 0.0 };
        let mut seen = Vec::new();
        for mut t in self.tracks.take().unwrap_or_default() {
            if t.number == 0 || seen.contains(&t.number) {
                continue;
            }
            seen.push(t.number);
            let Some(mut config) = t.config.take() else {
                out.skipped.push(t.name);
                continue;
            };
            config.timescale = timescale;
            let mut samples = match self.blocks.iter_mut().find(|b| b.0 == t.number) {
                Some(b) => std::mem::take(&mut b.1),
                None => Vec::new(),
            };
            timing(&mut samples, self.scale, timescale, &t, !config.is_video());
            out.tracks.push(TrackData { config, samples });
        }
        let (mut first, mut last) = (f64::MAX, f64::MIN);
        for t in &out.tracks {
            let ts = t.config.timescale as f64;
            for s in &t.samples {
                first = first.min(s.dts as f64 / ts);
                last = last.max(s.dts.saturating_add(s.duration as i64) as f64 / ts);
            }
        }
        out.duration_seconds = match self.duration {
            // A cut copy of a finished file still claims the full length.
            Some(d) if d > 0.0 && !self.truncated => d * self.scale as f64 / 1e9,
            _ if last >= first => last - first,
            _ => 0.0,
        };
        out
    }
}

/// Turns the raw block times of one track into ticks of `timescale`, spreads
/// laced frames and fills in durations.
fn timing(samples: &mut [SampleRef], scale: u64, timescale: u32, t: &RTrack, audio: bool) {
    let ticks = |ns: i128| div_round(ns * timescale as i128, 1_000_000_000) as i64;
    let to_dur = |d: i64| d.clamp(0, UNKNOWN_DUR as i64 - 1) as u32;
    let default_ns = t.default_ns;
    // Laced frames without any known frame duration: spread later.
    let mut spread = Vec::new();
    for (i, s) in samples.iter_mut().enumerate() {
        let (k, n) = if s.cts != 0 { ((s.cts >> 9) as i128, (s.cts & 511) as i128) } else { (0, 1) };
        let block_ns = s.dts as i128 * scale as i128 - t.delay_ns as i128;
        let block_dur = (s.duration != UNKNOWN_DUR).then(|| s.duration as i128 * scale as i128);
        let frame_ns = if n > 1 {
            default_ns.map(|d| d as i128).or(block_dur.map(|d| d / n))
        } else {
            block_dur.or(default_ns.map(|d| d as i128))
        };
        s.dts = ticks(block_ns + k * frame_ns.unwrap_or(0));
        s.duration = frame_ns.map_or(UNKNOWN_DUR, |d| to_dur(ticks(d)));
        s.cts = 0;
        s.key |= audio;
        if n > 1 && k == 0 && frame_ns.is_none() {
            spread.push((i, n as usize));
        }
    }
    // A lace shares one timestamp: share out the time up to the next block.
    for (i, n) in spread {
        let base = samples[i].dts;
        if let Some(next) = samples.get(i + n).map(|s| s.dts).filter(|&d| d > base) {
            let gap = next as i128 - base as i128;
            for (k, s) in samples[i..i + n].iter_mut().enumerate() {
                s.dts = (base as i128 + gap * k as i128 / n as i128) as i64;
            }
        }
    }
    // Still unknown: the gap to the next presentation time (sorted, so
    // B-frames stored out of order get their own frame's gap).
    if samples.iter().any(|s| s.duration == UNKNOWN_DUR) {
        let mut order: Vec<u32> = (0..samples.len() as u32).collect();
        order.sort_by_key(|&i| samples[i as usize].dts);
        for (w, &i) in order.iter().enumerate() {
            let i = i as usize;
            if samples[i].duration == UNKNOWN_DUR {
                samples[i].duration = order.get(w + 1).map_or(0, |&j| to_dur(samples[j as usize].dts.saturating_sub(samples[i].dts)));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::container::testdata;
    use std::io::Cursor;
    use std::path::PathBuf;
    use std::process::Command;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join("lastshot-mkv-tests");
        std::fs::create_dir_all(&d).unwrap();
        d.join(format!("{}-{name}", std::process::id()))
    }

    /// (seconds, key, bytes) of every sample written, per track.
    type Expect = [Vec<(f64, bool, Vec<u8>)>; 2];

    /// Writes `frames` of 64x48 H.264 at 30 fps (90 kHz ticks) plus AAC for the
    /// same time, interleaved, flushing every 0.5 s.
    fn make(path: &Path, frames: u32, finish: bool) -> Expect {
        let s = testdata::H264Stream::new(64, 48);
        let avcc = codec::video_config(CodecId::H264, &s.header(), &[]).unwrap();
        let tracks = vec![TrackConfig::video(CodecId::H264, 90_000, 64, 48, avcc), TrackConfig::aac(48_000, 2, 192_000)];
        let mut w = MkvWriter::create(path, tracks).unwrap();
        let mut exp: Expect = Default::default();
        let end = frames as f64 / 30.0;
        let (mut v, mut a, mut next_flush) = (0u32, 0u32, 0.5);
        loop {
            let (tv, ta) = (v as f64 / 30.0, a as f64 * 1024.0 / 48_000.0);
            let (video_left, audio_left) = (v < frames, ta < end - 1e-9);
            if !video_left && !audio_left {
                break;
            }
            let video = video_left && (!audio_left || tv <= ta);
            if (if video { tv } else { ta }) >= next_flush {
                w.flush().unwrap();
                next_flush += 0.5;
            }
            if video {
                let (au, key) = s.frame(v, 30);
                let mut bytes = Vec::new();
                codec::append_sample(CodecId::H264, &au, &mut bytes);
                w.write_sample(0, v as i64 * 3000, key, 3000, |b| {
                    codec::append_sample(CodecId::H264, &au, b);
                })
                .unwrap();
                exp[0].push((tv, key, bytes));
                v += 1;
            } else {
                w.write_sample(1, a as i64 * 1024, true, 1024, |b| b.extend_from_slice(&testdata::SILENT_AAC_STEREO)).unwrap();
                exp[1].push((ta, true, testdata::SILENT_AAC_STEREO.to_vec()));
                a += 1;
            }
        }
        if finish {
            w.finish().unwrap();
        }
        exp
    }

    fn check(info: &MkvInfo, exp: &Expect, file: &[u8]) {
        assert_eq!(info.tracks.len(), 2);
        for (t, e) in info.tracks.iter().zip(exp) {
            assert_eq!(t.config.timescale, 1000);
            assert_eq!(t.samples.len(), e.len());
            for (s, (secs, key, bytes)) in t.samples.iter().zip(e) {
                assert_eq!(s.key, *key);
                assert!((s.dts as f64 - secs * 1000.0).abs() <= 0.5 + 1e-6, "{} vs {secs}", s.dts);
                assert_eq!(s.cts, 0);
                assert_eq!(&file[s.offset as usize..][..s.size as usize], &bytes[..]);
            }
        }
    }

    /// Positions of the top-level elements inside the Segment: (id, offset).
    fn top_level(file: &[u8]) -> (usize, Vec<(u32, usize)>) {
        let (_, a) = id_at(file).unwrap();
        let (n, b, _) = vint(&file[a..]).unwrap();
        let seg = a + b + n as usize;
        let (_, c) = id_at(&file[seg..]).unwrap();
        let (_, d, _) = vint(&file[seg + c..]).unwrap();
        let start = seg + c + d;
        let mut out = Vec::new();
        let mut p = start;
        while p < file.len() {
            let Some((id, a)) = id_at(&file[p..]) else { break };
            let Some((n, b, _)) = vint(&file[p + a..]) else { break };
            out.push((id, p));
            p += a + b + n as usize;
        }
        (start, out)
    }

    #[test]
    fn round_trip_h264_and_aac() {
        let path = tmp("roundtrip.mkv");
        let exp = make(&path, 90, true);
        let file = std::fs::read(&path).unwrap();
        let info = read(&path).unwrap();
        check(&info, &exp, &file);
        assert!(!info.truncated && info.skipped.is_empty());
        assert_eq!((exp[0].len(), exp[1].len()), (90, 141));
        let v = &info.tracks[0].config;
        let s = testdata::H264Stream::new(64, 48);
        assert_eq!((v.codec, v.width, v.height), (CodecId::H264, 64, 48));
        assert_eq!(v.config, codec::video_config(CodecId::H264, &s.header(), &[]).unwrap());
        let a = &info.tracks[1].config;
        assert_eq!((a.codec, a.sample_rate, a.channels, &a.config[..]), (CodecId::Aac, 48_000, 2, &[0x11, 0x90][..]));
        // DefaultDuration was filled in for both constant-rate tracks.
        assert_eq!(info.tracks[0].samples.last().unwrap().duration, 33);
        assert_eq!(info.tracks[1].samples.last().unwrap().duration, 21);
        assert!((info.duration_seconds - 3.008).abs() < 0.002, "{}", info.duration_seconds);

        // finish(): SeekHead entries hit their elements, the Segment size is
        // exact, every cue lands on a keyframe block with its time.
        let (start, top) = top_level(&file);
        assert_eq!(top[0], (SEEK_HEAD, start));
        assert_eq!(top.last().unwrap().0, CUES);
        let (_, a) = id_at(&file[start..]).unwrap();
        let (n, b, _) = vint(&file[start + a..]).unwrap();
        let sh = &file[start + a + b..][..n as usize];
        let mut seen = Vec::new();
        for (_, seek) in elems(sh).filter(|e| e.0 == SEEK) {
            let mut e = elems(seek);
            let id = u32::from_be_bytes(e.next().unwrap().1.try_into().unwrap());
            let pos = uint(e.next().unwrap().1).unwrap() as usize;
            assert_eq!(id_at(&file[start + pos..]).unwrap().0, id);
            seen.push(id);
        }
        assert_eq!(seen, [INFO, TRACKS, CUES]);
        let (_, sa) = id_at(&file[start - 12..]).unwrap();
        assert_eq!(vint(&file[start - 12 + sa..]).unwrap().0 as usize, file.len() - start);
        let cues_at = top.last().unwrap().1;
        let (_, a) = id_at(&file[cues_at..]).unwrap();
        let (n, b, _) = vint(&file[cues_at + a..]).unwrap();
        let mut cues = 0;
        for (_, cp) in elems(&file[cues_at + a + b..][..n as usize]) {
            let time = uint(elems(cp).find(|e| e.0 == CUE_TIME).unwrap().1).unwrap();
            let tp = elems(cp).find(|e| e.0 == CUE_TRACK_POSITIONS).unwrap().1;
            let get = |id| uint(elems(tp).find(|e| e.0 == id).unwrap().1).unwrap() as usize;
            let cl = start + get(CUE_CLUSTER_POSITION);
            assert_eq!(id_at(&file[cl..]).unwrap().0, CLUSTER);
            let (_, ca, _) = vint(&file[cl + 4..]).unwrap();
            let body = &file[cl + 4 + ca..];
            let cts = uint(elems(body).next().unwrap().1).unwrap();
            let blk = &file[cl + 4 + ca + get(CUE_RELATIVE_POSITION)..];
            assert_eq!(blk[0], 0xA3);
            let (_, l, _) = vint(&blk[1..]).unwrap();
            let blk = &blk[1 + l..];
            assert_eq!((blk[0], blk[3] & 0x80), (0x81, 0x80));
            assert_eq!(cts as i64 + i16::from_be_bytes([blk[1], blk[2]]) as i64, time as i64);
            cues += 1;
        }
        assert_eq!(cues, 3); // the three IDR frames
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn ffprobe_accepts_the_written_file() {
        if testdata::ffprobe().is_none() {
            return;
        }
        let path = tmp("ffprobe.mkv");
        make(&path, 90, true);
        let p = testdata::probe(&path).unwrap();
        eprintln!("ffprobe: {}{}", p.stdout, p.stderr);
        assert_eq!(p.packets("h264"), Some(90));
        assert_eq!(p.packets("aac"), Some(141));
        assert!((p.format_duration().unwrap() - 3.0).abs() < 0.05);
        assert!(p.stderr.trim().is_empty(), "{}", p.stderr);
        if let Some(e) = testdata::decode_errors(&path) {
            assert!(e.trim().is_empty(), "{e}");
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn unfinished_and_cut_files_read_up_to_the_cut() {
        // Dropped without finish: unknown Segment size, no Cues, no Duration.
        let path = tmp("unfinished.mkv");
        let exp = make(&path, 60, false);
        let file = std::fs::read(&path).unwrap();
        let info = read(&path).unwrap();
        check(&info, &exp, &file);
        assert!(!info.truncated);
        assert!((info.duration_seconds - 2.005).abs() < 0.002, "{}", info.duration_seconds);
        if let Some(p) = testdata::probe(&path) {
            assert_eq!((p.packets("h264"), p.packets("aac")), (Some(60), Some(94)), "{p:?}");
        }
        // Killed at any byte: a cut right after a flushed Cluster is a clean
        // file, a cut anywhere else is `truncated`; only whole blocks count.
        let (_, top) = top_level(&file);
        let clusters: Vec<usize> = top.iter().filter(|e| e.0 == CLUSTER).map(|e| e.1).collect();
        assert!(clusters.len() >= 4);
        for cut in clusters[0]..=file.len() {
            let got = parse(Cursor::new(&file[..cut]), cut as u64).unwrap_or_else(|e| panic!("cut {cut}: {e}"));
            assert_eq!(got.truncated, !(clusters.contains(&cut) || cut == file.len()), "cut {cut}");
            for (t, f) in got.tracks.iter().zip(&info.tracks) {
                let whole = f.samples.iter().filter(|s| s.offset + s.size as u64 <= cut as u64).count();
                assert_eq!(t.samples.len(), whole, "cut {cut}");
            }
        }
        if testdata::ffprobe().is_some() {
            let cut = clusters[2];
            std::fs::write(&path, &file[..cut]).unwrap();
            let ours = read(&path).unwrap();
            let p = testdata::probe(&path).unwrap();
            let counts = (Some(ours.tracks[0].samples.len() as u64), Some(ours.tracks[1].samples.len() as u64));
            assert_eq!((p.packets("h264"), p.packets("aac")), counts, "{p:?}");
            assert!(p.stderr.trim().is_empty(), "{}", p.stderr);
        }
        let _ = std::fs::remove_file(&path);

        // A finished file cut at every byte.
        let path = tmp("cut.mkv");
        make(&path, 90, true);
        let file = std::fs::read(&path).unwrap();
        let full = read(&path).unwrap();
        let (_, top) = top_level(&file);
        let first_cluster = top.iter().find(|e| e.0 == CLUSTER).unwrap().1;
        let cues_at = top.last().unwrap().1;
        for cut in 0..=file.len() {
            let r = parse(Cursor::new(&file[..cut]), cut as u64);
            if cut < first_cluster {
                assert!(r.is_err(), "cut {cut} before the first cluster read fine");
                continue;
            }
            let info = r.unwrap_or_else(|e| panic!("cut {cut}: {e}"));
            assert_eq!(info.truncated, cut < file.len(), "cut {cut}");
            for (t, f) in info.tracks.iter().zip(&full.tracks) {
                let complete = f.samples.iter().filter(|s| s.offset + s.size as u64 <= cut as u64).count();
                assert_eq!(t.samples.len(), complete, "cut {cut}");
                for (a, b) in t.samples.iter().zip(&f.samples) {
                    assert_eq!((a.offset, a.size, a.dts, a.key), (b.offset, b.size, b.dts, b.key), "cut {cut}");
                }
            }
        }

        // Garbage after a cut: no panic, the complete samples stay.
        let mid = full.tracks[0].samples[45].offset as usize + 3;
        let mut seed = 0x2545_F491_4F6C_DD1Du64;
        let mut rnd = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        for fill in [0x00u8, 0xFF, 0x42, 0x1F] {
            for tail in [0, 1, 7, 4000] {
                let mut d = file[..mid].to_vec();
                d.extend((0..tail).map(|_| if fill == 0x42 { (rnd() >> 24) as u8 } else { fill }));
                let info = parse(Cursor::new(&d), d.len() as u64).unwrap();
                assert!(info.truncated);
                assert!(info.tracks[0].samples.len() >= 45);
            }
        }
        // Random damage anywhere: any result, never a panic.
        for _ in 0..3000 {
            let mut d = file.clone();
            for _ in 0..1 + rnd() % 6 {
                let at = (rnd() % d.len() as u64) as usize;
                d[at] = rnd() as u8;
            }
            let cut = d.len() - (rnd() % 64) as usize;
            let _ = parse(Cursor::new(&d[..cut]), cut as u64);
        }

        // ffprobe opens cut files that hold at least one cluster.
        if testdata::ffprobe().is_some() {
            let (p20, idr2) = (full.tracks[0].samples[20], full.tracks[0].samples[30]);
            for (name, cut) in [
                ("mid-cluster", p20.offset as usize + 2),
                ("mid-block", idr2.offset as usize + idr2.size as usize / 2),
                ("in-cues", cues_at + 5),
            ] {
                let p = tmp(&format!("cut-{name}.mkv"));
                std::fs::write(&p, &file[..cut]).unwrap();
                let ours = read(&p).unwrap();
                let (v, a) = (ours.tracks[0].samples.len() as u64, ours.tracks[1].samples.len() as u64);
                let pr = testdata::probe(&p).unwrap();
                eprintln!("{name}: ours {v} video / {a} audio; ffprobe {pr:?}");
                assert!(pr.stdout.contains("codec_name=h264") && pr.stdout.contains("codec_name=aac"), "{name}: {pr:?}");
                assert_eq!((pr.packets("h264"), pr.packets("aac")), (Some(v), Some(a)), "{name}");
                let _ = std::fs::remove_file(&p);
            }
        }
        let _ = std::fs::remove_file(&path);
    }

    /// One packet as ffprobe lists it.
    struct Pkt {
        stream: usize,
        pts: i64,
        size: u32,
        key: bool,
        crc: String,
    }

    fn ffprobe_packets(path: &Path) -> Vec<Pkt> {
        let out = Command::new(testdata::ffprobe().unwrap())
            .args(["-v", "error", "-show_entries", "packet=stream_index,pts,size,flags,data_hash", "-show_data_hash", "crc32", "-of", "compact"])
            .arg(path)
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter(|l| l.starts_with("packet|"))
            .map(|l| {
                let get = |k: &str| l.split('|').find_map(|kv| kv.strip_prefix(k)).unwrap_or("").to_string();
                Pkt {
                    stream: get("stream_index=").parse().unwrap(),
                    pts: get("pts=").parse().unwrap(),
                    size: get("size=").parse().unwrap(),
                    key: get("flags=").starts_with('K'),
                    crc: get("data_hash=CRC32:"),
                }
            })
            .collect()
    }

    fn crc32(d: &[u8]) -> u32 {
        let mut c = !0u32;
        for &b in d {
            c ^= b as u32;
            for _ in 0..8 {
                c = if c & 1 != 0 { (c >> 1) ^ 0xEDB8_8320 } else { c >> 1 };
            }
        }
        !c
    }

    #[test]
    fn reads_ffmpeg_files() {
        let Some(ffmpeg) = testdata::ffmpeg() else { return };
        if testdata::ffprobe().is_none() {
            return;
        }
        let cases: [(&str, CodecId, &[&str]); 4] = [
            ("h264", CodecId::H264, &["-c:v", "libx264", "-bf", "2", "-g", "30", "-x264-params", "b-adapt=0"]),
            ("hevc", CodecId::Hevc, &["-c:v", "libx265", "-bf", "2", "-g", "30", "-x265-params", "log-level=error"]),
            ("av1", CodecId::Av1, &["-c:v", "libsvtav1", "-preset", "12", "-g", "30"]),
            ("av1", CodecId::Av1, &["-c:v", "libaom-av1", "-cpu-used", "8", "-g", "30"]),
        ];
        let mut av1_done = false;
        for (name, codec_id, args) in cases {
            if codec_id == CodecId::Av1 && av1_done {
                continue;
            }
            let path = tmp(&format!("ff-{name}.mkv"));
            let ok = Command::new(&ffmpeg)
                .args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=128x72:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "2", "-pix_fmt", "yuv420p"])
                .args(args)
                .args(["-c:a", "aac"])
                .arg(&path)
                .output() // the encoders' own logs stay out of the test output
                .map(|o| o.status.success())
                .unwrap_or(false);
            if !ok {
                eprintln!("{name}: encoder {args:?} not available, skipped");
                continue;
            }
            av1_done |= codec_id == CodecId::Av1;
            let info = read(&path).unwrap();
            let file = std::fs::read(&path).unwrap();
            let pkts = ffprobe_packets(&path);
            let probe = testdata::probe(&path).unwrap();
            assert!(!info.truncated && info.skipped.is_empty());
            assert_eq!(info.tracks.len(), 2);
            let (v, a) = (&info.tracks[0], &info.tracks[1]);
            assert_eq!((v.config.codec, v.config.width, v.config.height), (codec_id, 128, 72));
            assert_eq!(codec::config_size(codec_id, &v.config.config), Some((128, 72)), "{name}");
            assert_eq!((a.config.codec, a.config.sample_rate), (CodecId::Aac, 48_000));
            let ff_name = match codec_id {
                CodecId::H264 => "h264",
                CodecId::Hevc => "hevc",
                _ => "av1",
            };
            assert_eq!(probe.packets(ff_name), Some(v.samples.len() as u64), "{name}");
            assert_eq!(probe.packets("aac"), Some(a.samples.len() as u64), "{name}");
            for (i, t) in info.tracks.iter().enumerate() {
                let ff: Vec<&Pkt> = pkts.iter().filter(|p| p.stream == i).collect();
                assert_eq!(ff.len(), t.samples.len());
                for (s, p) in t.samples.iter().zip(ff) {
                    assert_eq!((s.dts, s.size, s.key), (p.pts, p.size, p.key), "{name} track {i}");
                    let bytes = &file[s.offset as usize..][..s.size as usize];
                    assert_eq!(format!("{:08x}", crc32(bytes)), p.crc, "{name} track {i}");
                }
            }
            if codec_id == CodecId::H264 {
                // B-frames: stored in decode order, so pts go back now and then,
                // and each frame still gets its own display duration.
                assert!(v.samples.windows(2).any(|w| w[1].dts < w[0].dts));
                assert!(v.samples.iter().all(|s| s.duration == 33 || s.duration == 34), "{:?}", v.samples.iter().map(|s| s.duration).collect::<Vec<_>>());
            }
            let total: f64 = info.duration_seconds;
            assert!((total - 2.0).abs() < 0.1, "{name}: {total}");
            eprintln!("{name}: {} video / {} audio packets match ffprobe (pts, size, key, CRC32)", v.samples.len(), a.samples.len());
            let _ = std::fs::remove_file(&path);
        }
    }

    // Hand-built files for what our writer never produces.

    fn ebml_head(doc: &[u8]) -> Vec<u8> {
        let mut b = Vec::new();
        let m = begin(&mut b, EBML);
        put_bytes(&mut b, DOC_TYPE, doc);
        end(&mut b, m);
        b
    }

    fn audio_entry(b: &mut Vec<u8>, number: u64, codec_id: &str, rate: f64, channels: u64, default_ns: Option<u64>) {
        let e = begin(b, TRACK_ENTRY);
        put_uint(b, TRACK_NUMBER, number);
        put_uint(b, TRACK_TYPE, 2);
        put_bytes(b, CODEC_ID, codec_id.as_bytes());
        if let Some(ns) = default_ns {
            put_uint(b, DEFAULT_DURATION, ns);
        }
        let a = begin(b, AUDIO);
        put_float(b, SAMPLING_FREQUENCY, rate);
        put_uint(b, CHANNELS, channels);
        end(b, a);
        end(b, e);
    }

    /// A block element: (track, timestamp, flags), lace header, then frames
    /// whose bytes are all `tag + frame index` so a wrong offset shows.
    fn put_block(b: &mut Vec<u8>, id: u32, (track, rel, flags): (u8, i16, u8), lace_head: &[u8], sizes: &[usize], tag: u8) {
        let mut body = vec![0x80 | track];
        body.extend_from_slice(&rel.to_be_bytes());
        body.push(flags);
        body.extend_from_slice(lace_head);
        for (i, &n) in sizes.iter().enumerate() {
            body.resize(body.len() + n, tag + i as u8);
        }
        put_bytes(b, id, &body);
    }

    #[test]
    fn reads_xiph_fixed_and_ebml_lacing() {
        let mut f = ebml_head(b"matroska");
        put_id(&mut f, SEGMENT);
        let seg = f.len();
        f.extend_from_slice(&[0x10, 0, 0, 0]);
        let seg = seg + 4;
        let m = begin(&mut f, INFO);
        put_uint(&mut f, TIMESTAMP_SCALE, 1_000_000);
        end(&mut f, m);
        let m = begin(&mut f, TRACKS);
        audio_entry(&mut f, 1, "A_AAC", 48_000.0, 2, Some(21_333_333));
        audio_entry(&mut f, 2, "A_AAC/MPEG4/LC", 44_100.0, 1, None);
        end(&mut f, m);
        let c = begin(&mut f, CLUSTER);
        put_uint(&mut f, TIMESTAMP, 1000);
        // Xiph, 3 frames: sizes 300 (255 + 45), 5, then the rest (7).
        put_block(&mut f, SIMPLE_BLOCK, (1, 0, 0x82), &[2, 255, 45, 5], &[300, 5, 7], 10);
        // Fixed, 4 frames of 10.
        put_block(&mut f, SIMPLE_BLOCK, (1, 100, 0x84), &[3], &[10; 4], 20);
        // EBML, 3 frames: 100, then 100 - 10 = 90 (signed: -10 + 63), then the rest (200).
        put_block(&mut f, SIMPLE_BLOCK, (1, 200, 0x86), &[2, 0x80 | 100, 0x80 | 53], &[100, 90, 200], 30);
        // BlockGroup: EBML lacing, 2 frames, BlockDuration 40 ms shared out.
        let g = begin(&mut f, BLOCK_GROUP);
        put_block(&mut f, BLOCK, (2, 300, 0x06), &[1, 0x80 | 8], &[8, 9], 40);
        put_uint(&mut f, BLOCK_DURATION, 40);
        end(&mut f, g);
        // Xiph lace with no duration known: spread up to the next block.
        put_block(&mut f, SIMPLE_BLOCK, (2, 500, 0x82), &[1, 4], &[4, 6], 50);
        put_block(&mut f, SIMPLE_BLOCK, (2, 600, 0x80), &[], &[3], 60);
        end(&mut f, c);
        let n = (f.len() - seg) as u32;
        f[seg - 4..seg].copy_from_slice(&(n | 0x1000_0000).to_be_bytes());

        let path = tmp("laced.mkv");
        std::fs::write(&path, &f).unwrap();
        let info = read(&path).unwrap();
        assert!(!info.truncated);
        let got = |t: usize| -> Vec<(i64, u32, u32, u8)> {
            info.tracks[t].samples.iter().map(|s| (s.dts, s.size, s.duration, f[s.offset as usize])).collect()
        };
        for t in &info.tracks {
            for s in &t.samples {
                let d = &f[s.offset as usize..][..s.size as usize];
                assert!(d.iter().all(|&x| x == d[0]), "frame bytes do not line up");
                assert!(s.key);
            }
        }
        #[rustfmt::skip]
        assert_eq!(got(0), vec![
            (1000, 300, 21, 10), (1021, 5, 21, 11), (1043, 7, 21, 12),
            (1100, 10, 21, 20), (1121, 10, 21, 21), (1143, 10, 21, 22), (1164, 10, 21, 23),
            (1200, 100, 21, 30), (1221, 90, 21, 31), (1243, 200, 21, 32),
        ]);
        #[rustfmt::skip]
        assert_eq!(got(1), vec![
            (1300, 8, 20, 40), (1320, 9, 20, 41),
            (1500, 4, 50, 50), (1550, 6, 50, 51),
            (1600, 3, 0, 60),
        ]);
        let a = &info.tracks[1].config;
        assert_eq!((a.codec, a.sample_rate, a.channels, a.config.clone()), (CodecId::Aac, 44_100, 1, codec::aac_config(44_100, 1).to_vec()));
        assert_eq!(info.tracks[0].config.config, codec::aac_config(48_000, 2).to_vec());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn edge_cases() {
        // Empty and foreign files.
        let path = tmp("edge.bin");
        std::fs::write(&path, b"").unwrap();
        assert!(read(&path).is_err());
        std::fs::write(&path, b"\0\0\0\x18ftypisom\0\0\0\0isomiso2").unwrap();
        assert!(read(&path).is_err());
        assert!(is_mkv(&[0x1A, 0x45, 0xDF, 0xA3, 0x01]) && !is_mkv(&[0x1A, 0x45]) && !is_mkv(b"RIFF"));
        let mut f = ebml_head(b"notmkv");
        f.extend_from_slice(&[0x18, 0x53, 0x80, 0x67, 0x80]);
        std::fs::write(&path, &f).unwrap();
        assert!(read(&path).is_err());
        // A file cut inside its header.
        assert!(parse(Cursor::new(&f[..3]), 3).is_err());

        // WebM, unknown-size Segment and Clusters, a Cues element between them.
        let mut f = ebml_head(b"webm");
        put_id(&mut f, SEGMENT);
        f.push(0xFF);
        let m = begin(&mut f, TRACKS);
        audio_entry(&mut f, 1, "A_AAC", 48_000.0, 2, None);
        audio_entry(&mut f, 2, "A_OPUS", 48_000.0, 2, None);
        end(&mut f, m);
        let tracks_end = f.len();
        put_id(&mut f, CLUSTER);
        f.push(0xFF);
        put_uint(&mut f, TIMESTAMP, 0);
        put_block(&mut f, SIMPLE_BLOCK, (1, 0, 0x80), &[], &[5], 1);
        put_block(&mut f, SIMPLE_BLOCK, (2, 0, 0x80), &[], &[5], 2);
        put_block(&mut f, SIMPLE_BLOCK, (1, 40, 0x80), &[], &[6], 3);
        let m = begin(&mut f, CUES);
        let p = begin(&mut f, CUE_POINT);
        put_uint(&mut f, CUE_TIME, 0);
        end(&mut f, p);
        end(&mut f, m);
        put_id(&mut f, CLUSTER);
        f.push(0xFF);
        put_uint(&mut f, TIMESTAMP, 1000);
        put_block(&mut f, SIMPLE_BLOCK, (1, 0, 0x80), &[], &[7], 4);
        let m = begin(&mut f, TAGS);
        end(&mut f, m);
        let info = parse(Cursor::new(&f), f.len() as u64).unwrap();
        assert!(!info.truncated);
        assert_eq!(info.skipped, vec!["A_OPUS".to_string()]);
        let t = &info.tracks[0].samples;
        assert_eq!(t.iter().map(|s| (s.dts, s.size, s.duration)).collect::<Vec<_>>(), vec![(0, 5, 40), (40, 6, 960), (1000, 7, 0)]);
        assert!((info.duration_seconds - 1.0).abs() < 1e-9);
        // Cut anywhere after the track list: fine, and only whole blocks count.
        let mut last = 0;
        for cut in tracks_end..f.len() {
            let info = parse(Cursor::new(&f[..cut]), cut as u64).unwrap_or_else(|e| panic!("cut {cut}: {e}"));
            let n = info.tracks[0].samples.len();
            assert!(n >= last && n <= 3 && info.tracks[0].samples.iter().all(|s| s.offset + s.size as u64 <= cut as u64));
            last = n;
        }

        // A `fill` that panics leaves no half block behind.
        let path = tmp("panic.mkv");
        let r = std::panic::catch_unwind(|| {
            let mut w = MkvWriter::create(&path, vec![TrackConfig::aac(48_000, 2, 0)]).unwrap();
            w.write_sample(0, 0, true, 1024, |b| b.extend_from_slice(&[1, 2, 3])).unwrap();
            w.write_sample(0, 1024, true, 1024, |b| {
                b.push(9);
                panic!("encoder bug");
            })
        });
        assert!(r.is_err());
        let info = read(&path).unwrap();
        assert!(!info.truncated);
        assert_eq!(info.tracks[0].samples.iter().map(|s| s.size).collect::<Vec<_>>(), [3]);
        let _ = std::fs::remove_file(&path);

        // Timestamp jumps past what a block can hold (> 32 s), an empty track,
        // an 8K header.
        let path = tmp("jump.mkv");
        let avcc = codec::video_config(CodecId::H264, &testdata::H264Stream::new(64, 48).header(), &[]).unwrap();
        let tracks = vec![TrackConfig::video(CodecId::H264, 1000, 7680, 4320, avcc), TrackConfig::aac(48_000, 2, 0)];
        let mut w = MkvWriter::create(&path, tracks).unwrap();
        assert!(w.write_sample(2, 0, true, 0, |_| {}).is_err());
        let times = [0i64, 33, 100_000, 100_033, 100_066, 40_000_000];
        for (i, &t) in times.iter().enumerate() {
            w.write_sample(0, t, i == 0, 33, |b| b.extend_from_slice(&[0, 0, 0, 1, i as u8])).unwrap();
        }
        assert!(w.bytes_written() > 0);
        w.finish().unwrap();
        let info = read(&path).unwrap();
        let v = &info.tracks[0];
        assert_eq!((v.config.width, v.config.height), (7680, 4320));
        assert_eq!(v.samples.iter().map(|s| s.dts).collect::<Vec<_>>(), times);
        assert!(info.tracks[1].samples.is_empty());
        assert!((info.duration_seconds - 40_000.033).abs() < 1e-6);
        if let Some(p) = testdata::probe(&path) {
            assert_eq!(p.packets("h264"), Some(times.len() as u64), "{p:?}");
        }
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(tmp("edge.bin"));
    }
}
