use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex as SyncMutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use futures_util::{SinkExt, StreamExt, stream::SplitSink};
use tokio::{
    sync::{Mutex, oneshot},
    task::JoinHandle,
    time::{Instant, timeout, timeout_at},
};
use tokio_tungstenite::tungstenite::Message;

use crate::protocol::wire::{self, JsonRpcId, JsonRpcMessage, JsonRpcRequest, JsonRpcResponse};

use super::{
    super::protocol_event::decode_event_notification, AppServerClientError, events::Ingress,
    websocket::AppServerSocket,
};

const CLOSE_DEADLINE: Duration = Duration::from_secs(1);
pub(super) const EVENT_CHANNEL_CAPACITY: usize = 256;

type SocketWriter = SplitSink<AppServerSocket, Message>;
type PendingRequests = Arc<SyncMutex<HashMap<u64, oneshot::Sender<AwaitedResponse>>>>;
type AwaitedResponse = Result<JsonRpcResponse, AwaitFailure>;

pub(super) struct Connection {
    writer: Arc<Mutex<SocketWriter>>,
    pending: PendingRequests,
    closed: Arc<AtomicBool>,
    reader: Option<JoinHandle<()>>,
}

impl Connection {
    pub(super) fn new(socket: AppServerSocket, events: Ingress) -> Self {
        let (writer, reader) = socket.split();
        let writer = Arc::new(Mutex::new(writer));
        let pending = Arc::new(SyncMutex::new(HashMap::new()));
        let closed = Arc::new(AtomicBool::new(false));
        let reader = tokio::spawn(read_messages(
            reader,
            Arc::clone(&writer),
            Arc::clone(&pending),
            events,
            Arc::clone(&closed),
        ));
        Self {
            writer,
            pending,
            closed,
            reader: Some(reader),
        }
    }

    pub(super) async fn exchange(
        &self,
        request: JsonRpcRequest,
        deadline: Duration,
    ) -> Result<JsonRpcResponse, ExchangeFailure> {
        let id =
            numeric_id(&request.id).ok_or(ExchangeFailure::not_written(AwaitFailure::Protocol))?;
        let encoded = wire::encode(&JsonRpcMessage::from(request))
            .map_err(|_| ExchangeFailure::not_written(AwaitFailure::Protocol))?;
        let expires_at = Instant::now() + deadline;
        let mut writer = timeout_at(expires_at, self.writer.lock())
            .await
            .map_err(|_| ExchangeFailure::not_written(AwaitFailure::Deadline))?;
        if self.closed.load(Ordering::Acquire) {
            return Err(ExchangeFailure::not_written(AwaitFailure::Closed));
        }

        let (sender, receiver) = oneshot::channel();
        pending(&self.pending).insert(id, sender);
        let _registration = PendingRegistration {
            id,
            pending: Arc::clone(&self.pending),
        };
        if self.closed.load(Ordering::Acquire) {
            return Err(ExchangeFailure::not_written(AwaitFailure::Closed));
        }
        match timeout_at(expires_at, writer.send(Message::Text(encoded.into()))).await {
            Ok(Ok(())) => {}
            Ok(Err(_)) => {
                drop(writer);
                fail_connection(&self.pending, &self.closed, AwaitFailure::Closed);
                return Err(ExchangeFailure::written(AwaitFailure::Transport));
            }
            Err(_) => {
                drop(writer);
                fail_connection(&self.pending, &self.closed, AwaitFailure::Deadline);
                return Err(ExchangeFailure::written(AwaitFailure::Deadline));
            }
        }
        drop(writer);
        match timeout_at(expires_at, receiver).await {
            Ok(Ok(response)) => response.map_err(ExchangeFailure::written),
            Ok(Err(_)) => Err(ExchangeFailure::written(AwaitFailure::Closed)),
            Err(_) => {
                fail_connection(&self.pending, &self.closed, AwaitFailure::Deadline);
                Err(ExchangeFailure::written(AwaitFailure::Deadline))
            }
        }
    }

    pub(super) async fn close(mut self) -> Result<(), AppServerClientError> {
        fail_connection(&self.pending, &self.closed, AwaitFailure::Closed);
        let expires_at = Instant::now() + CLOSE_DEADLINE;
        let result = match timeout_at(expires_at, self.writer.lock()).await {
            Ok(mut writer) => match timeout_at(expires_at, writer.send(Message::Close(None))).await
            {
                Ok(Ok(())) => Ok(()),
                Ok(Err(_)) | Err(_) => Err(AppServerClientError::CloseFailed),
            },
            Err(_) => Err(AppServerClientError::CloseFailed),
        };
        if let Some(mut reader) = self.reader.take()
            && timeout_at(expires_at, &mut reader).await.is_err()
        {
            reader.abort();
            let _ = reader.await;
        }
        result
    }

    pub(super) fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        fail_connection(&self.pending, &self.closed, AwaitFailure::Closed);
        if let Some(reader) = self.reader.take() {
            reader.abort();
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum Delivery {
    NotWritten,
    Written,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct ExchangeFailure {
    delivery: Delivery,
    reason: AwaitFailure,
}

impl ExchangeFailure {
    const fn not_written(reason: AwaitFailure) -> Self {
        Self {
            delivery: Delivery::NotWritten,
            reason,
        }
    }

    const fn written(reason: AwaitFailure) -> Self {
        Self {
            delivery: Delivery::Written,
            reason,
        }
    }

    pub(super) const fn delivery(self) -> Delivery {
        self.delivery
    }

    pub(super) const fn into_client_error(self) -> AppServerClientError {
        match self.reason {
            AwaitFailure::Deadline => AppServerClientError::RequestDeadline,
            AwaitFailure::Closed => AppServerClientError::ConnectionClosed,
            AwaitFailure::UnknownResponse => AppServerClientError::UnknownResponse,
            AwaitFailure::Transport => AppServerClientError::Transport,
            AwaitFailure::Protocol => AppServerClientError::Protocol,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AwaitFailure {
    Deadline,
    Closed,
    UnknownResponse,
    Transport,
    Protocol,
}

struct PendingRegistration {
    id: u64,
    pending: PendingRequests,
}

impl Drop for PendingRegistration {
    fn drop(&mut self) {
        pending(&self.pending).remove(&self.id);
    }
}

fn pending(
    requests: &PendingRequests,
) -> std::sync::MutexGuard<'_, HashMap<u64, oneshot::Sender<AwaitedResponse>>> {
    requests
        .lock()
        .expect("pending request lock is not poisoned")
}

async fn read_messages(
    mut reader: futures_util::stream::SplitStream<AppServerSocket>,
    writer: Arc<Mutex<SocketWriter>>,
    pending_requests: PendingRequests,
    events: Ingress,
    closed: Arc<AtomicBool>,
) {
    let failure = loop {
        match reader.next().await {
            Some(Ok(Message::Text(text))) => {
                if let Err(failure) = route_text(text.as_str(), &pending_requests, &events).await {
                    break failure;
                }
            }
            Some(Ok(Message::Ping(payload))) => {
                if writer
                    .lock()
                    .await
                    .send(Message::Pong(payload))
                    .await
                    .is_err()
                {
                    break AwaitFailure::Transport;
                }
            }
            Some(Ok(Message::Pong(_))) => {}
            Some(Ok(Message::Close(frame))) => {
                let _ = writer.lock().await.send(Message::Close(frame)).await;
                break AwaitFailure::Closed;
            }
            Some(Ok(Message::Binary(_) | Message::Frame(_))) => break AwaitFailure::Protocol,
            Some(Err(_)) => break AwaitFailure::Transport,
            None => break AwaitFailure::Closed,
        }
    };
    fail_connection(&pending_requests, &closed, failure);
    events.connection_closed().await;
    if let Ok(mut writer) = timeout(CLOSE_DEADLINE, writer.lock()).await {
        let _ = timeout(CLOSE_DEADLINE, writer.close()).await;
    }
}

async fn route_text(
    text: &str,
    pending_requests: &PendingRequests,
    events: &Ingress,
) -> Result<(), AwaitFailure> {
    for frame in text.lines().filter(|line| !line.trim().is_empty()) {
        match wire::decode(frame).map_err(|_| AwaitFailure::Protocol)? {
            JsonRpcMessage::Response(response) => {
                let id = response_id(&response).ok_or(AwaitFailure::UnknownResponse)?;
                let sender = pending(pending_requests)
                    .remove(&id)
                    .ok_or(AwaitFailure::UnknownResponse)?;
                let _ = sender.send(Ok(response));
            }
            JsonRpcMessage::Notification(notification) => {
                let event =
                    decode_event_notification(notification).map_err(|_| AwaitFailure::Protocol)?;
                events.ingest(event).map_err(|_| AwaitFailure::Closed)?;
            }
            JsonRpcMessage::Request(_) => return Err(AwaitFailure::Protocol),
        }
    }
    Ok(())
}

fn fail_connection(requests: &PendingRequests, closed: &AtomicBool, failure: AwaitFailure) {
    closed.store(true, Ordering::Release);
    for sender in pending(requests).drain().map(|(_, sender)| sender) {
        let _ = sender.send(Err(failure));
    }
}

fn response_id(response: &JsonRpcResponse) -> Option<u64> {
    match response {
        JsonRpcResponse::Success(success) => numeric_id(&success.id),
        JsonRpcResponse::Failure(failure) => failure.id.as_ref().and_then(numeric_id),
    }
}

fn numeric_id(id: &JsonRpcId) -> Option<u64> {
    match id {
        JsonRpcId::Number(number) => number.as_u64(),
        JsonRpcId::String(_) => None,
    }
}
