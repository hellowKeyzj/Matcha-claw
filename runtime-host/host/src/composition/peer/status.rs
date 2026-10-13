use foundation::process::supervision::{
    RestartOutcome, StartOutcome, SupervisorSnapshot, TerminationCompletion,
};

use crate::{
    HostState, RuntimeFailure, RuntimeLifecycle, RuntimeState,
    composition::{
        admission::HostAdmission,
        host::diagnostics::project_host_lifecycle,
        runtime_ports::{
            RuntimeDriverDirectory, RuntimeDriverIdentity,
            RuntimeLifecycleFailure as DriverLifecycleFailure,
            RuntimeStartFailure as DriverStartFailure,
        },
    },
};

use ::diagnostics::{RuntimeStartupDiagnostic, RuntimeStartupDiagnostics};
use runtime_directory::{
    RuntimeControlLifecycle, RuntimeControlLifecycleFailure, RuntimeControlLifecycleStatus,
    RuntimeControlStartupDiagnostic,
};

pub(super) fn host_state(
    admission: &HostAdmission,
    directory: &RuntimeDriverDirectory,
    matcha_diagnostics: &RuntimeStartupDiagnostics,
    openclaw_diagnostics: &RuntimeStartupDiagnostics,
) -> HostState {
    let matcha = matcha_lifecycle_snapshot(directory);
    let open_claw = open_claw_lifecycle_snapshot(directory);
    let phase = admission.state().phase();
    HostState::from_runtime_states(
        phase == crate::composition::HostPhase::Ready,
        project_host_lifecycle(phase),
        RuntimeState::from_snapshot_with_startup_diagnostic(
            &matcha,
            matcha_diagnostics.category(),
        ),
        RuntimeState::from_snapshot_with_startup_diagnostic(
            &open_claw,
            openclaw_diagnostics.category(),
        ),
    )
}

pub(super) fn matcha_state(
    directory: &RuntimeDriverDirectory,
    diagnostics: &RuntimeStartupDiagnostics,
) -> RuntimeState {
    RuntimeState::from_snapshot_with_startup_diagnostic(
        &matcha_lifecycle_snapshot(directory),
        diagnostics.category(),
    )
}

pub(super) fn open_claw_state(
    directory: &RuntimeDriverDirectory,
    diagnostics: &RuntimeStartupDiagnostics,
) -> RuntimeState {
    RuntimeState::from_snapshot_with_startup_diagnostic(
        &open_claw_lifecycle_snapshot(directory),
        diagnostics.category(),
    )
}

pub(super) fn matcha_lifecycle_snapshot(directory: &RuntimeDriverDirectory) -> SupervisorSnapshot {
    lifecycle_snapshot(directory, RuntimeDriverIdentity::matcha_agent())
}

pub(super) fn open_claw_lifecycle_snapshot(directory: &RuntimeDriverDirectory) -> SupervisorSnapshot {
    lifecycle_snapshot(directory, RuntimeDriverIdentity::open_claw())
}

fn lifecycle_snapshot(
    directory: &RuntimeDriverDirectory,
    identity: RuntimeDriverIdentity,
) -> SupervisorSnapshot {
    let endpoint = identity.endpoint();
    let driver = directory
        .lookup(&endpoint)
        .expect("peer runtime lifecycle driver must be registered");
    driver
        .host_lifecycle_ops()
        .expect("peer runtime lifecycle ops must be registered")
        .snapshot()
}

pub(super) fn start_failure(
    result: &Result<StartOutcome, DriverStartFailure>,
) -> Option<crate::RuntimeStartFailure> {
    match result {
        Ok(StartOutcome::Started) => None,
        Ok(StartOutcome::Cancelled { .. }) => Some(crate::RuntimeStartFailure::Cancelled),
        Err(error) => Some(map_start_failure(*error)),
    }
}

pub(super) fn runtime_start_result(
    result: Result<StartOutcome, DriverStartFailure>,
) -> Result<(), crate::RuntimeStartFailure> {
    match result {
        Ok(StartOutcome::Started) => Ok(()),
        Ok(StartOutcome::Cancelled { .. }) => Err(crate::RuntimeStartFailure::Cancelled),
        Err(error) => Err(map_start_failure(error)),
    }
}

pub(super) fn runtime_stop_result(
    result: Result<TerminationCompletion, DriverLifecycleFailure>,
) -> Result<(), crate::RuntimeLifecycleFailure> {
    result.map(|_| ()).map_err(map_lifecycle_failure)
}

pub(super) fn runtime_restart_result(
    result: Result<RestartOutcome, DriverLifecycleFailure>,
) -> Result<(), crate::RuntimeLifecycleFailure> {
    match result {
        Ok(RestartOutcome::Restarted) => Ok(()),
        Ok(RestartOutcome::Cancelled { .. }) => Err(crate::RuntimeLifecycleFailure::Cancelled),
        Err(error) => Err(map_lifecycle_failure(error)),
    }
}

pub(super) fn runtime_control_status(state: &RuntimeState) -> RuntimeControlLifecycleStatus {
    RuntimeControlLifecycleStatus {
        lifecycle: runtime_control_lifecycle(state.lifecycle()),
        failure: state.failure().map(runtime_control_failure),
        startup_diagnostic: state
            .startup_diagnostic()
            .map(runtime_control_startup_diagnostic),
    }
}

const fn runtime_control_lifecycle(lifecycle: RuntimeLifecycle) -> RuntimeControlLifecycle {
    match lifecycle {
        RuntimeLifecycle::Unavailable => RuntimeControlLifecycle::Unavailable,
        RuntimeLifecycle::Idle => RuntimeControlLifecycle::Idle,
        RuntimeLifecycle::Starting => RuntimeControlLifecycle::Starting,
        RuntimeLifecycle::Running => RuntimeControlLifecycle::Running,
        RuntimeLifecycle::Stopping => RuntimeControlLifecycle::Stopping,
        RuntimeLifecycle::WaitingToRestart => RuntimeControlLifecycle::WaitingToRestart,
        RuntimeLifecycle::Failed => RuntimeControlLifecycle::Failed,
        RuntimeLifecycle::ShutDown => RuntimeControlLifecycle::ShutDown,
    }
}

const fn runtime_control_failure(failure: RuntimeFailure) -> RuntimeControlLifecycleFailure {
    match failure {
        RuntimeFailure::ArtifactUnavailable => RuntimeControlLifecycleFailure::ArtifactUnavailable,
        RuntimeFailure::PermissionDenied => RuntimeControlLifecycleFailure::PermissionDenied,
        RuntimeFailure::ResourceUnavailable => RuntimeControlLifecycleFailure::ResourceUnavailable,
        RuntimeFailure::PlatformRejected => RuntimeControlLifecycleFailure::PlatformRejected,
        RuntimeFailure::Stdio => RuntimeControlLifecycleFailure::Stdio,
        RuntimeFailure::Readiness => RuntimeControlLifecycleFailure::Readiness,
        RuntimeFailure::UnexpectedExit => RuntimeControlLifecycleFailure::UnexpectedExit,
        RuntimeFailure::AuthorityLost => RuntimeControlLifecycleFailure::AuthorityLost,
        RuntimeFailure::CleanupUnconfirmed => RuntimeControlLifecycleFailure::CleanupUnconfirmed,
        RuntimeFailure::MaterialCleanupFailed => {
            RuntimeControlLifecycleFailure::MaterialCleanupFailed
        }
    }
}

const fn runtime_control_startup_diagnostic(
    diagnostic: RuntimeStartupDiagnostic,
) -> RuntimeControlStartupDiagnostic {
    match diagnostic {
        RuntimeStartupDiagnostic::PortConflict => RuntimeControlStartupDiagnostic::PortConflict,
        RuntimeStartupDiagnostic::ConfigurationRejected => {
            RuntimeControlStartupDiagnostic::ConfigurationRejected
        }
        RuntimeStartupDiagnostic::AppServerReportedError => {
            RuntimeControlStartupDiagnostic::AppServerReportedError
        }
        RuntimeStartupDiagnostic::UnclassifiedStderr => {
            RuntimeControlStartupDiagnostic::UnclassifiedStderr
        }
        RuntimeStartupDiagnostic::InvalidUtf8 => RuntimeControlStartupDiagnostic::InvalidUtf8,
        RuntimeStartupDiagnostic::LineTooLong => RuntimeControlStartupDiagnostic::LineTooLong,
        RuntimeStartupDiagnostic::ListenerReported => {
            RuntimeControlStartupDiagnostic::ListenerReported
        }
        RuntimeStartupDiagnostic::BindRejected => RuntimeControlStartupDiagnostic::BindRejected,
        RuntimeStartupDiagnostic::StartupFailed => RuntimeControlStartupDiagnostic::StartupFailed,
        RuntimeStartupDiagnostic::InvalidEncoding => {
            RuntimeControlStartupDiagnostic::InvalidEncoding
        }
        RuntimeStartupDiagnostic::DiagnosticLimitReached => {
            RuntimeControlStartupDiagnostic::DiagnosticLimitReached
        }
    }
}

const fn map_start_failure(error: DriverStartFailure) -> crate::RuntimeStartFailure {
    match error {
        DriverStartFailure::CompletionFailed => crate::RuntimeStartFailure::CompletionFailed,
        DriverStartFailure::SupervisorStopped => crate::RuntimeStartFailure::SupervisorStopped,
        DriverStartFailure::Busy => crate::RuntimeStartFailure::Busy,
        DriverStartFailure::Rejected(_) | DriverStartFailure::Unsupported => {
            crate::RuntimeStartFailure::Rejected
        }
        DriverStartFailure::ShuttingDown => crate::RuntimeStartFailure::ShuttingDown,
    }
}

const fn map_lifecycle_failure(error: DriverLifecycleFailure) -> crate::RuntimeLifecycleFailure {
    match error {
        DriverLifecycleFailure::CompletionFailed => {
            crate::RuntimeLifecycleFailure::CompletionFailed
        }
        DriverLifecycleFailure::SupervisorStopped => {
            crate::RuntimeLifecycleFailure::SupervisorStopped
        }
        DriverLifecycleFailure::AlreadySatisfied => {
            crate::RuntimeLifecycleFailure::AlreadySatisfied
        }
        DriverLifecycleFailure::Busy => crate::RuntimeLifecycleFailure::Busy,
        DriverLifecycleFailure::Rejected(_) | DriverLifecycleFailure::Unsupported => {
            crate::RuntimeLifecycleFailure::Rejected
        }
        DriverLifecycleFailure::ShuttingDown => crate::RuntimeLifecycleFailure::ShuttingDown,
    }
}
