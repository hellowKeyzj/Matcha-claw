use std::{mem::ManuallyDrop, time::SystemTime};

use windows_sys::Win32::{Foundation as F, System::Threading as T};

use super::{
    super::super::{ExitObservation, ProcessIdentity},
    error::WindowsCustodyError,
};

type Result<T> = std::result::Result<T, WindowsCustodyError>;

pub(super) struct Handle(F::HANDLE);

// SAFETY: Win32 kernel handles are process-wide and ownership moves exclusively with Handle.
unsafe impl Send for Handle {}

impl Handle {
    pub(super) fn new(raw: F::HANDLE, operation: &'static str) -> Result<Self> {
        if raw.is_null() || raw == F::INVALID_HANDLE_VALUE {
            return Err(native(operation));
        }
        Ok(Self(raw))
    }

    pub(super) const fn raw(&self) -> F::HANDLE {
        self.0
    }

    pub(super) fn into_raw(self) -> F::HANDLE {
        ManuallyDrop::new(self).0
    }

    pub(super) fn is_signaled(&self) -> Result<bool> {
        // SAFETY: handle is a valid waitable process handle.
        match unsafe { T::WaitForSingleObject(self.raw(), 0) } {
            F::WAIT_OBJECT_0 => Ok(true),
            F::WAIT_TIMEOUT => Ok(false),
            _ => Err(native("WaitForSingleObject")),
        }
    }

    pub(super) fn exit_observation(&self) -> Result<ExitObservation> {
        let mut exit_code = 0;
        if unsafe { T::GetExitCodeProcess(self.raw(), &mut exit_code) } == 0 {
            return Err(native("GetExitCodeProcess"));
        }
        Ok(exit_observation(exit_code, SystemTime::now()))
    }

    pub(super) fn identity(&self) -> Result<ProcessIdentity> {
        let mut creation = F::FILETIME::default();
        let mut exit = F::FILETIME::default();
        let mut kernel = F::FILETIME::default();
        let mut user = F::FILETIME::default();
        if unsafe {
            T::GetProcessTimes(self.raw(), &mut creation, &mut exit, &mut kernel, &mut user)
        } == 0
        {
            return Err(native("GetProcessTimes"));
        }
        Ok(ProcessIdentity::new(
            // SAFETY: the process handle retains the original process instance identity.
            unsafe { T::GetProcessId(self.raw()) },
            creation_marker(creation),
        ))
    }
}

pub(super) const fn creation_marker(creation: F::FILETIME) -> u128 {
    let marker = (creation.dwLowDateTime as u64) | ((creation.dwHighDateTime as u64) << 32);
    marker as u128
}

fn exit_observation(exit_code: u32, observed_at: SystemTime) -> ExitObservation {
    ExitObservation::new(Some(exit_code as i32), None, observed_at)
}

impl Drop for Handle {
    fn drop(&mut self) {
        // SAFETY: Handle only owns non-null, non-invalid Win32 handles and drops once.
        unsafe { F::CloseHandle(self.0) };
    }
}

pub(super) fn native(operation: &'static str) -> WindowsCustodyError {
    // SAFETY: GetLastError only reads the calling thread's Win32 error slot.
    WindowsCustodyError::native(operation, unsafe { F::GetLastError() })
}

pub(super) fn close_if_valid(raw: F::HANDLE) {
    if !raw.is_null() && raw != F::INVALID_HANDLE_VALUE {
        // SAFETY: this branch only handles a raw CreateProcessW result not adopted by Handle.
        unsafe { F::CloseHandle(raw) };
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, SystemTime};

    use windows_sys::Win32::Foundation::FILETIME;

    use super::{creation_marker, exit_observation};

    #[test]
    fn creation_marker_combines_filetime_words_without_pid_guessing() {
        let marker = creation_marker(FILETIME {
            dwLowDateTime: 0x89ab_cdef,
            dwHighDateTime: 0x0123_4567,
        });

        assert_eq!(marker, 0x0123_4567_89ab_cdef);
    }

    #[test]
    fn exit_observation_preserves_unsigned_windows_exit_codes() {
        let observed_at = SystemTime::UNIX_EPOCH + Duration::from_secs(42);
        let observation = exit_observation(u32::MAX, observed_at);

        assert_eq!(observation.exit_code(), Some(-1));
        assert_eq!(observation.signal(), None);
        assert_eq!(observation.observed_at(), observed_at);
    }
}
