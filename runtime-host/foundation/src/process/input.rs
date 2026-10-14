#[cfg(unix)]
#[path = "input/unix.rs"]
mod native;
#[cfg(windows)]
#[path = "input/windows.rs"]
mod native;

pub use native::StdinReader;
