use std::ffi::OsString;
use std::io;
use std::os::unix::ffi::{OsStrExt, OsStringExt};

use super::super::protocol::{LAUNCH_COUNT_BYTES, LAUNCH_VALUE_LENGTH_BYTES, invalid_frame};
use crate::process::launch::posix_limits::{MAX_ARGUMENTS, MAX_PUBLIC_ENVIRONMENT_VARIABLES};

pub(in super::super) struct LaunchPayload {
    pub(in super::super) program: OsString,
    pub(in super::super) working_directory: OsString,
    pub(in super::super) arguments: Vec<OsString>,
    pub(in super::super) public_environment: Vec<(OsString, OsString)>,
}

pub(in super::super) fn decode_launch_payload(payload: &[u8]) -> io::Result<LaunchPayload> {
    let mut decoder = LaunchDecoder::new(payload);
    let count = decoder.read_u16()? as usize;
    if count == 0 || count > MAX_ARGUMENTS {
        return Err(invalid_frame("custody launch argument count is invalid"));
    }
    let mut values = Vec::with_capacity(count);
    for index in 0..count {
        values.push(decoder.read_value(index == 0)?);
    }
    let working_directory = decoder.read_value(true)?;
    let public_environment_count = decoder.read_u16()? as usize;
    if public_environment_count > MAX_PUBLIC_ENVIRONMENT_VARIABLES {
        return Err(invalid_frame(
            "custody launch environment override count is invalid",
        ));
    }
    let mut public_environment = Vec::with_capacity(public_environment_count);
    for _ in 0..public_environment_count {
        let key = decoder.read_value(false)?;
        validate_environment_key(&key)?;
        if public_environment
            .iter()
            .any(|(observed, _)| observed == &key)
        {
            return Err(invalid_frame(
                "custody launch environment key is duplicated",
            ));
        }
        let value = decoder.read_value(false)?;
        public_environment.push((key, value));
    }
    decoder.finish()?;

    let program = values.remove(0);
    Ok(LaunchPayload {
        program,
        working_directory,
        arguments: values,
        public_environment,
    })
}

fn validate_environment_key(key: &OsString) -> io::Result<()> {
    let bytes = key.as_os_str().as_bytes();
    if bytes.is_empty() || bytes.contains(&0) || bytes.contains(&b'=') {
        return Err(invalid_frame("custody environment key is invalid"));
    }
    Ok(())
}

struct LaunchDecoder<'a> {
    payload: &'a [u8],
    offset: usize,
}

impl<'a> LaunchDecoder<'a> {
    const fn new(payload: &'a [u8]) -> Self {
        Self { payload, offset: 0 }
    }

    fn read_u16(&mut self) -> io::Result<u16> {
        let bytes = self.read_bytes(LAUNCH_COUNT_BYTES)?;
        Ok(u16::from_be_bytes(bytes.try_into().expect("u16 width")))
    }

    fn read_value(&mut self, required: bool) -> io::Result<OsString> {
        let length = u32::from_be_bytes(
            self.read_bytes(LAUNCH_VALUE_LENGTH_BYTES)?
                .try_into()
                .expect("value length width"),
        ) as usize;
        let value = self.read_bytes(length)?;
        if (required && value.is_empty()) || value.contains(&0) {
            return Err(invalid_frame("custody launch value is invalid"));
        }
        Ok(OsString::from_vec(value.to_vec()))
    }

    fn read_bytes(&mut self, length: usize) -> io::Result<&'a [u8]> {
        let end = self
            .offset
            .checked_add(length)
            .ok_or_else(|| invalid_frame("custody launch payload overflows"))?;
        let value = self
            .payload
            .get(self.offset..end)
            .ok_or_else(|| invalid_frame("custody launch payload is truncated"))?;
        self.offset = end;
        Ok(value)
    }

    fn finish(self) -> io::Result<()> {
        if self.offset == self.payload.len() {
            Ok(())
        } else {
            Err(invalid_frame("custody launch has trailing bytes"))
        }
    }
}
