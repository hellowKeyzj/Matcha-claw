use std::io;
use std::os::fd::{AsRawFd, IntoRawFd, OwnedFd, RawFd};
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use crate::process::launch::posix::PosixLaunchCustody;

use super::guardian_cleanup;
use super::guardian_io::socket_pair_cloexec;
use super::stdio::HostStdio;

pub(super) struct GuardianProcess {
    pub(super) child: Child,
    pub(super) stdin: ChildStdin,
    pub(super) stdout: ChildStdout,
}

pub(super) enum SpawnFailure {
    BeforeOwnership(io::Error),
    AfterOwnership,
}

pub(super) fn spawn(
    executable: &Path,
    stdio: HostStdio,
    custody: Option<PosixLaunchCustody>,
    private_descriptor: Option<OwnedFd>,
    execution_source: Option<OwnedFd>,
) -> Result<(GuardianProcess, HostStdio), SpawnFailure> {
    if !executable.is_absolute() {
        return Err(SpawnFailure::BeforeOwnership(io::Error::new(
            io::ErrorKind::InvalidInput,
            "guardian executable is not absolute",
        )));
    }
    if !executable.is_file() {
        return Err(SpawnFailure::BeforeOwnership(io::Error::new(
            io::ErrorKind::NotFound,
            "guardian executable is not a file",
        )));
    }
    let (target_stdio, process_stdio) = stdio.into_target_ends();
    let (target_state_directory, cleanup_directory, cleanup_names, handoff) = custody
        .map(PosixLaunchCustody::into_guardian_parts)
        .map_or_else(
            || (None, None, Vec::new(), None),
            |(target, cleanup, names, handoff)| (Some(target), Some(cleanup), names, handoff),
        );
    let cleanup_names = if cleanup_directory.is_some() {
        let (read, write) = socket_pair_cloexec().map_err(SpawnFailure::BeforeOwnership)?;
        set_nonblocking(write.as_raw_fd()).map_err(SpawnFailure::BeforeOwnership)?;
        guardian_cleanup::write_names(write, &cleanup_names)
            .map_err(SpawnFailure::BeforeOwnership)?;
        Some(read)
    } else {
        None
    };
    let descriptor_limit =
        super::guardian_descriptors::descriptor_limit().map_err(SpawnFailure::BeforeOwnership)?;
    let mut target_stdio = Some(target_stdio);
    let mut target_state_directory = target_state_directory;
    let mut private_descriptor = private_descriptor;
    let mut execution_source = execution_source;
    let mut cleanup_directory = cleanup_directory;
    let mut cleanup_names = cleanup_names;
    let mut command = Command::new(executable);
    command
        .current_dir("/")
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    unsafe {
        command.pre_exec(move || {
            prepare_guardian_exec(
                target_stdio
                    .take()
                    .expect("guardian target stdio must be transferred once"),
                target_state_directory.take(),
                private_descriptor.take(),
                execution_source.take(),
                cleanup_directory.take(),
                cleanup_names.take(),
                descriptor_limit,
            )
        });
    }
    let child = command.spawn().map_err(SpawnFailure::BeforeOwnership)?;
    if let Some(handoff) = handoff {
        handoff();
    }
    let guardian = finish(child).map_err(|_| SpawnFailure::AfterOwnership)?;
    Ok((guardian, process_stdio))
}

pub(super) fn finish(mut child: Child) -> io::Result<GuardianProcess> {
    let (stdin, stdout) = take_control(&mut child)?;
    let guardian = GuardianProcess {
        child,
        stdin,
        stdout,
    };
    if let Err(error) = configure_control(&guardian) {
        drop(guardian);
        return Err(error);
    }
    Ok(guardian)
}

pub(super) fn reap(guardian: GuardianProcess) -> io::Result<()> {
    let GuardianProcess {
        mut child,
        stdin,
        stdout,
    } = guardian;
    drop(stdin);
    drop(stdout);
    child.wait().map(|_| ())
}

fn take_control(child: &mut Child) -> io::Result<(ChildStdin, ChildStdout)> {
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| unavailable("guardian stdin is unavailable"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| unavailable("guardian stdout is unavailable"))?;
    Ok((stdin, stdout))
}

fn set_nonblocking(descriptor: std::os::fd::RawFd) -> io::Result<()> {
    let flags = unsafe { libc::fcntl(descriptor, libc::F_GETFL) };
    if flags == -1
        || unsafe { libc::fcntl(descriptor, libc::F_SETFL, flags | libc::O_NONBLOCK) } == -1
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn configure_control(guardian: &GuardianProcess) -> io::Result<()> {
    let control_flags = unsafe { libc::fcntl(guardian.stdout.as_raw_fd(), libc::F_GETFD) };
    if control_flags == -1
        || unsafe {
            libc::fcntl(
                guardian.stdout.as_raw_fd(),
                libc::F_SETFD,
                control_flags | libc::FD_CLOEXEC,
            )
        } == -1
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn prepare_guardian_exec(
    target_stdio: [OwnedFd; 3],
    target_state_directory: Option<OwnedFd>,
    private_descriptor: Option<OwnedFd>,
    execution_source: Option<OwnedFd>,
    cleanup_directory: Option<OwnedFd>,
    cleanup_names: Option<OwnedFd>,
    descriptor_limit: RawFd,
) -> io::Result<()> {
    let [target_stdin, target_stdout, target_stderr] = target_stdio;
    retain_descriptor(target_stdin, super::guardian_descriptors::TARGET_STDIN_FD)?;
    retain_descriptor(target_stdout, super::guardian_descriptors::TARGET_STDOUT_FD)?;
    retain_descriptor(target_stderr, super::guardian_descriptors::TARGET_STDERR_FD)?;
    retain_optional_descriptor(
        target_state_directory,
        super::guardian_descriptors::TARGET_STATE_DIRECTORY_FD,
    )?;
    retain_optional_descriptor(
        private_descriptor,
        super::guardian_descriptors::TARGET_PRIVATE_DESCRIPTOR_FD,
    )?;
    retain_optional_descriptor(
        execution_source,
        super::guardian_descriptors::TARGET_EXECUTION_SOURCE_FD,
    )?;
    retain_optional_descriptor(
        cleanup_directory,
        super::guardian_descriptors::GUARDIAN_CLEANUP_DIRECTORY_FD,
    )?;
    retain_optional_descriptor(
        cleanup_names,
        super::guardian_descriptors::GUARDIAN_CLEANUP_NAMES_FD,
    )?;
    super::guardian_descriptors::clear_close_on_exec(libc::STDIN_FILENO)?;
    super::guardian_descriptors::clear_close_on_exec(libc::STDOUT_FILENO)?;
    super::guardian_descriptors::clear_close_on_exec(libc::STDERR_FILENO)?;
    super::guardian_descriptors::close_descriptor(
        super::guardian_descriptors::SENTINEL_LIVENESS_FD,
    )?;
    super::guardian_descriptors::close_descriptor(
        super::guardian_descriptors::SENTINEL_CONTROL_FD,
    )?;
    close_from(
        super::guardian_descriptors::FIRST_UNRESERVED_FD,
        descriptor_limit,
    )
}

fn close_from(first: RawFd, limit: RawFd) -> io::Result<()> {
    #[cfg(target_os = "linux")]
    {
        let result = unsafe {
            libc::syscall(
                libc::SYS_close_range,
                first as libc::c_uint,
                libc::c_uint::MAX,
                0_u32,
            )
        };
        if result == 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::ENOSYS) {
            return Err(error);
        }
    }
    let mut descriptor = first;
    while descriptor < limit {
        super::guardian_descriptors::close_descriptor(descriptor)?;
        descriptor += 1;
    }
    Ok(())
}

fn retain_descriptor(descriptor: OwnedFd, target: RawFd) -> io::Result<()> {
    let descriptor = super::guardian_descriptors::relocate_descriptor(
        super::guardian_descriptors::reserve_descriptor(descriptor)?,
        target,
    )?;
    super::guardian_descriptors::clear_close_on_exec(descriptor.as_raw_fd())?;
    let _ = descriptor.into_raw_fd();
    Ok(())
}

fn retain_optional_descriptor(descriptor: Option<OwnedFd>, target: RawFd) -> io::Result<()> {
    match descriptor {
        Some(descriptor) => retain_descriptor(descriptor, target),
        None => super::guardian_descriptors::close_descriptor(target),
    }
}

fn unavailable(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::BrokenPipe, message)
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    use crate::process::{StdioMode, StdioSpec};

    use super::{HostStdio, SpawnFailure, reap, spawn};
    use crate::process::launch::posix::PosixLaunchCustody;

    #[test]
    fn failed_spawn_does_not_run_handoff() {
        let calls = Arc::new(AtomicUsize::new(0));
        let result = spawn(
            &missing_guardian_path(),
            HostStdio::create(null_stdio()).unwrap(),
            Some(custody_with_handoff(calls.clone())),
            None,
            None,
        );

        assert!(matches!(result, Err(SpawnFailure::BeforeOwnership(_))));
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn successful_spawn_runs_handoff_once() {
        let calls = Arc::new(AtomicUsize::new(0));
        let result = spawn(
            Path::new("/bin/sh"),
            HostStdio::create(null_stdio()).unwrap(),
            Some(custody_with_handoff(calls.clone())),
            None,
            None,
        );
        let Ok((guardian, _)) = result else {
            panic!("guardian spawn must succeed");
        };

        assert_eq!(calls.load(Ordering::SeqCst), 1);
        reap(guardian).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn guardian_starts_with_a_fixed_absolute_working_directory() {
        let result = spawn(
            Path::new("/bin/cat"),
            HostStdio::create(null_stdio()).unwrap(),
            None,
            None,
            None,
        );
        let Ok((guardian, _)) = result else {
            panic!("guardian spawn must succeed");
        };
        let cwd = std::fs::read_link(format!("/proc/{}/cwd", guardian.child.id())).unwrap();

        assert_eq!(cwd, Path::new("/"));
        reap(guardian).unwrap();
    }

    fn null_stdio() -> StdioSpec {
        StdioSpec::new(StdioMode::Null, StdioMode::Null, StdioMode::Null)
    }

    fn missing_guardian_path() -> PathBuf {
        std::env::temp_dir().join(format!(
            "matcha-guardian-missing-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ))
    }

    fn custody_with_handoff(calls: Arc<AtomicUsize>) -> PosixLaunchCustody {
        let directory = std::fs::File::open("/").unwrap();
        PosixLaunchCustody::new(
            directory.try_clone().unwrap().into(),
            directory.into(),
            std::iter::empty(),
        )
        .unwrap()
        .with_handoff(move || {
            calls.fetch_add(1, Ordering::SeqCst);
        })
    }
}
