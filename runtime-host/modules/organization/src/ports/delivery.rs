use crate::{
    ActivityKind, ActivityRequest, DeliveryId, NativeDeliveryCorrelation,
    NativeRunReceiptReference, NativeTerminalStatus, TeamId,
};

use super::{DeliveryReceiptReference, DeliveryReference, IdempotencyKey, RoleSessionReceipt};

#[derive(Clone, Eq, PartialEq)]
pub struct PromptDispatchPayload(String);

impl std::fmt::Debug for PromptDispatchPayload {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("PromptDispatchPayload([redacted])")
    }
}

impl PromptDispatchPayload {
    pub fn try_new(value: impl Into<String>) -> Result<Self, InvalidPromptDispatchPayload> {
        let value = value.into();
        if value.trim().is_empty() {
            return Err(InvalidPromptDispatchPayload);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InvalidPromptDispatchPayload;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PromptDeliveryRequest {
    delivery: DeliveryReference,
    binding: RoleSessionReceipt,
    idempotency_key: IdempotencyKey,
    payload: PromptDispatchPayload,
}

impl PromptDeliveryRequest {
    pub fn new(
        delivery: DeliveryReference,
        binding: RoleSessionReceipt,
        idempotency_key: IdempotencyKey,
        payload: PromptDispatchPayload,
    ) -> Self {
        Self {
            delivery,
            binding,
            idempotency_key,
            payload,
        }
    }

    pub fn delivery(&self) -> &DeliveryReference {
        &self.delivery
    }

    pub fn binding(&self) -> &RoleSessionReceipt {
        &self.binding
    }

    pub fn idempotency_key(&self) -> &IdempotencyKey {
        &self.idempotency_key
    }

    pub fn payload(&self) -> &PromptDispatchPayload {
        &self.payload
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DeliveryRejection {
    Permanent,
    Retryable,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PromptDeliveryOutcome {
    Delivered { receipt: DeliveryReceiptReference },
    Rejected { rejection: DeliveryRejection },
    OutcomeUnknown,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActivityExecutionRequest {
    delivery: crate::DeliveryRequest,
    binding: RoleSessionReceipt,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ActivityExecutionRequestError {
    InvalidDeliveryReference,
    InvalidIdempotencyKey,
    InvalidPromptPayload,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ActivityExecutionOutcome {
    Accepted {
        receipt: DeliveryReceiptReference,
        correlation: NativeDeliveryCorrelation,
    },
    Rejected {
        rejection: DeliveryRejection,
    },
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeRunSettled {
    pub status: NativeTerminalStatus,
    pub final_assistant_text: Option<String>,
}

impl ActivityExecutionRequest {
    pub fn agent_task(
        team_id: &TeamId,
        activity: &ActivityRequest,
        binding: RoleSessionReceipt,
    ) -> Result<Self, ActivityExecutionRequestError> {
        let ActivityKind::AgentTask {
            task_id,
            role_id,
            prompt,
            ..
        } = &activity.activity_kind
        else {
            return Err(ActivityExecutionRequestError::InvalidPromptPayload);
        };
        let delivery = crate::DeliveryRequest {
            delivery_id: DeliveryId::new(activity.activity_id.as_str().to_owned())
                .map_err(|_| ActivityExecutionRequestError::InvalidDeliveryReference)?,
            team_id: team_id.as_str().to_owned(),
            run_id: activity.run_id.as_str().to_owned(),
            node_id: activity.node_id.as_str().to_owned(),
            node_execution_id: activity.node_execution_id.as_str().to_owned(),
            task_id: task_id.clone(),
            role_id: role_id.clone(),
            session_ref: binding.session_ref().as_str().to_owned(),
            idempotency_key: activity.idempotency_key.clone(),
            message: prompt.clone(),
            requested_at: activity.created_at,
            max_attempts: activity.max_attempts,
        };
        delivery
            .validate()
            .map_err(|_| ActivityExecutionRequestError::InvalidPromptPayload)?;
        Ok(Self { delivery, binding })
    }

    pub fn from_delivery_request(
        delivery: crate::DeliveryRequest,
        binding: RoleSessionReceipt,
    ) -> Self {
        Self { delivery, binding }
    }

    pub fn binding(&self) -> &RoleSessionReceipt {
        &self.binding
    }

    pub fn delivery_request(&self) -> &crate::DeliveryRequest {
        &self.delivery
    }
}

impl ActivityExecutionOutcome {
    pub fn accepted(endpoint_session_id: super::EndpointSessionId, run_id: String) -> Self {
        let Ok(receipt) = DeliveryReceiptReference::try_new(run_id.clone()) else {
            return Self::Unknown;
        };
        let Ok(native_run_receipt) = NativeRunReceiptReference::try_new(run_id) else {
            return Self::Unknown;
        };
        Self::Accepted {
            receipt,
            correlation: NativeDeliveryCorrelation::new(endpoint_session_id, native_run_receipt),
        }
    }
}

pub trait PromptDeliveryPort {
    type Error;

    fn deliver(
        &mut self,
        request: PromptDeliveryRequest,
    ) -> Result<PromptDeliveryOutcome, Self::Error>;
}
