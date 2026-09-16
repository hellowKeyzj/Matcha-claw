use foundation::process::supervision::{
    RestartOutcome, StartOutcome, SupervisorPhase, SupervisorSnapshot, TerminationCompletion,
};

use crate::{
    HostState, RuntimeState,
    runtime::adapters::openclaw::ControlLease,
    runtime::driver::{
        RuntimeDriverIdentity, RuntimeLifecycleFailure as DriverLifecycleFailure,
        RuntimeStartFailure as DriverStartFailure,
    },
};

use super::actor::PeerShared;

pub(super) fn host_state(shared: &PeerShared) -> HostState {
    let matcha = matcha_lifecycle_snapshot(shared);
    let open_claw = open_claw_lifecycle_snapshot(shared);
    HostState::from_supervisors(
        shared.admission().state().phase(),
        &matcha,
        shared.matcha_startup_diagnostics().category(),
        &open_claw,
        shared.openclaw_startup_diagnostics().category(),
    )
}

pub(super) fn matcha_state(shared: &PeerShared) -> RuntimeState {
    RuntimeState::from_snapshot_with_startup_diagnostic(
        &matcha_lifecycle_snapshot(shared),
        shared
            .matcha_startup_diagnostics()
            .category()
            .map(Into::into),
    )
}

pub(super) fn open_claw_state(shared: &PeerShared) -> RuntimeState {
    RuntimeState::from_snapshot_with_startup_diagnostic(
        &open_claw_lifecycle_snapshot(shared),
        shared
            .openclaw_startup_diagnostics()
            .category()
            .map(Into::into),
    )
}

pub(super) fn matcha_lifecycle_snapshot(shared: &PeerShared) -> SupervisorSnapshot {
    lifecycle_snapshot(shared, RuntimeDriverIdentity::matcha_agent())
}

pub(super) fn open_claw_lifecycle_snapshot(shared: &PeerShared) -> SupervisorSnapshot {
    lifecycle_snapshot(shared, RuntimeDriverIdentity::open_claw())
}

fn lifecycle_snapshot(shared: &PeerShared, identity: RuntimeDriverIdentity) -> SupervisorSnapshot {
    let endpoint = identity.endpoint();
    let driver = shared
        .runtime_directory()
        .lookup(&endpoint)
        .expect("peer runtime lifecycle driver must be registered");
    driver
        .lifecycle_ops()
        .expect("peer runtime lifecycle ops must be registered")
        .snapshot()
}

pub(super) fn control_lease_for_snapshot(
    shared: &PeerShared,
    snapshot: &SupervisorSnapshot,
) -> ControlLease {
    match snapshot.phase() {
        SupervisorPhase::Starting | SupervisorPhase::Running => shared.open_claw().control_lease(),
        _ => ControlLease::unavailable(),
    }
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
