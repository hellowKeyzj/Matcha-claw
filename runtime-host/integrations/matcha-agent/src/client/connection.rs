use std::{
    collections::HashMap,
    future::poll_fn,
    pin::Pin,
    sync::{
        Arc, Mutex as SyncMutex,
        atomic::{AtomicU8, Ordering},
    },
    time::Duration,
};

use futures_util::{
    Sink, SinkExt, StreamExt,
    stream::{SplitSink, SplitStream},
};
use serde_json::Value;
use tokio::{
    sync::{Mutex, mpsc, oneshot},
    task::JoinHandle,
    time::{Instant, timeout_at},
};
use tokio_tungstenite::tungstenite::{
    Error as SocketError, Message,
    error::ProtocolError,
    protocol::{CloseFrame, frame::coding::CloseCode},
};
use tokio_util::{
    sync::CancellationToken,
    task::{AbortOnDropHandle, TaskTracker},
};

use crate::protocol::wire::{self, JsonRpcId, JsonRpcMessage, JsonRpcRequest, JsonRpcResponse};

use super::{Delivery, Error, REQUEST_DEADLINE, websocket::Socket};

const QUEUED: u8 = 0;
const SENT: u8 = 1;
const CANCELLED: u8 = 2;
const CLOSE_DEADLINE: Duration = Duration::from_secs(1);

#[derive(Clone, Copy)]
enum ReadEnd {
    Stopped,
    PeerClosed,
}

enum WriteEnd {
    Stopped,
    CloseObserved,
}

struct Awaited {
    response: oneshot::Sender<Result<Value, Error>>,
    progress: Arc<AtomicU8>,
}

type Pending = Arc<SyncMutex<HashMap<u64, Awaited>>>;

struct Outbound {
    text: String,
    progress: Arc<AtomicU8>,
    expires_at: Instant,
}

pub(super) struct Connection {
    output: mpsc::Sender<Outbound>,
    pending: Pending,
    stopped: CancellationToken,
    failure: Arc<SyncMutex<Option<Error>>>,
    task: Mutex<Option<JoinHandle<Result<(), Error>>>>,
}

impl Connection {
    pub(super) fn new(
        socket: Socket,
        notifications: Option<mpsc::Sender<wire::JsonRpcNotification>>,
        tasks: &TaskTracker,
        stopped: CancellationToken,
    ) -> Self {
        let (writer, reader) = socket.split();
        let (output, queued) = mpsc::channel(1);
        let pending = Arc::new(SyncMutex::new(HashMap::new()));
        let reading = stopped.clone();
        let writing = stopped.clone();
        let closing = stopped.clone();
        let requests = pending.clone();
        let failure = Arc::new(SyncMutex::new(None));
        let failed = failure.clone();
        let task = tasks.spawn(async move {
            let closed_notifications = notifications.clone();
            let mut reader = AbortOnDropHandle::new(tokio::spawn(read_messages(
                reader,
                requests.clone(),
                notifications,
                reading,
            )));
            let mut writer =
                AbortOnDropHandle::new(tokio::spawn(write_messages(writer, queued, writing)));
            let (mut read, mut write) = tokio::select! {
                biased;
                _ = closing.cancelled() => (None, None),
                result = &mut reader => (Some(joined(result)), None),
                result = &mut writer => (None, Some(joined(result))),
            };
            let failure = read
                .as_ref()
                .and_then(|result| result.as_ref().err())
                .or_else(|| write.as_ref().and_then(|result| result.as_ref().err()))
                .cloned();
            *failed.lock().expect("connection failure is not poisoned") = failure.clone();
            closing.cancel();
            fail_pending(&requests, failure.as_ref());
            // Joining and the wire handshake share one deadline; aborts are also awaited.
            let expires_at = Instant::now() + CLOSE_DEADLINE;
            if let Some(error) = &failure {
                trace_failure(
                    if read.is_some() {
                        "reader_terminal"
                    } else {
                        "writer_terminal"
                    },
                    error,
                );
            }
            let read = match read.take() {
                Some(result) => result,
                None => finish(&mut reader, expires_at, "reader_finish_timeout").await,
            };
            let write = match write.take() {
                Some(result) => result,
                None => finish(&mut writer, expires_at, "writer_finish_timeout").await,
            };
            drop(closed_notifications);
            if let Err(error) = &read {
                trace_failure("reader_finish", error);
            }
            if let Err(error) = &write {
                trace_failure("writer_finish", error);
            }
            if let Some(error) = failure {
                return Err(error);
            }
            let (reader, read_end) = read?;
            let (writer, write_end) = write?;
            if matches!(write_end, WriteEnd::CloseObserved)
                && !matches!(read_end, ReadEnd::PeerClosed)
            {
                return Err(Error::local("transport", Delivery::Unknown));
            }
            // Reuniting drops any unsent SplitSink slot; SENT requests remain Unknown.
            let mut socket = writer
                .reunite(reader)
                .map_err(|_| Error::local("protocol", Delivery::Unknown))?;
            close_socket(&mut socket, read_end, expires_at).await
        });
        Self {
            output,
            pending,
            stopped,
            failure,
            task: Mutex::new(Some(task)),
        }
    }

    pub(super) fn is_connected(&self) -> bool {
        !self.stopped.is_cancelled()
    }

    pub(super) fn stop(&self) {
        self.stopped.cancel();
    }

    pub(super) fn failure(&self) -> Error {
        self.failure
            .lock()
            .expect("connection failure is not poisoned")
            .clone()
            .unwrap_or_else(|| Error::local("connection_closed", Delivery::Unknown))
    }

    pub(super) async fn call(
        &self,
        id: u64,
        method: &str,
        params: Value,
        cancellation: &CancellationToken,
    ) -> Result<Value, Error> {
        let request = JsonRpcRequest::new(JsonRpcId::Number(id.into()), method, Some(params));
        let text = wire::encode(&request.into())
            .map_err(|_| Error::local("protocol", Delivery::NotSent))?;
        let expires_at = Instant::now() + REQUEST_DEADLINE;
        let progress = Arc::new(AtomicU8::new(QUEUED));
        let (response, mut receiver) = oneshot::channel();
        let mut guard = RequestGuard {
            id,
            pending: self.pending.clone(),
            progress: progress.clone(),
        };
        requests(&self.pending).insert(
            id,
            Awaited {
                response,
                progress: progress.clone(),
            },
        );
        if !self.is_connected() {
            return Err(guard.failure("connection_closed"));
        }
        let queued = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(guard.failure("cancelled")),
            _ = self.stopped.cancelled() => return Err(guard.failure("connection_closed")),
            queued = timeout_at(expires_at, self.output.send(Outbound { text, progress, expires_at })) => queued,
        };
        match queued {
            Ok(Ok(())) => {}
            Ok(Err(_)) => return Err(guard.failure("connection_closed")),
            Err(_) => return Err(guard.failure("deadline")),
        }
        let kind = tokio::select! {
            biased;
            response = &mut receiver => return response.unwrap_or_else(|_| Err(guard.failure("connection_closed"))),
            _ = cancellation.cancelled() => "cancelled",
            _ = self.stopped.cancelled() => "connection_closed",
            _ = tokio::time::sleep_until(expires_at) => "deadline",
        };
        // Serialize with dispatch before deciding: a response already observed wins cancellation/EOF.
        let delivery_error = {
            let mut pending = requests(&self.pending);
            pending.remove(&id);
            let error = guard.failure(kind);
            if kind == "connection_closed" {
                self.failure().with_delivery(error.delivery())
            } else {
                error
            }
        };
        receiver.close();
        match receiver.try_recv() {
            Ok(response) => response,
            Err(_) => Err(delivery_error),
        }
    }

    pub(super) async fn close(&self) -> Result<(), Error> {
        self.stop();
        let mut task = self.task.lock().await;
        match task.as_mut() {
            Some(join) => {
                let result = joined(join.await);
                task.take();
                if let Err(error) = &result {
                    trace_failure("owner_join", error);
                }
                result
            }
            None => Ok(()),
        }
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        self.stop();
        // The owner task completes cleanup and joins both socket halves even if its handle is dropped.
    }
}

struct RequestGuard {
    id: u64,
    pending: Pending,
    progress: Arc<AtomicU8>,
}

impl RequestGuard {
    fn failure(&mut self, kind: &'static str) -> Error {
        let delivery = match self.progress.compare_exchange(
            QUEUED,
            CANCELLED,
            Ordering::AcqRel,
            Ordering::Acquire,
        ) {
            Ok(_) | Err(CANCELLED) => Delivery::NotSent,
            Err(_) => Delivery::Unknown,
        };
        Error::local(kind, delivery)
    }
}

impl Drop for RequestGuard {
    fn drop(&mut self) {
        let _ =
            self.progress
                .compare_exchange(QUEUED, CANCELLED, Ordering::AcqRel, Ordering::Acquire);
        requests(&self.pending).remove(&self.id);
    }
}

async fn write_messages(
    mut writer: SplitSink<Socket, Message>,
    mut queued: mpsc::Receiver<Outbound>,
    stopped: CancellationToken,
) -> Result<(SplitSink<Socket, Message>, WriteEnd), Error> {
    let result = async {
        loop {
            let outbound = tokio::select! {
                biased;
                _ = stopped.cancelled() => return Ok(WriteEnd::Stopped),
                outbound = queued.recv() => match outbound { Some(outbound) => outbound, None => return Ok(WriteEnd::Stopped) },
            };
            if outbound.progress.load(Ordering::Acquire) == CANCELLED {
                continue;
            }
            tokio::select! {
                biased;
                _ = stopped.cancelled() => return Ok(WriteEnd::Stopped),
                ready = timeout_at(outbound.expires_at, poll_fn(|cx| Sink::poll_ready(Pin::new(&mut writer), cx))) => {
                    if let Err(error) = ready.map_err(|_| Error::local("deadline", Delivery::NotSent))? {
                        return write_error(error, Delivery::NotSent);
                    }
                },
            }
            if outbound.progress.compare_exchange(QUEUED, SENT, Ordering::AcqRel, Ordering::Acquire).is_err() {
                continue;
            }
            if let Err(error) = Sink::start_send(Pin::new(&mut writer), Message::Text(outbound.text.into())) {
                return write_error(error, Delivery::Unknown);
            }
            tokio::select! {
                biased;
                _ = stopped.cancelled() => return Ok(WriteEnd::Stopped),
                flushed = timeout_at(outbound.expires_at, writer.flush()) => {
                    if let Err(error) = flushed.map_err(|_| Error::local("deadline", Delivery::Unknown))? {
                        return write_error(error, Delivery::Unknown);
                    }
                },
            }
        }
    }.await;
    result.map(|end| (writer, end))
}

fn write_error(error: SocketError, delivery: Delivery) -> Result<WriteEnd, Error> {
    match error {
        SocketError::ConnectionClosed
        | SocketError::AlreadyClosed
        | SocketError::Protocol(ProtocolError::SendAfterClosing) => Ok(WriteEnd::CloseObserved),
        _ => Err(Error::local("transport", delivery)),
    }
}

async fn read_messages(
    mut reader: SplitStream<Socket>,
    pending: Pending,
    notifications: Option<mpsc::Sender<wire::JsonRpcNotification>>,
    stopped: CancellationToken,
) -> Result<(SplitStream<Socket>, ReadEnd), Error> {
    loop {
        let message = tokio::select! {
            biased;
            _ = stopped.cancelled() => return Ok((reader, ReadEnd::Stopped)),
            message = reader.next() => message,
        };
        match message {
            Some(Ok(Message::Text(text))) => {
                match wire::decode(text.as_str())
                    .map_err(|_| Error::local("protocol", Delivery::Unknown))?
                {
                    JsonRpcMessage::Response(response) => {
                        let (id, response) = match response {
                            JsonRpcResponse::Success(success) => {
                                (numeric_id(&success.id), Ok(success.result))
                            }
                            JsonRpcResponse::Failure(failure) => (
                                failure.id.as_ref().and_then(numeric_id),
                                Err(Error::remote(failure.error)),
                            ),
                        };
                        let id = id.ok_or_else(|| Error::local("protocol", Delivery::Unknown))?;
                        // Late responses to cancelled/timed-out requests are not failures of other calls.
                        let mut pending = requests(&pending);
                        if let Some(awaited) = pending.remove(&id) {
                            let _ = awaited.response.send(response);
                        }
                    }
                    JsonRpcMessage::Notification(notification) => {
                        let output = notifications
                            .as_ref()
                            .ok_or_else(|| Error::local("protocol", Delivery::Unknown))?;
                        tokio::select! {
                            biased;
                            _ = stopped.cancelled() => return Ok((reader, ReadEnd::Stopped)),
                            sent = output.send(notification) => sent.map_err(|_| Error::local("connection_closed", Delivery::Unknown))?,
                        }
                    }
                    JsonRpcMessage::Request(_) => {
                        return Err(Error::local("protocol", Delivery::Unknown));
                    }
                }
            }
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
            Some(Ok(Message::Close(frame))) => {
                validate_close(frame.as_ref())?;
                return Ok((reader, ReadEnd::PeerClosed));
            }
            None => {
                let error = Error::local("connection_closed", Delivery::Unknown);
                trace_failure("reader_eof_without_close", &error);
                return Err(error);
            }
            Some(Ok(Message::Binary(_) | Message::Frame(_))) => {
                return Err(Error::local("protocol", Delivery::Unknown));
            }
            Some(Err(error)) => return Err(read_error(error)),
        }
    }
}

fn read_error(error: SocketError) -> Error {
    let phase = match error {
        SocketError::Protocol(ProtocolError::ResetWithoutClosingHandshake) => {
            "reader_reset_without_close"
        }
        SocketError::Io(_) => "reader_io",
        SocketError::Protocol(_) => "reader_websocket_protocol",
        _ => "reader_websocket_error",
    };
    let error = Error::local("transport", Delivery::Unknown);
    trace_failure(phase, &error);
    error
}

fn validate_close(frame: Option<&CloseFrame>) -> Result<(), Error> {
    match frame.map(|frame| frame.code) {
        None | Some(CloseCode::Normal | CloseCode::Away) => Ok(()),
        _ => Err(Error::local("protocol", Delivery::Unknown)),
    }
}

async fn close_socket(socket: &mut Socket, end: ReadEnd, expires_at: Instant) -> Result<(), Error> {
    let result = timeout_at(expires_at, async {
        if matches!(end, ReadEnd::Stopped) {
            if SinkExt::close(socket).await.is_err() {
                let error = Error::local("close_failed", Delivery::Unknown);
                trace_failure("writer_close_io", &error);
                return Err(error);
            }
            loop {
                match socket.next().await {
                    Some(Ok(Message::Close(frame))) => {
                        validate_close(frame.as_ref())?;
                        break;
                    }
                    None => return Err(Error::local("connection_closed", Delivery::Unknown)),
                    Some(Err(error)) => return Err(read_error(error)),
                    // Already-sent frames can precede the peer's Close; do not dispatch them.
                    Some(Ok(Message::Text(_) | Message::Ping(_) | Message::Pong(_))) => {}
                    Some(Ok(_)) => return Err(Error::local("protocol", Delivery::Unknown)),
                }
            }
        }
        // A valid Close was observed on either path. Flush its automatic response, not a new Close.
        match socket.flush().await {
            Ok(()) | Err(SocketError::ConnectionClosed | SocketError::AlreadyClosed) => Ok(()),
            Err(_) => {
                let error = Error::local("close_failed", Delivery::Unknown);
                trace_failure("writer_close_io", &error);
                Err(error)
            }
        }
    })
    .await;
    match result {
        Ok(result) => {
            if let Err(error) = &result {
                trace_failure("close_handshake", error);
            }
            result
        }
        Err(_) => {
            let error = Error::local("close_failed", Delivery::Unknown);
            trace_failure("close_handshake_timeout", &error);
            Err(error)
        }
    }
}

fn numeric_id(id: &JsonRpcId) -> Option<u64> {
    match id {
        JsonRpcId::Number(id) => id.as_u64(),
        JsonRpcId::String(_) => None,
    }
}

fn requests(pending: &Pending) -> std::sync::MutexGuard<'_, HashMap<u64, Awaited>> {
    pending.lock().expect("request registry is not poisoned")
}

fn fail_pending(pending: &Pending, failure: Option<&Error>) {
    for (_, awaited) in requests(pending).drain() {
        let delivery = match awaited.progress.compare_exchange(
            QUEUED,
            CANCELLED,
            Ordering::AcqRel,
            Ordering::Acquire,
        ) {
            Ok(_) | Err(CANCELLED) => Delivery::NotSent,
            Err(_) => Delivery::Unknown,
        };
        let error = failure
            .cloned()
            .unwrap_or_else(|| Error::local("connection_closed", delivery));
        let _ = awaited.response.send(Err(error.with_delivery(delivery)));
    }
}

fn trace_failure(phase: &'static str, error: &Error) {
    platform::trace::runtime_trace("matcha.client.connection.failed", || {
        serde_json::json!({
            "phase": phase,
            "error": format!("{error:?}"),
            "delivery": format!("{:?}", error.delivery()),
        })
    });
}

fn joined<T>(result: Result<Result<T, Error>, tokio::task::JoinError>) -> Result<T, Error> {
    result.map_err(|_| Error::local("connection_task_failed", Delivery::Unknown))?
}

async fn finish<T>(
    task: &mut AbortOnDropHandle<Result<T, Error>>,
    expires_at: Instant,
    timeout_phase: &'static str,
) -> Result<T, Error> {
    match timeout_at(expires_at, &mut *task).await {
        Ok(result) => joined(result),
        Err(_) => {
            task.abort();
            let _ = task.await;
            let error = Error::local("close_failed", Delivery::Unknown);
            trace_failure(timeout_phase, &error);
            Err(error)
        }
    }
}
