use std::panic::AssertUnwindSafe;

use futures_util::FutureExt;
use tokio::sync::{mpsc, oneshot};

use super::{
    LaunchRequest, NativeAdapter, NativeCleanupResult, NativeDetachResult, NativeInstallResult,
    NativePollResult, TerminationFailure,
};
use crate::process::task::TaskOwner;

const CHANNEL_CAPACITY: usize = 2;

#[derive(Clone, Copy, Eq, PartialEq)]
pub(super) struct AdapterGeneration(u64);

pub(super) enum PollOutcome {
    Completed(NativePollResult),
    Abandoned,
}

pub(super) enum AdapterResult {
    Install(NativeInstallResult),
    Poll {
        generation: AdapterGeneration,
        outcome: PollOutcome,
    },
    Cleanup(NativeCleanupResult),
    Detach(NativeDetachResult),
}

pub(super) struct PollTicket {
    pub(super) generation: AdapterGeneration,
    pub(super) result: oneshot::Receiver<AdapterResult>,
}

enum AdapterOperation {
    Install(LaunchRequest),
    Poll(AdapterGeneration),
    Cleanup,
    Detach,
    Stop,
}

struct AdapterCommand {
    operation: AdapterOperation,
    reply: Option<oneshot::Sender<AdapterResult>>,
}

pub(super) struct AdapterOwner {
    commands: mpsc::Sender<AdapterCommand>,
    task: TaskOwner<()>,
    next_poll_generation: Option<u64>,
}

impl AdapterOwner {
    pub(super) fn spawn<A: NativeAdapter>(adapter: A) -> Self {
        let (commands, receiver) = mpsc::channel(CHANNEL_CAPACITY);
        Self {
            commands,
            task: TaskOwner::spawn(run(adapter, receiver)),
            next_poll_generation: Some(0),
        }
    }

    pub(super) async fn install(&self, request: LaunchRequest) -> NativeInstallResult {
        self.install_operation(AdapterOperation::Install(request))
            .await
    }

    async fn install_operation(&self, operation: AdapterOperation) -> NativeInstallResult {
        match self.call(operation).await {
            Some(AdapterResult::Install(result)) => result,
            Some(_) => unreachable!("install command returned a different adapter result"),
            None => NativeInstallResult::Unresolved {
                observation: None,
                failure: TerminationFailure::AuthorityLost,
            },
        }
    }

    pub(super) async fn start_poll(&mut self) -> Option<PollTicket> {
        let generation = AdapterGeneration(self.next_poll_generation?);
        self.next_poll_generation = generation.0.checked_add(1);
        let (reply, result) = oneshot::channel();
        self.commands
            .send(AdapterCommand {
                operation: AdapterOperation::Poll(generation),
                reply: Some(reply),
            })
            .await
            .ok()?;
        Some(PollTicket { generation, result })
    }

    pub(super) async fn cleanup(&self) -> NativeCleanupResult {
        match self.call(AdapterOperation::Cleanup).await {
            Some(AdapterResult::Cleanup(result)) => result,
            Some(_) => unreachable!("cleanup command returned a different adapter result"),
            None => NativeCleanupResult::Unresolved(TerminationFailure::AuthorityLost),
        }
    }

    pub(super) async fn detach(&self) -> NativeDetachResult {
        match self.call(AdapterOperation::Detach).await {
            Some(AdapterResult::Detach(result)) => result,
            Some(_) => unreachable!("detach command returned a different adapter result"),
            None => NativeDetachResult::Unresolved(TerminationFailure::AuthorityLost),
        }
    }

    pub(super) async fn stop(&mut self) {
        self.finish(AdapterOperation::Stop).await;
    }

    async fn finish(&mut self, operation: AdapterOperation) {
        if !self.task.is_finished() {
            let _ = self
                .commands
                .send(AdapterCommand {
                    operation,
                    reply: None,
                })
                .await;
        }
        let _ = (&mut self.task).await;
    }

    async fn call(&self, operation: AdapterOperation) -> Option<AdapterResult> {
        let (reply, result) = oneshot::channel();
        self.commands
            .send(AdapterCommand {
                operation,
                reply: Some(reply),
            })
            .await
            .ok()?;
        result.await.ok()
    }
}

async fn install(adapter: &mut impl NativeAdapter, request: LaunchRequest) -> NativeInstallResult {
    AssertUnwindSafe(async { adapter.install(request).await })
        .catch_unwind()
        .await
        .unwrap_or(NativeInstallResult::Unresolved {
            observation: None,
            failure: TerminationFailure::AuthorityLost,
        })
}

async fn cleanup(adapter: &mut impl NativeAdapter) -> NativeCleanupResult {
    AssertUnwindSafe(async { adapter.cleanup().await })
        .catch_unwind()
        .await
        .unwrap_or(NativeCleanupResult::Unresolved(
            TerminationFailure::AuthorityLost,
        ))
}

async fn detach(adapter: &mut impl NativeAdapter) -> NativeDetachResult {
    AssertUnwindSafe(async { adapter.detach().await })
        .catch_unwind()
        .await
        .unwrap_or(NativeDetachResult::Unresolved(
            TerminationFailure::AuthorityLost,
        ))
}

async fn settle_observation(adapter: &mut impl NativeAdapter) {
    let _ = AssertUnwindSafe(async { adapter.poll().await })
        .catch_unwind()
        .await;
}

async fn run<A: NativeAdapter>(mut adapter: A, mut commands: mpsc::Receiver<AdapterCommand>) {
    let mut pending = None;
    loop {
        let command = match pending.take() {
            Some(command) => command,
            None => match commands.recv().await {
                Some(command) => command,
                None => break,
            },
        };
        let (result, reply) = match command.operation {
            AdapterOperation::Install(request) => (
                AdapterResult::Install(install(&mut adapter, request).await),
                command.reply,
            ),
            AdapterOperation::Poll(generation) => {
                // Only observation is preemptible. Mutations retain custody and run to a
                // discriminated result before the next command is accepted.
                let mut poll_reply = command.reply;
                let mut poll =
                    Box::pin(AssertUnwindSafe(async { adapter.poll().await }).catch_unwind());
                let interrupted = tokio::select! {
                    biased;
                    command = commands.recv() => Some(command),
                    result = &mut poll => {
                        if let Some(reply) = poll_reply.take() {
                            let result = result.unwrap_or(NativePollResult::Unresolved(
                                TerminationFailure::AuthorityLost,
                            ));
                            let _ = reply.send(AdapterResult::Poll {
                                generation,
                                outcome: PollOutcome::Completed(result),
                            });
                        }
                        None
                    }
                };
                drop(poll);
                let Some(interrupted) = interrupted else {
                    continue;
                };
                let Some(command) = interrupted else {
                    settle_observation(&mut adapter).await;
                    break;
                };
                if let Some(reply) = poll_reply.take() {
                    let _ = reply.send(AdapterResult::Poll {
                        generation,
                        outcome: PollOutcome::Abandoned,
                    });
                }
                match command.operation {
                    AdapterOperation::Cleanup => (
                        AdapterResult::Cleanup(cleanup(&mut adapter).await),
                        command.reply,
                    ),
                    AdapterOperation::Detach => (
                        AdapterResult::Detach(detach(&mut adapter).await),
                        command.reply,
                    ),
                    AdapterOperation::Stop => {
                        settle_observation(&mut adapter).await;
                        break;
                    }
                    _ => {
                        pending = Some(command);
                        continue;
                    }
                }
            }
            AdapterOperation::Cleanup => (
                AdapterResult::Cleanup(cleanup(&mut adapter).await),
                command.reply,
            ),
            AdapterOperation::Detach => (
                AdapterResult::Detach(detach(&mut adapter).await),
                command.reply,
            ),
            AdapterOperation::Stop => break,
        };
        if let Some(reply) = reply {
            let _ = reply.send(result);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
        time::Duration,
    };

    use tokio::sync::{Semaphore, mpsc};

    use super::super::NativeFuture;
    use super::*;

    #[derive(Debug, Eq, PartialEq)]
    enum Event {
        PollStarted(usize),
        PollCancelled,
        PollSettled,
        AdapterDropped,
    }

    struct FakeAdapter {
        events: mpsc::UnboundedSender<Event>,
        settlement: Arc<Semaphore>,
        poll_calls: Arc<AtomicUsize>,
        cleanup_calls: Arc<AtomicUsize>,
        detach_calls: Arc<AtomicUsize>,
    }

    impl Drop for FakeAdapter {
        fn drop(&mut self) {
            let _ = self.events.send(Event::AdapterDropped);
        }
    }

    impl NativeAdapter for FakeAdapter {
        fn install(
            &mut self,
            _request: crate::process::launch::LaunchRequest,
        ) -> NativeFuture<'_, NativeInstallResult> {
            Box::pin(async { unreachable!("install is not used by this test") })
        }

        fn poll(&mut self) -> NativeFuture<'_, NativePollResult> {
            let call = self.poll_calls.fetch_add(1, Ordering::SeqCst) + 1;
            let events = self.events.clone();
            let settlement = Arc::clone(&self.settlement);
            Box::pin(async move {
                let _ = events.send(Event::PollStarted(call));
                if call == 1 {
                    let _cancelled = PollCancellation(events);
                    std::future::pending().await
                } else {
                    let _permit = settlement.acquire().await.expect("settlement stays open");
                    let _ = events.send(Event::PollSettled);
                    NativePollResult::Pending
                }
            })
        }

        fn cleanup(&mut self) -> NativeFuture<'_, NativeCleanupResult> {
            self.cleanup_calls.fetch_add(1, Ordering::SeqCst);
            Box::pin(async {
                NativeCleanupResult::Unresolved(TerminationFailure::CleanupUnconfirmed)
            })
        }

        fn detach(&mut self) -> NativeFuture<'_, NativeDetachResult> {
            self.detach_calls.fetch_add(1, Ordering::SeqCst);
            Box::pin(async {
                NativeDetachResult::Unresolved(TerminationFailure::CleanupUnconfirmed)
            })
        }
    }

    struct PollCancellation(mpsc::UnboundedSender<Event>);

    impl Drop for PollCancellation {
        fn drop(&mut self) {
            let _ = self.0.send(Event::PollCancelled);
        }
    }

    async fn next_event(events: &mut mpsc::UnboundedReceiver<Event>) -> Event {
        tokio::time::timeout(Duration::from_secs(1), events.recv())
            .await
            .expect("adapter event timed out")
            .expect("adapter event channel closed")
    }

    #[tokio::test]
    async fn command_channel_close_settles_interrupted_poll_before_dropping_adapter() {
        let (event_sender, mut events) = mpsc::unbounded_channel();
        let settlement = Arc::new(Semaphore::new(0));
        let poll_calls = Arc::new(AtomicUsize::new(0));
        let cleanup_calls = Arc::new(AtomicUsize::new(0));
        let detach_calls = Arc::new(AtomicUsize::new(0));
        let mut owner = AdapterOwner::spawn(FakeAdapter {
            events: event_sender,
            settlement: Arc::clone(&settlement),
            poll_calls: Arc::clone(&poll_calls),
            cleanup_calls: Arc::clone(&cleanup_calls),
            detach_calls: Arc::clone(&detach_calls),
        });
        let ticket = owner.start_poll().await.expect("poll starts");

        assert_eq!(next_event(&mut events).await, Event::PollStarted(1));
        drop(owner);

        assert_eq!(next_event(&mut events).await, Event::PollCancelled);
        assert_eq!(next_event(&mut events).await, Event::PollStarted(2));
        assert!(matches!(
            events.try_recv(),
            Err(mpsc::error::TryRecvError::Empty)
        ));
        assert_eq!(cleanup_calls.load(Ordering::SeqCst), 0);
        assert_eq!(detach_calls.load(Ordering::SeqCst), 0);

        settlement.add_permits(1);

        assert_eq!(next_event(&mut events).await, Event::PollSettled);
        assert_eq!(next_event(&mut events).await, Event::AdapterDropped);
        assert!(ticket.result.await.is_err());
        assert_eq!(poll_calls.load(Ordering::SeqCst), 2);
        assert_eq!(cleanup_calls.load(Ordering::SeqCst), 0);
        assert_eq!(detach_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn stop_settles_interrupted_poll_before_dropping_adapter() {
        let (event_sender, mut events) = mpsc::unbounded_channel();
        let settlement = Arc::new(Semaphore::new(0));
        let poll_calls = Arc::new(AtomicUsize::new(0));
        let cleanup_calls = Arc::new(AtomicUsize::new(0));
        let detach_calls = Arc::new(AtomicUsize::new(0));
        let mut owner = AdapterOwner::spawn(FakeAdapter {
            events: event_sender,
            settlement: Arc::clone(&settlement),
            poll_calls: Arc::clone(&poll_calls),
            cleanup_calls: Arc::clone(&cleanup_calls),
            detach_calls: Arc::clone(&detach_calls),
        });
        let ticket = owner.start_poll().await.expect("poll starts");
        let generation = ticket.generation;

        assert_eq!(next_event(&mut events).await, Event::PollStarted(1));
        let stop = tokio::spawn(async move { owner.stop().await });

        assert_eq!(next_event(&mut events).await, Event::PollCancelled);
        assert!(matches!(
            ticket.result.await.expect("abandoned poll result"),
            AdapterResult::Poll {
                generation: actual_generation,
                outcome: PollOutcome::Abandoned,
            } if actual_generation == generation
        ));
        assert_eq!(next_event(&mut events).await, Event::PollStarted(2));
        assert!(!stop.is_finished());
        assert_eq!(cleanup_calls.load(Ordering::SeqCst), 0);
        assert_eq!(detach_calls.load(Ordering::SeqCst), 0);

        settlement.add_permits(1);
        tokio::time::timeout(Duration::from_secs(1), stop)
            .await
            .expect("stop waits only for settlement")
            .expect("adapter owner stop task succeeds");

        assert_eq!(next_event(&mut events).await, Event::PollSettled);
        assert_eq!(next_event(&mut events).await, Event::AdapterDropped);
        assert_eq!(poll_calls.load(Ordering::SeqCst), 2);
        assert_eq!(cleanup_calls.load(Ordering::SeqCst), 0);
        assert_eq!(detach_calls.load(Ordering::SeqCst), 0);
    }
}
