use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::{Value, json};

#[derive(Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum Proactive {
    #[default]
    Unobserved,
    Enabled,
    Disabled,
    OutcomeUnknown,
}

#[derive(Default)]
pub(super) struct Snapshot {
    pub initialize: Option<Value>,
    pub tasks: BTreeMap<String, Value>,
    pub busy: bool,
    pub tools: Option<Vec<String>>,
    pub proactive: Proactive,
}

impl Snapshot {
    pub fn view(&self, session_id: &str, agent_id: &str, instance_id: Option<&str>) -> Value {
        json!({
            "sessionId": session_id, "agentId": agent_id, "instanceId": instance_id,
            "initialize": self.initialize, "tasks": self.tasks.values().collect::<Vec<_>>(), "tools": self.tools,
            "proactive": self.proactive,
        })
    }

    pub fn observe(&mut self, message: &Value) {
        if message.get("type").and_then(Value::as_str) != Some("system") {
            return;
        }
        match message.get("subtype").and_then(Value::as_str) {
            Some("init") => {
                self.tools = message
                    .get("tools")
                    .and_then(Value::as_array)
                    .and_then(|tools| {
                        tools
                            .iter()
                            .map(|tool| tool.as_str().map(str::to_owned))
                            .collect()
                    });
            }
            Some("session_state_changed") => match message.get("state").and_then(Value::as_str) {
                Some("idle") => self.busy = false,
                Some("running" | "requires_action") => self.busy = true,
                _ => {}
            },
            Some("task_started" | "task_progress" | "task_notification") => {
                if let Some(id) = message
                    .get("task_id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                {
                    let task = self.tasks.entry(id.to_owned()).or_insert_with(|| json!({}));
                    if let (Some(current), Some(incoming)) =
                        (task.as_object_mut(), message.as_object())
                    {
                        current.extend(
                            incoming
                                .iter()
                                .map(|(key, value)| (key.clone(), value.clone())),
                        );
                    }
                }
            }
            _ => {}
        }
    }
}

pub(super) fn idle(message: &Value) -> bool {
    message.get("type").and_then(Value::as_str) == Some("system")
        && message.get("subtype").and_then(Value::as_str) == Some("session_state_changed")
        && message.get("state").and_then(Value::as_str) == Some("idle")
}

pub(super) fn interrupted(message: &Value) -> bool {
    if message.get("type").and_then(Value::as_str) != Some("user") {
        return false;
    }
    let Some(blocks) = message
        .pointer("/message/content")
        .and_then(Value::as_array)
    else {
        return false;
    };
    blocks.iter().any(|block| {
        matches!(
            block.get("text").and_then(Value::as_str),
            Some("[Request interrupted by user]" | "[Request interrupted by user for tool use]")
        )
    })
}
