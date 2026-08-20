use std::io;

use crate::process::launch::posix_limits::MAX_FRAME_BYTES;

#[path = "protocol_frame.rs"]
mod frame;

pub(super) use frame::{Frame, HEADER_BYTES, Message};

pub(super) const LAUNCH_COUNT_BYTES: usize = size_of::<u16>();
pub(super) const LAUNCH_VALUE_LENGTH_BYTES: usize = size_of::<u32>();
pub(super) const STDIO_MODE_BYTES: usize = 3;
pub(super) const STDIO_NULL: u8 = 0;
pub(super) const STDIO_PIPED: u8 = 1;
pub(super) const PID_BYTES: usize = size_of::<i32>();
pub(super) const CREATION_MARKER_BYTES: usize = size_of::<u128>();
pub(super) const EXIT_STATUS_BYTES: usize = size_of::<i32>();

const MINIMUM_LAUNCH_PAYLOAD_BYTES: usize =
    2 * LAUNCH_COUNT_BYTES + 2 * LAUNCH_VALUE_LENGTH_BYTES + 1;

fn validate_payload(message: Message, payload: &[u8]) -> io::Result<()> {
    let valid = match message {
        Message::Ready
        | Message::Terminate
        | Message::Disarm
        | Message::AuthorityLost
        | Message::LaunchFailed
        | Message::Drain
        | Message::Pending
        | Message::CleanupUnconfirmed => payload.is_empty(),
        Message::Hello => payload.len() == STDIO_MODE_BYTES,
        Message::Launch => payload.len() >= MINIMUM_LAUNCH_PAYLOAD_BYTES,
        Message::Armed => payload.len() == PID_BYTES + CREATION_MARKER_BYTES,
        Message::Drained => payload.len() == EXIT_STATUS_BYTES,
    };
    if valid {
        Ok(())
    } else {
        Err(invalid_frame("custody control payload shape is invalid"))
    }
}

pub(super) fn invalid_frame(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
