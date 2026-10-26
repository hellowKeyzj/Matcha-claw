use crate::{
    expression::{Effect, ExpressionIr},
    ids::*,
    sources::ContractRef,
    time::{Timestamp, ValidTime},
};
use serde::{Deserialize, Serialize};

/// Trusted ingress facts, never a model/public request payload. Proofs and permits stay private.
#[derive(Clone, Debug, PartialEq, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Invocation {
    pub id: InvocationId,
    pub world: WorldRef,
    pub actor: Actor,
    pub delegation: Option<DelegationId>,
    pub agent_id: Option<AgentId>,
    pub task_id: Option<TaskId>,
    pub branch_id: Option<BranchId>,
    pub native_session_id: Option<NativeSessionId>,
    pub native_run_id: Option<NativeRunId>,
    pub audience: String,
    pub request_digest: Digest,
    pub deadline: Timestamp,
    pub replay_id: RequestId,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Actor {
    Human { id: ActorId },
    Service { id: ActorId },
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PolicyRef {
    pub policy_id: PolicyId,
    pub revision: Revision,
    pub contract: ContractRef,
    pub obligations: Vec<PolicyObligation>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PolicyRule {
    pub reference: PolicyRef,
    pub verdict: PolicyVerdict,
    pub access: Vec<AccessScope>,
    pub labels: Vec<String>,
    pub effects: Vec<Effect>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PolicyBinding {
    pub name: String,
    pub policy: PolicyRef,
    pub applies_to: Vec<ResourceRef>,
    pub scope: ScopeId,
    pub predicate: ExpressionIr,
    pub access: Vec<AccessMode>,
    pub labels: Vec<String>,
}
#[derive(
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
    Serialize,
    Deserialize,
    schemars::JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum AccessMode {
    Read,
    Write,
    Execute,
    Approve,
    Publish,
    Manage,
    Export,
    Delete,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccessScope {
    pub resources: Vec<ResourceRef>,
    pub fields: Vec<DefinitionRef>,
    pub modes: Vec<AccessMode>,
    pub scope: ScopeId,
    pub valid_time: Option<ValidTime>,
}
/// Constructed from resolved plans by the owner, not accepted as a model's authority claim.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActualImpact {
    pub access: Vec<AccessScope>,
    pub effects: Vec<Effect>,
    pub labels: Vec<String>,
    pub state: Vec<StateRef>,
    pub source_ids: Vec<SourceId>,
    pub digest: Digest,
}
#[derive(Clone, Debug, PartialEq, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AdmissionRequest {
    pub invocation: Invocation,
    pub impact: ActualImpact,
    pub policies: Vec<PolicyRef>,
    pub approval: Option<ApprovalBinding>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApprovalBinding {
    pub approval_id: ApprovalId,
    pub action_digest: Digest,
    pub impact_digest: Digest,
    pub contract: DefinitionRef,
    pub expires_at: Timestamp,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum PolicyObligation {
    Approval,
    Audit,
    Redact {
        fields: Vec<DefinitionId>,
    },
    Limit {
        #[serde(with = "crate::wire::u64_decimal")]
        #[schemars(with = "String")]
        maximum: u64,
    },
    RevalidateBeforeEffect,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Decision {
    pub id: DecisionId,
    pub invocation_id: InvocationId,
    pub impact_digest: Digest,
    pub verdict: PolicyVerdict,
    pub policy_epoch: PolicyEpoch,
    pub grant_epoch: GrantEpoch,
    pub evaluated_at: Timestamp,
    pub expires_at: Option<Timestamp>,
    pub obligations: Vec<PolicyObligation>,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PolicyVerdict {
    Allow,
    Deny,
    NeedsApproval,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum AuthorizationFailure {
    InvalidPrincipal,
    InvalidDelegation,
    InsufficientScope,
    Revoked,
    AudienceMismatch,
    RequestDigestMismatch,
    DeadlineExpired,
    Replay,
    ApprovalMissing,
    ApprovalExpired,
    ApprovalDigestMismatch,
    RequiredPolicyUnavailable {
        policy_id: PolicyId,
    },
    PolicyContractMismatch {
        contract_id: ContractId,
    },
    EpochChanged {
        policy_epoch: PolicyEpoch,
        grant_epoch: GrantEpoch,
    },
    ObligationUnsatisfied,
    InternalFault,
}
