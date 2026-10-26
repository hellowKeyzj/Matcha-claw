use crate::{ids::*, time::ValidTime};
use serde::{Deserialize, Serialize};
pub const SOURCE_KEY_REGISTRATION: &str = "identity.source-key.v1";
pub fn resolve_contract() -> Result<crate::sources::ContractRef, crate::schema::SchemaFailure> {
    crate::slots::slot_contract(crate::bindings::SlotKind::Identity)
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Object {
    pub world: WorldRef,
    pub id: ObjectId,
    pub type_id: DefinitionId,
}
/// Roles and existence belong exclusively to a RelationClaim assertion.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Relation {
    pub world: WorldRef,
    pub id: RelationId,
    pub type_id: DefinitionId,
}
#[derive(
    Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize, schemars::JsonSchema,
)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SubjectRef {
    Object { id: ObjectId },
    Relation { id: RelationId },
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceKey {
    pub world: WorldRef,
    pub source_id: SourceId,
    pub namespace: String,
    pub native_key: String,
    pub incarnation: String,
    pub valid_time: ValidTime,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceAlias {
    pub key: SourceKey,
    pub target: SubjectRef,
    pub revision: Revision,
    pub evidence: Vec<EvidenceRef>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum IdentityFailure {
    Ambiguous {
        candidates: Vec<SubjectRef>,
    },
    AliasConflict {
        key: SourceKey,
    },
    RevisionConflict {
        expected: Revision,
        actual: Revision,
    },
    OverlappingIncarnation {
        source_id: SourceId,
    },
    InvalidMerge,
    InvalidSplit,
    CrossWorld,
    ScopeConflict,
    InvalidInterval,
    UnresolvedIdentity {
        subject: SubjectRef,
    },
    UnresolvedType {
        reference: DefinitionRef,
    },
    TypeKindMismatch {
        reference: DefinitionRef,
    },
    PermissionDenied,
    Cancelled,
    CandidateScopeIncomplete,
    BasisChanged {
        resource: ResourceRef,
    },
    ImpactSetChanged,
    Commit {
        failure: crate::commit::CommitFailure,
    },
    InternalFault,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    content = "record",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum IdentityRecord {
    Object(Object),
    Relation(Relation),
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IdentitySnapshot {
    pub record: IdentityRecord,
    pub revision: Revision,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IdentityCandidate {
    pub identity: IdentitySnapshot,
    pub evidence: Vec<EvidenceRef>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IdentityResolveRequest {
    pub key: SourceKey,
    pub type_ref: DefinitionRef,
    pub candidates: Vec<IdentityCandidate>,
    pub scope: ScopeId,
    pub candidates_complete: bool,
    pub dependencies: Vec<crate::provenance::ReadDependency>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum IdentityProposal {
    Same {
        target: SubjectRef,
        evidence: Vec<EvidenceRef>,
    },
    New {
        type_ref: DefinitionRef,
        evidence: Vec<EvidenceRef>,
    },
    Ambiguous {
        candidates: Vec<SubjectRef>,
        evidence: Vec<EvidenceRef>,
    },
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IdentityReceipt {
    pub key: SourceKey,
    pub resolution: AliasResolution,
    pub scope: ScopeId,
    pub range_generation: Generation,
    pub dependencies: Vec<crate::provenance::ReadDependency>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum AliasResolution {
    Existing {
        identity: IdentitySnapshot,
        alias_revision: Revision,
        decisions: Vec<DecisionId>,
    },
    NotFound,
    Ambiguous {
        candidates: Vec<SubjectRef>,
        decisions: Vec<DecisionId>,
    },
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IdentityRemap {
    pub original: SubjectRef,
    pub replacements: Vec<SubjectRef>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IdentityAssertionReplacement {
    pub draft: crate::facts::ObservationDraft,
    pub supports: Option<crate::provenance::SupportDeltaProposal>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IdentityAssertionRemap {
    pub original: AssertionRef,
    pub replacements: Vec<IdentityAssertionReplacement>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IdentityChangeProposal {
    pub assertion_remapping: Vec<IdentityAssertionRemap>,
    pub world: WorldRef,
    pub operation: IdentityChangeKind,
    pub identities: Vec<IdentitySnapshot>,
    pub aliases: Vec<SourceAlias>,
    pub remapping: Vec<IdentityRemap>,
    pub affected_assertions: Vec<AssertionRef>,
    pub relation_claims: Vec<crate::facts::RelationClaim>,
    pub scope: ScopeId,
    pub valid_time: ValidTime,
    pub reason: String,
    pub evidence: Vec<EvidenceRef>,
    pub admission_id: DecisionId,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum IdentityChangeKind {
    Merge,
    Split,
}
