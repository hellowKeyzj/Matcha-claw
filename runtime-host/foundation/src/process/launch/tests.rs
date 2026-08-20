use std::ffi::OsString;
use std::path::PathBuf;

#[cfg(unix)]
use std::os::unix::ffi::OsStringExt;

#[cfg(unix)]
use super::posix::{MAX_FRAME_BYTES, encoded_launch_payload_size};
use super::{InvalidLaunchSpec, LaunchMaterializationFailure, LaunchSpec};
use crate::process::{StdioMode, StdioSpec, supervision::LaunchFailure};

const TEST_STDIO: StdioSpec = StdioSpec::new(StdioMode::Null, StdioMode::Piped, StdioMode::Piped);

#[test]
fn try_new_constructs_the_complete_immutable_spawn_input() {
    let executable = absolute_path("runtime-host");
    let working_directory = absolute_path("runtime");
    let arguments = [OsString::from("serve"), OsString::from("--quiet")];
    let environment = [(OsString::from("MODE"), OsString::from("test"))];

    let spec = LaunchSpec::try_new(
        executable.clone(),
        working_directory.clone(),
        arguments.clone(),
        environment.clone(),
        TEST_STDIO,
    )
    .unwrap();

    assert!(spec.executable() == executable);
    assert!(spec.working_directory() == working_directory);
    assert!(spec.arguments() == arguments);
    assert!(spec.public_environment() == environment);
    assert_eq!(spec.stdio(), TEST_STDIO);
}

#[test]
fn try_new_keeps_an_explicit_empty_public_environment_empty() {
    let spec = LaunchSpec::try_new(
        absolute_path("runtime-host"),
        absolute_path("runtime"),
        [],
        [],
        TEST_STDIO,
    )
    .unwrap();

    assert!(spec.public_environment().is_empty());
}

#[test]
fn try_new_rejects_relative_and_nul_paths() {
    for (executable, working_directory, expected) in [
        (
            PathBuf::from("runtime-host"),
            absolute_path("runtime"),
            InvalidLaunchSpec::ExecutableNotAbsolute,
        ),
        (
            absolute_path_with_nul("runtime-host"),
            absolute_path("runtime"),
            InvalidLaunchSpec::ExecutableContainsNul,
        ),
        (
            absolute_path("runtime-host"),
            PathBuf::from("runtime"),
            InvalidLaunchSpec::WorkingDirectoryNotAbsolute,
        ),
        (
            absolute_path("runtime-host"),
            absolute_path_with_nul("runtime"),
            InvalidLaunchSpec::WorkingDirectoryContainsNul,
        ),
    ] {
        assert!(
            LaunchSpec::try_new(executable, working_directory, [], [], TEST_STDIO).err()
                == Some(expected)
        );
    }
}

#[test]
fn try_new_rejects_nul_arguments_and_invalid_public_environment() {
    assert!(
        LaunchSpec::try_new(
            absolute_path("runtime-host"),
            absolute_path("runtime"),
            [OsString::from("bad\0argument")],
            [],
            TEST_STDIO,
        )
        .err()
            == Some(InvalidLaunchSpec::ArgumentContainsNul)
    );

    for (key, value, expected) in [
        (
            OsString::new(),
            OsString::from("value"),
            InvalidLaunchSpec::EnvironmentKeyEmpty,
        ),
        (
            OsString::from("A=B"),
            OsString::from("value"),
            InvalidLaunchSpec::EnvironmentKeyContainsEquals,
        ),
        (
            OsString::from("A\0B"),
            OsString::from("value"),
            InvalidLaunchSpec::EnvironmentKeyContainsNul,
        ),
        (
            OsString::from("KEY"),
            OsString::from("bad\0value"),
            InvalidLaunchSpec::EnvironmentValueContainsNul,
        ),
    ] {
        assert!(
            LaunchSpec::try_new(
                absolute_path("runtime-host"),
                absolute_path("runtime"),
                [],
                [(key, value)],
                TEST_STDIO,
            )
            .err()
                == Some(expected)
        );
    }
}

#[test]
fn invalid_launch_spec_projections_do_not_include_inputs() {
    let private_input = "private-input-material";
    let error = LaunchSpec::try_new(
        PathBuf::from(private_input),
        absolute_path("runtime"),
        [],
        [(OsString::from(private_input), OsString::from(private_input))],
        TEST_STDIO,
    )
    .err()
    .unwrap();

    assert!(!error.to_string().contains(private_input));
    assert!(!format!("{error:?}").contains(private_input));
}

#[test]
fn materialization_failure_projections_expose_only_the_fixed_report() {
    let failure = LaunchMaterializationFailure::with_guard(LaunchFailure::PermissionDenied, ());

    assert_eq!(failure.to_string(), "process launch permission was denied");
    assert_eq!(
        format!("{failure:?}"),
        "LaunchMaterializationFailure { failure: PermissionDenied, has_guard: true }"
    );
}

#[test]
fn try_new_rejects_exact_duplicate_environment_keys() {
    assert!(
        LaunchSpec::try_new(
            absolute_path("runtime-host"),
            absolute_path("runtime"),
            [],
            [
                (OsString::from("MODE"), OsString::from("one")),
                (OsString::from("MODE"), OsString::from("two")),
            ],
            TEST_STDIO,
        )
        .err()
            == Some(InvalidLaunchSpec::DuplicateEnvironmentKey)
    );
}

#[cfg(windows)]
#[test]
fn try_new_rejects_windows_ordinal_case_insensitive_duplicate_environment_keys() {
    for keys in [("PATH", "path"), ("Å", "å")] {
        assert!(
            LaunchSpec::try_new(
                absolute_path("runtime-host"),
                absolute_path("runtime"),
                [],
                [
                    (OsString::from(keys.0), OsString::from("one")),
                    (OsString::from(keys.1), OsString::from("two")),
                ],
                TEST_STDIO,
            )
            .err()
                == Some(InvalidLaunchSpec::DuplicateEnvironmentKey)
        );
    }
}

#[cfg(not(windows))]
#[test]
fn try_new_keeps_non_windows_duplicate_comparison_exact() {
    assert!(
        LaunchSpec::try_new(
            absolute_path("runtime-host"),
            absolute_path("runtime"),
            [],
            [
                (OsString::from("MODE"), OsString::from("one")),
                (OsString::from("mode"), OsString::from("two")),
            ],
            TEST_STDIO,
        )
        .is_ok()
    );
}

#[cfg(unix)]
#[test]
fn try_new_enforces_posix_argument_and_environment_counts() {
    assert!(
        LaunchSpec::try_new(
            absolute_path("runtime-host"),
            absolute_path("runtime"),
            std::iter::repeat_n(OsString::new(), 255),
            [],
            TEST_STDIO,
        )
        .is_ok()
    );
    assert!(
        LaunchSpec::try_new(
            absolute_path("runtime-host"),
            absolute_path("runtime"),
            std::iter::repeat_n(OsString::new(), 256),
            [],
            TEST_STDIO,
        )
        .err()
            == Some(InvalidLaunchSpec::TooManyArguments)
    );

    let environment = (0..256).map(|index| (OsString::from(format!("K{index}")), OsString::new()));
    assert!(
        LaunchSpec::try_new(
            absolute_path("runtime-host"),
            absolute_path("runtime"),
            [],
            environment,
            TEST_STDIO,
        )
        .is_ok()
    );
    let environment = (0..257).map(|index| (OsString::from(format!("K{index}")), OsString::new()));
    assert!(
        LaunchSpec::try_new(
            absolute_path("runtime-host"),
            absolute_path("runtime"),
            [],
            environment,
            TEST_STDIO,
        )
        .err()
            == Some(InvalidLaunchSpec::TooManyEnvironmentVariables)
    );
}

#[cfg(unix)]
#[test]
fn try_new_enforces_the_exact_posix_payload_boundary() {
    let executable = absolute_path("runtime-host");
    let working_directory = absolute_path("runtime");
    let baseline =
        encoded_launch_payload_size(executable.as_os_str(), &working_directory, &[], &[]).unwrap();
    let exact_argument = OsString::from_vec(vec![b'x'; MAX_FRAME_BYTES - baseline - 4]);
    assert!(
        LaunchSpec::try_new(
            executable.clone(),
            working_directory.clone(),
            [exact_argument],
            [],
            TEST_STDIO,
        )
        .is_ok()
    );
    let oversized_argument = OsString::from_vec(vec![b'x'; MAX_FRAME_BYTES - baseline - 3]);
    assert!(
        LaunchSpec::try_new(
            executable,
            working_directory,
            [oversized_argument],
            [],
            TEST_STDIO,
        )
        .err()
            == Some(InvalidLaunchSpec::PlatformPayloadTooLarge)
    );
}

#[cfg(windows)]
fn absolute_path(name: &str) -> PathBuf {
    PathBuf::from(format!(r"C:\{name}"))
}

#[cfg(not(windows))]
fn absolute_path(name: &str) -> PathBuf {
    PathBuf::from(format!("/{name}"))
}

#[cfg(windows)]
fn absolute_path_with_nul(name: &str) -> PathBuf {
    PathBuf::from(format!("C:\\{name}\0invalid"))
}

#[cfg(not(windows))]
fn absolute_path_with_nul(name: &str) -> PathBuf {
    PathBuf::from(format!("/{name}\0invalid"))
}
