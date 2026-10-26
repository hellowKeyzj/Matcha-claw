use crate::{
    compiler::{ArtifactManifest, CompileRequest},
    definitions::{Definition, DefinitionBody, Scope},
    evaluation::BranchBasis,
    failure::FieldPath,
    ids::*,
    provenance::ReadDependency,
    query::ReadReceipt,
    sources::SourceBasis,
    time::Timestamp,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorldBranch {
    pub world: WorldRef,
    pub id: BranchId,
    pub revision: Revision,
    pub task_id: TaskId,
    pub task_revision: Revision,
    pub basis: BranchBasis,
    pub compile: CompileRequest,
    pub candidate_id: CandidateId,
    pub change_set_id: ChangeSetId,
    pub status: crate::learning::ChangeStatus,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Release {
    pub world: WorldRef,
    pub id: ReleaseId,
    pub parent: Option<ReleaseId>,
    pub source_branch: Option<BranchRef>,
    pub artifact: ArtifactManifest,
    pub definitions: Vec<Definition<DefinitionBody>>,
    pub scopes: Vec<Scope>,
    pub basis: Vec<ReadDependency>,
    pub sources: Vec<SourceBasis>,
    pub read_receipts: Vec<ReadReceipt>,
    pub evaluations: Vec<EvaluationId>,
    pub published_at: Timestamp,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BranchRef {
    pub world: WorldRef,
    pub id: BranchId,
    pub revision: Revision,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseHead {
    pub world: WorldRef,
    pub channel: ChannelId,
    pub generation: Generation,
    pub revision: Revision,
    pub release_id: ReleaseId,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseHeadCas {
    pub world: WorldRef,
    pub channel: ChannelId,
    pub expected: Option<ReleaseHead>,
    pub next: ReleaseId,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MergeConflict {
    pub definition_id: DefinitionId,
    pub fields: Vec<FieldPath>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ReleaseFailure {
    BranchMissing {
        branch_id: BranchId,
    },
    ReleaseMissing {
        release_id: ReleaseId,
    },
    BranchConflict {
        branch_id: BranchId,
        expected: Revision,
        actual: Revision,
        fields: Vec<FieldPath>,
    },
    HeadConflict {
        channel: ChannelId,
        expected: Option<ReleaseHead>,
        actual: Option<ReleaseHead>,
    },
    MergeConflicts {
        conflicts: Vec<MergeConflict>,
    },
    BasisChanged {
        resources: Vec<ResourceRef>,
    },
    EvaluationRequired {
        suites: Vec<SuiteId>,
    },
    BackfillNotReady {
        release_id: ReleaseId,
        partitions: Vec<String>,
    },
    InvalidBranch {
        field: FieldPath,
    },
    InvalidArtifact {
        field: FieldPath,
    },
    EvaluationMissing {
        evaluation_id: EvaluationId,
    },
    EvaluationRejected {
        evaluation_id: EvaluationId,
    },
    BackfillFailed {
        release_id: ReleaseId,
        partition: String,
        failure: crate::sources::SourceFailure,
    },
    Authorization {
        failure: crate::authorization::AuthorizationFailure,
    },
    Compile {
        failure: crate::compiler::CompileFailure,
    },
    Commit {
        failure: crate::commit::CommitFailure,
    },
    Cancelled,
    InternalFault,
}
