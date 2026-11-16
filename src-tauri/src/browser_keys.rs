//! Lastshot windows are an app, not a browser: no reload (Ctrl+R, F5), find
//! (Ctrl+F, F3), print (Ctrl+P), view source, page zoom (Ctrl+wheel,
//! Ctrl+plus/minus/0, pinch), back/forward (Alt+arrows, mouse buttons,
//! swipes), downloads/history or devtools (F12, Ctrl+Shift+I) in release
//! builds. WebView2 turns these off itself through its settings; the page
//! has a key guard as well (src/lib/browserKeys.ts) and its own app zoom.
//!
//! Editing keys (copy, paste, undo in text fields) stay: WebView2 keeps them
//! with browser keys off. The page decides about right-click menus (text
//! fields keep theirs).

pub fn lock_down<R: tauri::Runtime>(webview: &tauri::Webview<R>) {
    #[cfg(windows)]
    let _ = webview.with_webview(|wv| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2Settings3, ICoreWebView2Settings5, ICoreWebView2Settings6};
        use windows_core_061::Interface;
        let Ok(core) = wv.controller().CoreWebView2() else { return };
        let Ok(settings) = core.Settings() else { return };
        let _ = settings.SetIsZoomControlEnabled(false);
        let _ = settings.SetIsStatusBarEnabled(false);
        if let Ok(s5) = settings.cast::<ICoreWebView2Settings5>() {
            let _ = s5.SetIsPinchZoomEnabled(false);
        }
        if let Ok(s6) = settings.cast::<ICoreWebView2Settings6>() {
            let _ = s6.SetIsSwipeNavigationEnabled(false);
        }
        // Debug builds keep F12 and friends for development.
        if !cfg!(debug_assertions) {
            if let Ok(s3) = settings.cast::<ICoreWebView2Settings3>() {
                let _ = s3.SetAreBrowserAcceleratorKeysEnabled(false);
            }
        }
    });
    #[cfg(not(windows))]
    let _ = webview;
}
