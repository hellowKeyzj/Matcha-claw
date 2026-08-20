use std::ffi::OsString;
use std::io::{self, Read};
use std::os::fd::OwnedFd;
use std::os::unix::ffi::OsStringExt;

use crate::guardian_cleanup_runtime::validate_name;

const MAX_CLEANUP_NAMES: usize = 32;
const MAX_CLEANUP_NAME_BYTES: usize = 255;
const COUNT_BYTES: usize = size_of::<u16>();
const LENGTH_BYTES: usize = size_of::<u16>();
const MAX_PAYLOAD_BYTES: usize =
    COUNT_BYTES + MAX_CLEANUP_NAMES * (LENGTH_BYTES + MAX_CLEANUP_NAME_BYTES);

pub(crate) fn read_names(descriptor: OwnedFd) -> io::Result<Vec<OsString>> {
    let mut input = std::fs::File::from(descriptor);
    let mut payload = Vec::new();
    Read::by_ref(&mut input)
        .take((MAX_PAYLOAD_BYTES + 1) as u64)
        .read_to_end(&mut payload)?;
    if payload.len() > MAX_PAYLOAD_BYTES {
        return Err(invalid_names());
    }
    decode_names(&payload)
}

fn decode_names(payload: &[u8]) -> io::Result<Vec<OsString>> {
    let count = read_u16(payload, 0)? as usize;
    if count > MAX_CLEANUP_NAMES {
        return Err(invalid_names());
    }
    let mut offset = COUNT_BYTES;
    let mut names = Vec::with_capacity(count);
    for _ in 0..count {
        let length = read_u16(payload, offset)? as usize;
        offset = offset.checked_add(LENGTH_BYTES).ok_or_else(invalid_names)?;
        let end = offset.checked_add(length).ok_or_else(invalid_names)?;
        let bytes = payload.get(offset..end).ok_or_else(invalid_names)?;
        let name = OsString::from_vec(bytes.to_vec());
        validate_name(&name)?;
        if names.iter().any(|existing| existing == &name) {
            return Err(invalid_names());
        }
        names.push(name);
        offset = end;
    }
    if offset == payload.len() {
        Ok(names)
    } else {
        Err(invalid_names())
    }
}

fn read_u16(payload: &[u8], offset: usize) -> io::Result<u16> {
    let end = offset.checked_add(COUNT_BYTES).ok_or_else(invalid_names)?;
    let bytes = payload.get(offset..end).ok_or_else(invalid_names)?;
    Ok(u16::from_be_bytes(bytes.try_into().expect("fixed width")))
}

fn invalid_names() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "guardian cleanup names are invalid",
    )
}

#[cfg(test)]
mod tests {
    use super::decode_names;

    #[test]
    fn cleanup_names_reject_duplicates() {
        let payload = [0, 2, 0, 1, b'a', 0, 1, b'a'];
        assert!(decode_names(&payload).is_err());
    }
}
