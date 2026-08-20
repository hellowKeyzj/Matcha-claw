use std::fmt;

use super::ExitObservation;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TerminationFailure {
    AuthorityLost,
    CleanupUnconfirmed,
    MaterialCleanupFailed,
}

impl fmt::Display for TerminationFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AuthorityLost => formatter.write_str("termination authority was lost"),
            Self::CleanupUnconfirmed => formatter.write_str("process cleanup was not confirmed"),
            Self::MaterialCleanupFailed => {
                formatter.write_str("launch attempt material cleanup failed")
            }
        }
    }
}

impl std::error::Error for TerminationFailure {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TerminationOutcome {
    AuthorityLost,
    Failed(TerminationFailure),
    Forced(ExitObservation),
    Graceful(ExitObservation),
    NoProcess,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ShutdownOutcome {
    Detached,
    Terminated(TerminationOutcome),
    Unresolved { failure: TerminationFailure },
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, SystemTime};

    use super::*;

    #[test]
    fn graceful_and_forced_termination_outcomes_are_distinct() {
        let exit = ExitObservation::new(
            Some(0),
            None,
            SystemTime::UNIX_EPOCH + Duration::from_secs(42),
        );
        let graceful = TerminationOutcome::Graceful(exit.clone());
        let forced = TerminationOutcome::Forced(exit.clone());

        assert!(matches!(
            graceful,
            TerminationOutcome::Graceful(ref observation) if observation == &exit
        ));
        assert!(matches!(
            forced,
            TerminationOutcome::Forced(ref observation) if observation == &exit
        ));
        assert_ne!(graceful, forced);
    }

    #[test]
    fn authority_loss_and_cleanup_failures_remain_distinct() {
        let authority_lost = TerminationOutcome::AuthorityLost;
        let cleanup_unconfirmed =
            TerminationOutcome::Failed(TerminationFailure::CleanupUnconfirmed);
        let material_cleanup_failed =
            TerminationOutcome::Failed(TerminationFailure::MaterialCleanupFailed);

        assert!(matches!(authority_lost, TerminationOutcome::AuthorityLost));
        assert!(matches!(
            cleanup_unconfirmed,
            TerminationOutcome::Failed(TerminationFailure::CleanupUnconfirmed)
        ));
        assert!(matches!(
            material_cleanup_failed,
            TerminationOutcome::Failed(TerminationFailure::MaterialCleanupFailed)
        ));
        assert_ne!(cleanup_unconfirmed, material_cleanup_failed);
    }

    #[test]
    fn shutdown_outcomes_distinguish_final_states() {
        let detached = ShutdownOutcome::Detached;
        let terminated = ShutdownOutcome::Terminated(TerminationOutcome::NoProcess);
        let unresolved = ShutdownOutcome::Unresolved {
            failure: TerminationFailure::CleanupUnconfirmed,
        };

        assert!(matches!(detached, ShutdownOutcome::Detached));
        assert!(matches!(
            terminated,
            ShutdownOutcome::Terminated(TerminationOutcome::NoProcess)
        ));
        assert!(matches!(
            unresolved,
            ShutdownOutcome::Unresolved {
                failure: TerminationFailure::CleanupUnconfirmed
            }
        ));
    }
}
