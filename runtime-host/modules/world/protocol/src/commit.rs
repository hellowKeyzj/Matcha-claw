use crate::{ids::*, time::Timestamp};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WriteFence {
    pub world: WorldRef,
    pub domain: WriterDomain,
    pub epoch: WriterEpoch,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommittedRevision {
    pub resource: ResourceRef,
    pub revision: Revision,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitReceipt {
    pub world: WorldRef,
    pub commit_id: CommitId,
    pub committed_at: Timestamp,
    pub revisions: Vec<CommittedRevision>,
    pub outbox_ids: Vec<EventId>,
    pub fence: WriteFence,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CommitFailure {
    Installation {
        reason: InstallationFailure,
    },
    NotConfigured,
    Closed,
    Connection,
    PoolTimeout,
    StatementTimeout,
    SerializationConflict,
    Deadlock,
    RollbackFailed,
    CommitIdPayloadConflict {
        commit_id: CommitId,
    },
    InvalidBatch,
    ReadDependencyChanged {
        resource: ResourceRef,
    },
    ConstraintConflict {
        constraint: ConstraintCode,
    },
    RevisionConflict {
        resource: ResourceRef,
        expected: Revision,
        actual: Revision,
    },
    RolledBack,
    Fenced {
        expected: WriterEpoch,
        actual: WriterEpoch,
    },
    CommitIndeterminate {
        commit_id: CommitId,
    },
    TransferIndeterminate {
        transfer_id: TransferId,
    },
    InternalFault,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum InstallationFailure {
    UnsupportedVersion,
    ExtensionUnavailable,
    PermissionDenied,
    SchemaMismatch,
    StorageIdentityMismatch,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ConstraintCode {
    DatabaseConstraint,
    IdentityAlias,
    ImmutableRevision,
    IdempotencyPayload,
    SupportCycle,
    HeadGeneration,
    StateEpoch,
    ForeignReference,
    ScopeOverlap,
}
