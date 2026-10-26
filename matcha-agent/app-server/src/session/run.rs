use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use uuid::Uuid;

use crate::rpc;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum Status {
    Queued,
    Starting,
    Running,
    CancelRequested,
    Succeeded,
    Failed,
    Cancelled,
    OutcomeUnknown,
}

impl Status {
    pub fn terminal(self) -> bool {
        matches!(
            self,
            Self::Succeeded | Self::Failed | Self::Cancelled | Self::OutcomeUnknown
        )
    }
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Budget {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_turns: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_wall_time_ms: Option<u64>,
    #[serde(flatten)]
    pub constraints: BTreeMap<String, Value>,
}

impl Budget {
    pub fn validate(&self) -> rpc::Result<()> {
        for (field, value) in [
            ("maxTurns", self.max_turns),
            ("maxWallTimeMs", self.max_wall_time_ms),
        ] {
            if value.is_some_and(|value| value == 0 || value > 9_007_199_254_740_991) {
                return Err(rpc::Error::invalid(format!(
                    "{field} must be a positive safe integer"
                )));
            }
        }
        if self.max_wall_time_ms.is_some_and(|value| {
            tokio::time::Instant::now()
                .checked_add(std::time::Duration::from_millis(value))
                .is_none()
        }) {
            return Err(rpc::Error::invalid(
                "maxWallTimeMs exceeds the native timer range",
            ));
        }
        if !self.constraints.is_empty() {
            return Err(rpc::Error::new(-32007, "unsupported_budget", "Native budget constraints are not supported")
                .with_data(json!({"delivery":"notSent", "unsupported":self.constraints.keys().collect::<Vec<_>>() })));
        }
        Ok(())
    }
}

pub(super) fn validate_request_id(value: &str) -> rpc::Result<()> {
    if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
        return Err(rpc::Error::invalid(
            "requestId must contain 1 to 256 bytes without control characters",
        ));
    }
    Ok(())
}

pub(super) fn content_budget_digest(
    content: &Value,
    budget: &Option<Budget>,
) -> rpc::Result<String> {
    fn canonical(value: Value) -> Value {
        match value {
            Value::Object(object) => Value::Object(
                object
                    .into_iter()
                    .map(|(key, value)| (key, canonical(value)))
                    .collect::<BTreeMap<_, _>>()
                    .into_iter()
                    .collect(),
            ),
            Value::Array(values) => Value::Array(values.into_iter().map(canonical).collect()),
            value => value,
        }
    }
    let bytes = serde_json::to_vec(&canonical(json!({"content":content,"budget":budget})))
        .map_err(|error| rpc::Error::internal("run_digest_encode").with_source(error))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Run {
    pub run_id: String,
    pub session_id: String,
    pub message_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_budget_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget: Option<Budget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub world_investigation: Option<super::investigation::Investigation>,
    pub status: Status,
    pub created_at_ms: u64,
    pub started_at_ms: Option<u64>,
    pub finished_at_ms: Option<u64>,
    pub cancel_requested_at_ms: Option<u64>,
    pub result: Option<Value>,
    pub reason: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Record {
    pub run: Run,
    pub content: Option<Value>,
}

pub(super) struct Active {
    pub record: Record,
    pub acknowledged: bool,
    pub input_started: bool,
    pub native_cycle_observed: bool,
    pub idle_observed: bool,
    pub interrupt_observed: bool,
    pub ownership_ambiguous: bool,
    pub result_count: usize,
    pub result: Option<Value>,
    pub deadline: Option<tokio::time::Instant>,
    pub budget_expired: bool,
    pub auxiliary_pending: usize,
}

impl Record {
    pub fn new(
        session_id: &str,
        content: Value,
        request_id: Option<String>,
        digest: Option<String>,
        budget: Option<Budget>,
        world_investigation: Option<super::investigation::Investigation>,
    ) -> Self {
        Self {
            run: Run {
                run_id: Uuid::new_v4().to_string(),
                session_id: session_id.to_owned(),
                message_id: Uuid::new_v4().to_string(),
                request_id,
                content_budget_digest: digest,
                budget,
                world_investigation,
                status: Status::Queued,
                created_at_ms: rpc::now_ms(),
                started_at_ms: None,
                finished_at_ms: None,
                cancel_requested_at_ms: None,
                result: None,
                reason: None,
            },
            content: Some(content),
        }
    }

    pub fn finish(&mut self, status: Status, reason: &str, result: Option<Value>) {
        self.run.status = status;
        self.run.finished_at_ms = Some(rpc::now_ms());
        self.run.reason = Some(reason.to_owned());
        let correlation = self.run.world_investigation.as_ref().and_then(|world| world.correlation(&self.run));
        if let Some(world) = self.run.world_investigation.as_mut() {
            world.finish(correlation, result.as_ref());
        }
        self.run.result = result;
        self.content = None;
    }
}

impl Active {
    pub fn owned_result(&self) -> Option<Value> {
        if self.acknowledged
            && self.idle_observed
            && !self.ownership_ambiguous
            && self.result_count == 1
        {
            self.result.clone()
        } else {
            None
        }
    }

    pub fn outcome(&self) -> (Status, &'static str) {
        if self.ownership_ambiguous || self.result_count > 1 {
            return (Status::OutcomeUnknown, "native_result_ownership_ambiguous");
        }
        if !self.acknowledged {
            return (Status::OutcomeUnknown, "native_input_not_acknowledged");
        }
        let Some(result) = self.result.as_ref() else {
            return (Status::OutcomeUnknown, "native_idle_without_result");
        };
        if self.record.run.cancel_requested_at_ms.is_some() && self.interrupt_observed {
            return (Status::Cancelled, "native_interruption_observed");
        }
        match (
            result.get("subtype").and_then(Value::as_str),
            result.get("is_error").and_then(Value::as_bool),
        ) {
            (Some("success"), Some(false)) => (Status::Succeeded, "native_result"),
            (
                Some(
                    "success"
                    | "error_during_execution"
                    | "error_max_turns"
                    | "error_max_budget_usd"
                    | "error_max_structured_output_retries",
                ),
                Some(_),
            ) => (Status::Failed, "native_result"),
            _ => (Status::OutcomeUnknown, "native_result_unrecognized"),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Page {
    pub runs: Vec<Run>,
    pub next_before_run_id: Option<String>,
    pub current_run: Option<Run>,
    pub latest_seq: u64,
}

pub(super) fn validate_content(content: &Value) -> rpc::Result<()> {
    match content {
        Value::String(text) if !text.trim().is_empty() => Ok(()),
        Value::Array(blocks)
            if !blocks.is_empty()
                && blocks.iter().all(|block| {
                    block.is_object() && block.get("type").and_then(Value::as_str).is_some()
                }) =>
        {
            Ok(())
        }
        _ => Err(rpc::Error::invalid(
            "content must be a nonempty string or native content block array",
        )),
    }
}
