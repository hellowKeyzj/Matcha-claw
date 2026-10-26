use crate::{send::InvalidCommand, state::{RunPhase, SessionIdentity}};

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

