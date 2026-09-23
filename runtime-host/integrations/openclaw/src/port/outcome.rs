use std::fmt;

use platform::exchange::InvocationOutcome;
use serde_json::Value;

use crate::{
    gateway::{
        delivery::{DispatcherError, MutationDelivery},
        wire::GatewayResponse,
    },
    session::{operation::OperationError, protocol::SessionModelPatchResult},
    session_window::HistoryError,
};

pub enum OpenClawGatewayRequestOutcome {
    Succeeded(Value),
    Rejected,
    Unavailable,
    CapacityExhausted,
    OutcomeUnknown,
}

pub(super) fn gateway_request_outcome(delivery: MutationDelivery) -> OpenClawGatewayRequestOutcome {
    match delivery {
        MutationDelivery::Response(GatewayResponse::Success { payload, .. }) => {
            OpenClawGatewayRequestOutcome::Succeeded(payload.unwrap_or(Value::Null))
        }
        MutationDelivery::Response(GatewayResponse::Failure { .. }) => {
            OpenClawGatewayRequestOutcome::Rejected
        }
        MutationDelivery::NotWritten(DispatcherError::Saturated) => {
            OpenClawGatewayRequestOutcome::CapacityExhausted
        }
        MutationDelivery::NotWritten(_) => OpenClawGatewayRequestOutcome::Unavailable,
        MutationDelivery::MayHaveReached(_) => OpenClawGatewayRequestOutcome::OutcomeUnknown,
    }
}

pub(super) fn port_outcome<T>(
    outcome: InvocationOutcome<T, OperationError>,
) -> InvocationOutcome<T, OpenClawSessionError> {
    match outcome {
        InvocationOutcome::Succeeded(result) => InvocationOutcome::Succeeded(result),
        InvocationOutcome::TargetRejected(error) => InvocationOutcome::TargetRejected(error.into()),
        InvocationOutcome::Cancelled => InvocationOutcome::Cancelled,
        InvocationOutcome::Unknown => InvocationOutcome::Unknown,
    }
}

pub(super) fn session_model_patch_outcome(
    outcome: InvocationOutcome<SessionModelPatchResult, OperationError>,
) -> InvocationOutcome<SessionModelPatchResult, SessionModelPatchFailure> {
    match session_mutation_outcome(outcome) {
        InvocationOutcome::Succeeded(result) => InvocationOutcome::Succeeded(result),
        InvocationOutcome::TargetRejected(failure) => InvocationOutcome::TargetRejected(
            SessionModelPatchFailure::TargetRejected(failure.peer_rejection),
        ),
        InvocationOutcome::Cancelled => InvocationOutcome::Cancelled,
        InvocationOutcome::Unknown => InvocationOutcome::Unknown,
    }
}

pub(super) fn session_mutation_outcome<T>(
    outcome: InvocationOutcome<T, OperationError>,
) -> InvocationOutcome<T, OpenClawSessionMutationFailure> {
    match outcome {
        InvocationOutcome::Succeeded(result) => InvocationOutcome::Succeeded(result),
        InvocationOutcome::TargetRejected(error) => {
            InvocationOutcome::TargetRejected(OpenClawSessionMutationFailure {
                peer_rejection: OpenClawPeerRejection::from_operation(&error),
            })
        }
        InvocationOutcome::Cancelled => InvocationOutcome::Cancelled,
        InvocationOutcome::Unknown => InvocationOutcome::Unknown,
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OpenClawSessionMutationFailure {
    peer_rejection: Option<OpenClawPeerRejection>,
}

impl OpenClawSessionMutationFailure {
    pub fn peer_rejection(&self) -> Option<&OpenClawPeerRejection> {
        self.peer_rejection.as_ref()
    }

    #[cfg(test)]
    pub(crate) fn from_peer_rejection_for_test(code: impl Into<String>) -> Self {
        Self {
            peer_rejection: Some(OpenClawPeerRejection {
                code: code.into(),
                message: String::new(),
            }),
        }
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct OpenClawPeerRejection {
    code: String,
    message: String,
}

impl OpenClawPeerRejection {
    fn from_operation(error: &OperationError) -> Option<Self> {
        let (code, message) = error.gateway_rejection()?;
        Some(Self {
            code: code.to_owned(),
            message: message.to_owned(),
        })
    }

    pub fn code(&self) -> &str {
        &self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Debug for OpenClawPeerRejection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OpenClawPeerRejection")
            .field("code", &self.code)
            .field("message", &"[REDACTED]")
            .finish()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SessionModelPatchFailure {
    TargetRejected(Option<OpenClawPeerRejection>),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OpenClawSessionError {
    SessionConnection,
    RequestIdExhausted,
    RequestDeadline,
    ConnectionClosed,
    UnknownResponse,
    Transport,
    Protocol(Option<HistoryError>),
    TargetRejected,
    EventBackpressure,
}

impl From<OperationError> for OpenClawSessionError {
    fn from(value: OperationError) -> Self {
        match value {
            OperationError::RequestIdExhausted => Self::RequestIdExhausted,
            OperationError::RequestDeadline => Self::RequestDeadline,
            OperationError::ConnectionClosed => Self::ConnectionClosed,
            OperationError::UnknownResponse => Self::UnknownResponse,
            OperationError::Transport => Self::Transport,
            OperationError::Protocol => Self::Protocol(None),
            OperationError::Rejected | OperationError::GatewayRejected { .. } => {
                Self::TargetRejected
            }
        }
    }
}

impl fmt::Display for OpenClawSessionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::SessionConnection => "OpenClaw session connection failed",
            Self::RequestIdExhausted => "OpenClaw session request IDs are exhausted",
            Self::RequestDeadline => "OpenClaw session request deadline elapsed",
            Self::ConnectionClosed => "OpenClaw session connection closed",
            Self::UnknownResponse => "OpenClaw session response was not correlated",
            Self::Transport => "OpenClaw session transport failed",
            Self::Protocol(_) => "OpenClaw session protocol failed",
            Self::TargetRejected => "OpenClaw session request was rejected",
            Self::EventBackpressure => "OpenClaw session event capacity was exhausted",
        })
    }
}

impl std::error::Error for OpenClawSessionError {}
