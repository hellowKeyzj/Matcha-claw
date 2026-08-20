use std::ffi::{OsStr, OsString};
use std::fmt;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;

use super::{StdioSpec, supervision::LaunchFailure};

mod child_descriptor;
pub use child_descriptor::ChildDescriptor;

mod execution_source;
pub use execution_source::ExecutionSource;

#[cfg(unix)]
#[path = "launch/posix.rs"]
pub(crate) mod posix;
#[cfg(unix)]
pub use posix::PosixLaunchCustody;
#[cfg(unix)]
#[path = "launch/posix_limits.rs"]
pub(crate) mod posix_limits;
#[cfg(windows)]
#[path = "launch/windows.rs"]
mod windows;

#[derive(Clone)]
pub struct LaunchSpec {
    executable: PathBuf,
    working_directory: PathBuf,
    arguments: Vec<OsString>,
    public_environment: Vec<(OsString, OsString)>,
    stdio: StdioSpec,
}

pub type LaunchAttemptFuture = Pin<
    Box<dyn Future<Output = Result<LaunchAttempt, LaunchMaterializationFailure>> + Send + 'static>,
>;

pub struct LaunchAttempt {
    spec: LaunchSpec,
    guard: Box<dyn LaunchAttemptGuard>,
    child_descriptor: Option<ChildDescriptor>,
    execution_source: Option<ExecutionSource>,
    #[cfg(unix)]
    custody: Option<posix::PosixLaunchCustody>,
}

impl LaunchAttempt {
    pub fn new(spec: LaunchSpec, guard: impl LaunchAttemptGuard) -> Self {
        Self {
            spec,
            guard: Box::new(guard),
            child_descriptor: None,
            execution_source: None,
            #[cfg(unix)]
            custody: None,
        }
    }

    pub fn with_child_descriptor(
        spec: LaunchSpec,
        guard: impl LaunchAttemptGuard,
        child_descriptor: ChildDescriptor,
    ) -> Self {
        Self {
            spec,
            guard: Box::new(guard),
            child_descriptor: Some(child_descriptor),
            execution_source: None,
            #[cfg(unix)]
            custody: None,
        }
    }

    pub fn with_execution_source(
        spec: LaunchSpec,
        guard: impl LaunchAttemptGuard,
        execution_source: ExecutionSource,
    ) -> Self {
        Self {
            spec,
            guard: Box::new(guard),
            child_descriptor: None,
            execution_source: Some(execution_source),
            #[cfg(unix)]
            custody: None,
        }
    }

    pub fn with_child_descriptor_and_execution_source(
        spec: LaunchSpec,
        guard: impl LaunchAttemptGuard,
        child_descriptor: ChildDescriptor,
        execution_source: ExecutionSource,
    ) -> Self {
        Self {
            spec,
            guard: Box::new(guard),
            child_descriptor: Some(child_descriptor),
            execution_source: Some(execution_source),
            #[cfg(unix)]
            custody: None,
        }
    }

    #[cfg(unix)]
    pub fn with_posix_custody(
        spec: LaunchSpec,
        guard: impl LaunchAttemptGuard,
        custody: posix::PosixLaunchCustody,
    ) -> Self {
        Self {
            spec,
            guard: Box::new(guard),
            child_descriptor: None,
            execution_source: None,
            custody: Some(custody),
        }
    }

    pub(crate) fn into_parts(self) -> (LaunchRequest, Box<dyn LaunchAttemptGuard>) {
        (
            LaunchRequest {
                spec: self.spec,
                child_descriptor: self.child_descriptor,
                execution_source: self.execution_source,
                #[cfg(unix)]
                custody: self.custody,
            },
            self.guard,
        )
    }
}

pub(crate) struct LaunchRequest {
    pub(crate) spec: LaunchSpec,
    pub(crate) child_descriptor: Option<ChildDescriptor>,
    pub(crate) execution_source: Option<ExecutionSource>,
    #[cfg(unix)]
    pub(crate) custody: Option<posix::PosixLaunchCustody>,
}

impl LaunchRequest {
    #[cfg(test)]
    pub(crate) fn fixed(spec: LaunchSpec) -> Self {
        Self {
            spec,
            child_descriptor: None,
            execution_source: None,
            #[cfg(unix)]
            custody: None,
        }
    }
}

pub struct LaunchMaterializationFailure {
    failure: LaunchFailure,
    guard: Option<Box<dyn LaunchAttemptGuard>>,
}

impl LaunchMaterializationFailure {
    pub fn new(failure: LaunchFailure) -> Self {
        Self {
            failure,
            guard: None,
        }
    }

    pub fn with_guard(failure: LaunchFailure, guard: impl LaunchAttemptGuard) -> Self {
        Self {
            failure,
            guard: Some(Box::new(guard)),
        }
    }

    pub const fn failure(&self) -> LaunchFailure {
        self.failure
    }

    pub fn cleanup(&mut self) -> Result<(), LaunchAttemptCleanupFailure> {
        let Some(guard) = self.guard.as_mut() else {
            return Ok(());
        };
        guard.cleanup()?;
        self.guard = None;
        Ok(())
    }

    pub(crate) fn into_parts(self) -> (LaunchFailure, Option<Box<dyn LaunchAttemptGuard>>) {
        (self.failure, self.guard)
    }
}

impl From<LaunchFailure> for LaunchMaterializationFailure {
    fn from(failure: LaunchFailure) -> Self {
        Self::new(failure)
    }
}

impl fmt::Debug for LaunchMaterializationFailure {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output
            .debug_struct("LaunchMaterializationFailure")
            .field("failure", &self.failure)
            .field("has_guard", &self.guard.is_some())
            .finish()
    }
}

impl fmt::Display for LaunchMaterializationFailure {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.failure.fmt(output)
    }
}

impl std::error::Error for LaunchMaterializationFailure {}

pub trait LaunchAttemptGuard: Send + 'static {
    fn cleanup(&mut self) -> Result<(), LaunchAttemptCleanupFailure>;
}

impl LaunchAttemptGuard for () {
    fn cleanup(&mut self) -> Result<(), LaunchAttemptCleanupFailure> {
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LaunchAttemptCleanupFailure;

impl fmt::Display for LaunchAttemptCleanupFailure {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str("launch attempt material cleanup failed")
    }
}

impl std::error::Error for LaunchAttemptCleanupFailure {}

pub trait LaunchAttemptMaterializer: Send + 'static {
    fn materialize(&mut self) -> LaunchAttemptFuture;
}

pub struct FixedLaunch {
    spec: LaunchSpec,
}

impl FixedLaunch {
    pub const fn new(spec: LaunchSpec) -> Self {
        Self { spec }
    }
}

impl LaunchAttemptMaterializer for FixedLaunch {
    fn materialize(&mut self) -> LaunchAttemptFuture {
        let spec = self.spec.clone();
        Box::pin(async move { Ok(LaunchAttempt::new(spec, ())) })
    }
}

impl LaunchSpec {
    pub fn try_new(
        executable: PathBuf,
        working_directory: PathBuf,
        arguments: impl IntoIterator<Item = OsString>,
        public_environment: impl IntoIterator<Item = (OsString, OsString)>,
        stdio: StdioSpec,
    ) -> Result<Self, InvalidLaunchSpec> {
        validate_path(
            &executable,
            InvalidLaunchSpec::ExecutableNotAbsolute,
            InvalidLaunchSpec::ExecutableContainsNul,
        )?;
        validate_path(
            &working_directory,
            InvalidLaunchSpec::WorkingDirectoryNotAbsolute,
            InvalidLaunchSpec::WorkingDirectoryContainsNul,
        )?;

        let arguments = arguments.into_iter().collect::<Vec<_>>();
        if arguments
            .iter()
            .any(|argument| contains_nul(argument.as_os_str()))
        {
            return Err(InvalidLaunchSpec::ArgumentContainsNul);
        }

        let public_environment = public_environment.into_iter().collect::<Vec<_>>();
        for (key, value) in &public_environment {
            validate_environment_key(key)?;
            validate_environment_value(value)?;
        }
        validate_public_environment_keys(&public_environment)?;
        #[cfg(unix)]
        posix::encoded_launch_payload_size(
            executable.as_os_str(),
            &working_directory,
            &arguments,
            &public_environment,
        )
        .map_err(|error| match error {
            posix::CapacityError::TooManyArguments => InvalidLaunchSpec::TooManyArguments,
            posix::CapacityError::TooManyEnvironmentVariables => {
                InvalidLaunchSpec::TooManyEnvironmentVariables
            }
            posix::CapacityError::PayloadTooLarge => InvalidLaunchSpec::PlatformPayloadTooLarge,
        })?;

        Ok(Self {
            executable,
            working_directory,
            arguments,
            public_environment,
            stdio,
        })
    }

    pub fn executable(&self) -> &Path {
        &self.executable
    }

    pub fn working_directory(&self) -> &Path {
        &self.working_directory
    }

    pub fn arguments(&self) -> &[OsString] {
        &self.arguments
    }

    pub fn public_environment(&self) -> &[(OsString, OsString)] {
        &self.public_environment
    }

    pub const fn stdio(&self) -> StdioSpec {
        self.stdio
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InvalidLaunchSpec {
    ExecutableNotAbsolute,
    ExecutableContainsNul,
    WorkingDirectoryNotAbsolute,
    WorkingDirectoryContainsNul,
    ArgumentContainsNul,
    EnvironmentKeyEmpty,
    EnvironmentKeyContainsEquals,
    EnvironmentKeyContainsNul,
    EnvironmentValueContainsNul,
    DuplicateEnvironmentKey,
    EnvironmentKeyComparisonFailed,
    TooManyArguments,
    TooManyEnvironmentVariables,
    PlatformPayloadTooLarge,
}

impl fmt::Display for InvalidLaunchSpec {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str(match self {
            Self::ExecutableNotAbsolute => "launch executable is not absolute",
            Self::ExecutableContainsNul => "launch executable contains NUL",
            Self::WorkingDirectoryNotAbsolute => "launch working directory is not absolute",
            Self::WorkingDirectoryContainsNul => "launch working directory contains NUL",
            Self::ArgumentContainsNul => "launch argument contains NUL",
            Self::EnvironmentKeyEmpty => "public environment key is empty",
            Self::EnvironmentKeyContainsEquals => "public environment key contains '='",
            Self::EnvironmentKeyContainsNul => "public environment key contains NUL",
            Self::EnvironmentValueContainsNul => "public environment value contains NUL",
            Self::DuplicateEnvironmentKey => "public environment key is duplicated",
            Self::EnvironmentKeyComparisonFailed => "public environment key comparison failed",
            Self::TooManyArguments => "launch has too many arguments",
            Self::TooManyEnvironmentVariables => "launch has too many public environment variables",
            Self::PlatformPayloadTooLarge => "launch platform payload is too large",
        })
    }
}

impl std::error::Error for InvalidLaunchSpec {}

fn validate_path(
    path: &Path,
    not_absolute: InvalidLaunchSpec,
    contains_nul_error: InvalidLaunchSpec,
) -> Result<(), InvalidLaunchSpec> {
    if !path.is_absolute() {
        return Err(not_absolute);
    }
    if contains_nul(path.as_os_str()) {
        return Err(contains_nul_error);
    }
    Ok(())
}

fn validate_environment_key(key: &OsStr) -> Result<(), InvalidLaunchSpec> {
    if key.is_empty() {
        return Err(InvalidLaunchSpec::EnvironmentKeyEmpty);
    }
    if contains_nul(key) {
        return Err(InvalidLaunchSpec::EnvironmentKeyContainsNul);
    }
    if key.as_encoded_bytes().contains(&b'=') {
        return Err(InvalidLaunchSpec::EnvironmentKeyContainsEquals);
    }
    Ok(())
}

fn validate_environment_value(value: &OsStr) -> Result<(), InvalidLaunchSpec> {
    if contains_nul(value) {
        return Err(InvalidLaunchSpec::EnvironmentValueContainsNul);
    }
    Ok(())
}

#[cfg(windows)]
fn validate_public_environment_keys(
    public_environment: &[(OsString, OsString)],
) -> Result<(), InvalidLaunchSpec> {
    windows::validate_public_environment_keys(public_environment)
}

#[cfg(not(windows))]
fn validate_public_environment_keys(
    public_environment: &[(OsString, OsString)],
) -> Result<(), InvalidLaunchSpec> {
    for (index, (key, _)) in public_environment.iter().enumerate() {
        if public_environment[..index]
            .iter()
            .any(|(observed, _)| observed == key)
        {
            return Err(InvalidLaunchSpec::DuplicateEnvironmentKey);
        }
    }
    Ok(())
}

fn contains_nul(value: &OsStr) -> bool {
    value.as_encoded_bytes().contains(&0)
}

#[cfg(test)]
#[path = "launch/tests.rs"]
mod tests;
