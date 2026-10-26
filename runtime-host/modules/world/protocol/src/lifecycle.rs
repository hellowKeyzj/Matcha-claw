use crate::{
    bindings::{ExactClosure, ImplementationRef},
    ids::*,
    time::{DurationMs, Timestamp},
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedNodeReceipt {
    pub node_id: NodeId,
    pub generation_id: PluginGenerationId,
    pub implementation: ImplementationRef,
    pub config_digest: Digest,
    pub ports: Vec<crate::bindings::MethodPort>,
    pub state: Option<crate::bindings::StateBinding>,
    pub checkpoint_format: Option<CheckpointFormatId>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrepareReceipt {
    pub activation_lock_id: ActivationLockId,
    pub lock_digest: Digest,
    pub nodes: Vec<PreparedNodeReceipt>,
    pub prepared_at: Timestamp,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LifecycleRequest {
    pub world: WorldRef,
    pub operation_id: OperationId,
    pub install_id: InstallId,
    pub expected_revision: Revision,
    pub operation: LifecycleOperation,
    pub timeout: DurationMs,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum LifecycleOperation {
    Enable,
    Disable,
    Revoke,
    Quarantine,
    Stop,
    Uninstall,
    DeleteWorld,
    Upgrade,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesiredPluginState {
    pub world: WorldRef,
    pub install_id: InstallId,
    pub revision: Revision,
    pub desired_enabled: bool,
    pub activation_lock_id: ActivationLockId,
    pub implementation: ImplementationRef,
    pub config_revision: Revision,
    pub trust_revision: Revision,
    pub grant_epoch: GrantEpoch,
    pub quarantined: bool,
    pub pending_removal: bool,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InvocationLease {
    pub id: InvocationLeaseId,
    pub invocation_id: InvocationId,
    pub generation_id: PluginGenerationId,
    pub closure: ExactClosure,
    pub resources: Vec<ResourceToken>,
    pub acquired_at: Timestamp,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcquisitionTicket {
    pub id: AcquisitionId,
    pub generation_id: PluginGenerationId,
    pub invocation_id: Option<InvocationId>,
    pub kind: ResourceKind,
    pub policy_epoch: PolicyEpoch,
    pub grant_epoch: GrantEpoch,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ResourceKind {
    Invocation,
    Dependency,
    Registration,
    Stream,
    Body,
    HostIo,
    Callback,
    Timer,
    ChildCall,
    TaskJoin,
    Store,
    Process,
    PrivateMaterial,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ResourceStage {
    Acquiring,
    Running,
    Joining,
    CleanupFailed,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RetainedResource {
    pub parts: Vec<ResourcePartFailure>,
    pub token: ResourceToken,
    pub generation_id: PluginGenerationId,
    pub invocation_id: Option<InvocationId>,
    pub acquisition_id: Option<AcquisitionId>,
    pub kind: ResourceKind,
    pub stage: ResourceStage,
    pub reason: ResourceFailureReason,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourcePartFailure {
    pub kind: ResourceKind,
    pub name: String,
    pub stage: ResourceFailureStage,
    pub code: String,
    pub message: String,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ResourceFailureStage {
    Acquisition,
    Admission,
    Cancel,
    Stop,
    Shutdown,
    SupervisorJoin,
    TaskJoin,
    MaterialCleanup,
    Cleanup,
    Completion,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ResourceFailureReason {
    AcquisitionClosed,
    DependencyMissing,
    AuthorizationRevoked,
    CleanupFailed,
    JoinFailed,
    EngineNotStopped,
    ProcessExitUnconfirmed,
    Timeout,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum LifecycleStage {
    Prepare,
    Acquire,
    CloseAcquisition,
    Revoke,
    Cancel,
    Join,
    Cleanup,
    StopEngine,
    StopProcess,
    Commit,
    Recover,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum GenerationState {
    Preparing,
    Active,
    Retiring {
        operation: LifecycleOperation,
    },
    Retained {
        stage: LifecycleStage,
        remaining_resources: Vec<RetainedResource>,
    },
    Stopped,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LifecycleStatus {
    pub operation_id: OperationId,
    pub install_id: InstallId,
    pub generation_id: PluginGenerationId,
    pub state: GenerationState,
    pub desired: DesiredPluginState,
    pub revision: Revision,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum LifecycleFailure {
    MissingInstall {
        install_id: InstallId,
    },
    MissingConfiguration {
        install_id: InstallId,
    },
    MissingTrust {
        install_id: InstallId,
    },
    InvalidPersistedState,
    AlreadyPrepared,
    ConcurrentCallLimit {
        node_id: NodeId,
    },
    AcquisitionClosed,
    DependencyMissing {
        node_id: NodeId,
    },
    AuthorizationRevoked,
    PrepareFailed {
        node_id: NodeId,
    },
    Retained {
        stage: LifecycleStage,
        remaining_resources: Vec<RetainedResource>,
    },
    StateMigrationRequired {
        migration_id: MigrationId,
    },
    RevisionConflict {
        expected: Revision,
        actual: Revision,
    },
    Commit {
        failure: crate::commit::CommitFailure,
    },
    InternalFault,
}
