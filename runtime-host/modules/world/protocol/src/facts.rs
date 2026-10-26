use crate::{
    identity::SubjectRef,
    ids::*,
    materials::{AccessPolicyRef, SourceAnchor, SourceVersionRef},
    sources::{AuthorityRef, RetentionPolicy, SourcePosition},
    time::{Timestamp, ValidTime},
    value::Value,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Assertion {
    pub reference: AssertionRef,
    pub scope: ScopeId,
    pub claim: Claim,
    pub polarity: Polarity,
    pub valid_time: ValidTime,
    pub recorded_at: Timestamp,
    pub superseded_at: Option<Timestamp>,
    pub status: AssertionStatus,
    pub origin: AssertionOrigin,
    pub evidence: Vec<EvidenceRef>,
    pub supersedes: Option<AssertionRef>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    content = "claim",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Claim {
    Attribute(AttributeClaim),
    Relation(RelationClaim),
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Polarity {
    Positive,
    Negative,
}
/// An observation proposes a claim. It does not assign an assertion revision or grant authority.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObservationDraft {
    pub claim: Claim,
    pub polarity: Polarity,
    pub scope: ScopeId,
    pub valid_time: ValidTime,
    pub observed_at: Timestamp,
    pub origin: AssertionOrigin,
    pub evidence: Vec<EvidenceRef>,
    pub supersedes: Option<AssertionRef>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceAuthority {
    pub incarnation: String,
    pub world: WorldRef,
    pub source_id: SourceId,
    pub binding: DefinitionRef,
    pub authority: AuthorityRef,
    pub scope: ScopeId,
    pub valid_time: ValidTime,
    pub recorded_at: Timestamp,
    pub ownership: AuthorityOwnership,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum AuthorityOwnership {
    Properties {
        properties: Vec<DefinitionRef>,
    },
    RelationRoles {
        relation_type: DefinitionRef,
        roles: Vec<RoleId>,
    },
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttributeClaim {
    pub subject: SubjectRef,
    pub property: DefinitionRef,
    pub value: Value,
}
/// A complete role group is one claim; never independently upsert individual endpoints.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RelationClaim {
    pub relation_id: RelationId,
    pub relation_type: DefinitionRef,
    pub roles: Vec<RoleBinding>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoleBinding {
    pub role: RoleId,
    pub object_id: ObjectId,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AssertionStatus {
    Candidate,
    Accepted,
    Rejected,
    Withdrawn,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum AssertionOrigin {
    Source {
        binding: DefinitionRef,
        authority: AuthorityRef,
        position: Option<SourcePosition>,
    },
    Derived {},
    HumanObservation {
        invocation_id: InvocationId,
    },
    Extraction {
        run_id: RunId,
        model_call_id: Option<ModelCallId>,
    },
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Evidence {
    pub reference: EvidenceRef,
    pub locator: EvidenceLocator,
    pub digest: Option<Digest>,
    pub origin_family: OriginFamilyId,
    pub derived_from: Vec<EvidenceRef>,
    pub observed_at: Timestamp,
    pub authority: Option<AuthorityRef>,
    pub access: AccessPolicyRef,
    pub retention: RetentionPolicy,
    pub status: EvidenceStatus,
    pub availability: EvidenceAvailability,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvidenceLocator {
    pub source_version: SourceVersionRef,
    pub parse_artifact_id: Option<ParseArtifactId>,
    pub anchor: SourceAnchor,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceStatus {
    Active,
    Withdrawn,
    ContentDeleted,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceAvailability {
    Available,
    Unavailable,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum FactFailure {
    Compilation {
        failure: crate::compiler::CompileFailure,
    },
    Provenance {
        failure: crate::provenance::ProvenanceFailure,
    },
    SourceMapping {
        failure: crate::sources::MappingFailure,
    },
    MissingDefinition {
        reference: DefinitionRef,
    },
    MissingSubject {
        subject: SubjectRef,
    },
    TypeMismatch {
        field: crate::failure::FieldPath,
    },
    UnitMismatch {
        field: crate::failure::FieldPath,
    },
    NullNotAllowed {
        property: DefinitionRef,
    },
    InvalidRoleGroup {
        relation_type: DefinitionRef,
    },
    ScopeMismatch,
    ValidTimeMismatch,
    CrossWorld,
    EvidenceMissing {
        reference: EvidenceRef,
    },
    EvidenceIncomplete {
        reference: EvidenceRef,
    },
    SourceAuthorityDenied {
        binding: DefinitionRef,
    },
    RevisionConflict {
        expected: Revision,
        actual: Revision,
    },
    Structural {
        field: crate::failure::FieldPath,
    },
    SourceCapabilityMissing {
        capability: crate::sources::SourceCapability,
    },
    InvalidEvidenceLocator {
        reference: EvidenceRef,
    },
    EvidenceCycle {
        references: Vec<EvidenceRef>,
    },
    AccessDenied,
    InvalidRecordedTime,
    EvidenceUnavailable {
        reference: EvidenceRef,
    },
    EvidenceDeleted {
        reference: EvidenceRef,
    },
    Cancelled,
    SupersedesMismatch {
        expected: AssertionRef,
    },
    Commit {
        failure: crate::commit::CommitFailure,
    },
    InternalFault,
}
