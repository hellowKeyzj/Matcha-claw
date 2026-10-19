use super::{projection, rpc::Failure};
use serde_json::{Map, Value, json};
use sessions_module::state::MAX_SEGMENTS;

pub(crate) struct Message<'a> {
    pub row: Value,
    pub source: Source<'a>,
}

pub(crate) struct Source<'a> {
    pub raw: &'a Value,
    pub block_index: Option<usize>,
}

impl Source<'_> {
    pub fn block(&self, index: usize) -> Result<&Value, Failure> {
        let row = if self.raw["type"] == "progress" {
            &self.raw["data"]["message"]
        } else {
            self.raw
        };
        let body = body(row).ok_or(Failure::InvalidReadback)?;
        let index = match self.block_index {
            Some(original) if index == 0 => original,
            Some(_) => return Err(Failure::InvalidInput),
            None => index,
        };
        match body {
            Value::Array(blocks) => blocks.get(index).ok_or(Failure::InvalidInput),
            Value::String(_) if index == 0 => Ok(body),
            _ => Err(Failure::InvalidInput),
        }
    }
}

fn body(row: &Value) -> Option<&Value> {
    row.pointer("/message/content")
        .or_else(|| row.get("content"))
}

fn invalid(raw: &Value, reason: &'static str) -> Failure {
    platform::trace::runtime_trace(
        "matcha.session.history.normalization_rejected",
        || json!({"reason":reason,"row":projection::trace_shape(raw)}),
    );
    Failure::InvalidReadback
}

fn trim(text: &str) -> &str {
    text.trim_matches(|ch: char| ch == '\u{feff}' || (ch.is_whitespace() && ch != '\u{85}'))
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64() != Some(0.0),
        Value::String(value) => !value.is_empty(),
        _ => true,
    }
}

fn initial_replay(row: &Value) -> bool {
    if [
        "isMeta",
        "toolUseResult",
        "isCompactSummary",
        "isVisibleInTranscriptOnly",
    ]
    .iter()
    .any(|key| row.get(*key).is_some_and(truthy))
    {
        return false;
    }
    let content = body(row);
    if let Some(Value::Array(blocks)) = content {
        if blocks
            .first()
            .is_some_and(|block| block["type"] == "tool_result")
        {
            return false;
        }
        if let Some(text) = blocks
            .first()
            .filter(|block| block["type"] == "text")
            .and_then(|block| block["text"].as_str())
            && matches!(
                text,
                "[Request interrupted by user]"
                    | "[Request interrupted by user for tool use]"
                    | "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed."
                    | "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed."
                    | "No response requested."
            )
        {
            return false;
        }
    }
    let text = match content {
        Some(Value::String(text)) => text.as_str(),
        Some(Value::Array(blocks)) => blocks
            .last()
            .filter(|block| block["type"] == "text")
            .and_then(|block| block["text"].as_str())
            .unwrap_or_default(),
        _ => "",
    };
    ![
        "<local-command-stdout>",
        "<local-command-stderr>",
        "<bash-stdout>",
        "<bash-stderr>",
        "<task-notification>",
        "<tick>",
        "<teammate-message",
    ]
    .iter()
    .any(|tag| text.contains(tag))
}

// QueryEngine calls normalizeMessage separately for each raw row. UUID derivation
// therefore never inherits normalizeMessages' isNewChain from an earlier row.
pub(crate) fn messages(raw: &Value, managed_input: bool) -> Result<Vec<Message<'_>>, Failure> {
    let kind = raw
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid(raw, "message.type_invalid"))?;
    let (row, parent) = if kind == "progress" {
        if !matches!(
            raw.pointer("/data/type").and_then(Value::as_str),
            Some("agent_progress" | "skill_progress")
        ) {
            return Ok(Vec::new());
        }
        (
            &raw["data"]["message"],
            raw.get("parentToolUseID").cloned().unwrap_or(Value::Null),
        )
    } else {
        (raw, Value::Null)
    };
    let kind = row
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid(raw, "message.type_invalid"))?;
    if !matches!(kind, "assistant" | "user") {
        return Ok(if raw["type"] == "progress" {
            Vec::new()
        } else {
            vec![Message {
                row: row.clone(),
                source: Source {
                    raw,
                    block_index: None,
                },
            }]
        });
    }
    let uuid = row
        .get("uuid")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid(raw, "message.uuid_missing"))?;
    let content = body(row);
    if content
        .and_then(Value::as_array)
        .is_some_and(|blocks| blocks.len() > MAX_SEGMENTS)
    {
        return Err(invalid(raw, "message.segment_limit"));
    }
    if kind == "user" && raw["type"] != "progress" && managed_input && initial_replay(row) {
        return Ok(vec![Message {
            row: row.clone(),
            source: Source {
                raw,
                block_index: None,
            },
        }]);
    }
    let blocks = match content {
        Some(Value::Array(blocks)) => blocks.clone(),
        Some(Value::String(text)) if kind == "user" => vec![json!({"type":"text","text":text})],
        Some(Value::String(_)) | None | Some(Value::Null) => Vec::new(),
        _ => return Err(invalid(raw, "message.content_invalid")),
    };
    let split = blocks.len() > 1;
    let mut messages = Vec::new();
    for (index, block) in blocks.into_iter().enumerate() {
        let uuid = if split {
            format!("{}{index:012x}", uuid.chars().take(24).collect::<String>())
        } else {
            uuid.to_owned()
        };
        // SDK filters assistant empties only after assigning the original index UUID.
        if kind == "assistant" && block["type"] == "text" {
            let text = block
                .get("text")
                .and_then(Value::as_str)
                .ok_or_else(|| invalid(raw, "message.text_invalid"))?;
            if trim(text).is_empty()
                || matches!(
                    text,
                    "(no content)" | "[Request interrupted by user for tool use]"
                )
            {
                continue;
            }
        }
        let mut native: Map<String, Value> = row
            .get("message")
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
            .filter(|(key, _)| key.as_str() != "content")
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        native.insert("content".to_owned(), Value::Array(vec![block]));
        messages.push(Message {
            row: json!({"type":kind,"uuid":uuid,"message":native,"parent_tool_use_id":parent}),
            source: Source {
                raw,
                block_index: Some(index),
            },
        });
    }
    Ok(messages)
}
