use std::{
    fmt,
    os::windows::io::{AsRawHandle, FromRawHandle, IntoRawHandle},
    process::Command,
    time::Instant,
};

use windows_sys::Win32::{Foundation as F, System::Threading as T};

use crate::protocol::ProcessIdentity;

const HARD_KILL_EXIT_CODE: u32 = 1;
const MAX_WAIT_MILLIS: u128 = u32::MAX as u128 - 1;

pub(crate) fn current_identity() -> Result<ProcessIdentity, PlatformError> {
    let process = OwnedHandle::current_process()?;
    process.identity(std::process::id())
}

pub(crate) fn is_exact_identity_alive(identity: ProcessIdentity) -> Result<bool, PlatformError> {
    let Some(process) = OwnedHandle::open(identity.pid(), observation_access())? else {
        return Ok(false);
    };
    if classify_marker(process.creation_marker()?, identity.creation_marker())
        == MarkerMatch::Different
    {
        return Ok(false);
    }
    process.is_live()
}

pub(crate) fn hard_kill_exact(identity: ProcessIdentity) -> Result<(), PlatformError> {
    let Some(process) = OwnedHandle::open(identity.pid(), termination_access())? else {
        return Ok(());
    };
    if classify_marker(process.creation_marker()?, identity.creation_marker())
        == MarkerMatch::Different
    {
        return Ok(());
    }
    if !process.is_live()? {
        return Ok(());
    }
    // SAFETY: process was opened with PROCESS_TERMINATE and its marker was verified above.
    if unsafe { T::TerminateProcess(process.raw(), HARD_KILL_EXIT_CODE) } != 0 {
        return Ok(());
    }
    if !process.is_live()? {
        return Ok(());
    }
    Err(PlatformError::new("TerminateProcess failed"))
}

pub(crate) fn wait_for_exact_exit(
    identity: ProcessIdentity,
    deadline: Instant,
) -> Result<(), PlatformError> {
    let Some(process) = OwnedHandle::open(identity.pid(), observation_access())? else {
        return Ok(());
    };
    if classify_marker(process.creation_marker()?, identity.creation_marker())
        == MarkerMatch::Different
    {
        return Ok(());
    }
    process.wait_until(deadline)
}

pub(crate) fn spawn_host_kill_verifier(
    command: &mut Command,
) -> Result<OwnedHandle, PlatformError> {
    let child = command
        .spawn()
        .map_err(|_| PlatformError::new("fixture verifier spawn failed"))?;
    let raw = child.into_raw_handle();
    // SAFETY: Child transferred exclusive ownership of its valid process handle above.
    Ok(OwnedHandle(unsafe {
        std::os::windows::io::OwnedHandle::from_raw_handle(raw)
    }))
}

#[derive(Debug)]
pub(crate) struct OwnedHandle(std::os::windows::io::OwnedHandle);

impl OwnedHandle {
    fn current_process() -> Result<Self, PlatformError> {
        let current_pid = std::process::id();
        Self::open(current_pid, T::PROCESS_QUERY_LIMITED_INFORMATION)?
            .ok_or_else(|| PlatformError::new("current process is unavailable"))
    }

    fn open(pid: u32, access: u32) -> Result<Option<Self>, PlatformError> {
        // SAFETY: no handle inheritance is requested; pid and access are passed through unchanged.
        let raw = unsafe { T::OpenProcess(access, 0, pid) };
        if raw.is_null() {
            // Windows reports an absent PID through ERROR_INVALID_PARAMETER. Other failures,
            // notably access denial, do not prove that the exact identity is gone.
            return match unsafe { F::GetLastError() } {
                F::ERROR_INVALID_PARAMETER => Ok(None),
                _ => Err(PlatformError::new("OpenProcess failed")),
            };
        }
        if raw == F::INVALID_HANDLE_VALUE {
            return Err(PlatformError::new("OpenProcess returned an invalid handle"));
        }
        // SAFETY: OpenProcess returned a non-null, non-invalid handle owned by this caller.
        Ok(Some(Self(unsafe {
            std::os::windows::io::OwnedHandle::from_raw_handle(raw)
        })))
    }

    fn raw(&self) -> F::HANDLE {
        self.0.as_raw_handle()
    }

    fn identity(&self, pid: u32) -> Result<ProcessIdentity, PlatformError> {
        Ok(ProcessIdentity::new(pid, self.creation_marker()?))
    }

    fn creation_marker(&self) -> Result<u128, PlatformError> {
        let mut creation = F::FILETIME::default();
        let mut exit = F::FILETIME::default();
        let mut kernel = F::FILETIME::default();
        let mut user = F::FILETIME::default();
        // SAFETY: self is a process handle with query access and all outputs are writable.
        bool_result(
            unsafe {
                T::GetProcessTimes(self.raw(), &mut creation, &mut exit, &mut kernel, &mut user)
            },
            "GetProcessTimes",
        )?;
        Ok(creation_marker(creation))
    }

    fn is_live(&self) -> Result<bool, PlatformError> {
        // SAFETY: self is a valid waitable process handle.
        match unsafe { T::WaitForSingleObject(self.raw(), 0) } {
            F::WAIT_TIMEOUT => Ok(true),
            F::WAIT_OBJECT_0 => Ok(false),
            _ => Err(PlatformError::new("WaitForSingleObject failed")),
        }
    }

    fn wait_until(&self, deadline: Instant) -> Result<(), PlatformError> {
        loop {
            let now = Instant::now();
            if now >= deadline {
                return match self.is_live()? {
                    false => Ok(()),
                    true => Err(PlatformError::new("process exit deadline elapsed")),
                };
            }
            let wait_millis = deadline
                .saturating_duration_since(now)
                .as_millis()
                .min(MAX_WAIT_MILLIS) as u32;
            // SAFETY: self is a valid waitable process handle and the wait is deadline-bounded.
            match unsafe { T::WaitForSingleObject(self.raw(), wait_millis) } {
                F::WAIT_OBJECT_0 => return Ok(()),
                F::WAIT_TIMEOUT => continue,
                _ => return Err(PlatformError::new("WaitForSingleObject failed")),
            }
        }
    }
}

const fn observation_access() -> u32 {
    T::PROCESS_QUERY_LIMITED_INFORMATION | T::PROCESS_SYNCHRONIZE
}

const fn termination_access() -> u32 {
    observation_access() | T::PROCESS_TERMINATE
}

fn bool_result(succeeded: i32, operation: &'static str) -> Result<(), PlatformError> {
    if succeeded == 0 {
        Err(PlatformError::new(operation))
    } else {
        Ok(())
    }
}

const fn creation_marker(creation: F::FILETIME) -> u128 {
    let marker = creation.dwLowDateTime as u64 | ((creation.dwHighDateTime as u64) << 32);
    marker as u128
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum MarkerMatch {
    Exact,
    Different,
}

const fn classify_marker(observed: u128, expected: u128) -> MarkerMatch {
    if observed == expected {
        MarkerMatch::Exact
    } else {
        MarkerMatch::Different
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct PlatformError {
    operation: &'static str,
}

impl PlatformError {
    const fn new(operation: &'static str) -> Self {
        Self { operation }
    }
}

impl fmt::Display for PlatformError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.operation)
    }
}

impl std::error::Error for PlatformError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marker_combines_filetime_words_like_production_identity() {
        assert_eq!(
            creation_marker(F::FILETIME {
                dwLowDateTime: 0x89ab_cdef,
                dwHighDateTime: 0x0123_4567,
            }),
            0x0123_4567_89ab_cdef,
        );
    }

    #[test]
    fn marker_mismatch_classifies_reused_pid_as_gone() {
        assert_eq!(classify_marker(41, 41), MarkerMatch::Exact);
        assert_eq!(classify_marker(42, 41), MarkerMatch::Different);
    }
}
