use crate::{ids::*, time::DurationMs};
use serde::{Deserialize, Serialize};

/// Safe wire projection only; private causes remain in the owning module's diagnostics.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Failure<D> {
    pub code: String,
    pub stage: FailureStage,
    pub message: String,
    pub diagnostic_id: DiagnosticId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<OperationId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<RunId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step_id: Option<StepId>,
    pub details: D,
    pub recovery: Recovery,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum FailureStage {
    Decode,
    Admission,
    Read,
    Parse,
    Generate,
    Resolve,
    Validate,
    Compile,
    Prepare,
    Execute,
    Verify,
    Commit,
    Activate,
    Migrate,
    Drain,
    Stop,
    Recover,
    Disclose,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Recovery {
    None,
    CorrectInput {
        fields: Vec<FieldPath>,
    },
    Refresh,
    Rebase {
        current_revision: Revision,
    },
    SupplyDependency {
        contract_id: ContractId,
    },
    RestoreCredential {
        source_id: Option<SourceId>,
    },
    RetryRead {
        after: Option<DurationMs>,
    },
    ResumeOperation {
        operation_id: OperationId,
        after: Option<DurationMs>,
    },
    ReadCommit {
        commit_id: CommitId,
    },
    ReadTransfer {
        transfer_id: TransferId,
    },
    InspectEffect {
        operation_id: OperationId,
        step_id: StepId,
    },
    RequestEvidence {
        evidence: Vec<EvidenceRef>,
    },
    ManualReview,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(transparent)]
pub struct FieldPath(pub Vec<String>);

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum InputFailure {
    MissingField {
        field: FieldPath,
    },
    InvalidValue {
        field: FieldPath,
    },
    InvalidUnit {
        field: FieldPath,
    },
    LimitExceeded {
        limit: InputLimit,
        #[serde(with = "crate::wire::u64_decimal")]
        #[schemars(with = "String")]
        maximum: u64,
    },
    SchemaMismatch {
        contract_id: ContractId,
        expected: Digest,
    },
    UnresolvedReference {
        resource: ResourceRef,
    },
    UnknownField {
        field: FieldPath,
    },
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum InputLimit {
    Bytes,
    Depth,
    Items,
    StringLength,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InternalFault {
    pub diagnostic_id: DiagnosticId,
}
