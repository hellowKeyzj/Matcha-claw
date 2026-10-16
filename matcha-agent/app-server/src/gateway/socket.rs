use super::{Gateway, PROTOCOL_VERSION, dispatch, subscriptions};
use crate::rpc;
use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt, stream::FuturesUnordered};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tokio::{
    sync::{mpsc, oneshot},
    task::JoinSet,
};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

pub(super) struct Outbound {
    message: Message,
    after_send: Vec<oneshot::Sender<()>>,
}

pub(super) struct Connection {
    pub(super) gateway: Gateway,
    pub(super) closed: CancellationToken,
    pub(super) streams: TaskTracker,
    pub(super) subscriptions: subscriptions::Subscriptions,
    initialized: AtomicBool,
    output: mpsc::Sender<Outbound>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Initialize {
    protocol_version: String,
    token: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Shutdown {}

struct Reply {
    response: Option<Value>,
    after_send: Vec<oneshot::Sender<()>>,
}

impl Reply {
    fn error(id: Value, error: rpc::Error) -> Self {
        Self {
            response: Some(response(id, Err(error))),
            after_send: Vec::new(),
        }
    }
}

pub(super) async fn serve(socket: WebSocket, gateway: Gateway) {
    let (mut writer, mut reader) = socket.split();
    // A slow socket retains one queued frame, not an unbounded copy of durable events.
    let (output, mut queued) = mpsc::channel::<Outbound>(1);
    let connection = Arc::new(Connection {
        closed: gateway.shutdown.child_token(),
        gateway,
        streams: TaskTracker::new(),
        subscriptions: subscriptions::Subscriptions::default(),
        initialized: AtomicBool::new(false),
        output,
    });
    let writing = connection.clone();
    let writer_task = tokio::spawn(async move {
        loop {
            let outbound = tokio::select! {
                biased;
                _ = writing.closed.cancelled() => break,
                outbound = queued.recv() => match outbound {
                    Some(outbound) => outbound,
                    None => break,
                },
            };
            let sent = tokio::select! {
                biased;
                _ = writing.closed.cancelled() => break,
                sent = writer.send(outbound.message) => sent,
            };
            if sent.is_err() {
                writing.closed.cancel();
                writing.record("write", "socket_write_failed").await;
                break;
            }
            for ready in outbound.after_send {
                let _ = ready.send(());
            }
        }
        // Dropping the socket is immediate; never wait for a stalled peer's close ACK.
        writing.closed.cancel();
    });
    let mut frames = JoinSet::new();
    loop {
        tokio::select! {
            biased;
            _ = connection.closed.cancelled() => break,
            result = frames.join_next(), if !frames.is_empty() => {
                if result.is_some_and(|result| result.is_err()) {
                    connection.record("request", "request_task_failed").await;
                    break;
                }
            },
            message = reader.next() => {
                match message {
                    Some(Ok(Message::Text(text))) => {
                        let connection = connection.clone();
                        frames.spawn(async move { connection.handle_text(text.as_str()).await; });
                    }
                    Some(Ok(Message::Ping(bytes))) => {
                        let connection = connection.clone();
                        frames.spawn(async move {
                            let _ = connection.send(Message::Pong(bytes), Vec::new()).await;
                        });
                    }
                    Some(Ok(Message::Pong(_))) => {},
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(Message::Binary(_))) => {
                        let connection = connection.clone();
                        frames.spawn(async move {
                            connection.send_reply(Reply::error(Value::Null, rpc::Error::new(
                                -32600, "invalid_request", "JSON-RPC requires a text WebSocket message",
                            ))).await;
                        });
                    }
                    Some(Err(_)) => {
                        connection.record("read", "socket_read_failed").await;
                        break;
                    }
                }
            },
        }
    }
    connection.closed.cancel();
    // Accepted business calls may already have side effects. Join rather than abort;
    // server shutdown concurrently asks the Session owner to release native pending.
    while let Some(result) = frames.join_next().await {
        if result.is_err() {
            connection.record("request", "request_task_failed").await;
        }
    }
    connection.streams.close();
    connection.streams.wait().await;
    if writer_task.await.is_err() {
        connection.record("write", "writer_task_failed").await;
    }
}

impl Connection {
    async fn handle_text(self: Arc<Self>, text: &str) {
        let parsed = match serde_json::from_str::<Value>(text) {
            Ok(value) => value,
            Err(_) => {
                self.send_reply(Reply::error(
                    Value::Null,
                    rpc::Error::new(-32700, "parse_error", "Parse error"),
                ))
                .await;
                return;
            }
        };
        let reply = match parsed {
            Value::Array(batch) if batch.is_empty() => Reply::error(Value::Null, invalid_request()),
            Value::Array(batch) => {
                let mut pending: FuturesUnordered<_> = batch
                    .into_iter()
                    .map(|message| {
                        let connection = self.clone();
                        async move { connection.call(message).await }
                    })
                    .collect();
                let mut responses = Vec::new();
                let mut after_send = Vec::new();
                while let Some(reply) = pending.next().await {
                    if let Some(response) = reply.response {
                        responses.push(response);
                    }
                    after_send.extend(reply.after_send);
                }
                Reply {
                    response: (!responses.is_empty()).then_some(Value::Array(responses)),
                    after_send,
                }
            }
            message => self.call(message).await,
        };
        self.send_reply(reply).await;
    }

    async fn call(self: &Arc<Self>, message: Value) -> Reply {
        let Value::Object(mut object) = message else {
            return Reply::error(Value::Null, invalid_request());
        };
        let id = object.remove("id");
        if id
            .as_ref()
            .is_some_and(|id| !matches!(id, Value::Null | Value::String(_) | Value::Number(_)))
        {
            return Reply::error(Value::Null, invalid_request());
        }
        if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
            return Reply::error(id.unwrap_or(Value::Null), invalid_request());
        }
        let Some(Value::String(method)) = object.remove("method") else {
            return Reply::error(id.unwrap_or(Value::Null), invalid_request());
        };
        let params = object.remove("params").unwrap_or_else(|| json!({}));
        let mut after_send = Vec::new();
        let result = if !params.is_object() && !params.is_array() {
            Err(rpc::Error::invalid("params must be an object or array"))
        } else if method == "initialize" {
            self.initialize(params)
        } else if !self.initialized.load(Ordering::Acquire) {
            Err(rpc::Error::new(
                -32007,
                "not_initialized",
                "Initialize and authenticate this connection first",
            ))
        } else {
            match method.as_str() {
                "server.shutdown" => self.shutdown(params, &mut after_send),
                "events.replay" => subscriptions::replay(self, params).await,
                "events.subscribe" => subscriptions::subscribe(self, params, &mut after_send).await,
                "schedules.subscribe" => {
                    subscriptions::subscribe_schedules(self, params, &mut after_send).await
                }
                _ => dispatch::dispatch(&self.gateway, &method, params).await,
            }
        };
        if id.is_none() {
            // No notification response, including unknown methods and auth failures.
            if let Err(error) = &result {
                let kind = error
                    .data
                    .as_ref()
                    .and_then(|data| data["kind"].as_str())
                    .unwrap_or("notification_failed");
                self.record("notification", kind).await;
            }
        }
        Reply {
            response: id.map(|id| response(id, result)),
            after_send,
        }
    }

    fn initialize(&self, params: Value) -> rpc::Result {
        let params: Initialize = rpc::params(params)?;
        self.gateway.authenticate(params.token.as_deref())?;
        if params.protocol_version != PROTOCOL_VERSION {
            return Err(rpc::Error::unavailable(
                "unsupported_protocol",
                "The requested protocol version is not supported",
            )
            .with_data(json!({ "supportedProtocolVersions": [PROTOCOL_VERSION] })));
        }
        self.initialized
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| {
                rpc::Error::conflict(
                    "already_initialized",
                    "This connection is already initialized",
                )
            })?;
        Ok(dispatch::capabilities())
    }

    fn shutdown(&self, params: Value, after_send: &mut Vec<oneshot::Sender<()>>) -> rpc::Result {
        let _: Shutdown = rpc::params(params)?;
        let (flushed, received) = oneshot::channel();
        after_send.push(flushed);
        let shutdown = self.gateway.shutdown.clone();
        let closed = self.closed.clone();
        self.gateway.connections.spawn(async move {
            // A received request remains owned if the caller disconnects before its ACK.
            tokio::select! {
                _ = received => {},
                _ = closed.cancelled() => {},
            }
            shutdown.cancel();
        });
        Ok(json!({ "status": "stopping" }))
    }

    async fn send_reply(&self, reply: Reply) {
        match reply.response {
            Some(response) => {
                let _ = self
                    .send(Message::Text(response.to_string().into()), reply.after_send)
                    .await;
            }
            None => {
                for ready in reply.after_send {
                    let _ = ready.send(());
                }
            }
        }
    }

    pub(super) async fn notify(&self, method: &str, params: Value) -> Result<(), ()> {
        self.send(
            Message::Text(
                json!({ "jsonrpc": "2.0", "method": method, "params": params })
                    .to_string()
                    .into(),
            ),
            Vec::new(),
        )
        .await
    }

    pub(super) async fn notify_flushed(&self, method: &str, params: Value) -> Result<(), ()> {
        let (flushed, received) = oneshot::channel();
        self.send(
            Message::Text(
                json!({ "jsonrpc": "2.0", "method": method, "params": params })
                    .to_string()
                    .into(),
            ),
            vec![flushed],
        )
        .await?;
        tokio::select! {
            biased;
            _ = self.closed.cancelled() => Err(()),
            result = received => result.map_err(|_| ()),
        }
    }

    async fn send(&self, message: Message, after_send: Vec<oneshot::Sender<()>>) -> Result<(), ()> {
        tokio::select! {
            biased;
            _ = self.closed.cancelled() => Err(()),
            result = self.output.send(Outbound { message, after_send }) => result.map_err(|_| ()),
        }
    }

    pub(super) async fn record(&self, operation: &str, kind: &str) {
        if self
            .gateway
            .diagnostics
            .record("gateway", operation, kind, json!({}))
            .await
            .is_err()
        {
            eprintln!("matcha-app-server: gateway diagnostic write failed");
        }
    }
}

fn response(id: Value, result: rpc::Result) -> Value {
    match result {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err(error) => json!({ "jsonrpc": "2.0", "id": id, "error": error }),
    }
}

fn invalid_request() -> rpc::Error {
    rpc::Error::new(-32600, "invalid_request", "Invalid Request")
}
