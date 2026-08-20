use std::{fmt, future::Future, pin::Pin};

use super::{
    DeliveryReceiptReference, ExternalSessionReference, MaterializationOperationOutcome,
    PromptDeliveryOutcome, PromptDeliveryRequest, RoleSessionReceipt, SessionWindowReference,
    TeamMaterializationRemoval, TeamMaterializationRequest,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeEffectFailure {
    InvalidInput,
    Rejected,
    Unavailable,
    Unsupported,
}

#[derive(Clone, Eq, PartialEq)]
pub struct RoleSessionAbortReceipt {
    session: ExternalSessionReference,
}

impl RoleSessionAbortReceipt {
    pub fn new(session: ExternalSessionReference) -> Self {
        Self { session }
    }

    pub fn session(&self) -> &ExternalSessionReference {
        &self.session
    }
}

impl fmt::Debug for RoleSessionAbortReceipt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("RoleSessionAbortReceipt(<redacted>)")
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RoleSessionAbortOutcome {
    Confirmed { receipt: RoleSessionAbortReceipt },
    Failed { failure: NativeEffectFailure },
    OutcomeUnknown,
}

#[derive(Clone, Eq, PartialEq)]
pub struct RoleSessionDeleteReceipt {
    session: ExternalSessionReference,
}

impl RoleSessionDeleteReceipt {
    pub fn new(session: ExternalSessionReference) -> Self {
        Self { session }
    }

    pub fn session(&self) -> &ExternalSessionReference {
        &self.session
    }
}

impl fmt::Debug for RoleSessionDeleteReceipt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("RoleSessionDeleteReceipt(<redacted>)")
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RoleSessionDeleteOutcome {
    Confirmed { receipt: RoleSessionDeleteReceipt },
    Failed { failure: NativeEffectFailure },
    OutcomeUnknown,
}

#[derive(Clone, Eq, PartialEq)]
pub struct RoleSessionReadbackReceipt {
    session: ExternalSessionReference,
    window: SessionWindowReference,
}

impl RoleSessionReadbackReceipt {
    pub fn new(session: ExternalSessionReference, window: SessionWindowReference) -> Self {
        Self { session, window }
    }

    pub fn session(&self) -> &ExternalSessionReference {
        &self.session
    }

    pub fn window(&self) -> &SessionWindowReference {
        &self.window
    }
}

impl fmt::Debug for RoleSessionReadbackReceipt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("RoleSessionReadbackReceipt(<redacted>)")
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RoleSessionReadbackOutcome {
    Confirmed { receipt: RoleSessionReadbackReceipt },
    Failed { failure: NativeEffectFailure },
    OutcomeUnknown,
}

pub trait TeamNativeEffectsPort {
    fn materialize(
        &mut self,
        request: TeamMaterializationRequest,
    ) -> Pin<Box<dyn Future<Output = MaterializationOperationOutcome> + Send + '_>>;

    fn recover_materialization(
        &mut self,
        request: TeamMaterializationRequest,
    ) -> Pin<Box<dyn Future<Output = MaterializationOperationOutcome> + Send + '_>>;

    fn remove(
        &mut self,
        removal: TeamMaterializationRemoval,
    ) -> Pin<Box<dyn Future<Output = MaterializationOperationOutcome> + Send + '_>>;

    fn deliver(
        &mut self,
        request: PromptDeliveryRequest,
    ) -> Pin<Box<dyn Future<Output = PromptDeliveryOutcome> + Send + '_>>;

    fn abort(
        &mut self,
        receipt: &RoleSessionReceipt,
    ) -> Pin<Box<dyn Future<Output = RoleSessionAbortOutcome> + Send + '_>>;

    fn delete(
        &mut self,
        receipt: &RoleSessionReceipt,
    ) -> Pin<Box<dyn Future<Output = RoleSessionDeleteOutcome> + Send + '_>>;

    fn readback(
        &mut self,
        receipt: &RoleSessionReceipt,
    ) -> Pin<Box<dyn Future<Output = RoleSessionReadbackOutcome> + Send + '_>>;
}

#[allow(dead_code)]
fn _opaque_receipt_types_are_publicly_safe(
    _delivery: DeliveryReceiptReference,
    _session: ExternalSessionReference,
) {
}
