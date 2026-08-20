use std::ffi::{OsStr, OsString};
use std::io;
use std::mem::MaybeUninit;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

const FIRST_CUSTODY_DESCRIPTOR: libc::c_int = 64;
const MAX_CLEANUP_NAMES: usize = 32;
const MAX_CLEANUP_NAME_BYTES: usize = 255;

pub(crate) type PosixCustodyHandoff = Box<dyn FnOnce() + Send + 'static>;

pub struct PosixLaunchCustody {
    target_state_directory: OwnedFd,
    cleanup_directory: OwnedFd,
    cleanup_names: Vec<OsString>,
    handoff: Option<PosixCustodyHandoff>,
}

impl PosixLaunchCustody {
    pub fn new(
        target_state_directory: OwnedFd,
        cleanup_directory: OwnedFd,
        cleanup_names: impl IntoIterator<Item = OsString>,
    ) -> io::Result<Self> {
        validate_directory(target_state_directory.as_raw_fd())?;
        validate_directory(cleanup_directory.as_raw_fd())?;
        let cleanup_names = cleanup_names.into_iter().collect::<Vec<_>>();
        if cleanup_names.len() > MAX_CLEANUP_NAMES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "cleanup name manifest is too large",
            ));
        }
        for (index, name) in cleanup_names.iter().enumerate() {
            validate_cleanup_name(name)?;
            if cleanup_names[..index]
                .iter()
                .any(|existing| existing == name)
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "cleanup name manifest contains duplicates",
                ));
            }
        }
        Ok(Self {
            target_state_directory: duplicate(target_state_directory)?,
            cleanup_directory: duplicate(cleanup_directory)?,
            cleanup_names,
            handoff: None,
        })
    }

    pub fn with_handoff(mut self, handoff: impl FnOnce() + Send + 'static) -> Self {
        assert!(
            self.handoff.is_none(),
            "launch custody handoff is already bound"
        );
        self.handoff = Some(Box::new(handoff));
        self
    }

    pub(crate) fn into_guardian_parts(
        self,
    ) -> (OwnedFd, OwnedFd, Vec<OsString>, Option<PosixCustodyHandoff>) {
        (
            self.target_state_directory,
            self.cleanup_directory,
            self.cleanup_names,
            self.handoff,
        )
    }
}

fn duplicate(descriptor: OwnedFd) -> io::Result<OwnedFd> {
    let duplicated = unsafe {
        libc::fcntl(
            descriptor.as_raw_fd(),
            libc::F_DUPFD_CLOEXEC,
            FIRST_CUSTODY_DESCRIPTOR,
        )
    };
    if duplicated == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(duplicated) })
}

fn validate_directory(descriptor: libc::c_int) -> io::Result<()> {
    let mut metadata = MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstat(descriptor, metadata.as_mut_ptr()) } == -1 {
        return Err(io::Error::last_os_error());
    }
    let metadata = unsafe { metadata.assume_init() };
    if metadata.st_mode & libc::S_IFMT != libc::S_IFDIR {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "launch custody descriptor is not a directory",
        ));
    }
    Ok(())
}

fn validate_cleanup_name(name: &OsStr) -> io::Result<()> {
    let bytes = name.as_bytes();
    if bytes.is_empty()
        || bytes.len() > MAX_CLEANUP_NAME_BYTES
        || bytes == b"."
        || bytes == b".."
        || bytes.contains(&0)
        || bytes.contains(&b'/')
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "cleanup name is not bounded",
        ));
    }
    Ok(())
}

pub(crate) use super::posix_limits::{
    MAX_ARGUMENTS, MAX_FRAME_BYTES, MAX_PUBLIC_ENVIRONMENT_VARIABLES,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CapacityError {
    TooManyArguments,
    TooManyEnvironmentVariables,
    PayloadTooLarge,
}

const COUNT_BYTES: usize = size_of::<u16>();
const VALUE_LENGTH_BYTES: usize = size_of::<u32>();

pub(crate) fn encoded_launch_payload_size(
    executable: &OsStr,
    working_directory: &Path,
    arguments: &[OsString],
    public_environment: &[(OsString, OsString)],
) -> Result<usize, CapacityError> {
    let argument_count = arguments
        .len()
        .checked_add(1)
        .ok_or(CapacityError::TooManyArguments)?;
    if argument_count > MAX_ARGUMENTS {
        return Err(CapacityError::TooManyArguments);
    }
    if public_environment.len() > MAX_PUBLIC_ENVIRONMENT_VARIABLES {
        return Err(CapacityError::TooManyEnvironmentVariables);
    }

    let mut payload_bytes = checked_add_payload_bytes(0, COUNT_BYTES)?;
    payload_bytes = checked_add_encoded_value(payload_bytes, executable.as_bytes().len())?;
    for argument in arguments {
        payload_bytes =
            checked_add_encoded_value(payload_bytes, argument.as_os_str().as_bytes().len())?;
    }
    payload_bytes = checked_add_encoded_value(
        payload_bytes,
        working_directory.as_os_str().as_bytes().len(),
    )?;
    payload_bytes = checked_add_payload_bytes(payload_bytes, COUNT_BYTES)?;
    for (key, value) in public_environment {
        payload_bytes = checked_add_encoded_value(payload_bytes, key.as_os_str().as_bytes().len())?;
        payload_bytes =
            checked_add_encoded_value(payload_bytes, value.as_os_str().as_bytes().len())?;
    }
    Ok(payload_bytes)
}

fn checked_add_encoded_value(
    payload_bytes: usize,
    value_bytes: usize,
) -> Result<usize, CapacityError> {
    u32::try_from(value_bytes).map_err(|_| CapacityError::PayloadTooLarge)?;
    let payload_bytes = checked_add_payload_bytes(payload_bytes, VALUE_LENGTH_BYTES)?;
    checked_add_payload_bytes(payload_bytes, value_bytes)
}

fn checked_add_payload_bytes(
    payload_bytes: usize,
    additional_bytes: usize,
) -> Result<usize, CapacityError> {
    payload_bytes
        .checked_add(additional_bytes)
        .filter(|size| *size <= MAX_FRAME_BYTES)
        .ok_or(CapacityError::PayloadTooLarge)
}

#[cfg(test)]
mod tests {
    use std::fs::File;

    use super::{
        CapacityError, PosixLaunchCustody, checked_add_encoded_value, checked_add_payload_bytes,
    };

    #[test]
    #[should_panic(expected = "launch custody handoff is already bound")]
    fn duplicate_handoff_binding_panics_instead_of_replacing_the_first_callback() {
        let custody = PosixLaunchCustody::new(
            File::open(".").unwrap().into(),
            File::open(".").unwrap().into(),
            [],
        )
        .unwrap();

        let _ = custody.with_handoff(|| {}).with_handoff(|| {});
    }

    #[test]
    fn payload_sizing_rejects_checked_arithmetic_overflow() {
        assert!(checked_add_payload_bytes(usize::MAX, 1) == Err(CapacityError::PayloadTooLarge));
        assert!(checked_add_encoded_value(0, usize::MAX) == Err(CapacityError::PayloadTooLarge));
    }
}
