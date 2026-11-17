fn main() {
    // Emit the Windows manifest (DPI awareness + per-monitor v2) and generate
    // the Tauri codegen context.
    tauri_build::build();

    // `tauri build` sets STATIC_VCRUNTIME=true so the exe carries its own C
    // runtime, but tauri-build doesn't tell cargo to watch it: a build script
    // cached by a plain `cargo build`/`cargo test` in the shared target dir
    // then links vcruntime140.dll, and the exe fails to start (0xC0000135) on
    // PCs without the VC++ redistributable.
    println!("cargo:rerun-if-env-changed=STATIC_VCRUNTIME");

    // Media Foundation + DXGI are delay-loaded on purpose: ClipFlow must still
    // launch on Windows N/KN editions that ship without the media pack, so we
    // can surface a friendly error instead of a hard loader failure.
    #[cfg(windows)]
    {
        println!("cargo:rustc-link-arg=/DELAYLOAD:mf.dll");
        println!("cargo:rustc-link-arg=/DELAYLOAD:mfplat.dll");
        println!("cargo:rustc-link-arg=/DELAYLOAD:mfreadwrite.dll");
        println!("cargo:rustc-link-arg=/DELAYLOAD:mfuuid.dll");
        println!("cargo:rustc-link-lib=dylib=delayimp");
    }
}
