use std::ffi::CString;
use std::io;
use std::os::fd::{AsRawFd, OwnedFd, RawFd};
#[cfg(test)]
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use super::super::guardian_protocol::decode_launch_payload;
use super::super::guardian_timeout::cleanup_timeout;
use super::super::io::{pipe_cloexec, wait_ready};
use super::super::platform;

#[cfg(test)]
pub(crate) static STALL_BEFORE_TARGET_SETUP: AtomicBool = AtomicBool::new(false);
#[cfg(test)]
pub(crate) static FAIL_CLEANUP_CONFIRMATION: AtomicBool = AtomicBool::new(false);

pub(super) enum SpawnFailure {
    Drained(io::Error),
    Unresolved(io::Error),
}

pub(super) struct SpawnedTarget {
    pub(super) pid: libc::pid_t,
    pub(super) proof: platform::ProcessProof,
}

pub(super) fn spawn_target(
    payload: &[u8],
    target_stdio: [OwnedFd; 3],
    target_state_directory: Option<OwnedFd>,
    private_descriptor: Option<OwnedFd>,
    execution_source: Option<OwnedFd>,
) -> Result<SpawnedTarget, SpawnFailure> {
    spawn_target_until(
        payload,
        target_stdio,
        target_state_directory,
        private_descriptor,
        execution_source,
        Instant::now() + cleanup_timeout(),
    )
}

fn spawn_target_until(
    payload: &[u8],
    target_stdio: [OwnedFd; 3],
    target_state_directory: Option<OwnedFd>,
    private_descriptor: Option<OwnedFd>,
    execution_source: Option<OwnedFd>,
    deadline: Instant,
) -> Result<SpawnedTarget, SpawnFailure> {
    let request = decode_launch_payload(payload).map_err(SpawnFailure::Drained)?;
    if !std::path::Path::new(&request.program).is_absolute() {
        return Err(SpawnFailure::Drained(invalid_launch(
            "custody executable must be absolute",
        )));
    }
    let program = CString::new(request.program.into_encoded_bytes())
        .map_err(|_| SpawnFailure::Drained(invalid_launch("custody launch contains a nul byte")))?;
    let arguments = request
        .arguments
        .into_iter()
        .map(|argument| {
            CString::new(argument.into_encoded_bytes())
                .map_err(|_| invalid_launch("custody launch contains a nul byte"))
        })
        .collect::<io::Result<Vec<_>>>()
        .map_err(SpawnFailure::Drained)?;
    if !std::path::Path::new(&request.working_directory).is_absolute() {
        return Err(SpawnFailure::Drained(invalid_launch(
            "custody working directory must be absolute",
        )));
    }
    let working_directory = CString::new(request.working_directory.into_encoded_bytes())
        .map_err(|_| SpawnFailure::Drained(invalid_launch("custody launch contains a nul byte")))?;
    let environment =
        exact_environment(request.public_environment).map_err(SpawnFailure::Drained)?;
    let mut argv = Vec::with_capacity(arguments.len() + 2);
    argv.push(program.as_ptr().cast_mut());
    argv.extend(
        arguments
            .iter()
            .map(|argument| argument.as_ptr().cast_mut()),
    );
    argv.push(std::ptr::null_mut());
    let mut envp = environment
        .iter()
        .map(|entry| entry.as_ptr().cast_mut())
        .collect::<Vec<_>>();
    envp.push(std::ptr::null_mut());

    let descriptor_limit =
        super::super::guardian_descriptors::descriptor_limit().map_err(SpawnFailure::Drained)?;
    let (status_read, status_write) = pipe_cloexec().map_err(SpawnFailure::Drained)?;
    let target_pid = unsafe { libc::fork() };
    if target_pid == -1 {
        return Err(SpawnFailure::Drained(io::Error::last_os_error()));
    }
    if target_pid == 0 {
        drop(status_read);
        #[cfg(test)]
        if STALL_BEFORE_TARGET_SETUP.load(Ordering::Relaxed) {
            loop {
                unsafe { libc::pause() };
            }
        }
        let (status_write, execution_source) =
            match super::super::guardian_runtime_descriptors::prepare_target_exec(
                status_write,
                target_stdio,
                target_state_directory,
                private_descriptor,
                execution_source,
                descriptor_limit,
            ) {
                Ok(parts) => parts,
                Err((status, error)) => exit_with_status_error(status, error),
            };
        if unsafe { libc::setpgid(0, 0) } == -1 {
            exit_with_status_error(status_write.as_raw_fd(), io::Error::last_os_error());
        }
        if unsafe { libc::chdir(working_directory.as_ptr()) } == -1 {
            exit_with_status_error(status_write.as_raw_fd(), io::Error::last_os_error());
        }
        match execution_source {
            #[cfg(target_os = "linux")]
            Some(execution_source) => unsafe {
                let empty = c"";
                libc::execveat(
                    execution_source.as_raw_fd(),
                    empty.as_ptr(),
                    argv.as_ptr(),
                    envp.as_ptr(),
                    libc::AT_EMPTY_PATH,
                );
                exit_with_status_error(status_write.as_raw_fd(), io::Error::last_os_error());
            },
            #[cfg(not(target_os = "linux"))]
            Some(_) => exit_with_status_error(
                status_write.as_raw_fd(),
                io::Error::new(
                    io::ErrorKind::Unsupported,
                    "descriptor-native executable launch is unavailable",
                ),
            ),
            None => unsafe {
                libc::execve(
                    program.as_ptr(),
                    argv.as_ptr() as *const *const libc::c_char,
                    envp.as_ptr() as *const *const libc::c_char,
                );
                exit_with_status_error(status_write.as_raw_fd(), io::Error::last_os_error());
            },
        }
    }

    drop(target_stdio);
    drop(target_state_directory);
    drop(private_descriptor);
    drop(status_write);
    #[cfg(test)]
    let setup_deadline = if STALL_BEFORE_TARGET_SETUP.load(Ordering::Relaxed) {
        Instant::now()
    } else {
        deadline
    };
    #[cfg(not(test))]
    let setup_deadline = deadline;
    let result = wait_for_target_group(target_pid, setup_deadline)
        .and_then(|proof| wait_for_exec(status_read.as_raw_fd(), setup_deadline).map(|()| proof));
    match result {
        Ok(proof) => Ok(SpawnedTarget {
            pid: target_pid,
            proof,
        }),
        Err(error) => match reap_unarmed_target(target_pid) {
            Ok(()) => Err(SpawnFailure::Drained(error)),
            Err(cleanup_error) => Err(SpawnFailure::Unresolved(cleanup_error)),
        },
    }
}

fn wait_for_exec(status_read: RawFd, deadline: Instant) -> io::Result<()> {
    wait_ready(status_read, libc::POLLIN, deadline)?;
    let mut error_code = [0_u8; std::mem::size_of::<i32>()];
    let read = unsafe {
        libc::read(
            status_read,
            error_code.as_mut_ptr().cast(),
            error_code.len(),
        )
    };
    if read == 0 {
        return Ok(());
    }
    if read < 0 {
        return Err(io::Error::last_os_error());
    }
    if read as usize != error_code.len() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "target setup status is truncated",
        ));
    }
    Err(io::Error::from_raw_os_error(i32::from_ne_bytes(error_code)))
}

fn exit_with_status_error(status: RawFd, error: io::Error) -> ! {
    let error_code = error.raw_os_error().unwrap_or(libc::EIO).to_ne_bytes();
    let mut written = 0;
    while written < error_code.len() {
        let result = unsafe {
            libc::write(
                status,
                error_code[written..].as_ptr().cast(),
                error_code.len() - written,
            )
        };
        if result > 0 {
            written += result as usize;
            continue;
        }
        if result == -1 && io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
            continue;
        }
        break;
    }
    unsafe { libc::_exit(127) }
}

pub(crate) fn reap_unarmed_target(target_pid: libc::pid_t) -> io::Result<()> {
    let mut status = 0;
    let waited = unsafe { libc::waitpid(target_pid, &mut status, libc::WNOHANG) };
    if waited == target_pid {
        return confirm_unarmed_reap();
    }
    if waited == -1 {
        return Err(io::Error::last_os_error());
    }

    let kill_error = if unsafe { libc::kill(target_pid, libc::SIGKILL) } == -1 {
        let error = io::Error::last_os_error();
        (error.raw_os_error() != Some(libc::ESRCH)).then_some(error)
    } else {
        None
    };
    match wait_for_unarmed_target(target_pid, Instant::now() + cleanup_timeout()) {
        Ok(()) => Ok(()),
        Err(error) => Err(kill_error.unwrap_or(error)),
    }
}

fn wait_for_unarmed_target(target_pid: libc::pid_t, deadline: Instant) -> io::Result<()> {
    loop {
        let mut status = 0;
        let waited = unsafe { libc::waitpid(target_pid, &mut status, libc::WNOHANG) };
        if waited == target_pid {
            return confirm_unarmed_reap();
        }
        if waited == -1 {
            return Err(io::Error::last_os_error());
        }
        if Instant::now() >= deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "unarmed target did not reap before custody deadline",
            ));
        }
        platform::wait_a_moment()?;
    }
}

fn confirm_unarmed_reap() -> io::Result<()> {
    #[cfg(test)]
    if FAIL_CLEANUP_CONFIRMATION.load(Ordering::Relaxed) {
        return Err(io::Error::other(
            "unarmed target cleanup confirmation failed",
        ));
    }
    Ok(())
}

fn wait_for_target_group(
    target_pid: libc::pid_t,
    deadline: Instant,
) -> io::Result<platform::ProcessProof> {
    loop {
        let proof = platform::prove_process(target_pid)?;
        let group = unsafe { libc::getpgid(target_pid) };
        let session = unsafe { libc::getsid(target_pid) };
        if group == target_pid && session == unsafe { libc::getpid() } {
            return Ok(proof);
        }
        if group == -1 || session == -1 {
            return Err(io::Error::last_os_error());
        }
        if Instant::now() >= deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "target did not establish its custody group",
            ));
        }
        platform::wait_a_moment()?;
    }
}

fn exact_environment(
    environment: Vec<(std::ffi::OsString, std::ffi::OsString)>,
) -> io::Result<Vec<CString>> {
    environment
        .into_iter()
        .map(|(key, value)| {
            let mut entry = key.into_encoded_bytes();
            entry.push(b'=');
            entry.extend(value.into_encoded_bytes());
            CString::new(entry).map_err(|_| invalid_launch("custody launch contains a nul byte"))
        })
        .collect()
}

fn invalid_launch(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}
