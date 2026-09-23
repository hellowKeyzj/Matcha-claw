pub(crate) mod adapters;
mod agent;
mod buddy;
mod native_effects;
mod provider;
mod recovery;
mod workspace;
pub use native_effects::OpenClawTeamNativeEffects;
pub(crate) use provider::TeamProvider;
#[cfg(test)]
pub(crate) use recovery::{TeamRecoveryOutcome, TeamRecoveryRequest, TeamRecoveryRole};
#[cfg(test)]
pub(crate) use workspace::ResolvedWorkspace;

use platform::exchange::InvocationOutcome;

use crate::{
    agents::{AgentWaitResult, AgentWaitStatus, AgentsWaitOutcome},
    session::{
        operation::OperationError,
        protocol::{
            AgentId, AgentScopedSessionKey, ChatSendParams, ChatSendResult, EndpointSessionId,
            RunId, SessionKey,
        },
    },
};

#[derive(Clone, PartialEq)]
pub struct PromptDelivery {
    agent_id: AgentId,
    endpoint_session_id: EndpointSessionId,
    prompt: String,
    idempotency_key: RunId,
}

impl PromptDelivery {
    pub fn try_new(
        agent_id: AgentId,
        endpoint_session_id: EndpointSessionId,
        prompt: impl Into<String>,
        idempotency_key: RunId,
    ) -> Result<Self, PromptDeliveryError> {
        let prompt = prompt.into();
        if prompt.trim().is_empty() {
            return Err(PromptDeliveryError::InvalidInput);
        }
        let delivery = Self {
            agent_id,
            endpoint_session_id,
            prompt,
            idempotency_key,
        };
        delivery.params()?;
        Ok(delivery)
    }

    pub(crate) fn into_params(self) -> Result<ChatSendParams, PromptDeliveryError> {
        self.params()
    }

    fn params(&self) -> Result<ChatSendParams, PromptDeliveryError> {
        let session_key = AgentScopedSessionKey::try_new(
            self.agent_id.clone(),
            self.endpoint_session_id.clone(),
        )?;
        Ok(ChatSendParams::try_new(
            SessionKey::try_new(session_key.as_str())?,
            self.prompt.clone(),
            self.idempotency_key.clone(),
        )?)
    }
}

impl std::fmt::Debug for PromptDelivery {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PromptDelivery")
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PromptDeliveryOutcome {
    Accepted { receipt: PromptDeliveryReceipt },
    Rejected { failure: PromptDeliveryFailure },
    OutcomeUnknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PromptDeliveryFailure {
    PolicyRejected,
    Unavailable,
}

#[derive(Clone, Eq, PartialEq)]
pub struct PromptDeliveryReceipt(RunId);

impl PromptDeliveryReceipt {
    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }
}

impl std::fmt::Debug for PromptDeliveryReceipt {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("PromptDeliveryReceipt(<redacted>)")
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PromptDeliveryError {
    InvalidInput,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeRunSettled {
    status: NativeRunStatus,
    hard_timeout: bool,
    final_assistant_text: Option<String>,
}

impl NativeRunSettled {
    pub const fn status(&self) -> NativeRunStatus {
        self.status
    }

    pub const fn is_hard_timeout(&self) -> bool {
        self.hard_timeout
    }

    pub fn final_assistant_text(&self) -> Option<&str> {
        self.final_assistant_text.as_deref()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeRunStatus {
    Completed,
    Failed,
    Timeout,
    Pending,
}

impl From<AgentWaitStatus> for NativeRunStatus {
    fn from(value: AgentWaitStatus) -> Self {
        match value {
            AgentWaitStatus::Completed => Self::Completed,
            AgentWaitStatus::Failed => Self::Failed,
            AgentWaitStatus::Timeout => Self::Timeout,
            AgentWaitStatus::Pending => Self::Pending,
        }
    }
}

impl From<AgentWaitResult> for NativeRunSettled {
    fn from(value: AgentWaitResult) -> Self {
        Self {
            status: value.status.into(),
            hard_timeout: value.is_hard_timeout(),
            final_assistant_text: value.final_assistant_text,
        }
    }
}

impl From<AgentsWaitOutcome> for NativeRunSettledOutcome {
    fn from(value: AgentsWaitOutcome) -> Self {
        match value {
            AgentsWaitOutcome::Observed(result) => Self::Observed(result.into()),
            AgentsWaitOutcome::Rejected => Self::Rejected,
            AgentsWaitOutcome::OutcomeUnknown => Self::OutcomeUnknown,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeRunSettledOutcome {
    Observed(NativeRunSettled),
    Rejected,
    OutcomeUnknown,
}

impl From<crate::session::protocol::ValidationError> for PromptDeliveryError {
    fn from(_: crate::session::protocol::ValidationError) -> Self {
        Self::InvalidInput
    }
}

pub(crate) fn map_send_outcome(
    outcome: InvocationOutcome<ChatSendResult, OperationError>,
) -> PromptDeliveryOutcome {
    match outcome {
        InvocationOutcome::Succeeded(result) => PromptDeliveryOutcome::Accepted {
            receipt: PromptDeliveryReceipt(result.run_id),
        },
        InvocationOutcome::TargetRejected(
            OperationError::Rejected | OperationError::GatewayRejected { .. },
        ) => PromptDeliveryOutcome::Rejected {
            failure: PromptDeliveryFailure::PolicyRejected,
        },
        InvocationOutcome::TargetRejected(_) => PromptDeliveryOutcome::Rejected {
            failure: PromptDeliveryFailure::Unavailable,
        },
        InvocationOutcome::Cancelled | InvocationOutcome::Unknown => {
            PromptDeliveryOutcome::OutcomeUnknown
        }
    }
}

#[cfg(test)]
mod tests {
    use platform::exchange::InvocationOutcome;

    use super::*;
    use crate::session::protocol::{ChatSendStatus, RunId};

    fn agent_id() -> AgentId {
        AgentId::try_new("mct-team").unwrap()
    }

    fn endpoint_session_id() -> EndpointSessionId {
        EndpointSessionId::try_new("team-endpoint-session-run-1-reviewer").unwrap()
    }

    fn idempotency_key() -> RunId {
        RunId::try_new("team-run:run-1:node-1").unwrap()
    }

    #[test]
    fn delivery_uses_the_existing_agent_scoped_session_key_and_idempotency_key() {
        let delivery = PromptDelivery::try_new(
            agent_id(),
            endpoint_session_id(),
            "review the release",
            idempotency_key(),
        )
        .unwrap();

        let encoded = serde_json::to_value(delivery.into_params().unwrap()).unwrap();
        assert_eq!(
            encoded,
            serde_json::json!({
                "sessionKey": "agent:mct-team:team-endpoint-session-run-1-reviewer",
                "message": "review the release",
                "idempotencyKey": "team-run:run-1:node-1"
            })
        );
    }

    #[test]
    fn delivery_rejects_blank_prompt_and_invalid_scoped_session_inputs_before_send() {
        assert_eq!(
            PromptDelivery::try_new(agent_id(), endpoint_session_id(), " \n", idempotency_key(),),
            Err(PromptDeliveryError::InvalidInput)
        );
        assert_eq!(
            PromptDelivery::try_new(
                agent_id(),
                EndpointSessionId::try_new("agent:other:session").unwrap(),
                "prompt-canary",
                idempotency_key(),
            ),
            Err(PromptDeliveryError::InvalidInput)
        );
    }

    #[test]
    fn accepted_native_responses_are_delivered_with_only_the_opaque_run_receipt() {
        for status in [
            ChatSendStatus::Started,
            ChatSendStatus::InFlight,
            ChatSendStatus::Ok,
        ] {
            let outcome = map_send_outcome(InvocationOutcome::Succeeded(ChatSendResult {
                run_id: RunId::try_new("native-run-canary").unwrap(),
                status,
            }));

            assert_eq!(
                outcome,
                PromptDeliveryOutcome::Accepted {
                    receipt: PromptDeliveryReceipt(RunId::try_new("native-run-canary").unwrap()),
                }
            );
        }
    }

    #[test]
    fn peer_rejection_and_pre_write_unavailability_remain_distinct() {
        assert_eq!(
            map_send_outcome(InvocationOutcome::TargetRejected(OperationError::Rejected)),
            PromptDeliveryOutcome::Rejected {
                failure: PromptDeliveryFailure::PolicyRejected,
            }
        );
        assert_eq!(
            map_send_outcome(InvocationOutcome::TargetRejected(
                OperationError::RequestDeadline
            )),
            PromptDeliveryOutcome::Rejected {
                failure: PromptDeliveryFailure::Unavailable,
            }
        );
    }

    #[test]
    fn uncertain_or_cancelled_mutations_remain_outcome_unknown() {
        for outcome in [InvocationOutcome::Unknown, InvocationOutcome::Cancelled] {
            assert_eq!(
                map_send_outcome(outcome),
                PromptDeliveryOutcome::OutcomeUnknown
            );
        }
    }

    #[test]
    fn delivery_values_redact_prompt_and_native_receipt() {
        let delivery = PromptDelivery::try_new(
            agent_id(),
            endpoint_session_id(),
            "prompt-canary",
            idempotency_key(),
        )
        .unwrap();
        let params = delivery.clone().into_params().unwrap();
        let receipt = PromptDeliveryReceipt(RunId::try_new("native-run-canary").unwrap());
        let outcome = PromptDeliveryOutcome::Accepted {
            receipt: receipt.clone(),
        };

        let delivery_debug = format!("{delivery:?}");
        let params_debug = format!("{params:?}");
        let outcome_debug = format!("{outcome:?}");
        assert!(!delivery_debug.contains("prompt-canary"));
        assert!(!delivery_debug.contains(idempotency_key().as_str()));
        assert!(!delivery_debug.contains(endpoint_session_id().as_str()));
        assert_eq!(delivery_debug, "PromptDelivery { .. }");
        assert!(!params_debug.contains("prompt-canary"));
        assert!(!params_debug.contains(idempotency_key().as_str()));
        assert!(!params_debug.contains(endpoint_session_id().as_str()));
        assert_eq!(format!("{receipt:?}"), "PromptDeliveryReceipt(<redacted>)");
        assert!(!outcome_debug.contains("native-run-canary"));
    }
}
