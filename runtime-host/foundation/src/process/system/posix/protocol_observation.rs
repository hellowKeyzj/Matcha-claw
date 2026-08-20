use std::io;

use super::super::protocol::{EXIT_STATUS_BYTES, invalid_frame};

pub(in super::super) fn decode_exit_status_payload(
    payload: &[u8],
) -> io::Result<(Option<i32>, Option<i32>)> {
    if payload.len() != EXIT_STATUS_BYTES {
        return Err(invalid_frame("custody exit payload shape is invalid"));
    }
    let status = i32::from_be_bytes(payload.try_into().expect("exit status width"));
    if libc::WIFEXITED(status) {
        return Ok((Some(libc::WEXITSTATUS(status)), None));
    }
    if libc::WIFSIGNALED(status) {
        return Ok((None, Some(libc::WTERMSIG(status))));
    }
    Err(invalid_frame(
        "custody exit payload is not a terminal status",
    ))
}
