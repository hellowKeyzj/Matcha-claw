use std::{error::Error, fmt, io::Read, path::PathBuf};

use pdfium_render::prelude::{Pdfium, PdfiumLibraryBindings};
use sha2::{Digest as _, Sha256};

use crate::{FailureKind, ParseFailure};

/// Keep the loader's actual module alive until Pdfium has acquired its own reference.
pub(super) fn bind(
    path: &std::path::Path,
) -> Result<(Box<dyn PdfiumLibraryBindings>, String), ParseFailure> {
    let library = native::Library::open(path)?;
    let loaded_path =
        std::fs::canonicalize(library.path()?).map_err(|cause| unavailable("path", cause))?;
    let mut file = std::fs::File::open(&loaded_path).map_err(|cause| unavailable("hash", cause))?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|cause| unavailable("hash", cause))?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    let bindings =
        Pdfium::bind_to_library(&loaded_path).map_err(|cause| unavailable("bind", cause))?;
    Ok((bindings, format!("{:x}", hash.finalize())))
}

/// The signed file lease remains alive in the parent until this process has joined.
/// Verify before any native code runs, then verify the loader selected that exact file.
pub(super) fn bind_exact(
    path: &std::path::Path,
    expected: &str,
) -> Result<(Box<dyn PdfiumLibraryBindings>, String), ParseFailure> {
    let expected = expected.strip_prefix("sha256:").unwrap_or(expected);
    if !path.is_absolute()
        || expected.len() != 64
        || !expected.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(unavailable("selection", std::io::Error::from(std::io::ErrorKind::InvalidInput)));
    }
    let path = std::fs::canonicalize(path).map_err(|cause| unavailable("path", cause))?;
    if fingerprint(&path)? != expected {
        return Err(unavailable("digest", std::io::Error::from(std::io::ErrorKind::InvalidData)));
    }
    let library = native::Library::open(&path)?;
    let loaded = std::fs::canonicalize(library.path()?).map_err(|cause| unavailable("path", cause))?;
    if loaded != path || fingerprint(&loaded)? != expected {
        return Err(unavailable("loaded_digest", std::io::Error::from(std::io::ErrorKind::InvalidData)));
    }
    let bindings = Pdfium::bind_to_library(&loaded).map_err(|cause| unavailable("bind", cause))?;
    Ok((bindings, expected.to_owned()))
}

fn fingerprint(path: &std::path::Path) -> Result<String, ParseFailure> {
    let mut file = std::fs::File::open(path).map_err(|cause| unavailable("hash", cause))?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|cause| unavailable("hash", cause))?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

#[derive(Debug)]
struct LibraryFailure {
    stage: &'static str,
    cause: Box<dyn Error + Send + Sync>,
}

impl fmt::Display for LibraryFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "Native document library {} failed", self.stage)
    }
}

impl Error for LibraryFailure {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        Some(self.cause.as_ref())
    }
}

fn unavailable(stage: &'static str, cause: impl Error + Send + Sync + 'static) -> ParseFailure {
    ParseFailure::caused(
        FailureKind::ParserUnavailable,
        LibraryFailure {
            stage,
            cause: Box::new(cause),
        },
    )
}

#[cfg(windows)]
mod native {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use windows_sys::Win32::{
        Foundation::{FreeLibrary, HMODULE},
        System::LibraryLoader::{GetModuleFileNameW, GetProcAddress, LoadLibraryW},
    };

    use super::*;

    pub(super) struct Library(HMODULE);

    impl Library {
        pub(super) fn open(path: &std::path::Path) -> Result<Self, ParseFailure> {
            let name: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
            if name[..name.len() - 1].contains(&0) {
                return Err(unavailable(
                    "load",
                    std::io::Error::from(std::io::ErrorKind::InvalidInput),
                ));
            }
            // Same OS loader as pdfium-render; this is Host-selected native code, not document data.
            let handle = unsafe { LoadLibraryW(name.as_ptr()) };
            if handle.is_null() {
                return Err(unavailable("load", std::io::Error::last_os_error()));
            }
            Ok(Self(handle))
        }

        pub(super) fn path(&self) -> Result<PathBuf, ParseFailure> {
            if unsafe { GetProcAddress(self.0, c"FPDF_InitLibrary".as_ptr().cast()) }.is_none() {
                return Err(unavailable("symbol", std::io::Error::last_os_error()));
            }
            let mut name = vec![0u16; 512];
            loop {
                // The live module handle determines the path, including system-loader resolution.
                let count =
                    unsafe { GetModuleFileNameW(self.0, name.as_mut_ptr(), name.len() as u32) }
                        as usize;
                if count == 0 {
                    return Err(unavailable("path", std::io::Error::last_os_error()));
                }
                if count < name.len() {
                    return Ok(PathBuf::from(std::ffi::OsString::from_wide(&name[..count])));
                }
                name.resize(name.len() * 2, 0);
            }
        }
    }

    impl Drop for Library {
        fn drop(&mut self) {
            // Pdfium's successful binding owns a separate loader reference.
            unsafe { FreeLibrary(self.0) };
        }
    }
}

#[cfg(unix)]
mod native {
    use std::{
        ffi::{CStr, CString, OsStr},
        os::unix::ffi::OsStrExt,
    };

    use super::*;

    pub(super) struct Library(*mut libc::c_void);

    fn loader_error(stage: &'static str) -> ParseFailure {
        let error = unsafe { libc::dlerror() };
        let message = if error.is_null() {
            "Native document library resolution failed".to_owned()
        } else {
            unsafe { CStr::from_ptr(error) }
                .to_string_lossy()
                .into_owned()
        };
        unavailable(stage, std::io::Error::other(message))
    }

    impl Library {
        pub(super) fn open(path: &std::path::Path) -> Result<Self, ParseFailure> {
            let name = CString::new(path.as_os_str().as_bytes())
                .map_err(|cause| unavailable("load", cause))?;
            // Match pdfium-render's libloading default flags and hold this exact loaded module.
            let handle = unsafe { libc::dlopen(name.as_ptr(), libc::RTLD_LAZY | libc::RTLD_LOCAL) };
            if handle.is_null() {
                return Err(loader_error("load"));
            }
            Ok(Self(handle))
        }

        pub(super) fn path(&self) -> Result<PathBuf, ParseFailure> {
            let symbol = unsafe { libc::dlsym(self.0, c"FPDF_InitLibrary".as_ptr()) };
            if symbol.is_null() {
                return Err(loader_error("symbol"));
            }
            let mut info = std::mem::MaybeUninit::<libc::Dl_info>::uninit();
            if unsafe { libc::dladdr(symbol, info.as_mut_ptr()) } == 0 {
                return Err(loader_error("path"));
            }
            let info = unsafe { info.assume_init() };
            if info.dli_fname.is_null() {
                return Err(loader_error("path"));
            }
            let name = unsafe { CStr::from_ptr(info.dli_fname) };
            Ok(PathBuf::from(OsStr::from_bytes(name.to_bytes())))
        }
    }

    impl Drop for Library {
        fn drop(&mut self) {
            // Pdfium's successful binding owns a separate loader reference.
            unsafe { libc::dlclose(self.0) };
        }
    }
}
