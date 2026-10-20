use super::socket::Connection;
use crate::{events::Event, rpc, schedule::changes::Changes};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::sync::{oneshot, watch};
use tokio_util::sync::CancellationToken;

// Page size bounds only one durable read, not stream length or retained events.
const REPLAY_PAGE: usize = 128;

#[derive(Default)]
pub(super) struct Subscriptions {
    sessions: Mutex<HashMap<String, CancellationToken>>,
    schedules: Mutex<Option<CancellationToken>>,
    catalog: Mutex<Option<CancellationToken>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Cursor {
    session_id: String,
    #[serde(default)]
    after_seq: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Replay {
    session_id: String,
    #[serde(default)]
    after_seq: u64,
    #[serde(default = "default_limit")]
    limit: usize,
}

fn default_limit() -> usize {
    REPLAY_PAGE
}

pub(super) async fn replay(connection: &Connection, params: Value) -> rpc::Result {
    let params: Replay = rpc::params(params)?;
    let latest = validate_cursor(connection, &params.session_id, params.after_seq).await?;
    let events = connection
        .gateway
        .events
        .replay(&params.session_id, params.after_seq, params.limit)
        .await?;
    let next_seq = events.last().map_or(params.after_seq, |event| event.seq);
    Ok(json!({
        "sessionId": params.session_id,
        "events": events,
        "nextSeq": next_seq,
        "latestSeq": latest.max(next_seq),
    }))
}

pub(super) async fn subscribe(
    connection: &Arc<Connection>,
    params: Value,
    after_send: &mut Vec<oneshot::Sender<()>>,
) -> rpc::Result {
    let params: Cursor = rpc::params(params)?;
    validate_session(connection, &params.session_id).await?;
    // Watch first. Any commit overlapping the replay is either replayed or wakes us.
    let changes = connection.gateway.events.watch(&params.session_id).await;
    let latest = validate_sequence(connection, &params.session_id, params.after_seq).await?;
    let stopped = connection.closed.child_token();
    {
        let mut subscriptions = connection
            .subscriptions
            .sessions
            .lock()
            .map_err(|_| rpc::Error::internal("subscriptions_lock"))?;
        if let Some(previous) = subscriptions.insert(params.session_id.clone(), stopped.clone()) {
            previous.cancel();
        }
    }
    let (ready, sent) = oneshot::channel();
    after_send.push(ready);
    let connection = connection.clone();
    let session_id = params.session_id.clone();
    let streams = connection.streams.clone();
    streams.spawn(async move {
        let start = tokio::select! {
            biased;
            _ = stopped.cancelled() => false,
            sent = sent => sent.is_ok(),
        };
        if start {
            let result = stream(&connection, &session_id, params.after_seq, changes, &stopped).await;
            if let Err(error) = result {
                connection.record("subscribe", "event_stream_failed").await;
                tokio::select! {
                    biased;
                    _ = stopped.cancelled() => {},
                    _ = connection.notify("events.subscriptionError", json!({ "sessionId": session_id, "error": error })) => {},
                }
            }
        }
        // A replacement may already own this session key; do not remove its token.
        if let Ok(mut subscriptions) = connection.subscriptions.sessions.lock()
            && !stopped.is_cancelled()
        {
            subscriptions.remove(&session_id);
        }
    });
    Ok(json!({
        "sessionId": params.session_id,
        "afterSeq": params.after_seq,
        "latestSeq": latest,
        "delivery": "durable_replay_then_live",
    }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Catalog {}

pub(super) async fn subscribe_catalog(
    connection: &Arc<Connection>,
    params: Value,
    after_send: &mut Vec<oneshot::Sender<()>>,
) -> rpc::Result {
    let _: Catalog = rpc::params(params)?;
    let mut changes = connection.gateway.sessions.catalog_changes();
    let stopped = connection.closed.child_token();
    {
        let mut subscription = connection
            .subscriptions
            .catalog
            .lock()
            .map_err(|_| rpc::Error::internal("subscriptions_lock"))?;
        if let Some(previous) = subscription.replace(stopped.clone()) {
            previous.cancel();
        }
    }
    let (ready, sent) = oneshot::channel();
    after_send.push(ready);
    let connection = connection.clone();
    let streams = connection.streams.clone();
    streams.spawn(async move {
        let start = tokio::select! {
            biased;
            _ = stopped.cancelled() => false,
            sent = sent => sent.is_ok(),
        };
        if start {
            loop {
                changes.borrow_and_update();
                let sent = tokio::select! {
                    biased;
                    _ = stopped.cancelled() => break,
                    sent = connection.notify("sessions.catalogChanged", json!({})) => sent,
                };
                if sent.is_err() {
                    break;
                }
                let changed = tokio::select! {
                    biased;
                    _ = stopped.cancelled() => break,
                    changed = changes.changed() => changed,
                };
                if changed.is_err() {
                    break;
                }
            }
        }
        if let Ok(mut subscription) = connection.subscriptions.catalog.lock()
            && !stopped.is_cancelled()
        {
            subscription.take();
        }
    });
    Ok(json!({ "delivery": "live_invalidation" }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ScheduleCursor {
    after_seq: u64,
}

pub(super) async fn subscribe_schedules(
    connection: &Arc<Connection>,
    params: Value,
    after_send: &mut Vec<oneshot::Sender<()>>,
) -> rpc::Result {
    let params: ScheduleCursor = rpc::params(params)?;
    let changes = Changes::open(&connection.gateway.config.paths().database()).await?;
    let updates = changes.watch();
    changes.replay(params.after_seq, 0).await?;
    let latest = changes.latest().await?;
    let stopped = connection.closed.child_token();
    {
        let mut subscription = connection
            .subscriptions
            .schedules
            .lock()
            .map_err(|_| rpc::Error::internal("subscriptions_lock"))?;
        if let Some(previous) = subscription.replace(stopped.clone()) {
            previous.cancel();
        }
    }
    let (ready, sent) = oneshot::channel();
    after_send.push(ready);
    let connection = connection.clone();
    let streams = connection.streams.clone();
    streams.spawn(async move {
        let start = tokio::select! {
            biased;
            _ = stopped.cancelled() => false,
            sent = sent => sent.is_ok(),
        };
        let mut cursor = params.after_seq;
        if start
            && let Err(error) = stream_schedules(&connection, &changes, &mut cursor, updates, &stopped).await
        {
            connection.record("schedule_subscribe", "schedule_stream_failed").await;
            tokio::select! {
                biased;
                _ = stopped.cancelled() => {},
                _ = connection.notify("schedules.subscriptionError", json!({
                    "afterSeq": cursor, "code": error.code, "message": error.message, "data": error.data,
                })) => {},
            }
        }
        if let Ok(mut subscription) = connection.subscriptions.schedules.lock()
            && !stopped.is_cancelled()
        {
            subscription.take();
        }
    });
    Ok(json!({
        "afterSeq": params.after_seq,
        "latestSeq": latest,
        "delivery": "durable_replay_then_live",
    }))
}

async fn stream_schedules(
    connection: &Connection,
    changes: &Changes,
    cursor: &mut u64,
    mut updates: watch::Receiver<()>,
    stopped: &CancellationToken,
) -> rpc::Result<()> {
    loop {
        updates.borrow_and_update();
        let receipts = tokio::select! {
            biased;
            _ = stopped.cancelled() => return Ok(()),
            receipts = changes.replay(*cursor, REPLAY_PAGE) => receipts?,
        };
        if receipts.is_empty() {
            tokio::select! {
                biased;
                _ = stopped.cancelled() => return Ok(()),
                changed = updates.changed() => changed.map_err(|_| rpc::Error::unavailable(
                    "schedule_watch_closed", "The durable schedule watch closed; resubscribe from the last received sequence",
                ))?,
            }
            continue;
        }
        for receipt in receipts {
            let seq = receipt.seq;
            let notification = rpc::value(receipt)?;
            let sent = tokio::select! {
                biased;
                _ = stopped.cancelled() => return Ok(()),
                result = connection.notify_flushed("schedules.receipt", notification) => result,
            };
            if sent.is_err() {
                return Ok(());
            }
            *cursor = seq;
        }
    }
}

async fn validate_cursor(
    connection: &Connection,
    session_id: &str,
    after_seq: u64,
) -> rpc::Result<u64> {
    validate_session(connection, session_id).await?;
    validate_sequence(connection, session_id, after_seq).await
}

async fn validate_session(connection: &Connection, session_id: &str) -> rpc::Result<()> {
    // Do not create phantom subscriptions or delete real sessions on transport teardown.
    connection
        .gateway
        .sessions
        .dispatch("sessions.get", json!({ "sessionId": session_id }))
        .await?;
    Ok(())
}

async fn validate_sequence(
    connection: &Connection,
    session_id: &str,
    after_seq: u64,
) -> rpc::Result<u64> {
    let latest = connection.gateway.events.latest(session_id).await?;
    if after_seq > latest {
        return Err(rpc::Error::new(
            -32002,
            "events_cursor_ahead",
            "afterSeq exceeds this session's latest durable sequence",
        )
        .with_data(json!({ "cursor": after_seq, "latestSeq": latest })));
    }
    Ok(latest)
}

async fn stream(
    connection: &Connection,
    session_id: &str,
    mut cursor: u64,
    mut changes: watch::Receiver<u64>,
    stopped: &CancellationToken,
) -> rpc::Result<()> {
    loop {
        // Mark only before the durable read, never after it: a racing commit must
        // remain visible to changed() when the just-read page was empty.
        changes.borrow_and_update();
        let events = tokio::select! {
            biased;
            _ = stopped.cancelled() => return Ok(()),
            events = connection.gateway.events.replay(session_id, cursor, REPLAY_PAGE) => events?,
        };
        if events.is_empty() {
            tokio::select! {
                biased;
                _ = stopped.cancelled() => return Ok(()),
                changed = changes.changed() => changed.map_err(|_| rpc::Error::unavailable("event_watch_closed", "The durable event watch closed; resubscribe from the last received sequence"))?,
            }
            continue;
        }
        for event in events {
            if event.seq <= cursor || event.session_id != session_id {
                return Err(rpc::Error::internal("event_cursor_order"));
            }
            let seq = event.seq;
            let notification = rpc::value::<Event>(event)?;
            let sent = tokio::select! {
                biased;
                _ = stopped.cancelled() => return Ok(()),
                result = connection.notify("session.event", notification) => result,
            };
            if sent.is_err() {
                return Ok(());
            }
            cursor = seq;
        }
    }
}
