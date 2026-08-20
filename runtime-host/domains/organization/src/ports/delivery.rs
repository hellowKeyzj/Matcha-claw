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

pub trait PromptDeliveryPort {
    type Error;

    fn deliver(
        &mut self,
        request: PromptDeliveryRequest,
    ) -> Result<PromptDeliveryOutcome, Self::Error>;
}
