#[cfg(target_os = "linux")]
pub(crate) use super::linux::*;
#[cfg(target_os = "macos")]
pub(crate) use super::macos::*;

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
compile_error!("Foundation POSIX authority supports only Linux and macOS");
