use std::{
    panic::{AssertUnwindSafe, resume_unwind},
    time::Duration,
};

use futures_util::FutureExt;
use tokio::{
    sync::{mpsc, oneshot},
    time::{Instant, sleep, sleep_until},
};

use super::{
    LaunchAttemptMaterializer, NativeAdapter, ProcessObservation, ResourceEpoch,
    ResourceEventSender, SharedTerminalEvidence, TerminationFailure,
    adapter::{AdapterGeneration, AdapterOwner, AdapterResult},
    client::Request,
};
use crate::process::task::TaskOwner;

mod request;
mod state;
mod terminal;

use state::{NonRequestCursor, Owner, OwnerState};

pub(super) const POLL_INTERVAL: Duration = Duration::from_millis(5);

enum LoopEvent {
    Request(Option<Request>),
    Activation(bool),
    Poll(AdapterResult),
    PollChannelClosed(AdapterGeneration),
    Wake,
}

#[cfg(test)]
pub(super) fn spawn<A: NativeAdapter>(
    adapter: A,
    materializer: Option<Box<dyn LaunchAttemptMaterializer>>,
    requests: mpsc::Receiver<Request>,
    events: ResourceEventSender,
    initial: Option<(ResourceEpoch, ProcessObservation)>,
    next_epoch: Option<ResourceEpoch>,
) -> TaskOwner<()> {
    TaskOwner::spawn(task(
        adapter,
        materializer,
        requests,
        events,
        initial,
        next_epoch,
    ))
}

pub(super) fn deferred<A: NativeAdapter>(
    adapter: A,
    materializer: Option<Box<dyn LaunchAttemptMaterializer>>,
    requests: mpsc::Receiver<Request>,
    events: ResourceEventSender,
    initial: Option<(ResourceEpoch, ProcessObservation)>,
    next_epoch: Option<ResourceEpoch>,
) -> TaskOwner<()> {
    TaskOwner::deferred(task(
        adapter,
        materializer,
        requests,
        events,
        initial,
        next_epoch,
    ))
}

async fn task<A: NativeAdapter>(
    adapter: A,
    materializer: Option<Box<dyn LaunchAttemptMaterializer>>,
    requests: mpsc::Receiver<Request>,
    events: ResourceEventSender,
    initial: Option<(ResourceEpoch, ProcessObservation)>,
    next_epoch: Option<ResourceEpoch>,
) {
    Owner {
        adapter: AdapterOwner::spawn(adapter),
        materializer,
        active_attempt: None,
        requests,
        events,
        state: match initial {
            Some((epoch, observation)) => OwnerState::Active { epoch, observation },
            None => OwnerState::Empty,
        },
        next_epoch,
        last_terminal: None,
        waiters: Vec::new(),
        pending_shutdown: None,
        poll: None,
        next_poll_at: Instant::now() + POLL_INTERVAL,
        next_non_request: NonRequestCursor::Activation,
        non_request_turn: false,
        orphaned: false,
    }
    .run()
    .await;
}

impl Owner {
    async fn run(mut self) {
        let failure = AssertUnwindSafe(self.drive()).catch_unwind().await.err();
        if failure.is_some() {
            self.orphaned = true;
        }
        if self.orphaned {
            self.settle_after_authority_loss().await;
        }
        self.state = OwnerState::Closed;
        self.adapter.stop().await;
        if let Some(failure) = failure {
            resume_unwind(failure);
        }
    }

    async fn drive(&mut self) {
        loop {
            let event = self.next_event().await;
            self.non_request_turn = matches!(event, LoopEvent::Request(_));
            let keep_running = match event {
                LoopEvent::Request(Some(request)) => self.handle_request(request).await,
                LoopEvent::Request(None) => {
                    self.orphaned = true;
                    false
                }
                LoopEvent::Activation(activated) => self.handle_activation(activated).await,
                LoopEvent::Poll(result) => self.handle_poll(result).await,
                LoopEvent::PollChannelClosed(generation) => {
                    self.handle_poll_channel_closed(generation).await
                }
                LoopEvent::Wake => self.handle_wake().await,
            };
            if !keep_running {
                break;
            }
        }
    }

    async fn next_event(&mut self) -> LoopEvent {
        if self.non_request_turn
            && let Some(event) = self.ready_non_request()
        {
            self.next_non_request = self.next_non_request.next();
            return event;
        }
        let wake = self.next_wake();
        let waiter_wake = self
            .waiters
            .iter()
            .filter_map(|waiter| waiter.deadline)
            .min();
        match &mut self.state {
            OwnerState::AwaitingActivation { activation, .. } => {
                if let Some((_, ticket)) = &mut self.poll {
                    tokio::select! {
                        biased;
                        request = self.requests.recv() => LoopEvent::Request(request),
                        activated = activation => LoopEvent::Activation(activated.is_ok()),
                        result = &mut ticket.result => poll_event(ticket.generation, result),
                        _ = sleep_until(wake) => LoopEvent::Wake,
                    }
                } else {
                    tokio::select! {
                        biased;
                        request = self.requests.recv() => LoopEvent::Request(request),
                        activated = activation => LoopEvent::Activation(activated.is_ok()),
                        _ = sleep_until(wake) => LoopEvent::Wake,
                    }
                }
            }
            OwnerState::Active { .. }
            | OwnerState::Unresolved {
                failure: TerminationFailure::CleanupUnconfirmed,
                ..
            } => {
                if let Some((_, ticket)) = &mut self.poll {
                    tokio::select! {
                        biased;
                        request = self.requests.recv() => LoopEvent::Request(request),
                        result = &mut ticket.result => poll_event(ticket.generation, result),
                        _ = sleep_until(wake) => LoopEvent::Wake,
                    }
                } else {
                    tokio::select! {
                        biased;
                        request = self.requests.recv() => LoopEvent::Request(request),
                        _ = sleep_until(wake) => LoopEvent::Wake,
                    }
                }
            }
            OwnerState::MaterialCleanupFailed { .. }
            | OwnerState::Unresolved {
                failure: TerminationFailure::MaterialCleanupFailed,
                ..
            } => {
                if let Some(deadline) = waiter_wake {
                    tokio::select! {
                        biased;
                        request = self.requests.recv() => LoopEvent::Request(request),
                        _ = sleep_until(deadline) => LoopEvent::Wake,
                    }
                } else {
                    LoopEvent::Request(self.requests.recv().await)
                }
            }
            OwnerState::Empty
            | OwnerState::Unresolved {
                failure: TerminationFailure::AuthorityLost,
                ..
            } => LoopEvent::Request(self.requests.recv().await),
            OwnerState::Installing { .. } | OwnerState::Closing | OwnerState::Closed => {
                LoopEvent::Request(None)
            }
        }
    }

    fn ready_non_request(&mut self) -> Option<LoopEvent> {
        let now = Instant::now();
        for offset in 0..3 {
            let cursor = match offset {
                0 => self.next_non_request,
                1 => self.next_non_request.next(),
                _ => self.next_non_request.next().next(),
            };
            let event = match cursor {
                NonRequestCursor::Activation => self.ready_activation(),
                NonRequestCursor::Poll => self.ready_poll(),
                NonRequestCursor::Wake => (self.next_wake() <= now).then_some(LoopEvent::Wake),
            };
            if event.is_some() {
                self.next_non_request = cursor;
                return event;
            }
        }
        None
    }

    fn ready_activation(&mut self) -> Option<LoopEvent> {
        let OwnerState::AwaitingActivation { activation, .. } = &mut self.state else {
            return None;
        };
        match activation.try_recv() {
            Ok(()) => Some(LoopEvent::Activation(true)),
            Err(oneshot::error::TryRecvError::Closed) => Some(LoopEvent::Activation(false)),
            Err(oneshot::error::TryRecvError::Empty) => None,
        }
    }

    fn ready_poll(&mut self) -> Option<LoopEvent> {
        let (_, ticket) = self.poll.as_mut()?;
        match ticket.result.try_recv() {
            Ok(result) => Some(LoopEvent::Poll(result)),
            Err(oneshot::error::TryRecvError::Closed) => {
                Some(LoopEvent::PollChannelClosed(ticket.generation))
            }
            Err(oneshot::error::TryRecvError::Empty) => None,
        }
    }

    fn next_wake(&self) -> Instant {
        if matches!(self.state, OwnerState::AwaitingActivation { .. }) {
            return self.next_poll_at;
        }
        self.waiters
            .iter()
            .filter_map(|waiter| waiter.deadline)
            .min()
            .map_or(self.next_poll_at, |deadline| {
                deadline.min(self.next_poll_at)
            })
    }

    fn matching_terminal(&self, epoch: ResourceEpoch) -> Option<SharedTerminalEvidence> {
        self.last_terminal
            .as_ref()
            .filter(|evidence| evidence.epoch() == epoch)
            .cloned()
    }

    fn published_terminal(&self, epoch: ResourceEpoch) -> Option<SharedTerminalEvidence> {
        matches!(self.state, OwnerState::Empty | OwnerState::Closed)
            .then(|| self.matching_terminal(epoch))
            .flatten()
    }

    fn authority_lost(&self, epoch: ResourceEpoch) -> bool {
        matches!(
            self.state,
            OwnerState::Unresolved {
                epoch: current,
                failure: TerminationFailure::AuthorityLost,
                ..
            } if current == epoch
        )
    }

    fn cleanup_active_attempt(&mut self, epoch: ResourceEpoch) -> bool {
        let Some((current, guard)) = self.active_attempt.as_mut() else {
            return true;
        };
        assert_eq!(*current, epoch, "launch attempt epoch mismatch");
        if !matches!(
            std::panic::catch_unwind(AssertUnwindSafe(|| guard.cleanup())),
            Ok(Ok(()))
        ) {
            return false;
        }
        self.active_attempt = None;
        true
    }

    async fn settle_after_authority_loss(&mut self) {
        if matches!(
            self.state,
            OwnerState::Unresolved { .. } | OwnerState::MaterialCleanupFailed { .. }
        ) {
            sleep(POLL_INTERVAL).await;
        }
        loop {
            let epoch = self
                .active_epoch()
                .or_else(|| self.active_attempt.as_ref().map(|(epoch, _)| *epoch));
            let Some(epoch) = epoch else {
                return;
            };
            if self.active_attempt.is_none() && self.matching_terminal(epoch).is_some() {
                return;
            }
            if let OwnerState::MaterialCleanupFailed { terminal, .. } = &self.state {
                let terminal = terminal.clone();
                if !self.cleanup_active_attempt(epoch) {
                    sleep(POLL_INTERVAL).await;
                    continue;
                }
                self.last_terminal = terminal;
                return;
            }
            let attached = self.observation(epoch).is_some_and(|observation| {
                matches!(
                    observation.provenance(),
                    crate::process::Provenance::Attached { .. }
                )
            });
            if attached {
                if matches!(
                    self.adapter.detach().await,
                    super::NativeDetachResult::Detached
                ) {
                    return;
                }
            } else {
                match self.adapter.cleanup().await {
                    super::NativeCleanupResult::AlreadyDrained(exit) => {
                        let _ = self
                            .commit_terminal(epoch, exit, super::TerminalOrigin::ObservedDrain)
                            .await;
                        if self.active_attempt.is_none() {
                            return;
                        }
                    }
                    super::NativeCleanupResult::Terminated(exit) => {
                        let _ = self
                            .commit_terminal(epoch, exit, super::TerminalOrigin::DestructiveCleanup)
                            .await;
                        if self.active_attempt.is_none() {
                            return;
                        }
                    }
                    super::NativeCleanupResult::Unresolved(_) => {}
                }
            }
            sleep(POLL_INTERVAL).await;
        }
    }

    fn active_epoch(&self) -> Option<ResourceEpoch> {
        match &self.state {
            OwnerState::Installing { epoch }
            | OwnerState::AwaitingActivation { epoch, .. }
            | OwnerState::Active { epoch, .. }
            | OwnerState::Unresolved { epoch, .. }
            | OwnerState::MaterialCleanupFailed { epoch, .. } => Some(*epoch),
            _ => None,
        }
    }

    fn observation(&self, epoch: ResourceEpoch) -> Option<ProcessObservation> {
        match &self.state {
            OwnerState::AwaitingActivation {
                epoch: current,
                observation,
                ..
            }
            | OwnerState::Active {
                epoch: current,
                observation,
            } if *current == epoch => Some(*observation),
            OwnerState::Unresolved {
                epoch: current,
                observation,
                ..
            } if *current == epoch => *observation,
            _ => None,
        }
    }
}

fn poll_event(
    generation: AdapterGeneration,
    result: Result<AdapterResult, oneshot::error::RecvError>,
) -> LoopEvent {
    result.map_or(LoopEvent::PollChannelClosed(generation), LoopEvent::Poll)
}
