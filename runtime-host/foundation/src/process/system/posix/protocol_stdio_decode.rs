use std::io;

use super::super::protocol::{STDIO_MODE_BYTES, STDIO_NULL, STDIO_PIPED, invalid_frame};

pub(in super::super) fn validate_stdio_spec(payload: &[u8]) -> io::Result<()> {
    let modes: [u8; STDIO_MODE_BYTES] = payload
        .try_into()
        .map_err(|_| invalid_frame("custody stdio mode payload shape is invalid"))?;
    if modes
        .into_iter()
        .all(|mode| matches!(mode, STDIO_NULL | STDIO_PIPED))
    {
        Ok(())
    } else {
        Err(invalid_frame("custody stdio mode is invalid"))
    }
}
