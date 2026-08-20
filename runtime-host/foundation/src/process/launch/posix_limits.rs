pub(crate) const MAX_ARGUMENTS: usize = 256;
pub(crate) const MAX_PUBLIC_ENVIRONMENT_VARIABLES: usize = 256;
pub(crate) const MAX_FRAME_BYTES: usize = 64 * 1024;

const _: () = assert!(MAX_ARGUMENTS <= u16::MAX as usize);
const _: () = assert!(MAX_PUBLIC_ENVIRONMENT_VARIABLES <= u16::MAX as usize);
const _: () = assert!(MAX_FRAME_BYTES <= u32::MAX as usize);

#[cfg(test)]
mod tests {
    use std::ffi::OsString;
    use std::os::unix::ffi::OsStringExt;
    use std::path::Path;

    use super::super::posix::{CapacityError, encoded_launch_payload_size};
    use super::{MAX_ARGUMENTS, MAX_FRAME_BYTES, MAX_PUBLIC_ENVIRONMENT_VARIABLES};

    #[test]
    fn preflight_bounds_the_guardian_argument_and_environment_counts() {
        let executable = OsString::from("/");
        let working_directory = Path::new("/");

        assert!(
            encoded_launch_payload_size(
                executable.as_os_str(),
                working_directory,
                &vec![OsString::new(); MAX_ARGUMENTS - 1],
                &[],
            )
            .is_ok()
        );
        assert_eq!(
            encoded_launch_payload_size(
                executable.as_os_str(),
                working_directory,
                &vec![OsString::new(); MAX_ARGUMENTS],
                &[],
            ),
            Err(CapacityError::TooManyArguments),
        );

        let environment = (0..MAX_PUBLIC_ENVIRONMENT_VARIABLES)
            .map(|index| (OsString::from(format!("K{index}")), OsString::new()))
            .collect::<Vec<_>>();
        assert!(
            encoded_launch_payload_size(
                executable.as_os_str(),
                working_directory,
                &[],
                &environment,
            )
            .is_ok()
        );
        let environment = (0..=MAX_PUBLIC_ENVIRONMENT_VARIABLES)
            .map(|index| (OsString::from(format!("K{index}")), OsString::new()))
            .collect::<Vec<_>>();
        assert_eq!(
            encoded_launch_payload_size(
                executable.as_os_str(),
                working_directory,
                &[],
                &environment,
            ),
            Err(CapacityError::TooManyEnvironmentVariables),
        );
    }

    #[test]
    fn preflight_enforces_the_exact_guardian_frame_capacity() {
        let executable = OsString::from("/");
        let working_directory = Path::new("/");
        let baseline =
            encoded_launch_payload_size(executable.as_os_str(), working_directory, &[], &[])
                .unwrap();

        let exact = OsString::from_vec(vec![b'x'; MAX_FRAME_BYTES - baseline - size_of::<u32>()]);
        assert_eq!(
            encoded_launch_payload_size(executable.as_os_str(), working_directory, &[exact], &[],),
            Ok(MAX_FRAME_BYTES),
        );

        let oversized = OsString::from_vec(vec![
            b'x';
            MAX_FRAME_BYTES - baseline - size_of::<u32>() + 1
        ]);
        assert_eq!(
            encoded_launch_payload_size(
                executable.as_os_str(),
                working_directory,
                &[oversized],
                &[],
            ),
            Err(CapacityError::PayloadTooLarge),
        );
    }
}
