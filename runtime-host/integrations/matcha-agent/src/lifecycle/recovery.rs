use std::{
    sync::{
        Arc,
        atomic::{AtomicU8, Ordering},
    },
    time::Duration,
};

use foundation::process::supervision::{
    LaunchFailure, PolicyFuture, StartRecovery, StartRecoveryResult, SupervisorFailure,
};
use tokio_util::sync::CancellationToken;

const MAX_STARTUP_RECOVERY_ATTEMPTS: u8 = 3;
const STARTUP_RETRY_DELAY: Duration = Duration::from_millis(300);

#[derive(Clone, Copy)]
enum StartupFailure {
    ResourceUnavailable,
    ReadinessFailed,
    Exited,
    Other,
}

pub struct StartupRecovery {
    attempts: Arc<AtomicU8>,
}

impl StartupRecovery {
    pub fn new() -> Self {
        Self {
            attempts: Arc::new(AtomicU8::new(0)),
        }
    }
}

impl Default for StartupRecovery {
    fn default() -> Self {
        Self::new()
    }
}

impl StartRecovery for StartupRecovery {
    fn recover(
        &self,
        failure: SupervisorFailure,
        cancellation: CancellationToken,
    ) -> PolicyFuture<StartRecoveryResult> {
        let attempts = Arc::clone(&self.attempts);

        Box::pin(async move {
            if cancellation.is_cancelled() {
                return StartRecoveryResult::Cancelled;
            }
            if !is_startup_recoverable(classify_startup_failure(&failure)) {
                return StartRecoveryResult::Fail;
            }

            match attempts.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |attempts| {
                (attempts < MAX_STARTUP_RECOVERY_ATTEMPTS).then_some(attempts.saturating_add(1))
            }) {
                Ok(_) => StartRecoveryResult::RetryAfter(STARTUP_RETRY_DELAY),
                Err(_) => StartRecoveryResult::Fail,
            }
        })
    }
}

fn classify_startup_failure(failure: &SupervisorFailure) -> StartupFailure {
    match failure {
        SupervisorFailure::LaunchFailed(LaunchFailure::ResourceUnavailable) => {
            StartupFailure::ResourceUnavailable
        }
        SupervisorFailure::ReadinessFailed => StartupFailure::ReadinessFailed,
        SupervisorFailure::Exited(_) => StartupFailure::Exited,
        _ => StartupFailure::Other,
    }
}

fn is_startup_recoverable(failure: StartupFailure) -> bool {
    matches!(
        failure,
        StartupFailure::ResourceUnavailable
            | StartupFailure::ReadinessFailed
            | StartupFailure::Exited
    )
}

#[cfg(test)]
mod tests {
    use std::{
        future::Future,
        sync::{Arc, Barrier},
        task::{Context, Poll, Waker},
        thread,
    };

    use foundation::process::TerminationFailure;

    use super::*;

    fn resolve(future: PolicyFuture<StartRecoveryResult>) -> StartRecoveryResult {
        let mut context = Context::from_waker(Waker::noop());
        let mut future = future;

        match Future::poll(future.as_mut(), &mut context) {
            Poll::Ready(result) => result,
            Poll::Pending => panic!("startup recovery decision must be immediate"),
        }
    }

    fn recover(policy: &StartupRecovery, failure: SupervisorFailure) -> StartRecoveryResult {
        resolve(policy.recover(failure, CancellationToken::new()))
    }

    #[test]
    fn startup_recovery_retries_only_recoverable_failure_classes() {
        let recoverable = [
            StartupFailure::ResourceUnavailable,
            StartupFailure::ReadinessFailed,
            StartupFailure::Exited,
        ];
        for failure in recoverable {
            assert!(is_startup_recoverable(failure));
        }

        assert!(!is_startup_recoverable(StartupFailure::Other));
    }

    #[test]
    fn maps_typed_supervisor_failures_to_startup_failure_classes() {
        let recoverable = [
            SupervisorFailure::LaunchFailed(LaunchFailure::ResourceUnavailable),
            SupervisorFailure::ReadinessFailed,
        ];
        for failure in recoverable {
            assert!(is_startup_recoverable(classify_startup_failure(&failure)));
        }

        let unrecoverable = [
            SupervisorFailure::LaunchFailed(LaunchFailure::ArtifactUnavailable),
            SupervisorFailure::LaunchFailed(LaunchFailure::PermissionDenied),
            SupervisorFailure::LaunchFailed(LaunchFailure::PlatformRejected),
            SupervisorFailure::StdioFailed,
            SupervisorFailure::Termination(TerminationFailure::AuthorityLost),
            SupervisorFailure::Termination(TerminationFailure::CleanupUnconfirmed),
        ];
        for failure in unrecoverable {
            assert!(matches!(
                classify_startup_failure(&failure),
                StartupFailure::Other
            ));
        }
    }

    #[test]
    fn startup_recovery_budget_is_bounded() {
        let policy = StartupRecovery::new();

        for _ in 0..MAX_STARTUP_RECOVERY_ATTEMPTS {
            assert_eq!(
                recover(&policy, SupervisorFailure::ReadinessFailed),
                StartRecoveryResult::RetryAfter(STARTUP_RETRY_DELAY),
            );
        }
        assert_eq!(
            recover(&policy, SupervisorFailure::ReadinessFailed),
            StartRecoveryResult::Fail,
        );
    }

    #[test]
    fn cancellation_wins_without_consuming_startup_budget() {
        let policy = StartupRecovery::new();
        let cancellation = CancellationToken::new();
        cancellation.cancel();

        assert_eq!(
            resolve(policy.recover(SupervisorFailure::ReadinessFailed, cancellation)),
            StartRecoveryResult::Cancelled,
        );
        for _ in 0..MAX_STARTUP_RECOVERY_ATTEMPTS {
            assert_eq!(
                recover(&policy, SupervisorFailure::ReadinessFailed),
                StartRecoveryResult::RetryAfter(STARTUP_RETRY_DELAY),
            );
        }
    }

    #[test]
    fn concurrent_startup_failures_share_the_bounded_budget() {
        const CALLS: usize = 12;

        let policy = Arc::new(StartupRecovery::new());
        let start = Arc::new(Barrier::new(CALLS));
        let workers = (0..CALLS)
            .map(|_| {
                let policy = Arc::clone(&policy);
                let start = Arc::clone(&start);
                thread::spawn(move || {
                    start.wait();
                    recover(&policy, SupervisorFailure::ReadinessFailed)
                })
            })
            .collect::<Vec<_>>();
        let results = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect::<Vec<_>>();

        assert_eq!(
            results
                .iter()
                .filter(|result| **result == StartRecoveryResult::RetryAfter(STARTUP_RETRY_DELAY))
                .count(),
            MAX_STARTUP_RECOVERY_ATTEMPTS as usize,
        );
        assert_eq!(
            results
                .iter()
                .filter(|result| **result == StartRecoveryResult::Fail)
                .count(),
            CALLS - MAX_STARTUP_RECOVERY_ATTEMPTS as usize,
        );
    }
}
