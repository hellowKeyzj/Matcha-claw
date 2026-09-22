use std::fmt;

use crate::{
    domain::command::{CommandAttempt, CommandId, CommandIntent, CommandKind, CommandTarget},
    domain::outbox::{DispatchAttempt, DispatchIntent},
    domain::target::{FleetTargetConfig, FleetTargetSelector, TargetEndpointBinding},
    domain::topology::EndpointObservation,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FleetDispatchTarget {
    selector: FleetTargetSelector,
    config: FleetTargetConfig,
    binding: TargetEndpointBinding,
    endpoint: EndpointObservation,
}

impl FleetDispatchTarget {
    pub fn new(
        selector: FleetTargetSelector,
        config: FleetTargetConfig,
        binding: TargetEndpointBinding,
        endpoint: EndpointObservation,
    ) -> Self {
        Self {
            selector,
            config,
            binding,
            endpoint,
        }
    }

    pub fn selector(&self) -> &FleetTargetSelector {
        &self.selector
    }

    pub fn config(&self) -> &FleetTargetConfig {
        &self.config
    }

    pub fn binding(&self) -> &TargetEndpointBinding {
        &self.binding
    }

    pub fn endpoint(&self) -> &EndpointObservation {
        &self.endpoint
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FleetDispatchRequest {
    command: CommandIntent,
    dispatch: DispatchIntent,
    attempt: DispatchAttempt,
    target: Option<FleetDispatchTarget>,
}

impl FleetDispatchRequest {
    pub fn try_new(
        command: CommandIntent,
        dispatch: DispatchIntent,
        attempt: DispatchAttempt,
    ) -> Result<Self, FleetDispatchRequestError> {
        if command.command_id() != dispatch.command_id() {
            return Err(FleetDispatchRequestError::MismatchedCommand);
        }

        Ok(Self {
            command,
            dispatch,
            attempt,
            target: None,
        })
    }

    pub fn with_target(mut self, target: FleetDispatchTarget) -> Self {
        self.target = Some(target);
        self
    }

    pub fn command(&self) -> &CommandIntent {
        &self.command
    }

    pub fn dispatch(&self) -> &DispatchIntent {
        &self.dispatch
    }

    pub fn attempt(&self) -> &DispatchAttempt {
        &self.attempt
    }

    /// Projects the command attempt from the same durable delivery attempt.
    ///
    /// `DispatchAttempt` rejects zero, so this conversion cannot manufacture a
    /// second sequence or silently fall back to one.
    pub fn command_attempt(&self) -> CommandAttempt {
        CommandAttempt::try_new(self.attempt.sequence())
            .expect("a valid dispatch request always has a positive attempt")
    }

    pub fn command_id(&self) -> &CommandId {
        self.command.command_id()
    }

    /// Safe operation projection for dispatch adapters. It contains only typed
    /// identity and selector facts; credentials and target configuration remain
    /// owned by Fleet and are never exposed through this request.
    pub fn operation_kind(&self) -> CommandKind {
        self.command.kind()
    }

    pub fn operation_target(&self) -> &CommandTarget {
        self.command.target()
    }

    pub fn target_selector(&self) -> Option<&FleetTargetSelector> {
        self.target
            .as_ref()
            .map(FleetDispatchTarget::selector)
            .or_else(|| self.dispatch.target())
    }

    pub fn target(&self) -> Option<&FleetDispatchTarget> {
        self.target.as_ref()
    }

    pub fn agent_id(&self) -> &platform::endpoint::NativeAgentId {
        self.dispatch.agent_id()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FleetDispatchRequestError {
    MismatchedCommand,
}

impl fmt::Display for FleetDispatchRequestError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Fleet dispatch intent must reference its command")
    }
}

impl std::error::Error for FleetDispatchRequestError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FleetDispatchReadbackError {
    DispatchNotFound,
    DispatchCommandMismatch,
    DispatchAgentMismatch,
    DispatchAttemptMismatch,
    CommandNotFound,
    CommandCorrelationMismatch,
    RuntimeAgentAttemptMismatch,
}

impl fmt::Display for FleetDispatchReadbackError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::DispatchNotFound => "Fleet dispatch readback source is missing",
            Self::DispatchCommandMismatch => "Fleet dispatch readback command does not match",
            Self::DispatchAgentMismatch => "Fleet dispatch readback agent does not match",
            Self::DispatchAttemptMismatch => "Fleet dispatch readback attempt is stale",
            Self::CommandNotFound => "Fleet command readback source is missing",
            Self::CommandCorrelationMismatch => {
                "Fleet RuntimeAgent readback correlation does not match"
            }
            Self::RuntimeAgentAttemptMismatch => {
                "Fleet RuntimeAgent readback attempt does not match"
            }
        })
    }
}

impl std::error::Error for FleetDispatchReadbackError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FleetDispatchOutcome {
    Accepted,
    Rejected,
    OutcomeUnknown,
}

pub trait FleetDispatchPort {
    type Error;

    fn dispatch(
        &mut self,
        request: &FleetDispatchRequest,
    ) -> Result<FleetDispatchOutcome, Self::Error>;
}
