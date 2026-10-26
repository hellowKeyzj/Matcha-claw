use crate::{
    expression::{ExpressionIr, TimeWindow},
    ids::*,
    sources::SourcePosition,
    time::{Timestamp, ValidTime},
    value::DirtyState,
};
use serde::{Deserialize, Serialize};

/// All premises in this group are AND; groups with the same conclusion are OR.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SupportSet {
    pub reference: SupportRef,
    pub conclusion: AssertionRef,
    pub rule: DefinitionRef,
    pub arguments: Vec<crate::query::QueryArgument>,
    pub scope: ScopeId,
    pub valid_time: ValidTime,
    pub release_id: ReleaseId,
    pub branch_id: Option<BranchId>,
    pub premises: Vec<PremiseRef>,
    pub status: SupportStatus,
    pub dirty: DirtyState,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    content = "reference",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum PremiseRef {
    Assertion(AssertionRef),
    Evidence(EvidenceRef),
    Read(ReadDependency),
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SupportStatus {
    Valid,
    Invalid,
    Pending,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ConclusionSupport {
    Supported {
        supports: Vec<SupportRef>,
    },
    Dirty {
        supports: Vec<SupportRef>,
        generation: Generation,
    },
    Unsupported,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ReadDependency {
    Assertion {
        reference: AssertionRef,
    },
    Evidence {
        reference: EvidenceRef,
    },
    Definition {
        reference: DefinitionRef,
    },
    Watch {
        id: WatchId,
        generation: Generation,
    },
    Source {
        position: SourcePosition,
        binding: DefinitionRef,
    },
    TimeBoundary {
        at: Timestamp,
    },
    Identity {
        subject: crate::identity::SubjectRef,
        revision: Revision,
    },
    AliasRange {
        digest: Digest,
        generation: Generation,
    },
    SourceMapping {
        mapping: MappingRef,
        identity_rule: IdentityRuleRef,
        authority: crate::sources::AuthorityRef,
        binding: DefinitionRef,
    },
    SourceField {
        schema: SchemaRef,
        field: SourceFieldId,
        value_type: crate::value::ValueType,
        nullable: bool,
        optional: bool,
        name: String,
    },
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueryWatch {
    pub world: WorldRef,
    pub id: WatchId,
    pub scope: ScopeId,
    pub selector: ExpressionIr,
    pub predicate_digest: Digest,
    pub purpose: WatchPurpose,
    pub window: Option<TimeWindow>,
    pub generation: Generation,
    pub coverage: WatchCoverage,
    pub query: crate::query::QueryIr,
    pub arguments: Vec<crate::query::QueryArgument>,
    pub datasets: Vec<DefinitionRef>,
    pub partitions: Vec<String>,
    pub visibility_digest: Digest,
    pub policy_epoch: PolicyEpoch,
    pub grant_epoch: GrantEpoch,
    pub next_boundary: Option<Timestamp>,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WatchPurpose {
    Membership,
    NotExists,
    Aggregate,
    TopK,
    TimeWindow,
    MissingField,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WatchCoverage {
    CompleteAuthorizedRange,
    Partial,
    Gap,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SupportSnapshot {
    pub assertions: Vec<AssertionRef>,
    pub evidence: Vec<EvidenceRef>,
    pub supports: Vec<SupportSet>,
    pub watches: Vec<QueryWatch>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SupportDeltaProposal {
    pub upserts: Vec<SupportSet>,
    pub invalidate: Vec<SupportRef>,
    pub affected_watches: Vec<WatchId>,
    pub observed_dependencies: Vec<ReadDependency>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExplanationGraph {
    pub conclusion: AssertionRef,
    pub revision: Revision,
    pub supports: Vec<SupportSet>,
    pub visible_evidence: Vec<EvidenceRef>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DirtyRecompute {
    pub conclusion: AssertionRef,
    pub generation: Generation,
    pub dependencies: Vec<ReadDependency>,
    pub fence: crate::commit::WriteFence,
    pub release_id: ReleaseId,
    pub branch_id: Option<BranchId>,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProvenanceLimit {
    ComponentNodes,
    AlternativeSupports,
    ProposalItems,
    QueryNodes,
    WatchPartitions,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProvenanceDependency {
    RuleEvaluationProof,
    ClosedWorldQueryProof,
    FieldCoverageProof,
    QueryReceipt,
    CurrentAuthorization,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ProvenanceFailure {
    DependencyMissing {
        dependency: ProvenanceDependency,
    },
    LimitExceeded {
        resource: ProvenanceLimit,
        #[serde(with = "crate::wire::u64_decimal")]
        #[schemars(with = "String")]
        limit: u64,
    },
    Dirty {
        watches: Vec<WatchId>,
    },
    Cancelled,
    CleanupFailed,
    UnclosedRange {
        watch_id: WatchId,
    },
    CyclicSupport {
        assertions: Vec<AssertionRef>,
    },
    MissingPremise,
    CrossScope,
    InvalidInterval,
    BasisChanged {
        watch_id: WatchId,
        expected: Generation,
        actual: Generation,
    },
    IncompleteNegativeRange,
    Commit {
        failure: crate::commit::CommitFailure,
    },
    InternalFault,
}
