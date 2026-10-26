use serde::{Deserialize, Serialize};
use std::{future::Future, pin::Pin, sync::Arc};
use world_protocol::{
    api::InvestigationSelection,
    budget::{Budget, BudgetDimension, Usage},
    expression::Effect,
    ids::*,
    learning::TaskRef,
    operation::OperationAccepted,
    time::Timestamp,
};

pub type InvestigationFuture<'a> = Pin<Box<dyn Future<Output = InvestigationReceipt> + Send + 'a>>;
pub type InvestigationSettlementFuture<'a> = Pin<Box<dyn Future<Output = Result<(), crate::NativeVerificationError>> + Send + 'a>>;

/// The selected native runtime owns admission, execution, metering and durable receipts.
pub trait WorldInvestigation: Send + Sync {
    fn execute<'a>(&'a self, request: InvestigationRequest) -> InvestigationFuture<'a>;
    fn inspect<'a>(&'a self, request: InvestigationRequest) -> InvestigationFuture<'a>;
    fn cancel<'a>(
        &'a self,
        request: InvestigationRequest,
        requested_at: Timestamp,
    ) -> InvestigationFuture<'a>;
    fn settle<'a>(&'a self, request: InvestigationRequest, settled_at: Timestamp) -> InvestigationSettlementFuture<'a>;
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InvestigationIdentity {
    pub selection: InvestigationSelection,
    pub binding_id: BindingId,
    pub native_request_id: String,
    pub task: TaskRef,
    pub operation: OperationAccepted,
    pub run_id: RunId,
    pub step_id: StepId,
    pub attempt: u32,
    pub case_id: CaseId,
    pub world_request_id: RequestId,
    /// Original Task input, not the native runtime's canonical request digest.
    pub input_digest: Digest,
    pub material_digest: Digest,
    pub content_budget_digest: Digest,
}

#[derive(Clone)]
pub struct InvestigationRequest {
    pub authority: Arc<crate::authorization::InvestigationBinding>,
    pub identity: InvestigationIdentity,
    pub execution_prompt: String,
    pub allowed_effects: Vec<Effect>,
    pub budget: Budget,
    pub created_at: Timestamp,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InvestigationAccepted {
    pub binding_id: BindingId,
    pub accepted_request_id: String,
    pub accepted_run_id: String,
    pub accepted_input_id: String,
    pub content_budget_digest: Digest,
    pub native_attempt_id: String,
    pub native_instance_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InvestigationReceipt {
    pub identity: InvestigationIdentity,
    pub state: InvestigationState,
    pub sentness: InvestigationSentness,
    pub accepted: Option<InvestigationAccepted>,
    pub usage: InvestigationUsage,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InvestigationSentness {
    NotSent,
    MayHaveSent,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum InvestigationState {
    Pending,
    Accepted,
    Terminal { status: InvestigationTerminal },
    Rejected { reason: InvestigationRejection },
    Unknown,
    Unavailable,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum InvestigationRejection {
    InvalidInput,
    SelectionChanged,
    RequestConflict,
    NoAgentTask,
    RuntimeRejected,
    StartRejected,
    UnsupportedBudget { dimensions: Vec<BudgetDimension> },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InvestigationTerminal {
    Completed,
    Cancelled,
    Failed,
    Interrupted,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum InvestigationUsage {
    Unavailable,
    /// Exact, complete, native-exclusive usage for the whole accepted input.
    /// Matcha may omit `cost` only without an original execution cost limit and with
    /// native/Integration proof that every original I/O uses fixed local-free producers
    /// and operations, all seven counters are checked sums with original elapsed,
    /// CLI failures are empty and pending work is zero. Stop, ownership and join are
    /// verified independently; missing-cost usage with unknown or paid I/O remains Unavailable.
    Complete {
        usage: Usage,
    },
}
