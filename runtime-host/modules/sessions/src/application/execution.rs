use serde::Serialize;

use crate::{send::InvalidCommand, state::{ItemStatus, RunPhase, RuntimeIssue, SessionIdentity}};

pub use organization::{
    TaskExecutionContext as SessionExecutionContext,
    TaskMeasurementCoverage as SessionMeasurementCoverage,
    TaskMeasurementScope as SessionMeasurementScope,
    TaskMetric as SessionMetric,
    TaskNativeMeasurement as SessionNativeMeasurement,
    TaskRunMeasurement as SessionRunMeasurement,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SessionRunSelector {
    RequestId(String),
    RunId(String),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionRunReadCommand {
    pub identity: SessionIdentity,
    pub endpoint_session_id: Option<String>,
    pub selector: SessionRunSelector,
}

impl SessionRunReadCommand {
    pub fn try_new(
        identity: SessionIdentity,
        endpoint_session_id: Option<String>,
        selector: SessionRunSelector,
    ) -> Result<Self, InvalidCommand> {
        let command = Self { identity, endpoint_session_id, selector };
        if !command.valid() { return Err(InvalidCommand); }
        Ok(command)
    }

    pub(crate) fn valid(&self) -> bool {
        let bounded = |value: &str, limit| !value.is_empty() && value.len() <= limit
            && value.trim() == value && !value.chars().any(char::is_control);
        self.identity.validate().is_ok()
            && self.endpoint_session_id.as_deref().is_none_or(|value| bounded(value, 4096))
            && match &self.selector {
                SessionRunSelector::RequestId(value) => bounded(value, 256),
                SessionRunSelector::RunId(value) => bounded(value, 4096),
            }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SessionRunReadOutcome {
    Found(SessionRunRecord),
    NotFound,
    Rejected,
    Unsupported,
    Unavailable,
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionRunRecord {
    pub run_id: String,
    pub message_id: String,
    pub request_id: Option<String>,
    pub phase: RunPhase,
    pub measurement: SessionRunMeasurement,
    /// Exact native final response candidates; no transcript or business-outcome inference.
    pub assistant_texts: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionExecutionResult {
    pub identity: SessionIdentity,
    pub run_id: String,
    pub runtime: Option<SessionExecutionRuntime>,
    pub messages_status: SessionExecutionMessagesStatus,
    pub messages: Vec<SessionExecutionMessage>,
    pub complete: bool,
}

impl SessionExecutionResult {
    pub(crate) fn valid_for(&self, command: &SessionRunReadCommand) -> bool {
        use crate::state::{MAX_ID_BYTES, MAX_ITEMS, MAX_TEXT_BYTES};

        let bounded_id = |value: &str| !value.is_empty() && value.len() <= MAX_ID_BYTES
            && value.trim() == value && !value.chars().any(char::is_control);
        command.valid()
            && self.identity == command.identity
            && self.identity.endpoint.kind == "native-runtime"
            && self.identity.endpoint.runtime_instance_id == "local"
            && matches!(&command.selector, SessionRunSelector::RunId(run_id) if run_id == &self.run_id)
            && self.messages.len() <= MAX_ITEMS
            && self.messages.iter().all(|message| {
                message.item_id.as_deref().is_none_or(bounded_id)
                    && message.text.len() <= MAX_TEXT_BYTES && !message.text.contains('\0')
            })
            && self.runtime.as_ref().is_none_or(|runtime| runtime.active_run_id.as_deref().is_none_or(bounded_id))
            && self.complete == (self.messages_status == SessionExecutionMessagesStatus::Complete)
            && (!self.complete || (!self.messages.is_empty() && self.messages.iter().all(|message| {
                message.status == ItemStatus::Final && !message.text.trim().is_empty()
            })))
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionExecutionRuntime {
    pub phase: RunPhase,
    pub active_run_id: Option<String>,
    pub issue: Option<RuntimeIssue>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionExecutionMessage {
    pub item_id: Option<String>,
    pub text: String,
    pub status: ItemStatus,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionExecutionMessagesStatus {
    Complete,
    Incomplete,
    Unknown,
    Unavailable,
}

pub fn native_execution_result(
    identity: SessionIdentity,
    run_id: String,
    record: SessionRunRecord,
) -> Option<SessionExecutionResult> {
    use crate::state::{MAX_ITEMS, MAX_TEXT_BYTES};

    if identity.endpoint.kind != "native-runtime"
        || identity.endpoint.runtime_instance_id != "local"
        || record.run_id != run_id
        || record.assistant_texts.len() > MAX_ITEMS
        || record.assistant_texts.iter().any(|text| text.len() > MAX_TEXT_BYTES || text.contains('\0'))
    {
        return None;
    }
    SessionRunReadCommand::try_new(identity.clone(), None, SessionRunSelector::RunId(run_id.clone())).ok()?;
    let messages: Vec<_> = record.assistant_texts.into_iter()
        .filter(|text| !text.trim().is_empty())
        .map(|text| SessionExecutionMessage { item_id: None, text, status: ItemStatus::Final })
        .collect();
    let complete = record.phase == RunPhase::Completed && !messages.is_empty();
    Some(SessionExecutionResult {
        identity,
        run_id,
        runtime: None,
        messages_status: if complete { SessionExecutionMessagesStatus::Complete } else { SessionExecutionMessagesStatus::Incomplete },
        messages,
        complete,
    })
}

