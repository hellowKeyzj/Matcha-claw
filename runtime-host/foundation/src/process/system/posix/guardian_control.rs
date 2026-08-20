use std::io;
use std::time::{Duration, Instant};

use super::super::guardian_protocol::decode_armed_payload;
use super::super::guardian_timeout::cleanup_timeout;
use super::super::io::{read_frame, write_frame};
use super::super::platform;
use super::super::protocol::{Frame, Message};
use super::super::scope::{ScopeIdentity, SessionAnchor, verify_live_scope};

const OBSERVATION_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum Settlement {
    Reply(Message, u64, Vec<u8>),
    HostLostUnarmed,
    HostLostWithTarget,
}

#[derive(Clone, Copy)]
enum Target {
    Active(ScopeIdentity),
    Drained,
}

enum LaunchResult {
    Armed(Target),
    Failed,
}

enum SentinelLaunchResponse {
    Armed {
        target_pid: libc::pid_t,
        creation_marker: u128,
    },
    Failed,
    AuthorityLost,
}

pub(super) fn serve(
    host_input: i32,
    host_output: i32,
    sentinel_control: i32,
    sentinel_pid: libc::pid_t,
    hello: &Frame,
) -> io::Result<Settlement> {
    let session_anchor = wait_for_session_anchor(sentinel_pid)?;
    reply(
        host_output,
        Message::Ready,
        hello.nonce,
        hello.request_id,
        Vec::new(),
    )?;

    let mut target: Option<Target> = None;
    loop {
        if let Some(Target::Active(scope)) = target
            && verify_live_scope(scope).is_err()
        {
            return Ok(authority_lost(hello.request_id));
        }
        let command = match read_host_command(host_input, OBSERVATION_INTERVAL) {
            Ok(Some(frame)) => frame,
            Ok(None) => continue,
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => {
                return Ok(match target {
                    Some(_) => Settlement::HostLostWithTarget,
                    None => Settlement::HostLostUnarmed,
                });
            }
            Err(_) => return Ok(authority_lost(hello.request_id)),
        };
        if command.nonce != hello.nonce {
            return Ok(authority_lost(command.request_id));
        }

        match (command.message, target) {
            (Message::Launch, None) => {
                match launch(host_output, sentinel_control, session_anchor, &command) {
                    Ok(LaunchResult::Armed(launched)) => target = Some(launched),
                    Ok(LaunchResult::Failed) => return Ok(launch_failed(command.request_id)),
                    Err(_) => return Ok(authority_lost(command.request_id)),
                }
            }
            (Message::Terminate, Some(Target::Active(_))) => {
                if terminate(sentinel_control, &command).is_err() {
                    return Ok(authority_lost(command.request_id));
                }
                return Ok(Settlement::Reply(
                    Message::Terminate,
                    command.request_id,
                    Vec::new(),
                ));
            }
            (Message::Drain, Some(Target::Active(_))) => {
                let response = match drain(sentinel_control, &command) {
                    Ok(response) => response,
                    Err(_) => return Ok(authority_lost(command.request_id)),
                };
                if response.message == Message::Drained {
                    target = Some(Target::Drained);
                }
                reply(
                    host_output,
                    response.message,
                    hello.nonce,
                    command.request_id,
                    response.payload,
                )?;
            }
            (Message::Disarm, Some(Target::Drained)) => {
                if disarm(sentinel_control, &command).is_err() {
                    return Ok(authority_lost(command.request_id));
                }
                return Ok(Settlement::Reply(
                    Message::Disarm,
                    command.request_id,
                    Vec::new(),
                ));
            }
            (Message::Disarm, Some(Target::Active(_))) => {
                let _ = disarm(sentinel_control, &command);
                return Ok(authority_lost(command.request_id));
            }
            _ => return Ok(authority_lost(command.request_id)),
        }
    }
}

pub(super) fn reply(
    control: i32,
    message: Message,
    nonce: [u8; 16],
    request_id: u64,
    payload: Vec<u8>,
) -> io::Result<()> {
    let response = Frame::new(message, nonce, request_id, payload)?;
    write_frame(control, &response, Instant::now() + cleanup_timeout())
}

fn wait_for_session_anchor(sentinel_pid: libc::pid_t) -> io::Result<SessionAnchor> {
    let deadline = Instant::now() + cleanup_timeout();
    loop {
        let anchor = SessionAnchor::new(platform::prove_process(sentinel_pid)?);
        match anchor.verify() {
            Ok(()) => return Ok(anchor),
            Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {}
            Err(error) => return Err(error),
        }
        if Instant::now() >= deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "sentinel did not establish its custody session",
            ));
        }
        platform::wait_a_moment()?;
    }
}

fn read_host_command(control: i32, timeout: Duration) -> io::Result<Option<Frame>> {
    let mut descriptor = libc::pollfd {
        fd: control,
        events: libc::POLLIN | libc::POLLHUP,
        revents: 0,
    };
    loop {
        let ready = unsafe { libc::poll(&mut descriptor, 1, timeout.as_millis() as i32) };
        if ready == 0 {
            return Ok(None);
        }
        if ready > 0 {
            break;
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
    if descriptor.revents & (libc::POLLHUP | libc::POLLERR | libc::POLLNVAL) != 0 {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "host control closed",
        ));
    }
    if descriptor.revents & libc::POLLIN != 0 {
        return read_frame(control, Instant::now() + cleanup_timeout()).map(Some);
    }
    Ok(None)
}

fn launch(
    host_output: i32,
    sentinel_control: i32,
    session_anchor: SessionAnchor,
    command: &Frame,
) -> io::Result<LaunchResult> {
    session_anchor.verify()?;
    let request = Frame::new(
        Message::Launch,
        command.nonce,
        command.request_id,
        command.payload.clone(),
    )?;
    write_frame(
        sentinel_control,
        &request,
        Instant::now() + cleanup_timeout(),
    )?;
    let response = read_frame(sentinel_control, Instant::now() + cleanup_timeout())?;
    match validate_sentinel_launch_response(&response, command)? {
        SentinelLaunchResponse::Armed {
            target_pid,
            creation_marker,
        } => {
            let root = platform::prove_process(target_pid)?;
            let target_scope = ScopeIdentity::new(session_anchor, root);
            if root.creation_marker() != creation_marker || verify_live_scope(target_scope).is_err()
            {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "target left authority scope",
                ));
            }
            reply(
                host_output,
                Message::Armed,
                command.nonce,
                command.request_id,
                response.payload,
            )?;
            Ok(LaunchResult::Armed(Target::Active(target_scope)))
        }
        SentinelLaunchResponse::Failed => Ok(LaunchResult::Failed),
        SentinelLaunchResponse::AuthorityLost => Err(launch_proof_failed()),
    }
}

fn validate_sentinel_launch_response(
    response: &Frame,
    command: &Frame,
) -> io::Result<SentinelLaunchResponse> {
    if response.nonce != command.nonce || response.request_id != command.request_id {
        return Err(launch_proof_failed());
    }
    match response.message {
        Message::Armed => {
            let (target_pid, creation_marker) = decode_armed_payload(&response.payload)?;
            Ok(SentinelLaunchResponse::Armed {
                target_pid,
                creation_marker,
            })
        }
        Message::LaunchFailed if response.payload.is_empty() => Ok(SentinelLaunchResponse::Failed),
        Message::AuthorityLost if response.payload.is_empty() => {
            Ok(SentinelLaunchResponse::AuthorityLost)
        }
        _ => Err(launch_proof_failed()),
    }
}

fn launch_proof_failed() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "sentinel launch proof failed",
    )
}

fn drain(sentinel_control: i32, command: &Frame) -> io::Result<Frame> {
    let request = Frame::new(
        Message::Drain,
        command.nonce,
        command.request_id,
        Vec::new(),
    )?;
    write_frame(
        sentinel_control,
        &request,
        Instant::now() + cleanup_timeout(),
    )?;
    let response = read_frame(sentinel_control, Instant::now() + cleanup_timeout())?;
    if !matches!(response.message, Message::Pending | Message::Drained)
        || response.nonce != command.nonce
        || response.request_id != command.request_id
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "sentinel drain proof failed",
        ));
    }
    Ok(response)
}

fn disarm(sentinel_control: i32, command: &Frame) -> io::Result<()> {
    exchange_terminal(sentinel_control, command, Message::Disarm)
}

fn terminate(sentinel_control: i32, command: &Frame) -> io::Result<()> {
    exchange_terminal(sentinel_control, command, Message::Terminate)
}

fn exchange_terminal(sentinel_control: i32, command: &Frame, message: Message) -> io::Result<()> {
    let request = Frame::new(message, command.nonce, command.request_id, Vec::new())?;
    write_frame(
        sentinel_control,
        &request,
        Instant::now() + cleanup_timeout(),
    )?;
    let response = read_frame(sentinel_control, Instant::now() + cleanup_timeout())?;
    if response.message != message
        || response.nonce != command.nonce
        || response.request_id != command.request_id
        || !response.payload.is_empty()
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "sentinel terminal proof failed",
        ));
    }
    Ok(())
}

const fn launch_failed(request_id: u64) -> Settlement {
    Settlement::Reply(Message::LaunchFailed, request_id, Vec::new())
}

const fn authority_lost(request_id: u64) -> Settlement {
    Settlement::Reply(Message::AuthorityLost, request_id, Vec::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    const NONCE: [u8; 16] = [7; 16];

    #[test]
    fn launch_failed_response_requires_empty_correlated_proof() {
        let command = launch_command();
        let valid = Frame::new(Message::LaunchFailed, NONCE, 42, Vec::new()).unwrap();
        assert!(matches!(
            validate_sentinel_launch_response(&valid, &command),
            Ok(SentinelLaunchResponse::Failed)
        ));

        for response in [
            Frame {
                message: Message::LaunchFailed,
                nonce: NONCE,
                request_id: 42,
                payload: vec![1],
            },
            Frame::new(Message::LaunchFailed, [8; 16], 42, Vec::new()).unwrap(),
            Frame::new(Message::LaunchFailed, NONCE, 43, Vec::new()).unwrap(),
        ] {
            assert!(validate_sentinel_launch_response(&response, &command).is_err());
        }
    }

    fn launch_command() -> Frame {
        Frame {
            message: Message::Launch,
            nonce: NONCE,
            request_id: 42,
            payload: Vec::new(),
        }
    }
}
