use std::{fmt, sync::Arc};

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::protocol::wire::{JsonRpcError, JsonRpcNotification};

use super::{Client, Delivery, Error, connection::Connection, next_id};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub session_id: String,
    pub seq: u64,
    pub run_id: Option<String>,
    pub kind: String,
    pub at_ms: u64,
    pub payload: Value,
}

impl fmt::Debug for Event {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Event")
            .field("seq", &self.seq)
            .finish_non_exhaustive()
    }
}

pub struct Subscription {
    // An owned observer keeps the shared transport alive even if its caller drops the Client.
    _client: Client,
    connection: Arc<Connection>,
    notifications: mpsc::Receiver<JsonRpcNotification>,
    session_id: String,
    cursor: u64,
    failure: Option<Error>,
}

pub(super) async fn open(
    client: &Client,
    session_id: &str,
    after_seq: u64,
) -> Result<Subscription, Error> {
    if session_id.is_empty() {
        return Err(Error::local("invalid_params", Delivery::NotSent));
    }
    let (output, notifications) = mpsc::channel(1);
    let connection = client
        .open(Some(output), &tokio_util::sync::CancellationToken::new())
        .await?;
    let mut subscription = Subscription {
        _client: client.clone(),
        connection,
        notifications,
        session_id: session_id.to_owned(),
        cursor: after_seq,
        failure: None,
    };
    let result = subscription
        .connection
        .call(
            next_id()?,
            "events.subscribe",
            json!({
                "sessionId": session_id,
                "afterSeq": after_seq,
            }),
            &tokio_util::sync::CancellationToken::new(),
        )
        .await;
    match result {
        Ok(result)
            if result.get("sessionId").and_then(Value::as_str) == Some(session_id)
                && result.get("afterSeq").and_then(Value::as_u64) == Some(after_seq)
                && result
                    .get("latestSeq")
                    .and_then(Value::as_u64)
                    .is_some_and(|latest| latest >= after_seq)
                && result.get("delivery").and_then(Value::as_str)
                    == Some("durable_replay_then_live") =>
        {
            Ok(subscription)
        }
        result => {
            let error = result
                .err()
                .unwrap_or_else(|| Error::local("protocol", Delivery::ResponseReceived));
            let _ = subscription.connection.close().await;
            subscription.failure = Some(error.clone());
            Err(error)
        }
    }
}

impl Subscription {
    pub async fn recv(&mut self) -> Result<Event, Error> {
        if let Some(error) = &self.failure {
            return Err(error.clone());
        }
        let result = match self.notifications.recv().await {
            Some(notification) => self.decode(notification),
            None => Err(self.connection.failure()),
        };
        match result {
            Ok(event) => {
                self.cursor = event.seq;
                Ok(event)
            }
            Err(error) => {
                self.connection.stop();
                self.failure = Some(error.clone());
                Err(error)
            }
        }
    }

    pub async fn close(self) -> Result<(), Error> {
        self.connection.close().await
    }

    fn decode(&self, notification: JsonRpcNotification) -> Result<Event, Error> {
        let params = notification
            .params
            .ok_or_else(|| Error::local("protocol", Delivery::ResponseReceived))?;
        match notification.method.as_str() {
            "session.event" => {
                let event: Event = serde_json::from_value(params)
                    .map_err(|_| Error::local("protocol", Delivery::ResponseReceived))?;
                if event.session_id != self.session_id
                    || event.kind.is_empty()
                    || event.run_id.as_ref().is_some_and(String::is_empty)
                {
                    return Err(Error::local("protocol", Delivery::ResponseReceived));
                }
                if self.cursor.checked_add(1) != Some(event.seq) {
                    return Err(Error::local(
                        "events_sequence_gap",
                        Delivery::ResponseReceived,
                    ));
                }
                Ok(event)
            }
            "events.subscriptionError" => {
                if params.get("sessionId").and_then(Value::as_str) != Some(self.session_id.as_str())
                {
                    return Err(Error::local("protocol", Delivery::ResponseReceived));
                }
                let error = params
                    .get("error")
                    .and_then(Value::as_object)
                    .ok_or_else(|| Error::local("protocol", Delivery::ResponseReceived))?;
                let code = error
                    .get("code")
                    .and_then(Value::as_i64)
                    .ok_or_else(|| Error::local("protocol", Delivery::ResponseReceived))?;
                if !error.get("message").is_some_and(Value::is_string) {
                    return Err(Error::local("protocol", Delivery::ResponseReceived));
                }
                Err(Error::remote(JsonRpcError::remote(
                    code,
                    error.get("data").cloned(),
                )))
            }
            _ => Err(Error::local("protocol", Delivery::ResponseReceived)),
        }
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        self.connection.stop();
    }
}

impl fmt::Debug for Subscription {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Subscription")
            .field("cursor", &self.cursor)
            .field("connected", &self.connection.is_connected())
            .finish_non_exhaustive()
    }
}
