#[cfg(unix)]
pub(crate) mod posix;
#[cfg(windows)]
pub mod windows;

#[cfg(test)]
mod native_tests;
