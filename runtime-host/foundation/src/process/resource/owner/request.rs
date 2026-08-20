use tokio::{sync::oneshot, time::Instant};

use super::{Owner, OwnerState, state::Waiter};
use crate::process::Provenance;

use super::super::{
    Activation, ActivationOutcome, BeginCompletion, BeginDrained, ManagedObservation,
    NativeCleanupResult, NativeDetachResult, NativeInstallResult, ResourceEpoch, ResourceEvent,
    ResourceFailure, ResourceShutdown, TerminalOrigin, TerminationFailure,
    client::{EvidenceReply, Request, ShutdownReply},
};

impl Owner {
    pub(super) async fn handle_request(&mut self, request: Request) -> bool {
        match request {
            Request::Begin => self.begin().await,
            Request::WaitDrained {
                expected,
                deadline,
                reply,
            } => {
                self.wait_drained(expected, deadline, reply);
                true
            }
            Request::Kill { expected, reply } => self.kill(expected, reply).await,
            Request::Shutdown { expected, reply } => self.shutdown(expected, reply).await,
        }
    }

    async fn begin(&mut self) -> bool {
        if !matches!(self.state, OwnerState::Empty) {
            return true;
        }
        assert!(self.active_attempt.is_none(), "overlapping launch attempt");
        let Some(epoch) = self.next_epoch else {
            let _ = self.events.send(ResourceEvent::OwnerStopped).await;
            return false;
        };
        self.next_epoch = super::super::advance(epoch);
        self.last_terminal = None;
        self.state = OwnerState::Installing { epoch };
        let accepted = self
            .events
            .send(ResourceEvent::BeginAccepted(epoch))
            .await
            .is_ok();
        let installed = self.install_attempt(epoch).await;
        if !accepted {
            match installed {
                NativeInstallResult::Installed(_, _) => {
                    self.orphaned = true;
                    self.cleanup_unpublished_install(epoch).await;
                }
                NativeInstallResult::Drained(_) => {
                    if !self.cleanup_active_attempt(epoch) {
                        self.state = OwnerState::MaterialCleanupFailed {
                            epoch,
                            terminal: None,
                        };
                        self.orphaned = true;
                    }
                }
                NativeInstallResult::Unresolved { .. } => self.orphaned = true,
            }
            return false;
        }

        let completion = match installed {
            NativeInstallResult::Installed(observation, stdio) => {
                let (activation_sender, activation) = oneshot::channel();
                let (activation_reply, outcome) = oneshot::channel();
                self.state = OwnerState::AwaitingActivation {
                    epoch,
                    observation,
                    activation,
                    activation_reply,
                    terminal: None,
                    unresolved: None,
                };
                BeginCompletion::Installed(ManagedObservation {
                    epoch,
                    observation,
                    stdio: stdio.into_stdio(),
                    activation: Activation {
                        sender: activation_sender,
                        outcome,
                    },
                })
            }
            NativeInstallResult::Drained(drained) => {
                if self.cleanup_active_attempt(epoch) {
                    self.state = OwnerState::Empty;
                    BeginCompletion::Drained(drained)
                } else {
                    self.state = OwnerState::MaterialCleanupFailed {
                        epoch,
                        terminal: None,
                    };
                    BeginCompletion::MaterialCleanupFailed { epoch }
                }
            }
            NativeInstallResult::Unresolved {
                observation,
                failure,
            } => {
                self.state = OwnerState::Unresolved {
                    epoch,
                    observation,
                    failure,
                };
                BeginCompletion::Unresolved {
                    epoch,
                    observation,
                    failure,
                }
            }
        };
        if self
            .events
            .send(ResourceEvent::BeginCompleted { epoch, completion })
            .await
            .is_ok()
        {
            return true;
        }
        match self.state {
            OwnerState::AwaitingActivation { .. } => {
                self.orphaned = true;
                self.cleanup_unpublished_install(epoch).await;
            }
            OwnerState::Unresolved { .. } | OwnerState::MaterialCleanupFailed { .. } => {
                self.orphaned = true;
            }
            _ => {}
        }
        false
    }

    async fn install_attempt(&mut self, epoch: ResourceEpoch) -> NativeInstallResult {
        let attempt = match self
            .materializer
            .as_mut()
            .expect("spawned resource missing launch materializer")
            .materialize()
            .await
        {
            Ok(attempt) => attempt,
            Err(failure) => {
                let (failure, guard) = failure.into_parts();
                if let Some(guard) = guard {
                    assert!(self.active_attempt.is_none(), "overlapping launch attempt");
                    self.active_attempt = Some((epoch, guard));
                }
                return NativeInstallResult::Drained(BeginDrained::LaunchFailed(failure));
            }
        };
        let (request, guard) = attempt.into_parts();
        assert!(self.active_attempt.is_none(), "overlapping launch attempt");
        self.active_attempt = Some((epoch, guard));
        self.adapter.install(request).await
    }

    fn wait_drained(&mut self, expected: ResourceEpoch, deadline: Instant, reply: EvidenceReply) {
        if let Some(evidence) = self.published_terminal(expected) {
            let _ = reply.send(Ok(evidence));
            return;
        }
        if self.authority_lost(expected) {
            let _ = reply.send(Err(ResourceFailure::AuthorityLost));
            return;
        }
        if self.active_epoch() != Some(expected) {
            let _ = reply.send(Err(ResourceFailure::EpochMismatch));
            return;
        }
        self.waiters.push(Waiter {
            epoch: expected,
            deadline: Some(deadline),
            reply,
        });
    }

    async fn kill(&mut self, expected: ResourceEpoch, reply: EvidenceReply) -> bool {
        if let Some(evidence) = self.published_terminal(expected) {
            let _ = reply.send(Ok(evidence));
            return true;
        }
        if self.matching_terminal(expected).is_some() {
            self.waiters.push(Waiter {
                epoch: expected,
                deadline: None,
                reply,
            });
            return true;
        }
        if self.authority_lost(expected) {
            let _ = reply.send(Err(ResourceFailure::AuthorityLost));
            return true;
        }
        if self.active_epoch() != Some(expected) {
            let _ = reply.send(Err(ResourceFailure::EpochMismatch));
            return true;
        }
        self.waiters.push(Waiter {
            epoch: expected,
            deadline: None,
            reply,
        });
        match self.adapter.cleanup().await {
            NativeCleanupResult::AlreadyDrained(exit) => {
                self.commit_terminal(expected, exit, TerminalOrigin::ObservedDrain)
                    .await
            }
            NativeCleanupResult::Terminated(exit) => {
                self.commit_terminal(expected, exit, TerminalOrigin::DestructiveCleanup)
                    .await
            }
            NativeCleanupResult::Unresolved(failure) => {
                self.mark_unresolved(expected, failure).await
            }
        }
    }

    async fn shutdown(&mut self, expected: Option<ResourceEpoch>, reply: ShutdownReply) -> bool {
        let Some(expected) = expected else {
            if matches!(self.state, OwnerState::Empty) {
                let _ = reply.send(Ok(ResourceShutdown::NoResource));
                self.state = OwnerState::Closed;
                return false;
            }
            let _ = reply.send(Err(ResourceFailure::EpochMismatch));
            return true;
        };

        if let OwnerState::MaterialCleanupFailed { epoch, terminal } = &self.state
            && *epoch == expected
        {
            let terminal = terminal.clone();
            if !self.cleanup_active_attempt(expected) {
                let _ = reply.send(Ok(ResourceShutdown::Unresolved(
                    TerminationFailure::MaterialCleanupFailed,
                )));
                return true;
            }
            if let Some(evidence) = terminal {
                self.last_terminal = Some(evidence.clone());
                self.state = OwnerState::Empty;
                self.pending_shutdown = Some(reply);
                return self.finish_terminal(evidence).await;
            }
            let _ = reply.send(Ok(ResourceShutdown::NoResource));
            self.state = OwnerState::Closed;
            return false;
        }
        if let Some(evidence) = self.published_terminal(expected) {
            let _ = reply.send(Ok(ResourceShutdown::Terminated(evidence)));
            self.state = OwnerState::Closed;
            return false;
        }
        if self.matching_terminal(expected).is_some() {
            self.pending_shutdown = Some(reply);
            return true;
        }
        if self.active_epoch() != Some(expected) {
            let _ = reply.send(Err(ResourceFailure::EpochMismatch));
            return true;
        }

        if self.observation(expected).is_some_and(|observation| {
            matches!(observation.provenance(), Provenance::Attached { .. })
        }) {
            return match self.adapter.detach().await {
                NativeDetachResult::Detached => {
                    let _ = reply.send(Ok(ResourceShutdown::Detached));
                    self.state = OwnerState::Closed;
                    false
                }
                NativeDetachResult::Unresolved(failure) => {
                    let _ = reply.send(Ok(ResourceShutdown::Unresolved(failure)));
                    true
                }
            };
        }

        self.pending_shutdown = Some(reply);
        match self.adapter.cleanup().await {
            NativeCleanupResult::AlreadyDrained(exit) => {
                self.commit_terminal(expected, exit, TerminalOrigin::ObservedDrain)
                    .await
            }
            NativeCleanupResult::Terminated(exit) => {
                self.commit_terminal(expected, exit, TerminalOrigin::DestructiveCleanup)
                    .await
            }
            NativeCleanupResult::Unresolved(failure) => {
                let _ = self.mark_unresolved(expected, failure).await;
                if let Some(reply) = self.pending_shutdown.take() {
                    let _ = reply.send(Ok(ResourceShutdown::Unresolved(failure)));
                }
                true
            }
        }
    }

    pub(super) async fn handle_activation(&mut self, activated: bool) -> bool {
        let state = std::mem::replace(&mut self.state, OwnerState::Closing);
        let OwnerState::AwaitingActivation {
            epoch,
            observation,
            activation_reply,
            terminal,
            unresolved,
            ..
        } = state
        else {
            return true;
        };
        if !activated {
            drop(activation_reply);
            if let Some(evidence) = terminal {
                return self.finish_terminal(evidence).await;
            }
            self.state = OwnerState::Active { epoch, observation };
            return match self.adapter.cleanup().await {
                NativeCleanupResult::AlreadyDrained(exit) => {
                    self.commit_terminal(epoch, exit, TerminalOrigin::ObservedDrain)
                        .await
                }
                NativeCleanupResult::Terminated(exit) => {
                    self.commit_terminal(epoch, exit, TerminalOrigin::DestructiveCleanup)
                        .await
                }
                NativeCleanupResult::Unresolved(failure) => {
                    self.finish_unresolved_cleanup(epoch, observation, failure)
                        .await
                }
            };
        }
        if let Some(evidence) = terminal {
            let _ = activation_reply.send(ActivationOutcome::Terminal(evidence.clone()));
            return self.finish_terminal(evidence).await;
        }
        if let Some((observation, failure)) = unresolved {
            let _ = activation_reply.send(ActivationOutcome::Unresolved {
                observation,
                failure,
            });
            self.state = OwnerState::Unresolved {
                epoch,
                observation,
                failure,
            };
            return true;
        }
        self.state = OwnerState::Active { epoch, observation };
        if activation_reply.send(ActivationOutcome::Active).is_ok() {
            return true;
        }
        match self.adapter.cleanup().await {
            NativeCleanupResult::AlreadyDrained(exit) => {
                self.commit_terminal(epoch, exit, TerminalOrigin::ObservedDrain)
                    .await
            }
            NativeCleanupResult::Terminated(exit) => {
                self.commit_terminal(epoch, exit, TerminalOrigin::DestructiveCleanup)
                    .await
            }
            NativeCleanupResult::Unresolved(failure) => {
                self.finish_unresolved_cleanup(epoch, observation, failure)
                    .await
            }
        }
    }
}
