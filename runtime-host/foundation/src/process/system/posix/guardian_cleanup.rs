use std::ffi::OsString;
use std::io::{self, Write};
use std::os::fd::OwnedFd;
use std::os::unix::ffi::OsStrExt;

const MAX_CLEANUP_NAMES: usize = 32;
const MAX_CLEANUP_NAME_BYTES: usize = 255;
const COUNT_BYTES: usize = size_of::<u16>();
const LENGTH_BYTES: usize = size_of::<u16>();

pub(crate) fn write_names(descriptor: OwnedFd, names: &[OsString]) -> io::Result<()> {
    let payload = encode_names(names)?;
    let mut output = std::fs::File::from(descriptor);
    output.write_all(&payload)
}

fn encode_names(names: &[OsString]) -> io::Result<Vec<u8>> {
    if names.len() > MAX_CLEANUP_NAMES {
        return Err(invalid_names());
    }
    let mut payload =
        Vec::with_capacity(COUNT_BYTES + names.len() * (LENGTH_BYTES + MAX_CLEANUP_NAME_BYTES));
    payload.extend_from_slice(&(names.len() as u16).to_be_bytes());
    for (index, name) in names.iter().enumerate() {
        validate_name(name)?;
        if names[..index].iter().any(|existing| existing == name) {
            return Err(invalid_names());
        }
        let bytes = name.as_os_str().as_bytes();
        payload.extend_from_slice(&(bytes.len() as u16).to_be_bytes());
        payload.extend_from_slice(bytes);
    }
    Ok(payload)
}

fn validate_name(name: &OsString) -> io::Result<()> {
    let bytes = name.as_os_str().as_bytes();
    if bytes.is_empty()
        || bytes.len() > MAX_CLEANUP_NAME_BYTES
        || bytes == b"."
        || bytes == b".."
        || bytes.contains(&0)
        || bytes.contains(&b'/')
    {
        return Err(invalid_names());
    }
    Ok(())
}

fn invalid_names() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "guardian cleanup names are invalid",
    )
}
