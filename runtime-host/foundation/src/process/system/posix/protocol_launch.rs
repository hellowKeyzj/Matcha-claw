use std::ffi::{OsStr, OsString};
use std::io;
use std::os::unix::ffi::OsStrExt;

use super::super::protocol::invalid_frame;
use crate::process::launch::posix::encoded_launch_payload_size;

pub(in super::super) fn encode_launch_payload(
    program: &OsStr,
    working_directory: &std::path::Path,
    arguments: &[OsString],
    public_environment: &[(OsString, OsString)],
) -> io::Result<Vec<u8>> {
    let payload_size =
        encoded_launch_payload_size(program, working_directory, arguments, public_environment)
            .map_err(|_| invalid_frame("custody launch input was not validated"))?;
    let argument_count = arguments
        .len()
        .checked_add(1)
        .expect("validated launch argument count");
    let mut payload = Vec::new();
    payload
        .try_reserve_exact(payload_size)
        .map_err(|_| io::Error::other("custody launch payload allocation failed"))?;
    payload.extend_from_slice(&(argument_count as u16).to_be_bytes());
    append_value(&mut payload, program, true)?;
    for argument in arguments {
        append_value(&mut payload, argument, false)?;
    }
    append_value(&mut payload, working_directory.as_os_str(), true)?;
    payload.extend_from_slice(&(public_environment.len() as u16).to_be_bytes());
    for (index, (key, value)) in public_environment.iter().enumerate() {
        validate_environment_key(key)?;
        if public_environment[..index]
            .iter()
            .any(|(observed, _)| observed == key)
        {
            return Err(invalid_frame(
                "custody launch environment key is duplicated",
            ));
        }
        append_value(&mut payload, key, false)?;
        append_value(&mut payload, value, false)?;
    }
    debug_assert_eq!(payload.len(), payload_size);
    Ok(payload)
}

fn append_value(payload: &mut Vec<u8>, value: &OsStr, required: bool) -> io::Result<()> {
    let bytes = value.as_bytes();
    if (required && bytes.is_empty()) || bytes.contains(&0) {
        return Err(invalid_frame("custody launch value is invalid"));
    }
    payload.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    payload.extend_from_slice(bytes);
    Ok(())
}

fn validate_environment_key(key: &OsStr) -> io::Result<()> {
    let bytes = key.as_bytes();
    if bytes.is_empty() || bytes.contains(&0) || bytes.contains(&b'=') {
        return Err(invalid_frame("custody environment key is invalid"));
    }
    Ok(())
}
