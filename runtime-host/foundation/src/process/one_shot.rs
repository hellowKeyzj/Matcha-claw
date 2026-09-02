use std::{fmt, time::Duration};

use tokio::time::{Instant, timeout_at};

use crate::execution::OwnedTask;
use tokio_util::sync::CancellationToken;

use super::{
    LaunchAttempt, LaunchAttemptFuture, LaunchAttemptMaterializer, LaunchSpec, ProcessContainment,
    ShutdownOutcome, StdioMode, StdioSpec, supervise,
    supervision::{
        CommandReceipt, CompletionError, GracefulStop, GracefulStopResult, PolicyFuture,
        ReadinessProbe, ReadinessResult, RestartDecision, RestartEpisode, RestartPolicy,
        StartRecovery, StartRecoveryResult, StdioActivation, SupervisorFailure,
    },
};

/// A containment capability validated by the caller before constructing a one-shot run.
#[derive(Clone)]
pub struct OneShotContainment(ProcessContainment);

impl OneShotContainment {
    #[cfg(windows)]
    pub const fn job() -> Self {
        Self(ProcessContainment::job())
    }

    pub const fn from_process_containment(containment: ProcessContainment) -> Self {
        Self(containment)
    }

    pub(crate) fn into_process_containment(self) -> ProcessContainment {
        self.0
    }

    #[cfg(unix)]
    pub fn guardian(
        guardian_executable: std::path::PathBuf,
    ) -> Result<Self, super::InvalidGuardianExecutable> {
        ProcessContainment::guardian(guardian_executable).map(Self)
    }
}

/// An already-validated launch specification for a single contained process attempt.
pub struct OneShotRun {
    launch: LaunchSpec,
    containment: OneShotContainment,
    deadline: Duration,
}

impl OneShotRun {
    pub fn try_new(
        launch: LaunchSpec,
        containment: OneShotContainment,
        deadline: Duration,
    ) -> Result<Self, OneShotFailure> {
        if launch.stdio() != StdioSpec::new(StdioMode::Null, StdioMode::Null, StdioMode::Null) {
            return Err(OneShotFailure::InvalidLaunch);
        }
        if deadline.is_zero() {
            return Err(OneShotFailure::InvalidLaunch);
        }
        Ok(Self {
            launch,
            containment,
            deadline,
        })
    }
}

/// Redacted result for a single bounded attempt. The runner never exposes output, paths, or exit
/// details.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OneShotCompletion {
    UnavailableBeforeDispatch,
    Succeeded,
    Failed,
    OutcomeUnknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OneShotFailure {
    InvalidLaunch,
}

impl fmt::Display for OneShotFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("one-shot process launch is invalid")
    }
}

impl std::error::Error for OneShotFailure {}

/// Foundation-owned adapter for a single contained, null-stdio execution. It maps every failure
/// after dispatch, deadline expiry, cancellation, or unconfirmed supervisor shutdown to
/// `OutcomeUnknown`.
pub struct OneShotRunner;

pub struct OneShotOperation {
    completion: OwnedTask<OneShotCompletion>,
}

impl OneShotOperation {
    pub fn cancel(&self) {
        self.completion.cancel();
    }

    pub async fn wait(&mut self) -> OneShotCompletion {
        self.completion
            .join()
            .await
            .unwrap_or(OneShotCompletion::OutcomeUnknown)
    }

    pub async fn cancel_and_join(&mut self) -> OneShotCompletion {
        self.completion
            .cancel_and_join()
            .await
            .unwrap_or(OneShotCompletion::OutcomeUnknown)
    }
}

impl OneShotRunner {
    pub const fn new() -> Self {
        Self
    }

    pub fn start(&self, run: OneShotRun) -> Result<OneShotOperation, OneShotFailure> {
        let deadline_at = Instant::now()
            .checked_add(run.deadline)
            .ok_or(OneShotFailure::InvalidLaunch)?;
        let (completion, _) =
            OwnedTask::spawn(move |cancellation| Self::run_async(run, deadline_at, cancellation));
        Ok(OneShotOperation { completion })
    }

    async fn run_async(
        run: OneShotRun,
        deadline_at: Instant,
        cancellation: CancellationToken,
    ) -> OneShotCompletion {
        if Instant::now() >= deadline_at {
            return OneShotCompletion::OutcomeUnknown;
        }
        let OneShotRun {
            launch,
            containment,
            ..
        } = run;
        let mut supervisor = supervise(
            containment.0,
            DeadlineBoundLaunch::new(launch, deadline_at),
            NullStdio,
            ImmediateReady,
            NoGracefulStop,
            FailRecovery,
            HaltRestart,
        );
        let handle = supervisor.handle();
        let execution = async {
            if Instant::now() >= deadline_at {
                return Result::<OneShotCompletion, OneShotCompletion>::Ok(
                    OneShotCompletion::OutcomeUnknown,
                );
            }
            let start = settle_start(handle.start().await).await?;
            if Instant::now() >= deadline_at {
                return Ok(OneShotCompletion::OutcomeUnknown);
            }
            if let Some(completion) = start {
                return Ok(completion);
            }
            let mut snapshots = handle.subscribe();
            loop {
                let snapshot = snapshots.borrow().clone();
                if let Some(failure) = snapshot.failure() {
                    return Ok(match failure {
                        SupervisorFailure::Exited(exit) if exit.exit_code() == Some(0) => {
                            OneShotCompletion::Succeeded
                        }
                        SupervisorFailure::Exited(_) => OneShotCompletion::Failed,
                        SupervisorFailure::LaunchFailed(_) => OneShotCompletion::Failed,
                        SupervisorFailure::StdioFailed
                        | SupervisorFailure::ReadinessFailed
                        | SupervisorFailure::Termination(_) => OneShotCompletion::OutcomeUnknown,
                    });
                }
                snapshots
                    .changed()
                    .await
                    .map_err(|_| OneShotCompletion::OutcomeUnknown)?;
            }
        };
        let completion = tokio::select! {
            result = timeout_at(deadline_at, execution) => match result {
                Ok(Ok(completion)) => completion,
                Ok(Err(_)) | Err(_) => OneShotCompletion::OutcomeUnknown,
            },
            _ = cancellation.cancelled() => OneShotCompletion::OutcomeUnknown,
        };
        // Cleanup is deliberately awaited without the execution deadline: containment ownership
        // must be released before its runtime drops. An elapsed deadline has already fixed the
        // completion projection as `OutcomeUnknown`.
        let shutdown_confirmed = shutdown_is_confirmed(handle.shutdown().await).await;
        let joined = supervisor.join().await.is_ok();
        if shutdown_confirmed && joined {
            completion
        } else {
            OneShotCompletion::OutcomeUnknown
        }
    }
}

impl Default for OneShotRunner {
    fn default() -> Self {
        Self::new()
    }
}

struct DeadlineBoundLaunch {
    launch: Option<LaunchSpec>,
    deadline_at: Instant,
}

impl DeadlineBoundLaunch {
    const fn new(launch: LaunchSpec, deadline_at: Instant) -> Self {
        Self {
            launch: Some(launch),
            deadline_at,
        }
    }
}

impl LaunchAttemptMaterializer for DeadlineBoundLaunch {
    fn materialize(&mut self) -> LaunchAttemptFuture {
        let launch = self.launch.take();
        let deadline_at = self.deadline_at;
        Box::pin(async move {
            if Instant::now() >= deadline_at {
                return Err(super::supervision::LaunchFailure::PlatformRejected.into());
            }
            let Some(launch) = launch else {
                return Err(super::supervision::LaunchFailure::PlatformRejected.into());
            };
            Ok(LaunchAttempt::new(launch, ()))
        })
    }
}

async fn shutdown_is_confirmed(receipt: CommandReceipt<ShutdownOutcome>) -> bool {
    match receipt {
        CommandReceipt::Accepted(completion) | CommandReceipt::Shared(completion) => {
            matches!(completion.wait().await, Ok(ShutdownOutcome::Terminated(_)))
        }
        CommandReceipt::AlreadySatisfied => true,
        CommandReceipt::Busy | CommandReceipt::Rejected(_) | CommandReceipt::ShuttingDown => false,
    }
}

async fn settle_start(
    receipt: CommandReceipt<super::supervision::StartOutcome>,
) -> Result<Option<OneShotCompletion>, OneShotCompletion> {
    match receipt {
        CommandReceipt::Accepted(completion) | CommandReceipt::Shared(completion) => {
            match completion.wait().await {
                Ok(super::supervision::StartOutcome::Started) => Ok(None),
                Ok(super::supervision::StartOutcome::Cancelled { .. }) => {
                    Ok(Some(OneShotCompletion::OutcomeUnknown))
                }
                Err(CompletionError::Failed(SupervisorFailure::LaunchFailed(_))) => {
                    Ok(Some(OneShotCompletion::UnavailableBeforeDispatch))
                }
                Err(CompletionError::Failed(SupervisorFailure::Exited(exit))) => {
                    Ok(Some(if exit.exit_code() == Some(0) {
                        OneShotCompletion::Succeeded
                    } else {
                        OneShotCompletion::Failed
                    }))
                }
                Err(_) => Err(OneShotCompletion::OutcomeUnknown),
            }
        }
        CommandReceipt::Busy | CommandReceipt::Rejected(_) => {
            Ok(Some(OneShotCompletion::UnavailableBeforeDispatch))
        }
        CommandReceipt::AlreadySatisfied | CommandReceipt::ShuttingDown => {
            Ok(Some(OneShotCompletion::OutcomeUnknown))
        }
    }
}

#[derive(Clone, Copy)]
struct NullStdio;

impl StdioActivation for NullStdio {
    fn activate(
        &self,
        _: super::ProcessObservation,
        stdio: super::ProcessStdio,
        _: tokio_util::sync::CancellationToken,
    ) -> PolicyFuture<super::StdioActivationResult> {
        Box::pin(async move {
            let (stdin, stdout, stderr) = stdio.into_parts();
            if stdin.is_none() && stdout.is_none() && stderr.is_none() {
                super::StdioActivationResult::Activated(super::StdioDrain::new(async {
                    super::StdioDrainResult::Drained
                }))
            } else {
                super::StdioActivationResult::Unavailable
            }
        })
    }
}

#[derive(Clone, Copy)]
struct ImmediateReady;

impl ReadinessProbe for ImmediateReady {
    fn wait_ready(
        &self,
        _: super::ProcessObservation,
        _: tokio_util::sync::CancellationToken,
    ) -> PolicyFuture<ReadinessResult> {
        Box::pin(async { ReadinessResult::Ready })
    }
}

#[derive(Clone, Copy)]
struct NoGracefulStop;

impl GracefulStop for NoGracefulStop {
    fn grace_period(&self) -> Duration {
        Duration::ZERO
    }

    fn request_stop(
        &self,
        _: super::ProcessObservation,
        _: tokio_util::sync::CancellationToken,
    ) -> PolicyFuture<GracefulStopResult> {
        Box::pin(async { GracefulStopResult::Rejected })
    }
}

#[derive(Clone, Copy)]
struct FailRecovery;

impl StartRecovery for FailRecovery {
    fn recover(
        &self,
        _: SupervisorFailure,
        _: tokio_util::sync::CancellationToken,
    ) -> PolicyFuture<StartRecoveryResult> {
        Box::pin(async { StartRecoveryResult::Fail })
    }
}

#[derive(Clone, Copy)]
struct HaltRestart;

impl RestartPolicy for HaltRestart {
    fn decide(&self, _: &SupervisorFailure, _: RestartEpisode) -> RestartDecision {
        RestartDecision::Halt
    }
}

#[cfg(test)]
mod tests {
    use crate::process::supervision;

    use super::*;

    #[tokio::test]
    async fn start_receipt_maps_pre_dispatch_rejection_and_known_exit() {
        assert_eq!(
            settle_start(CommandReceipt::Rejected(
                supervision::SupervisorRejection::AuthorityLost
            ))
            .await,
            Ok(Some(OneShotCompletion::UnavailableBeforeDispatch))
        );
        assert_eq!(
            settle_start(CommandReceipt::ShuttingDown).await,
            Ok(Some(OneShotCompletion::OutcomeUnknown))
        );
        assert_eq!(
            settle_start(start_failure_receipt(SupervisorFailure::LaunchFailed(
                supervision::LaunchFailure::ArtifactUnavailable,
            )))
            .await,
            Ok(Some(OneShotCompletion::UnavailableBeforeDispatch))
        );
        assert_eq!(
            settle_start(start_failure_receipt(SupervisorFailure::Exited(
                exit_observation(Some(0)),
            )))
            .await,
            Ok(Some(OneShotCompletion::Succeeded))
        );
        assert_eq!(
            settle_start(stopped_start_receipt()).await,
            Err(OneShotCompletion::OutcomeUnknown)
        );
    }

    #[tokio::test]
    async fn expired_launch_materializer_refuses_dispatch() {
        let launch = valid_launch();
        let mut materializer = DeadlineBoundLaunch::new(launch, Instant::now());

        assert!(materializer.materialize().await.is_err());
    }

    #[tokio::test]
    async fn shutdown_confirmation_rejects_detached_unresolved_and_lost_receipts() {
        let detached = receipt(Ok(ShutdownOutcome::Detached));
        let unresolved = receipt(Ok(ShutdownOutcome::Unresolved {
            failure: super::super::TerminationFailure::CleanupUnconfirmed,
        }));
        let lost = stopped_receipt();

        assert!(!shutdown_is_confirmed(detached).await);
        assert!(!shutdown_is_confirmed(unresolved).await);
        assert!(!shutdown_is_confirmed(lost).await);
    }

    #[test]
    fn one_shot_run_rejects_any_non_null_stdio() {
        #[cfg(windows)]
        let executable = std::path::PathBuf::from(r"C:\\trusted\\uv.exe");
        #[cfg(windows)]
        let working_directory = std::path::PathBuf::from(r"C:\\trusted");
        #[cfg(unix)]
        let executable = std::path::PathBuf::from("/trusted/uv");
        #[cfg(unix)]
        let working_directory = std::path::PathBuf::from("/trusted");
        let launch = LaunchSpec::try_new(
            executable,
            working_directory,
            std::iter::empty::<std::ffi::OsString>(),
            std::iter::empty::<(std::ffi::OsString, std::ffi::OsString)>(),
            StdioSpec::new(StdioMode::Null, StdioMode::Piped, StdioMode::Null),
        )
        .unwrap();

        #[cfg(windows)]
        let containment = OneShotContainment::job();
        #[cfg(unix)]
        let containment =
            OneShotContainment::guardian(std::path::PathBuf::from("/trusted/guardian"))
                .expect("absolute guardian is valid");

        assert!(matches!(
            OneShotRun::try_new(launch, containment, Duration::from_secs(1)),
            Err(OneShotFailure::InvalidLaunch)
        ));
    }

    fn valid_launch() -> LaunchSpec {
        #[cfg(windows)]
        let executable = std::path::PathBuf::from(r"C:\\trusted\\uv.exe");
        #[cfg(windows)]
        let working_directory = std::path::PathBuf::from(r"C:\\trusted");
        #[cfg(unix)]
        let executable = std::path::PathBuf::from("/trusted/uv");
        #[cfg(unix)]
        let working_directory = std::path::PathBuf::from("/trusted");
        LaunchSpec::try_new(
            executable,
            working_directory,
            std::iter::empty::<std::ffi::OsString>(),
            std::iter::empty::<(std::ffi::OsString, std::ffi::OsString)>(),
            StdioSpec::new(StdioMode::Null, StdioMode::Null, StdioMode::Null),
        )
        .expect("absolute null-stdio launch is valid")
    }

    fn receipt(
        outcome: Result<ShutdownOutcome, supervision::SupervisorFailure>,
    ) -> CommandReceipt<ShutdownOutcome> {
        let (sender, receiver) = tokio::sync::watch::channel(None);
        sender
            .send(Some(outcome))
            .expect("test receiver remains open");
        CommandReceipt::Accepted(supervision::Completion::new(receiver))
    }

    fn stopped_receipt() -> CommandReceipt<ShutdownOutcome> {
        let (sender, receiver) = tokio::sync::watch::channel(None);
        drop(sender);
        CommandReceipt::Accepted(supervision::Completion::new(receiver))
    }

    fn stopped_start_receipt() -> CommandReceipt<supervision::StartOutcome> {
        let (sender, receiver) = tokio::sync::watch::channel(None);
        drop(sender);
        CommandReceipt::Accepted(supervision::Completion::new(receiver))
    }

    fn start_failure_receipt(
        failure: SupervisorFailure,
    ) -> CommandReceipt<supervision::StartOutcome> {
        let (sender, receiver) = tokio::sync::watch::channel(None);
        sender
            .send(Some(Err(failure)))
            .expect("test receiver remains open");
        CommandReceipt::Accepted(supervision::Completion::new(receiver))
    }

    fn exit_observation(exit_code: Option<i32>) -> super::super::ExitObservation {
        super::super::ExitObservation::new(exit_code, None, std::time::SystemTime::UNIX_EPOCH)
    }
}
