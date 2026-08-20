use std::sync::Arc;

use tokio::time::Instant;

use super::{Owner, OwnerState};
use crate::process::{ProcessObservation, TerminationFailure};

use super::super::{
    NativeCleanupResult, NativePollResult, ResourceEpoch, ResourceEvent, ResourceFailure,
    ResourceShutdown, SharedTerminalEvidence, TerminalEvidence, TerminalOrigin,
    adapter::{AdapterGeneration, AdapterResult, PollOutcome},
};

impl Owner {
    pub(super) async fn handle_wake(&mut self) -> bool {
        self.next_poll_at = Instant::now() + super::POLL_INTERVAL;
        if !matches!(self.state, OwnerState::AwaitingActivation { .. }) {
            self.expire_waiters();
        }
        let epoch = match &self.state {
            OwnerState::AwaitingActivation { epoch, .. }
            | OwnerState::Active { epoch, .. }
            | OwnerState::Unresolved {
                epoch,
                failure: TerminationFailure::CleanupUnconfirmed,
                ..
            } => *epoch,
            _ => return true,
        };
        if self.matching_terminal(epoch).is_some() || self.poll.is_some() {
            return true;
        }
        let Some(ticket) = self.adapter.start_poll().await else {
            return self
                .mark_unresolved(epoch, TerminationFailure::AuthorityLost)
                .await;
        };
        self.poll = Some((epoch, ticket));
        true
    }

    pub(super) async fn handle_poll(&mut self, result: AdapterResult) -> bool {
        let AdapterResult::Poll {
            generation,
            outcome,
        } = result
        else {
            unreachable!("poll command returned a different adapter result");
        };
        let Some((epoch, ticket)) = self.poll.take() else {
            return true;
        };
        if ticket.generation != generation
            || self.active_epoch() != Some(epoch)
            || self.matching_terminal(epoch).is_some()
        {
            return true;
        }
        match outcome {
            PollOutcome::Abandoned | PollOutcome::Completed(NativePollResult::Pending) => true,
            PollOutcome::Completed(NativePollResult::Drained(exit)) => {
                self.commit_terminal(epoch, exit, TerminalOrigin::ObservedDrain)
                    .await
            }
            PollOutcome::Completed(NativePollResult::Unresolved(failure)) => {
                self.mark_unresolved(epoch, failure).await
            }
        }
    }

    pub(super) async fn handle_poll_channel_closed(
        &mut self,
        generation: AdapterGeneration,
    ) -> bool {
        let Some((epoch, ticket)) = self.poll.take() else {
            return true;
        };
        if ticket.generation != generation
            || self.active_epoch() != Some(epoch)
            || self.matching_terminal(epoch).is_some()
        {
            return true;
        }
        self.mark_unresolved(epoch, TerminationFailure::AuthorityLost)
            .await
    }

    fn expire_waiters(&mut self) {
        let now = Instant::now();
        let mut pending = Vec::with_capacity(self.waiters.len());
        for waiter in self.waiters.drain(..) {
            if waiter.deadline.is_some_and(|deadline| deadline <= now) {
                let _ = waiter.reply.send(Err(ResourceFailure::TimedOut));
            } else {
                pending.push(waiter);
            }
        }
        self.waiters = pending;
    }

    pub(super) async fn commit_terminal(
        &mut self,
        epoch: ResourceEpoch,
        exit: crate::process::ExitObservation,
        origin: TerminalOrigin,
    ) -> bool {
        if self.matching_terminal(epoch).is_some() {
            return true;
        }
        let evidence = Arc::new(TerminalEvidence {
            epoch,
            exit,
            origin,
        });
        self.last_terminal = Some(evidence.clone());
        if !self.cleanup_active_attempt(epoch) {
            self.state = OwnerState::MaterialCleanupFailed {
                epoch,
                terminal: Some(evidence.clone()),
            };
            let _ = self
                .events
                .send(ResourceEvent::MaterialCleanupFailed(evidence))
                .await;
            if let Some(reply) = self.pending_shutdown.take() {
                let _ = reply.send(Ok(ResourceShutdown::Unresolved(
                    TerminationFailure::MaterialCleanupFailed,
                )));
            }
            return true;
        }
        match &mut self.state {
            OwnerState::AwaitingActivation {
                epoch: current,
                terminal,
                ..
            } if *current == epoch => {
                *terminal = Some(evidence);
                true
            }
            OwnerState::Active { epoch: current, .. }
            | OwnerState::Unresolved { epoch: current, .. }
                if *current == epoch =>
            {
                self.finish_terminal(evidence).await
            }
            _ => true,
        }
    }

    pub(super) async fn finish_terminal(&mut self, evidence: SharedTerminalEvidence) -> bool {
        self.state = OwnerState::Empty;
        let delivered = self.publish_terminal(evidence.clone()).await;
        if let Some(reply) = self.pending_shutdown.take() {
            let _ = reply.send(Ok(ResourceShutdown::Terminated(evidence)));
            self.state = OwnerState::Closed;
            return false;
        }
        if !delivered {
            self.orphaned = true;
        }
        delivered
    }

    pub(super) async fn finish_unresolved_cleanup(
        &mut self,
        epoch: ResourceEpoch,
        observation: ProcessObservation,
        failure: TerminationFailure,
    ) -> bool {
        let delivered = self.mark_unresolved(epoch, failure).await;
        self.state = OwnerState::Unresolved {
            epoch,
            observation: Some(observation),
            failure,
        };
        if let Some(reply) = self.pending_shutdown.take() {
            let _ = reply.send(Ok(ResourceShutdown::Unresolved(failure)));
        }
        delivered
    }

    pub(super) async fn cleanup_unpublished_install(&mut self, epoch: ResourceEpoch) {
        match self.adapter.cleanup().await {
            NativeCleanupResult::AlreadyDrained(exit) => {
                let _ = self
                    .commit_terminal(epoch, exit, TerminalOrigin::ObservedDrain)
                    .await;
            }
            NativeCleanupResult::Terminated(exit) => {
                let _ = self
                    .commit_terminal(epoch, exit, TerminalOrigin::DestructiveCleanup)
                    .await;
            }
            NativeCleanupResult::Unresolved(failure) => {
                let observation = self.observation(epoch);
                self.state = OwnerState::Unresolved {
                    epoch,
                    observation,
                    failure,
                };
            }
        }
    }

    async fn publish_terminal(&mut self, evidence: SharedTerminalEvidence) -> bool {
        let delivered = self
            .events
            .send(ResourceEvent::NativeFact(evidence.clone()))
            .await
            .is_ok();
        let epoch = evidence.epoch();
        let mut pending = Vec::with_capacity(self.waiters.len());
        for waiter in self.waiters.drain(..) {
            if waiter.epoch == epoch {
                let _ = waiter.reply.send(Ok(evidence.clone()));
            } else {
                pending.push(waiter);
            }
        }
        self.waiters = pending;
        delivered
    }

    pub(super) async fn mark_unresolved(
        &mut self,
        epoch: ResourceEpoch,
        failure: TerminationFailure,
    ) -> bool {
        if self.matching_terminal(epoch).is_some() {
            return true;
        }
        let already_unresolved = matches!(
            self.state,
            OwnerState::Unresolved {
                epoch: current,
                failure: current_failure,
                ..
            } if current == epoch && current_failure == failure
        ) || matches!(
            self.state,
            OwnerState::AwaitingActivation {
                epoch: current,
                unresolved: Some((_, current_failure)),
                ..
            } if current == epoch && current_failure == failure
        );
        let observation = self.observation(epoch);
        if let OwnerState::AwaitingActivation {
            epoch: current,
            unresolved,
            ..
        } = &mut self.state
            && *current == epoch
        {
            *unresolved = Some((observation, failure));
        } else {
            self.state = OwnerState::Unresolved {
                epoch,
                observation,
                failure,
            };
        }
        let mut pending = Vec::with_capacity(self.waiters.len());
        for waiter in self.waiters.drain(..) {
            if waiter.epoch == epoch {
                let _ = waiter.reply.send(Err(failure.into()));
            } else {
                pending.push(waiter);
            }
        }
        self.waiters = pending;
        if already_unresolved {
            return true;
        }
        let delivered = self
            .events
            .send(ResourceEvent::Unresolved {
                epoch,
                observation,
                failure,
            })
            .await
            .is_ok();
        if !delivered {
            self.orphaned = true;
        }
        delivered
    }
}
