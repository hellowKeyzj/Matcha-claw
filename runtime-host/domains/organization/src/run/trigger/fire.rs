use std::fmt;

use super::super::graph::ReduceError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TriggerFireRequest {
    pub run_id: String,
    pub start_node_id: String,
    pub source: TriggerSource,
    pub idempotency_key: String,
}

impl TriggerFireRequest {
    pub fn try_new(
        run_id: impl Into<String>,
        start_node_id: impl Into<String>,
        source: TriggerSource,
        idempotency_key: impl Into<String>,
    ) -> Result<Self, TriggerFireRequestError> {
        let request = Self {
            run_id: run_id.into().trim().to_owned(),
            start_node_id: start_node_id.into().trim().to_owned(),
            source,
            idempotency_key: idempotency_key.into().trim().to_owned(),
        };
        request.validate()?;
        Ok(request)
    }

    pub fn validate(&self) -> Result<(), TriggerFireRequestError> {
        if !is_opaque_identifier(&self.run_id) {
            return Err(TriggerFireRequestError::InvalidRunId);
        }
        if !is_opaque_identifier(&self.start_node_id) {
            return Err(TriggerFireRequestError::InvalidStartNodeId);
        }
        if !is_opaque_identifier(&self.idempotency_key) {
            return Err(TriggerFireRequestError::InvalidIdempotencyKey);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TriggerSource {
    Cron,
    Webhook,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TriggerFireRequestError {
    InvalidRunId,
    InvalidStartNodeId,
    InvalidIdempotencyKey,
}

impl fmt::Display for TriggerFireRequestError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::InvalidRunId => "trigger run id is invalid",
            Self::InvalidStartNodeId => "trigger start node id is invalid",
            Self::InvalidIdempotencyKey => "trigger idempotency key is invalid",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for TriggerFireRequestError {}

pub(super) fn is_opaque_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_' | b':'))
}

#[derive(Clone, PartialEq, Eq)]
pub enum TriggerFireError {
    InvalidRequest(TriggerFireRequestError),
    RunMismatch,
    SourceMismatch,
    Reduce(ReduceError),
}

impl fmt::Debug for TriggerFireError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::InvalidRequest(_) => "TriggerFireError::InvalidRequest",
            Self::RunMismatch => "TriggerFireError::RunMismatch",
            Self::SourceMismatch => "TriggerFireError::SourceMismatch",
            Self::Reduce(_) => "TriggerFireError::GraphStateViolation",
        };
        formatter.write_str(message)
    }
}

impl fmt::Display for TriggerFireError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::InvalidRequest(_) => "trigger fire request is invalid",
            Self::RunMismatch => "trigger fire request does not match an existing TeamRun",
            Self::SourceMismatch => {
                "trigger fire request source does not match the armed TeamRun trigger"
            }
            Self::Reduce(_) => "trigger fire request violates the TeamRun graph state machine",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for TriggerFireError {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::run::graph::{GraphEvent, NodeId, ReduceError};

    #[test]
    fn normalizes_trigger_identifiers_at_the_boundary() {
        let request = TriggerFireRequest::try_new(
            " run-1 ",
            " start-1 ",
            TriggerSource::Webhook,
            " request-1 ",
        )
        .unwrap();

        assert_eq!(request.run_id, "run-1");
        assert_eq!(request.start_node_id, "start-1");
        assert_eq!(request.idempotency_key, "request-1");
    }

    #[test]
    fn rejects_blank_or_non_opaque_trigger_facts() {
        assert_eq!(
            TriggerFireRequest::try_new(" ", "start-1", TriggerSource::Cron, "slot-1"),
            Err(TriggerFireRequestError::InvalidRunId)
        );
        assert_eq!(
            TriggerFireRequest::try_new("run/1", "start-1", TriggerSource::Cron, "slot-1"),
            Err(TriggerFireRequestError::InvalidRunId)
        );
        assert_eq!(
            TriggerFireRequest::try_new("run-1", " ", TriggerSource::Cron, "slot-1"),
            Err(TriggerFireRequestError::InvalidStartNodeId)
        );
        assert_eq!(
            TriggerFireRequest::try_new("run-1", "start node", TriggerSource::Cron, "slot-1"),
            Err(TriggerFireRequestError::InvalidStartNodeId)
        );
        assert_eq!(
            TriggerFireRequest::try_new("run-1", "start-1", TriggerSource::Cron, " "),
            Err(TriggerFireRequestError::InvalidIdempotencyKey)
        );
        assert_eq!(
            TriggerFireRequest::try_new("run-1", "start-1", TriggerSource::Cron, "slot/1"),
            Err(TriggerFireRequestError::InvalidIdempotencyKey)
        );
    }

    #[test]
    fn redacts_trigger_fire_error_details_from_display() {
        let invalid = TriggerFireError::InvalidRequest(TriggerFireRequestError::InvalidRunId);
        let run = TriggerFireError::RunMismatch;
        let reduce = TriggerFireError::Reduce(ReduceError::UnknownNode(NodeId::new("secret-node")));

        assert_eq!(invalid.to_string(), "trigger fire request is invalid");
        assert_eq!(
            run.to_string(),
            "trigger fire request does not match an existing TeamRun"
        );
        assert_eq!(
            reduce.to_string(),
            "trigger fire request violates the TeamRun graph state machine"
        );
        assert_eq!(
            format!("{reduce:?}"),
            "TriggerFireError::GraphStateViolation"
        );
        assert_eq!(
            format!(
                "{:?}",
                TriggerFireError::InvalidRequest(TriggerFireRequestError::InvalidRunId)
            ),
            "TriggerFireError::InvalidRequest"
        );
        assert!(!format!("{reduce:?}").contains("secret-node"));
        assert!(matches!(
            reduce,
            TriggerFireError::Reduce(ReduceError::UnknownNode(_))
        ));
        let _ = GraphEvent::TriggerFired {
            node_id: NodeId::new("start"),
            fired_at: 1,
        };
    }
}
