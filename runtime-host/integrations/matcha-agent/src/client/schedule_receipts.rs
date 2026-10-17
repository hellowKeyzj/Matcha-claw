use std::{fmt, sync::Arc};

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::protocol::wire::{JsonRpcError, JsonRpcNotification};

use super::{Client, Delivery, Error, connection::Connection, next_id};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleReceiptChange {
    pub seq: u64,
    pub receipt_id: String,
    pub schedule_id: String,
    pub status: String,
    pub run_id: Option<String>,
}

impl fmt::Debug for ScheduleReceiptChange {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ScheduleReceiptChange")
            .field("seq", &self.seq)
            .finish_non_exhaustive()
    }
}

pub struct ScheduleReceiptSubscription {
    _client: Client,
    connection: Arc<Connection>,
    notifications: mpsc::Receiver<JsonRpcNotification>,
    cursor: u64,
    failure: Option<Error>,
}

pub(super) async fn open(
    client: &Client,
    after_seq: u64,
) -> Result<ScheduleReceiptSubscription, Error> {
    let (output, notifications) = mpsc::channel(1);
    let connection = client.open(Some(output), &CancellationToken::new()).await?;
    let subscription = ScheduleReceiptSubscription {
        _client: client.clone(),
        connection,
        notifications,
        cursor: after_seq,
        failure: None,
    };
    let result = subscription
        .connection
        .call(
            next_id()?,
            "schedules.subscribe",
            json!({
                "afterSeq": after_seq,
            }),
            &CancellationToken::new(),
        )
        .await;
    match result {
        Ok(result)
            if result.get("afterSeq").and_then(Value::as_u64) == Some(after_seq)
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
            Err(error)
        }
    }
}

impl ScheduleReceiptSubscription {
    pub async fn recv(&mut self) -> Result<ScheduleReceiptChange, Error> {
        if let Some(error) = &self.failure {
            return Err(error.clone());
        }
        let result = match self.notifications.recv().await {
            Some(notification) => self.decode(notification),
            None => Err(self.connection.failure()),
        };
        match result {
            Ok(change) => {
                self.cursor = change.seq;
                Ok(change)
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

    fn decode(&self, notification: JsonRpcNotification) -> Result<ScheduleReceiptChange, Error> {
        let params = notification
            .params
            .ok_or_else(|| Error::local("protocol", Delivery::ResponseReceived))?;
        match notification.method.as_str() {
            "schedules.receipt" => {
                let change: ScheduleReceiptChange = serde_json::from_value(params)
                    .map_err(|_| Error::local("protocol", Delivery::ResponseReceived))?;
                if change.receipt_id.is_empty()
                    || change.schedule_id.is_empty()
                    || change.status.is_empty()
                    || change.run_id.as_ref().is_some_and(String::is_empty)
                {
                    return Err(Error::local("protocol", Delivery::ResponseReceived));
                }
                if self.cursor.checked_add(1) != Some(change.seq) {
                    return Err(Error::local(
                        "schedules_sequence_gap",
                        Delivery::ResponseReceived,
                    ));
                }
                Ok(change)
            }
            "schedules.subscriptionError" => {
                if params.get("afterSeq").and_then(Value::as_u64) != Some(self.cursor) {
                    return Err(Error::local(
                        "schedules_sequence_gap",
                        Delivery::ResponseReceived,
                    ));
                }
                let code = params
                    .get("code")
                    .and_then(Value::as_i64)
                    .ok_or_else(|| Error::local("protocol", Delivery::ResponseReceived))?;
                if !params.get("message").is_some_and(Value::is_string) {
                    return Err(Error::local("protocol", Delivery::ResponseReceived));
                }
                Err(Error::remote(JsonRpcError::remote(
                    code,
                    params.get("data").cloned(),
                )))
            }
            _ => Err(Error::local("protocol", Delivery::ResponseReceived)),
        }
    }
}

impl Drop for ScheduleReceiptSubscription {
    fn drop(&mut self) {
        self.connection.stop();
    }
}

impl fmt::Debug for ScheduleReceiptSubscription {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ScheduleReceiptSubscription")
            .field("cursor", &self.cursor)
            .field("connected", &self.connection.is_connected())
            .finish_non_exhaustive()
    }
}
