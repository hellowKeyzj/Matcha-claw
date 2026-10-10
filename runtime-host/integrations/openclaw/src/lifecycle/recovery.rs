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

use super::logs::{LifecycleDiagnostic, LifecycleDiagnosticCategory, LifecycleDiagnosticState};

const MAX_STARTUP_RETRIES: u8 = 2;
const RETRY_DELAY: Duration = Duration::from_secs(1);

#[derive(Clone, Copy)]
enum StartupFailure {
    ResourceUnavailable,
    ReadinessFailed,
    Exited,
    Diagnostic(LifecycleDiagnosticCategory),
    Other,
}

pub struct OpenClawStartRecovery {
    first_episode_attempts: Arc<AtomicU8>,
    diagnostics: LifecycleDiagnosticState,
}

impl OpenClawStartRecovery {
    pub fn new() -> Self {
        Self::with_diagnostics(LifecycleDiagnostic::state())
    }

    pub fn with_diagnostics(diagnostics: LifecycleDiagnosticState) -> Self {
        Self {
            first_episode_attempts: Arc::new(AtomicU8::new(0)),
            diagnostics,
        }
    }
}

impl Default for OpenClawStartRecovery {
    fn default() -> Self {
        Self::new()
    }
}

impl StartRecovery for OpenClawStartRecovery {
    fn recover(
        &self,
        failure: SupervisorFailure,
        cancellation: CancellationToken,
    ) -> PolicyFuture<StartRecoveryResult> {
        let first_episode_attempts = Arc::clone(&self.first_episode_attempts);
        let diagnostics = self.diagnostics.clone();

        Box::pin(async move {
            if cancellation.is_cancelled() {
                return StartRecoveryResult::Cancelled;
            }
            match classify_startup_failure_with_diagnostics(&failure, &diagnostics) {
                failure if is_recoverable_startup_failure(failure) => {
                    match first_episode_attempts.fetch_update(
                        Ordering::Relaxed,
                        Ordering::Relaxed,
                        |attempts| {
                            (attempts < MAX_STARTUP_RETRIES).then_some(attempts.saturating_add(1))
                        },
                    ) {
                        Ok(_) => StartRecoveryResult::RetryAfter(RETRY_DELAY),
                        Err(_) => StartRecoveryResult::Fail,
                    }
                }
                _ => StartRecoveryResult::Fail,
            }
        })
    }
}

fn classify_startup_failure_with_diagnostics(
    failure: &SupervisorFailure,
    diagnostics: &LifecycleDiagnosticState,
) -> StartupFailure {
    if matches!(
        failure,
        SupervisorFailure::ReadinessFailed | SupervisorFailure::Exited(_)
    ) {
        if let Some(diagnostic) = latest_startup_diagnostic(diagnostics) {
            return StartupFailure::Diagnostic(diagnostic);
        }
    }
    match failure {
        SupervisorFailure::LaunchFailed(LaunchFailure::ResourceUnavailable) => {
            StartupFailure::ResourceUnavailable
        }
        SupervisorFailure::ReadinessFailed => StartupFailure::ReadinessFailed,
        SupervisorFailure::Exited(_) => StartupFailure::Exited,
        _ => StartupFailure::Other,
    }
}

fn latest_startup_diagnostic(
    diagnostics: &LifecycleDiagnosticState,
) -> Option<LifecycleDiagnosticCategory> {
    let categories = diagnostics.snapshot();
    categories
        .iter()
        .rev()
        .copied()
        .find(|category| {
            is_startup_diagnostic(*category)
                && *category != LifecycleDiagnosticCategory::StartupFailed
        })
        .or_else(|| {
            categories
                .into_iter()
                .rev()
                .find(|category| is_startup_diagnostic(*category))
        })
}

const fn is_startup_diagnostic(category: LifecycleDiagnosticCategory) -> bool {
    matches!(
        category,
        LifecycleDiagnosticCategory::ConfigurationRejected
            | LifecycleDiagnosticCategory::PortConflict
            | LifecycleDiagnosticCategory::BindRejected
            | LifecycleDiagnosticCategory::StartupFailed
    )
}

fn is_recoverable_startup_failure(failure: StartupFailure) -> bool {
    matches!(
        failure,
        StartupFailure::ResourceUnavailable
            | StartupFailure::ReadinessFailed
            | StartupFailure::Exited
            | StartupFailure::Diagnostic(LifecycleDiagnosticCategory::StartupFailed)
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

    fn recover(policy: &OpenClawStartRecovery, failure: SupervisorFailure) -> StartRecoveryResult {
        resolve(policy.recover(failure, CancellationToken::new()))
    }

    fn diagnostic(category: LifecycleDiagnosticCategory) -> LifecycleDiagnostic {
        LifecycleDiagnostic::new(super::super::logs::LogStream::Stderr, category)
    }

    #[test]
    fn retries_only_recoverable_startup_failure_classes() {
        let recoverable = [
            StartupFailure::ResourceUnavailable,
            StartupFailure::ReadinessFailed,
            StartupFailure::Exited,
        ];

        for failure in recoverable {
            assert!(is_recoverable_startup_failure(failure));
        }
        assert!(is_recoverable_startup_failure(StartupFailure::Diagnostic(
            LifecycleDiagnosticCategory::StartupFailed
        )));

        assert!(!is_recoverable_startup_failure(StartupFailure::Diagnostic(
            LifecycleDiagnosticCategory::ConfigurationRejected
        )));
        assert!(!is_recoverable_startup_failure(StartupFailure::Diagnostic(
            LifecycleDiagnosticCategory::PortConflict
        )));
        assert!(!is_recoverable_startup_failure(StartupFailure::Diagnostic(
            LifecycleDiagnosticCategory::BindRejected
        )));
        assert!(!is_recoverable_startup_failure(StartupFailure::Other));
    }

    #[test]
    fn maps_typed_supervisor_failures_to_startup_failure_classes() {
        let recoverable = [
            SupervisorFailure::LaunchFailed(LaunchFailure::ResourceUnavailable),
            SupervisorFailure::ReadinessFailed,
        ];
        let diagnostics = LifecycleDiagnosticState::new();
        for failure in recoverable {
            assert!(is_recoverable_startup_failure(
                classify_startup_failure_with_diagnostics(&failure, &diagnostics)
            ));
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
                classify_startup_failure_with_diagnostics(&failure, &diagnostics),
                StartupFailure::Other
            ));
        }
    }

    #[test]
    fn maps_latest_lifecycle_diagnostic_to_startup_failure_class() {
        let diagnostics = LifecycleDiagnosticState::new();
        diagnostics.record(diagnostic(
            LifecycleDiagnosticCategory::ConfigurationRejected,
        ));
        assert!(matches!(
            classify_startup_failure_with_diagnostics(
                &SupervisorFailure::ReadinessFailed,
                &diagnostics,
            ),
            StartupFailure::Diagnostic(LifecycleDiagnosticCategory::ConfigurationRejected)
        ));

        diagnostics.record(diagnostic(LifecycleDiagnosticCategory::PortConflict));
        assert!(matches!(
            classify_startup_failure_with_diagnostics(
                &SupervisorFailure::ReadinessFailed,
                &diagnostics,
            ),
            StartupFailure::Diagnostic(LifecycleDiagnosticCategory::PortConflict)
        ));
    }

    #[test]
    fn rejects_configuration_port_conflict_and_bind_without_consuming_retry_budget() {
        for category in [
            LifecycleDiagnosticCategory::ConfigurationRejected,
            LifecycleDiagnosticCategory::PortConflict,
            LifecycleDiagnosticCategory::BindRejected,
        ] {
            let diagnostics = LifecycleDiagnosticState::new();
            diagnostics.record(diagnostic(category));
            let policy = OpenClawStartRecovery::with_diagnostics(diagnostics);

            assert_eq!(
                recover(&policy, SupervisorFailure::ReadinessFailed),
                StartRecoveryResult::Fail,
            );
            assert_eq!(
                recover(
                    &policy,
                    SupervisorFailure::LaunchFailed(LaunchFailure::ResourceUnavailable),
                ),
                StartRecoveryResult::RetryAfter(RETRY_DELAY),
            );
        }
    }

    #[test]
    fn first_startup_episode_allows_two_retries_after_the_initial_attempt() {
        let policy = OpenClawStartRecovery::new();

        for _ in 0..MAX_STARTUP_RETRIES {
            assert_eq!(
                recover(&policy, SupervisorFailure::ReadinessFailed),
                StartRecoveryResult::RetryAfter(RETRY_DELAY),
            );
        }
        assert_eq!(
            recover(&policy, SupervisorFailure::ReadinessFailed),
            StartRecoveryResult::Fail,
        );
    }

    #[test]
    fn unrecoverable_failures_do_not_consume_or_reset_the_episode_budget() {
        let policy = OpenClawStartRecovery::new();

        assert_eq!(
            recover(
                &policy,
                SupervisorFailure::LaunchFailed(LaunchFailure::PermissionDenied),
            ),
            StartRecoveryResult::Fail,
        );
        for _ in 0..MAX_STARTUP_RETRIES {
            assert_eq!(
                recover(&policy, SupervisorFailure::ReadinessFailed),
                StartRecoveryResult::RetryAfter(RETRY_DELAY),
            );
        }
        assert_eq!(
            recover(
                &policy,
                SupervisorFailure::LaunchFailed(LaunchFailure::ArtifactUnavailable),
            ),
            StartRecoveryResult::Fail,
        );
        assert_eq!(
            recover(&policy, SupervisorFailure::ReadinessFailed),
            StartRecoveryResult::Fail,
        );
    }

    #[test]
    fn cancellation_precedes_failure_classification_and_budget_consumption() {
        let policy = OpenClawStartRecovery::new();
        let cancellation = CancellationToken::new();
        cancellation.cancel();

        assert_eq!(
            resolve(policy.recover(
                SupervisorFailure::LaunchFailed(LaunchFailure::PermissionDenied),
                cancellation.clone(),
            )),
            StartRecoveryResult::Cancelled,
        );
        assert_eq!(
            resolve(policy.recover(SupervisorFailure::ReadinessFailed, cancellation)),
            StartRecoveryResult::Cancelled,
        );
        for _ in 0..MAX_STARTUP_RETRIES {
            assert_eq!(
                recover(&policy, SupervisorFailure::ReadinessFailed),
                StartRecoveryResult::RetryAfter(RETRY_DELAY),
            );
        }
    }

    #[test]
    fn concurrent_failures_share_one_two_retry_budget() {
        const CALLS: usize = 12;

        let policy = Arc::new(OpenClawStartRecovery::new());
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
                .filter(|result| **result == StartRecoveryResult::RetryAfter(RETRY_DELAY))
                .count(),
            MAX_STARTUP_RETRIES as usize,
        );
        assert_eq!(
            results
                .iter()
                .filter(|result| **result == StartRecoveryResult::Fail)
                .count(),
            CALLS - MAX_STARTUP_RETRIES as usize,
        );
    }

    #[test]
    fn a_new_policy_instance_starts_a_new_first_episode() {
        let exhausted = OpenClawStartRecovery::new();
        for _ in 0..MAX_STARTUP_RETRIES {
            assert_eq!(
                recover(&exhausted, SupervisorFailure::ReadinessFailed),
                StartRecoveryResult::RetryAfter(RETRY_DELAY),
            );
        }
        assert_eq!(
            recover(&exhausted, SupervisorFailure::ReadinessFailed),
            StartRecoveryResult::Fail,
        );

        assert_eq!(
            recover(
                &OpenClawStartRecovery::new(),
                SupervisorFailure::ReadinessFailed,
            ),
            StartRecoveryResult::RetryAfter(RETRY_DELAY),
        );
    }
}
