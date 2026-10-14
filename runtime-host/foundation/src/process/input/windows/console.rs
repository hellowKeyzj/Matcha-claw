use std::{
    io,
    mem::size_of,
    os::windows::io::{AsRawHandle, OwnedHandle},
    sync::atomic::{AtomicBool, Ordering},
};

use windows_sys::Win32::{
    Foundation::{ERROR_OPERATION_ABORTED, GetLastError, SetLastError},
    System::Console::{CONSOLE_READCONSOLE_CONTROL, GetConsoleMode, ReadConsoleW},
};

pub(super) struct ConsoleInput {
    surrogate: Option<u16>,
}

impl ConsoleInput {
    pub(super) fn open(input: &OwnedHandle) -> Option<Self> {
        let mut mode = 0;
        // SAFETY: input is a live owned handle, and mode is writable for the call.
        (unsafe { GetConsoleMode(input.as_raw_handle() as _, &mut mode) } != 0)
            .then_some(Self { surrogate: None })
    }

    pub(super) fn read(&mut self, input: &OwnedHandle, stop: &AtomicBool) -> io::Result<Vec<u8>> {
        // Match std's Unicode console path, including DOS EOF and Ctrl-C handling.
        const CTRL_Z: u16 = 0x1a;
        let control = CONSOLE_READCONSOLE_CONTROL {
            nLength: size_of::<CONSOLE_READCONSOLE_CONTROL>() as u32,
            nInitialChars: 0,
            dwCtrlWakeupMask: 1 << CTRL_Z,
            dwControlKeyState: 0,
        };
        loop {
            if stop.load(Ordering::Acquire) {
                return Ok(Vec::new());
            }
            let mut utf16 = [0_u16; 4096];
            let start = usize::from(self.surrogate.is_some());
            if let Some(surrogate) = self.surrogate.take() {
                utf16[0] = surrogate;
            }
            let mut read = 0;
            // SAFETY: the owned handle, UTF-16 buffer, count and control live through this sync call.
            let result = unsafe {
                SetLastError(0);
                ReadConsoleW(
                    input.as_raw_handle() as _,
                    utf16[start..].as_mut_ptr().cast(),
                    (utf16.len() - start) as u32,
                    &mut read,
                    &control,
                )
            };
            if result == 0 {
                return Err(io::Error::last_os_error());
            }
            // A successful zero-character read with this code is Ctrl-C, not EOF.
            if read == 0 && unsafe { GetLastError() } == ERROR_OPERATION_ABORTED {
                self.surrogate = (start != 0).then_some(utf16[0]);
                continue;
            }
            let mut count = read as usize + start;
            if count > 0 && utf16[count - 1] == CTRL_Z {
                count -= 1;
            }
            if count > 0 && (0xd800..=0xdbff).contains(&utf16[count - 1]) {
                self.surrogate = Some(utf16[count - 1]);
                count -= 1;
                if count == 0 && read != 0 {
                    continue;
                }
            }
            return String::from_utf16(&utf16[..count])
                .map(String::into_bytes)
                .map_err(|_| {
                    io::Error::new(io::ErrorKind::InvalidData, "standard input contains invalid UTF-16")
                });
        }
    }
}
