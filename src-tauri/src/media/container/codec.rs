//! Codec glue shared by the MP4 and MKV writers and readers.
//!
//! * Annex B (start codes, what Media Foundation encoders emit) to length
//!   prefixed NAL units (what MP4 and MKV store), without allocating.
//! * avcC / hvcC / av1C decoder configuration records built from the
//!   encoder's parameter sets.
//! * AV1 temporal units cleaned for storage (no temporal delimiters, every
//!   OBU with a size field).
//! * The AAC AudioSpecificConfig.

use super::CodecId;

// --------------------------------------------------------------- bit reader

/// MSB-first bit reader over an RBSP (emulation prevention already removed).
pub struct Bits<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Bits<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }
    pub fn bit(&mut self) -> Option<u32> {
        let byte = *self.data.get(self.pos / 8)?;
        let v = (byte >> (7 - (self.pos % 8))) & 1;
        self.pos += 1;
        Some(v as u32)
    }
    pub fn bits(&mut self, n: u32) -> Option<u64> {
        let mut v = 0u64;
        for _ in 0..n {
            v = (v << 1) | self.bit()? as u64;
        }
        Some(v)
    }
    pub fn skip(&mut self, n: usize) -> Option<()> {
        if self.pos + n > self.data.len() * 8 {
            return None;
        }
        self.pos += n;
        Some(())
    }
    /// Exp-Golomb unsigned.
    pub fn ue(&mut self) -> Option<u32> {
        let mut zeros = 0;
        while self.bit()? == 0 {
            zeros += 1;
            if zeros > 31 {
                return None;
            }
        }
        Some(((1u64 << zeros) - 1 + self.bits(zeros)?) as u32)
    }
    pub fn se(&mut self) -> Option<i32> {
        let k = self.ue()? as i64;
        Some(if k % 2 == 1 { ((k + 1) / 2) as i32 } else { (-(k / 2)) as i32 })
    }
    /// AV1 leb128-free unsigned variable length code (`uvlc`).
    pub fn uvlc(&mut self) -> Option<u32> {
        let mut zeros = 0;
        while self.bit()? == 0 {
            zeros += 1;
            if zeros >= 32 {
                return Some(u32::MAX);
            }
        }
        Some(((1u64 << zeros) - 1 + self.bits(zeros)?) as u32)
    }
    pub fn pos(&self) -> usize {
        self.pos
    }
}

/// Removes emulation prevention bytes (00 00 03 -> 00 00).
pub fn unescape(nal: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(nal.len());
    let mut zeros = 0;
    for &b in nal {
        if zeros >= 2 && b == 3 {
            zeros = 0;
            continue;
        }
        zeros = if b == 0 { zeros + 1 } else { 0 };
        out.push(b);
    }
    out
}

// ------------------------------------------------------------- Annex B

/// True when the data starts with an Annex B start code.
pub fn is_annexb(data: &[u8]) -> bool {
    data.starts_with(&[0, 0, 1]) || data.starts_with(&[0, 0, 0, 1])
}

/// Iterates the NAL units of an Annex B buffer (start codes removed, trailing
/// zero bytes of the next start code trimmed).
pub fn annexb_nals(data: &[u8]) -> AnnexB<'_> {
    AnnexB { data, pos: 0 }
}

pub struct AnnexB<'a> {
    data: &'a [u8],
    pos: usize,
}

fn find_start(data: &[u8], from: usize) -> Option<(usize, usize)> {
    // Returns (position of the start code, its length).
    let mut i = from;
    while i + 3 <= data.len() {
        if data[i] == 0 && data[i + 1] == 0 {
            if data[i + 2] == 1 {
                return Some((i, 3));
            }
            if data[i + 2] == 0 && i + 3 < data.len() && data[i + 3] == 1 {
                return Some((i, 4));
            }
            // Skip ahead: 00 00 xx (xx > 1) cannot start a code at i+1.
            if data[i + 2] > 1 {
                i += 3;
                continue;
            }
            i += 1;
        } else {
            i += 1;
        }
    }
    None
}

impl<'a> Iterator for AnnexB<'a> {
    type Item = &'a [u8];
    fn next(&mut self) -> Option<&'a [u8]> {
        loop {
            let (s, len) = find_start(self.data, self.pos)?;
            let begin = s + len;
            let end = match find_start(self.data, begin) {
                Some((n, _)) => n,
                None => self.data.len(),
            };
            self.pos = end;
            let mut nal = &self.data[begin..end];
            while let Some((&0, rest)) = nal.split_last() {
                nal = rest;
            }
            if !nal.is_empty() {
                return Some(nal);
            }
            if end >= self.data.len() {
                return None;
            }
        }
    }
}

/// NAL unit type of the first header byte(s).
#[inline]
pub fn nal_type(codec: CodecId, nal: &[u8]) -> u8 {
    match codec {
        CodecId::Hevc => (nal.first().copied().unwrap_or(0) >> 1) & 0x3f,
        _ => nal.first().copied().unwrap_or(0) & 0x1f,
    }
}

/// Access unit delimiters carry nothing a container needs.
#[inline]
fn drop_in_sample(codec: CodecId, t: u8) -> bool {
    match codec {
        CodecId::H264 => t == 9,
        CodecId::Hevc => t == 35,
        _ => false,
    }
}

/// Appends `src` to `out` as 4-byte length prefixed NAL units. Annex B input
/// is converted; input that is already length prefixed is copied as is.
/// Returns false when nothing was written.
pub fn append_sample(codec: CodecId, src: &[u8], out: &mut Vec<u8>) -> bool {
    let start = out.len();
    match codec {
        CodecId::H264 | CodecId::Hevc => {
            if is_annexb(src) {
                for nal in annexb_nals(src) {
                    if drop_in_sample(codec, nal_type(codec, nal)) {
                        continue;
                    }
                    out.extend_from_slice(&(nal.len() as u32).to_be_bytes());
                    out.extend_from_slice(nal);
                }
            } else {
                out.extend_from_slice(src);
            }
        }
        CodecId::Av1 => av1_clean(src, out),
        CodecId::Aac => out.extend_from_slice(src),
    }
    out.len() > start
}

/// Size `append_sample` would write, without writing it.
pub fn sample_size(codec: CodecId, src: &[u8]) -> usize {
    match codec {
        CodecId::H264 | CodecId::Hevc if is_annexb(src) => annexb_nals(src)
            .filter(|n| !drop_in_sample(codec, nal_type(codec, n)))
            .map(|n| n.len() + 4)
            .sum(),
        CodecId::Av1 => {
            let mut n = 0;
            for o in Obus::new(src) {
                if keep_obu(o.kind) {
                    n += o.header_len + leb128_len(o.payload.len() as u64) + o.payload.len();
                }
            }
            n
        }
        _ => src.len(),
    }
}

/// Iterates length-prefixed (4 byte) NAL units.
pub fn lp_nals(data: &[u8]) -> impl Iterator<Item = &[u8]> {
    let mut pos = 0usize;
    std::iter::from_fn(move || {
        if pos + 4 > data.len() {
            return None;
        }
        let len = u32::from_be_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]]) as usize;
        let s = pos + 4;
        if len == 0 || s + len > data.len() {
            pos = data.len();
            return None;
        }
        pos = s + len;
        Some(&data[s..s + len])
    })
}

/// True when a (length prefixed or Annex B) H.264/HEVC sample holds an IDR /
/// IRAP picture.
pub fn is_keyframe(codec: CodecId, sample: &[u8]) -> bool {
    let check = |n: &[u8]| {
        let t = nal_type(codec, n);
        match codec {
            CodecId::H264 => t == 5,
            CodecId::Hevc => (16..=23).contains(&t),
            _ => false,
        }
    };
    if is_annexb(sample) {
        annexb_nals(sample).any(check)
    } else {
        lp_nals(sample).any(check)
    }
}

/// Parameter sets found in an encoder's sequence header or a key frame.
#[derive(Default, Debug, Clone, PartialEq)]
pub struct ParamSets {
    pub vps: Vec<Vec<u8>>,
    pub sps: Vec<Vec<u8>>,
    pub pps: Vec<Vec<u8>>,
}

impl ParamSets {
    pub fn is_complete(&self, codec: CodecId) -> bool {
        match codec {
            CodecId::H264 => !self.sps.is_empty() && !self.pps.is_empty(),
            CodecId::Hevc => !self.vps.is_empty() && !self.sps.is_empty() && !self.pps.is_empty(),
            _ => false,
        }
    }
    /// Collects the parameter sets from Annex B or length-prefixed data.
    pub fn collect(codec: CodecId, data: &[u8]) -> Self {
        let mut p = ParamSets::default();
        let mut take = |n: &[u8]| {
            let t = nal_type(codec, n);
            let slot = match (codec, t) {
                (CodecId::H264, 7) | (CodecId::Hevc, 33) => &mut p.sps,
                (CodecId::H264, 8) | (CodecId::Hevc, 34) => &mut p.pps,
                (CodecId::Hevc, 32) => &mut p.vps,
                _ => return,
            };
            if !slot.iter().any(|x| x == n) {
                slot.push(n.to_vec());
            }
        };
        if is_annexb(data) {
            annexb_nals(data).for_each(&mut take);
        } else {
            lp_nals(data).for_each(&mut take);
        }
        p
    }
}

// ----------------------------------------------------------------- H.264

/// avcC (AVCDecoderConfigurationRecord) from SPS/PPS NAL units.
pub fn avcc(p: &ParamSets) -> Option<Vec<u8>> {
    let sps = p.sps.first()?;
    if sps.len() < 4 || p.pps.is_empty() {
        return None;
    }
    let mut v = vec![1, sps[1], sps[2], sps[3], 0xFF, 0xE0 | p.sps.len().min(31) as u8];
    for s in p.sps.iter().take(31) {
        v.extend_from_slice(&(s.len() as u16).to_be_bytes());
        v.extend_from_slice(s);
    }
    v.push(p.pps.len().min(255) as u8);
    for s in p.pps.iter().take(255) {
        v.extend_from_slice(&(s.len() as u16).to_be_bytes());
        v.extend_from_slice(s);
    }
    // High profiles carry chroma format and bit depths (ISO 14496-15 5.3.3.1).
    if matches!(sps[1], 100 | 110 | 122 | 144) {
        let info = h264_sps_info(sps);
        let (chroma, bd_l, bd_c) = info.map(|i| (i.chroma_format, i.bit_depth_luma, i.bit_depth_chroma)).unwrap_or((1, 8, 8));
        v.push(0xFC | (chroma as u8 & 3));
        v.push(0xF8 | (bd_l.saturating_sub(8) as u8 & 7));
        v.push(0xF8 | (bd_c.saturating_sub(8) as u8 & 7));
        v.push(0);
    }
    Some(v)
}

/// Parameter sets listed in an avcC record.
pub fn avcc_params(rec: &[u8]) -> ParamSets {
    let mut p = ParamSets::default();
    if rec.len() < 6 {
        return p;
    }
    let mut pos = 6;
    let read = |pos: &mut usize| -> Option<Vec<u8>> {
        let len = u16::from_be_bytes([*rec.get(*pos)?, *rec.get(*pos + 1)?]) as usize;
        let s = rec.get(*pos + 2..*pos + 2 + len)?.to_vec();
        *pos += 2 + len;
        Some(s)
    };
    for _ in 0..(rec[5] & 0x1f) {
        match read(&mut pos) {
            Some(s) => p.sps.push(s),
            None => return p,
        }
    }
    let Some(&n) = rec.get(pos) else { return p };
    pos += 1;
    for _ in 0..n {
        match read(&mut pos) {
            Some(s) => p.pps.push(s),
            None => return p,
        }
    }
    p
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct VideoInfo {
    pub width: u32,
    pub height: u32,
    pub chroma_format: u32,
    pub bit_depth_luma: u32,
    pub bit_depth_chroma: u32,
    /// Frames per second from the VUI timing info, if any.
    pub fps: Option<f64>,
}

fn skip_scaling_list(b: &mut Bits, size: usize) -> Option<()> {
    let (mut last, mut next) = (8i32, 8i32);
    for _ in 0..size {
        if next != 0 {
            let delta = b.se()?;
            next = (last + delta + 256) % 256;
        }
        last = if next == 0 { last } else { next };
    }
    Some(())
}

/// Picture size, chroma format, bit depth and frame rate of an H.264 SPS.
pub fn h264_sps_info(sps: &[u8]) -> Option<VideoInfo> {
    let rbsp = unescape(sps.get(1..)?);
    let mut b = Bits::new(&rbsp);
    let profile = b.bits(8)? as u32;
    b.skip(16)?; // constraint flags, level
    b.ue()?; // sps id
    let (mut chroma, mut bd_l, mut bd_c) = (1u32, 8u32, 8u32);
    if matches!(profile, 100 | 110 | 122 | 244 | 44 | 83 | 86 | 118 | 128 | 138 | 139 | 134 | 135) {
        chroma = b.ue()?;
        if chroma == 3 {
            b.bit()?; // separate_colour_plane
        }
        bd_l = b.ue()? + 8;
        bd_c = b.ue()? + 8;
        b.bit()?; // qpprime_y_zero_transform_bypass
        if b.bit()? == 1 {
            let n = if chroma == 3 { 12 } else { 8 };
            for i in 0..n {
                if b.bit()? == 1 {
                    skip_scaling_list(&mut b, if i < 6 { 16 } else { 64 })?;
                }
            }
        }
    }
    b.ue()?; // log2_max_frame_num_minus4
    let poc_type = b.ue()?;
    if poc_type == 0 {
        b.ue()?;
    } else if poc_type == 1 {
        b.bit()?;
        b.se()?;
        b.se()?;
        let n = b.ue()?;
        for _ in 0..n.min(255) {
            b.se()?;
        }
    }
    b.ue()?; // max_num_ref_frames
    b.bit()?; // gaps
    let w_mbs = b.ue()? + 1;
    let h_units = b.ue()? + 1;
    let frame_mbs_only = b.bit()?;
    if frame_mbs_only == 0 {
        b.bit()?;
    }
    b.bit()?; // direct_8x8
    let (mut cl, mut cr, mut ct, mut cb) = (0, 0, 0, 0);
    if b.bit()? == 1 {
        cl = b.ue()?;
        cr = b.ue()?;
        ct = b.ue()?;
        cb = b.ue()?;
    }
    let (sub_w, sub_h) = match chroma {
        1 => (2, 2),
        2 => (2, 1),
        _ => (1, 1),
    };
    let crop_x = if chroma == 0 { 1 } else { sub_w };
    let crop_y = (if chroma == 0 { 1 } else { sub_h }) * (2 - frame_mbs_only);
    let width = w_mbs * 16 - crop_x * (cl + cr);
    let height = (2 - frame_mbs_only) * h_units * 16 - crop_y * (ct + cb);
    let mut fps = None;
    if b.bit()? == 1 {
        // VUI: skip to timing info.
        if b.bit()? == 1 {
            if b.bits(8)? == 255 {
                b.skip(32)?;
            }
        }
        if b.bit()? == 1 {
            b.bit()?;
        }
        if b.bit()? == 1 {
            b.skip(4)?;
            if b.bit()? == 1 {
                b.skip(24)?;
            }
        }
        if b.bit()? == 1 {
            b.ue()?;
            b.ue()?;
        }
        if b.bit()? == 1 {
            let units = b.bits(32)? as f64;
            let scale = b.bits(32)? as f64;
            if units > 0.0 && scale > 0.0 {
                fps = Some(scale / (2.0 * units));
            }
        }
    }
    Some(VideoInfo { width, height, chroma_format: chroma, bit_depth_luma: bd_l, bit_depth_chroma: bd_c, fps })
}

// ------------------------------------------------------------------ HEVC

struct HevcPtl {
    general: [u8; 12],
    max_sub_layers_minus1: u32,
    temporal_id_nesting: u32,
}

fn hevc_sps_ptl(rbsp: &[u8]) -> Option<(HevcPtl, VideoInfo)> {
    let mut b = Bits::new(rbsp);
    b.skip(4)?; // vps id
    let max_sub = b.bits(3)? as u32;
    let nesting = b.bit()?;
    let mut general = [0u8; 12];
    for g in general.iter_mut() {
        *g = b.bits(8)? as u8;
    }
    // Sub-layer flags and data.
    let mut sub_profile = [false; 8];
    let mut sub_level = [false; 8];
    for i in 0..max_sub as usize {
        sub_profile[i] = b.bit()? == 1;
        sub_level[i] = b.bit()? == 1;
    }
    if max_sub > 0 {
        for _ in max_sub..8 {
            b.skip(2)?;
        }
    }
    for i in 0..max_sub as usize {
        if sub_profile[i] {
            b.skip(88)?;
        }
        if sub_level[i] {
            b.skip(8)?;
        }
    }
    b.ue()?; // sps id
    let chroma = b.ue()?;
    if chroma == 3 {
        b.bit()?;
    }
    let mut width = b.ue()?;
    let mut height = b.ue()?;
    if b.bit()? == 1 {
        let (l, r, t, bo) = (b.ue()?, b.ue()?, b.ue()?, b.ue()?);
        let (sw, sh) = match chroma {
            1 => (2, 2),
            2 => (2, 1),
            _ => (1, 1),
        };
        width = width.saturating_sub(sw * (l + r));
        height = height.saturating_sub(sh * (t + bo));
    }
    let bd_l = b.ue()? + 8;
    let bd_c = b.ue()? + 8;
    Some((
        HevcPtl { general, max_sub_layers_minus1: max_sub, temporal_id_nesting: nesting },
        VideoInfo { width, height, chroma_format: chroma, bit_depth_luma: bd_l, bit_depth_chroma: bd_c, fps: None },
    ))
}

/// Picture size and format of an HEVC SPS NAL unit (with its 2-byte header).
pub fn hevc_sps_info(sps: &[u8]) -> Option<VideoInfo> {
    hevc_sps_ptl(&unescape(sps.get(2..)?)).map(|(_, i)| i)
}

/// hvcC (HEVCDecoderConfigurationRecord) from VPS/SPS/PPS NAL units.
pub fn hvcc(p: &ParamSets) -> Option<Vec<u8>> {
    let sps = p.sps.first()?;
    let (ptl, info) = hevc_sps_ptl(&unescape(sps.get(2..)?))?;
    let g = ptl.general;
    let mut v = Vec::with_capacity(64);
    v.push(1); // configurationVersion
    v.push(g[0]); // profile_space(2) tier(1) profile_idc(5)
    v.extend_from_slice(&g[1..5]); // compatibility flags
    v.extend_from_slice(&g[5..11]); // constraint indicator flags
    v.push(g[11]); // level
    v.extend_from_slice(&0xF000u16.to_be_bytes()); // min_spatial_segmentation 0
    v.push(0xFC); // parallelismType 0
    v.push(0xFC | (info.chroma_format as u8 & 3));
    v.push(0xF8 | (info.bit_depth_luma.saturating_sub(8) as u8 & 7));
    v.push(0xF8 | (info.bit_depth_chroma.saturating_sub(8) as u8 & 7));
    v.extend_from_slice(&0u16.to_be_bytes()); // avgFrameRate
    // constantFrameRate(2)=0, numTemporalLayers(3), temporalIdNested(1), lengthSizeMinusOne(2)=3
    v.push((((ptl.max_sub_layers_minus1 + 1) as u8 & 7) << 3) | ((ptl.temporal_id_nesting as u8 & 1) << 2) | 3);
    let arrays: [(u8, &Vec<Vec<u8>>); 3] = [(32, &p.vps), (33, &p.sps), (34, &p.pps)];
    v.push(arrays.iter().filter(|(_, a)| !a.is_empty()).count() as u8);
    for (t, list) in arrays {
        if list.is_empty() {
            continue;
        }
        v.push(0x80 | t); // array_completeness = 1
        v.extend_from_slice(&(list.len() as u16).to_be_bytes());
        for n in list {
            v.extend_from_slice(&(n.len() as u16).to_be_bytes());
            v.extend_from_slice(n);
        }
    }
    Some(v)
}

/// Parameter sets listed in an hvcC record.
pub fn hvcc_params(rec: &[u8]) -> ParamSets {
    let mut p = ParamSets::default();
    let Some(&n) = rec.get(22) else { return p };
    let mut pos = 23;
    for _ in 0..n {
        let Some(&t) = rec.get(pos) else { return p };
        let Some(cnt) = rec.get(pos + 1..pos + 3).map(|s| u16::from_be_bytes([s[0], s[1]])) else { return p };
        pos += 3;
        for _ in 0..cnt {
            let Some(len) = rec.get(pos..pos + 2).map(|s| u16::from_be_bytes([s[0], s[1]]) as usize) else { return p };
            let Some(nal) = rec.get(pos + 2..pos + 2 + len) else { return p };
            pos += 2 + len;
            match t & 0x3f {
                32 => p.vps.push(nal.to_vec()),
                33 => p.sps.push(nal.to_vec()),
                34 => p.pps.push(nal.to_vec()),
                _ => {}
            }
        }
    }
    p
}

// ------------------------------------------------------------------- AV1

/// One OBU of a low-overhead AV1 bitstream.
pub struct Obu<'a> {
    pub kind: u8,
    /// Header byte(s) as read (size flag possibly unset).
    pub header: [u8; 2],
    pub header_len: usize,
    pub payload: &'a [u8],
}

impl Obu<'_> {
    pub fn header_bytes(&self) -> &[u8] {
        &self.header[..self.header_len]
    }
}

pub struct Obus<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Obus<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }
}

fn read_leb128(data: &[u8], pos: &mut usize) -> Option<u64> {
    let mut v = 0u64;
    for i in 0..8 {
        let b = *data.get(*pos)?;
        *pos += 1;
        v |= ((b & 0x7f) as u64) << (i * 7);
        if b & 0x80 == 0 {
            return Some(v);
        }
    }
    None
}

pub fn leb128_len(mut v: u64) -> usize {
    let mut n = 1;
    while v >= 0x80 {
        v >>= 7;
        n += 1;
    }
    n
}

fn write_leb128(mut v: u64, out: &mut Vec<u8>) {
    loop {
        let b = (v & 0x7f) as u8;
        v >>= 7;
        if v == 0 {
            out.push(b);
            return;
        }
        out.push(b | 0x80);
    }
}

impl<'a> Iterator for Obus<'a> {
    type Item = Obu<'a>;
    fn next(&mut self) -> Option<Obu<'a>> {
        let d = self.data;
        let h0 = *d.get(self.pos)?;
        let kind = (h0 >> 3) & 0x0f;
        let ext = (h0 >> 2) & 1 == 1;
        let has_size = (h0 >> 1) & 1 == 1;
        let mut header = [h0 & !0x02, 0];
        let mut p = self.pos + 1;
        let header_len = if ext {
            header[1] = *d.get(p)?;
            p += 1;
            2
        } else {
            1
        };
        let size = if has_size { read_leb128(d, &mut p)? as usize } else { d.len().checked_sub(p)? };
        let payload = d.get(p..p.checked_add(size)?)?;
        self.pos = p + size;
        Some(Obu { kind, header, header_len, payload })
    }
}

/// OBUs worth storing: no temporal delimiters (2), padding (15) or tile list (8).
#[inline]
fn keep_obu(kind: u8) -> bool {
    !matches!(kind, 2 | 8 | 15)
}

/// Appends an AV1 temporal unit as stored in MP4/MKV: no temporal delimiter
/// or padding OBUs, every OBU with a size field.
pub fn av1_clean(src: &[u8], out: &mut Vec<u8>) {
    for o in Obus::new(src) {
        if !keep_obu(o.kind) {
            continue;
        }
        out.push(o.header[0] | 0x02);
        if o.header_len == 2 {
            out.push(o.header[1]);
        }
        write_leb128(o.payload.len() as u64, out);
        out.extend_from_slice(o.payload);
    }
}

/// The sequence header OBU (with a size field) found in `data`, if any.
pub fn av1_sequence_header(data: &[u8]) -> Option<Vec<u8>> {
    let o = Obus::new(data).find(|o| o.kind == 1)?;
    let mut v = vec![o.header[0] | 0x02];
    if o.header_len == 2 {
        v.push(o.header[1]);
    }
    write_leb128(o.payload.len() as u64, &mut v);
    v.extend_from_slice(o.payload);
    Some(v)
}

/// True when an AV1 temporal unit starts a new coded video sequence (it
/// carries a sequence header and a key frame).
pub fn av1_is_keyframe(data: &[u8]) -> bool {
    Obus::new(data).any(|o| o.kind == 1)
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Av1Info {
    pub profile: u8,
    pub level: u8,
    pub tier: u8,
    pub high_bitdepth: bool,
    pub twelve_bit: bool,
    pub mono: bool,
    pub ss_x: bool,
    pub ss_y: bool,
    pub chroma_position: u8,
    pub width: u32,
    pub height: u32,
}

/// Parses the fields av1C needs from a sequence header OBU payload.
pub fn av1_seq_info(payload: &[u8]) -> Option<Av1Info> {
    let mut b = Bits::new(payload);
    let profile = b.bits(3)? as u8;
    b.bit()?; // still_picture
    let reduced = b.bit()? == 1;
    let (mut level, mut tier) = (0u8, 0u8);
    if reduced {
        level = b.bits(5)? as u8;
    } else {
        let timing = b.bit()? == 1;
        let mut decoder_model = false;
        let mut buffer_delay_len = 0u32;
        if timing {
            b.skip(64)?;
            if b.bit()? == 1 {
                b.uvlc()?;
            }
            decoder_model = b.bit()? == 1;
            if decoder_model {
                buffer_delay_len = b.bits(5)? as u32 + 1;
                b.skip(32)?;
                b.skip(10)?;
            }
        }
        let initial_display_delay = b.bit()? == 1;
        let ops = b.bits(5)? as u32 + 1;
        for i in 0..ops {
            b.skip(12)?;
            let lvl = b.bits(5)? as u8;
            let t = if lvl > 7 { b.bit()? as u8 } else { 0 };
            if i == 0 {
                level = lvl;
                tier = t;
            }
            if decoder_model && b.bit()? == 1 {
                b.skip(buffer_delay_len as usize * 2 + 1)?;
            }
            if initial_display_delay && b.bit()? == 1 {
                b.skip(4)?;
            }
        }
    }
    let wbits = b.bits(4)? as u32 + 1;
    let hbits = b.bits(4)? as u32 + 1;
    let width = b.bits(wbits)? as u32 + 1;
    let height = b.bits(hbits)? as u32 + 1;
    if !reduced && b.bit()? == 1 {
        b.skip(7)?; // frame id lengths
    }
    b.skip(3)?; // 128x128 sb, filter intra, intra edge
    if !reduced {
        b.skip(4)?; // interintra, masked, warped, dual filter
        let order_hint = b.bit()? == 1;
        if order_hint {
            b.skip(2)?; // jnt comp, ref frame mvs
        }
        let force_sct = if b.bit()? == 1 { 2 } else { b.bit()? };
        if force_sct > 0 && b.bit()? == 0 {
            b.bit()?; // seq_force_integer_mv
        }
        if order_hint {
            b.skip(3)?;
        }
    }
    b.skip(3)?; // superres, cdef, restoration
    // color_config
    let high_bitdepth = b.bit()? == 1;
    let mut twelve_bit = false;
    if profile == 2 && high_bitdepth {
        twelve_bit = b.bit()? == 1;
    }
    let mono = if profile == 1 { false } else { b.bit()? == 1 };
    let (mut cp, mut tc, mut mc) = (2u64, 2u64, 2u64);
    if b.bit()? == 1 {
        cp = b.bits(8)?;
        tc = b.bits(8)?;
        mc = b.bits(8)?;
    }
    let (ss_x, ss_y, mut chroma_position);
    chroma_position = 0;
    if mono {
        b.bit()?;
        ss_x = true;
        ss_y = true;
    } else if cp == 1 && tc == 13 && mc == 0 {
        ss_x = false;
        ss_y = false;
    } else {
        b.bit()?; // color_range
        if profile == 0 {
            ss_x = true;
            ss_y = true;
        } else if profile == 1 {
            ss_x = false;
            ss_y = false;
        } else if twelve_bit {
            ss_x = b.bit()? == 1;
            ss_y = if ss_x { b.bit()? == 1 } else { false };
        } else {
            ss_x = true;
            ss_y = false;
        }
        if ss_x && ss_y {
            chroma_position = b.bits(2)? as u8;
        }
    }
    Some(Av1Info { profile, level, tier, high_bitdepth, twelve_bit, mono, ss_x, ss_y, chroma_position, width, height })
}

/// av1C (AV1CodecConfigurationRecord) from a sequence header OBU.
pub fn av1c(seq_header_obu: &[u8]) -> Option<Vec<u8>> {
    let o = Obus::new(seq_header_obu).find(|o| o.kind == 1)?;
    let i = av1_seq_info(o.payload)?;
    let mut v = vec![
        0x81,
        (i.profile << 5) | (i.level & 0x1f),
        (i.tier << 7)
            | ((i.high_bitdepth as u8) << 6)
            | ((i.twelve_bit as u8) << 5)
            | ((i.mono as u8) << 4)
            | ((i.ss_x as u8) << 3)
            | ((i.ss_y as u8) << 2)
            | (i.chroma_position & 3),
        0,
    ];
    v.extend_from_slice(&av1_sequence_header(seq_header_obu)?);
    Some(v)
}

/// The sequence header OBU stored in an av1C record.
pub fn av1c_seq_header(rec: &[u8]) -> Option<&[u8]> {
    rec.get(4..).filter(|s| !s.is_empty())
}

// ------------------------------------------------------------------- AAC

const AAC_RATES: [u32; 13] = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/// AudioSpecificConfig for AAC-LC.
pub fn aac_config(sample_rate: u32, channels: u16) -> [u8; 2] {
    let idx = AAC_RATES.iter().position(|&r| r == sample_rate).unwrap_or(3) as u16;
    let v: u16 = (2 << 11) | (idx << 7) | ((channels.min(7)) << 3);
    v.to_be_bytes()
}

/// Sample rate and channel count of an AudioSpecificConfig.
pub fn aac_config_info(asc: &[u8]) -> Option<(u32, u16)> {
    let mut b = Bits::new(asc);
    let mut ot = b.bits(5)?;
    if ot == 31 {
        ot = 32 + b.bits(6)?;
    }
    let _ = ot;
    let idx = b.bits(4)? as usize;
    let rate = if idx == 15 { b.bits(24)? as u32 } else { *AAC_RATES.get(idx)? };
    let ch = b.bits(4)? as u16;
    Some((rate, ch))
}

/// Builds the decoder configuration record for a video codec from the
/// parameter sets in a key frame (what the stream really uses) and, failing
/// that, from what the encoder handed over (`header`, Annex B or OBUs). None
/// when the parameter sets are not there yet.
pub fn video_config(codec: CodecId, header: &[u8], keyframe: &[u8]) -> Option<Vec<u8>> {
    match codec {
        CodecId::H264 | CodecId::Hevc => {
            let mut p = ParamSets::collect(codec, keyframe);
            if !p.is_complete(codec) {
                let h = ParamSets::collect(codec, header);
                if h.is_complete(codec) {
                    p = h;
                }
            }
            if !p.is_complete(codec) {
                return None;
            }
            if codec == CodecId::H264 {
                avcc(&p)
            } else {
                hvcc(&p)
            }
        }
        CodecId::Av1 => {
            // A header given as an av1C record already.
            if header.first() == Some(&0x81) && header.len() > 4 {
                return Some(header.to_vec());
            }
            av1c(keyframe).or_else(|| av1c(header))
        }
        CodecId::Aac => None,
    }
}

/// Picture size from a decoder configuration record (for checks and repair).
pub fn config_size(codec: CodecId, rec: &[u8]) -> Option<(u32, u32)> {
    match codec {
        CodecId::H264 => h264_sps_info(avcc_params(rec).sps.first()?).map(|i| (i.width, i.height)),
        CodecId::Hevc => hevc_sps_info(hvcc_params(rec).sps.first()?).map(|i| (i.width, i.height)),
        CodecId::Av1 => {
            let o = Obus::new(av1c_seq_header(rec)?).find(|o| o.kind == 1)?;
            av1_seq_info(o.payload).map(|i| (i.width, i.height))
        }
        CodecId::Aac => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::container::testdata;

    #[test]
    fn annexb_splits_three_and_four_byte_start_codes() {
        let d = [0, 0, 0, 1, 0x67, 1, 2, 0, 0, 1, 0x68, 3, 0, 0, 0, 1, 0x65, 9, 9, 0];
        let n: Vec<&[u8]> = annexb_nals(&d).collect();
        assert_eq!(n, vec![&[0x67, 1, 2][..], &[0x68, 3][..], &[0x65, 9, 9][..]]);
        let mut out = Vec::new();
        assert!(append_sample(CodecId::H264, &d, &mut out));
        assert_eq!(out.len(), sample_size(CodecId::H264, &d));
        assert_eq!(out, vec![0, 0, 0, 3, 0x67, 1, 2, 0, 0, 0, 2, 0x68, 3, 0, 0, 0, 3, 0x65, 9, 9]);
        assert!(is_keyframe(CodecId::H264, &d) && is_keyframe(CodecId::H264, &out));
    }

    #[test]
    fn access_unit_delimiters_are_dropped() {
        let d = [0, 0, 0, 1, 0x09, 0xF0, 0, 0, 0, 1, 0x41, 7];
        let mut out = Vec::new();
        append_sample(CodecId::H264, &d, &mut out);
        assert_eq!(out, vec![0, 0, 0, 2, 0x41, 7]);
        assert!(!is_keyframe(CodecId::H264, &d));
    }

    #[test]
    fn unescape_removes_emulation_prevention() {
        assert_eq!(unescape(&[1, 0, 0, 3, 1, 0, 0, 3]), vec![1, 0, 0, 1, 0, 0]);
    }

    #[test]
    fn avcc_round_trips_and_reads_the_picture_size() {
        let s = testdata::H264Stream::new(64, 48);
        let p = ParamSets::collect(CodecId::H264, &s.idr(0));
        assert!(p.is_complete(CodecId::H264));
        let rec = avcc(&p).unwrap();
        assert_eq!(rec[0], 1);
        assert_eq!(avcc_params(&rec), p);
        assert_eq!(config_size(CodecId::H264, &rec), Some((64, 48)));
    }

    #[test]
    fn aac_config_is_lc_48k_stereo() {
        assert_eq!(aac_config(48_000, 2), [0x11, 0x90]);
        assert_eq!(aac_config_info(&[0x11, 0x90]), Some((48_000, 2)));
        assert_eq!(aac_config_info(&aac_config(44_100, 1)), Some((44_100, 1)));
    }

    #[test]
    fn av1_clean_drops_delimiters_and_adds_sizes() {
        // TD (type 2, size 0), then a padding-free frame OBU (type 6) without a size field.
        let tu = [0x12, 0x00, 0x30, 0xAA, 0xBB];
        let mut out = Vec::new();
        av1_clean(&tu, &mut out);
        assert_eq!(out, vec![0x32, 0x02, 0xAA, 0xBB]);
        assert_eq!(sample_size(CodecId::Av1, &tu), out.len());
    }

    #[test]
    fn leb128_round_trips() {
        for v in [0u64, 1, 127, 128, 300, 1 << 20, (1 << 35) + 7] {
            let mut b = Vec::new();
            write_leb128(v, &mut b);
            assert_eq!(b.len(), leb128_len(v));
            let mut p = 0;
            assert_eq!(read_leb128(&b, &mut p), Some(v));
        }
    }
}
