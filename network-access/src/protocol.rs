use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot};

pub const MAX_FRAME: usize = 2 * 1024 * 1024;
pub const MAX_REQUEST: usize = 64 * 1024;

#[derive(Clone)]
pub struct Output(mpsc::Sender<(Value, oneshot::Sender<()>)>);

impl Output {
    pub async fn send(&self, value: Value) -> Result<(), ()> {
        let (sender, receiver) = oneshot::channel();
        self.0.send((value, sender)).await.map_err(|_| ())?;
        receiver.await.map_err(|_| ())
    }
}

pub fn output() -> Output {
    let (sender, receiver) = mpsc::channel(64);
    tokio::spawn(write_events(receiver));
    Output(sender)
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum Command {
    Start {
        id: u64,
        configuration: String,
    },
    Read {
        id: u64,
    },
    Invoke {
        id: u64,
        #[serde(rename = "nodeId")]
        node_id: String,
        request: Value,
    },
    Reply {
        id: u64,
        response: Value,
    },
    Stop {
        id: u64,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Runtime {
    pub node_id: String,
    pub listeners: Vec<String>,
    pub peer_count: usize,
    pub peers: Vec<Peer>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Peer {
    pub node_id: String,
    pub name: String,
}

pub fn failure(id: u64, error: &'static str) -> Value {
    serde_json::json!({ "kind": "failure", "id": id, "error": error })
}

pub fn bounded_object(value: &Value, limit: usize) -> bool {
    value.is_object() && serde_json::to_vec(value).is_ok_and(|bytes| bytes.len() <= limit)
}

pub async fn read_commands(sender: mpsc::Sender<Result<Command, Option<u64>>>) {
    let mut input = tokio::io::stdin();
    loop {
        let mut header = [0; 4];
        if input.read_exact(&mut header).await.is_err() {
            std::process::exit(0);
        }
        let length = u32::from_be_bytes(header) as usize;
        if length == 0 || length > MAX_FRAME {
            std::process::exit(1);
        }
        let mut bytes = vec![0; length];
        if input.read_exact(&mut bytes).await.is_err() {
            std::process::exit(1);
        }
        let command = serde_json::from_slice::<Command>(&bytes).map_err(|_| {
            serde_json::from_slice::<Value>(&bytes)
                .ok()
                .and_then(|value| value.get("id").and_then(Value::as_u64))
        });
        if matches!(&command, Ok(Command::Stop { .. })) {
            std::process::exit(0);
        }
        if sender.send(command).await.is_err() {
            break;
        }
    }
}

async fn write_events(mut receiver: mpsc::Receiver<(Value, oneshot::Sender<()>)>) {
    let mut output = tokio::io::stdout();
    while let Some((event, flushed)) = receiver.recv().await {
        let Ok(bytes) = serde_json::to_vec(&event) else {
            std::process::exit(1);
        };
        if bytes.len() > MAX_FRAME
            || output
                .write_all(&(bytes.len() as u32).to_be_bytes())
                .await
                .is_err()
            || output.write_all(&bytes).await.is_err()
            || output.flush().await.is_err()
        {
            std::process::exit(1);
        }
        let _ = flushed.send(());
    }
}
