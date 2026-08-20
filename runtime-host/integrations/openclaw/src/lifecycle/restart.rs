use std::time::Duration;

use foundation::process::supervision::{
    RestartDecision, RestartEpisode, RestartPolicy, SupervisorFailure,
};

const MAX_RESTART_ATTEMPTS: u32 = 10;
const CRASH_BACKOFF: [Duration; 6] = [
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(4),
    Duration::from_secs(8),
    Duration::from_secs(16),
    Duration::from_secs(30),
];

#[derive(Clone, Copy)]
enum RestartFailure {
    Exited,
    Other,
}

pub struct OpenClawRestartPolicy;

impl RestartPolicy for OpenClawRestartPolicy {
    fn decide(&self, failure: &SupervisorFailure, episode: RestartEpisode) -> RestartDecision {
        restart_decision(failure, episode.settled_failures())
    }
}

fn restart_decision(failure: &SupervisorFailure, settled_failures: u32) -> RestartDecision {
    restart_decision_for_failure(classify_restart_failure(failure), settled_failures)
}

fn classify_restart_failure(failure: &SupervisorFailure) -> RestartFailure {
    match failure {
        SupervisorFailure::Exited(_) => RestartFailure::Exited,
        _ => RestartFailure::Other,
    }
}

fn restart_decision_for_failure(failure: RestartFailure, settled_failures: u32) -> RestartDecision {
    if !matches!(failure, RestartFailure::Exited)
        || settled_failures == 0
        || settled_failures > MAX_RESTART_ATTEMPTS
    {
        return RestartDecision::Halt;
    }

    let backoff_index = (settled_failures - 1).min(CRASH_BACKOFF.len() as u32 - 1) as usize;
    RestartDecision::RestartAfter(CRASH_BACKOFF[backoff_index])
}

#[cfg(test)]
mod tests {
    use foundation::process::TerminationFailure;
    use foundation::process::supervision::LaunchFailure;

    use super::*;

    #[test]
    fn crash_backoff_follows_the_bounded_sequence() {
        let expected_delays = [1, 2, 4, 8, 16, 30, 30];

        for (episode, expected_seconds) in (1..).zip(expected_delays) {
            assert_eq!(
                restart_decision_for_failure(RestartFailure::Exited, episode),
                RestartDecision::RestartAfter(Duration::from_secs(expected_seconds)),
            );
        }
    }

    #[test]
    fn restart_episode_boundaries_fail_closed() {
        assert_eq!(
            restart_decision_for_failure(RestartFailure::Exited, 0),
            RestartDecision::Halt
        );
        assert_eq!(
            restart_decision_for_failure(RestartFailure::Exited, 1),
            RestartDecision::RestartAfter(Duration::from_secs(1))
        );
        assert_eq!(
            restart_decision_for_failure(RestartFailure::Exited, 6),
            RestartDecision::RestartAfter(Duration::from_secs(30))
        );
        assert_eq!(
            restart_decision_for_failure(RestartFailure::Exited, 10),
            RestartDecision::RestartAfter(Duration::from_secs(30))
        );
        assert_eq!(
            restart_decision_for_failure(RestartFailure::Exited, 11),
            RestartDecision::Halt
        );
        assert_eq!(
            restart_decision_for_failure(RestartFailure::Exited, u32::MAX),
            RestartDecision::Halt
        );
    }

    #[test]
    fn unexpected_exit_restarts() {
        assert_eq!(
            restart_decision_for_failure(RestartFailure::Exited, 1),
            RestartDecision::RestartAfter(Duration::from_secs(1))
        );
    }

    #[test]
    fn non_crash_failures_halt() {
        let failures = [
            SupervisorFailure::LaunchFailed(LaunchFailure::ArtifactUnavailable),
            SupervisorFailure::LaunchFailed(LaunchFailure::PermissionDenied),
            SupervisorFailure::LaunchFailed(LaunchFailure::ResourceUnavailable),
            SupervisorFailure::LaunchFailed(LaunchFailure::PlatformRejected),
            SupervisorFailure::StdioFailed,
            SupervisorFailure::ReadinessFailed,
            SupervisorFailure::Termination(TerminationFailure::AuthorityLost),
            SupervisorFailure::Termination(TerminationFailure::CleanupUnconfirmed),
        ];

        for failure in failures {
            assert_eq!(restart_decision(&failure, 1), RestartDecision::Halt);
            assert!(matches!(
                classify_restart_failure(&failure),
                RestartFailure::Other
            ));
        }
    }
}
