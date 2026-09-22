use std::{
    collections::{HashMap, VecDeque},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use futures_util::{SinkExt, StreamExt};
use tokio::{
    sync::{mpsc, oneshot},
    task::JoinHandle,
    time::{Instant, timeout, timeout_at},
};
use tokio_tungstenite::tungstenite::Message;

use super::{
    client::GatewaySocket,
    delivery::DispatcherError,
    wire::{self, GatewayResponse, RpcRequest},
};

const COMMAND_CAPACITY: usize = 64;
const MAX_ACTIVE_REQUESTS: usize = 16;
const MAX_PENDING_REQUESTS: usize = 128;
const MAX_QUEUED_REQUESTS: usize = 64;
const CLOSE_DEADLINE: Duration = Duration::from_secs(1);
const MIN_REQUEST_DEADLINE: Duration = Duration::from_secs(1);

type Reply = oneshot::Sender<Result<GatewayResponse, ExchangeFailure>>;

type Pending = HashMap<String, PendingRequest>;

struct PendingRequest {
    request: Option<OutboundRequest>,
    reply: Reply,
    sent: Arc<AtomicBool>,
}

struct OutboundRequest {
    request_id: String,
    frame: OutboundFrame,
}

enum OutboundFrame {
    Rpc(RpcRequest),
    Encoded(String),
}

impl OutboundRequest {
    fn rpc(request: RpcRequest) -> Self {
        Self {
            request_id: request.request_id().to_owned(),
            frame: OutboundFrame::Rpc(request),
        }
    }

    fn encoded(request_id: String, encoded: String) -> Self {
        Self {
            request_id,
            frame: OutboundFrame::Encoded(encoded),
        }
    }

    fn request_id(&self) -> &str {
        &self.request_id
    }

    fn encode(self) -> Result<String, DispatcherError> {
        match self.frame {
            OutboundFrame::Rpc(request) => request.encode().map_err(|_| DispatcherError::Protocol),
            OutboundFrame::Encoded(encoded) => Ok(encoded),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ExchangeFailure {
    pub(crate) error: DispatcherError,
    pub(crate) sent: bool,
}

enum Command {
    Request {
        request: OutboundRequest,
        sent: Arc<AtomicBool>,
        reply: Reply,
    },
    Cancel {
        request_id: String,
    },
    Close,
}

struct ExchangeGuard<'a> {
    commands: &'a mpsc::Sender<Command>,
    request_id: Option<String>,
    receiver: oneshot::Receiver<Result<GatewayResponse, ExchangeFailure>>,
}

impl Drop for ExchangeGuard<'_> {
    fn drop(&mut self) {
        self.receiver.close();
        if let Some(request_id) = self.request_id.take() {
            let _ = self.commands.try_send(Command::Cancel { request_id });
        }
    }
}

/// The single owner of a connected gateway socket.
///
/// Callers only interact with the command channel; frame reads and writes are
/// serialized by the actor and responses are correlated by request id.
pub(crate) struct GatewayConnection {
    commands: mpsc::Sender<Command>,
    actor: Option<JoinHandle<()>>,
}

impl GatewayConnection {
    pub(crate) fn spawn(socket: GatewaySocket, events: mpsc::Sender<wire::GatewayEvent>) -> Self {
        let (commands, receiver) = mpsc::channel(COMMAND_CAPACITY);
        let actor = tokio::spawn(run_actor(socket, receiver, events));
        Self {
            commands,
            actor: Some(actor),
        }
    }

    pub(crate) async fn request(
        &self,
        request: RpcRequest,
        deadline: Duration,
    ) -> Result<GatewayResponse, ExchangeFailure> {
        self.exchange(OutboundRequest::rpc(request), deadline).await
    }

    pub(crate) async fn encoded_request(
        &self,
        request_id: String,
        encoded: String,
        deadline: Duration,
    ) -> Result<GatewayResponse, ExchangeFailure> {
        self.exchange(OutboundRequest::encoded(request_id, encoded), deadline)
            .await
    }

    async fn exchange(
        &self,
        request: OutboundRequest,
        deadline: Duration,
    ) -> Result<GatewayResponse, ExchangeFailure> {
        let request_id = request.request_id().to_owned();
        let sent = Arc::new(AtomicBool::new(false));
        let (reply, receiver) = oneshot::channel();
        let expires_at = Instant::now() + deadline.max(MIN_REQUEST_DEADLINE);
        match timeout_at(
            expires_at,
            self.commands.send(Command::Request {
                request,
                sent: Arc::clone(&sent),
                reply,
            }),
        )
        .await
        {
            Ok(Ok(())) => {}
            Ok(Err(_)) => {
                return Err(ExchangeFailure {
                    error: DispatcherError::ConnectionClosed,
                    sent: false,
                });
            }
            Err(_) => {
                return Err(ExchangeFailure {
                    error: DispatcherError::Deadline,
                    sent: false,
                });
            }
        }

        let mut guard = ExchangeGuard {
            commands: &self.commands,
            request_id: Some(request_id),
            receiver,
        };
        let result = timeout_at(expires_at, &mut guard.receiver).await;
        if result.is_ok() {
            guard.request_id = None;
        }
        drop(guard);
        match result {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(ExchangeFailure {
                error: DispatcherError::ConnectionClosed,
                sent: sent.load(Ordering::Acquire),
            }),
            Err(_) => Err(ExchangeFailure {
                error: DispatcherError::Deadline,
                sent: sent.load(Ordering::Acquire),
            }),
        }
    }

    pub(crate) async fn close(mut self) {
        let _ = self.commands.send(Command::Close).await;
        if let Some(mut actor) = self.actor.take() {
            if timeout(CLOSE_DEADLINE, &mut actor).await.is_err() {
                actor.abort();
                let _ = actor.await;
            }
        }
    }
}

impl Drop for GatewayConnection {
    fn drop(&mut self) {
        if let Some(actor) = self.actor.take() {
            actor.abort();
        }
    }
}

async fn run_actor(
    mut socket: GatewaySocket,
    mut commands: mpsc::Receiver<Command>,
    events: mpsc::Sender<wire::GatewayEvent>,
) {
    let mut closing = false;
    let mut pending = Pending::new();
    let mut queued = VecDeque::new();
    let failure = loop {
        // A full command channel can reject Cancel; closed replies remain authoritative.
        let previous_pending = pending.len();
        pending.retain(|_, request| !request.reply.is_closed());
        if pending.len() != previous_pending {
            queued.retain(|request_id| pending.contains_key(request_id));
            if let Err(error) = activate_queued(&mut socket, &mut pending, &mut queued).await {
                break error;
            }
        }
        tokio::select! {
            command = commands.recv() => match command {
                Some(Command::Request { request, sent, reply }) => {
                    if reply.is_closed() {
                        continue;
                    }
                    let request_id = request.request_id().to_owned();
                    if pending.contains_key(&request_id) || pending.len() >= MAX_PENDING_REQUESTS {
                        let _ = reply.send(Err(ExchangeFailure {
                            error: if pending.contains_key(&request_id) {
                                DispatcherError::Protocol
                            } else {
                                DispatcherError::Saturated
                            },
                            sent: false,
                        }));
                        continue;
                    }
                    pending.insert(request_id.clone(), PendingRequest {
                        request: Some(request),
                        reply,
                        sent: Arc::clone(&sent),
                    });
                    if active_count(&pending) >= MAX_ACTIVE_REQUESTS {
                        if queued.len() >= MAX_QUEUED_REQUESTS {
                            let request = pending.remove(&request_id).expect("request was inserted");
                            let _ = request.reply.send(Err(ExchangeFailure {
                                error: DispatcherError::Saturated,
                                sent: false,
                            }));
                        } else {
                            queued.push_back(request_id);
                        }
                    } else if let Err(error) = activate_request(&mut socket, &mut pending, &request_id).await {
                        break error;
                    }
                }
                Some(Command::Cancel { request_id }) => {
                    pending.remove(&request_id);
                    while queued.iter().any(|queued_id| queued_id == &request_id) {
                        queued.retain(|queued_id| queued_id != &request_id);
                    }
                    if let Err(error) = activate_queued(&mut socket, &mut pending, &mut queued).await {
                        break error;
                    }
                }
                Some(Command::Close) | None => {
                    closing = true;
                    break DispatcherError::ConnectionClosed;
                }
            },
            frame = socket.next() => match frame {
                Some(Ok(Message::Text(text))) => {
                    match route_text(text.as_str(), &mut pending, &events).await {
                        Ok(true) => {
                            if let Err(error) = activate_queued(&mut socket, &mut pending, &mut queued).await {
                                break error;
                            }
                        }
                        Ok(false) => {}
                        Err(error) => break error,
                    }
                }
                Some(Ok(Message::Ping(payload))) => {
                    if socket.send(Message::Pong(payload)).await.is_err() {
                        break DispatcherError::Transport;
                    }
                }
                Some(Ok(Message::Pong(_))) => {}
                Some(Ok(Message::Close(_))) | None => break DispatcherError::ConnectionClosed,
                Some(Ok(Message::Binary(_) | Message::Frame(_))) => break DispatcherError::Protocol,
                Some(Err(_)) => break DispatcherError::Transport,
            },
        }
    };

    fail_pending(&mut pending, failure);
    if closing {
        let _ = timeout(CLOSE_DEADLINE, socket.close(None)).await;
    }
}

async fn activate_queued(
    socket: &mut GatewaySocket,
    pending: &mut Pending,
    queued: &mut VecDeque<String>,
) -> Result<(), DispatcherError> {
    while active_count(pending) < MAX_ACTIVE_REQUESTS {
        let Some(request_id) = queued.pop_front() else {
            break;
        };
        if pending.contains_key(&request_id) {
            activate_request(socket, pending, &request_id).await?;
        }
    }
    Ok(())
}

async fn activate_request(
    socket: &mut GatewaySocket,
    pending: &mut Pending,
    request_id: &str,
) -> Result<(), DispatcherError> {
    let Some(pending_request) = pending.get_mut(request_id) else {
        return Ok(());
    };
    if pending_request.reply.is_closed() {
        pending.remove(request_id);
        return Ok(());
    }
    let Some(request) = pending_request.request.take() else {
        return Ok(());
    };
    let encoded = request.encode()?;
    pending_request.sent.store(true, Ordering::Release);
    socket
        .send(Message::Text(encoded.into()))
        .await
        .map_err(|_| DispatcherError::Transport)
}

fn active_count(pending: &Pending) -> usize {
    pending
        .values()
        .filter(|request| request.request.is_none())
        .count()
}

async fn route_text(
    text: &str,
    pending: &mut Pending,
    events: &mpsc::Sender<wire::GatewayEvent>,
) -> Result<bool, DispatcherError> {
    let frame: serde_json::Value =
        serde_json::from_str(text).map_err(|_| DispatcherError::Protocol)?;
    let kind = frame
        .get("type")
        .and_then(serde_json::Value::as_str)
        .ok_or(DispatcherError::Protocol)?;
    match kind {
        "res" => {
            let request_id = frame
                .get("id")
                .and_then(serde_json::Value::as_str)
                .ok_or(DispatcherError::Protocol)?;
            let Some(pending_request) = pending.remove(request_id) else {
                return Ok(false);
            };
            let response = wire::decode_response(text, request_id)
                .map_err(|_| DispatcherError::Protocol)?
                .ok_or(DispatcherError::Protocol)?;
            let _ = pending_request.reply.send(Ok(response));
            Ok(true)
        }
        "event" => {
            let event = wire::decode_event(text).map_err(|_| DispatcherError::Protocol)?;
            events
                .try_send(event)
                .map(|_| false)
                .map_err(|_| DispatcherError::EventBackpressure)
        }
        _ => Err(DispatcherError::Protocol),
    }
}

fn fail_pending(pending: &mut Pending, error: DispatcherError) {
    for (_, request) in pending.drain() {
        let _ = request.reply.send(Err(ExchangeFailure {
            error,
            sent: request.sent.load(Ordering::Acquire),
        }));
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn route_text_demultiplexes_response_and_event() {
        let (events, mut received) = mpsc::channel(2);
        let (reply, result) = oneshot::channel();
        let sent = Arc::new(AtomicBool::new(true));
        let mut pending = Pending::new();
        pending.insert(
            "request-1".into(),
            PendingRequest {
                request: None,
                reply,
                sent,
            },
        );

        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            route_text(
                &json!({"type":"event","event":"tick"}).to_string(),
                &mut pending,
                &events,
            )
            .await
            .unwrap();
            route_text(
                &json!({"type":"res","id":"request-1","ok":true}).to_string(),
                &mut pending,
                &events,
            )
            .await
            .unwrap();
            assert_eq!(received.recv().await.unwrap().name, "tick");
            assert!(result.await.unwrap().is_ok());
        });
    }
}
