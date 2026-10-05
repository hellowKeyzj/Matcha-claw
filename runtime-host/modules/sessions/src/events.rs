use std::{future::Future, io, pin::Pin};

use platform::loopback::StreamHandler;
use tokio::{
    io::AsyncWriteExt,
    net::TcpStream,
    sync::broadcast,
    time::{Instant, MissedTickBehavior, interval_at},
};

use super::state::{SessionDelta, SessionIdentity};

#[derive(Clone)]
pub enum SessionEvent {
    Delta(SessionDelta),
    Resync { identity: SessionIdentity, epoch: u64, seq: u64 },
}

#[derive(Clone)]
pub struct SessionDeltaSource {
    sender: broadcast::Sender<SessionEvent>,
}

impl SessionDeltaSource {
    pub fn new(capacity: usize) -> Self {
        let (sender, _) = broadcast::channel(capacity);
        Self { sender }
    }

    pub fn publish(&self, delta: SessionDelta) -> bool {
        if crate::trace::enabled() {
            crate::trace::log_unscoped("sessions.delta.publish", serde_json::json!({
                "identity": crate::trace::identity_shape(&delta.identity), "epoch": delta.epoch,
                "seq": delta.seq, "cursor": delta.cursor, "runHash": delta.run_id.as_deref().map(crate::trace::fingerprint),
                "changes": crate::trace::changes_shape(&delta.changes), "receivers": self.sender.receiver_count(),
            }));
        }
        let sent = self.sender.send(SessionEvent::Delta(delta));
        if crate::trace::enabled() {
            crate::trace::log_unscoped("sessions.delta.publish_outcome", serde_json::json!({ "hasReceiver": sent.is_ok() }));
        }
        true
    }

    pub fn resync(&self, identity: SessionIdentity, epoch: u64, seq: u64) {
        if crate::trace::enabled() {
            crate::trace::log_unscoped("sessions.resync.publish", serde_json::json!({
                "identity": crate::trace::identity_shape(&identity), "epoch": epoch, "seq": seq,
                "receivers": self.sender.receiver_count(),
            }));
        }
        let sent = self.sender.send(SessionEvent::Resync { identity, epoch, seq });
        if crate::trace::enabled() {
            crate::trace::log_unscoped("sessions.resync.publish_outcome", serde_json::json!({ "hasReceiver": sent.is_ok() }));
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<SessionEvent> {
        self.sender.subscribe()
    }
}

pub struct SessionDeltaStream {
    receiver: broadcast::Receiver<SessionEvent>,
    keepalive_interval: std::time::Duration,
}

impl SessionDeltaStream {
    pub fn new(
        receiver: broadcast::Receiver<SessionEvent>,
        keepalive_interval: std::time::Duration,
    ) -> Self {
        Self {
            receiver,
            keepalive_interval,
        }
    }
}

impl StreamHandler for SessionDeltaStream {
    fn write(
        mut self: Box<Self>,
        mut stream: TcpStream,
    ) -> Pin<Box<dyn Future<Output = io::Result<()>> + Send>> {
        Box::pin(async move {
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\n\r\n",
                )
                .await?;
            stream.flush().await?;
            let mut keepalive = interval_at(
                Instant::now() + self.keepalive_interval,
                self.keepalive_interval,
            );
            keepalive.set_missed_tick_behavior(MissedTickBehavior::Delay);
            loop {
                let mut frame_context = None;
                tokio::select! {
                    delta = self.receiver.recv() => match delta {
                        Ok(SessionEvent::Delta(delta)) => {
                            let written = stream.write_all(&session_delta_frame(&delta)).await;
                            if crate::trace::enabled() {
                                frame_context = Some(serde_json::json!({
                                    "kind": "delta", "identity": crate::trace::identity_shape(&delta.identity),
                                    "epoch": delta.epoch, "seq": delta.seq, "cursor": delta.cursor,
                                }));
                                crate::trace::log_unscoped("sessions.sse.write", serde_json::json!({
                                    "frame": frame_context, "outcome": if written.is_ok() { "succeeded" } else { "failed" },
                                }));
                            }
                            written?;
                        },
                        Ok(SessionEvent::Resync { identity, epoch, seq }) => {
                            if crate::trace::enabled() {
                                crate::trace::log_unscoped("sessions.sse.resync_frame", serde_json::json!({
                                    "identity": crate::trace::identity_shape(&identity), "epoch": epoch, "seq": seq,
                                }));
                            }
                            let data = serde_json::json!({ "identity": identity, "epoch": epoch, "seq": seq });
                            let written = stream.write_all(format!("event: session.resync\ndata: {data}\n\n").as_bytes()).await;
                            if crate::trace::enabled() {
                                frame_context = Some(serde_json::json!({
                                    "kind": "resync", "identity": crate::trace::identity_shape(&identity), "epoch": epoch, "seq": seq,
                                }));
                                crate::trace::log_unscoped("sessions.sse.write", serde_json::json!({
                                    "frame": frame_context, "outcome": if written.is_ok() { "succeeded" } else { "failed" },
                                }));
                            }
                            written?;
                        }
                        Err(broadcast::error::RecvError::Lagged(missed)) => {
                            if crate::trace::enabled() {
                                crate::trace::log_unscoped("sessions.sse.closed", serde_json::json!({ "reason": "lagged", "missedCount": missed }));
                            }
                            return Ok(());
                        },
                        Err(broadcast::error::RecvError::Closed) => {
                            if crate::trace::enabled() {
                                crate::trace::log_unscoped("sessions.sse.closed", serde_json::json!({ "reason": "source_closed" }));
                            }
                            return Ok(());
                        },
                    },
                    _ = keepalive.tick() => {
                        let written = stream.write_all(b":keepalive\n\n").await;
                        if crate::trace::enabled() && written.is_err() {
                            crate::trace::log_unscoped("sessions.sse.write", serde_json::json!({ "kind": "keepalive", "outcome": "failed" }));
                        }
                        written?;
                    },
                }
                let flushed = stream.flush().await;
                if crate::trace::enabled() && (frame_context.is_some() || flushed.is_err()) {
                    crate::trace::log_unscoped("sessions.sse.flush", serde_json::json!({
                        "frame": frame_context, "outcome": if flushed.is_ok() { "succeeded" } else { "failed" },
                    }));
                }
                flushed?;
            }
        })
    }
}

fn session_delta_frame(delta: &SessionDelta) -> Vec<u8> {
    if crate::trace::enabled() {
        crate::trace::log_unscoped("sessions.sse.delta_frame", serde_json::json!({
            "identity": crate::trace::identity_shape(&delta.identity), "epoch": delta.epoch,
            "seq": delta.seq, "cursor": delta.cursor, "sseId": delta.seq(),
            "runHash": delta.run_id.as_deref().map(crate::trace::fingerprint),
            "changes": crate::trace::changes_shape(&delta.changes),
        }));
    }
    let data = serde_json::to_string(delta).expect("session delta SSE data is serializable");
    format!(
        "event: session.delta\nid: {}\ndata: {data}\n\n",
        delta.seq()
    )
    .into_bytes()
}
