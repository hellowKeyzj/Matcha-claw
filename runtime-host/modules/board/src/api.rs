use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use foundation::execution::OwnerRuntimeHandle;
use tokio::sync::{OwnedSemaphorePermit, Semaphore, broadcast, oneshot, watch};

use crate::{application::BoardOwnerCommand, model::*};

pub(crate) const SUBSCRIPTION_CAPACITY: usize = 32;
pub(crate) const EVENT_CAPACITY: usize = 64;

#[derive(Clone)]
pub(crate) struct BoardDelivery {
    pub(crate) generation: u64,
    pub(crate) event: BoardEvent,
}

#[derive(Clone)]
pub(crate) struct BoardLifecycle {
    pub(crate) closing: Arc<AtomicBool>,
    pub(crate) closed: watch::Sender<bool>,
    pub(crate) subscriptions: Arc<Semaphore>,
    pub(crate) events: broadcast::Sender<BoardDelivery>,
    pub(crate) resync: watch::Sender<u64>,
}

impl BoardLifecycle {
    pub(crate) fn new() -> Self {
        Self {
            closing: Arc::new(AtomicBool::new(false)),
            closed: watch::channel(false).0,
            subscriptions: Arc::new(Semaphore::new(SUBSCRIPTION_CAPACITY)),
            events: broadcast::channel(EVENT_CAPACITY).0,
            resync: watch::channel(0).0,
        }
    }

    pub(crate) fn finish(&self) {
        self.closing.store(true, Ordering::Release);
        self.subscriptions.close();
        self.closed.send_replace(true);
    }
}

#[derive(Clone)]
pub(crate) struct BoardHandle {
    owner: OwnerRuntimeHandle<BoardOwnerCommand, std::convert::Infallible>,
    lifecycle: BoardLifecycle,
}

impl BoardHandle {
    pub(crate) fn new(
        owner: OwnerRuntimeHandle<BoardOwnerCommand, std::convert::Infallible>,
        lifecycle: BoardLifecycle,
    ) -> Self {
        Self { owner, lifecycle }
    }

    pub(crate) async fn execute(
        &self,
        identity: BoardIdentity,
        operation: BoardOperation,
    ) -> Result<BoardResult, BoardFailure> {
        self.admit()?;
        operation.validate()?;
        let (reply, response) = oneshot::channel();
        self.owner
            .try_send_command(BoardOwnerCommand::Execute {
                identity,
                operation,
                reply,
            })
            .map_err(|_| BoardFailure::Unavailable)?;
        response.await.map_err(|_| BoardFailure::Unknown)?
    }

    pub(crate) async fn subscribe(
        &self,
        identity: BoardIdentity,
    ) -> Result<BoardSubscription, BoardFailure> {
        self.admit()?;
        let permit = self
            .lifecycle
            .subscriptions
            .clone()
            .try_acquire_owned()
            .map_err(|_| BoardFailure::Unavailable)?;
        let (reply, response) = oneshot::channel();
        self.owner
            .try_send_command(BoardOwnerCommand::Subscribe {
                identity,
                permit,
                reply,
            })
            .map_err(|_| BoardFailure::Unavailable)?;
        response.await.map_err(|_| BoardFailure::Unavailable)?
    }

    pub(crate) fn event_sink(&self) -> BoardEventSink {
        BoardEventSink {
            handle: self.clone(),
        }
    }

    pub(crate) fn subscribe_events(&self) -> Result<BoardEventSubscription, BoardFailure> {
        self.admit()?;
        let permit = self
            .lifecycle
            .subscriptions
            .clone()
            .try_acquire_owned()
            .map_err(|_| BoardFailure::Unavailable)?;
        Ok(BoardEventSubscription::new(
            self.lifecycle.events.subscribe(),
            &self.lifecycle,
            permit,
        ))
    }

    pub(crate) async fn close(&self) -> Result<(), BoardFailure> {
        if *self.lifecycle.closed.borrow() {
            return Ok(());
        }
        let permit = match self.owner.reserve().await {
            Ok(permit) => permit,
            Err(_) if *self.lifecycle.closed.borrow() => return Ok(()),
            Err(_) => return Err(BoardFailure::Unavailable),
        };
        if self.lifecycle.closing.swap(true, Ordering::AcqRel) {
            drop(permit);
            let mut closed = self.lifecycle.closed.subscribe();
            closed
                .wait_for(|closed| *closed)
                .await
                .map_err(|_| BoardFailure::Unavailable)?;
            return Ok(());
        }
        self.lifecycle.subscriptions.close();
        let (reply, response) = oneshot::channel();
        if permit.send(BoardOwnerCommand::Close { reply }).is_err() {
            self.lifecycle.finish();
            return Err(BoardFailure::Unavailable);
        }
        response.await.map_err(|_| BoardFailure::Unavailable)
    }

    fn admit(&self) -> Result<(), BoardFailure> {
        if self.lifecycle.closing.load(Ordering::Acquire) {
            Err(BoardFailure::Unavailable)
        } else {
            Ok(())
        }
    }
}

/// Injected into the existing native ordered ingress; it opens no additional native subscription.
#[derive(Clone)]
pub struct BoardEventSink {
    handle: BoardHandle,
}

impl BoardEventSink {
    /// Backpressure invalidates observations even when the owner mailbox is already full.
    pub fn publish(&self, event: BoardEvent) -> Result<(), BoardFailure> {
        self.handle.admit()?;
        let generation = *self.handle.lifecycle.resync.borrow();
        if let Err(failure) = crate::validation::event(&event) {
            self.invalidate();
            return Err(failure);
        }
        let delivery = BoardDelivery { generation, event };
        self.handle
            .owner
            .try_send_command(BoardOwnerCommand::Publish(delivery))
            .map_err(|_| {
                self.invalidate();
                BoardFailure::Unavailable
            })
    }

    /// Native gaps and reconnects invalidate views; this generation is not a native revision.
    pub fn invalidate(&self) {
        self.handle
            .lifecycle
            .resync
            .send_modify(|generation| *generation = generation.wrapping_add(1));
    }
}

pub struct BoardSubscription {
    identity: BoardIdentity,
    events: BoardEventSubscription,
}

/// One bounded global receipt stream for the Host event bridge; it owns no Board facts.
pub struct BoardEventSubscription {
    receiver: broadcast::Receiver<BoardDelivery>,
    closed: watch::Receiver<bool>,
    resync: watch::Receiver<u64>,
    _permit: OwnedSemaphorePermit,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BoardSubscriptionFailure {
    Lagged,
    Closed,
}

impl BoardSubscription {
    pub(crate) fn new(
        identity: BoardIdentity,
        receiver: broadcast::Receiver<BoardDelivery>,
        lifecycle: &BoardLifecycle,
        permit: OwnedSemaphorePermit,
    ) -> Self {
        Self {
            identity,
            events: BoardEventSubscription::new(receiver, lifecycle, permit),
        }
    }
    pub fn identity(&self) -> &BoardIdentity {
        &self.identity
    }
    pub async fn recv(&mut self) -> Result<BoardEvent, BoardSubscriptionFailure> {
        loop {
            let event = self.events.recv().await?;
            if event.identity() == &self.identity {
                return Ok(event);
            }
        }
    }
}

impl BoardEventSubscription {
    fn new(
        receiver: broadcast::Receiver<BoardDelivery>,
        lifecycle: &BoardLifecycle,
        permit: OwnedSemaphorePermit,
    ) -> Self {
        Self {
            receiver,
            closed: lifecycle.closed.subscribe(),
            resync: lifecycle.resync.subscribe(),
            _permit: permit,
        }
    }

    pub async fn recv(&mut self) -> Result<BoardEvent, BoardSubscriptionFailure> {
        loop {
            tokio::select! {
                biased;
                _ = self.closed.wait_for(|closed| *closed) => return Err(BoardSubscriptionFailure::Closed),
                changed = self.resync.changed() => {
                    if changed.is_err() { return Err(BoardSubscriptionFailure::Closed); }
                    self.receiver = self.receiver.resubscribe();
                    return Err(BoardSubscriptionFailure::Lagged);
                }
                event = self.receiver.recv() => match event {
                    Ok(delivery) if delivery.generation == *self.resync.borrow() => return Ok(delivery.event),
                    Ok(_) => continue,
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        self.receiver = self.receiver.resubscribe();
                        return Err(BoardSubscriptionFailure::Lagged);
                    }
                    Err(broadcast::error::RecvError::Closed) => return Err(BoardSubscriptionFailure::Closed),
                },
            }
        }
    }
}
