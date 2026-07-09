fn main() {
    // In `tauri dev` the app runs as a plain unbundled executable, so the
    // bundled Info.plist (with NSCameraUsageDescription) is never applied and
    // macOS denies camera access outright. Embed the plist into the binary's
    // __TEXT,__info_plist section so TCC can read the usage string in dev too.
    // (`-bins` keeps this off the staticlib/cdylib link steps.)
    #[cfg(target_os = "macos")]
    {
        let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap();
        println!(
            "cargo:rustc-link-arg-bins=-Wl,-sectcreate,__TEXT,__info_plist,{manifest}/Info.plist"
        );
    }

    tauri_build::build()
}
