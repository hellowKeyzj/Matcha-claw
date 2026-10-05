use std::{fmt, future::Future, pin::Pin, sync::Arc};

use runtime_directory::OwnedRuntimeFuture;

use crate::{GraphRunId, NativeDeletionEvidence, RoleAbortOutcome};

use super::{
    ActivityExecutionOutcome, ActivityExecutionRequest, DeliveryReceiptReference,
    EndpointSessionId, ManagedAgentReference, MaterializationOperationOutcome,
    MemberIntroductionError, MemberProfile, RoleSessionReceipt, RunRuntimeReceipt,
    SessionWindowReference, TeamMaterializationRemoval, TeamMaterializationRequest,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeEffectFailure {
    InvalidInput,
    Rejected,
    Unavailable,
    Unsupported,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeReceiptOutcome {
    Installed,
    Rejected,
    OutcomeUnknown,
    Unavailable,
}

pub trait OrganizationNativeRuntime: Send + Sync {
    /// Reads native description, AGENTS.md and SOUL.md without modifying agents or files.
    /// A successful result contains one profile per input agent, in the same order.
    fn read_team_member_profiles(
        &self,
        _agents: Vec<ManagedAgentReference>,
    ) -> OwnedRuntimeFuture<Result<Vec<MemberProfile>, MemberIntroductionError>> {
        Box::pin(async { Err(MemberIntroductionError::Unsupported) })
    }

    fn materialize_team(
        &self,
        request: TeamMaterializationRequest,
    ) -> OwnedRuntimeFuture<MaterializationOperationOutcome>;

    /// Optional observation of the same native materialization execution.
    fn materialize_team_observed(
        &self,
        request: TeamMaterializationRequest,
        _observer: Option<super::TeamProvisionObserver>,
    ) -> OwnedRuntimeFuture<MaterializationOperationOutcome> {
        self.materialize_team(request)
    }

    fn remove_team(
        &self,
        removal: TeamMaterializationRemoval,
    ) -> OwnedRuntimeFuture<MaterializationOperationOutcome>;

    /// Removes only native remnants verified against the original unconfirmed intent.
    /// `Confirmed` is cleanup evidence, not a materialization receipt to install.
    fn remove_unconfirmed_team(
        &self,
        _request: TeamMaterializationRequest,
    ) -> OwnedRuntimeFuture<MaterializationOperationOutcome> {
        Box::pin(async { MaterializationOperationOutcome::OutcomeUnknown })
    }

    fn recover_team_materialization(
        &self,
        request: TeamMaterializationRequest,
    ) -> OwnedRuntimeFuture<MaterializationOperationOutcome>;

    fn confirm_team_run_receipt(
        &self,
        receipt: RunRuntimeReceipt,
    ) -> OwnedRuntimeFuture<RuntimeReceiptOutcome>;

    fn abort_role_sessions(
        &self,
        bindings: Vec<RoleSessionReceipt>,
    ) -> OwnedRuntimeFuture<RoleAbortOutcome>;

    fn delete_role_sessions(
        &self,
        run_id: GraphRunId,
        bindings: Vec<RoleSessionReceipt>,
        abort_first: bool,
    ) -> OwnedRuntimeFuture<NativeDeletionEvidence>;

    fn installed_skill_names(&self) -> OwnedRuntimeFuture<Option<Vec<String>>>;
}

pub trait OrganizationRuntimeDirectory: Send + Sync {
    fn team_runtime_for_endpoint(
        &self,
        endpoint: &super::RuntimeEndpointReference,
    ) -> Option<Arc<dyn OrganizationNativeRuntime>>;

    fn open_claw_runtime(&self) -> Option<Arc<dyn OrganizationNativeRuntime>>;
}

pub trait TeamActivityExecutor: Send + Sync {
    fn execute(
        &self,
        request: ActivityExecutionRequest,
    ) -> OwnedRuntimeFuture<ActivityExecutionOutcome>;

    fn open_claw_ready(&self) -> bool;
}

#[derive(Clone, Eq, PartialEq)]
pub struct RoleSessionAbortReceipt {
    session: EndpointSessionId,
}

impl RoleSessionAbortReceipt {
    pub fn new(session: EndpointSessionId) -> Self {
        Self { session }
    }

    pub fn session(&self) -> &EndpointSessionId {
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
    session: EndpointSessionId,
}

impl RoleSessionDeleteReceipt {
    pub fn new(session: EndpointSessionId) -> Self {
        Self { session }
    }

    pub fn session(&self) -> &EndpointSessionId {
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
    session: EndpointSessionId,
    window: SessionWindowReference,
}

impl RoleSessionReadbackReceipt {
    pub fn new(session: EndpointSessionId, window: SessionWindowReference) -> Self {
        Self { session, window }
    }

    pub fn session(&self) -> &EndpointSessionId {
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

    /// Optional observation of the same materialization execution.
    fn materialize_observed(
        &mut self,
        request: TeamMaterializationRequest,
        _observer: Option<super::TeamProvisionObserver>,
    ) -> Pin<Box<dyn Future<Output = MaterializationOperationOutcome> + Send + '_>> {
        self.materialize(request)
    }

    fn recover_materialization(
        &mut self,
        request: TeamMaterializationRequest,
    ) -> Pin<Box<dyn Future<Output = MaterializationOperationOutcome> + Send + '_>>;

    fn remove(
        &mut self,
        removal: TeamMaterializationRemoval,
    ) -> Pin<Box<dyn Future<Output = MaterializationOperationOutcome> + Send + '_>>;

    fn remove_unconfirmed(
        &mut self,
        _request: TeamMaterializationRequest,
    ) -> Pin<Box<dyn Future<Output = MaterializationOperationOutcome> + Send + '_>> {
        Box::pin(async { MaterializationOperationOutcome::OutcomeUnknown })
    }

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
    _session: EndpointSessionId,
) {
}
