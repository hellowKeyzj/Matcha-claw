use std::io;

use super::super::protocol::{CREATION_MARKER_BYTES, PID_BYTES, invalid_frame};

pub(in super::super) fn encode_armed_payload(
    target_pid: libc::pid_t,
    creation_marker: u128,
) -> io::Result<Vec<u8>> {
    if target_pid <= 0 {
        return Err(invalid_frame("custody target pid is invalid"));
    }
    let mut payload = Vec::with_capacity(PID_BYTES + CREATION_MARKER_BYTES);
    payload.extend_from_slice(&target_pid.to_be_bytes());
    payload.extend_from_slice(&creation_marker.to_be_bytes());
    Ok(payload)
}

pub(in super::super) fn encode_exit_status_payload(status: i32) -> Vec<u8> {
    status.to_be_bytes().to_vec()
}
