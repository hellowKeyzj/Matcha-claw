use std::{future::Future, io, pin::Pin};

use platform::loopback::StreamHandler;
use tokio::{
    io::AsyncWriteExt,
    net::TcpStream,
    sync::broadcast,
    time::{Instant, MissedTickBehavior, interval_at},
};

use super::state::SessionDelta;

#[derive(Clone)]
pub struct SessionDeltaSource {
    sender: broadcast::Sender<SessionDelta>,
}

impl SessionDeltaSource {
    pub fn new(capacity: usize) -> Self {
        let (sender, _) = broadcast::channel(capacity);
        Self { sender }
    }

    pub fn publish(&self, delta: SessionDelta) -> bool {
        let _ = self.sender.send(delta);
        true
    }

    pub fn subscribe(&self) -> broadcast::Receiver<SessionDelta> {
        self.sender.subscribe()
    }
}

pub struct SessionDeltaStream {
    receiver: broadcast::Receiver<SessionDelta>,
    keepalive_interval: std::time::Duration,
}

impl SessionDeltaStream {
    pub fn new(
        receiver: broadcast::Receiver<SessionDelta>,
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
                tokio::select! {
                    delta = self.receiver.recv() => match delta {
                        Ok(delta) => stream.write_all(&session_delta_frame(&delta)).await?,
                        Err(broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(broadcast::error::RecvError::Closed) => return Ok(()),
                    },
                    _ = keepalive.tick() => stream.write_all(b":keepalive\n\n").await?,
                }
                stream.flush().await?;
            }
        })
    }
}

fn session_delta_frame(delta: &SessionDelta) -> Vec<u8> {
    let data = serde_json::to_string(delta).expect("session delta SSE data is serializable");
    format!(
        "event: session.delta\nid: {}\ndata: {data}\n\n",
        delta.seq()
    )
    .into_bytes()
}
