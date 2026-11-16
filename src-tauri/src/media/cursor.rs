//! The mouse pointer in full-screen captures. Desktop Duplication leaves it
//! out of the picture and reports its shape and position separately, so the
//! engine draws it onto each frame (on the GPU, on the copy the encoder
//! reads anyway: no extra full-frame copy).

/// DXGI_OUTDUPL_POINTER_SHAPE_TYPE values.
pub const SHAPE_MONOCHROME: u32 = 1;
pub const SHAPE_COLOR: u32 = 2;
pub const SHAPE_MASKED_COLOR: u32 = 4;

/// Converts a pointer shape from Desktop Duplication into straight-alpha
/// BGRA. Returns (width, height, pixels).
///
/// Pixels that invert the screen (the text I-beam, for example) cannot be
/// drawn as an inversion with a plain blend, so they become white with a
/// one-pixel black outline: visible on any background.
pub fn shape_to_bgra(kind: u32, width: u32, height: u32, pitch: u32, data: &[u8]) -> Option<(u32, u32, Vec<u8>)> {
    let (w, pitch) = (width as usize, pitch as usize);
    // Pixel kinds: 0 transparent, 1 colour (already set), 2 invert.
    let (h, mut px, mut kinds) = match kind {
        SHAPE_MONOCHROME => {
            // AND mask on top, XOR mask below: twice the real height.
            let h = height as usize / 2;
            if w == 0 || h == 0 || data.len() < pitch * h * 2 {
                return None;
            }
            let bit = |row: usize, x: usize| data[row * pitch + x / 8] & (0x80 >> (x % 8)) != 0;
            let mut px = vec![0u8; w * h * 4];
            let mut kinds = vec![0u8; w * h];
            for y in 0..h {
                for x in 0..w {
                    let i = y * w + x;
                    match (bit(y, x), bit(y + h, x)) {
                        (true, false) => {}
                        (false, xor) => {
                            let v = if xor { 255 } else { 0 };
                            px[i * 4..i * 4 + 4].copy_from_slice(&[v, v, v, 255]);
                            kinds[i] = 1;
                        }
                        (true, true) => kinds[i] = 2,
                    }
                }
            }
            (h, px, kinds)
        }
        SHAPE_COLOR | SHAPE_MASKED_COLOR => {
            let h = height as usize;
            if w == 0 || h == 0 || data.len() < pitch * (h - 1) + w * 4 {
                return None;
            }
            let mut px = vec![0u8; w * h * 4];
            let mut kinds = vec![0u8; w * h];
            for y in 0..h {
                for x in 0..w {
                    let s = &data[y * pitch + x * 4..y * pitch + x * 4 + 4];
                    let i = y * w + x;
                    if kind == SHAPE_COLOR {
                        px[i * 4..i * 4 + 4].copy_from_slice(s);
                        kinds[i] = if s[3] > 0 { 1 } else { 0 };
                    } else if s[3] == 0 {
                        // Mask 0: replace the screen with this colour.
                        px[i * 4..i * 4 + 4].copy_from_slice(&[s[0], s[1], s[2], 255]);
                        kinds[i] = 1;
                    } else if s[0] | s[1] | s[2] != 0 {
                        // Mask 1 with a colour: XOR with the screen.
                        kinds[i] = 2;
                    }
                }
            }
            (h, px, kinds)
        }
        _ => return None,
    };
    // Inverting pixels: white, then a black outline around them.
    for i in 0..w * h {
        if kinds[i] == 2 {
            px[i * 4..i * 4 + 4].copy_from_slice(&[255, 255, 255, 255]);
        }
    }
    let snapshot = kinds.clone();
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            if snapshot[i] != 0 {
                continue;
            }
            let near = (y.saturating_sub(1)..=(y + 1).min(h - 1))
                .any(|yy| (x.saturating_sub(1)..=(x + 1).min(w - 1)).any(|xx| snapshot[yy * w + xx] == 2));
            if near {
                px[i * 4..i * 4 + 4].copy_from_slice(&[0, 0, 0, 255]);
                kinds[i] = 1;
            }
        }
    }
    Some((w as u32, h as u32, px))
}

#[cfg(windows)]
pub use imp::*;

#[cfg(windows)]
mod imp {
    use super::shape_to_bgra;
    use crate::media::compositor::{Compositor, Crop, Rect, SourceTexture};
    use windows::core::Interface;
    use windows::Win32::Graphics::Direct3D11::{ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D};
    use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM;
    use windows::Win32::Graphics::Dxgi::{IDXGIOutputDuplication, DXGI_OUTDUPL_FRAME_INFO, DXGI_OUTDUPL_POINTER_SHAPE_INFO};

    /// Pointer state for one duplicated monitor.
    #[derive(Default)]
    pub struct CursorOverlay {
        shape: Option<SourceTexture>,
        buf: Vec<u8>,
        x: i32,
        y: i32,
        visible: bool,
        /// Drawing onto the converter's input copy; re-made if it changes.
        comp: Option<(Compositor, usize)>,
    }

    impl CursorOverlay {
        /// Reads the new position and shape that came with a frame.
        pub fn update(&mut self, dup: &IDXGIOutputDuplication, device: &ID3D11Device, context: &ID3D11DeviceContext, info: &DXGI_OUTDUPL_FRAME_INFO) {
            if info.LastMouseUpdateTime != 0 {
                // Not visible = the pointer is on another monitor or hidden.
                self.visible = info.PointerPosition.Visible.as_bool();
                self.x = info.PointerPosition.Position.x;
                self.y = info.PointerPosition.Position.y;
            }
            let size = info.PointerShapeBufferSize;
            if size == 0 {
                return;
            }
            self.buf.resize(size as usize, 0);
            let mut needed = 0u32;
            let mut si = DXGI_OUTDUPL_POINTER_SHAPE_INFO::default();
            let ok = unsafe { dup.GetFramePointerShape(size, self.buf.as_mut_ptr() as *mut _, &mut needed, &mut si) };
            if ok.is_err() {
                return;
            }
            if let Some((w, h, px)) = shape_to_bgra(si.Type, si.Width, si.Height, si.Pitch, &self.buf) {
                let fits = self.shape.as_ref().map(|s| s.width == w && s.height == h).unwrap_or(false);
                if !fits {
                    self.shape = SourceTexture::new(device, w, h, DXGI_FORMAT_B8G8R8A8_UNORM).ok();
                }
                if let Some(s) = self.shape.as_ref() {
                    s.upload_bgra(context, &px);
                }
            }
        }

        /// Draws the pointer onto `target` (the frame about to be encoded).
        pub fn draw_on(&mut self, device: &ID3D11Device, context: &ID3D11DeviceContext, target: &ID3D11Texture2D) {
            self.draw_mapped(device, context, target, (0.0, 0.0), (0.0, 0.0), 1.0);
        }

        /// Draws the pointer onto a crop of the monitor: monitor position
        /// `p` lands at `(p - from) * scale + to` on `target`.
        pub fn draw_mapped(&mut self, device: &ID3D11Device, context: &ID3D11DeviceContext, target: &ID3D11Texture2D, from: (f32, f32), to: (f32, f32), scale: f32) {
            if !self.visible {
                return;
            }
            let Some(shape) = self.shape.as_ref() else { return };
            let key = target.as_raw() as usize;
            if self.comp.as_ref().map(|c| c.1) != Some(key) {
                self.comp = Compositor::on_target(device, context, target.clone()).ok().map(|c| (c, key));
            }
            let Some((comp, _)) = self.comp.as_ref() else { return };
            comp.begin_keep();
            let r = Rect {
                x: (self.x as f32 - from.0) * scale + to.0,
                y: (self.y as f32 - from.1) * scale + to.1,
                w: shape.width as f32 * scale,
                h: shape.height as f32 * scale,
            };
            comp.draw(shape, r, Crop::NONE, 1.0, false);
            comp.end();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn monochrome_arrow_and_ibeam() {
        // 8x2 shape: row 0 = black, white, transparent, invert...; pitch 1.
        // AND rows (2), then XOR rows (2).
        let data = [0b0011_0000, 0b1111_1111, 0b0101_0000, 0b0000_0000];
        let (w, h, px) = shape_to_bgra(SHAPE_MONOCHROME, 8, 4, 1, &data).unwrap();
        assert_eq!((w, h), (8, 2));
        let at = |x: usize, y: usize| &px[(y * 8 + x) * 4..(y * 8 + x) * 4 + 4];
        assert_eq!(at(0, 0), &[0, 0, 0, 255]); // AND 0, XOR 0: black
        assert_eq!(at(1, 0), &[255, 255, 255, 255]); // AND 0, XOR 1: white
        assert_eq!(at(3, 0), &[255, 255, 255, 255]); // AND 1, XOR 1: invert -> white
        assert_eq!(at(4, 0), &[0, 0, 0, 255]); // next to the invert pixel: outline
        assert_eq!(at(7, 1)[3], 0); // AND 1, XOR 0, far away: transparent
    }

    #[test]
    fn masked_colour() {
        // 2x1: opaque red (mask 0), XOR black (mask 1, no colour -> transparent).
        let data = [0, 0, 255, 0, 0, 0, 0, 255];
        let (_, _, px) = shape_to_bgra(SHAPE_MASKED_COLOR, 2, 1, 8, &data).unwrap();
        assert_eq!(&px[0..4], &[0, 0, 255, 255]);
        assert_eq!(px[7], 0);
    }

    #[test]
    fn rejects_short_buffers() {
        assert!(shape_to_bgra(SHAPE_COLOR, 32, 32, 128, &[0; 16]).is_none());
        assert!(shape_to_bgra(9, 1, 1, 4, &[0; 4]).is_none());
    }
}
