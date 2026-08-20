use std::ffi::OsString;
use std::io;
use std::os::fd::{AsRawFd, OwnedFd};
use std::time::Instant;

use self::control::{Settlement, reply, serve};
use super::guardian_cleanup_runtime;
use super::guardian_io::socket_pair_cloexec;
use super::guardian_protocol::validate_stdio_spec;
use super::guardian_timeout::cleanup_timeout;
use super::io::{pipe_cloexec, read_frame};
use super::platform;
use super::protocol::{Frame, Message};
use super::scope::reap_sentinel_until;
use super::sentinel;

#[path = "guardian_control.rs"]
mod control;

pub(super) fn run(
    host_input: OwnedFd,
    host_output: OwnedFd,
    target_stdio: [OwnedFd; 3],
    target_state_directory: Option<OwnedFd>,
    private_descriptor: Option<OwnedFd>,
    execution_source: Option<OwnedFd>,
    cleanup_directory: Option<OwnedFd>,
    cleanup_names: Vec<OsString>,
) -> io::Result<()> {
    acquire_cleanup_lease(cleanup_directory.as_ref())?;
    let hello = match read_hello(host_input.as_raw_fd()) {
        Ok(hello) => hello,
        Err(error) => {
            cleanup_after_host_loss(cleanup_directory.as_ref(), &cleanup_names)?;
            return Err(error);
        }
    };
    if let Err(error) = validate_stdio_spec(&hello.payload) {
        cleanup_after_host_loss(cleanup_directory.as_ref(), &cleanup_names)?;
        return Err(error);
    }
    let (sentinel_liveness, guardian_liveness) = match pipe_cloexec() {
        Ok(descriptors) => descriptors,
        Err(error) => {
            cleanup_after_host_loss(cleanup_directory.as_ref(), &cleanup_names)?;
            return Err(error);
        }
    };
    let (guardian_control, sentinel_control) = match socket_pair_cloexec() {
        Ok(descriptors) => descriptors,
        Err(error) => {
            cleanup_after_host_loss(cleanup_directory.as_ref(), &cleanup_names)?;
            return Err(error);
        }
    };
    let sentinel_pid = match sentinel::spawn(
        sentinel_liveness,
        sentinel_control,
        target_stdio,
        target_state_directory,
        private_descriptor,
        execution_source,
    ) {
        Ok(sentinel_pid) => sentinel_pid,
        Err(error) => {
            cleanup_after_host_loss(cleanup_directory.as_ref(), &cleanup_names)?;
            return Err(error);
        }
    };
    let settlement = serve(
        host_input.as_raw_fd(),
        host_output.as_raw_fd(),
        guardian_control.as_raw_fd(),
        sentinel_pid,
        &hello,
    );

    drop(guardian_liveness);
    let sentinel_status = match reap_owned_sentinel(sentinel_pid) {
        Ok(status) => status,
        Err(_) => hold_cleanup_lease(),
    };
    if validate_sentinel_exit(settlement.as_ref().ok(), sentinel_status).is_err() {
        hold_cleanup_lease();
    }

    match settlement {
        Ok(Settlement::Reply(message, request_id, _)) => settle_cleanup(
            host_input.as_raw_fd(),
            host_output.as_raw_fd(),
            hello.nonce,
            message,
            request_id,
            cleanup_directory.as_ref(),
            &cleanup_names,
        ),
        Ok(Settlement::HostLostUnarmed | Settlement::HostLostWithTarget) | Err(_) => {
            cleanup_after_host_loss(cleanup_directory.as_ref(), &cleanup_names)
        }
    }
}

fn read_hello(host_input: i32) -> io::Result<Frame> {
    let hello = read_frame(host_input, Instant::now() + cleanup_timeout())?;
    if hello.message != Message::Hello {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "guardian expected hello",
        ));
    }
    Ok(hello)
}

fn settle_cleanup(
    host_input: i32,
    host_output: i32,
    nonce: [u8; 16],
    mut message: Message,
    mut request_id: u64,
    cleanup_directory: Option<&OwnedFd>,
    cleanup_names: &[OsString],
) -> io::Result<()> {
    loop {
        match guardian_cleanup_runtime::remove_names(cleanup_directory, cleanup_names) {
            Ok(()) => return reply(host_output, message, nonce, request_id, Vec::new()),
            Err(_) => {
                if reply(
                    host_output,
                    Message::CleanupUnconfirmed,
                    nonce,
                    request_id,
                    Vec::new(),
                )
                .is_err()
                {
                    return cleanup_after_host_loss(cleanup_directory, cleanup_names);
                }
            }
        }
        let command = match read_frame(host_input, Instant::now() + cleanup_timeout()) {
            Ok(command) if command.nonce == nonce && is_terminal(command.message) => command,
            Ok(_) => continue,
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => {
                return cleanup_after_host_loss(cleanup_directory, cleanup_names);
            }
            Err(_) => continue,
        };
        message = command.message;
        request_id = command.request_id;
    }
}

fn acquire_cleanup_lease(directory: Option<&OwnedFd>) -> io::Result<()> {
    loop {
        match guardian_cleanup_runtime::acquire_lease(directory) {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => platform::wait_a_moment()?,
            Err(error) => return Err(error),
        }
    }
}

fn cleanup_after_host_loss(
    cleanup_directory: Option<&OwnedFd>,
    cleanup_names: &[OsString],
) -> io::Result<()> {
    loop {
        if guardian_cleanup_runtime::remove_names(cleanup_directory, cleanup_names).is_ok() {
            return Ok(());
        }
        platform::wait_a_moment()?;
    }
}

fn hold_cleanup_lease() -> ! {
    loop {
        let _ = platform::wait_a_moment();
    }
}

const fn is_terminal(message: Message) -> bool {
    matches!(message, Message::Terminate | Message::Disarm)
}

fn reap_owned_sentinel(sentinel_pid: libc::pid_t) -> io::Result<i32> {
    loop {
        match reap_sentinel_until(sentinel_pid, Instant::now() + cleanup_timeout()) {
            Ok(status) => return Ok(status),
            Err(error) if error.kind() == io::ErrorKind::TimedOut => platform::wait_a_moment()?,
            Err(error) => return Err(error),
        }
    }
}

fn validate_sentinel_exit(settlement: Option<&Settlement>, status: i32) -> io::Result<()> {
    if !libc::WIFEXITED(status) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "sentinel did not exit normally",
        ));
    }
    let requires_success = matches!(
        settlement,
        Some(
            Settlement::Reply(Message::Terminate | Message::Disarm, _, _)
                | Settlement::HostLostWithTarget
        )
    );
    if requires_success && libc::WEXITSTATUS(status) != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "sentinel did not complete custody settlement",
        ));
    }
    Ok(())
}
