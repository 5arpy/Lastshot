//! Window and app capture with Windows.Graphics.Capture (Windows 10 1903+).
//!
//! Unlike desktop duplication, this captures one window even when it is
//! covered, moved to another monitor or partly off screen, and nothing else
//! on the desktop ends up in the video. Frames arrive as D3D11 textures on
//! the engine's own device, so they go straight into the compositor.

use serde::Serialize;

/// A window the user can pick as a source.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    /// HWND as a number (stable while the window lives).
    pub hwnd: i64,
    pub title: String,
    /// Executable file name, e.g. "RobloxPlayerBeta.exe".
    pub exe: String,
    pub pid: u32,
    pub width: u32,
    pub height: u32,
}

#[cfg(windows)]
pub use imp::*;

#[cfg(windows)]
mod imp {
    use super::WindowInfo;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use windows::core::{factory, Interface};
    use windows::Foundation::TypedEventHandler;
    use windows::Graphics::Capture::{
        Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession,
    };
    use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
    use windows::Graphics::DirectX::DirectXPixelFormat;
    use windows::Graphics::SizeInt32;
    use windows::Win32::Foundation::{BOOL, CloseHandle, HWND, LPARAM, RECT};
    use windows::Win32::Graphics::Gdi::HMONITOR;
    use windows::Win32::Graphics::Direct3D11::{ID3D11Device, ID3D11Texture2D};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
    use windows::Win32::Graphics::Dxgi::IDXGIDevice;
    use windows::Win32::System::Threading::{
        GetCurrentProcessId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::System::WinRT::Direct3D11::{
        CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess,
    };
    use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetAncestor, GetWindow, GetWindowLongPtrW, GetWindowThreadProcessId,
        InternalGetWindowText, IsIconic, IsWindow, IsWindowVisible, GA_ROOT, GWL_EXSTYLE, GW_OWNER,
        WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    };

    fn e(err: windows::core::Error) -> String {
        format!("{} (0x{:08X})", err.message(), err.code().0 as u32)
    }

    /// True when Windows.Graphics.Capture is available on this PC.
    pub fn supported() -> bool {
        GraphicsCaptureSession::IsSupported().unwrap_or(false)
    }

    /// Top-level windows worth recording, in Z order (front first).
    pub fn list_windows() -> Vec<WindowInfo> {
        unsafe extern "system" fn cb(hwnd: HWND, lp: LPARAM) -> BOOL {
            let out = &mut *(lp.0 as *mut Vec<HWND>);
            out.push(hwnd);
            BOOL(1)
        }
        let mut all: Vec<HWND> = Vec::new();
        unsafe {
            let _ = EnumWindows(Some(cb), LPARAM(&mut all as *mut _ as isize));
        }
        let me = unsafe { GetCurrentProcessId() };
        all.into_iter()
            .filter(|&h| {
                let mut pid = 0u32;
                unsafe { GetWindowThreadProcessId(h, Some(&mut pid)) };
                pid != me
            })
            .filter_map(info)
            .collect()
    }

    /// Details of one window, or None when it should not be offered.
    pub fn info(hwnd: HWND) -> Option<WindowInfo> {
        unsafe {
            if !IsWindow(hwnd).as_bool() || !IsWindowVisible(hwnd).as_bool() {
                return None;
            }
            if GetAncestor(hwnd, GA_ROOT) != hwnd {
                return None;
            }
            if GetWindow(hwnd, GW_OWNER).map(|o| !o.is_invalid()).unwrap_or(false) {
                return None;
            }
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
            if ex & WS_EX_TOOLWINDOW.0 != 0 || ex & WS_EX_NOACTIVATE.0 != 0 {
                return None;
            }
            let mut cloaked = 0u32;
            let _ = DwmGetWindowAttribute(
                hwnd,
                DWMWA_CLOAKED,
                &mut cloaked as *mut _ as *mut _,
                std::mem::size_of::<u32>() as u32,
            );
            if cloaked != 0 {
                return None;
            }
            // The title as Windows keeps it. GetWindowText would send the
            // window a message when it is one of ours, which waits for its
            // thread: the capture thread looks for windows while the UI
            // thread may be waiting for it (quit), and that never ends.
            let mut buf = [0u16; 512];
            let n = InternalGetWindowText(hwnd, &mut buf);
            if n <= 0 {
                return None;
            }
            let title = String::from_utf16_lossy(&buf[..n.max(0) as usize]);
            if title.trim().is_empty() || title == "Program Manager" {
                return None;
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            let mut r = RECT::default();
            let _ = DwmGetWindowAttribute(
                hwnd,
                DWMWA_EXTENDED_FRAME_BOUNDS,
                &mut r as *mut _ as *mut _,
                std::mem::size_of::<RECT>() as u32,
            );
            let (w, h) = ((r.right - r.left).max(0) as u32, (r.bottom - r.top).max(0) as u32);
            // Minimised windows report a tiny rect but can still be picked.
            if (w < 40 || h < 40) && !IsIconic(hwnd).as_bool() {
                return None;
            }
            Some(WindowInfo {
                hwnd: hwnd.0 as i64,
                title,
                exe: exe_name(pid).unwrap_or_default(),
                pid,
                width: w,
                height: h,
            })
        }
    }

    /// The executable's file name for a process id.
    pub fn exe_name(pid: u32) -> Option<String> {
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let mut buf = vec![0u16; 1024];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(
                h,
                PROCESS_NAME_WIN32,
                windows::core::PWSTR(buf.as_mut_ptr()),
                &mut len,
            )
            .is_ok();
            let _ = CloseHandle(h);
            if !ok {
                return None;
            }
            let full = String::from_utf16_lossy(&buf[..len as usize]);
            Some(full.rsplit('\\').next().unwrap_or(&full).to_string())
        }
    }

    /// Finds the main window of an app by executable name (for "record this
    /// app" sources that should survive the window being re-created).
    pub fn find_app_window(exe: &str) -> Option<WindowInfo> {
        let want = exe.to_ascii_lowercase();
        list_windows()
            .into_iter()
            .filter(|w| w.exe.to_ascii_lowercase() == want)
            .max_by_key(|w| w.width as u64 * w.height as u64)
    }

    /// A running capture of one window.
    pub struct WindowCapture {
        pub hwnd: HWND,
        _item: GraphicsCaptureItem,
        pool: Direct3D11CaptureFramePool,
        session: GraphicsCaptureSession,
        device: IDirect3DDevice,
        size: SizeInt32,
        closed: Arc<AtomicBool>,
    }

    // The pool is free-threaded and only used from the capture thread.
    unsafe impl Send for WindowCapture {}

    impl WindowCapture {
        pub fn new(d3d: &ID3D11Device, hwnd: HWND, cursor: bool) -> Result<Self, String> {
            let interop = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>().map_err(e)?;
            let item: GraphicsCaptureItem = unsafe { interop.CreateForWindow(hwnd) }.map_err(e)?;
            Self::start(d3d, item, hwnd, cursor)
        }

        /// A whole monitor through Graphics Capture: the fallback when desktop
        /// duplication is unavailable (hybrid-GPU laptops, some remote
        /// sessions) or delivers only black frames.
        pub fn for_monitor(d3d: &ID3D11Device, monitor: HMONITOR, cursor: bool) -> Result<Self, String> {
            let interop = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>().map_err(e)?;
            let item: GraphicsCaptureItem = unsafe { interop.CreateForMonitor(monitor) }.map_err(e)?;
            Self::start(d3d, item, HWND::default(), cursor)
        }

        fn start(d3d: &ID3D11Device, item: GraphicsCaptureItem, hwnd: HWND, cursor: bool) -> Result<Self, String> {
            unsafe {
                let dxgi: IDXGIDevice = d3d.cast().map_err(e)?;
                let inspectable = CreateDirect3D11DeviceFromDXGIDevice(&dxgi).map_err(e)?;
                let device: IDirect3DDevice = inspectable.cast().map_err(e)?;
                let size = item.Size().map_err(e)?;
                let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
                    &device,
                    DirectXPixelFormat::B8G8R8A8UIntNormalized,
                    2,
                    size,
                )
                .map_err(e)?;
                let session = pool.CreateCaptureSession(&item).map_err(e)?;
                let _ = session.SetIsCursorCaptureEnabled(cursor);
                // Windows 11: no yellow border around the captured window.
                let _ = session.SetIsBorderRequired(false);
                let closed = Arc::new(AtomicBool::new(false));
                let flag = Arc::clone(&closed);
                let _ = item.Closed(&TypedEventHandler::new(move |_, _| {
                    flag.store(true, Ordering::Release);
                    Ok(())
                }));
                session.StartCapture().map_err(e)?;
                Ok(Self { hwnd, _item: item, pool, session, device, size, closed })
            }
        }

        /// The window was closed (the source should look for it again).
        pub fn is_closed(&self) -> bool {
            self.closed.load(Ordering::Acquire)
                || (!self.hwnd.is_invalid() && unsafe { !IsWindow(self.hwnd).as_bool() })
        }

        /// Calls `f` with the newest frame, if a new one arrived. The texture
        /// is only valid inside `f` (copy it there).
        pub fn with_latest<R>(&mut self, f: impl FnOnce(&ID3D11Texture2D) -> R) -> Option<R> {
            // Skip to the newest frame; older ones are just released.
            let mut newest = None;
            while let Ok(frame) = self.pool.TryGetNextFrame() {
                if let Some(old) = newest.replace(frame) {
                    let _ = old.Close();
                }
            }
            let frame = newest?;
            let size = frame.ContentSize().ok();
            let out = (|| {
                let surface = frame.Surface().ok()?;
                let access: IDirect3DDxgiInterfaceAccess = surface.cast().ok()?;
                let tex: ID3D11Texture2D = unsafe { access.GetInterface().ok()? };
                Some(f(&tex))
            })();
            let _ = frame.Close();
            // The window was resized: re-create the pool at the new size so
            // the next frames are not cut off.
            if let Some(s) = size {
                if s.Width > 0 && s.Height > 0 && (s.Width != self.size.Width || s.Height != self.size.Height) {
                    self.size = s;
                    let _ = self.pool.Recreate(
                        &self.device,
                        DirectXPixelFormat::B8G8R8A8UIntNormalized,
                        2,
                        s,
                    );
                }
            }
            out
        }
    }

    impl Drop for WindowCapture {
        fn drop(&mut self) {
            let _ = self.session.Close();
            let _ = self.pool.Close();
        }
    }
}

#[cfg(not(windows))]
pub fn list_windows() -> Vec<WindowInfo> {
    Vec::new()
}

#[cfg(not(windows))]
pub fn supported() -> bool {
    false
}
