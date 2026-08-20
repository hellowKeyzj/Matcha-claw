#[cfg(unix)]
#[path = "../process/system/posix/guardian.rs"]
pub(crate) mod guardian;
#[cfg(unix)]
#[path = "../process/system/posix/guardian_cleanup_bootstrap.rs"]
pub(crate) mod guardian_cleanup_bootstrap;
#[cfg(unix)]
#[path = "../process/system/posix/guardian_cleanup_runtime.rs"]
pub(crate) mod guardian_cleanup_runtime;
#[cfg(unix)]
#[path = "../process/system/posix/guardian_descriptors.rs"]
pub(crate) mod guardian_descriptors;
#[cfg(unix)]
#[path = "../process/system/posix/guardian_io.rs"]
pub(crate) mod guardian_io;
#[cfg(unix)]
#[path = "../process/system/posix/guardian_protocol.rs"]
pub(crate) mod guardian_protocol;
#[cfg(unix)]
#[path = "../process/system/posix/guardian_runtime_descriptors.rs"]
pub(crate) mod guardian_runtime_descriptors;
#[cfg(unix)]
#[path = "../process/system/posix/guardian_timeout.rs"]
pub(crate) mod guardian_timeout;
#[cfg(unix)]
#[path = "../process/system/posix/io.rs"]
pub(crate) mod io;
#[cfg(unix)]
mod process {
    pub(crate) mod launch {
        pub(crate) mod posix_limits {
            include!("../process/launch/posix_limits.rs");
        }
    }
}
#[cfg(all(unix, target_os = "linux"))]
#[path = "../process/system/posix/linux.rs"]
pub(crate) mod linux;
#[cfg(all(unix, target_os = "macos"))]
#[path = "../process/system/posix/macos.rs"]
pub(crate) mod macos;
#[cfg(unix)]
#[path = "../process/system/posix/platform.rs"]
pub(crate) mod platform;
#[cfg(unix)]
#[path = "../process/system/posix/protocol.rs"]
pub(crate) mod protocol;
#[cfg(unix)]
#[path = "../process/system/posix/protocol_observation_decode.rs"]
pub(crate) mod protocol_observation_decode;
#[cfg(unix)]
#[path = "../process/system/posix/scope.rs"]
pub(crate) mod scope;
#[cfg(unix)]
#[path = "../process/system/posix/sentinel.rs"]
pub(crate) mod sentinel;

#[cfg(unix)]
fn run() -> std::io::Result<()> {
    let host_input = adopt_required(libc::STDIN_FILENO)?;
    let host_output = adopt_required(libc::STDOUT_FILENO)?;
    let target_stdio = [
        adopt_required(guardian_descriptors::TARGET_STDIN_FD)?,
        adopt_required(guardian_descriptors::TARGET_STDOUT_FD)?,
        adopt_required(guardian_descriptors::TARGET_STDERR_FD)?,
    ];
    let target_state_directory = adopt_optional(guardian_descriptors::TARGET_STATE_DIRECTORY_FD)?;
    let private_descriptor = adopt_optional(guardian_descriptors::TARGET_PRIVATE_DESCRIPTOR_FD)?;
    let execution_source = adopt_optional(guardian_descriptors::TARGET_EXECUTION_SOURCE_FD)?;
    let cleanup_directory = adopt_optional(guardian_descriptors::GUARDIAN_CLEANUP_DIRECTORY_FD)?;
    let cleanup_names = match adopt_optional(guardian_descriptors::GUARDIAN_CLEANUP_NAMES_FD)? {
        Some(descriptor) => guardian_cleanup_bootstrap::read_names(descriptor)?,
        None => Vec::new(),
    };
    if cleanup_directory.is_none() && !cleanup_names.is_empty() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "guardian cleanup names require a cleanup directory",
        ));
    }
    guardian::run(
        host_input,
        host_output,
        target_stdio,
        target_state_directory,
        private_descriptor,
        execution_source,
        cleanup_directory,
        cleanup_names,
    )
}

#[cfg(unix)]
fn adopt_required(descriptor: libc::c_int) -> std::io::Result<std::os::fd::OwnedFd> {
    use std::os::fd::FromRawFd;

    if unsafe { libc::fcntl(descriptor, libc::F_GETFD) } == -1 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(unsafe { std::os::fd::OwnedFd::from_raw_fd(descriptor) })
}

#[cfg(unix)]
fn adopt_optional(descriptor: libc::c_int) -> std::io::Result<Option<std::os::fd::OwnedFd>> {
    use std::os::fd::FromRawFd;

    if unsafe { libc::fcntl(descriptor, libc::F_GETFD) } == -1 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::EBADF) {
            return Ok(None);
        }
        return Err(error);
    }
    Ok(Some(unsafe {
        std::os::fd::OwnedFd::from_raw_fd(descriptor)
    }))
}

#[cfg(unix)]
fn main() {
    if run().is_err() {
        std::process::exit(127);
    }
}

#[cfg(not(unix))]
fn main() {
    eprintln!("process-guardian is not supported on this platform");
    std::process::exit(1);
}
