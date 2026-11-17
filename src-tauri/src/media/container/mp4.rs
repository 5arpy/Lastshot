//! MP4 writer and reader.
//!
//! **Hybrid mode** (screen recordings): the file is written as a fragmented
//! MP4 (an index-free `moov`, then `moof`+`mdat` pairs every half second), so
//! a crash, a kill or a power cut leaves a file that plays up to the last
//! fragment. A clean stop appends a normal `moov` with the full sample tables
//! and then turns the initial `moov` and every `moof` into `free` boxes (a
//! few bytes each, in place): the result is an ordinary MP4 that every editor
//! reads, with no copy and no extra disk space. The order of those steps keeps
//! the file playable if the PC dies half way (see [`finalize_in_place`]).
//!
//! **Plain mode** (replays, remuxes): `ftyp`, one big `mdat`, `moov` at the end.
//!
//! The reader understands regular, fragmented and half-finished files and
//! files cut off at any byte; [`super::remux`] uses it to repair and remux.

use std::fs::{File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::time::{Duration, Instant};

use super::{bad, codec, CodecId, SampleRef, TrackConfig, TrackData};

/// Movie timescale (edit lists, track headers): milliseconds.
const MOVIE_TS: u32 = 1000;
/// Sample flags: a sync sample / a sample that depends on others.
const KEY_FLAGS: u32 = 0x0200_0000;
const DELTA_FLAGS: u32 = 0x0101_0000;
/// Handler names; the reader recognises our own recordings by them.
const VIDEO_NAME: &str = "Lastshot Video";
const SOUND_NAME: &str = "Lastshot Sound";

// ------------------------------------------------------------ box building

trait Put {
    fn u8(&mut self, v: u8);
    fn u16(&mut self, v: u16);
    fn u32(&mut self, v: u32);
    fn i32(&mut self, v: i32);
    fn u64(&mut self, v: u64);
    fn zeros(&mut self, n: usize);
}

impl Put for Vec<u8> {
    fn u8(&mut self, v: u8) {
        self.push(v);
    }
    fn u16(&mut self, v: u16) {
        self.extend_from_slice(&v.to_be_bytes());
    }
    fn u32(&mut self, v: u32) {
        self.extend_from_slice(&v.to_be_bytes());
    }
    fn i32(&mut self, v: i32) {
        self.extend_from_slice(&v.to_be_bytes());
    }
    fn u64(&mut self, v: u64) {
        self.extend_from_slice(&v.to_be_bytes());
    }
    fn zeros(&mut self, n: usize) {
        self.resize(self.len() + n, 0);
    }
}

fn open_box(b: &mut Vec<u8>, t: &[u8; 4]) -> usize {
    let p = b.len();
    b.u32(0);
    b.extend_from_slice(t);
    p
}

fn open_full(b: &mut Vec<u8>, t: &[u8; 4], version: u8, flags: u32) -> usize {
    let p = open_box(b, t);
    b.u32(((version as u32) << 24) | (flags & 0x00FF_FFFF));
    p
}

fn close_box(b: &mut Vec<u8>, p: usize) {
    let n = (b.len() - p) as u32;
    b[p..p + 4].copy_from_slice(&n.to_be_bytes());
}

const MATRIX: [u32; 9] = [0x0001_0000, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000];

fn ftyp(b: &mut Vec<u8>) {
    let p = open_box(b, b"ftyp");
    b.extend_from_slice(b"isom");
    b.u32(0x200);
    for brand in [b"isom", b"iso2", b"iso6", b"mp41"] {
        b.extend_from_slice(brand);
    }
    close_box(b, p);
}

// ------------------------------------------------------------ sample table

/// A track's sample tables in the compact form `moov` stores them in
/// (4 bytes per sample plus run-length timing).
#[derive(Default, Clone, Debug)]
pub(crate) struct Table {
    sizes: Vec<u32>,
    stts: Vec<(u32, u32)>,
    ctts: Vec<(u32, i32)>,
    any_cts: bool,
    sync: Vec<u32>,
    chunks: Vec<(u64, u32)>,
    first_dts: Option<i64>,
    first_cts: i32,
    total_dur: u64,
    durs: u64,
}

impl Table {
    fn push_sample(&mut self, size: u32, cts: i32, key: bool) {
        self.sizes.push(size);
        if cts != 0 {
            self.any_cts = true;
        }
        match self.ctts.last_mut() {
            Some((n, c)) if *c == cts => *n += 1,
            _ => self.ctts.push((1, cts)),
        }
        if key {
            self.sync.push(self.sizes.len() as u32);
        }
    }

    fn push_dur(&mut self, d: u32) {
        self.total_dur += d as u64;
        self.durs += 1;
        match self.stts.last_mut() {
            Some((n, v)) if *v == d => *n += 1,
            _ => self.stts.push((1, d)),
        }
    }

    fn add_chunk(&mut self, offset: u64, count: u32) {
        if count > 0 {
            self.chunks.push((offset, count));
        }
    }

    pub(crate) fn samples(&self) -> usize {
        self.sizes.len()
    }

    /// Tables for samples read from a file (repair). Durations must already
    /// be right (see [`fix_durations`]).
    pub(crate) fn from_samples(samples: &[SampleRef]) -> Table {
        let mut t = Table::default();
        let mut i = 0;
        while i < samples.len() {
            let start = samples[i].offset;
            let mut end = start;
            let mut n = 0u32;
            while i < samples.len() && samples[i].offset == end && n < 4096 {
                let s = &samples[i];
                if t.first_dts.is_none() {
                    t.first_dts = Some(s.dts);
                    t.first_cts = s.cts;
                }
                t.push_sample(s.size, s.cts, s.key);
                t.push_dur(s.duration.max(1));
                end += s.size as u64;
                n += 1;
                i += 1;
            }
            t.add_chunk(start, n);
        }
        t
    }
}

/// Gives every sample the gap to the next one as its duration (fragment
/// readers only know the encoder's nominal duration for the last sample of
/// each fragment); the last sample keeps its own.
pub(crate) fn fix_durations(samples: &mut [SampleRef]) {
    for i in 1..samples.len() {
        let d = samples[i].dts - samples[i - 1].dts;
        if d > 0 && d <= u32::MAX as i64 {
            samples[i - 1].duration = d as u32;
        }
    }
    let n = samples.len();
    if n > 0 && samples[n - 1].duration == 0 {
        samples[n - 1].duration = if n > 1 { samples[n - 2].duration.max(1) } else { 1 };
    }
}

fn to_movie(ticks: i64, ts: u32) -> u64 {
    if ticks <= 0 {
        return 0;
    }
    ((ticks as u128 * MOVIE_TS as u128 + ts as u128 / 2) / ts.max(1) as u128) as u64
}

pub(crate) struct MoovTrack<'a> {
    pub cfg: &'a TrackConfig,
    /// None = the index-free `moov` of a fragmented file.
    pub table: Option<&'a Table>,
}

/// Edit list entries (movie-timescale duration, media time) that place the
/// track's first presented sample at its real time.
fn edits(cfg: &TrackConfig, t: &Table) -> Vec<(u64, i64)> {
    let first = t.first_dts.unwrap_or(0);
    let c0 = t.first_cts as i64;
    let pt0 = first + c0;
    let media_time = c0 + if pt0 < 0 { -pt0 } else { 0 };
    let present = (t.total_dur as i64 - media_time).max(0);
    let mut e = Vec::new();
    if pt0 > 0 {
        let d = to_movie(pt0, cfg.timescale);
        if d > 0 {
            e.push((d, -1));
        }
    }
    if !e.is_empty() || media_time != 0 {
        e.push((to_movie(present, cfg.timescale), media_time));
    }
    e
}

fn track_movie_duration(cfg: &TrackConfig, t: &Table) -> u64 {
    let e = edits(cfg, t);
    if e.is_empty() {
        to_movie(t.total_dur as i64, cfg.timescale)
    } else {
        e.iter().map(|x| x.0).sum()
    }
}

/// Builds a `moov`: the index-free one of a fragmented file (with `mvex`), or
/// a regular one with full sample tables.
pub(crate) fn build_moov(tracks: &[MoovTrack]) -> Vec<u8> {
    let fragmented = tracks.iter().all(|t| t.table.is_none());
    let mut b = Vec::with_capacity(4096 + tracks.iter().map(|t| t.table.map_or(0, |x| x.sizes.len() * 4 + x.chunks.len() * 12)).sum::<usize>());
    let moov = open_box(&mut b, b"moov");
    let movie_dur = tracks
        .iter()
        .filter_map(|t| t.table.map(|x| track_movie_duration(t.cfg, x)))
        .max()
        .unwrap_or(0);
    // mvhd
    let p = open_full(&mut b, b"mvhd", 1, 0);
    b.u64(0);
    b.u64(0);
    b.u32(MOVIE_TS);
    b.u64(movie_dur);
    b.u32(0x0001_0000);
    b.u16(0x0100);
    b.zeros(10);
    for m in MATRIX {
        b.u32(m);
    }
    b.zeros(24);
    b.u32(tracks.len() as u32 + 1);
    close_box(&mut b, p);

    for (i, t) in tracks.iter().enumerate() {
        trak(&mut b, i as u32 + 1, t);
    }

    if fragmented {
        let mvex = open_box(&mut b, b"mvex");
        for i in 0..tracks.len() {
            let p = open_full(&mut b, b"trex", 0, 0);
            b.u32(i as u32 + 1);
            b.u32(1);
            b.u32(0);
            b.u32(0);
            b.u32(0);
            close_box(&mut b, p);
        }
        close_box(&mut b, mvex);
    }
    close_box(&mut b, moov);
    b
}

fn trak(b: &mut Vec<u8>, id: u32, t: &MoovTrack) {
    let cfg = t.cfg;
    let video = cfg.is_video();
    let trak = open_box(b, b"trak");
    let tk_dur = t.table.map(|x| track_movie_duration(cfg, x)).unwrap_or(0);
    let p = open_full(b, b"tkhd", 1, 3);
    b.u64(0);
    b.u64(0);
    b.u32(id);
    b.u32(0);
    b.u64(tk_dur);
    b.zeros(8);
    b.u16(0); // layer
    b.u16(0); // alternate group
    b.u16(if video { 0 } else { 0x0100 });
    b.u16(0);
    for m in MATRIX {
        b.u32(m);
    }
    b.u32(cfg.width << 16);
    b.u32(cfg.height << 16);
    close_box(b, p);

    if let Some(tab) = t.table {
        let e = edits(cfg, tab);
        if !e.is_empty() {
            let edts = open_box(b, b"edts");
            let p = open_full(b, b"elst", 1, 0);
            b.u32(e.len() as u32);
            for (d, m) in e {
                b.u64(d);
                b.u64(m as u64);
                b.u16(1);
                b.u16(0);
            }
            close_box(b, p);
            close_box(b, edts);
        }
    }

    let mdia = open_box(b, b"mdia");
    let p = open_full(b, b"mdhd", 1, 0);
    b.u64(0);
    b.u64(0);
    b.u32(cfg.timescale);
    b.u64(t.table.map(|x| x.total_dur).unwrap_or(0));
    b.u16(0x55C4); // "und"
    b.u16(0);
    close_box(b, p);
    let p = open_full(b, b"hdlr", 0, 0);
    b.u32(0);
    b.extend_from_slice(if video { b"vide" } else { b"soun" });
    b.zeros(12);
    b.extend_from_slice(if video { VIDEO_NAME } else { SOUND_NAME }.as_bytes());
    b.u8(0);
    close_box(b, p);

    let minf = open_box(b, b"minf");
    if video {
        let p = open_full(b, b"vmhd", 0, 1);
        b.zeros(8);
        close_box(b, p);
    } else {
        let p = open_full(b, b"smhd", 0, 0);
        b.zeros(4);
        close_box(b, p);
    }
    let dinf = open_box(b, b"dinf");
    let dref = open_full(b, b"dref", 0, 0);
    b.u32(1);
    let p = open_full(b, b"url ", 0, 1);
    close_box(b, p);
    close_box(b, dref);
    close_box(b, dinf);

    let stbl = open_box(b, b"stbl");
    stsd(b, cfg);
    match t.table {
        None => {
            for name in [b"stts", b"stsc", b"stco"] {
                let p = open_full(b, name, 0, 0);
                b.u32(0);
                close_box(b, p);
            }
            let p = open_full(b, b"stsz", 0, 0);
            b.u32(0);
            b.u32(0);
            close_box(b, p);
        }
        Some(tab) => tables(b, tab, video),
    }
    close_box(b, stbl);
    close_box(b, minf);
    close_box(b, mdia);
    close_box(b, trak);
}

fn tables(b: &mut Vec<u8>, t: &Table, video: bool) {
    let n = t.sizes.len() as u32;
    // stts: exactly one duration per sample.
    let mut stts = t.stts.clone();
    let mut have: u64 = stts.iter().map(|x| x.0 as u64).sum();
    while have > n as u64 {
        let excess = (have - n as u64) as u32;
        let last = stts.last_mut().expect("have > 0");
        if last.0 > excess {
            last.0 -= excess;
            have = n as u64;
        } else {
            have -= last.0 as u64;
            stts.pop();
        }
    }
    if have < n as u64 {
        let d = stts.last().map(|x| x.1).unwrap_or(1);
        stts.push(((n as u64 - have) as u32, d));
    }
    let p = open_full(b, b"stts", 0, 0);
    b.u32(stts.len() as u32);
    for (c, d) in stts {
        b.u32(c);
        b.u32(d);
    }
    close_box(b, p);

    if t.any_cts {
        let neg = t.ctts.iter().any(|x| x.1 < 0);
        let p = open_full(b, b"ctts", if neg { 1 } else { 0 }, 0);
        b.u32(t.ctts.len() as u32);
        for (c, o) in &t.ctts {
            b.u32(*c);
            b.i32(*o);
        }
        close_box(b, p);
    }

    if video && (t.sync.len() as u32) < n {
        let p = open_full(b, b"stss", 0, 0);
        b.u32(t.sync.len() as u32);
        for s in &t.sync {
            b.u32(*s);
        }
        close_box(b, p);
    }

    // stsc: runs of chunks with the same sample count.
    let mut stsc: Vec<(u32, u32)> = Vec::new();
    for (i, (_, c)) in t.chunks.iter().enumerate() {
        if stsc.last().map(|x| x.1) != Some(*c) {
            stsc.push((i as u32 + 1, *c));
        }
    }
    let p = open_full(b, b"stsc", 0, 0);
    b.u32(stsc.len() as u32);
    for (first, c) in stsc {
        b.u32(first);
        b.u32(c);
        b.u32(1);
    }
    close_box(b, p);

    let p = open_full(b, b"stsz", 0, 0);
    let same = t.sizes.first().copied().filter(|s| t.sizes.iter().all(|x| x == s));
    match same {
        Some(s) => {
            b.u32(s);
            b.u32(n);
        }
        None => {
            b.u32(0);
            b.u32(n);
            b.reserve(t.sizes.len() * 4);
            for s in &t.sizes {
                b.u32(*s);
            }
        }
    }
    close_box(b, p);

    let big = t.chunks.iter().any(|c| c.0 > u32::MAX as u64);
    let p = open_full(b, if big { b"co64" } else { b"stco" }, 0, 0);
    b.u32(t.chunks.len() as u32);
    for (o, _) in &t.chunks {
        if big {
            b.u64(*o);
        } else {
            b.u32(*o as u32);
        }
    }
    close_box(b, p);
}

fn stsd(b: &mut Vec<u8>, cfg: &TrackConfig) {
    let p = open_full(b, b"stsd", 0, 0);
    b.u32(1);
    match cfg.codec {
        CodecId::H264 | CodecId::Hevc | CodecId::Av1 => {
            let (entry, rec): (&[u8; 4], &[u8; 4]) = match cfg.codec {
                CodecId::H264 => (b"avc1", b"avcC"),
                CodecId::Hevc => (b"hvc1", b"hvcC"),
                _ => (b"av01", b"av1C"),
            };
            let e = open_box(b, entry);
            b.zeros(6);
            b.u16(1);
            b.zeros(16);
            b.u16(cfg.width.min(65535) as u16);
            b.u16(cfg.height.min(65535) as u16);
            b.u32(0x0048_0000);
            b.u32(0x0048_0000);
            b.u32(0);
            b.u16(1);
            let mut name = [0u8; 32];
            let label = b"Lastshot";
            name[0] = label.len() as u8;
            name[1..1 + label.len()].copy_from_slice(label);
            b.extend_from_slice(&name);
            b.u16(0x0018);
            b.u16(0xFFFF);
            let r = open_box(b, rec);
            b.extend_from_slice(&cfg.config);
            close_box(b, r);
            close_box(b, e);
        }
        CodecId::Aac => {
            let e = open_box(b, b"mp4a");
            b.zeros(6);
            b.u16(1);
            b.zeros(8);
            b.u16(cfg.channels.max(1));
            b.u16(16);
            b.u16(0);
            b.u16(0);
            b.u32(if cfg.sample_rate < 65536 { cfg.sample_rate << 16 } else { 0 });
            esds(b, cfg);
            close_box(b, e);
        }
    }
    close_box(b, p);
}

fn descriptor(b: &mut Vec<u8>, tag: u8, body: &[u8]) {
    b.u8(tag);
    // Four length bytes: the form every reader accepts.
    let n = body.len() as u32;
    b.u8(0x80 | ((n >> 21) & 0x7f) as u8);
    b.u8(0x80 | ((n >> 14) & 0x7f) as u8);
    b.u8(0x80 | ((n >> 7) & 0x7f) as u8);
    b.u8((n & 0x7f) as u8);
    b.extend_from_slice(body);
}

fn esds(b: &mut Vec<u8>, cfg: &TrackConfig) {
    let p = open_full(b, b"esds", 0, 0);
    let mut dsi = Vec::new();
    descriptor(&mut dsi, 0x05, &cfg.config);
    let mut dcd = vec![0x40, 0x15, 0, 0x18, 0]; // AAC, audio stream, 6 KB buffer
    dcd.u32(cfg.bitrate);
    dcd.u32(cfg.bitrate);
    dcd.extend_from_slice(&dsi);
    let mut es = vec![0, 0, 0]; // ES_ID 0, no flags
    descriptor(&mut es, 0x04, &dcd);
    descriptor(&mut es, 0x06, &[0x02]);
    descriptor(b, 0x03, &es);
    close_box(b, p);
}

// ------------------------------------------------------------------ writer

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Fragmented while writing, a normal MP4 after `finish` (crash-safe).
    Hybrid,
    /// One `mdat`, `moov` at the end (written in one go: replays, remuxes).
    Plain,
}

struct FragSample {
    size: u32,
    dur: u32,
    cts: i32,
    key: bool,
}

struct WTrack {
    cfg: TrackConfig,
    table: Table,
    frag: Vec<FragSample>,
    data: Vec<u8>,
    frag_dts: i64,
    last_dts: Option<i64>,
    /// The newest sample's decode time and nominal duration: its real
    /// duration is known when the next sample arrives.
    pending: Option<(i64, u32)>,
}

/// What a finished file holds.
#[derive(Debug, Clone, Default)]
pub struct Finished {
    pub bytes: u64,
    /// Seconds of the longest track.
    pub seconds: f64,
    pub samples: Vec<usize>,
}

/// Streams already-encoded samples into an MP4. Not for the capture thread:
/// writes go straight to the file.
pub struct Mp4Writer {
    file: File,
    mode: Mode,
    tracks: Vec<WTrack>,
    pos: u64,
    /// Hybrid: the index-free `moov`. Plain: the `mdat` header.
    head_pos: u64,
    moofs: Vec<u64>,
    seq: u32,
    head: Vec<u8>,
    last_sync: Instant,
    /// How often written data is forced to the disk (hybrid only), so a power
    /// cut loses at most this much.
    pub sync_every: Duration,
    /// Seconds of samples buffered before a fragment / chunk is written.
    pub fragment_seconds: f64,
    /// A write failed (disk full, drive gone): the file ends at `pos`.
    failed: bool,
}

impl Mp4Writer {
    pub fn create(path: &Path, mode: Mode, tracks: Vec<TrackConfig>) -> io::Result<Self> {
        if tracks.is_empty() {
            return Err(bad("an MP4 needs at least one track"));
        }
        for t in &tracks {
            if t.config.is_empty() || t.timescale == 0 {
                return Err(bad(format!("{} track without its codec setup", t.codec.label())));
            }
        }
        let mut file = OpenOptions::new().read(true).write(true).create(true).truncate(true).open(path)?;
        let mut b = Vec::with_capacity(2048);
        ftyp(&mut b);
        let head_pos = b.len() as u64;
        match mode {
            Mode::Hybrid => {
                let list: Vec<MoovTrack> = tracks.iter().map(|cfg| MoovTrack { cfg, table: None }).collect();
                b.extend_from_slice(&build_moov(&list));
            }
            Mode::Plain => {
                b.u32(1);
                b.extend_from_slice(b"mdat");
                b.u64(16);
            }
        }
        file.write_all(&b)?;
        let pos = b.len() as u64;
        let tracks = tracks
            .into_iter()
            .map(|cfg| WTrack {
                cfg,
                table: Table::default(),
                frag: Vec::with_capacity(256),
                data: Vec::new(),
                frag_dts: 0,
                last_dts: None,
                pending: None,
            })
            .collect();
        Ok(Self {
            file,
            mode,
            tracks,
            pos,
            head_pos,
            moofs: Vec::new(),
            seq: 1,
            head: Vec::with_capacity(4096),
            last_sync: Instant::now(),
            sync_every: Duration::from_secs(5),
            fragment_seconds: if mode == Mode::Hybrid { 1.0 } else { 0.5 },
            failed: false,
        })
    }

    pub fn track_config(&self, track: usize) -> Option<&TrackConfig> {
        self.tracks.get(track).map(|t| &t.cfg)
    }

    /// File size so far.
    pub fn bytes_written(&self) -> u64 {
        self.pos
    }

    /// Adds one sample. `dts`/`cts` are in the track's ticks; `fill` appends
    /// the sample bytes (length-prefixed NALs, OBUs or raw AAC) to the buffer
    /// it is given. Samples of one track must come in decode order; a decode
    /// time that does not move forward is nudged one tick on.
    pub fn write_sample(
        &mut self,
        track: usize,
        dts: i64,
        cts: i32,
        key: bool,
        dur_hint: u32,
        fill: impl FnOnce(&mut Vec<u8>),
    ) -> io::Result<bool> {
        let t = self.tracks.get_mut(track).ok_or_else(|| bad("no such track"))?;
        let before = t.data.len();
        fill(&mut t.data);
        let size = t.data.len() - before;
        if size == 0 {
            return Ok(false);
        }
        if size > u32::MAX as usize / 2 {
            t.data.truncate(before);
            return Err(bad("sample too large"));
        }
        let mut dts = dts;
        if let Some(l) = t.last_dts {
            if dts <= l {
                dts = l + 1;
            }
        }
        if let Some((pd, _)) = t.pending.take() {
            let d = (dts - pd).clamp(1, u32::MAX as i64) as u32;
            t.table.push_dur(d);
            if let Some(last) = t.frag.last_mut() {
                last.dur = d;
            }
        }
        if t.frag.is_empty() {
            t.frag_dts = dts;
        }
        if t.table.first_dts.is_none() {
            t.table.first_dts = Some(dts);
            t.table.first_cts = cts;
        }
        let hint = dur_hint.max(1);
        t.frag.push(FragSample { size: size as u32, dur: hint, cts, key });
        t.pending = Some((dts, hint));
        t.last_dts = Some(dts);
        if self.flush_due() {
            self.flush()?;
        }
        Ok(true)
    }

    fn flush_due(&self) -> bool {
        let bytes: usize = self.tracks.iter().map(|t| t.data.len()).sum();
        if bytes >= 8 << 20 {
            return true;
        }
        self.tracks.iter().any(|t| match (t.frag.is_empty(), t.last_dts) {
            (false, Some(l)) => (l - t.frag_dts) as f64 / t.cfg.timescale as f64 >= self.fragment_seconds,
            _ => false,
        })
    }

    /// Writes everything buffered (one fragment in hybrid mode).
    pub fn flush(&mut self) -> io::Result<()> {
        if self.failed {
            return Err(io::Error::new(io::ErrorKind::Other, "the file could not be written"));
        }
        if self.tracks.iter().all(|t| t.frag.is_empty()) {
            return Ok(());
        }
        let r = match self.mode {
            Mode::Hybrid => self.write_fragment(),
            Mode::Plain => self.write_chunks(),
        };
        if r.is_err() {
            self.failed = true;
            // Drop the partial write so the file ends on a whole fragment.
            let _ = self.file.set_len(self.pos);
        }
        r?;
        for t in &mut self.tracks {
            t.frag.clear();
            t.data.clear();
        }
        if self.mode == Mode::Hybrid && self.last_sync.elapsed() >= self.sync_every {
            super::sync_file(&self.file);
            self.last_sync = Instant::now();
        }
        Ok(())
    }

    fn write_fragment(&mut self) -> io::Result<()> {
        let h = &mut self.head;
        h.clear();
        let moof = open_box(h, b"moof");
        let p = open_full(h, b"mfhd", 0, 0);
        h.u32(self.seq);
        close_box(h, p);
        let mut patches = Vec::with_capacity(self.tracks.len());
        for (i, t) in self.tracks.iter().enumerate() {
            if t.frag.is_empty() {
                continue;
            }
            let traf = open_box(h, b"traf");
            let p = open_full(h, b"tfhd", 0, 0x02_0000);
            h.u32(i as u32 + 1);
            close_box(h, p);
            let p = open_full(h, b"tfdt", 1, 0);
            h.u64(t.frag_dts.max(0) as u64);
            close_box(h, p);
            let any_cts = t.frag.iter().any(|s| s.cts != 0);
            let flags = 0x1 | 0x100 | 0x200 | 0x400 | if any_cts { 0x800 } else { 0 };
            let p = open_full(h, b"trun", 1, flags);
            h.u32(t.frag.len() as u32);
            patches.push((h.len(), i));
            h.u32(0);
            for s in &t.frag {
                h.u32(s.dur);
                h.u32(s.size);
                h.u32(if s.key || !t.cfg.is_video() { KEY_FLAGS } else { DELTA_FLAGS });
                if any_cts {
                    h.i32(s.cts);
                }
            }
            close_box(h, p);
            close_box(h, traf);
        }
        close_box(h, moof);
        let moof_len = h.len() as u64;
        let data_len: u64 = self.tracks.iter().map(|t| t.data.len() as u64).sum();
        if 8 + data_len > u32::MAX as u64 {
            return Err(bad("fragment too large"));
        }
        // Data offsets are counted from the start of the moof.
        let mut offset = moof_len + 8;
        let mut track_offsets = vec![0u64; self.tracks.len()];
        for (i, t) in self.tracks.iter().enumerate() {
            track_offsets[i] = offset;
            offset += t.data.len() as u64;
        }
        for (at, i) in patches {
            h[at..at + 4].copy_from_slice(&(track_offsets[i] as u32).to_be_bytes());
        }
        h.u32((8 + data_len) as u32);
        h.extend_from_slice(b"mdat");
        self.file.write_all(h)?;
        for t in &self.tracks {
            if !t.data.is_empty() {
                self.file.write_all(&t.data)?;
            }
        }
        let start = self.pos;
        for (i, t) in self.tracks.iter_mut().enumerate() {
            if t.frag.is_empty() {
                continue;
            }
            t.table.add_chunk(start + track_offsets[i], t.frag.len() as u32);
            for s in &t.frag {
                t.table.push_sample(s.size, s.cts, s.key);
            }
        }
        self.moofs.push(start);
        self.pos += moof_len + 8 + data_len;
        self.seq += 1;
        Ok(())
    }

    fn write_chunks(&mut self) -> io::Result<()> {
        for t in self.tracks.iter_mut() {
            if t.frag.is_empty() {
                continue;
            }
            self.file.write_all(&t.data)?;
            t.table.add_chunk(self.pos, t.frag.len() as u32);
            for s in &t.frag {
                t.table.push_sample(s.size, s.cts, s.key);
            }
            self.pos += t.data.len() as u64;
        }
        Ok(())
    }

    /// Finishes the file: a normal MP4 from here on. After a write failure
    /// (disk full, drive gone) it still finishes what reached the disk; if
    /// even that fails, the fragmented file stays playable and can be
    /// repaired later.
    pub fn finish(mut self) -> io::Result<Finished> {
        let flushed = self.flush();
        for t in &mut self.tracks {
            if let Some((_, hint)) = t.pending.take() {
                t.table.push_dur(hint);
            }
        }
        let list: Vec<MoovTrack> =
            self.tracks.iter().filter(|t| t.table.samples() > 0).map(|t| MoovTrack { cfg: &t.cfg, table: Some(&t.table) }).collect();
        let info = Finished {
            bytes: self.pos,
            seconds: self
                .tracks
                .iter()
                .map(|t| t.table.total_dur as f64 / t.cfg.timescale.max(1) as f64)
                .fold(0.0, f64::max),
            samples: self.tracks.iter().map(|t| t.table.samples()).collect(),
        };
        if list.is_empty() {
            flushed?;
            return Ok(info);
        }
        let moov = build_moov(&list);
        match self.mode {
            Mode::Hybrid => {
                finalize_in_place(&mut self.file, self.pos, &moov, &self.moofs, Some(self.head_pos))?;
            }
            Mode::Plain => {
                self.file.seek(SeekFrom::Start(self.head_pos + 8))?;
                self.file.write_all(&(self.pos - self.head_pos).to_be_bytes())?;
                self.file.seek(SeekFrom::Start(self.pos))?;
                self.file.write_all(&moov)?;
            }
        }
        Ok(Finished { bytes: self.pos + moov.len() as u64, ..info })
    }
}

/// Turns a fragmented file (ours) into a normal MP4, in place:
/// 1. append the full `moov` at `end` and sync: the file still plays as a
///    fragmented MP4 (players use the first `moov`);
/// 2. turn every `moof` into `free`;
/// 3. turn the index-free `moov` into `free` and sync: now a normal MP4.
///
/// A crash between steps leaves a file that plays (fully before step 2,
/// partly during it) and that `remux::repair` finishes.
pub(crate) fn finalize_in_place(file: &mut File, end: u64, moov: &[u8], moofs: &[u64], frag_moov: Option<u64>) -> io::Result<()> {
    file.set_len(end)?;
    file.seek(SeekFrom::Start(end))?;
    file.write_all(moov)?;
    file.sync_data()?;
    for &m in moofs {
        file.seek(SeekFrom::Start(m + 4))?;
        file.write_all(b"free")?;
    }
    if let Some(p) = frag_moov {
        file.seek(SeekFrom::Start(p + 4))?;
        file.write_all(b"free")?;
    }
    file.sync_data()?;
    Ok(())
}

// ------------------------------------------------------------------ reader

/// What kind of MP4 a file is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Layout {
    /// A normal MP4 (also our finished recordings).
    Regular,
    /// Fragmented (an unfinished or crashed recording, or fMP4 from elsewhere).
    Fragmented,
    /// Our recording stopped in the middle of being finished.
    HalfFinished,
    /// Samples but no index at all (a normal MP4 cut off before its `moov`).
    NoIndex,
    /// Nothing that can be played.
    Empty,
}

#[derive(Debug)]
pub struct Mp4Info {
    pub tracks: Vec<TrackData>,
    /// Codecs we cannot carry (named), left out of `tracks`.
    pub skipped: Vec<String>,
    pub layout: Layout,
    pub file_len: u64,
    /// Written by Lastshot (hybrid recording).
    pub ours: bool,
    /// The file ends inside a box.
    pub truncated: bool,
    pub(crate) frag_moov: Option<u64>,
    pub(crate) moofs: Vec<u64>,
    /// `mdat` boxes: (box start, header length, end as declared, end in file).
    pub(crate) mdats: Vec<(u64, u64, u64, u64)>,
    /// Track configs and ids from the fragmented `moov` (repair rebuilds
    /// with them).
    pub(crate) frag_tracks: Vec<TrackConfig>,
}

impl Mp4Info {
    pub fn duration_seconds(&self) -> f64 {
        self.tracks.iter().map(|t| t.duration_seconds()).fold(0.0, f64::max)
    }
    pub fn video(&self) -> Option<&TrackData> {
        self.tracks.iter().find(|t| t.config.is_video())
    }
}

pub fn is_mp4(head: &[u8]) -> bool {
    head.len() >= 8 && matches!(&head[4..8], b"ftyp" | b"moov" | b"mdat" | b"free" | b"skip" | b"wide" | b"moof" | b"styp")
}

struct Rd<'a> {
    d: &'a [u8],
    p: usize,
}

impl<'a> Rd<'a> {
    fn new(d: &'a [u8]) -> Self {
        Self { d, p: 0 }
    }
    fn take(&mut self, n: usize) -> io::Result<&'a [u8]> {
        let s = self.d.get(self.p..self.p.checked_add(n).ok_or_else(|| bad("bad size"))?).ok_or_else(|| bad("box too short"))?;
        self.p += n;
        Ok(s)
    }
    fn u8(&mut self) -> io::Result<u8> {
        Ok(self.take(1)?[0])
    }
    fn u32(&mut self) -> io::Result<u32> {
        let s = self.take(4)?;
        Ok(u32::from_be_bytes([s[0], s[1], s[2], s[3]]))
    }
    fn u64(&mut self) -> io::Result<u64> {
        let s = self.take(8)?;
        Ok(u64::from_be_bytes(s.try_into().expect("8 bytes")))
    }
    fn skip(&mut self, n: usize) -> io::Result<()> {
        self.take(n).map(|_| ())
    }
    fn rest(&mut self) -> &'a [u8] {
        let s = &self.d[self.p.min(self.d.len())..];
        self.p = self.d.len();
        s
    }
    fn full(&mut self) -> io::Result<(u8, u32)> {
        let v = self.u32()?;
        Ok(((v >> 24) as u8, v & 0x00FF_FFFF))
    }
}

/// Child boxes of a box body: (type, body).
fn children(d: &[u8]) -> impl Iterator<Item = ([u8; 4], &[u8])> {
    let mut p = 0usize;
    std::iter::from_fn(move || {
        if p + 8 > d.len() {
            return None;
        }
        let mut size = u32::from_be_bytes([d[p], d[p + 1], d[p + 2], d[p + 3]]) as u64;
        let t: [u8; 4] = d[p + 4..p + 8].try_into().expect("4 bytes");
        let mut hdr = 8u64;
        if size == 1 {
            if p + 16 > d.len() {
                return None;
            }
            size = u64::from_be_bytes(d[p + 8..p + 16].try_into().expect("8 bytes"));
            hdr = 16;
        } else if size == 0 {
            size = (d.len() - p) as u64;
        }
        if size < hdr || p as u64 + size > d.len() as u64 {
            return None;
        }
        let body = &d[p + hdr as usize..p + size as usize];
        p += size as usize;
        Some((t, body))
    })
}

fn child<'a>(d: &'a [u8], t: &[u8; 4]) -> Option<&'a [u8]> {
    children(d).find(|(x, _)| x == t).map(|(_, b)| b)
}

#[derive(Default)]
struct Trex {
    dur: u32,
    size: u32,
    flags: u32,
}

struct Trak {
    id: u32,
    config: Option<TrackConfig>,
    unsupported: Option<String>,
    /// Ticks to add to media decode times (edit list).
    shift: i64,
    samples: Vec<SampleRef>,
    ours: bool,
}

fn parse_mvhd_timescale(moov: &[u8]) -> u32 {
    child(moov, b"mvhd")
        .and_then(|b| {
            let mut r = Rd::new(b);
            let (v, _) = r.full().ok()?;
            r.skip(if v == 1 { 16 } else { 8 }).ok()?;
            r.u32().ok()
        })
        .unwrap_or(MOVIE_TS)
}

fn parse_esds(d: &[u8]) -> Option<(Vec<u8>, u32)> {
    let mut r = Rd::new(d);
    r.full().ok()?;
    fn desc<'a>(r: &mut Rd<'a>) -> Option<(u8, &'a [u8])> {
        let tag = r.u8().ok()?;
        let mut len = 0usize;
        for _ in 0..4 {
            let b = r.u8().ok()?;
            len = (len << 7) | (b & 0x7f) as usize;
            if b & 0x80 == 0 {
                break;
            }
        }
        Some((tag, r.take(len).ok()?))
    }
    let (tag, es) = desc(&mut r)?;
    if tag != 3 {
        return None;
    }
    let mut r = Rd::new(es);
    r.skip(2).ok()?;
    let flags = r.u8().ok()?;
    if flags & 0x80 != 0 {
        r.skip(2).ok()?;
    }
    if flags & 0x40 != 0 {
        let n = r.u8().ok()? as usize;
        r.skip(n).ok()?;
    }
    if flags & 0x20 != 0 {
        r.skip(2).ok()?;
    }
    while let Some((tag, body)) = desc(&mut r) {
        if tag == 4 {
            let mut d = Rd::new(body);
            if d.u8().ok()? != 0x40 {
                return None; // not MPEG-4 audio (AAC)
            }
            d.skip(4).ok()?;
            d.skip(4).ok()?;
            let avg = d.u32().ok()?;
            while let Some((t, b)) = desc(&mut d) {
                if t == 5 {
                    return Some((b.to_vec(), avg));
                }
            }
        }
    }
    None
}

/// The sample entry as a track config, or the name of an unsupported codec.
fn parse_stsd(stsd: &[u8], timescale: u32) -> Result<TrackConfig, String> {
    let mut r = Rd::new(stsd);
    r.full().map_err(|e| e.to_string())?;
    r.u32().map_err(|e| e.to_string())?;
    let (t, body) = children(r.rest()).next().ok_or("no sample entry")?;
    let name = String::from_utf8_lossy(&t).to_string();
    let codec = match &t {
        b"avc1" | b"avc3" => CodecId::H264,
        b"hvc1" | b"hev1" => CodecId::Hevc,
        b"av01" => CodecId::Av1,
        b"mp4a" => CodecId::Aac,
        _ => return Err(name),
    };
    if codec.is_video() {
        if body.len() < 78 {
            return Err(name);
        }
        let w = u16::from_be_bytes([body[24], body[25]]) as u32;
        let h = u16::from_be_bytes([body[26], body[27]]) as u32;
        let rec: &[u8; 4] = match codec {
            CodecId::H264 => b"avcC",
            CodecId::Hevc => b"hvcC",
            _ => b"av1C",
        };
        let config = child(&body[78..], rec).ok_or(name.clone())?.to_vec();
        let mut cfg = TrackConfig::video(codec, timescale, w, h, config);
        if let Some((cw, ch)) = codec::config_size(codec, &cfg.config) {
            if cw > 0 && ch > 0 && (w == 0 || h == 0) {
                cfg.width = cw;
                cfg.height = ch;
            }
        }
        Ok(cfg)
    } else {
        if body.len() < 28 {
            return Err(name);
        }
        let version = u16::from_be_bytes([body[8], body[9]]);
        let channels = u16::from_be_bytes([body[16], body[17]]);
        let rate = u32::from_be_bytes([body[24], body[25], body[26], body[27]]) >> 16;
        let extra = match version {
            1 => 16,
            2 => 36,
            _ => 0,
        };
        let kids = body.get(28 + extra..).unwrap_or(&[]);
        let esds = child(kids, b"esds").or_else(|| child(kids, b"wave").and_then(|w| child(w, b"esds")));
        let (asc, avg) = esds.and_then(parse_esds).ok_or("mp4a (not AAC)".to_string())?;
        let (r2, c2) = codec::aac_config_info(&asc).unwrap_or((rate, channels));
        let rate = if r2 > 0 { r2 } else { rate };
        Ok(TrackConfig {
            codec,
            timescale,
            width: 0,
            height: 0,
            sample_rate: rate,
            channels: if c2 > 0 { c2 } else { channels },
            config: asc,
            bitrate: avg,
        })
    }
}

fn read_table_u32(b: &[u8], fields: usize) -> io::Result<Vec<u32>> {
    let mut r = Rd::new(b);
    r.full()?;
    let n = r.u32()? as usize;
    if n.checked_mul(fields * 4).map_or(true, |x| x > b.len()) {
        return Err(bad("table larger than its box"));
    }
    let mut v = Vec::with_capacity(n * fields);
    for _ in 0..n * fields {
        v.push(r.u32()?);
    }
    Ok(v)
}

fn parse_trak(trak: &[u8], movie_ts: u32) -> io::Result<Trak> {
    let tkhd = child(trak, b"tkhd").ok_or_else(|| bad("track without tkhd"))?;
    let mut r = Rd::new(tkhd);
    let (v, _) = r.full()?;
    r.skip(if v == 1 { 16 } else { 8 })?;
    let id = r.u32()?;
    let mdia = child(trak, b"mdia").ok_or_else(|| bad("track without mdia"))?;
    let mdhd = child(mdia, b"mdhd").ok_or_else(|| bad("track without mdhd"))?;
    let mut r = Rd::new(mdhd);
    let (v, _) = r.full()?;
    r.skip(if v == 1 { 16 } else { 8 })?;
    let timescale = r.u32()?.max(1);
    let hdlr = child(mdia, b"hdlr").unwrap_or(&[]);
    let ours = hdlr.len() > 24 && {
        let name = &hdlr[24..];
        name.starts_with(VIDEO_NAME.as_bytes()) || name.starts_with(SOUND_NAME.as_bytes())
    };
    let handler = hdlr.get(8..12).unwrap_or(&[]);
    let mut out = Trak { id, config: None, unsupported: None, shift: 0, samples: Vec::new(), ours };
    if handler != b"vide" && handler != b"soun" {
        return Ok(out);
    }
    let stbl = child(mdia, b"minf").and_then(|m| child(m, b"stbl")).ok_or_else(|| bad("track without stbl"))?;
    match child(stbl, b"stsd").map(|s| parse_stsd(s, timescale)) {
        Some(Ok(c)) => out.config = Some(c),
        Some(Err(name)) => {
            out.unsupported = Some(name);
            return Ok(out);
        }
        None => return Ok(out),
    }

    // Edit list: empty edits delay the track, the first media time skips in.
    if let Some(elst) = child(trak, b"edts").and_then(|e| child(e, b"elst")) {
        let mut r = Rd::new(elst);
        let (v, _) = r.full()?;
        let n = r.u32()?;
        let mut empty: i64 = 0;
        for _ in 0..n.min(64) {
            let (dur, mt) = if v == 1 { (r.u64()? as i64, r.u64()? as i64) } else { (r.u32()? as i64, r.u32()? as i32 as i64) };
            r.skip(4)?;
            if mt == -1 {
                empty += dur;
            } else {
                out.shift = empty * timescale as i64 / movie_ts.max(1) as i64 - mt;
                break;
            }
        }
    }

    // Regular sample tables (empty in a fragmented file).
    let sizes: Vec<u32> = match child(stbl, b"stsz") {
        Some(b) => {
            let mut r = Rd::new(b);
            r.full()?;
            let fixed = r.u32()?;
            let n = r.u32()? as usize;
            if fixed != 0 {
                vec![fixed; n.min(50_000_000)]
            } else {
                if n * 4 > b.len() {
                    return Err(bad("stsz larger than its box"));
                }
                (0..n).map(|_| r.u32()).collect::<io::Result<_>>()?
            }
        }
        None => Vec::new(),
    };
    if sizes.is_empty() {
        return Ok(out);
    }
    let stts = child(stbl, b"stts").map(|b| read_table_u32(b, 2)).transpose()?.unwrap_or_default();
    let ctts: Vec<(u32, i32)> = match child(stbl, b"ctts") {
        Some(b) => read_table_u32(b, 2)?.chunks(2).map(|c| (c[0], c[1] as i32)).collect(),
        None => Vec::new(),
    };
    let stsc = child(stbl, b"stsc").map(|b| read_table_u32(b, 3)).transpose()?.unwrap_or_default();
    let offsets: Vec<u64> = if let Some(b) = child(stbl, b"stco") {
        read_table_u32(b, 1)?.into_iter().map(u64::from).collect()
    } else if let Some(b) = child(stbl, b"co64") {
        let mut r = Rd::new(b);
        r.full()?;
        let n = r.u32()? as usize;
        if n * 8 > b.len() {
            return Err(bad("co64 larger than its box"));
        }
        (0..n).map(|_| r.u64()).collect::<io::Result<_>>()?
    } else {
        return Err(bad("no chunk offsets"));
    };
    let sync: Option<Vec<u32>> = child(stbl, b"stss").map(|b| read_table_u32(b, 1)).transpose()?;

    let mut durs = stts.chunks(2).flat_map(|c| std::iter::repeat(c[1]).take(c[0] as usize));
    let mut ctss = ctts.iter().flat_map(|&(n, o)| std::iter::repeat(o).take(n as usize));
    let mut sync_i = 0usize;
    let mut dts = out.shift;
    let mut s = 0usize;
    for (ci, &off) in offsets.iter().enumerate() {
        let chunk_no = ci as u32 + 1;
        let spc = stsc
            .chunks(3)
            .take_while(|e| e[0] <= chunk_no)
            .last()
            .map(|e| e[1])
            .unwrap_or(0);
        let mut o = off;
        for _ in 0..spc {
            if s >= sizes.len() {
                break;
            }
            let d = durs.next().unwrap_or(0);
            let key = match &sync {
                None => true,
                Some(list) => {
                    while sync_i < list.len() && (list[sync_i] as usize) < s + 1 {
                        sync_i += 1;
                    }
                    list.get(sync_i) == Some(&(s as u32 + 1))
                }
            };
            out.samples.push(SampleRef { offset: o, size: sizes[s], dts, cts: ctss.next().unwrap_or(0), duration: d, key });
            o += sizes[s] as u64;
            dts += d as i64;
            s += 1;
        }
    }
    Ok(out)
}

struct FragState {
    trex: Vec<(u32, Trex)>,
    next_dts: Vec<(u32, i64)>,
}

fn parse_moof(moof_pos: u64, body: &[u8], traks: &mut [Trak], st: &mut FragState, file_len: u64) -> io::Result<()> {
    let mut prev_end = moof_pos;
    for (t, traf) in children(body) {
        if &t != b"traf" {
            continue;
        }
        let tfhd = child(traf, b"tfhd").ok_or_else(|| bad("traf without tfhd"))?;
        let mut r = Rd::new(tfhd);
        let (_, flags) = r.full()?;
        let id = r.u32()?;
        let base_off = if flags & 0x1 != 0 { Some(r.u64()?) } else { None };
        if flags & 0x2 != 0 {
            r.u32()?;
        }
        let defaults = st.trex.iter().find(|(i, _)| *i == id).map(|(_, t)| (t.dur, t.size, t.flags)).unwrap_or((0, 0, 0));
        let def_dur = if flags & 0x8 != 0 { r.u32()? } else { defaults.0 };
        let def_size = if flags & 0x10 != 0 { r.u32()? } else { defaults.1 };
        let def_flags = if flags & 0x20 != 0 { r.u32()? } else { defaults.2 };
        let base = match base_off {
            Some(b) => b,
            None if flags & 0x02_0000 != 0 => moof_pos,
            None => prev_end,
        };
        let Some(trak) = traks.iter_mut().find(|t| t.id == id) else {
            continue;
        };
        let mut dts = match child(traf, b"tfdt") {
            Some(b) => {
                let mut r = Rd::new(b);
                let (v, _) = r.full()?;
                (if v == 1 { r.u64()? } else { r.u32()? as u64 }) as i64 + trak.shift
            }
            None => st.next_dts.iter().find(|(i, _)| *i == id).map(|x| x.1).unwrap_or(trak.shift),
        };
        let mut ptr = base;
        for (t, trun) in children(traf) {
            if &t != b"trun" {
                continue;
            }
            let mut r = Rd::new(trun);
            let (v, fl) = r.full()?;
            let n = r.u32()?;
            if fl & 0x1 != 0 {
                ptr = (base as i64 + r.u32()? as i32 as i64).max(0) as u64;
            }
            let first_flags = if fl & 0x4 != 0 { Some(r.u32()?) } else { None };
            for i in 0..n {
                let dur = if fl & 0x100 != 0 { r.u32()? } else { def_dur };
                let size = if fl & 0x200 != 0 { r.u32()? } else { def_size };
                let sflags = if fl & 0x400 != 0 {
                    r.u32()?
                } else if i == 0 {
                    first_flags.unwrap_or(def_flags)
                } else {
                    def_flags
                };
                let cts = if fl & 0x800 != 0 {
                    let c = r.u32()?;
                    if v == 0 && c > i32::MAX as u32 {
                        i32::MAX
                    } else {
                        c as i32
                    }
                } else {
                    0
                };
                if ptr + size as u64 > file_len {
                    // Cut off: the rest of this fragment never reached the disk.
                    return Ok(());
                }
                if trak.config.is_some() {
                    trak.samples.push(SampleRef { offset: ptr, size, dts, cts, duration: dur, key: sflags & 0x0001_0000 == 0 });
                }
                ptr += size as u64;
                dts += dur as i64;
            }
            prev_end = ptr;
        }
        match st.next_dts.iter_mut().find(|(i, _)| *i == id) {
            Some(x) => x.1 = dts,
            None => st.next_dts.push((id, dts)),
        }
    }
    Ok(())
}

/// Reads an MP4's tracks and samples (no sample data is loaded).
/// `with_freed_moofs`: also read fragments a half-finished finalisation
/// already turned into `free` boxes (repair).
pub fn read(path: &Path) -> io::Result<Mp4Info> {
    read_with(path, false)
}

pub(crate) fn read_with(path: &Path, with_freed_moofs: bool) -> io::Result<Mp4Info> {
    let mut f = File::open(path)?;
    let len = f.metadata()?.len();
    if len == 0 {
        return Err(bad("the file is empty"));
    }
    let mut head = [0u8; 16];
    let mut pos = 0u64;
    let mut truncated = false;
    let mut frag_moov: Option<(u64, Vec<u8>)> = None;
    let mut reg_moov: Option<Vec<u8>> = None;
    let mut moofs: Vec<(u64, Vec<u8>, bool)> = Vec::new();
    let mut mdats = Vec::new();
    let mut saw_ftyp = false;
    while pos + 8 <= len {
        f.seek(SeekFrom::Start(pos))?;
        let n = (len - pos).min(16) as usize;
        f.read_exact(&mut head[..n])?;
        let mut size = u32::from_be_bytes([head[0], head[1], head[2], head[3]]) as u64;
        let t: [u8; 4] = head[4..8].try_into().expect("4 bytes");
        let mut hdr = 8u64;
        if size == 1 {
            if n < 16 {
                truncated = true;
                break;
            }
            size = u64::from_be_bytes(head[8..16].try_into().expect("8 bytes"));
            hdr = 16;
        } else if size == 0 {
            size = len - pos;
        }
        if size < hdr || !t.iter().all(|c| c.is_ascii_graphic() || *c == b' ') {
            // Garbage (a half-written header): stop here.
            truncated = true;
            break;
        }
        if pos == 0 {
            if !matches!(&t, b"ftyp" | b"moov" | b"mdat" | b"free" | b"skip" | b"wide" | b"styp") {
                return Err(bad("not an MP4 file"));
            }
        }
        let end = pos.saturating_add(size);
        let complete = end <= len;
        let read_body = |f: &mut File, cap: u64| -> io::Result<Vec<u8>> {
            if size - hdr > cap {
                return Err(bad("box too large"));
            }
            let mut v = vec![0u8; (size - hdr) as usize];
            f.seek(SeekFrom::Start(pos + hdr))?;
            f.read_exact(&mut v)?;
            Ok(v)
        };
        match &t {
            b"ftyp" => saw_ftyp = true,
            b"moov" if complete => {
                let body = read_body(&mut f, 1 << 30)?;
                if child(&body, b"mvex").is_some() {
                    if frag_moov.is_none() {
                        frag_moov = Some((pos, body));
                    }
                } else if reg_moov.is_none() {
                    reg_moov = Some(body);
                }
            }
            b"moof" if complete => moofs.push((pos, read_body(&mut f, 64 << 20)?, false)),
            b"free" | b"skip" if complete && with_freed_moofs && size >= hdr + 16 => {
                let body = read_body(&mut f, 64 << 20)?;
                if body.get(4..8) == Some(b"mfhd") {
                    moofs.push((pos, body, true));
                }
            }
            b"mdat" => mdats.push((pos, hdr, end, end.min(len))),
            _ => {}
        }
        if !complete {
            truncated = true;
            break;
        }
        pos = end;
    }
    if !saw_ftyp && reg_moov.is_none() && frag_moov.is_none() && mdats.is_empty() {
        return Err(bad("not an MP4 file"));
    }

    let mut info = Mp4Info {
        tracks: Vec::new(),
        skipped: Vec::new(),
        layout: Layout::Empty,
        file_len: len,
        ours: false,
        truncated,
        frag_moov: frag_moov.as_ref().map(|x| x.0),
        moofs: moofs.iter().filter(|m| !m.2).map(|m| m.0).collect(),
        mdats,
        frag_tracks: Vec::new(),
    };
    let live_moofs = !info.moofs.is_empty();

    let use_regular = reg_moov.is_some();
    let moov = reg_moov.as_deref().or(frag_moov.as_ref().map(|x| x.1.as_slice()));
    let Some(moov) = moov else {
        info.layout = if info.mdats.iter().any(|m| m.3 > m.0 + m.1) { Layout::NoIndex } else { Layout::Empty };
        return Ok(info);
    };
    let movie_ts = parse_mvhd_timescale(moov);
    let mut traks: Vec<Trak> = children(moov).filter(|(t, _)| t == b"trak").map(|(_, b)| parse_trak(b, movie_ts)).collect::<io::Result<_>>()?;
    info.ours = traks.iter().any(|t| t.ours);
    if let Some((_, fm)) = frag_moov.as_ref() {
        let fm_ts = parse_mvhd_timescale(fm);
        for t in children(fm).filter(|(t, _)| t == b"trak") {
            if let Ok(tr) = parse_trak(t.1, fm_ts) {
                info.ours |= tr.ours;
                if let Some(c) = tr.config {
                    info.frag_tracks.push(c);
                }
            }
        }
    }

    if !use_regular {
        let mvex = child(moov, b"mvex").unwrap_or(&[]);
        let mut st = FragState { trex: Vec::new(), next_dts: Vec::new() };
        for (t, b) in children(mvex) {
            if &t == b"trex" {
                let mut r = Rd::new(b);
                r.full()?;
                let id = r.u32()?;
                r.u32()?;
                st.trex.push((id, Trex { dur: r.u32()?, size: r.u32()?, flags: r.u32()? }));
            }
        }
        for (p, body, _) in &moofs {
            parse_moof(*p, body, &mut traks, &mut st, len)?;
        }
    }

    for t in traks {
        if let Some(name) = t.unsupported {
            info.skipped.push(name);
        }
        if let Some(cfg) = t.config {
            info.tracks.push(TrackData { config: cfg, samples: t.samples });
        }
    }
    info.layout = if use_regular {
        if live_moofs || info.frag_moov.is_some() {
            Layout::HalfFinished
        } else {
            Layout::Regular
        }
    } else if info.tracks.iter().any(|t| !t.samples.is_empty()) {
        Layout::Fragmented
    } else if info.mdats.iter().any(|m| m.3 > m.0 + m.1) && !live_moofs {
        Layout::NoIndex
    } else {
        Layout::Empty
    };
    Ok(info)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::media::container::testdata::{self, H264Stream, SILENT_AAC_STEREO};

    pub(crate) fn tmp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("lastshot-mux-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        dir.join(name)
    }

    /// Writes `secs` of 64x48 30 fps video (+ AAC) and returns the writer
    /// unfinished.
    pub(crate) fn write_av(path: &Path, mode: Mode, secs: u32, audio: bool) -> Mp4Writer {
        let s = H264Stream::new(64, 48);
        let mut tracks = vec![TrackConfig::video(CodecId::H264, 30_000, 64, 48, codec::video_config(CodecId::H264, &s.header(), &[]).unwrap())];
        if audio {
            tracks.push(TrackConfig::aac(48_000, 2, 192_000));
        }
        let mut w = Mp4Writer::create(path, mode, tracks).unwrap();
        let mut a = 0i64;
        for i in 0..secs * 30 {
            let (au, key) = s.frame(i, 30);
            w.write_sample(0, i as i64 * 1000, 0, key, 1000, |b| {
                codec::append_sample(CodecId::H264, &au, b);
            })
            .unwrap();
            while audio && a * 1024 * 30 < (i as i64 + 1) * 48_000 {
                // Audio starts 10 ms after the video.
                w.write_sample(1, 480 + a * 1024, 0, true, 1024, |b| b.extend_from_slice(&SILENT_AAC_STEREO)).unwrap();
                a += 1;
            }
        }
        w
    }

    #[test]
    fn hybrid_file_finishes_into_a_regular_mp4() {
        let p = tmp("hybrid.mp4");
        let w = write_av(&p, Mode::Hybrid, 3, true);
        let done = w.finish().unwrap();
        assert_eq!(done.samples[0], 90);
        let info = read(&p).unwrap();
        assert_eq!(info.layout, Layout::Regular);
        assert!(info.ours && !info.truncated);
        let v = info.video().unwrap();
        assert_eq!(v.samples.len(), 90);
        assert_eq!(v.samples.iter().filter(|s| s.key).count(), 3);
        assert!((v.duration_seconds() - 3.0).abs() < 0.01);
        let a = &info.tracks[1];
        assert_eq!(a.samples[0].dts, 480, "the audio delay survives the edit list");
        assert!(a.samples.iter().all(|s| s.duration == 1024));
        // Every sample points at its exact bytes.
        let bytes = std::fs::read(&p).unwrap();
        for s in &v.samples {
            let d = &bytes[s.offset as usize..(s.offset + s.size as u64) as usize];
            assert!(codec::lp_nals(d).count() >= 1);
        }
        for s in &a.samples {
            assert_eq!(&bytes[s.offset as usize..(s.offset + s.size as u64) as usize], &SILENT_AAC_STEREO);
        }
        if let Some(pr) = testdata::probe(&p) {
            assert_eq!(pr.packets("h264"), Some(90), "{pr:?}");
            assert!(pr.packets("aac").unwrap_or(0) >= 140, "{pr:?}");
            assert!(pr.stderr.trim().is_empty(), "{}", pr.stderr);
            assert!((pr.format_duration().unwrap() - 3.0).abs() < 0.05, "{pr:?}");
        }
        if let Some(e) = testdata::decode_errors(&p) {
            assert!(e.trim().is_empty(), "{e}");
        }
    }

    #[test]
    fn plain_file_reads_back_and_plays() {
        let p = tmp("plain.mp4");
        let w = write_av(&p, Mode::Plain, 2, true);
        w.finish().unwrap();
        let info = read(&p).unwrap();
        assert_eq!(info.layout, Layout::Regular);
        assert_eq!(info.video().unwrap().samples.len(), 60);
        if let Some(pr) = testdata::probe(&p) {
            assert_eq!(pr.packets("h264"), Some(60), "{pr:?}");
            assert!(pr.stderr.trim().is_empty(), "{}", pr.stderr);
        }
    }

    #[test]
    fn an_unfinished_hybrid_file_is_a_playable_fragmented_mp4() {
        let p = tmp("unfinished.mp4");
        let mut w = write_av(&p, Mode::Hybrid, 3, true);
        w.flush().unwrap();
        drop(w); // never finished: as if the app died
        let info = read(&p).unwrap();
        assert_eq!(info.layout, Layout::Fragmented);
        assert!(info.ours);
        assert_eq!(info.video().unwrap().samples.len(), 90);
        if let Some(pr) = testdata::probe(&p) {
            assert_eq!(pr.packets("h264"), Some(90), "{pr:?}");
        }
    }

    #[test]
    fn a_file_cut_at_any_byte_reads_what_is_complete() {
        let p = tmp("cut-src.mp4");
        let mut w = write_av(&p, Mode::Hybrid, 2, true);
        w.flush().unwrap();
        drop(w);
        let full = std::fs::read(&p).unwrap();
        let total = read(&p).unwrap().video().unwrap().samples.len();
        let c = tmp("cut.mp4");
        let mut last = 0;
        for cut in (0..full.len()).step_by(97).chain([full.len()]) {
            std::fs::write(&c, &full[..cut]).unwrap();
            match read(&c) {
                Ok(info) => {
                    let n = info.video().map(|v| v.samples.len()).unwrap_or(0);
                    assert!(n >= last, "samples never go down as the cut moves on");
                    for s in info.tracks.iter().flat_map(|t| t.samples.iter()) {
                        assert!(s.offset + s.size as u64 <= cut as u64);
                    }
                    last = n;
                }
                Err(_) => assert!(cut < 200, "only a cut inside the header fails ({cut})"),
            }
        }
        assert_eq!(last, total);
    }

    #[test]
    fn several_video_tracks_in_one_file() {
        // Room for multi-monitor recording: one video track per monitor.
        let p = tmp("two-video.mp4");
        let (a, b) = (H264Stream::new(64, 48), H264Stream::new(32, 32));
        let cfg = |s: &H264Stream| codec::video_config(CodecId::H264, &s.header(), &[]).unwrap();
        let mut w = Mp4Writer::create(
            &p,
            Mode::Hybrid,
            vec![TrackConfig::video(CodecId::H264, 60_000, 64, 48, cfg(&a)), TrackConfig::video(CodecId::H264, 30_000, 32, 32, cfg(&b))],
        )
        .unwrap();
        for i in 0..120u32 {
            let (au, key) = a.frame(i, 60);
            w.write_sample(0, i as i64 * 1000, 0, key, 1000, |x| {
                codec::append_sample(CodecId::H264, &au, x);
            })
            .unwrap();
            if i % 2 == 0 {
                let (au, key) = b.frame(i / 2, 30);
                w.write_sample(1, (i / 2) as i64 * 1000, 0, key, 1000, |x| {
                    codec::append_sample(CodecId::H264, &au, x);
                })
                .unwrap();
            }
        }
        w.finish().unwrap();
        let info = read(&p).unwrap();
        assert_eq!(info.tracks.len(), 2);
        assert_eq!((info.tracks[0].samples.len(), info.tracks[1].samples.len()), (120, 60));
        if let Some(pr) = testdata::probe(&p) {
            assert_eq!(pr.stdout.matches("codec_name=h264").count(), 2, "{pr:?}");
            assert!(pr.stderr.trim().is_empty(), "{}", pr.stderr);
        }
    }

    #[test]
    fn empty_and_foreign_files_are_clean_errors() {
        let p = tmp("empty.mp4");
        std::fs::write(&p, b"").unwrap();
        assert!(read(&p).is_err());
        std::fs::write(&p, b"\x1A\x45\xDF\xA3 not an mp4 at all").unwrap();
        assert!(read(&p).is_err());
    }

    #[test]
    fn a_crash_while_finishing_still_plays() {
        // Step 1 done (full moov appended), steps 2-3 not: two moovs.
        let p = tmp("half.mp4");
        let mut w = write_av(&p, Mode::Hybrid, 2, false);
        w.flush().unwrap();
        for t in &mut w.tracks {
            if let Some((_, h)) = t.pending.take() {
                t.table.push_dur(h);
            }
        }
        let list: Vec<MoovTrack> = w.tracks.iter().map(|t| MoovTrack { cfg: &t.cfg, table: Some(&t.table) }).collect();
        let moov = build_moov(&list);
        w.file.seek(SeekFrom::Start(w.pos)).unwrap();
        w.file.write_all(&moov).unwrap();
        // Half the moofs freed.
        for &m in w.moofs.iter().take(w.moofs.len() / 2) {
            w.file.seek(SeekFrom::Start(m + 4)).unwrap();
            w.file.write_all(b"free").unwrap();
        }
        drop(w);
        let info = read(&p).unwrap();
        assert_eq!(info.layout, Layout::HalfFinished);
        assert_eq!(info.video().unwrap().samples.len(), 60, "the full moov has every sample");
    }
}
