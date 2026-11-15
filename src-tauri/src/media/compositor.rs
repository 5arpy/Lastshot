//! GPU compositor: draws sources (screen, windows, webcam, pictures, text)
//! into one canvas texture with position, size, crop and opacity, the way
//! OBS builds a scene. The canvas then goes to the colour converter and the
//! encoder as before. Everything stays on the GPU; one draw call per source.

/// A rectangle in canvas pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

/// Part of a source to show, as fractions of its size (crop).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Crop {
    pub left: f32,
    pub top: f32,
    pub right: f32,
    pub bottom: f32,
}

impl Crop {
    pub const NONE: Crop = Crop { left: 0.0, top: 0.0, right: 0.0, bottom: 0.0 };
}

/// Biggest rectangle with the source's shape that fits the box, centred
/// (letterbox / pillarbox).
pub fn fit(src_w: f32, src_h: f32, b: Rect) -> Rect {
    if src_w <= 0.0 || src_h <= 0.0 || b.w <= 0.0 || b.h <= 0.0 {
        return Rect { w: 0.0, h: 0.0, ..b };
    }
    let s = (b.w / src_w).min(b.h / src_h);
    let (w, h) = (src_w * s, src_h * s);
    Rect { x: b.x + (b.w - w) / 2.0, y: b.y + (b.h - h) / 2.0, w, h }
}

/// Vertex-shader constants for one draw: destination in clip space
/// (x, y, w, h with h negative because clip space points up), source UV
/// rectangle, opacity, and whether to ignore the source's alpha.
pub fn draw_constants(canvas_w: f32, canvas_h: f32, dst: Rect, crop: Crop, opacity: f32, opaque: bool) -> [f32; 12] {
    let x = dst.x / canvas_w * 2.0 - 1.0;
    let y = 1.0 - dst.y / canvas_h * 2.0;
    let w = dst.w / canvas_w * 2.0;
    let h = -dst.h / canvas_h * 2.0;
    let u0 = crop.left.clamp(0.0, 1.0);
    let v0 = crop.top.clamp(0.0, 1.0);
    let uw = (1.0 - crop.right.clamp(0.0, 1.0) - u0).max(0.0);
    let vh = (1.0 - crop.bottom.clamp(0.0, 1.0) - v0).max(0.0);
    [x, y, w, h, u0, v0, uw, vh, opacity.clamp(0.0, 1.0), if opaque { 1.0 } else { 0.0 }, 0.0, 0.0]
}

#[cfg(windows)]
pub use imp::*;

#[cfg(windows)]
mod imp {
    use super::{draw_constants, Crop, Rect};
    use windows::core::PCSTR;
    use windows::Win32::Graphics::Direct3D::Fxc::{D3DCompile, D3DCOMPILE_OPTIMIZATION_LEVEL3};
    use windows::Win32::Graphics::Direct3D::{ID3DBlob, D3D11_PRIMITIVE_TOPOLOGY_TRIANGLESTRIP};
    use windows::Win32::Graphics::Direct3D11::*;
    use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT, DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};

    const HLSL: &str = r#"
cbuffer P : register(b0) { float4 dst; float4 uvr; float opacity; float opaque; float2 pad; };
struct V { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; };
V vs_main(uint id : SV_VertexID) {
    float2 t = float2(id & 1, id >> 1);
    V o;
    o.pos = float4(dst.xy + t * dst.zw, 0, 1);
    o.uv = uvr.xy + t * uvr.zw;
    return o;
}
Texture2D tex : register(t0);
SamplerState smp : register(s0);
float4 ps_main(V i) : SV_Target {
    float4 c = tex.Sample(smp, i.uv);
    if (opaque > 0.5) c.a = 1;
    c.a *= opacity;
    return c;
}
"#;

    fn e(err: windows::core::Error) -> String {
        format!("{} (0x{:08X})", err.message(), err.code().0 as u32)
    }

    fn compile(entry: &str, target: &str) -> Result<ID3DBlob, String> {
        let entry = std::ffi::CString::new(entry).unwrap();
        let target = std::ffi::CString::new(target).unwrap();
        let mut blob = None;
        let mut errors = None;
        let r = unsafe {
            D3DCompile(
                HLSL.as_ptr() as *const _,
                HLSL.len(),
                PCSTR::null(),
                None,
                None,
                PCSTR(entry.as_ptr() as *const u8),
                PCSTR(target.as_ptr() as *const u8),
                D3DCOMPILE_OPTIMIZATION_LEVEL3,
                0,
                &mut blob,
                Some(&mut errors),
            )
        };
        if let Err(err) = r {
            let msg = errors
                .map(|b: ID3DBlob| unsafe {
                    String::from_utf8_lossy(std::slice::from_raw_parts(b.GetBufferPointer() as *const u8, b.GetBufferSize())).to_string()
                })
                .unwrap_or_default();
            return Err(format!("shader {}: {} {msg}", entry.to_string_lossy(), e(err)));
        }
        blob.ok_or_else(|| "shader: no output".into())
    }

    fn bytes(b: &ID3DBlob) -> &[u8] {
        unsafe { std::slice::from_raw_parts(b.GetBufferPointer() as *const u8, b.GetBufferSize()) }
    }

    /// A source picture kept on the GPU (a copy of the latest frame), so
    /// the capture can release its own buffer at once.
    pub struct SourceTexture {
        pub tex: ID3D11Texture2D,
        srv: ID3D11ShaderResourceView,
        pub width: u32,
        pub height: u32,
        format: DXGI_FORMAT,
    }

    impl SourceTexture {
        /// Creates an empty texture to upload pixels into (pictures, text).
        pub fn new(device: &ID3D11Device, width: u32, height: u32, format: DXGI_FORMAT) -> Result<Self, String> {
            unsafe {
                let desc = D3D11_TEXTURE2D_DESC {
                    Width: width.max(1),
                    Height: height.max(1),
                    MipLevels: 1,
                    ArraySize: 1,
                    Format: format,
                    SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                    Usage: D3D11_USAGE_DEFAULT,
                    BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
                    CPUAccessFlags: 0,
                    MiscFlags: 0,
                };
                let mut tex = None;
                device.CreateTexture2D(&desc, None, Some(&mut tex)).map_err(e)?;
                let tex = tex.ok_or("texture: none")?;
                let mut srv = None;
                device.CreateShaderResourceView(&tex, None, Some(&mut srv)).map_err(e)?;
                Ok(Self { tex, srv: srv.ok_or("view: none")?, width: width.max(1), height: height.max(1), format })
            }
        }

        /// Copies a captured frame in, re-creating the texture when the
        /// frame's size or format changed (a resized window).
        pub fn update(slot: &mut Option<SourceTexture>, device: &ID3D11Device, context: &ID3D11DeviceContext, src: &ID3D11Texture2D) -> Result<(), String> {
            let mut d = D3D11_TEXTURE2D_DESC::default();
            unsafe { src.GetDesc(&mut d) };
            let fits = slot
                .as_ref()
                .map(|s| s.width == d.Width && s.height == d.Height && s.format == d.Format)
                .unwrap_or(false);
            if !fits {
                *slot = Some(SourceTexture::new(device, d.Width, d.Height, d.Format)?);
            }
            if let Some(s) = slot.as_ref() {
                unsafe { context.CopyResource(&s.tex, src) };
            }
            Ok(())
        }

        /// Uploads tightly packed BGRA pixels (pictures, text).
        pub fn upload_bgra(&self, context: &ID3D11DeviceContext, pixels: &[u8]) {
            if pixels.len() < (self.width * self.height * 4) as usize {
                return;
            }
            unsafe {
                context.UpdateSubresource(&self.tex, 0, None, pixels.as_ptr() as *const _, self.width * 4, 0);
            }
        }
    }

    /// The scene canvas and the few GPU objects needed to draw into it.
    pub struct Compositor {
        device: ID3D11Device,
        context: ID3D11DeviceContext,
        canvas: ID3D11Texture2D,
        rtv: ID3D11RenderTargetView,
        vs: ID3D11VertexShader,
        ps: ID3D11PixelShader,
        cb: ID3D11Buffer,
        sampler: ID3D11SamplerState,
        blend: ID3D11BlendState,
        raster: ID3D11RasterizerState,
        pub width: u32,
        pub height: u32,
    }

    unsafe impl Send for Compositor {}

    impl Compositor {
        pub fn new(device: &ID3D11Device, context: &ID3D11DeviceContext, width: u32, height: u32) -> Result<Self, String> {
            unsafe {
                let desc = D3D11_TEXTURE2D_DESC {
                    Width: width,
                    Height: height,
                    MipLevels: 1,
                    ArraySize: 1,
                    Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                    SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                    Usage: D3D11_USAGE_DEFAULT,
                    BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
                    CPUAccessFlags: 0,
                    MiscFlags: 0,
                };
                let mut canvas = None;
                device.CreateTexture2D(&desc, None, Some(&mut canvas)).map_err(e)?;
                let canvas = canvas.ok_or("canvas: none")?;
                let mut rtv = None;
                device.CreateRenderTargetView(&canvas, None, Some(&mut rtv)).map_err(e)?;

                let vsb = compile("vs_main", "vs_4_0")?;
                let psb = compile("ps_main", "ps_4_0")?;
                let mut vs = None;
                device.CreateVertexShader(bytes(&vsb), None, Some(&mut vs)).map_err(e)?;
                let mut ps = None;
                device.CreatePixelShader(bytes(&psb), None, Some(&mut ps)).map_err(e)?;

                let cbd = D3D11_BUFFER_DESC {
                    ByteWidth: 48,
                    Usage: D3D11_USAGE_DEFAULT,
                    BindFlags: D3D11_BIND_CONSTANT_BUFFER.0 as u32,
                    ..Default::default()
                };
                let mut cb = None;
                device.CreateBuffer(&cbd, None, Some(&mut cb)).map_err(e)?;

                let sd = D3D11_SAMPLER_DESC {
                    Filter: D3D11_FILTER_MIN_MAG_MIP_LINEAR,
                    AddressU: D3D11_TEXTURE_ADDRESS_CLAMP,
                    AddressV: D3D11_TEXTURE_ADDRESS_CLAMP,
                    AddressW: D3D11_TEXTURE_ADDRESS_CLAMP,
                    MaxLOD: f32::MAX,
                    ..Default::default()
                };
                let mut sampler = None;
                device.CreateSamplerState(&sd, Some(&mut sampler)).map_err(e)?;

                let mut bd = D3D11_BLEND_DESC::default();
                bd.RenderTarget[0] = D3D11_RENDER_TARGET_BLEND_DESC {
                    BlendEnable: true.into(),
                    SrcBlend: D3D11_BLEND_SRC_ALPHA,
                    DestBlend: D3D11_BLEND_INV_SRC_ALPHA,
                    BlendOp: D3D11_BLEND_OP_ADD,
                    SrcBlendAlpha: D3D11_BLEND_ONE,
                    DestBlendAlpha: D3D11_BLEND_INV_SRC_ALPHA,
                    BlendOpAlpha: D3D11_BLEND_OP_ADD,
                    RenderTargetWriteMask: D3D11_COLOR_WRITE_ENABLE_ALL.0 as u8,
                };
                let mut blend = None;
                device.CreateBlendState(&bd, Some(&mut blend)).map_err(e)?;

                let rd = D3D11_RASTERIZER_DESC {
                    FillMode: D3D11_FILL_SOLID,
                    CullMode: D3D11_CULL_NONE,
                    DepthClipEnable: true.into(),
                    ..Default::default()
                };
                let mut raster = None;
                device.CreateRasterizerState(&rd, Some(&mut raster)).map_err(e)?;

                Ok(Self {
                    device: device.clone(),
                    context: context.clone(),
                    canvas,
                    rtv: rtv.ok_or("rtv: none")?,
                    vs: vs.ok_or("vs: none")?,
                    ps: ps.ok_or("ps: none")?,
                    cb: cb.ok_or("cb: none")?,
                    sampler: sampler.ok_or("sampler: none")?,
                    blend: blend.ok_or("blend: none")?,
                    raster: raster.ok_or("raster: none")?,
                    width,
                    height,
                })
            }
        }

        pub fn device(&self) -> &ID3D11Device {
            &self.device
        }

        pub fn context(&self) -> &ID3D11DeviceContext {
            &self.context
        }

        /// The finished picture (BGRA, canvas size).
        pub fn canvas(&self) -> &ID3D11Texture2D {
            &self.canvas
        }

        /// Clears the canvas and sets up the pipeline for this frame.
        pub fn begin(&self, rgba: [f32; 4]) {
            unsafe {
                let c = &self.context;
                c.ClearRenderTargetView(&self.rtv, &rgba);
                c.OMSetRenderTargets(Some(&[Some(self.rtv.clone())]), None);
                c.OMSetBlendState(&self.blend, None, 0xffff_ffff);
                c.RSSetState(&self.raster);
                c.RSSetViewports(Some(&[D3D11_VIEWPORT {
                    TopLeftX: 0.0,
                    TopLeftY: 0.0,
                    Width: self.width as f32,
                    Height: self.height as f32,
                    MinDepth: 0.0,
                    MaxDepth: 1.0,
                }]));
                c.IASetInputLayout(None);
                c.IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLESTRIP);
                c.VSSetShader(&self.vs, None);
                c.VSSetConstantBuffers(0, Some(&[Some(self.cb.clone())]));
                c.PSSetShader(&self.ps, None);
                c.PSSetConstantBuffers(0, Some(&[Some(self.cb.clone())]));
                c.PSSetSamplers(0, Some(&[Some(self.sampler.clone())]));
            }
        }

        /// Draws one source into the canvas.
        pub fn draw(&self, src: &SourceTexture, dst: Rect, crop: Crop, opacity: f32, opaque: bool) {
            if dst.w <= 0.0 || dst.h <= 0.0 || opacity <= 0.0 {
                return;
            }
            let k = draw_constants(self.width as f32, self.height as f32, dst, crop, opacity, opaque);
            unsafe {
                let c = &self.context;
                c.UpdateSubresource(&self.cb, 0, None, k.as_ptr() as *const _, 0, 0);
                c.PSSetShaderResources(0, Some(&[Some(src.srv.clone())]));
                c.Draw(4, 0);
            }
        }

        /// Unbinds the canvas so the video processor can read it.
        pub fn end(&self) {
            unsafe {
                self.context.OMSetRenderTargets(None, None);
                self.context.PSSetShaderResources(0, Some(&[None]));
            }
        }
    }

}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fit_letterboxes_and_pillarboxes() {
        let b = Rect { x: 0.0, y: 0.0, w: 1920.0, h: 1080.0 };
        assert_eq!(fit(1280.0, 720.0, b), b);
        // A tall phone window is centred with bars left and right.
        let r = fit(1080.0, 1920.0, b);
        assert!((r.h - 1080.0).abs() < 0.01 && (r.w - 607.5).abs() < 0.01);
        assert!((r.x - 656.25).abs() < 0.01 && r.y == 0.0);
        assert_eq!(fit(0.0, 10.0, b).w, 0.0);
    }

    #[test]
    fn constants_map_pixels_to_clip_space() {
        let k = draw_constants(100.0, 50.0, Rect { x: 0.0, y: 0.0, w: 100.0, h: 50.0 }, Crop::NONE, 1.0, true);
        assert_eq!(&k[..4], &[-1.0, 1.0, 2.0, -2.0]);
        assert_eq!(&k[4..8], &[0.0, 0.0, 1.0, 1.0]);
        assert_eq!(k[9], 1.0);
        let k = draw_constants(100.0, 100.0, Rect { x: 50.0, y: 50.0, w: 50.0, h: 50.0 }, Crop { left: 0.25, top: 0.0, right: 0.25, bottom: 0.5 }, 2.0, false);
        assert_eq!(&k[..4], &[0.0, 0.0, 1.0, -1.0]);
        assert_eq!(&k[4..8], &[0.25, 0.0, 0.5, 0.5]);
        assert_eq!(k[8], 1.0);
        assert_eq!(k[9], 0.0);
    }
}
