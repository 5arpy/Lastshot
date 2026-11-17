//! Text and QR codes in a snip.
//!
//! Text comes from the OCR engine built into Windows (Windows.Media.Ocr), so
//! nothing is bundled: it reads the languages installed in Settings › Time &
//! language › Language. QR codes are decoded with `rqrr` (MIT/Apache + ISC).
//! Both read the frozen screen the snip holds (RGB, picture pixels).

use serde::Serialize;

/// One recognised word, in picture pixels.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct OcrWord {
    pub text: String,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct OcrLine {
    pub text: String,
    pub words: Vec<OcrWord>,
}

#[derive(Debug, Clone, Serialize)]
pub struct OcrResult {
    pub lines: Vec<OcrLine>,
    /// The recogniser's language ("en-US").
    pub language: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct OcrLanguage {
    pub tag: String,
    pub name: String,
}

/// An area of an RGB picture `pic_w` wide, clamped to it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Area {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

impl Area {
    pub fn clamp(x: i32, y: i32, w: i32, h: i32, pic_w: u32, pic_h: u32) -> Option<Area> {
        let x0 = x.clamp(0, pic_w as i32) as u32;
        let y0 = y.clamp(0, pic_h as i32) as u32;
        let x1 = (x.saturating_add(w)).clamp(0, pic_w as i32) as u32;
        let y1 = (y.saturating_add(h)).clamp(0, pic_h as i32) as u32;
        (x1 > x0 && y1 > y0).then_some(Area { x: x0, y: y0, w: x1 - x0, h: y1 - y0 })
    }
}

/// How much to scale an area before OCR: small text reads far better at 2x
/// (Windows OCR wants letters about 20 px tall), big areas are scaled down to
/// the engine's limit.
pub fn ocr_scale(w: u32, h: u32, max_dim: u32) -> f32 {
    let big = w.max(h).max(1) as f32;
    let max = max_dim.max(1) as f32;
    if big * 2.0 <= max && big <= 1600.0 {
        2.0
    } else if big > max {
        max / big
    } else {
        1.0
    }
}

/// The area as BGRA, scaled by `s` (bilinear), and its size.
fn bgra_of(rgb: &[u8], pic_w: u32, a: Area, s: f32) -> (Vec<u8>, u32, u32) {
    let ow = ((a.w as f32 * s).round() as u32).max(1);
    let oh = ((a.h as f32 * s).round() as u32).max(1);
    let mut out = vec![255u8; (ow * oh * 4) as usize];
    let px = |x: u32, y: u32| -> [f32; 3] {
        let i = (((a.y + y) * pic_w + (a.x + x)) * 3) as usize;
        [rgb[i] as f32, rgb[i + 1] as f32, rgb[i + 2] as f32]
    };
    for oy in 0..oh {
        let sy = ((oy as f32 + 0.5) / s - 0.5).clamp(0.0, (a.h - 1) as f32);
        let (y0, fy) = (sy.floor() as u32, sy.fract());
        let y1 = (y0 + 1).min(a.h - 1);
        for ox in 0..ow {
            let sx = ((ox as f32 + 0.5) / s - 0.5).clamp(0.0, (a.w - 1) as f32);
            let (x0, fx) = (sx.floor() as u32, sx.fract());
            let x1 = (x0 + 1).min(a.w - 1);
            let (p00, p10, p01, p11) = (px(x0, y0), px(x1, y0), px(x0, y1), px(x1, y1));
            let o = ((oy * ow + ox) * 4) as usize;
            for c in 0..3 {
                let top = p00[c] + (p10[c] - p00[c]) * fx;
                let bot = p01[c] + (p11[c] - p01[c]) * fx;
                // RGB in, BGR out.
                out[o + 2 - c] = (top + (bot - top) * fy).round().clamp(0.0, 255.0) as u8;
            }
        }
    }
    (out, ow, oh)
}

/// Greyscale of the area, halved while it is bigger than `max` px (QR codes
/// on screen are large; detection time grows with the area).
fn grey_of(rgb: &[u8], pic_w: u32, a: Area, max: u32) -> (Vec<u8>, u32, u32) {
    let mut step = 1u32;
    while a.w.max(a.h) / step > max {
        step *= 2;
    }
    let (w, h) = ((a.w / step).max(1), (a.h / step).max(1));
    let mut out = Vec::with_capacity((w * h) as usize);
    for y in 0..h {
        for x in 0..w {
            let i = (((a.y + y * step) * pic_w + (a.x + x * step)) * 3) as usize;
            let l = (rgb[i] as u32 * 299 + rgb[i + 1] as u32 * 587 + rgb[i + 2] as u32 * 114) / 1000;
            out.push(l as u8);
        }
    }
    (out, w, h)
}

/// Every QR code in the area: its text.
pub fn decode_qr(rgb: &[u8], pic_w: u32, a: Area) -> Vec<String> {
    let (grey, w, h) = grey_of(rgb, pic_w, a, 2400);
    let mut img = rqrr::PreparedImage::prepare_from_greyscale(w as usize, h as usize, |x, y| grey[y * w as usize + x]);
    let mut out: Vec<String> = Vec::new();
    for g in img.detect_grids() {
        if let Ok((_, text)) = g.decode() {
            if !text.is_empty() && !out.contains(&text) {
                out.push(text);
            }
        }
    }
    out
}

pub use imp::{languages, recognize};

#[cfg(all(windows, not(feature = "headless-sim")))]
mod imp {
    use super::*;
    use windows::core::HSTRING;
    use windows::Globalization::Language;
    use windows::Graphics::Imaging::{BitmapAlphaMode, BitmapPixelFormat, SoftwareBitmap};
    use windows::Media::Ocr::OcrEngine;
    use windows::Security::Cryptography::CryptographicBuffer;

    const NO_LANGUAGE: &str =
        "Windows has no text-recognition language installed. Add one in Settings › Time & language › Language & region (a language with \"Optical character recognition\").";

    fn engine(lang: Option<&str>) -> Result<OcrEngine, String> {
        if let Some(tag) = lang.filter(|t| !t.is_empty()) {
            if let Ok(l) = Language::CreateLanguage(&HSTRING::from(tag)) {
                if let Ok(e) = OcrEngine::TryCreateFromLanguage(&l) {
                    return Ok(e);
                }
            }
        }
        OcrEngine::TryCreateFromUserProfileLanguages().map_err(|_| NO_LANGUAGE.to_string())
    }

    /// The text in an area of the picture. `lang`: a language tag the user
    /// picked, else the user's own languages.
    pub fn recognize(rgb: &[u8], pic_w: u32, a: Area, lang: Option<&str>) -> Result<OcrResult, String> {
        let engine = engine(lang)?;
        let max = OcrEngine::MaxImageDimension().unwrap_or(2600);
        let s = ocr_scale(a.w, a.h, max);
        let (bgra, w, h) = bgra_of(rgb, pic_w, a, s);
        let buf = CryptographicBuffer::CreateFromByteArray(&bgra).map_err(|e| format!("OCR buffer: {e}"))?;
        let bmp = SoftwareBitmap::CreateCopyWithAlphaFromBuffer(&buf, BitmapPixelFormat::Bgra8, w as i32, h as i32, BitmapAlphaMode::Ignore)
            .map_err(|e| format!("OCR bitmap: {e}"))?;
        let res = engine.RecognizeAsync(&bmp).and_then(|op| op.get()).map_err(|e| format!("OCR: {e}"))?;
        let mut lines = Vec::new();
        for line in res.Lines().map_err(|e| e.to_string())? {
            let mut words = Vec::new();
            for word in line.Words().map_err(|e| e.to_string())? {
                let r = word.BoundingRect().map_err(|e| e.to_string())?;
                words.push(OcrWord {
                    text: word.Text().map(|t| t.to_string()).unwrap_or_default(),
                    x: a.x as f32 + r.X / s,
                    y: a.y as f32 + r.Y / s,
                    w: r.Width / s,
                    h: r.Height / s,
                });
            }
            lines.push(OcrLine { text: line.Text().map(|t| t.to_string()).unwrap_or_default(), words });
        }
        let language = engine.RecognizerLanguage().and_then(|l| l.LanguageTag()).map(|t| t.to_string()).unwrap_or_default();
        Ok(OcrResult { lines, language })
    }

    /// The OCR languages Windows has.
    pub fn languages() -> Vec<OcrLanguage> {
        let Ok(list) = OcrEngine::AvailableRecognizerLanguages() else { return Vec::new() };
        list.into_iter()
            .filter_map(|l| {
                Some(OcrLanguage { tag: l.LanguageTag().ok()?.to_string(), name: l.DisplayName().map(|n| n.to_string()).unwrap_or_default() })
            })
            .collect()
    }
}

#[cfg(any(not(windows), feature = "headless-sim"))]
mod imp {
    use super::*;
    pub fn recognize(_rgb: &[u8], _pic_w: u32, _a: Area, _lang: Option<&str>) -> Result<OcrResult, String> {
        Err("text recognition requires Windows".into())
    }
    pub fn languages() -> Vec<OcrLanguage> {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn areas_are_clamped_to_the_picture() {
        assert_eq!(Area::clamp(-10, 5, 50, 20, 100, 100), Some(Area { x: 0, y: 5, w: 40, h: 20 }));
        assert_eq!(Area::clamp(90, 90, 50, 50, 100, 100), Some(Area { x: 90, y: 90, w: 10, h: 10 }));
        assert_eq!(Area::clamp(100, 0, 5, 5, 100, 100), None);
        assert_eq!(Area::clamp(0, 0, 0, 5, 100, 100), None);
    }

    #[test]
    fn small_areas_are_read_at_twice_the_size() {
        assert_eq!(ocr_scale(400, 100, 10000), 2.0);
        assert_eq!(ocr_scale(1920, 1080, 10000), 1.0);
        assert_eq!(ocr_scale(5000, 1000, 2500), 0.5);
        assert_eq!(ocr_scale(1000, 100, 1500), 1.0);
    }

    #[test]
    fn the_scaled_copy_keeps_colours_and_swaps_to_bgr() {
        // 2×1 picture: red, blue.
        let rgb = [255, 0, 0, 0, 0, 255];
        let (out, w, h) = bgra_of(&rgb, 2, Area { x: 0, y: 0, w: 2, h: 1 }, 1.0);
        assert_eq!((w, h), (2, 1));
        assert_eq!(&out[..4], &[0, 0, 255, 255]);
        assert_eq!(&out[4..], &[255, 0, 0, 255]);
        let (big, w2, h2) = bgra_of(&rgb, 2, Area { x: 0, y: 0, w: 2, h: 1 }, 2.0);
        assert_eq!((w2, h2), (4, 2));
        assert_eq!(&big[..4], &[0, 0, 255, 255]);
    }

    #[test]
    fn grey_halves_big_areas() {
        let rgb = vec![200u8; 10 * 10 * 3];
        let (g, w, h) = grey_of(&rgb, 10, Area { x: 0, y: 0, w: 10, h: 10 }, 4);
        assert_eq!((w, h), (2, 2));
        assert!(g.iter().all(|&v| v == 200));
    }

    /// A version 1-L QR code of "https://x.io/ls" (mask 0).
    const QR: [&str; 21] = [
        "#######..#..#.#######",
        "#.....#..###..#.....#",
        "#.###.#.##.#..#.###.#",
        "#.###.#..#.#..#.###.#",
        "#.###.#...##..#.###.#",
        "#.....#.......#.....#",
        "#######.#.#.#.#######",
        "........##.#.........",
        "###.########.##...#..",
        "..##.#.##..##.###...#",
        "##.####.##.###..#.###",
        "#.#.##.##.#.#...#..#.",
        ".#..#.#.#..#.#.#.#...",
        "........##.######..##",
        "#######.###.#.#.#.###",
        "#.....#.##..##.##...#",
        "#.###.#.####.....#.#.",
        "#.###.#...###.#.##.#.",
        "#.###.#.#..##...#.#.#",
        "#.....#.#.......#..#.",
        "#######.###.....##.##",
    ];

    /// The code drawn at `at` in a bigger grey picture, 6 px a module.
    fn picture_with_qr(pic_w: u32, pic_h: u32, at: (u32, u32)) -> Vec<u8> {
        let mut rgb = vec![200u8; (pic_w * pic_h * 3) as usize];
        let m = 6;
        let quiet = 4 * m;
        let side = 21 * m + 2 * quiet;
        for y in 0..side {
            for x in 0..side {
                let (qx, qy) = (x as i32 - quiet as i32, y as i32 - quiet as i32);
                let dark = qx >= 0 && qy >= 0 && qx < 21 * m as i32 && qy < 21 * m as i32 && QR[(qy / m as i32) as usize].as_bytes()[(qx / m as i32) as usize] == b'#';
                let i = (((at.1 + y) * pic_w + at.0 + x) * 3) as usize;
                let v = if dark { 0 } else { 255 };
                rgb[i..i + 3].copy_from_slice(&[v, v, v]);
            }
        }
        rgb
    }

    #[test]
    fn reads_a_qr_code_in_the_area() {
        let rgb = picture_with_qr(400, 300, (120, 60));
        assert_eq!(decode_qr(&rgb, 400, Area { x: 100, y: 40, w: 250, h: 250 }), vec!["https://x.io/ls".to_string()]);
        // The whole picture works too; an area beside the code finds nothing.
        assert_eq!(decode_qr(&rgb, 400, Area { x: 0, y: 0, w: 400, h: 300 }).len(), 1);
        assert!(decode_qr(&rgb, 400, Area { x: 0, y: 0, w: 110, h: 300 }).is_empty());
    }

    /// Windows' OCR on text drawn in memory (GDI, never the screen). Skipped
    /// where Windows has no OCR language (Windows Sandbox).
    #[cfg(all(windows, not(feature = "headless-sim")))]
    #[test]
    fn reads_text_drawn_in_memory() {
        if languages().is_empty() {
            eprintln!("no OCR language installed: skipped");
            return;
        }
        let (w, h, bgra) = crate::media::layers::render_text("Lastshot reads 4821", 40, (255, 255, 255), true, false).expect("text");
        // Straight-alpha BGRA over a white page, as RGB with a 30 px margin.
        let (pw, ph) = (w + 60, h + 60);
        let mut rgb = vec![255u8; (pw * ph * 3) as usize];
        for y in 0..h {
            for x in 0..w {
                let s = ((y * w + x) * 4) as usize;
                let a = bgra[s + 3] as f32 / 255.0;
                let d = (((y + 30) * pw + x + 30) * 3) as usize;
                for c in 0..3 {
                    rgb[d + c] = (bgra[s + 2 - c] as f32 * a + 255.0 * (1.0 - a)).round() as u8;
                }
            }
        }
        let r = recognize(&rgb, pw, Area { x: 0, y: 0, w: pw, h: ph }, Some("en-US")).expect("ocr");
        let all = r.lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>().join(" ");
        assert!(all.to_lowercase().contains("lastshot") && all.contains("4821"), "{all}");
        // Word boxes are in picture pixels (the 2x reading scale undone).
        let first = &r.lines[0].words[0];
        assert!(first.x >= 30.0 && first.x < 30.0 + w as f32 / 3.0 && first.y >= 25.0 && first.y < 30.0 + h as f32, "{first:?}");
        // Only the part of the picture asked for is read.
        let half = recognize(&rgb, pw, Area { x: 0, y: 0, w: 30 + w / 2, h: ph }, Some("en-US")).expect("ocr");
        let part = half.lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>().join(" ");
        assert!(!part.contains("4821"), "{part}");
    }

    #[test]
    fn finds_no_qr_in_a_flat_picture() {
        let rgb = vec![255u8; 64 * 64 * 3];
        assert!(decode_qr(&rgb, 64, Area { x: 0, y: 0, w: 64, h: 64 }).is_empty());
    }
}
