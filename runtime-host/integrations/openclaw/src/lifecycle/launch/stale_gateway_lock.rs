use std::{
    ffi::OsString,
    fs, io,
    path::{Path, PathBuf},
};

use serde::Deserialize;

use platform::state_dir::CanonicalStateDir;

const TEMP_DIR: &str = "tmp";
const GATEWAY_LOCK_DIR: &str = "openclaw";
const MAX_GATEWAY_LOCK_PAYLOAD_BYTES: u64 = 16 * 1024;
const GATEWAY_RECLAIM_GUARD_SUFFIX: &str = ".reclaim";

#[derive(Deserialize)]
struct GatewayLockPayload {
    pid: Option<u32>,
    role: Option<String>,
}

pub(super) fn remove_stale_gateway_lock_artifacts(state_dir: &CanonicalStateDir) -> io::Result<()> {
    for lock_dir in gateway_lock_dirs(state_dir.as_path()) {
        let entries = match fs::read_dir(&lock_dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };

        for entry in entries {
            let path = entry?.path();
            if let Some(lock_path) = gateway_reclaim_guard_lock_path(&path) {
                if !lock_path.exists() {
                    remove_file_or_empty_dir_if_present(&path)?;
                }
                continue;
            }
            if !is_gateway_lock_file(&path) {
                continue;
            }
            let Some(payload) = read_gateway_lock_payload(&path)? else {
                continue;
            };
            if !is_gateway_payload(&payload) || !is_dead_owner(payload.pid) {
                continue;
            }
            remove_lock_and_reclaim_guard(&path)?;
        }
    }

    Ok(())
}

fn gateway_lock_dirs(state_dir: &Path) -> Vec<PathBuf> {
    let tmp = state_dir.join(TEMP_DIR);
    let mut dirs = Vec::with_capacity(2);
    #[cfg(unix)]
    dirs.push(tmp.join(format!("{GATEWAY_LOCK_DIR}-{}", unsafe { libc::getuid() })));
    dirs.push(tmp.join(GATEWAY_LOCK_DIR));
    dirs
}

fn is_gateway_lock_file(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    is_gateway_lock_name(name)
}

fn is_gateway_lock_name(name: &str) -> bool {
    name == "gateway.state.lock" || (name.starts_with("gateway.") && name.ends_with(".lock"))
}

fn gateway_reclaim_guard_lock_path(path: &Path) -> Option<PathBuf> {
    let name = path.file_name()?.to_str()?;
    let lock_name = name.strip_suffix(GATEWAY_RECLAIM_GUARD_SUFFIX)?;
    is_gateway_lock_name(lock_name).then(|| path.with_file_name(lock_name))
}

fn read_gateway_lock_payload(path: &Path) -> io::Result<Option<GatewayLockPayload>> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    if !metadata.is_file() || metadata.len() > MAX_GATEWAY_LOCK_PAYLOAD_BYTES {
        return Ok(None);
    }
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    Ok(serde_json::from_slice(&bytes).ok())
}

fn is_gateway_payload(payload: &GatewayLockPayload) -> bool {
    matches!(payload.role.as_deref(), None | Some("gateway"))
}

fn is_dead_owner(pid: Option<u32>) -> bool {
    let Some(pid) = pid.filter(|pid| *pid != 0) else {
        return false;
    };
    matches!(owner_process_state(pid), OwnerProcessState::Dead)
}

fn remove_lock_and_reclaim_guard(lock_path: &Path) -> io::Result<()> {
    remove_file_if_present(lock_path)?;
    remove_file_or_empty_dir_if_present(&companion_path(lock_path, GATEWAY_RECLAIM_GUARD_SUFFIX))
}

fn companion_path(path: &Path, suffix: &str) -> PathBuf {
    let mut value = OsString::from(path.as_os_str());
    value.push(suffix);
    PathBuf::from(value)
}

fn remove_file_if_present(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn remove_file_or_empty_dir_if_present(path: &Path) -> io::Result<()> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if metadata.is_dir() {
        return match fs::remove_dir(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        };
    }
    remove_file_if_present(path)
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum OwnerProcessState {
    Running,
    Dead,
    Unknown,
}

#[cfg(windows)]
fn owner_process_state(pid: u32) -> OwnerProcessState {
    use windows_sys::Win32::{Foundation as F, System::Threading as T};

    // SAFETY: pid is supplied by gateway lock metadata; no handle inheritance is requested.
    let handle = unsafe {
        T::OpenProcess(
            T::PROCESS_QUERY_LIMITED_INFORMATION | T::PROCESS_SYNCHRONIZE,
            0,
            pid,
        )
    };
    if handle.is_null() {
        // SAFETY: GetLastError only reads the calling thread's Win32 error slot.
        return match unsafe { F::GetLastError() } {
            F::ERROR_INVALID_PARAMETER => OwnerProcessState::Dead,
            _ => OwnerProcessState::Unknown,
        };
    }
    if handle == F::INVALID_HANDLE_VALUE {
        return OwnerProcessState::Unknown;
    }

    // SAFETY: OpenProcess returned a valid waitable process handle owned by this caller.
    let state = match unsafe { T::WaitForSingleObject(handle, 0) } {
        F::WAIT_TIMEOUT => OwnerProcessState::Running,
        F::WAIT_OBJECT_0 => OwnerProcessState::Dead,
        _ => OwnerProcessState::Unknown,
    };
    // SAFETY: handle is non-null/non-invalid and owned by this caller.
    unsafe { F::CloseHandle(handle) };
    state
}

#[cfg(unix)]
fn owner_process_state(pid: u32) -> OwnerProcessState {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return OwnerProcessState::Unknown;
    };
    // SAFETY: kill(pid, 0) probes liveness without sending a signal.
    if unsafe { libc::kill(pid, 0) } == 0 {
        return OwnerProcessState::Running;
    }
    match io::Error::last_os_error().raw_os_error() {
        Some(libc::ESRCH) => OwnerProcessState::Dead,
        Some(libc::EPERM) => OwnerProcessState::Running,
        _ => OwnerProcessState::Unknown,
    }
}
