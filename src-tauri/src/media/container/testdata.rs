//! Test material made in code: a real (tiny) H.264 stream and silent AAC
//! frames, so the containers can be checked end to end without a screen, a
//! sound card or an encoder. Also finds a local ffprobe/ffmpeg for checks
//! (optional: the tests that need them skip when none is found).

use std::path::PathBuf;

struct BitW {
    out: Vec<u8>,
    cur: u8,
    n: u8,
}

impl BitW {
    fn new() -> Self {
        Self { out: Vec::new(), cur: 0, n: 0 }
    }
    fn bit(&mut self, b: u32) {
        self.cur = (self.cur << 1) | (b & 1) as u8;
        self.n += 1;
        if self.n == 8 {
            self.out.push(self.cur);
            self.cur = 0;
            self.n = 0;
        }
    }
    fn bits(&mut self, v: u64, n: u32) {
        for i in (0..n).rev() {
            self.bit(((v >> i) & 1) as u32);
        }
    }
    fn ue(&mut self, v: u32) {
        let x = v as u64 + 1;
        let len = 64 - x.leading_zeros();
        self.bits(0, len - 1);
        self.bits(x, len);
    }
    fn se(&mut self, v: i32) {
        self.ue(if v > 0 { (2 * v - 1) as u32 } else { (-2 * v) as u32 });
    }
    fn align_zero(&mut self) {
        while self.n != 0 {
            self.bit(0);
        }
    }
    fn trailing(&mut self) -> Vec<u8> {
        self.bit(1);
        self.align_zero();
        std::mem::take(&mut self.out)
    }
    fn byte(&mut self, b: u8) {
        debug_assert_eq!(self.n, 0);
        self.out.push(b);
    }
}

/// NAL with emulation prevention, behind a 4-byte start code.
fn nal(header: u8, rbsp: &[u8]) -> Vec<u8> {
    let mut v = vec![0, 0, 0, 1, header];
    let mut zeros = 0;
    for &b in rbsp {
        if zeros >= 2 && b <= 3 {
            v.push(3);
            zeros = 0;
        }
        zeros = if b == 0 { zeros + 1 } else { 0 };
        v.push(b);
    }
    v
}

/// A valid baseline H.264 stream: IDR frames made of I_PCM macroblocks and
/// P frames that skip every macroblock. Any decoder plays it.
pub struct H264Stream {
    pub width: u32,
    pub height: u32,
    sps: Vec<u8>,
    pps: Vec<u8>,
}

impl H264Stream {
    pub fn new(width: u32, height: u32) -> Self {
        assert!(width % 16 == 0 && height % 16 == 0);
        let mut w = BitW::new();
        w.bits(66, 8); // baseline
        w.bits(0xC0, 8);
        w.bits(30, 8);
        w.ue(0); // sps id
        w.ue(0); // log2_max_frame_num_minus4 (4 bits)
        w.ue(2); // poc type 2
        w.ue(1); // max refs
        w.bit(0);
        w.ue(width / 16 - 1);
        w.ue(height / 16 - 1);
        w.bit(1); // frame_mbs_only
        w.bit(1); // direct_8x8
        w.bit(0); // no cropping
        w.bit(0); // no VUI
        let sps = nal(0x67, &w.trailing());
        let mut w = BitW::new();
        w.ue(0);
        w.ue(0);
        w.bit(0);
        w.bit(0);
        w.ue(0);
        w.ue(0);
        w.ue(0);
        w.bit(0);
        w.bits(0, 2);
        w.se(0);
        w.se(0);
        w.se(0);
        w.bit(1); // deblocking control present
        w.bit(0);
        w.bit(0);
        let pps = nal(0x68, &w.trailing());
        Self { width, height, sps, pps }
    }

    fn mbs(&self) -> u32 {
        (self.width / 16) * (self.height / 16)
    }

    /// Annex B SPS + PPS (what an encoder hands over as its sequence header).
    pub fn header(&self) -> Vec<u8> {
        [self.sps.clone(), self.pps.clone()].concat()
    }

    /// An IDR access unit (SPS, PPS, slice) whose grey level follows `n`.
    pub fn idr(&self, n: u32) -> Vec<u8> {
        let mut w = BitW::new();
        w.ue(0); // first mb
        w.ue(7); // I slice
        w.ue(0); // pps
        w.bits(0, 4); // frame_num
        w.ue(n % 2); // idr_pic_id
        w.bit(0);
        w.bit(0); // dec_ref_pic_marking
        w.se(0); // qp delta
        w.ue(1); // deblocking off
        let luma = 16 + (n * 37 % 200) as u8;
        for _ in 0..self.mbs() {
            w.ue(25); // I_PCM
            w.align_zero();
            for _ in 0..256 {
                w.byte(luma);
            }
            for _ in 0..128 {
                w.byte(128);
            }
        }
        let slice = nal(0x65, &w.trailing());
        [self.sps.clone(), self.pps.clone(), slice].concat()
    }

    /// A P access unit that repeats the previous picture. `frame_num` counts
    /// frames since the IDR.
    pub fn p(&self, frame_num: u32) -> Vec<u8> {
        let mut w = BitW::new();
        w.ue(0);
        w.ue(5); // P slice
        w.ue(0);
        w.bits((frame_num % 16) as u64, 4);
        w.bit(0); // num_ref_idx_override
        w.bit(0); // ref_pic_list_modification
        w.bit(0); // adaptive_ref_pic_marking
        w.se(0);
        w.ue(1);
        w.ue(self.mbs()); // mb_skip_run: all
        nal(0x41, &w.trailing())
    }

    /// Frame `i` of a stream with a key frame every `gop` frames.
    pub fn frame(&self, i: u32, gop: u32) -> (Vec<u8>, bool) {
        if i % gop == 0 {
            (self.idr(i / gop), true)
        } else {
            (self.p(i % gop), false)
        }
    }
}

/// One silent AAC-LC stereo frame (1024 samples), raw (no ADTS).
pub const SILENT_AAC_STEREO: [u8; 6] = [0x21, 0x00, 0x00, 0x00, 0x00, 0x1C];

fn tool(name: &str) -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("LASTSHOT_FFMPEG_DIR") {
        let p = PathBuf::from(dir).join(name);
        if p.exists() {
            return Some(p);
        }
    }
    for dir in [r"D:\Others\shotcut\Shotcut", r"D:\Others\kdenlive\kdenlive-25.04.3_standalone\bin"] {
        let p = PathBuf::from(dir).join(name);
        if p.exists() {
            return Some(p);
        }
    }
    None
}

pub fn ffprobe() -> Option<PathBuf> {
    tool("ffprobe.exe")
}

pub fn ffmpeg() -> Option<PathBuf> {
    tool("ffmpeg.exe")
}

/// What ffprobe says about a file: (stream codec names, packet counts, any
/// error text). None when ffprobe is not installed.
pub fn probe(path: &std::path::Path) -> Option<ProbeOut> {
    let exe = ffprobe()?;
    let out = std::process::Command::new(exe)
        .args(["-v", "error", "-count_packets", "-show_entries", "stream=codec_name,nb_read_packets,duration,width,height:format=duration", "-of", "compact"])
        .arg(path)
        .output()
        .ok()?;
    Some(ProbeOut {
        stdout: String::from_utf8_lossy(&out.stdout).to_string(),
        stderr: String::from_utf8_lossy(&out.stderr).to_string(),
    })
}

/// Decodes every frame with ffmpeg and returns its error output (empty = clean).
pub fn decode_errors(path: &std::path::Path) -> Option<String> {
    let exe = ffmpeg()?;
    let out = std::process::Command::new(exe)
        .args(["-v", "error", "-i"])
        .arg(path)
        .args(["-f", "null", "-"])
        .output()
        .ok()?;
    Some(String::from_utf8_lossy(&out.stderr).to_string())
}

#[derive(Debug)]
pub struct ProbeOut {
    pub stdout: String,
    pub stderr: String,
}

impl ProbeOut {
    /// Packet count of the stream with codec `name`.
    pub fn packets(&self, name: &str) -> Option<u64> {
        self.stdout
            .lines()
            .find(|l| l.contains(&format!("codec_name={name}")))
            .and_then(|l| l.split('|').find_map(|kv| kv.strip_prefix("nb_read_packets=")))
            .and_then(|v| v.trim().parse().ok())
    }
    pub fn format_duration(&self) -> Option<f64> {
        self.stdout
            .lines()
            .find(|l| l.starts_with("format"))
            .and_then(|l| l.split('|').find_map(|kv| kv.strip_prefix("duration=")))
            .and_then(|v| v.trim().parse().ok())
    }
}
