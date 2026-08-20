use std::io;
use std::os::fd::{AsRawFd, OwnedFd, RawFd};
use std::time::{Duration, Instant};

use self::lifecycle::{RootLifecycle, drain, terminate, terminate_after_guardian_loss};
use super::guardian_protocol::{encode_armed_payload, encode_exit_status_payload};
use super::io::{read_frame, write_frame};
use super::platform;
use super::protocol::{Frame, Message};
use super::scope::{ScopeIdentity, SessionAnchor, verify_live_scope};

#[path = "sentinel_launch.rs"]
pub(super) mod launch;
#[path = "sentinel_lifecycle.rs"]
mod lifecycle;

const SENTINEL_TIMEOUT: Duration = Duration::from_secs(5);

pub(super) fn spawn(
    guardian_liveness: OwnedFd,
    control: OwnedFd,
    target_stdio: [OwnedFd; 3],
    target_state_directory: Option<OwnedFd>,
    private_descriptor: Option<OwnedFd>,
    execution_source: Option<OwnedFd>,
) -> io::Result<libc::pid_t> {
    let descriptor_limit = super::guardian_descriptors::descriptor_limit()?;
    let sentinel_pid = unsafe { libc::fork() };
    if sentinel_pid == -1 {
        return Err(io::Error::last_os_error());
    }
    if sentinel_pid == 0 {
        let (
            guardian_liveness,
            control,
            target_stdio,
            target_state_directory,
            private_descriptor,
            execution_source,
        ) = match super::guardian_runtime_descriptors::isolate_sentinel(
            guardian_liveness,
            control,
            target_stdio,
            target_state_directory,
            private_descriptor,
            execution_source,
            descriptor_limit,
        ) {
            Ok(descriptors) => descriptors,
            Err(_) => unsafe { libc::_exit(127) },
        };
        if unsafe { libc::setsid() } == -1 {
            unsafe { libc::_exit(127) }
        }
        run(
            guardian_liveness,
            control,
            target_stdio,
            target_state_directory,
            private_descriptor,
            execution_source,
        );
    }
    drop(target_stdio);
    drop(target_state_directory);
    drop(private_descriptor);
    drop(execution_source);
    Ok(sentinel_pid)
}

fn run(
    guardian_liveness: OwnedFd,
    control: OwnedFd,
    target_stdio: [OwnedFd; 3],
    target_state_directory: Option<OwnedFd>,
    private_descriptor: Option<OwnedFd>,
    execution_source: Option<OwnedFd>,
) -> ! {
    let launch_request = match read_control_or_guardian_loss(
        guardian_liveness.as_raw_fd(),
        control.as_raw_fd(),
        Some(Instant::now() + SENTINEL_TIMEOUT),
    ) {
        Ok(ControlEvent::Frame(frame)) if frame.message == Message::Launch => frame,
        _ => exit_unarmed(),
    };
    let sentinel_proof = match platform::prove_process(unsafe { libc::getpid() }) {
        Ok(proof) => proof,
        Err(_) => reply_authority_lost(control.as_raw_fd(), &launch_request),
    };
    let target = match launch::spawn_target(
        &launch_request.payload,
        target_stdio,
        target_state_directory,
        private_descriptor,
        execution_source,
    ) {
        Ok(target) => target,
        Err(launch::SpawnFailure::Drained(error)) => {
            drop(error);
            reply_launch_failed(control.as_raw_fd(), &launch_request)
        }
        Err(launch::SpawnFailure::Unresolved(error)) => {
            drop(error);
            reply_authority_lost(control.as_raw_fd(), &launch_request)
        }
    };
    let scope = ScopeIdentity::new(SessionAnchor::new(sentinel_proof), target.proof);
    let mut root = RootLifecycle::Running;
    if verify_live_scope(scope).is_err() {
        exit_authority_lost(control.as_raw_fd(), &launch_request);
    }
    let armed_payload = match encode_armed_payload(target.pid, target.proof.creation_marker()) {
        Ok(payload) => payload,
        Err(_) => reject_and_cleanup(control.as_raw_fd(), &launch_request, scope, &mut root),
    };
    if reply(
        control.as_raw_fd(),
        Message::Armed,
        &launch_request,
        armed_payload,
    )
    .is_err()
    {
        terminate_after_guardian_loss(scope, &mut root);
    }

    serve_commands(guardian_liveness, control, scope, root)
}

fn serve_commands(
    guardian_liveness: OwnedFd,
    control: OwnedFd,
    scope: ScopeIdentity,
    mut root: RootLifecycle,
) -> ! {
    loop {
        let command = match read_control_or_guardian_loss(
            guardian_liveness.as_raw_fd(),
            control.as_raw_fd(),
            None,
        ) {
            Ok(ControlEvent::Frame(frame)) => frame,
            Ok(ControlEvent::GuardianLost) | Err(_) => {
                terminate_after_guardian_loss(scope, &mut root)
            }
        };
        if matches!(root, RootLifecycle::Reaped(_)) {
            if command.message != Message::Disarm {
                exit_authority_lost(control.as_raw_fd(), &command);
            }
            let _ = reply(control.as_raw_fd(), Message::Disarm, &command, Vec::new());
            unsafe { libc::_exit(0) }
        }
        match command.message {
            Message::Drain => {
                let response = match drain(scope, &mut root) {
                    Ok(Some(status)) => (Message::Drained, encode_exit_status_payload(status)),
                    Ok(None) => (Message::Pending, Vec::new()),
                    Err(_) => exit_authority_lost(control.as_raw_fd(), &command),
                };
                if reply(control.as_raw_fd(), response.0, &command, response.1).is_err() {
                    terminate_after_guardian_loss(scope, &mut root);
                }
            }
            Message::Terminate => {
                if terminate(scope, &mut root).is_err() {
                    exit_authority_lost(control.as_raw_fd(), &command);
                }
                let _ = reply(
                    control.as_raw_fd(),
                    Message::Terminate,
                    &command,
                    Vec::new(),
                );
                unsafe { libc::_exit(0) }
            }
            Message::Disarm => reject_and_cleanup(control.as_raw_fd(), &command, scope, &mut root),
            _ => reject_and_cleanup(control.as_raw_fd(), &command, scope, &mut root),
        }
    }
}

fn reply(control: RawFd, message: Message, request: &Frame, payload: Vec<u8>) -> io::Result<()> {
    let response = Frame::new(message, request.nonce, request.request_id, payload)?;
    write_frame(control, &response, Instant::now() + SENTINEL_TIMEOUT)
}

fn reply_launch_failed(control: RawFd, request: &Frame) -> ! {
    let _ = reply(control, Message::LaunchFailed, request, Vec::new());
    exit_unarmed()
}

fn reply_authority_lost(control: RawFd, request: &Frame) -> ! {
    let _ = reply(control, Message::AuthorityLost, request, Vec::new());
    exit_unarmed()
}

pub(super) fn exit_authority_lost(control: RawFd, request: &Frame) -> ! {
    let _ = reply(control, Message::AuthorityLost, request, Vec::new());
    unsafe { libc::_exit(0) }
}

fn reject_and_cleanup(
    control: RawFd,
    request: &Frame,
    scope: ScopeIdentity,
    root: &mut RootLifecycle,
) -> ! {
    let _ = reply(control, Message::AuthorityLost, request, Vec::new());
    terminate_after_guardian_loss(scope, root)
}

enum ControlEvent {
    Frame(Frame),
    GuardianLost,
}

fn read_control_or_guardian_loss(
    guardian_liveness: RawFd,
    control: RawFd,
    deadline: Option<Instant>,
) -> io::Result<ControlEvent> {
    loop {
        let timeout = match deadline {
            Some(deadline) => deadline
                .checked_duration_since(Instant::now())
                .map(|remaining| remaining.as_millis().max(1).min(i32::MAX as u128) as i32)
                .ok_or_else(super::io::timeout)?,
            None => -1,
        };
        let mut descriptors = [
            libc::pollfd {
                fd: guardian_liveness,
                events: libc::POLLIN | libc::POLLHUP,
                revents: 0,
            },
            libc::pollfd {
                fd: control,
                events: libc::POLLIN | libc::POLLHUP,
                revents: 0,
            },
        ];
        let ready = unsafe { libc::poll(descriptors.as_mut_ptr(), 2, timeout) };
        if ready == 0 {
            return Err(super::io::timeout());
        }
        if ready < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        if descriptors[0].revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR) != 0 {
            return Ok(ControlEvent::GuardianLost);
        }
        if descriptors[1].revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR) != 0 {
            return read_frame(
                control,
                deadline.unwrap_or_else(|| Instant::now() + SENTINEL_TIMEOUT),
            )
            .map(ControlEvent::Frame);
        }
    }
}

fn exit_unarmed() -> ! {
    unsafe { libc::_exit(127) }
}
