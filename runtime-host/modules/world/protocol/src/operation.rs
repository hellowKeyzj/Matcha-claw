use crate::{commit::CommitReceipt, failure::Failure, ids::*, time::Timestamp};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationAccepted {
    pub world: WorldRef,
    pub operation_id: OperationId,
    pub revision: Revision,
    pub incarnation: Generation,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationKey {
    pub world: WorldRef,
    pub operation_id: OperationId,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CancelOperation {
    pub key: OperationKey,
    pub expected_revision: Revision,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResumeOperation {
    pub key: OperationKey,
    pub expected_revision: Revision,
    pub request_id: RequestId,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationReceipt {
    pub accepted: OperationAccepted,
    pub disclosure: ReceiptDisclosure,
    pub phase: OperationPhase,
    pub progress: OperationProgress,
    pub result: Option<OperationResult>,
    pub failure: Option<Failure<OperationFailure>>,
    pub commit: Option<CommitReceipt>,
    pub effects: Vec<crate::actions::SourceReceipt>,
    pub cancellation: CancellationState,
    pub updated_at: Timestamp,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ReceiptDisclosure {
    Full,
    Summary { withheld: Vec<ReceiptDetail> },
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ReceiptDetail {
    ProgressCounts,
    ResultDetails,
    FailureDetails,
    Effects,
    CommittedRevisions,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum OperationPhase {
    Accepted,
    Admitted,
    Running,
    WaitingApproval,
    WaitingDependency,
    Verifying,
    Committing,
    Draining,
    Completed,
    Failed,
    CancelledBeforeCommit,
    CancelledAfterCommit,
    CommitIndeterminate,
    EffectIndeterminate,
    Retained,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationProgress {
    pub stage: crate::failure::FailureStage,
    #[serde(with = "crate::wire::u64_decimal")]
    #[schemars(with = "String")]
    pub completed: u64,
    #[serde(with = "crate::wire::optional_u64_decimal")]
    #[schemars(with = "Option<String>")]
    pub total: Option<u64>,
    pub run_id: Option<RunId>,
    pub step_id: Option<StepId>,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CancellationState {
    NotRequested,
    Requested,
    Acknowledged,
    SettledBeforeEffect,
    SettledAfterEffect,
    Retained,
}
/// Counts are records within each kind, not bytes or a deduplicated cross-kind total.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RetainedCount {
    pub kind: RetainedKind,
    #[serde(with = "crate::wire::u64_decimal")]
    #[schemars(with = "String")]
    pub count: u64,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RetainedKind {
    Scopes,
    Releases,
    ActivationLocks,
    BusinessFacts,
    Authority,
    Execution,
    Effects,
    CommitReceipts,
    OutboxEvents,
    ContentBlobs,
    ContentReferences,
    ContentHolds,
    ContentPins,
    SourceVersions,
    ParseArtifacts,
    PackageInventory,
    PackageRetention,
    ExtensionState,
    Archives,
    DeletionBarriers,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolutionResult {
    pub case_id: CaseId,
    pub outcome: crate::learning::CaseOutcome,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    content = "result",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum OperationResult {
    Materials {
        source_versions: Vec<crate::materials::SourceVersionRef>,
        parse_artifacts: Vec<ParseArtifactId>,
        candidates: Vec<CandidateId>,
        drafts: Vec<crate::materials::MaterialDraftRef>,
    },
    Sync {
        binding: DefinitionRef,
        checkpoint: crate::sources::SourceCheckpoint,
    },
    Connection {
        connection: ConnectionId,
        revision: Revision,
    },
    Mapping {
        binding: DefinitionRef,
        mapping: MappingRef,
    },
    BranchSourceAuthority {
        branch: crate::releases::BranchRef,
        authority: crate::facts::SourceAuthority,
    },
    Schema(crate::sources::SchemaDiscovery),
    Facts {
        assertions: Vec<AssertionRef>,
    },
    RuleEvaluated {
        status: crate::provenance::SupportStatus,
        assertion: Option<AssertionRef>,
    },
    Reconciled {
        checkpoints: Vec<crate::sources::SourceCheckpoint>,
    },
    TestCase {
        test: crate::evaluation::TestRevision,
    },
    Suite {
        suite: crate::evaluation::SuiteRef,
    },
    Policy {
        scope: ScopeId,
        policy_id: PolicyId,
        revision: Revision,
    },
    Retention {
        scope: ScopeId,
        policy_id: PolicyId,
        revision: Revision,
    },
    Commit(CommitReceipt),
    Change(crate::learning::ChangeSet),
    Task(crate::learning::TaskSummary),
    Resolution(ResolutionResult),
    Candidate(crate::learning::Candidate),
    Proposal(crate::actions::ActionProposal),
    Approval(crate::authorization::ApprovalBinding),
    Action(Box<crate::actions::ActionStatus>),
    Evaluation(Box<crate::evaluation::EvaluationReport>),
    EvaluationSummary(crate::evaluation::EvaluationSummary),
    Package {
        install_id: InstallId,
        revision: Revision,
    },
    PackageTrust {
        package_digest: Digest,
        revision: Revision,
    },
    PackageTrustPolicy {
        revision: Revision,
    },
    Activation {
        heads: Vec<crate::bindings::BindingHead>,
    },
    Release {
        head: crate::releases::ReleaseHead,
    },
    Backup {
        manifest: crate::materials::BlobRef,
    },
    Restore {
        release_id: ReleaseId,
    },
    Delete {
        deleted: bool,
        retained: Vec<RetainedCount>,
    },
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    content = "failure",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum OperationFailure {
    DetailsWithheld,
    NotConfigured,
    NotFound,
    RevisionConflict,
    Input(crate::failure::InputFailure),
    Authorization(crate::authorization::AuthorizationFailure),
    Upload(crate::api::UploadFailure),
    Material(crate::materials::MaterialFailure),
    Source(crate::sources::SourceFailure),
    Mapping(crate::sources::MappingFailure),
    Query(crate::query::QueryFailure),
    Slot(crate::slots::SlotFailure),
    Identity(crate::identity::IdentityFailure),
    Fact(crate::facts::FactFailure),
    Definition(crate::definitions::DefinitionFailure),
    Release(crate::releases::ReleaseFailure),
    Compile(crate::compiler::CompileFailure),
    Learning(crate::learning::LearningFailure),
    Generation(crate::generation::GenerationFailure),
    BudgetExceeded {
        dimension: crate::budget::BudgetDimension,
    },
    Evaluation(crate::evaluation::EvaluationFailure),
    EvaluationSummary(crate::evaluation::EvaluationSummaryFailure),
    Action(crate::actions::ActionFailure),
    Package(crate::package::PackageFailure),
    Binding(crate::bindings::BindingFailure),
    State(crate::state::StateFailure),
    Lifecycle(crate::lifecycle::LifecycleFailure),
    Process(crate::process::ProcessFailure),
    Commit(crate::commit::CommitFailure),
    Cancelled,
    CleanupFailed,
    InternalFault,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CancelReceipt {
    pub receipt: OperationReceipt,
    pub settled: bool,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    content = "request",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum OperationRequest {
    Status(OperationKey),
    Result(OperationKey),
    Cancel(CancelOperation),
    Resume(ResumeOperation),
}
impl OperationRequest {
    pub fn world(&self) -> &WorldRef {
        match self {
            Self::Status(key) | Self::Result(key) => &key.world,
            Self::Cancel(request) => &request.key.world,
            Self::Resume(request) => &request.key.world,
        }
    }
}
crate::api::operation_names!(OperationRequest {
    Status => ("status", "operation.status"),
    Result => ("result", "operation.result"),
    Cancel => ("cancel", "operation.cancel"),
    Resume => ("resume", "operation.resume")
});
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    content = "result",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum OperationResponse {
    Status(OperationReceipt),
    Result(OperationReceipt),
    Cancel(CancelReceipt),
    Resume(OperationAccepted),
}
