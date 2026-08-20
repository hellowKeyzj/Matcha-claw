use std::{
    collections::VecDeque,
    sync::Mutex,
    time::{Duration, Instant},
};

use foundation::process::supervision::{
    RestartDecision, RestartEpisode, RestartPolicy, SupervisorFailure,
};

const MAX_RESTART_ATTEMPTS: usize = 6;
const RESTART_WINDOW: Duration = Duration::from_secs(60);
const RESTART_BASE_DELAY: Duration = Duration::from_millis(300);
const RESTART_MAX_DELAY: Duration = Duration::from_secs(5);

#[derive(Clone, Copy)]
enum RestartFailure {
    Exited,
    Other,
}

pub struct CrashRestartPolicy {
    crashes: Mutex<VecDeque<Instant>>,
}

impl CrashRestartPolicy {
    pub fn new() -> Self {
        Self {
            crashes: Mutex::new(VecDeque::with_capacity(MAX_RESTART_ATTEMPTS + 1)),
        }
    }

    fn decide_at(
        &self,
        failure: &SupervisorFailure,
        episode: RestartEpisode,
        now: Instant,
    ) -> RestartDecision {
        self.decide_for_failure(classify_restart_failure(failure), episode, now)
    }

    fn decide_for_failure(
        &self,
        failure: RestartFailure,
        episode: RestartEpisode,
        now: Instant,
    ) -> RestartDecision {
        if !matches!(failure, RestartFailure::Exited) || episode.settled_failures() == 0 {
            return RestartDecision::Halt;
        }

        let Ok(mut crashes) = self.crashes.lock() else {
            return RestartDecision::Halt;
        };
        if episode.settled_failures() == 1 {
            crashes.clear();
        }
        crashes.retain(|crash| {
            now.checked_duration_since(*crash)
                .is_some_and(|age| age <= RESTART_WINDOW)
        });
        crashes.push_back(now);

        let attempt = crashes.len();
        if attempt > MAX_RESTART_ATTEMPTS {
            return RestartDecision::Halt;
        }

        RestartDecision::RestartAfter(restart_delay(attempt))
    }
}

fn classify_restart_failure(failure: &SupervisorFailure) -> RestartFailure {
    match failure {
        SupervisorFailure::Exited(_) => RestartFailure::Exited,
        _ => RestartFailure::Other,
    }
}

impl Default for CrashRestartPolicy {
    fn default() -> Self {
        Self::new()
    }
}

impl RestartPolicy for CrashRestartPolicy {
    fn decide(&self, failure: &SupervisorFailure, episode: RestartEpisode) -> RestartDecision {
        self.decide_at(failure, episode, Instant::now())
    }
}

fn restart_delay(attempt: usize) -> Duration {
    let exponent = u32::try_from(attempt.saturating_sub(1)).unwrap_or(u32::MAX);
    let multiplier = 2_u32.checked_pow(exponent).unwrap_or(u32::MAX);
    RESTART_BASE_DELAY
        .saturating_mul(multiplier)
        .min(RESTART_MAX_DELAY)
}

#[cfg(test)]
mod tests {
    use foundation::process::TerminationFailure;
    use foundation::process::supervision::LaunchFailure;

    use super::*;

    #[test]
    fn crash_restart_backoff_is_exponential_and_capped_inside_the_window() {
        let policy = CrashRestartPolicy::new();
        let start = Instant::now();
        let expected = [300, 600, 1_200, 2_400, 4_800, 5_000];

        for (offset, expected_millis) in expected.into_iter().enumerate() {
            assert_eq!(
                policy.decide_for_failure(
                    RestartFailure::Exited,
                    RestartEpisode::from_settled_failures((offset + 1) as u32),
                    start + Duration::from_millis(offset as u64),
                ),
                RestartDecision::RestartAfter(Duration::from_millis(expected_millis)),
            );
        }
        assert_eq!(
            policy.decide_for_failure(
                RestartFailure::Exited,
                RestartEpisode::from_settled_failures((MAX_RESTART_ATTEMPTS + 1) as u32),
                start + Duration::from_millis(6),
            ),
            RestartDecision::Halt,
        );
    }

    #[test]
    fn a_new_restart_episode_resets_the_crash_window() {
        let policy = CrashRestartPolicy::new();
        let start = Instant::now();

        for offset in 0..MAX_RESTART_ATTEMPTS {
            assert!(matches!(
                policy.decide_for_failure(
                    RestartFailure::Exited,
                    RestartEpisode::from_settled_failures((offset + 1) as u32),
                    start + Duration::from_millis(offset as u64),
                ),
                RestartDecision::RestartAfter(_),
            ));
        }

        assert_eq!(
            policy.decide_for_failure(
                RestartFailure::Exited,
                RestartEpisode::from_settled_failures(1),
                start + Duration::from_millis(MAX_RESTART_ATTEMPTS as u64),
            ),
            RestartDecision::RestartAfter(RESTART_BASE_DELAY),
        );
    }

    #[test]
    fn expired_crashes_leave_the_sliding_window() {
        let policy = CrashRestartPolicy::new();
        let start = Instant::now();
        assert_eq!(
            policy.decide_for_failure(
                RestartFailure::Exited,
                RestartEpisode::from_settled_failures(1),
                start,
            ),
            RestartDecision::RestartAfter(RESTART_BASE_DELAY),
        );
        assert_eq!(
            policy.decide_for_failure(
                RestartFailure::Exited,
                RestartEpisode::from_settled_failures(2),
                start + RESTART_WINDOW + Duration::from_nanos(1),
            ),
            RestartDecision::RestartAfter(RESTART_BASE_DELAY),
        );
    }

    #[test]
    fn non_crash_and_zero_episode_fail_closed_without_consuming_the_window() {
        let policy = CrashRestartPolicy::new();
        let now = Instant::now();
        assert_eq!(
            policy.decide_for_failure(RestartFailure::Exited, RestartEpisode::initial(), now),
            RestartDecision::Halt,
        );
        assert_eq!(
            policy.decide_for_failure(
                RestartFailure::Other,
                RestartEpisode::from_settled_failures(1),
                now,
            ),
            RestartDecision::Halt,
        );

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
            assert!(matches!(
                classify_restart_failure(&failure),
                RestartFailure::Other
            ));
        }

        assert_eq!(
            policy.decide_for_failure(
                RestartFailure::Exited,
                RestartEpisode::from_settled_failures(1),
                now,
            ),
            RestartDecision::RestartAfter(RESTART_BASE_DELAY),
        );
    }
}
