use std::collections::HashSet;

use serde_json::{Value, json};

use crate::rpc;

pub(super) fn restore(messages: &[Value]) -> rpc::Result<Value> {
    // filterUnresolvedToolUses removes the entire assistant message only when
    // all of its tool uses lack a result; it does not remove individual blocks.
    let results: HashSet<_> = messages
        .iter()
        .filter(|message| matches!(message["type"].as_str(), Some("user" | "assistant")))
        .filter_map(|message| message["message"]["content"].as_array())
        .flatten()
        .filter(|block| block["type"] == "tool_result")
        .map(|block| block["tool_use_id"].as_str())
        .collect();
    for message in messages
        .iter()
        .rev()
        .filter(|message| message["type"] == "assistant")
    {
        let Some(content) = message["message"]["content"].as_array() else {
            continue;
        };
        let mut uses = content
            .iter()
            .filter(|block| block["type"] == "tool_use")
            .peekable();
        if uses.peek().is_some() && uses.all(|block| !results.contains(&block["id"].as_str())) {
            continue;
        }
        let Some(tool) = content
            .iter()
            .rev()
            .find(|block| block["type"] == "tool_use" && block["name"] == "TodoWrite")
        else {
            continue;
        };
        // Native resume stops at the latest TodoWrite, even when its input is invalid.
        let todos = parse(&tool["input"]["todos"]).unwrap_or_default();
        let todos = if todos.iter().all(|todo| todo["status"] == "completed") {
            Vec::new()
        } else {
            todos
        };
        let mut result = json!({"todos": todos});
        let timestamp = message["timestamp"]
            .as_str()
            .ok_or_else(super::native_invalid)?;
        let millis = chrono::DateTime::parse_from_rfc3339(timestamp)
            .map_err(|error| super::native_invalid().with_source(error))?
            .timestamp_millis();
        if !(0..=9_007_199_254_740_991).contains(&millis) {
            return Err(super::native_invalid());
        }
        result["updatedAt"] = json!(millis);
        return Ok(result);
    }
    Ok(json!({"todos": []}))
}

fn parse(value: &Value) -> Option<Vec<Value>> {
    value
        .as_array()?
        .iter()
        .map(|item| {
            let content = item["content"].as_str().filter(|value| !value.is_empty())?;
            let active_form = item["activeForm"]
                .as_str()
                .filter(|value| !value.is_empty())?;
            let status = item["status"]
                .as_str()
                .filter(|value| matches!(*value, "pending" | "in_progress" | "completed"))?;
            Some(json!({"content": content, "activeForm": active_form, "status": status}))
        })
        .collect()
}
