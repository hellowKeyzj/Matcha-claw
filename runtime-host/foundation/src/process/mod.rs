mod authority;
mod factory;
mod launch;
mod observation;
mod one_shot;
mod resource;
mod stdio;
mod task;
mod termination;

pub mod supervision;
mod system;

pub use authority::{AuthorityClass, AuthorityScope, ProcessIdentity, Provenance, ScopeId};
pub use factory::{ProcessContainment, supervise};
pub(crate) use launch::LaunchRequest;
#[cfg(unix)]
pub use launch::PosixLaunchCustody;
pub use launch::{
    ChildDescriptor, ExecutionSource, FixedLaunch, InvalidLaunchSpec, LaunchAttempt,
    LaunchAttemptCleanupFailure, LaunchAttemptFuture, LaunchAttemptGuard,
    LaunchAttemptMaterializer, LaunchMaterializationFailure, LaunchSpec,
};
pub use observation::{ExitObservation, ProcessObservation};
pub use one_shot::{
    OneShotCompletion, OneShotContainment, OneShotFailure, OneShotOperation, OneShotRun,
    OneShotRunner,
};
pub use stdio::{
    ProcessOutput, ProcessStdin, ProcessStdio, StdioActivationResult, StdioDrain, StdioDrainResult,
    StdioMode, StdioSpec,
};
#[cfg(unix)]
pub use system::posix::InvalidGuardianExecutable;
#[cfg(windows)]
pub use system::windows::loader::{WindowsSystemRootError, windows_system_root};
pub use termination::{ShutdownOutcome, TerminationFailure, TerminationOutcome};
