//! Picture maths for the editor render, all on NV12 frames:
//!
//! - where a picture goes (crop, quarter turns, flips, size, position): the
//!   same rules as the preview's `placement()` in `src/editor/compose.ts`;
//! - drawing pictures onto the frame with bilinear sampling, in bands on a
//!   few threads;
//! - the blur and pixelate boxes.
//!
//! Working in NV12 (the encoder's format) avoids two colour conversions per
//! pixel; blur and pixelate are linear, so doing them on Y/U/V gives the same
//! result as on RGB.

use serde::Deserialize;

/// A rectangle in fractions of a picture (0..1).
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct CropF {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// How a picture is shown: everything `placement()` needs besides sizes.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Pose {
    pub crop: Option<CropF>,
    /// Clockwise quarter turn: 0, 90, 180 or 270.
    pub rot90: u32,
    pub flip_h: bool,
    pub flip_v: bool,
    /// 1 = fit (or cover, with `fill`) the frame.
    pub scale: f64,
    /// Centre, as fractions of the frame.
    pub cx: f64,
    pub cy: f64,
    /// Cover the frame instead of fitting in it.
    pub fill: bool,
}

impl Default for Pose {
    fn default() -> Self {
        Pose { crop: None, rot90: 0, flip_h: false, flip_v: false, scale: 1.0, cx: 0.5, cy: 0.5, fill: false }
    }
}

impl Pose {
    /// Shown whole, centred, fitted: the plain letterbox case.
    pub fn is_plain(&self) -> bool {
        let full = self.crop.map_or(true, |c| {
            c.x.abs() < 1e-6 && c.y.abs() < 1e-6 && (c.w - 1.0).abs() < 1e-6 && (c.h - 1.0).abs() < 1e-6
        });
        full && self.rot90 == 0
            && !self.flip_h
            && !self.flip_v
            && !self.fill
            && (self.scale - 1.0).abs() < 1e-6
            && (self.cx - 0.5).abs() < 1e-6
            && (self.cy - 0.5).abs() < 1e-6
    }
}

/// Normalises a turn to 0, 90, 180 or 270.
pub fn norm_rot(r: f64) -> u32 {
    let q = (r / 90.0).round() as i64;
    (q.rem_euclid(4) * 90) as u32
}

/// Where a picture goes, in the preview's terms.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Placement {
    /// Source rectangle (source pixels).
    pub sx: f64,
    pub sy: f64,
    pub sw: f64,
    pub sh: f64,
    /// Centre on the frame and drawn size before the turn (frame pixels).
    pub cx: f64,
    pub cy: f64,
    pub dw: f64,
    pub dh: f64,
    pub rot: u32,
    pub flip_h: bool,
    pub flip_v: bool,
}

/// Where a picture of natural size `nw x nh` goes on a `fw x fh` frame.
/// Mirrors `placement()` in `src/editor/compose.ts`.
pub fn placement(p: &Pose, nw: f64, nh: f64, fw: f64, fh: f64) -> Placement {
    let c = p.crop.unwrap_or(CropF { x: 0.0, y: 0.0, w: 1.0, h: 1.0 });
    let sx = c.x * nw;
    let sy = c.y * nh;
    let sw = (c.w * nw).max(1.0);
    let sh = (c.h * nh).max(1.0);
    let turned = p.rot90 == 90 || p.rot90 == 270;
    let (vw, vh) = if turned { (sh, sw) } else { (sw, sh) };
    let k = if p.fill { (fw / vw).max(fh / vh) } else { (fw / vw).min(fh / vh) } * p.scale;
    Placement {
        sx,
        sy,
        sw,
        sh,
        cx: p.cx * fw,
        cy: p.cy * fh,
        dw: sw * k,
        dh: sh * k,
        rot: p.rot90,
        flip_h: p.flip_h,
        flip_v: p.flip_v,
    }
}

/// `frame point -> source point`: `u = a x + b y + c`, `v = d x + e y + f`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Affine {
    pub a: f64,
    pub b: f64,
    pub c: f64,
    pub d: f64,
    pub e: f64,
    pub f: f64,
}

impl Affine {
    pub fn apply(&self, x: f64, y: f64) -> (f64, f64) {
        (self.a * x + self.b * y + self.c, self.d * x + self.e * y + self.f)
    }
}

impl Placement {
    /// Drawn box on the frame after the turn: `(x, y, w, h)`.
    pub fn bbox(&self) -> (f64, f64, f64, f64) {
        let turned = self.rot == 90 || self.rot == 270;
        let (w, h) = if turned { (self.dh, self.dw) } else { (self.dw, self.dh) };
        (self.cx - w / 2.0, self.cy - h / 2.0, w, h)
    }

    /// The same placement for the picture decoded at another size
    /// (`fx`, `fy` = decoded / natural).
    pub fn rescaled_source(&self, fx: f64, fy: f64) -> Placement {
        Placement { sx: self.sx * fx, sy: self.sy * fy, sw: self.sw * fx, sh: self.sh * fy, ..*self }
    }

    /// Frame point to source point. The canvas draws with
    /// `translate(c) rotate(rot) scale(flip)`, so the inverse undoes the turn
    /// first, then the flip, then maps the drawn box onto the source rect.
    pub fn inverse(&self) -> Affine {
        // Undo a clockwise turn (y points down).
        let (r00, r01, r10, r11) = match self.rot {
            90 => (0.0, 1.0, -1.0, 0.0),
            180 => (-1.0, 0.0, 0.0, -1.0),
            270 => (0.0, -1.0, 1.0, 0.0),
            _ => (1.0, 0.0, 0.0, 1.0),
        };
        let fx = if self.flip_h { -1.0 } else { 1.0 };
        let fy = if self.flip_v { -1.0 } else { 1.0 };
        let kx = self.sw / self.dw.max(1e-9);
        let ky = self.sh / self.dh.max(1e-9);
        let a = kx * fx * r00;
        let b = kx * fx * r01;
        let d = ky * fy * r10;
        let e = ky * fy * r11;
        Affine {
            a,
            b,
            c: self.sx + self.sw / 2.0 - a * self.cx - b * self.cy,
            d,
            e,
            f: self.sy + self.sh / 2.0 - d * self.cx - e * self.cy,
        }
    }
}

/// Size to decode a `nw x nh` source at: no bigger than drawn (so the
/// sampler never minifies much) and never above native. Even, at least 2.
pub fn decode_size(pl: &Placement, nw: u32, nh: u32) -> (u32, u32) {
    let k = (pl.dw / pl.sw.max(1e-9)).min(1.0);
    let even = |v: f64, max: u32| ((v.round() as u32).clamp(2, max.max(2))) & !1;
    (even(nw as f64 * k, nw), even(nh as f64 * k, nh))
}

// ------------------------------------------------------------------ drawing

/// An NV12 picture (Y plane, then interleaved UV at half size), with
/// optional alpha (full size, and per 2x2 block for the chroma).
#[derive(Clone, Copy)]
pub struct Src<'a> {
    pub w: usize,
    pub h: usize,
    pub y: &'a [u8],
    pub uv: &'a [u8],
    pub a: Option<&'a [u8]>,
    pub ca: Option<&'a [u8]>,
}

/// One picture to draw.
pub struct Draw<'a> {
    pub src: Src<'a>,
    /// Frame point to source pixel point.
    pub map: Affine,
    /// Source rectangle that may be sampled: `x0, y0, x1, y1`.
    pub rect: (f64, f64, f64, f64),
    /// Frame pixels it can touch: `x0, y0, x1, y1` (exclusive), clipped.
    pub bbox: (usize, usize, usize, usize),
}

impl<'a> Draw<'a> {
    /// `pl` must be in `src` pixels (see `Placement::rescaled_source`).
    pub fn new(src: Src<'a>, pl: &Placement, fw: usize, fh: usize) -> Option<Draw<'a>> {
        let (x, y, w, h) = pl.bbox();
        let x0 = x.floor().max(0.0) as usize;
        let y0 = y.floor().max(0.0) as usize;
        let x1 = ((x + w).ceil().max(0.0) as usize).min(fw);
        let y1 = ((y + h).ceil().max(0.0) as usize).min(fh);
        if x0 >= x1 || y0 >= y1 || src.w < 2 || src.h < 2 {
            return None;
        }
        let rx0 = pl.sx.clamp(0.0, src.w as f64);
        let ry0 = pl.sy.clamp(0.0, src.h as f64);
        let rx1 = (pl.sx + pl.sw).clamp(0.0, src.w as f64);
        let ry1 = (pl.sy + pl.sh).clamp(0.0, src.h as f64);
        if rx1 - rx0 < 0.5 || ry1 - ry0 < 0.5 {
            return None;
        }
        Some(Draw { src, map: pl.inverse(), rect: (rx0, ry0, rx1, ry1), bbox: (x0, y0, x1, y1) })
    }
}

#[inline]
fn lerp_w(t: f32) -> (f32, f32) {
    (1.0 - t, t)
}

/// Draws `draws` (bottom first) onto an NV12 frame `fw x fh`, splitting
/// the rows over up to `threads` threads.
pub fn composite(frame: &mut [u8], fw: usize, fh: usize, draws: &[Draw], threads: usize) {
    if draws.is_empty() {
        return;
    }
    let (yp, uvp) = frame.split_at_mut(fw * fh);
    let threads = threads.clamp(1, 16).min(fh / 16).max(1);
    let band = (fh.div_ceil(threads) + 1) & !1;
    if threads == 1 {
        draw_band(yp, uvp, 0, fw, draws);
        return;
    }
    std::thread::scope(|s| {
        for (i, (yb, uvb)) in yp.chunks_mut(band * fw).zip(uvp.chunks_mut(band / 2 * fw)).enumerate() {
            s.spawn(move || draw_band(yb, uvb, i * band, fw, draws));
        }
    });
}

/// Draws into rows `row0..` of the luma (`yb`) and the matching chroma rows.
fn draw_band(yb: &mut [u8], uvb: &mut [u8], row0: usize, fw: usize, draws: &[Draw]) {
    let rows = yb.len() / fw;
    let crows = uvb.len() / fw;
    let crow0 = row0 / 2;
    for d in draws {
        let (bx0, by0, bx1, by1) = d.bbox;
        let (rx0, ry0, rx1, ry1) = d.rect;
        let s = &d.src;
        let m = &d.map;
        // Valid sample indices (pixel centres inside the source rect).
        let ix0 = rx0.floor() as f32;
        let ix1 = ((rx1.ceil() as usize).min(s.w) - 1) as f32;
        let iy0 = ry0.floor() as f32;
        let iy1 = ((ry1.ceil() as usize).min(s.h) - 1) as f32;

        // Luma.
        for y in by0.max(row0)..by1.min(row0 + rows) {
            let py = y as f64 + 0.5;
            let mut u = m.a * (bx0 as f64 + 0.5) + m.b * py + m.c;
            let mut v = m.d * (bx0 as f64 + 0.5) + m.e * py + m.f;
            let out = &mut yb[(y - row0) * fw..(y - row0) * fw + fw];
            for o in out.iter_mut().take(bx1).skip(bx0) {
                if u >= rx0 && u < rx1 && v >= ry0 && v < ry1 {
                    let fx = (u as f32 - 0.5).clamp(ix0, ix1);
                    let fy = (v as f32 - 0.5).clamp(iy0, iy1);
                    let x0 = fx as usize;
                    let y0 = fy as usize;
                    let x1 = (x0 + 1).min(ix1 as usize);
                    let y1 = (y0 + 1).min(iy1 as usize);
                    let (wx0, wx1) = lerp_w(fx - x0 as f32);
                    let (wy0, wy1) = lerp_w(fy - y0 as f32);
                    let (i00, i01, i10, i11) = (y0 * s.w + x0, y0 * s.w + x1, y1 * s.w + x0, y1 * s.w + x1);
                    let (w00, w01, w10, w11) = (wx0 * wy0, wx1 * wy0, wx0 * wy1, wx1 * wy1);
                    match s.a {
                        None => {
                            let val = s.y[i00] as f32 * w00
                                + s.y[i01] as f32 * w01
                                + s.y[i10] as f32 * w10
                                + s.y[i11] as f32 * w11;
                            *o = (val + 0.5) as u8;
                        }
                        Some(a) => {
                            let (a00, a01, a10, a11) =
                                (a[i00] as f32 * w00, a[i01] as f32 * w01, a[i10] as f32 * w10, a[i11] as f32 * w11);
                            let asum = a00 + a01 + a10 + a11;
                            if asum > 0.5 {
                                let c = (s.y[i00] as f32 * a00
                                    + s.y[i01] as f32 * a01
                                    + s.y[i10] as f32 * a10
                                    + s.y[i11] as f32 * a11)
                                    / asum;
                                let al = (asum / 255.0).min(1.0);
                                *o = (c * al + *o as f32 * (1.0 - al) + 0.5) as u8;
                            }
                        }
                    }
                }
                u += m.a;
                v += m.d;
            }
        }

        // Chroma: one sample per 2x2 block, mapped from the block centre.
        let (cw, ch) = (s.w / 2, s.h / 2);
        if cw == 0 || ch == 0 {
            continue;
        }
        let cx0 = bx0 / 2;
        let cx1 = bx1.div_ceil(2).min(fw / 2);
        let cy0 = by0 / 2;
        let cy1 = by1.div_ceil(2);
        let jx0 = (rx0 / 2.0).floor() as f32;
        let jx1 = (((rx1 / 2.0).ceil() as usize).clamp(1, cw) - 1) as f32;
        let jy0 = (ry0 / 2.0).floor() as f32;
        let jy1 = (((ry1 / 2.0).ceil() as usize).clamp(1, ch) - 1) as f32;
        for cy in cy0.max(crow0)..cy1.min(crow0 + crows) {
            let py = cy as f64 * 2.0 + 1.0;
            let mut u = m.a * (cx0 as f64 * 2.0 + 1.0) + m.b * py + m.c;
            let mut v = m.d * (cx0 as f64 * 2.0 + 1.0) + m.e * py + m.f;
            let row = (cy - crow0) * fw;
            for cx in cx0..cx1 {
                if u >= rx0 && u < rx1 && v >= ry0 && v < ry1 {
                    let fx = (u as f32 / 2.0 - 0.5).clamp(jx0, jx1);
                    let fy = (v as f32 / 2.0 - 0.5).clamp(jy0, jy1);
                    let x0 = fx as usize;
                    let y0 = fy as usize;
                    let x1 = (x0 + 1).min(jx1 as usize);
                    let y1 = (y0 + 1).min(jy1 as usize);
                    let (wx0, wx1) = lerp_w(fx - x0 as f32);
                    let (wy0, wy1) = lerp_w(fy - y0 as f32);
                    let ks = [(y0 * cw + x0, wx0 * wy0), (y0 * cw + x1, wx1 * wy0), (y1 * cw + x0, wx0 * wy1), (y1 * cw + x1, wx1 * wy1)];
                    let o = row + cx * 2;
                    match s.ca {
                        None => {
                            let (mut su, mut sv) = (0.0f32, 0.0f32);
                            for (k, w) in ks {
                                su += s.uv[k * 2] as f32 * w;
                                sv += s.uv[k * 2 + 1] as f32 * w;
                            }
                            uvb[o] = (su + 0.5) as u8;
                            uvb[o + 1] = (sv + 0.5) as u8;
                        }
                        Some(ca) => {
                            let (mut su, mut sv, mut sa) = (0.0f32, 0.0f32, 0.0f32);
                            for (k, w) in ks {
                                let aw = ca[k] as f32 * w;
                                su += s.uv[k * 2] as f32 * aw;
                                sv += s.uv[k * 2 + 1] as f32 * aw;
                                sa += aw;
                            }
                            if sa > 0.5 {
                                let al = (sa / 255.0).min(1.0);
                                uvb[o] = (su / sa * al + uvb[o] as f32 * (1.0 - al) + 0.5) as u8;
                                uvb[o + 1] = (sv / sa * al + uvb[o + 1] as f32 * (1.0 - al) + 0.5) as u8;
                            }
                        }
                    }
                }
                u += m.a * 2.0;
                v += m.d * 2.0;
            }
        }
    }
}

/// A still picture as NV12 planes with alpha (`a`/`ca` empty = opaque).
pub struct Planes {
    pub w: usize,
    pub h: usize,
    pub y: Vec<u8>,
    pub uv: Vec<u8>,
    pub a: Vec<u8>,
    pub ca: Vec<u8>,
}

impl Planes {
    /// From RGBA (cut to even sizes). BT.709 limited, like the encoder.
    pub fn from_rgba(img: &image::RgbaImage) -> Option<Planes> {
        let (iw, ih) = (img.width() as usize, img.height() as usize);
        let (w, h) = (iw & !1, ih & !1);
        if w < 2 || h < 2 {
            return None;
        }
        let raw = img.as_raw();
        let mut y = vec![0u8; w * h];
        let mut a = vec![0u8; w * h];
        let mut uv = vec![128u8; w * h / 2];
        let mut ca = vec![0u8; w * h / 4];
        let mut opaque = true;
        for r in 0..h {
            for c in 0..w {
                let i = (r * iw + c) * 4;
                let (yy, _, _) = super::compose::yuv(raw[i] as f32, raw[i + 1] as f32, raw[i + 2] as f32);
                y[r * w + c] = yy.round().clamp(0.0, 255.0) as u8;
                a[r * w + c] = raw[i + 3];
                opaque &= raw[i + 3] == 255;
            }
        }
        for r in 0..h / 2 {
            for c in 0..w / 2 {
                let (mut su, mut sv, mut sa) = (0.0f32, 0.0f32, 0.0f32);
                for (dy, dx) in [(0, 0), (0, 1), (1, 0), (1, 1)] {
                    let i = ((r * 2 + dy) * iw + c * 2 + dx) * 4;
                    let al = raw[i + 3] as f32;
                    let (_, u, v) = super::compose::yuv(raw[i] as f32, raw[i + 1] as f32, raw[i + 2] as f32);
                    su += u * al;
                    sv += v * al;
                    sa += al;
                }
                let k = r * (w / 2) + c;
                if sa > 0.0 {
                    uv[k * 2] = (su / sa).round().clamp(0.0, 255.0) as u8;
                    uv[k * 2 + 1] = (sv / sa).round().clamp(0.0, 255.0) as u8;
                }
                ca[k] = (sa / 4.0).round() as u8;
            }
        }
        if opaque {
            a.clear();
            ca.clear();
        }
        Some(Planes { w, h, y, uv, a, ca })
    }

    pub fn src(&self) -> Src<'_> {
        fn opt(v: &[u8]) -> Option<&[u8]> {
            (!v.is_empty()).then_some(v)
        }
        Src { w: self.w, h: self.h, y: &self.y, uv: &self.uv, a: opt(&self.a), ca: opt(&self.ca) }
    }
}

// ------------------------------------------------------------------ regions

/// A box in frame pixels, clipped: `x0, y0, x1, y1` (exclusive).
pub fn region_box(x: f64, y: f64, w: f64, h: f64, fw: usize, fh: usize) -> Option<(usize, usize, usize, usize)> {
    let x0 = (x * fw as f64).round().max(0.0) as usize;
    let y0 = (y * fh as f64).round().max(0.0) as usize;
    let x1 = (((x + w) * fw as f64).round().max(0.0) as usize).min(fw);
    let y1 = (((y + h) * fh as f64).round().max(0.0) as usize).min(fh);
    (x0 < x1 && y0 < y1).then_some((x0, y0, x1, y1))
}

/// Pixelates a box of an NV12 frame like the preview: `round(w / block)`
/// cells across, each filled with its average.
/// Strongest blur / biggest pixel block, as the editor's slider allows.
pub const MAX_STRENGTH: f64 = 60.0;

/// A region strength kept to 2..=MAX_STRENGTH (16 when it is not a number).
pub fn strength(v: f64) -> f64 {
    if v.is_finite() {
        v.clamp(2.0, MAX_STRENGTH)
    } else {
        16.0
    }
}

pub fn pixelate(frame: &mut [u8], fw: usize, fh: usize, bx: (usize, usize, usize, usize), block: f64) {
    let (x0, y0, x1, y1) = bx;
    let (bw, bh) = ((x1 - x0) as f64, (y1 - y0) as f64);
    let block = strength(block);
    let tw = ((bw / block).round() as usize).max(1);
    let th = ((bh / block).round() as usize).max(1);
    let (yp, uvp) = frame.split_at_mut(fw * fh);
    let edge = |i: usize, n: usize, len: f64, o: usize| o + (i as f64 * len / n as f64).round() as usize;
    for j in 0..th {
        let (ya, yb) = (edge(j, th, bh, y0), edge(j + 1, th, bh, y0));
        for i in 0..tw {
            let (xa, xb) = (edge(i, tw, bw, x0), edge(i + 1, tw, bw, x0));
            if xa >= xb || ya >= yb {
                continue;
            }
            // Luma.
            let mut sum = 0u64;
            for r in ya..yb {
                sum += yp[r * fw + xa..r * fw + xb].iter().map(|&p| p as u64).sum::<u64>();
            }
            let avg = (sum / ((xb - xa) * (yb - ya)) as u64) as u8;
            for r in ya..yb {
                yp[r * fw + xa..r * fw + xb].fill(avg);
            }
            // Chroma (2x2 blocks touching the cell).
            let (ca, cb) = (xa / 2, xb.div_ceil(2).min(fw / 2));
            let (ra, rb) = (ya / 2, yb.div_ceil(2).min(fh / 2));
            let (mut su, mut sv, mut n) = (0u64, 0u64, 0u64);
            for r in ra..rb {
                for c in ca..cb {
                    su += uvp[r * fw + c * 2] as u64;
                    sv += uvp[r * fw + c * 2 + 1] as u64;
                    n += 1;
                }
            }
            if let (Some(au), Some(av)) = (su.checked_div(n), sv.checked_div(n)) {
                let (au, av) = (au as u8, av as u8);
                for r in ra..rb {
                    for c in ca..cb {
                        uvp[r * fw + c * 2] = au;
                        uvp[r * fw + c * 2 + 1] = av;
                    }
                }
            }
        }
    }
}

/// Box radius for three passes approximating a Gaussian of `sigma`.
pub fn box_radius(sigma: f64) -> usize {
    let n = (4.0 * sigma * sigma + 1.0).sqrt();
    ((n - 1.0) / 2.0).round().max(1.0) as usize
}

/// Gaussian-like blur (three box passes each way) of a box of an NV12
/// frame; `sigma` in luma pixels. Pixels around the box feed the blur.
pub fn blur(frame: &mut [u8], fw: usize, fh: usize, bx: (usize, usize, usize, usize), sigma: f64, scratch: &mut Vec<f32>) {
    let sigma = strength(sigma);
    let (yp, uvp) = frame.split_at_mut(fw * fh);
    blur_plane(yp, fw, fw, fh, 1, 0, bx, box_radius(sigma), scratch);
    let cb = (bx.0 / 2, bx.1 / 2, bx.2.div_ceil(2).min(fw / 2), bx.3.div_ceil(2).min(fh / 2));
    let r = box_radius(sigma / 2.0);
    blur_plane(uvp, fw, fw / 2, fh / 2, 2, 0, cb, r, scratch);
    blur_plane(uvp, fw, fw / 2, fh / 2, 2, 1, cb, r, scratch);
}

/// Blurs box `bx` of a plane `pw x ph` whose samples sit at
/// `row * stride + col * step + off`.
#[allow(clippy::too_many_arguments)]
fn blur_plane(
    plane: &mut [u8],
    stride: usize,
    pw: usize,
    ph: usize,
    step: usize,
    off: usize,
    bx: (usize, usize, usize, usize),
    r: usize,
    scratch: &mut Vec<f32>,
) {
    let (x0, y0, x1, y1) = bx;
    if x0 >= x1 || y0 >= y1 {
        return;
    }
    let pad = 3 * r;
    let ax0 = x0.saturating_sub(pad);
    let ay0 = y0.saturating_sub(pad);
    let ax1 = (x1 + pad).min(pw);
    let ay1 = (y1 + pad).min(ph);
    let (w, h) = (ax1 - ax0, ay1 - ay0);
    scratch.clear();
    scratch.resize(w * h + 2 * (w.max(h) + 2 * r + 1), 0.0);
    let (img, tmp) = scratch.split_at_mut(w * h);
    for yy in 0..h {
        for xx in 0..w {
            img[yy * w + xx] = plane[(ay0 + yy) * stride + (ax0 + xx) * step + off] as f32;
        }
    }
    for _ in 0..3 {
        for yy in 0..h {
            box_line(img, yy * w, 1, w, r, tmp);
        }
        for xx in 0..w {
            box_line(img, xx, w, h, r, tmp);
        }
    }
    for yy in y0..y1 {
        for xx in x0..x1 {
            let v = img[(yy - ay0) * w + (xx - ax0)];
            plane[yy * stride + xx * step + off] = v.round().clamp(0.0, 255.0) as u8;
        }
    }
}

/// One box pass (radius `r`, edges repeated) over `n` values at
/// `start + i * step`. `tmp` holds at least `n + 2r + 1` values.
fn box_line(img: &mut [f32], start: usize, step: usize, n: usize, r: usize, tmp: &mut [f32]) {
    // Prefix sums of the edge-extended line.
    let len = n + 2 * r;
    let at = |i: usize| -> f32 {
        let k = i.saturating_sub(r).min(n - 1);
        img[start + k * step]
    };
    tmp[0] = 0.0;
    for i in 0..len {
        tmp[i + 1] = tmp[i] + at(i);
    }
    let win = (2 * r + 1) as f32;
    for i in 0..n {
        img[start + i * step] = (tmp[i + 2 * r + 1] - tmp[i]) / win;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn near(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-6
    }

    #[test]
    fn plain_fit_letterboxes() {
        let pl = placement(&Pose::default(), 1920.0, 1080.0, 1080.0, 1920.0);
        assert!(near(pl.dw, 1080.0) && near(pl.dh, 607.5));
        assert_eq!(pl.bbox(), (0.0, 960.0 - 303.75, 1080.0, 607.5));
        assert!(Pose::default().is_plain());
    }

    #[test]
    fn fill_covers_and_scale_multiplies() {
        let p = Pose { fill: true, scale: 2.0, ..Pose::default() };
        let pl = placement(&p, 1920.0, 1080.0, 1080.0, 1920.0);
        // Cover: k = 1920/1080, then x2.
        assert!(near(pl.dh, 1080.0 * 1920.0 / 1080.0 * 2.0));
        assert!(!p.is_plain());
    }

    #[test]
    fn crop_and_turn_swap_the_visible_size() {
        let p = Pose { crop: Some(CropF { x: 0.25, y: 0.0, w: 0.5, h: 1.0 }), rot90: 90, ..Pose::default() };
        let pl = placement(&p, 1920.0, 1080.0, 1920.0, 1080.0);
        // Source rect 960x1080; turned it shows 1080 wide x 960 tall, so
        // fit k = min(1920/1080, 1080/960) = 1.125.
        assert!(near(pl.sx, 480.0) && near(pl.sw, 960.0) && near(pl.sh, 1080.0));
        assert!(near(pl.dw, 1080.0) && near(pl.dh, 1215.0));
        let (x, y, w, h) = pl.bbox();
        assert!(near(w, 1215.0) && near(h, 1080.0) && near(x, 352.5) && near(y, 0.0));
    }

    #[test]
    fn inverse_maps_corners() {
        // 100x50 source on a 200x100 frame: drawn 200x100 at the centre.
        let base = Pose::default();
        let pl = placement(&base, 100.0, 50.0, 200.0, 100.0);
        let m = pl.inverse();
        assert_eq!(m.apply(0.0, 0.0), (0.0, 0.0));
        assert_eq!(m.apply(200.0, 100.0), (100.0, 50.0));
        // Flip H: the frame's left edge shows the source's right edge.
        let pl = placement(&Pose { flip_h: true, ..base }, 100.0, 50.0, 200.0, 100.0);
        let (u, v) = pl.inverse().apply(0.0, 0.0);
        assert!(near(u, 100.0) && near(v, 0.0));
        // Flip V.
        let pl = placement(&Pose { flip_v: true, ..base }, 100.0, 50.0, 200.0, 100.0);
        let (u, v) = pl.inverse().apply(0.0, 0.0);
        assert!(near(u, 0.0) && near(v, 50.0));
        // 90 clockwise: the source's top-left lands at the box's top-right.
        let pl = placement(&Pose { rot90: 90, ..base }, 100.0, 50.0, 200.0, 100.0);
        let (bx, by, bw, _) = pl.bbox();
        let (u, v) = pl.inverse().apply(bx + bw, by);
        assert!(near(u, 0.0) && near(v, 0.0), "{u} {v}");
        // 270: the source's top-left lands at the box's bottom-left.
        let pl = placement(&Pose { rot90: 270, ..base }, 100.0, 50.0, 200.0, 100.0);
        let (bx, by, _, bh) = pl.bbox();
        let (u, v) = pl.inverse().apply(bx, by + bh);
        assert!(near(u, 0.0) && near(v, 0.0), "{u} {v}");
        // 180: top-left lands bottom-right.
        let pl = placement(&Pose { rot90: 180, ..base }, 100.0, 50.0, 200.0, 100.0);
        let (u, v) = pl.inverse().apply(200.0, 100.0);
        assert!(near(u, 0.0) && near(v, 0.0));
    }

    #[test]
    fn crop_offset_and_centre_move_the_picture() {
        let p = Pose { crop: Some(CropF { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }), cx: 0.25, cy: 0.75, scale: 0.5, ..Pose::default() };
        let pl = placement(&p, 100.0, 100.0, 100.0, 100.0);
        // 50x50 source rect, fit k = 2, x0.5 = 1: drawn 50x50 centred at (25, 75).
        assert_eq!(pl.bbox(), (0.0, 50.0, 50.0, 50.0));
        let m = pl.inverse();
        assert_eq!(m.apply(0.0, 50.0), (50.0, 50.0));
        assert_eq!(m.apply(50.0, 100.0), (100.0, 100.0));
        // Decoded at half size: the source rect halves too.
        let r = pl.rescaled_source(0.5, 0.5);
        assert_eq!(r.inverse().apply(50.0, 100.0), (50.0, 50.0));
    }

    #[test]
    fn decode_size_never_upscales() {
        let pl = placement(&Pose::default(), 3840.0, 2160.0, 1920.0, 1080.0);
        assert_eq!(decode_size(&pl, 3840, 2160), (1920, 1080));
        let pl = placement(&Pose::default(), 1280.0, 720.0, 1920.0, 1080.0);
        assert_eq!(decode_size(&pl, 1281, 721), (1280, 720));
        assert_eq!(norm_rot(-90.0), 270);
        assert_eq!(norm_rot(450.0), 90);
    }

    fn nv12(w: usize, h: usize, y: u8, u: u8, v: u8) -> Vec<u8> {
        let mut f = vec![y; w * h * 3 / 2];
        for k in 0..w * h / 4 {
            f[w * h + k * 2] = u;
            f[w * h + k * 2 + 1] = v;
        }
        f
    }

    #[test]
    fn composite_copies_exactly_at_one_to_one() {
        let (sw, sh) = (8usize, 4usize);
        let mut src = nv12(sw, sh, 0, 100, 150);
        for (i, p) in src[..sw * sh].iter_mut().enumerate() {
            *p = (i * 7 % 251) as u8;
        }
        let s = Src { w: sw, h: sh, y: &src[..sw * sh], uv: &src[sw * sh..], a: None, ca: None };
        // Fit doubles the picture; at a 1:1 placement (scale 0.5) it is copied.
        let pl = placement(&Pose { scale: 0.5, cx: 0.25, cy: 0.25, ..Pose::default() }, sw as f64, sh as f64, 16.0, 8.0);
        let mut frame = nv12(16, 8, 16, 128, 128);
        let d = Draw::new(s, &pl, 16, 8).unwrap();
        composite(&mut frame, 16, 8, &[d], 1);
        for r in 0..sh {
            for c in 0..sw {
                assert_eq!(frame[r * 16 + c], src[r * sw + c], "at {r},{c}");
            }
        }
        assert_eq!(frame[9], 16);
        assert_eq!(frame[16 * 8 + 2], 100);
        assert_eq!(frame[16 * 8 + 3], 150);
        assert_eq!(frame[16 * 8 + 8], 128);
    }

    #[test]
    fn composite_flip_and_threads_agree() {
        let (sw, sh) = (32usize, 32usize);
        let mut src = nv12(sw, sh, 0, 128, 128);
        for (i, p) in src[..sw * sh].iter_mut().enumerate() {
            *p = (i % sw * 8) as u8; // ramp left to right
        }
        let s = Src { w: sw, h: sh, y: &src[..sw * sh], uv: &src[sw * sh..], a: None, ca: None };
        let pl = placement(&Pose { flip_h: true, ..Pose::default() }, sw as f64, sh as f64, 64.0, 64.0);
        let mut one = nv12(64, 64, 16, 128, 128);
        let mut many = one.clone();
        composite(&mut one, 64, 64, &[Draw::new(s, &pl, 64, 64).unwrap()], 1);
        composite(&mut many, 64, 64, &[Draw::new(s, &pl, 64, 64).unwrap()], 4);
        assert_eq!(one, many);
        // Flipped: bright on the left, dark on the right.
        assert!(one[0] > 200 && one[63] < 10, "{} {}", one[0], one[63]);
    }

    #[test]
    fn transparent_still_keeps_the_background() {
        let mut img = image::RgbaImage::from_pixel(4, 4, image::Rgba([255, 255, 255, 0]));
        img.put_pixel(0, 0, image::Rgba([255, 255, 255, 255]));
        let p = Planes::from_rgba(&img).unwrap();
        let pl = placement(&Pose::default(), 4.0, 4.0, 4.0, 4.0);
        let mut f = nv12(4, 4, 16, 128, 128);
        composite(&mut f, 4, 4, &[Draw::new(p.src(), &pl, 4, 4).unwrap()], 1);
        assert_eq!(f[0], 235);
        assert_eq!(f[3], 16);
        assert_eq!(f[15], 16);
    }

    #[test]
    fn pixelate_averages_cells() {
        let mut f = nv12(8, 8, 0, 128, 128);
        for r in 0..8 {
            for c in 0..8 {
                f[r * 8 + c] = if c % 2 == 0 { 0 } else { 200 };
            }
        }
        pixelate(&mut f, 8, 8, (0, 0, 8, 8), 4.0);
        assert!(f[..64].iter().all(|&p| p == 100));
    }

    #[test]
    fn blur_smooths_inside_the_box_only() {
        let mut f = nv12(64, 64, 16, 128, 128);
        for r in 0..64 {
            for c in 32..64 {
                f[r * 64 + c] = 235;
            }
        }
        let before = f.clone();
        let mut scratch = Vec::new();
        blur(&mut f, 64, 64, (16, 16, 48, 48), 4.0, &mut scratch);
        // Edge inside the box softened.
        let mid = f[32 * 64 + 32];
        assert!(mid > 40 && mid < 230, "{mid}");
        // Outside the box untouched; flat areas stay flat.
        assert_eq!(f[10 * 64 + 40], before[10 * 64 + 40]);
        assert_eq!(f[32 * 64 + 17], 16);
        assert_eq!(box_radius(12.0), 12);
    }

    #[test]
    fn region_box_clips() {
        assert_eq!(region_box(-0.1, 0.5, 0.5, 1.0, 100, 100), Some((0, 50, 40, 100)));
        assert_eq!(region_box(1.1, 0.0, 0.5, 0.5, 100, 100), None);
    }
}
