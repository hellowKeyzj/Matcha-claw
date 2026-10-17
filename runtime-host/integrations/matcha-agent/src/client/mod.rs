mod connection;
mod error;
mod http;
mod schedule_receipts;
mod subscription;
mod websocket;

use std::{
    fmt,
    net::SocketAddr,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use serde_json::{Value, json};
use tokio::sync::Mutex;
use tokio_util::{sync::CancellationToken, task::TaskTracker};

use crate::{lifecycle::secret::Secret, protocol::wire::APP_SERVER_PROTOCOL_VERSION};

use connection::Connection;
pub use error::{Delivery, Error};
pub use schedule_receipts::{ScheduleReceiptChange, ScheduleReceiptSubscription};
pub use subscription::{Event, Subscription};

const REQUEST_DEADLINE: Duration = Duration::from_secs(30);
const MAX_REQUEST_ID: u64 = 9_007_199_254_740_991;
static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone)]
pub struct Client {
    inner: Arc<Inner>,
}

struct Inner {
    address: SocketAddr,
    secret: Arc<Secret>,
    control: Mutex<Option<Arc<Connection>>>,
    connected: std::sync::Mutex<Option<std::sync::Weak<Connection>>>,
    stopped: CancellationToken,
    admission: std::sync::Mutex<()>,
    tasks: TaskTracker,
}

impl Client {
    pub fn new(address: SocketAddr, secret: Arc<Secret>) -> Self {
        Self {
            inner: Arc::new(Inner {
                address,
                secret,
                control: Mutex::new(None),
                connected: std::sync::Mutex::new(None),
                stopped: CancellationToken::new(),
                admission: std::sync::Mutex::new(()),
                tasks: TaskTracker::new(),
            }),
        }
    }

    pub async fn call(&self, method: &str, params: Value) -> Result<Value, Error> {
        self.call_cancellable(method, params, &CancellationToken::new())
            .await
    }

    pub async fn call_cancellable(
        &self,
        method: &str,
        params: Value,
        cancellation: &CancellationToken,
    ) -> Result<Value, Error> {
        if method.trim().is_empty() || !matches!(params, Value::Object(_) | Value::Array(_)) {
            return Err(Error::local("invalid_params", Delivery::NotSent));
        }
        let connection = self.control(cancellation).await?;
        // A call is never reissued, including cancellation, EOF and response loss.
        connection
            .call(next_id()?, method, params, cancellation)
            .await
    }

    pub async fn subscribe(&self, session_id: &str, after_seq: u64) -> Result<Subscription, Error> {
        subscription::open(self, session_id, after_seq).await
    }

    pub async fn subscribe_schedule_receipts(
        &self,
        after_seq: u64,
    ) -> Result<ScheduleReceiptSubscription, Error> {
        schedule_receipts::open(self, after_seq).await
    }

    pub fn is_connected(&self) -> bool {
        !self.inner.stopped.is_cancelled()
            && self
                .inner
                .connected
                .lock()
                .expect("connection observation is not poisoned")
                .as_ref()
                .and_then(std::sync::Weak::upgrade)
                .is_some_and(|connection| connection.is_connected())
    }

    pub async fn shutdown(&self) -> Result<(), Error> {
        {
            let _admission = self
                .inner
                .admission
                .lock()
                .expect("connection admission is not poisoned");
            self.inner.stopped.cancel();
            self.inner.tasks.close();
        }
        // In-flight opens hold tracker tokens until their socket tasks are registered or dropped.
        let mut control = self.inner.control.lock().await;
        let result = match control.as_ref() {
            Some(connection) => connection.close().await,
            None => Ok(()),
        };
        control.take();
        self.inner.tasks.close();
        self.inner.tasks.wait().await;
        result
    }

    pub async fn probe_ready(&self, cancellation: &CancellationToken) -> Result<(), Error> {
        let health = self.http_json("/health", cancellation).await?;
        if health.get("ok").and_then(Value::as_bool) != Some(true)
            || health.get("scope").and_then(Value::as_str) != Some("http")
        {
            return Err(Error::local("protocol", Delivery::ResponseReceived));
        }
        let version = self.http_json("/version", cancellation).await?;
        if version.get("protocolVersion").and_then(Value::as_str)
            != Some(APP_SERVER_PROTOCOL_VERSION)
        {
            return Err(Error::local(
                "unsupported_protocol",
                Delivery::ResponseReceived,
            ));
        }
        self.control(cancellation).await?;
        Ok(())
    }

    async fn control(&self, cancellation: &CancellationToken) -> Result<Arc<Connection>, Error> {
        let mut control = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(Error::local("cancelled", Delivery::NotSent)),
            _ = self.inner.stopped.cancelled() => return Err(Error::local("client_shutdown", Delivery::NotSent)),
            control = self.inner.control.lock() => control,
        };
        if let Some(connection) = control.as_ref() {
            if connection.is_connected() {
                return Ok(connection.clone());
            }
            let _ = connection.close().await;
            control.take();
        }
        let connection = self.open(None, cancellation).await?;
        *self
            .inner
            .connected
            .lock()
            .expect("connection observation is not poisoned") = Some(Arc::downgrade(&connection));
        *control = Some(connection.clone());
        Ok(connection)
    }

    async fn open(
        &self,
        notifications: Option<
            tokio::sync::mpsc::Sender<crate::protocol::wire::JsonRpcNotification>,
        >,
        cancellation: &CancellationToken,
    ) -> Result<Arc<Connection>, Error> {
        // The tracker token covers in-flight handshakes as well as the eventual socket task.
        let _opening = self.operation()?;
        let socket = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(Error::local("cancelled", Delivery::NotSent)),
            _ = self.inner.stopped.cancelled() => return Err(Error::local("client_shutdown", Delivery::NotSent)),
            socket = websocket::connect(self.inner.address) => socket?,
        };
        let connection = Arc::new(Connection::new(
            socket,
            notifications,
            &self.inner.tasks,
            self.inner.stopped.child_token(),
        ));
        let token = self.inner.secret.issue_bearer_token();
        let initialized = connection
            .call(
                next_id()?,
                "initialize",
                json!({
                    "protocolVersion": APP_SERVER_PROTOCOL_VERSION,
                    "token": token.as_str(),
                }),
                cancellation,
            )
            .await;
        drop(token);
        let initialized = match initialized {
            Ok(initialized)
                if initialized.get("protocolVersion").and_then(Value::as_str)
                    == Some(APP_SERVER_PROTOCOL_VERSION) =>
            {
                Ok(())
            }
            Ok(_) => Err(Error::local("unsupported_protocol", Delivery::NotSent)),
            // Initialize cannot have delivered the caller's subsequent business command.
            Err(error) => Err(error.with_delivery(Delivery::NotSent)),
        };
        if let Err(error) = initialized {
            let _ = connection.close().await;
            return Err(error);
        }
        Ok(connection)
    }

    fn operation(&self) -> Result<tokio_util::task::task_tracker::TaskTrackerToken, Error> {
        let _admission = self
            .inner
            .admission
            .lock()
            .expect("connection admission is not poisoned");
        self.validate_endpoint()?;
        Ok(self.inner.tasks.token())
    }

    fn validate_endpoint(&self) -> Result<(), Error> {
        if self.inner.address.port() == 0 || !self.inner.address.ip().is_loopback() {
            return Err(Error::local("invalid_endpoint", Delivery::NotSent));
        }
        if self.inner.stopped.is_cancelled() {
            return Err(Error::local("client_shutdown", Delivery::NotSent));
        }
        Ok(())
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        self.stopped.cancel();
        self.tasks.close();
    }
}

impl fmt::Debug for Client {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Client")
            .field("connected", &self.is_connected())
            .finish_non_exhaustive()
    }
}

fn next_id() -> Result<u64, Error> {
    NEXT_REQUEST_ID
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |id| {
            (id < MAX_REQUEST_ID).then_some(id + 1)
        })
        .map_err(|_| Error::local("request_id_exhausted", Delivery::NotSent))
}
