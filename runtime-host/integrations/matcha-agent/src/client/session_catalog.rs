use std::{fmt, sync::Arc};

use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::protocol::wire::JsonRpcNotification;

use super::{Client, Delivery, Error, connection::Connection, next_id};

pub struct SessionCatalogSubscription {
    _client: Client,
    connection: Arc<Connection>,
    notifications: mpsc::Receiver<JsonRpcNotification>,
    failure: Option<Error>,
}

pub(super) async fn open(client: &Client) -> Result<SessionCatalogSubscription, Error> {
    let (output, notifications) = mpsc::channel(1);
    let connection = client.open(Some(output), &CancellationToken::new()).await?;
    let subscription = SessionCatalogSubscription {
        _client: client.clone(),
        connection,
        notifications,
        failure: None,
    };
    let result = subscription
        .connection
        .call(
            next_id()?,
            "sessions.subscribeCatalog",
            json!({}),
            &CancellationToken::new(),
        )
        .await;
    match result {
        Ok(result) if result == json!({"delivery": "live_invalidation"}) => Ok(subscription),
        result => {
            let error = result
                .err()
                .unwrap_or_else(|| Error::local("protocol", Delivery::ResponseReceived));
            let _ = subscription.connection.close().await;
            Err(error)
        }
    }
}

impl SessionCatalogSubscription {
    pub async fn recv(&mut self) -> Result<(), Error> {
        if let Some(error) = &self.failure {
            return Err(error.clone());
        }
        let result = match self.notifications.recv().await {
            Some(notification)
                if notification.method == "sessions.catalogChanged"
                    && notification
                        .params
                        .as_ref()
                        .and_then(Value::as_object)
                        .is_some_and(|params| params.is_empty()) =>
            {
                Ok(())
            }
            Some(_) => Err(Error::local("protocol", Delivery::ResponseReceived)),
            None => Err(self.connection.failure()),
        };
        if let Err(error) = &result {
            self.connection.stop();
            self.failure = Some(error.clone());
        }
        result
    }

    pub async fn close(self) -> Result<(), Error> {
        self.connection.close().await
    }
}

impl Drop for SessionCatalogSubscription {
    fn drop(&mut self) {
        self.connection.stop();
    }
}

impl fmt::Debug for SessionCatalogSubscription {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionCatalogSubscription")
            .field("connected", &self.connection.is_connected())
            .finish_non_exhaustive()
    }
}
