use std::time::Duration;

use tokio::{
    sync::{broadcast, mpsc, oneshot},
    task::JoinHandle,
    time::timeout,
};

use crate::session::{
    events::SessionEventUpdate,
    model::{Sequence, SessionId},
    protocol_event::EventEnvelope,
};

#[path = "ingress_state.rs"]
mod ingress_state;

pub(super) use ingress_state::IngressError;
use ingress_state::{Command, run};

const RAW_EVENT_CAPACITY: usize = 256;
const COMMAND_CAPACITY: usize = 16;
const CLOSE_DEADLINE: Duration = Duration::from_secs(1);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EventSubscription {
    Subscribed,
    ClientNotFound,
    ClientRequired,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EventSubscriptionCursor {
    Subscribed(EventReplay),
    ClientNotFound,
    ClientRequired,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct EventReplay {
    event_count: usize,
    cursor: Sequence,
}

impl EventReplay {
    pub(crate) const fn new(event_count: usize, cursor: Sequence) -> Self {
        Self {
            event_count,
            cursor,
        }
    }

    pub fn event_count(self) -> usize {
        self.event_count
    }

    pub fn cursor(self) -> Sequence {
        self.cursor
    }
}

/// A bounded, in-memory replay projection used by the session facts owner.
///
/// The envelopes are dropped with this value and are never persisted or exposed
/// as a local event store.
pub(crate) struct EventReplayPayload {
    summary: EventReplay,
    events: Vec<EventEnvelope>,
}

impl EventReplayPayload {
    pub(crate) fn new(summary: EventReplay, events: Vec<EventEnvelope>) -> Self {
        Self { summary, events }
    }

    pub(super) fn summary(&self) -> EventReplay {
        self.summary
    }

    pub(crate) fn event_count(&self) -> usize {
        self.summary.event_count()
    }

    pub(crate) fn cursor(&self) -> Sequence {
        self.summary.cursor()
    }

    pub(crate) fn events(&self) -> &[EventEnvelope] {
        &self.events
    }
}

pub(super) struct EventIngress {
    ingress: Ingress,
    task: Option<JoinHandle<()>>,
}

#[derive(Clone)]
pub(super) struct Ingress {
    commands: mpsc::Sender<Command>,
    events: mpsc::Sender<EventEnvelope>,
    raw_events: broadcast::Sender<RawEvent>,
}

#[derive(Clone, Debug)]
pub(crate) enum RawEvent {
    Envelope(EventEnvelope),
    Overflow,
    Closed,
}

impl EventIngress {
    pub(super) fn new(updates: Option<mpsc::Sender<SessionEventUpdate>>) -> Self {
        let (commands, command_receiver) = mpsc::channel(COMMAND_CAPACITY);
        let (events, event_receiver) = mpsc::channel(RAW_EVENT_CAPACITY);
        let (raw_events, _) = broadcast::channel(RAW_EVENT_CAPACITY);
        Self {
            ingress: Ingress {
                commands,
                events,
                raw_events: raw_events.clone(),
            },
            task: Some(tokio::spawn(run(
                command_receiver,
                event_receiver,
                updates,
                raw_events,
            ))),
        }
    }

    pub(super) fn connection(&self) -> Ingress {
        self.ingress.clone()
    }

    pub(super) async fn begin_subscription(
        &self,
        session_id: SessionId,
        after: Option<Sequence>,
    ) -> Result<(), IngressError> {
        self.ingress.begin(session_id, after, true).await
    }

    pub(super) async fn begin_replay(
        &self,
        session_id: SessionId,
        after: Option<Sequence>,
    ) -> Result<(), IngressError> {
        self.ingress.begin(session_id, after, false).await
    }

    pub(super) async fn settle_subscription(
        &self,
        session_id: SessionId,
        after: Option<Sequence>,
        replayed: Vec<EventEnvelope>,
    ) -> Result<EventReplay, IngressError> {
        Ok(self
            .ingress
            .settle(session_id, after, replayed, true)
            .await?
            .summary())
    }

    pub(super) async fn settle_replay_payload(
        &self,
        session_id: SessionId,
        after: Option<Sequence>,
        replayed: Vec<EventEnvelope>,
    ) -> Result<EventReplayPayload, IngressError> {
        self.ingress
            .settle(session_id, after, replayed, false)
            .await
    }

    pub(super) async fn abort(&self) {
        self.ingress.abort().await;
    }

    pub(super) async fn close(mut self) -> Result<(), IngressError> {
        let _ = timeout(CLOSE_DEADLINE, self.ingress.shutdown()).await;
        let mut task = self
            .task
            .take()
            .expect("event ingress task must be present");
        if timeout(CLOSE_DEADLINE, &mut task).await.is_ok() {
            Ok(())
        } else {
            task.abort();
            let _ = task.await;
            Err(IngressError::Closed)
        }
    }
}

impl Drop for EventIngress {
    fn drop(&mut self) {
        if let Some(task) = self.task.as_ref() {
            task.abort();
        }
    }
}

impl Ingress {
    pub(super) fn ingest(&self, event: EventEnvelope) -> Result<(), IngressError> {
        match self.events.try_send(event) {
            Ok(()) => Ok(()),
            Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {
                let _ = self.raw_events.send(RawEvent::Overflow);
                Err(IngressError::Closed)
            }
            Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => Err(IngressError::Closed),
        }
    }

    pub(super) fn raw_events(&self) -> broadcast::Receiver<RawEvent> {
        self.raw_events.subscribe()
    }

    pub(super) async fn connection_closed(&self) {
        let _ = self.raw_events.send(RawEvent::Closed);
        let _ = self.commands.send(Command::Closed).await;
    }

    async fn begin(
        &self,
        session_id: SessionId,
        after: Option<Sequence>,
        subscription: bool,
    ) -> Result<(), IngressError> {
        let (reply, received) = oneshot::channel();
        self.commands
            .send(Command::Begin {
                session_id,
                after,
                subscription,
                reply,
            })
            .await
            .map_err(|_| IngressError::Closed)?;
        received.await.map_err(|_| IngressError::Closed)?
    }

    async fn settle(
        &self,
        session_id: SessionId,
        after: Option<Sequence>,
        replayed: Vec<EventEnvelope>,
        subscription: bool,
    ) -> Result<EventReplayPayload, IngressError> {
        let (reply, received) = oneshot::channel();
        self.commands
            .send(Command::Settle {
                session_id,
                after,
                replayed,
                subscription,
                reply,
            })
            .await
            .map_err(|_| IngressError::Closed)?;
        received.await.map_err(|_| IngressError::Closed)?
    }

    async fn abort(&self) {
        let _ = self.commands.send(Command::Abort).await;
    }

    async fn shutdown(&self) {
        let _ = self.commands.send(Command::Shutdown).await;
    }
}
