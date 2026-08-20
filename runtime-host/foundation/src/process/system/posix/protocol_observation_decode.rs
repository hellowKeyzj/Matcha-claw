use std::io;

use super::protocol::{CREATION_MARKER_BYTES, PID_BYTES, invalid_frame};

pub(super) fn decode_armed_payload(payload: &[u8]) -> io::Result<(libc::pid_t, u128)> {
    let (pid, marker) = payload
        .split_at_checked(PID_BYTES)
        .ok_or_else(|| invalid_frame("custody armed payload shape is invalid"))?;
    if marker.len() != CREATION_MARKER_BYTES {
        return Err(invalid_frame("custody armed payload shape is invalid"));
    }
    let target_pid = libc::pid_t::from_be_bytes(pid.try_into().expect("pid width"));
    if target_pid <= 0 {
        return Err(invalid_frame("custody target pid is invalid"));
    }
    Ok((
        target_pid,
        u128::from_be_bytes(marker.try_into().expect("creation marker width")),
    ))
}
