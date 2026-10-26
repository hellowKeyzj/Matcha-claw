use crate::{
    ids::*,
    materials::BlobRef,
    sources::{ContractRef, SourceCheckpoint},
    time::Timestamp,
};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StateEpoch {
    pub world: WorldRef,
    pub namespace: StateNamespaceId,
    pub root: StateRef,
    pub writer_domain: WriterDomain,
    pub writer_epoch: WriterEpoch,
    pub schema: Digest,
    pub checkpoint_format: CheckpointFormatId,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StateSnapshot {
    pub epoch: StateEpoch,
    pub content: BlobRef,
    pub checkpoint: Option<SourceCheckpoint>,
    pub created_at: Timestamp,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StateMigration {
    pub id: MigrationId,
    pub expected: StateEpoch,
    pub target_schema: Digest,
    pub target_checkpoint_format: CheckpointFormatId,
    pub contract: ContractRef,
    pub shadow_root: StateRootId,
    pub reversible: bool,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StateMigrationReceipt {
    pub migration_id: MigrationId,
    pub source: crate::bindings::StateBinding,
    pub target: crate::bindings::StateBinding,
    pub snapshot: StateSnapshot,
    pub validated_at: Timestamp,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StateHeadCas {
    pub expected: StateEpoch,
    pub replacement: StateSnapshot,
    pub commit_id: CommitId,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StateMigrationInput {
    pub migration: StateMigration,
    pub checkpoint: Vec<u8>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StateMigrationOutput {
    pub schema: Digest,
    pub checkpoint_format: CheckpointFormatId,
    pub checkpoint: Vec<u8>,
}
pub fn migration_contract() -> Result<ContractRef, crate::schema::SchemaFailure> {
    crate::schema::method::<StateMigrationInput, StateMigrationOutput, StateFailure>(
        "state.migrate",
    )
}
pub const KV_CHECKPOINT_FORMAT: &str = "matcha.world-kv.1";
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum StateFailure {
    KeyInvalid,
    SizeLimit,
    RevisionConflict {
        expected: Option<Revision>,
        actual: Option<Revision>,
    },
    RootConflict {
        expected: StateRef,
        actual: StateRef,
    },
    NamespaceMissing {
        namespace: StateNamespaceId,
    },
    EpochStale {
        expected: WriterEpoch,
        actual: WriterEpoch,
    },
    SchemaMismatch {
        expected: Digest,
        actual: Digest,
    },
    CheckpointIncompatible {
        format: CheckpointFormatId,
    },
    MigrationUnavailable {
        migration_id: MigrationId,
    },
    MigrationFailed {
        migration_id: MigrationId,
    },
    CheckpointBarrierUnsatisfied,
    ReaderNotStopped,
    WriterNotStopped,
    AckNotStopped,
    ShadowValidationFailed,
    Fenced,
    Commit {
        failure: crate::commit::CommitFailure,
    },
    InternalFault,
}
