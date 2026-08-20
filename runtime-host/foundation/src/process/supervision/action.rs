use super::super::{
    Provenance, TerminationFailure, TerminationOutcome,
    resource::{ResourceFailure, SharedTerminalEvidence, TerminalOrigin},
};
use super::{ControlIntent, SupervisorFailure, SupervisorOperation};

pub(super) fn is_attached(observation: super::super::ProcessObservation) -> bool {
    matches!(observation.provenance(), Provenance::Attached { .. })
}

pub(super) fn operation(intent: ControlIntent) -> SupervisorOperation {
    match intent {
        ControlIntent::Stop => SupervisorOperation::Stop,
        ControlIntent::Kill => SupervisorOperation::Kill,
        ControlIntent::Shutdown => SupervisorOperation::Shutdown,
    }
}

pub(super) fn terminal_outcome(evidence: &SharedTerminalEvidence) -> TerminationOutcome {
    match evidence.origin() {
        TerminalOrigin::ObservedDrain => TerminationOutcome::Graceful(evidence.exit().clone()),
        TerminalOrigin::DestructiveCleanup => TerminationOutcome::Forced(evidence.exit().clone()),
    }
}

pub(super) fn termination_failure_outcome(failure: TerminationFailure) -> TerminationOutcome {
    match failure {
        TerminationFailure::AuthorityLost => TerminationOutcome::AuthorityLost,
        TerminationFailure::CleanupUnconfirmed => TerminationOutcome::Failed(failure),
        TerminationFailure::MaterialCleanupFailed => TerminationOutcome::Failed(failure),
    }
}

pub(super) fn resource_failure(failure: ResourceFailure) -> SupervisorFailure {
    match failure {
        ResourceFailure::AuthorityLost => {
            SupervisorFailure::Termination(TerminationFailure::AuthorityLost)
        }
        ResourceFailure::MaterialCleanupFailed => {
            SupervisorFailure::Termination(TerminationFailure::MaterialCleanupFailed)
        }
        ResourceFailure::CleanupUnconfirmed
        | ResourceFailure::EpochMismatch
        | ResourceFailure::TimedOut => {
            SupervisorFailure::Termination(TerminationFailure::CleanupUnconfirmed)
        }
        ResourceFailure::OwnerStopped => {
            SupervisorFailure::Termination(TerminationFailure::CleanupUnconfirmed)
        }
    }
}
