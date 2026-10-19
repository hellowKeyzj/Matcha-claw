use serde::{Deserialize, Serialize};
use serde_json::Value;
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

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Run {
    pub run_id: String,
    pub session_id: String,
    pub message_id: String,
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
    pub interrupt_observed: bool,
    pub ownership_ambiguous: bool,
    pub result_count: usize,
    pub result: Option<Value>,
}

impl Record {
    pub fn new(session_id: &str, content: Value) -> Self {
        Self {
            run: Run {
                run_id: Uuid::new_v4().to_string(),
                session_id: session_id.to_owned(),
                message_id: Uuid::new_v4().to_string(),
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
        self.run.result = result;
        self.content = None;
    }
}

impl Active {
    pub fn owned_result(&self) -> Option<Value> {
        if self.acknowledged && !self.ownership_ambiguous && self.result_count == 1 {
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
