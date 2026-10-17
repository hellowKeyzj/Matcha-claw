use std::{fmt, future::Future, pin::Pin, sync::Arc};

use runtime_directory::OwnedRuntimeFuture;

use crate::{GraphRunId, NativeDeletionEvidence, RoleAbortOutcome};

use super::{
    ActivityExecutionOutcome, ActivityExecutionRequest, DeliveryReceiptReference,
    EndpointSessionId, ManagedAgentReference, MaterializationOperationOutcome,
    MemberProfile, RoleSessionReceipt, RunRuntimeReceipt, TeamCreationFailure,
    TeamCreationFailureReason, TeamCreationStage,
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RoleSessionRetirementOutcome {
    Confirmed,
    OutcomeUnknown,
}

pub trait OrganizationNativeRuntime: Send + Sync {
    /// Reads native description, AGENTS.md and SOUL.md without modifying agents or files.
    /// A successful result contains one profile per input agent, in the same order.
    fn read_team_member_profiles(
        &self,
        _agents: Vec<ManagedAgentReference>,
    ) -> OwnedRuntimeFuture<Result<Vec<MemberProfile>, TeamCreationFailure>> {
        Box::pin(async {
            Err(TeamCreationFailure::new(TeamCreationStage::ReadingProfiles, TeamCreationFailureReason::Unsupported))
        })
    }

    fn read_team_member_profiles_cancellable(
        &self,
        _agents: Vec<ManagedAgentReference>,
        _cancellation: tokio_util::sync::CancellationToken,
    ) -> OwnedRuntimeFuture<Result<Vec<MemberProfile>, TeamCreationFailure>> {
        Box::pin(async {
            Err(TeamCreationFailure::new(TeamCreationStage::ReadingProfiles, TeamCreationFailureReason::Unsupported))
        })
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

    /// Reads only cleanup evidence for the original removal; never repeats native removal.
    fn recover_team_removal(
        &self,
        _removal: TeamMaterializationRemoval,
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

    /// Permanently fences unconfirmed identities; confirmation is not deletion proof.
    fn retire_unconfirmed_role_sessions(
        &self,
        _bindings: Vec<RoleSessionReceipt>,
        _cancellation: tokio_util::sync::CancellationToken,
    ) -> OwnedRuntimeFuture<RoleSessionRetirementOutcome> {
        Box::pin(async { RoleSessionRetirementOutcome::OutcomeUnknown })
    }

    fn materialize_team_cancellable(
        &self,
        request: TeamMaterializationRequest,
        observer: Option<super::TeamProvisionObserver>,
        _cancellation: tokio_util::sync::CancellationToken,
    ) -> OwnedRuntimeFuture<MaterializationOperationOutcome> {
        self.materialize_team_observed(request, observer)
    }

    fn confirm_team_run_receipt_cancellable(
        &self,
        receipt: RunRuntimeReceipt,
        _cancellation: tokio_util::sync::CancellationToken,
    ) -> OwnedRuntimeFuture<(RuntimeReceiptOutcome, Option<TeamCreationFailure>)> {
        let confirmation = self.confirm_team_run_receipt(receipt);
        Box::pin(async move { (confirmation.await, None) })
    }

    fn abort_role_sessions_cancellable(
        &self,
        bindings: Vec<RoleSessionReceipt>,
        _cancellation: tokio_util::sync::CancellationToken,
    ) -> OwnedRuntimeFuture<RoleAbortOutcome> {
        self.abort_role_sessions(bindings)
    }

    fn delete_role_sessions_cancellable(
        &self,
        run_id: GraphRunId,
        bindings: Vec<RoleSessionReceipt>,
        abort_first: bool,
        _cancellation: tokio_util::sync::CancellationToken,
    ) -> OwnedRuntimeFuture<NativeDeletionEvidence> {
        self.delete_role_sessions(run_id, bindings, abort_first)
    }

    fn remove_team_cancellable(
        &self,
        removal: TeamMaterializationRemoval,
        _cancellation: tokio_util::sync::CancellationToken,
    ) -> OwnedRuntimeFuture<MaterializationOperationOutcome> {
        self.remove_team(removal)
    }

    fn remove_unconfirmed_team_cancellable(
        &self,
        request: TeamMaterializationRequest,
        _cancellation: tokio_util::sync::CancellationToken,
    ) -> OwnedRuntimeFuture<MaterializationOperationOutcome> {
        self.remove_unconfirmed_team(request)
    }

    fn installed_skill_names(&self, source_agent: Option<ManagedAgentReference>) -> OwnedRuntimeFuture<Option<Vec<String>>>;
}

pub trait OrganizationRuntimeDirectory: Send + Sync {
    fn team_runtime_for_endpoint(
        &self,
        endpoint: &super::RuntimeEndpointReference,
    ) -> Option<Arc<dyn OrganizationNativeRuntime>>;

    fn open_claw_runtime(&self) -> Option<Arc<dyn OrganizationNativeRuntime>>;
}

pub trait TeamActivityExecutor: Send + Sync {
    /// Prepares the session without sending. Organization admits dispatch after this completes.
    fn prepare_cancellable(
        &self,
        _request: ActivityExecutionRequest,
        _cancellation: tokio_util::sync::CancellationToken,
    ) -> OwnedRuntimeFuture<Result<(), ActivityExecutionOutcome>> {
        Box::pin(async { Ok(()) })
    }

    /// Sends a prepared activity after Organization dispatch admission.
    fn execute(
        &self,
        request: ActivityExecutionRequest,
    ) -> OwnedRuntimeFuture<ActivityExecutionOutcome>;

    fn execute_cancellable(
        &self,
        request: ActivityExecutionRequest,
        _cancellation: tokio_util::sync::CancellationToken,
    ) -> OwnedRuntimeFuture<ActivityExecutionOutcome> {
        self.execute(request)
    }

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
