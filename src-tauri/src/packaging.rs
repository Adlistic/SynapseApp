//! Microsoft Store (MSIX) awareness. One binary serves both install routes:
//! the direct NSIS installer and the Store package. When packaged, updates come
//! from the Store: the package folder is read-only and the NSIS updater would
//! install a second, unpackaged copy, so `updater.rs` stands down.
//!
//! Detection is `GetCurrentPackageFullName` (kernel32): it returns
//! APPMODEL_ERROR_NO_PACKAGE (15700) for any process that isn't packaged.

use std::sync::OnceLock;

static PACKAGED: OnceLock<bool> = OnceLock::new();

/// True when running from the Microsoft Store (MSIX) package.
pub fn is_packaged() -> bool {
    *PACKAGED.get_or_init(detect_packaged)
}

#[cfg(windows)]
fn detect_packaged() -> bool {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentPackageFullName(package_full_name_length: *mut u32, package_full_name: *mut u16) -> i32;
    }
    // Packaged = the length query succeeds (0) or asks for a buffer (122,
    // ERROR_INSUFFICIENT_BUFFER). Anything else, including
    // APPMODEL_ERROR_NO_PACKAGE (15700), counts as a direct install so an
    // odd return code can never switch off self-updates.
    const ERROR_SUCCESS: i32 = 0;
    const ERROR_INSUFFICIENT_BUFFER: i32 = 122;
    let mut len: u32 = 0;
    // SAFETY: a null buffer with len 0 is the documented way to query; the call
    // only writes the required length into `len`.
    let rc = unsafe { GetCurrentPackageFullName(&mut len, std::ptr::null_mut()) };
    let packaged = rc == ERROR_INSUFFICIENT_BUFFER || rc == ERROR_SUCCESS;
    tracing::info!("install source: {}", if packaged { "store" } else { "direct" });
    packaged
}

#[cfg(not(windows))]
fn detect_packaged() -> bool {
    false
}

/// "store" or "direct", for the Settings → About line.
#[tauri::command]
pub fn get_install_source() -> &'static str {
    if is_packaged() { "store" } else { "direct" }
}
