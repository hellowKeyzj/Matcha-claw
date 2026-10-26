use std::{fmt, sync::Arc};

use tokio::sync::Mutex;

use foundation::process::{
    ShutdownOutcome, TerminationOutcome,
    supervision::{
        CommandReceipt, CompletionError, RestartOutcome, StartOutcome, Supervisor, SupervisorHandle,
        SupervisorLease, SupervisorOutcome, SupervisorRejection, SupervisorSnapshot,
        TerminationCompletion,
    },
};

pub struct SupervisorOwner {
    lifecycle: SupervisorLifecycleHandle,
    supervisor: Supervisor,
}

#[derive(Clone)]
pub struct SupervisorLifecycleHandle {
    handle: SupervisorHandle,
    closed: Arc<Mutex<bool>>,
    shutdown: Arc<Mutex<ShutdownConfirmation>>,
    mcp_oauth: Arc<crate::surfaces::connectors::oauth::McpOAuth>,
}

#[derive(Default)]
struct ShutdownConfirmation {
    stop_result: Option<Result<Option<TerminationOutcome>, SupervisorShutdownFailureKind>>,
    outcome: Option<Result<ShutdownOutcome, SupervisorShutdownFailureKind>>,
}

impl SupervisorOwner {
    pub(crate) fn new(
        supervisor: Supervisor,
        mcp_oauth: Arc<crate::surfaces::connectors::oauth::McpOAuth>,
    ) -> Self {
        Self {
            lifecycle: SupervisorLifecycleHandle {
                handle: supervisor.handle(),
                closed: Arc::new(Mutex::new(false)),
                shutdown: Arc::new(Mutex::new(ShutdownConfirmation::default())),
                mcp_oauth,
            },
            supervisor,
        }
    }

    pub fn lifecycle_handle(&self) -> SupervisorLifecycleHandle {
        self.lifecycle.clone()
    }

    pub fn begin_join(self) -> PendingSupervisorJoin {
        let mut supervisor = self.supervisor;
        let mcp_oauth = self.lifecycle.mcp_oauth;
        PendingSupervisorJoin {
            task: tokio::spawn(async move {
                let oauth_reaped = mcp_oauth.close_and_join().await;
                supervisor.join().await.map_err(SupervisorJoinError::from)?;
                if oauth_reaped {
                    Ok(())
                } else {
                    Err(SupervisorJoinError::CleanupFailed)
                }
            }),
        }
    }
}

impl SupervisorLifecycleHandle {
    pub fn snapshot(&self) -> SupervisorSnapshot {
        self.handle.snapshot()
    }

    pub fn lease(&self) -> Option<SupervisorLease> {
        self.handle.lease()
    }

    pub fn subscribe(&self) -> tokio::sync::watch::Receiver<SupervisorSnapshot> {
        self.handle.subscribe()
    }

    pub(crate) async fn enqueue_start(&self) -> CommandReceipt<StartOutcome> {
        let closed = self.closed.lock().await;
        if *closed {
            return CommandReceipt::ShuttingDown;
        }
        self.handle.start().await
    }

    pub(crate) async fn enqueue_restart(&self) -> CommandReceipt<RestartOutcome> {
        let closed = self.closed.lock().await;
        if *closed {
            return CommandReceipt::ShuttingDown;
        }
        self.handle.restart().await
    }

    pub(crate) async fn enqueue_stop(&self) -> CommandReceipt<TerminationCompletion> {
        let closed = self.closed.lock().await;
        if *closed {
            return CommandReceipt::ShuttingDown;
        }
        self.handle.stop().await
    }

    pub async fn confirm_shutdown(&self) -> Result<ShutdownOutcome, SupervisorShutdownFailureKind> {
        let process = platform::trace::enabled()
            .then(|| self.handle.snapshot().process())
            .flatten();
        platform::trace::runtime_trace("openclaw.shutdown.confirm", || {
            serde_json::json!({
                "phase": "start",
                "pid": process.map(|process| process.identity().pid()),
                "processIdentityHash": process.map(|process| {
                    platform::trace::identifier_hash(&format!("{:?}", process.identity()))
                }),
            })
        });
        let oauth_reaped = self.mcp_oauth.close_and_join().await;
        let result = self.stop_and_shutdown().await;
        let result = if oauth_reaped {
            result
        } else {
            Err(SupervisorShutdownFailureKind::CompletionFailed)
        };
        platform::trace::runtime_trace("openclaw.shutdown.confirm", || {
            use foundation::process::TerminationOutcome;

            let (outcome, exit, reason) = match &result {
                Ok(ShutdownOutcome::Detached) => ("detached", None, None),
                Ok(ShutdownOutcome::Terminated(TerminationOutcome::Forced(exit))) => {
                    ("forced", Some(exit), None)
                }
                Ok(ShutdownOutcome::Terminated(TerminationOutcome::Graceful(exit))) => {
                    ("graceful", Some(exit), None)
                }
                Ok(ShutdownOutcome::Terminated(TerminationOutcome::NoProcess)) => {
                    ("no_process", None, None)
                }
                Ok(ShutdownOutcome::Terminated(TerminationOutcome::AuthorityLost)) => {
                    ("authority_lost", None, None)
                }
                Ok(ShutdownOutcome::Terminated(TerminationOutcome::Failed(failure))) => {
                    ("failed", None, Some(format!("{failure:?}")))
                }
                Ok(ShutdownOutcome::Unresolved { failure }) => {
                    ("unresolved", None, Some(format!("{failure:?}")))
                }
                Err(error) => ("confirmation_failed", None, Some(format!("{error:?}"))),
            };
            serde_json::json!({
                "phase": "settle",
                "pid": process.map(|process| process.identity().pid()),
                "processIdentityHash": process.map(|process| {
                    platform::trace::identifier_hash(&format!("{:?}", process.identity()))
                }),
                "outcome": outcome,
                "reason": reason,
                "exitCode": exit.and_then(|exit| exit.exit_code()),
                "signal": exit.and_then(|exit| exit.signal()),
            })
        });
        result
    }

    async fn stop_and_shutdown(&self) -> Result<ShutdownOutcome, SupervisorShutdownFailureKind> {
        let mut confirmation = self.shutdown.lock().await;
        if let Some(outcome) = &confirmation.outcome {
            return outcome.clone();
        }
        if confirmation.stop_result.is_none() {
            let receipt = {
                let mut closed = self.closed.lock().await;
                *closed = true;
                self.handle.stop().await
            };
            confirmation.stop_result = Some(self.confirm_stop(receipt).await);
        }
        let shutdown = match self.handle.shutdown().await {
            CommandReceipt::Accepted(completion) | CommandReceipt::Shared(completion) => {
                completion.wait().await.map_err(|error| {
                    eprintln!("[openclaw-stop] supervisor shutdown completion failed: {error}");
                    SupervisorShutdownFailureKind::from(error)
                })
            }
            CommandReceipt::AlreadySatisfied => self
                .confirmed_shutdown_outcome()
                .ok_or(SupervisorShutdownFailureKind::MissingOutcome),
            CommandReceipt::Busy => Err(SupervisorShutdownFailureKind::Busy),
            CommandReceipt::Rejected(rejection) => {
                Err(SupervisorShutdownFailureKind::Rejected(rejection))
            }
            CommandReceipt::ShuttingDown => Err(SupervisorShutdownFailureKind::ShuttingDown),
        };
        let finalized = matches!(
            &shutdown,
            Ok(ShutdownOutcome::Terminated(_) | ShutdownOutcome::Detached)
        );
        let outcome = match &shutdown {
            Ok(ShutdownOutcome::Terminated(TerminationOutcome::NoProcess)) => {
                match confirmation
                    .stop_result
                    .as_ref()
                    .expect("stop confirmation recorded")
                {
                    Ok(Some(outcome)) => Ok(ShutdownOutcome::Terminated(outcome.clone())),
                    Err(error) => Err(*error),
                    Ok(None) => shutdown,
                }
            }
            _ => shutdown,
        };
        if finalized {
            confirmation.outcome = Some(outcome.clone());
        }
        outcome
    }

    async fn confirm_stop(
        &self,
        receipt: CommandReceipt<TerminationCompletion>,
    ) -> Result<Option<TerminationOutcome>, SupervisorShutdownFailureKind> {
        let completion = match receipt {
            CommandReceipt::Accepted(completion) | CommandReceipt::Shared(completion) => {
                match completion.wait().await {
                    Ok(completion) => completion,
                    Err(error) => {
                        eprintln!("[openclaw-stop] stop completion failed: {error}");
                        return Err(SupervisorShutdownFailureKind::from(error));
                    }
                }
            }
            CommandReceipt::AlreadySatisfied => {
                return Ok(match self.handle.snapshot().last_outcome() {
                    Some(SupervisorOutcome::Terminated(
                        TerminationCompletion::Completed(outcome)
                        | TerminationCompletion::Superseded {
                            final_outcome: outcome,
                            ..
                        },
                    )) => Some(outcome.clone()),
                    _ => None,
                });
            }
            CommandReceipt::Rejected(SupervisorRejection::NoTerminationAuthority) => {
                return Ok(None);
            }
            CommandReceipt::Busy => return Err(SupervisorShutdownFailureKind::Busy),
            CommandReceipt::Rejected(rejection) => {
                return Err(SupervisorShutdownFailureKind::Rejected(rejection));
            }
            CommandReceipt::ShuttingDown => {
                return Err(SupervisorShutdownFailureKind::ShuttingDown);
            }
        };
        let outcome = match completion {
            TerminationCompletion::Completed(outcome)
            | TerminationCompletion::Superseded {
                final_outcome: outcome,
                ..
            } => outcome,
        };
        Ok(Some(outcome))
    }

    fn confirmed_shutdown_outcome(&self) -> Option<ShutdownOutcome> {
        match self.handle.snapshot().last_outcome() {
            Some(SupervisorOutcome::ShutDown(outcome)) => Some(outcome.clone()),
            _ => None,
        }
    }
}

pub struct PendingSupervisorJoin {
    task: tokio::task::JoinHandle<Result<(), SupervisorJoinError>>,
}

impl PendingSupervisorJoin {
    pub async fn wait(&mut self) -> Result<(), SupervisorJoinError> {
        (&mut self.task).await.map_err(SupervisorJoinError::from)?
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SupervisorShutdownFailureKind {
    CompletionFailed,
    SupervisorStopped,
    Busy,
    Rejected(SupervisorRejection),
    ShuttingDown,
    MissingOutcome,
}

impl From<CompletionError> for SupervisorShutdownFailureKind {
    fn from(error: CompletionError) -> Self {
        match error {
            CompletionError::Failed(_) => Self::CompletionFailed,
            CompletionError::SupervisorStopped => Self::SupervisorStopped,
        }
    }
}

impl fmt::Display for SupervisorShutdownFailureKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::CompletionFailed => formatter.write_str("supervisor shutdown failed"),
            Self::SupervisorStopped => {
                formatter.write_str("supervisor stopped before shutdown completed")
            }
            Self::Busy => formatter.write_str("supervisor shutdown was busy"),
            Self::Rejected(_) => formatter.write_str("supervisor shutdown was rejected"),
            Self::ShuttingDown => formatter.write_str("supervisor stopped accepting shutdown"),
            Self::MissingOutcome => {
                formatter.write_str("supervisor shutdown outcome was unavailable")
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SupervisorJoinError {
    Cancelled,
    Panicked,
    CleanupFailed,
}

impl From<tokio::task::JoinError> for SupervisorJoinError {
    fn from(error: tokio::task::JoinError) -> Self {
        if error.is_cancelled() {
            Self::Cancelled
        } else {
            Self::Panicked
        }
    }
}

impl fmt::Display for SupervisorJoinError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Cancelled => formatter.write_str("supervisor task was cancelled"),
            Self::Panicked => formatter.write_str("supervisor task panicked"),
            Self::CleanupFailed => formatter.write_str("OpenClaw OAuth process cleanup failed"),
        }
    }
}

impl std::error::Error for SupervisorJoinError {}
