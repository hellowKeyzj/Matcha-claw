use std::{ffi::OsString, fmt, os::windows::ffi::OsStringExt};

use windows_sys::Win32::System::SystemInformation::GetWindowsDirectoryW;

const MAX_WINDOWS_DIRECTORY_UNITS: usize = 32_767;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WindowsSystemRootError;

impl fmt::Display for WindowsSystemRootError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Windows system root is unavailable")
    }
}

impl std::error::Error for WindowsSystemRootError {}

pub fn windows_system_root() -> Result<OsString, WindowsSystemRootError> {
    let mut buffer = vec![0_u16; 260];
    loop {
        let written = unsafe { GetWindowsDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) };
        if written == 0 {
            return Err(WindowsSystemRootError);
        }
        let written = written as usize;
        if written < buffer.len() {
            return Ok(OsString::from_wide(&buffer[..written]));
        }
        let next = written
            .checked_add(1)
            .filter(|size| *size <= MAX_WINDOWS_DIRECTORY_UNITS)
            .ok_or(WindowsSystemRootError)?;
        buffer.resize(next, 0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_root_is_a_nonempty_absolute_path() {
        let root = windows_system_root().unwrap();
        assert!(!root.is_empty());
        assert!(std::path::Path::new(&root).is_absolute());
    }
}
