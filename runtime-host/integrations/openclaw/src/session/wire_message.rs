use std::collections::HashMap;

use serde_json::{Map, Value, json};

use crate::gateway::wire::GatewayEvent;

use super::{projection::CanonicalRecoveryReason, protocol::MAX_HISTORY_RESPONSE_BYTES};

#[derive(Default)]
pub(super) struct WireMessages {
    runs: HashMap<String, RunMessage>,
    bytes: usize,
}

struct RunMessage {
    session_key: String,
    agent_id: Option<Value>,
    message: Value,
    bytes: usize,
}

impl WireMessages {
    pub(super) fn project(
        &mut self,
        event: &mut GatewayEvent,
    ) -> Result<Option<bool>, CanonicalRecoveryReason> {
        if event.name != "chat" {
            return Ok(Some(false));
        }
        let Some(payload) = event.payload.as_mut().and_then(Value::as_object_mut) else {
            return Ok(Some(false));
        };
        let (Some(run), Some(session)) = (
            payload.get("runId").and_then(Value::as_str),
            payload.get("sessionKey").and_then(Value::as_str),
        ) else {
            return Ok(Some(false));
        };
        let run = run.to_owned();
        match payload.get("state").and_then(Value::as_str) {
            Some("final" | "error" | "aborted") => {
                self.remove(&run);
                return Ok(Some(false));
            }
            Some("delta") => {}
            _ => return Ok(Some(false)),
        }
        let has_message = payload.contains_key("message");
        let delta = payload.get("deltaText").and_then(Value::as_str);
        let replace = payload.get("replace").and_then(Value::as_bool) == Some(true);
        // Leave malformed frames untouched for the strict decoder; never wash them with a baseline.
        if !has_message && delta.is_none() {
            return Ok(Some(false));
        }
        if self.runs.get(&run).is_some_and(|previous| {
            previous.session_key != session || previous.agent_id.as_ref() != payload.get("agentId")
        }) {
            self.remove(&run);
        }
        // Empty appends still need the connection's previous message.
        if !has_message && delta == Some("") && !replace {
            return self
                .runs
                .contains_key(&run)
                .then_some(None)
                .ok_or(CanonicalRecoveryReason::NativeUnknown);
        }
        let previous = self.remove(&run);
        let reconstructed_append = !has_message
            && !replace
            && previous
                .as_ref()
                .is_some_and(|previous| previous.message.is_object());
        let message = merge(previous.map(|previous| previous.message), payload)
            .ok_or(CanonicalRecoveryReason::NativeUnknown)?;
        let mut encoded = EncodedBytes(0);
        serde_json::to_writer(&mut encoded, &message).expect("wire message serializes");
        let bytes = encoded.0;
        if self.runs.len() >= sessions_module::state::MAX_ITEMS
            || bytes > MAX_HISTORY_RESPONSE_BYTES.saturating_sub(self.bytes)
        {
            return Err(CanonicalRecoveryReason::EventOverflow);
        }
        self.runs.insert(
            run,
            RunMessage {
                session_key: session.to_owned(),
                agent_id: payload.get("agentId").cloned(),
                message: message.clone(),
                bytes,
            },
        );
        self.bytes += bytes;
        payload.insert("message".to_owned(), message);
        Ok(Some(reconstructed_append))
    }

    pub(super) fn retire(&mut self, session_key: &str, agent_id: Option<&str>) {
        self.runs.retain(|_, run| {
            let retired = run.session_key == session_key
                && agent_id.is_none_or(|agent| {
                    run.agent_id
                        .as_ref()
                        .is_none_or(|value| value.as_str() == Some(agent))
                });
            if retired {
                self.bytes -= run.bytes;
            }
            !retired
        });
    }

    pub(super) fn clear(&mut self) {
        self.runs.clear();
        self.bytes = 0;
    }

    fn remove(&mut self, run: &str) -> Option<RunMessage> {
        let previous = self.runs.remove(run)?;
        self.bytes -= previous.bytes;
        Some(previous)
    }
}

struct EncodedBytes(usize);

impl std::io::Write for EncodedBytes {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0 += bytes.len();
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

// OpenClaw 2026.10.8 chat-stream-message: snapshots include their delta.
fn merge(previous: Option<Value>, payload: &Map<String, Value>) -> Option<Value> {
    if let Some(message) = payload.get("message") {
        return Some(message.clone());
    }
    let Some(delta) = payload.get("deltaText").and_then(Value::as_str) else {
        return previous;
    };
    let replace = payload.get("replace").and_then(Value::as_bool) == Some(true);
    if delta.is_empty() && !replace {
        return previous;
    }
    let mut message = match previous {
        Some(Value::Object(message)) => message,
        _ if replace => Map::from_iter([("role".to_owned(), Value::from("assistant"))]),
        _ => return None,
    };
    let content = match message.remove("content") {
        Some(Value::String(mut text)) => {
            if replace {
                text.clear();
            }
            text.push_str(delta);
            Value::String(text)
        }
        content => {
            let mut content = match content {
                Some(Value::Array(content)) => content,
                _ => Vec::new(),
            };
            let is_text = |block: &Value| block.get("type").and_then(Value::as_str) == Some("text");
            if replace {
                content.retain(|block| !is_text(block));
                content.insert(0, json!({ "type": "text", "text": delta }));
            } else if let Some(block) = content.iter_mut().rfind(|block| is_text(block)) {
                let block = block.as_object_mut().expect("text block is an object");
                let mut text = block
                    .remove("text")
                    .and_then(|value| value.as_str().map(str::to_owned))
                    .unwrap_or_default();
                text.push_str(delta);
                block.insert("text".to_owned(), Value::String(text));
            } else {
                content.push(json!({ "type": "text", "text": delta }));
            }
            Value::Array(content)
        }
    };
    message.insert("content".to_owned(), content);
    Some(Value::Object(message))
}
