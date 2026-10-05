use tokio::sync::{broadcast, mpsc, oneshot};

use crate::session::{
    events::{SessionEventCursor, SessionEventObservation, SessionEventUpdate},
    model::{Sequence, SessionId},
    protocol_event::EventEnvelope,
};

use super::{EventReplay, EventReplayPayload, RAW_EVENT_CAPACITY, RawEvent};

pub(super) enum Command {
    Begin {
        session_id: SessionId,
        after: Option<Sequence>,
        subscription: bool,
        reply: oneshot::Sender<Result<(), IngressError>>,
    },
    Settle {
        session_id: SessionId,
        after: Option<Sequence>,
        replayed: Vec<EventEnvelope>,
        subscription: bool,
        confirmed_cursor: Option<Sequence>,
        reply: oneshot::Sender<Result<EventReplayPayload, IngressError>>,
    },
    Abort,
    Closed,
    Shutdown,
}

enum State {
    Idle,
    Pending {
        cursor: SessionEventCursor,
        request_subscription: bool,
        restore_subscription: bool,
        live: Vec<EventEnvelope>,
        closed: bool,
    },
    Raw(SessionId),
    Active(SessionEventCursor),
    Recovery(SessionEventCursor),
    Closed(Option<Sequence>),
}

struct SettleInput {
    session_id: SessionId,
    after: Option<Sequence>,
    replayed: Vec<EventEnvelope>,
    subscription: bool,
    confirmed_cursor: Option<Sequence>,
}

pub(super) async fn run(
    mut commands: mpsc::Receiver<Command>,
    mut events: mpsc::Receiver<EventEnvelope>,
    updates: Option<mpsc::Sender<SessionEventUpdate>>,
    raw_events: broadcast::Sender<RawEvent>,
) {
    let mut state = State::Idle;
    loop {
        tokio::select! {
            biased;
            command = commands.recv() => match command {
                Some(Command::Shutdown) | None => {
                    let _ = raw_events.send(RawEvent::Closed);
                    return;
                }
                Some(command) => {
                    handle_command(command, &mut state, &mut events, updates.as_ref(), &raw_events).await
                }
            },

            event = events.recv() => match event {
                Some(event) => match &mut state {
                    State::Pending { live, .. } if live.len() < RAW_EVENT_CAPACITY => live.push(event),
                    State::Pending { cursor, .. } => {
                        let cursor = SessionEventCursor::resume_after(
                            cursor.session_id().clone(),
                            cursor.sequence(),
                        );
                        let _ = raw_events.send(RawEvent::Overflow);
                        state = State::Recovery(cursor);
                    }
                    _ => observe(&mut state, event, updates.as_ref(), &raw_events).await,
                },
                None => {
                    let _ = raw_events.send(RawEvent::Closed);
                    return;
                }
            },
        }
    }
}

async fn handle_command(
    command: Command,
    state: &mut State,
    events: &mut mpsc::Receiver<EventEnvelope>,
    updates: Option<&mpsc::Sender<SessionEventUpdate>>,
    raw_events: &broadcast::Sender<RawEvent>,
) {
    match command {
        Command::Begin {
            session_id,
            after,
            subscription,
            reply,
        } => {
            let _ = reply.send(begin(state, session_id, after, subscription));
        }
        Command::Settle {
            session_id,
            after,
            replayed,
            subscription,
            confirmed_cursor,
            reply,
        } => {
            let _ = reply.send(
                settle(
                    state,
                    events,
                    updates,
                    raw_events,
                    SettleInput {
                        session_id,
                        after,
                        replayed,
                        subscription,
                        confirmed_cursor,
                    },
                )
                .await,
            );
        }
        Command::Abort => abort(state, updates).await,
        Command::Closed => close(state, updates).await,
        Command::Shutdown => unreachable!("shutdown returns from the actor loop"),
    }
}

fn begin(
    state: &mut State,
    session_id: SessionId,
    after: Option<Sequence>,
    subscription: bool,
) -> Result<(), IngressError> {
    let requested = cursor(session_id, after);
    match std::mem::replace(state, State::Idle) {
        State::Idle => {
            *state = State::Pending {
                cursor: requested,
                request_subscription: subscription,
                restore_subscription: subscription,
                live: Vec::new(),
                closed: false,
            };
            Ok(())
        }
        State::Active(active) | State::Recovery(active)
            if !subscription
                && active.session_id() == requested.session_id()
                && active.sequence() == requested.sequence() =>
        {
            *state = State::Pending {
                cursor: active,
                request_subscription: false,
                restore_subscription: true,
                live: Vec::new(),
                closed: false,
            };
            Ok(())
        }
        previous => {
            *state = previous;
            Err(IngressError::Busy)
        }
    }
}

async fn settle(
    state: &mut State,
    events: &mut mpsc::Receiver<EventEnvelope>,
    updates: Option<&mpsc::Sender<SessionEventUpdate>>,
    raw_events: &broadcast::Sender<RawEvent>,
    input: SettleInput,
) -> Result<EventReplayPayload, IngressError> {
    let SettleInput {
        session_id,
        after,
        replayed,
        subscription,
        confirmed_cursor,
    } = input;
    let previous = std::mem::replace(state, State::Idle);
    let State::Pending {
        mut cursor,
        request_subscription,
        restore_subscription,
        live,
        closed,
    } = previous
    else {
        let error = if matches!(&previous, State::Recovery(_)) {
            IngressError::RecoveryRequired
        } else {
            IngressError::NotPending
        };
        *state = previous;
        return Err(error);
    };
    if cursor.session_id() != &session_id
        || !matches_cursor(after, cursor.sequence())
        || subscription != request_subscription
    {
        *state = State::Recovery(cursor);
        return Err(IngressError::MismatchedSession);
    }
    if subscription && updates.is_none() {
        for event in live {
            if event.session_id != session_id {
                *state = State::Recovery(cursor);
                return Err(IngressError::MismatchedSession);
            }
            let _ = raw_events.send(RawEvent::Envelope(event));
        }
        *state = if closed { State::Closed(None) } else { State::Raw(session_id) };
        return Ok(EventReplayPayload::new(EventReplay::new(0, cursor.sequence()), Vec::new()));
    }
    if let Some(confirmed_cursor) = confirmed_cursor {
        if confirmed_cursor.get() < cursor.sequence().get() {
            *state = State::Recovery(cursor);
            return Err(IngressError::MismatchedSession);
        }
        // Subscribe acknowledges the producer head; it consumed no historical events.
    }
    let event_count = replayed.len();
    let replay_cursor = replayed.last().map(|event| event.seq).unwrap_or(cursor.sequence());
    for event in &replayed {
        if let Err(error) = apply(&mut cursor, event.clone(), updates).await {
            let _ = raw_events.send(RawEvent::Overflow);
            *state = State::Recovery(cursor);
            return Err(error);
        }
        let _ = raw_events.send(RawEvent::Envelope(event.clone()));
    }
    for event in live {
        if let Err(error) = apply(&mut cursor, event.clone(), updates).await {
            let _ = raw_events.send(RawEvent::Overflow);
            *state = State::Recovery(cursor);
            return Err(error);
        }
        let _ = raw_events.send(RawEvent::Envelope(event));
    }
    while let Ok(event) = events.try_recv() {
        if let Err(error) = apply(&mut cursor, event.clone(), updates).await {
            let _ = raw_events.send(RawEvent::Overflow);
            *state = State::Recovery(cursor);
            return Err(error);
        }
        let _ = raw_events.send(RawEvent::Envelope(event));
    }
    let result =
        EventReplayPayload::new(EventReplay::new(event_count, replay_cursor), replayed);
    *state = if closed {
        State::Closed(Some(cursor.sequence()))
    } else if restore_subscription {
        State::Active(cursor)
    } else {
        State::Idle
    };
    if closed {
        publish_closed_summary(updates, result.cursor()).await;
    }
    Ok(result)
}

async fn abort(state: &mut State, updates: Option<&mpsc::Sender<SessionEventUpdate>>) {
    let previous = std::mem::replace(state, State::Idle);
    *state = match previous {
        State::Pending {
            cursor,
            closed: true,
            ..
        } => {
            let sequence = cursor.sequence();
            publish_closed_summary(updates, sequence).await;
            State::Closed(Some(sequence))
        }
        State::Pending {
            cursor,
            restore_subscription: true,
            ..
        } => State::Recovery(cursor),
        State::Pending { .. } => State::Idle,
        state => state,
    };
}

async fn observe(
    state: &mut State,
    event: EventEnvelope,
    updates: Option<&mpsc::Sender<SessionEventUpdate>>,
    raw_events: &broadcast::Sender<RawEvent>,
) {
    let previous = std::mem::replace(state, State::Idle);
    *state = match previous {
        State::Raw(session_id) if event.session_id == session_id => {
            let _ = raw_events.send(RawEvent::Envelope(event));
            State::Raw(session_id)
        }
        State::Active(mut cursor) => match apply(&mut cursor, event.clone(), updates).await {
            Ok(()) => {
                let _ = raw_events.send(RawEvent::Envelope(event));
                State::Active(cursor)
            }
            Err(IngressError::Closed) => {
                let _ = raw_events.send(RawEvent::Closed);
                State::Closed(Some(cursor.sequence()))
            }
            Err(_) => {
                let _ = raw_events.send(RawEvent::Overflow);
                State::Recovery(cursor)
            }
        },
        state => state,
    };
}

async fn close(state: &mut State, updates: Option<&mpsc::Sender<SessionEventUpdate>>) {
    if let State::Pending { closed, .. } = state {
        *closed = true;
        return;
    }
    let previous = std::mem::replace(state, State::Idle);
    let cursor = match &previous {
        State::Idle | State::Raw(_) => None,
        State::Pending { cursor, .. } | State::Active(cursor) | State::Recovery(cursor) => {
            Some(cursor.sequence())
        }
        State::Closed(cursor) => *cursor,
    };
    let was_closed = matches!(previous, State::Closed(_));
    *state = State::Closed(cursor);
    if !was_closed && let Some(cursor) = cursor {
        publish_closed_summary(updates, cursor).await;
    }
}

async fn emit_update(
    updates: Option<&mpsc::Sender<SessionEventUpdate>>,
    build: impl FnOnce() -> SessionEventUpdate,
) -> Result<(), IngressError> {
    let Some(updates) = updates else {
        return Ok(());
    };
    updates
        .send(build())
        .await
        .map_err(|_| IngressError::Closed)
}

async fn publish_closed_summary(
    updates: Option<&mpsc::Sender<SessionEventUpdate>>,
    cursor: Sequence,
) {
    let _ = emit_update(updates, || {
        SessionEventUpdate::new(
            SessionEventObservation::Closed { cursor },
            Some(cursor),
            false,
            false,
        )
    })
    .await;
}

async fn apply(
    cursor: &mut SessionEventCursor,
    event: EventEnvelope,
    updates: Option<&mpsc::Sender<SessionEventUpdate>>,
) -> Result<(), IngressError> {
    let observation = cursor.observe(&event);
    emit_update(updates, || {
        SessionEventUpdate::new(
            observation,
            Some(event.seq),
            event.run_id.is_some(),
            event.event.message_id().is_some(),
        )
    })
    .await?;
    match observation {
        SessionEventObservation::Gap { .. } => Err(IngressError::RecoveryRequired),
        SessionEventObservation::Accepted { .. }
        | SessionEventObservation::Duplicate { .. }
        | SessionEventObservation::Stale { .. }
        | SessionEventObservation::OutOfSession { .. }
        | SessionEventObservation::Closed { .. } => Ok(()),
    }
}

fn matches_cursor(after: Option<Sequence>, cursor: Sequence) -> bool {
    after.unwrap_or_else(zero_sequence) == cursor
}

fn zero_sequence() -> Sequence {
    Sequence::try_new(0).expect("zero is a valid replay cursor")
}

fn cursor(session_id: SessionId, after: Option<Sequence>) -> SessionEventCursor {
    match after {
        Some(after) => SessionEventCursor::resume_after(session_id, after),
        None => SessionEventCursor::new(session_id),
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(in super::super) enum IngressError {
    Busy,
    MismatchedSession,
    NotPending,
    RecoveryRequired,
    Closed,
}
