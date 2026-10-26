use crate::{budget::Budget, ids::*, materials::BlobRef, time::Timestamp, value::Value};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelBindingRef {
    pub id: ModelBindingId,
    pub revision: Revision,
    pub digest: Digest,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelBinding {
    pub reference: ModelBindingRef,
    pub account_id: String,
    pub model_id: String,
    pub selection_id: String,
    pub account_revision: Revision,
    pub provider_fingerprint: Digest,
    pub protocol: String,
    pub capability: String,
    pub parameters: GenerationParameters,
    pub capabilities: Option<ModelCapabilities>,
    pub remote_version_lock: RemoteVersionLock,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RemoteVersionLock {
    Unlocked,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GenerationParameters {
    pub temperature: Option<crate::value::Decimal>,
    pub top_p: Option<crate::value::Decimal>,
    #[serde(with = "crate::wire::optional_u64_decimal")]
    #[schemars(with = "Option<String>")]
    pub seed: Option<u64>,
    #[serde(with = "crate::wire::u64_decimal")]
    #[schemars(with = "String")]
    pub maximum_output_tokens: u64,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelCapabilities {
    pub structured_output: bool,
    pub tools: bool,
    pub images: bool,
    pub audio: bool,
    #[serde(with = "crate::wire::u64_decimal")]
    #[schemars(with = "String")]
    pub context_tokens: u64,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GenerationRequest {
    pub world: WorldRef,
    pub run_id: RunId,
    pub step_id: StepId,
    pub binding: ModelBindingRef,
    pub prompt: BlobRef,
    pub context: Vec<BlobRef>,
    pub result_schema: Digest,
    pub budget: Budget,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GenerationReceipt {
    pub id: ModelCallId,
    pub binding: ModelBindingRef,
    pub prompt_digest: Digest,
    pub context_digests: Vec<Digest>,
    pub output: Option<BlobRef>,
    pub value: Option<Value>,
    pub text: String,
    pub finish_reason: Option<String>,
    pub usage: Option<ModelUsage>,
    pub started_at: Timestamp,
    pub completed_at: Option<Timestamp>,
    pub actual_model: Option<String>,
    pub remote_revision: Option<String>,
    pub provider_call_reference: Option<String>,
    pub remote_call_reference: Option<String>,
    pub state: GenerationState,
    #[serde(with = "crate::wire::u64_decimal")]
    #[schemars(with = "String")]
    pub delivered_text_bytes: u64,
    pub delivery_uncertain: bool,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelUsage {
    #[serde(with = "crate::wire::optional_u64_decimal")]
    #[schemars(with = "Option<String>")]
    pub input_tokens: Option<u64>,
    #[serde(with = "crate::wire::optional_u64_decimal")]
    #[schemars(with = "Option<String>")]
    pub output_tokens: Option<u64>,
    #[serde(with = "crate::wire::optional_u64_decimal")]
    #[schemars(with = "Option<String>")]
    pub total_tokens: Option<u64>,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum GenerationState {
    Completed,
    Refused,
    Truncated,
    Partial,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum GenerationStage {
    Admission,
    Binding,
    Credential,
    Connect,
    Read,
    Output,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GenerationFailure {
    pub stage: GenerationStage,
    pub kind: GenerationFailureKind,
    pub receipt: Option<Box<GenerationReceipt>>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RetryAfter {
    Seconds {
        #[serde(with = "crate::wire::u64_decimal")]
        #[schemars(with = "String")]
        value: u64,
    },
    HttpDate {
        value: String,
    },
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum GenerationFailureKind {
    Authorization {
        failure: crate::authorization::AuthorizationFailure,
    },
    Commit {
        failure: crate::commit::CommitFailure,
    },
    Material {
        failure: crate::materials::MaterialFailure,
    },
    RunMismatch {
        run_id: RunId,
        step_id: StepId,
    },
    CallConflict {
        model_call_id: ModelCallId,
    },
    CallIndeterminate {
        model_call_id: ModelCallId,
    },
    UnsupportedParameter {
        parameter: String,
    },
    BindingStoreUnavailable,
    OwnerUnavailable,
    AuditUnavailable,
    BindingInvalid,
    BindingMissing {
        binding_id: ModelBindingId,
    },
    BindingStale,
    NoSelection,
    SelectionUnavailable,
    RemoteVersionUnlocked,
    UnsupportedProtocol,
    UnsupportedAuthentication,
    CredentialMissing,
    CredentialUnavailable,
    Authentication,
    PermissionDenied,
    RateLimited {
        retry_after: Option<RetryAfter>,
    },
    ConnectDeadline,
    ReadDeadline,
    GenerationDeadline,
    ConnectFailed,
    ReadFailed,
    ProviderRejected {
        status: Option<u16>,
    },
    ProviderUnavailable {
        status: Option<u16>,
    },
    ContextLimit,
    OutputLimit,
    StructuredOutputUnsupported,
    ToolUnsupported,
    MediaUnsupported,
    Refused,
    Truncated,
    InvalidOutput,
    SchemaMismatch {
        expected: Digest,
    },
    BudgetExceeded {
        dimension: crate::budget::BudgetDimension,
    },
    Cancelled,
    Sink,
    RemoteUnrecognized {
        status: Option<u16>,
    },
    InternalFault,
}
