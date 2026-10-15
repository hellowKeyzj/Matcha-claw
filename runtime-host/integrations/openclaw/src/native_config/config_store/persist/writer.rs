use platform::state_dir::StateDirHandle;

use super::{PersistError, state_dir_platform};

/// Participates in OpenClaw's native config mutation sidecar, not a second writer owner.
/// Contention fails before reading or invoking the non-replayable mutation callback.
pub(crate) struct Writer(state_dir_platform::WriterLock);

impl Writer {
    pub(crate) fn acquire(state_dir: &StateDirHandle) -> Result<Self, PersistError> {
        let mut entropy = [0u8; 16];
        getrandom::fill(&mut entropy).map_err(|_| PersistError::TemporaryCreateFailed)?;
        // fs-safe appends a whitespace-only ownership token, keeping the payload valid JSON.
        let mut payload = format!(
            "{{\"pid\":{},\"createdAt\":\"{}\"}}\n\t\t\t\t\t\t\t\t",
            std::process::id(),
            chrono::Utc::now().to_rfc3339(),
        );
        for byte in entropy {
            for bit in (0..8).rev() {
                payload.push(if byte & (1 << bit) == 0 { ' ' } else { '\t' });
            }
        }
        payload.push('\n');
        state_dir_platform::WriterLock::acquire(state_dir, payload.as_bytes()).map(Self)
    }

    pub(crate) fn release(mut self) {
        if self.0.release().is_err() {
            report_cleanup_failure();
        }
    }
}

pub(super) const MAX_LOCK_PAYLOAD_BYTES: u64 = 1_048_576;

pub(super) fn report_cleanup_failure() {
    use std::io::Write;

    let _ = writeln!(
        std::io::stderr().lock(),
        "OpenClaw config sidecar cleanup failed"
    );
}

pub(super) fn owner_is_dead(payload: &[u8]) -> bool {
    #[derive(serde::Deserialize)]
    struct Owner {
        pid: u32,
    }
    let Ok(owner) = serde_json::from_slice::<Owner>(payload) else {
        return false;
    };
    owner.pid != 0 && process_is_dead(owner.pid)
}

#[cfg(unix)]
fn process_is_dead(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    // Only ESRCH proves death; permission and other failures are not stale evidence.
    (unsafe { libc::kill(pid, 0) }) != 0
        && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}

#[cfg(windows)]
fn process_is_dead(pid: u32) -> bool {
    use windows_sys::Win32::{Foundation as F, System::Threading as T};

    let handle = unsafe {
        T::OpenProcess(
            T::PROCESS_QUERY_LIMITED_INFORMATION | T::PROCESS_SYNCHRONIZE,
            0,
            pid,
        )
    };
    if handle.is_null() {
        return (unsafe { F::GetLastError() }) == F::ERROR_INVALID_PARAMETER;
    }
    if handle == F::INVALID_HANDLE_VALUE {
        return false;
    }
    let dead = unsafe { T::WaitForSingleObject(handle, 0) } == F::WAIT_OBJECT_0;
    unsafe { F::CloseHandle(handle) };
    dead
}
