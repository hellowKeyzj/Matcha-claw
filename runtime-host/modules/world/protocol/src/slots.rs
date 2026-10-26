//! Algorithm proposals only. Trusted storage, authorization roots and effect execution are not guest imports.
use crate::{
    budget::Budget,
    facts::{Assertion, ObservationDraft},
    ids::*,
    provenance::ReadDependency,
    query::{FieldCell, ReadReceipt},
    sources::{SourceBasis, SourceReadPlan},
};
use serde::{Deserialize, Serialize};

pub const SCHEMA_REGISTRATION: &str = "schema.definition.v1";
pub const COMPILER_REGISTRATION: &str = "compiler.checked-ir.v1";
pub const PROVENANCE_REGISTRATION: &str = "provenance.support.v1";
pub const ACTION_REGISTRATION: &str = "action.plan.v1";
pub const EVALUATION_REGISTRATION: &str = "evaluation.oracle.v1";
pub const POLICY_REGISTRATION: &str = "policy.current.v1";
pub const PROJECTION_REGISTRATION: &str = "projection.assertions.v1";
pub const RECONCILE_REGISTRATION: &str = "reconcile.assertions.v1";
pub const STORAGE_REGISTRATION: &str = "storage.postgres.v1";
pub const RESOLVER_REGISTRATION: &str = "resolver.query.v1";
pub const CONTEXT_REGISTRATION: &str = "context.world-view.v1";
pub const ABSTRACTION_REGISTRATION: &str = "abstraction.contract.v1";
pub const AGENT_BRIDGE_REGISTRATION: &str = "agent-bridge.native-query.v1";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectionRequest {
    pub world: WorldRef,
    pub release_id: ReleaseId,
    pub definitions: Vec<crate::definitions::Definition<crate::definitions::DefinitionBody>>,
    pub scopes: Vec<crate::definitions::Scope>,
    pub scope: ScopeId,
    pub valid_time: crate::time::ValidTime,
    pub known_at: Option<crate::time::Timestamp>,
    pub cells: Vec<ProjectedCell>,
    pub fixed: Vec<ProjectedCell>,
    pub assertions: Vec<Assertion>,
    pub sources: Vec<ProjectionSourceWitness>,
    pub basis: Vec<SourceBasis>,
    pub dependencies: Vec<ReadDependency>,
    pub budget: Budget,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectionResult {
    pub cells: Vec<ProjectedCell>,
    pub dependencies: Vec<ReadDependency>,
    pub diagnostics: Vec<crate::compiler::CompileDiagnostic>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectedCell {
    pub subject: crate::identity::SubjectRef,
    pub field: FieldCell,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectionSourceWitness {
    pub basis: SourceBasis,
    pub cell: ProjectedCell,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReconcileRequest {
    pub world: WorldRef,
    pub release_id: ReleaseId,
    pub definitions: Vec<crate::definitions::Definition<crate::definitions::DefinitionBody>>,
    pub scopes: Vec<crate::definitions::Scope>,
    pub scope: ScopeId,
    pub valid_time: crate::time::ValidTime,
    pub known_at: Option<crate::time::Timestamp>,
    pub cells: Vec<ProjectedCell>,
    pub fixed: Vec<ProjectedCell>,
    pub assertions: Vec<Assertion>,
    pub sources: Vec<ProjectionSourceWitness>,
    pub basis: Vec<SourceBasis>,
    pub dependencies: Vec<ReadDependency>,
    pub budget: Budget,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReconcileResult {
    pub selected: Vec<AssertionRef>,
    pub conflicts: Vec<ProjectedCell>,
    pub observations: Vec<ObservationDraft>,
    pub dependencies: Vec<ReadDependency>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OracleRequest {
    pub world: WorldRef,
    pub test_case_id: TestCaseId,
    pub fixture: Vec<u8>,
    pub expected: Vec<u8>,
    pub observed: Vec<u8>,
    pub queries: Vec<OracleQueryObservation>,
    pub budget: Budget,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OracleQueryObservation {
    pub step_id: StepId,
    pub page: crate::query::QueryPage,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OracleFieldExpectation {
    pub step_id: StepId,
    pub subject: crate::identity::SubjectRef,
    pub property: DefinitionRef,
    pub cell: crate::value::Cell,
    pub evidence: Vec<EvidenceRef>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OracleExpected {
    pub fields: Vec<OracleFieldExpectation>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OracleResult {
    pub passed: bool,
    pub evidence: Vec<EvidenceRef>,
    pub diagnostics: Vec<crate::compiler::CompileDiagnostic>,
    #[serde(with = "crate::wire::optional_u64_decimal")]
    #[schemars(with = "Option<String>")]
    pub evidence_satisfied: Option<u64>,
    #[serde(with = "crate::wire::optional_u64_decimal")]
    #[schemars(with = "Option<String>")]
    pub evidence_required: Option<u64>,
    #[serde(with = "crate::wire::optional_u64_decimal")]
    #[schemars(with = "Option<String>")]
    pub conflicts_detected: Option<u64>,
    #[serde(with = "crate::wire::optional_u64_decimal")]
    #[schemars(with = "Option<String>")]
    pub conflicts_present: Option<u64>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ProjectionFailure {
    InvalidInput { field: crate::failure::FieldPath },
    BasisChanged,
    BudgetExceeded,
    Cancelled,
    InternalFault,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ReconcileFailure {
    InvalidInput { field: crate::failure::FieldPath },
    AuthorityMissing,
    BasisChanged,
    BudgetExceeded,
    Cancelled,
    InternalFault,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum OracleFailure {
    BadFixture,
    SchemaMismatch,
    Unavailable,
    BudgetExceeded,
    Cancelled,
    InternalFault,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolveQueryRequest {
    pub query: crate::query::QueryRequest,
    pub source_plans: Vec<SourceReadPlan>,
    pub budget: Budget,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolveQueryResult {
    pub page: crate::query::QueryPage,
    pub actual_dependencies: Vec<ReadDependency>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextRequest {
    pub world: WorldRef,
    pub task: crate::learning::TaskContract,
    pub query: crate::query::QueryRequest,
    pub budget: Budget,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextResult {
    pub view: crate::abstraction::WorldView,
    pub receipt: ReadReceipt,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentBridgeRequest {
    pub peer: crate::api::PeerRequest,
    pub deadline: crate::time::Timestamp,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentBridgeResult {
    pub response: crate::api::PeerResponse,
    pub native_run_id: Option<NativeRunId>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StorageReadRequest {
    pub world: WorldRef,
    pub resources: Vec<ResourceRef>,
    pub known_at: Option<crate::time::Timestamp>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StorageReadResult {
    pub assertions: Vec<Assertion>,
    pub definitions: Vec<crate::definitions::Definition<crate::definitions::DefinitionBody>>,
    pub evidence: Vec<crate::facts::Evidence>,
    pub revisions: Vec<crate::commit::CommittedRevision>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    content = "request",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SlotRequest {
    Connector(SourceReadPlan),
    ConnectorDiscover(crate::sources::SourceSchemaRequest),
    Identity(crate::identity::IdentityResolveRequest),
    Schema(crate::compiler::CompileRequest),
    SchemaKind(crate::definitions::KindRequest),
    Resolver(ResolveQueryRequest),
    Projection(ProjectionRequest),
    Provenance(crate::provenance::SupportSnapshot),
    Compiler(crate::compiler::CompilerPassRequest),
    Policy(PolicyEvaluationRequest),
    Action(ActionPlanRequest),
    Reconcile(ReconcileRequest),
    Abstraction(crate::abstraction::AbstractionRequest),
    Evaluation(OracleRequest),
    Context(ContextRequest),
    AgentBridge(AgentBridgeRequest),
    Storage(StorageReadRequest),
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    content = "result",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SlotResponse {
    Connector(crate::sources::SourcePage),
    ConnectorDiscover(crate::sources::SchemaObservation),
    Identity(crate::identity::IdentityProposal),
    Schema(crate::compiler::TypedIr),
    SchemaKind(crate::definitions::KindResponse),
    Resolver(ResolveQueryResult),
    Projection(ProjectionResult),
    Provenance(crate::provenance::SupportDeltaProposal),
    Compiler(crate::compiler::CompilerPassResult),
    Policy(PolicyEvaluationResult),
    Action(ActionPlanResult),
    Reconcile(ReconcileResult),
    Abstraction(crate::abstraction::AbstractionContract),
    Evaluation(OracleResult),
    Context(ContextResult),
    AgentBridge(AgentBridgeResult),
    Storage(StorageReadResult),
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PolicyEvaluationRequest {
    pub world: WorldRef,
    pub impact: crate::authorization::ActualImpact,
    pub policies: Vec<crate::authorization::PolicyRef>,
    pub scope_digest: Digest,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PolicyEvaluationResult {
    pub verdict: crate::authorization::PolicyVerdict,
    pub obligations: Vec<crate::authorization::PolicyObligation>,
    pub policies: Vec<crate::authorization::PolicyRef>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActionPlanRequest {
    pub proposal: crate::actions::ActionProposal,
    pub contract: crate::definitions::Definition<crate::actions::ActionContract>,
    pub basis: Vec<ReadReceipt>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActionPlanResult {
    pub source_operation: crate::actions::SourceOperation,
    pub arguments: Vec<crate::query::QueryArgument>,
    pub dependencies: Vec<ReadDependency>,
    pub expected_effect: crate::expression::ExpressionIr,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    content = "failure",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SlotFailure {
    Connector(crate::sources::SourceFailure),
    Identity(crate::identity::IdentityFailure),
    Schema(crate::compiler::CompileFailure),
    Resolver(crate::query::QueryFailure),
    Projection(ProjectionFailure),
    Provenance(crate::provenance::ProvenanceFailure),
    Compiler(crate::compiler::CompileFailure),
    Policy(crate::authorization::AuthorizationFailure),
    Action(crate::actions::ActionFailure),
    Reconcile(ReconcileFailure),
    Abstraction(crate::abstraction::AbstractionFailure),
    Evaluation(OracleFailure),
    Context(crate::abstraction::ContextFailure),
    AgentBridge(BridgeFailure),
    Storage(crate::commit::CommitFailure),
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum BridgeFailure {
    PrincipalInvalid,
    SessionUnavailable,
    RuntimeUnavailable,
    ProtocolMismatch,
    Timeout,
    Cancelled,
    InternalFault,
}
pub fn projection_contract() -> Result<crate::sources::ContractRef, crate::schema::SchemaFailure> {
    slot_contract(crate::bindings::SlotKind::Projection)
}
pub fn reconcile_contract() -> Result<crate::sources::ContractRef, crate::schema::SchemaFailure> {
    slot_contract(crate::bindings::SlotKind::Reconcile)
}
pub fn evaluation_contract() -> Result<crate::sources::ContractRef, crate::schema::SchemaFailure> {
    slot_contract(crate::bindings::SlotKind::Evaluation)
}

pub fn discover_port() -> Result<crate::bindings::MethodPort, crate::schema::SchemaFailure> {
    let contract = crate::sources::discover_contract()?;
    Ok(crate::bindings::MethodPort {
        name: contract.id.to_string(),
        contract,
        request_schema: crate::schema::digest::<crate::sources::SourceSchemaRequest>()?,
        result_schema: crate::schema::digest::<crate::sources::SchemaObservation>()?,
        direction: crate::bindings::PortDirection::Export,
        required: true,
    })
}

pub fn kind_schema_port(declaration: &crate::package::PackageContract) -> crate::bindings::MethodPort {
    crate::bindings::MethodPort {
        name: declaration.reference.id.to_string(),
        contract: declaration.reference.clone(),
        request_schema: declaration.request_schema.digest.clone(),
        result_schema: declaration.result_schema.digest.clone(),
        direction: crate::bindings::PortDirection::Export,
        required: true,
    }
}

pub fn kind_port(
    contract: &crate::sources::ContractRef,
) -> Result<crate::bindings::MethodPort, crate::schema::SchemaFailure> {
    use crate::{compiler::CompileFailure, definitions::{KindRequest, KindResponse}};
    if contract.schema_digest
        != crate::schema::digest::<crate::schema::MethodSchema<KindRequest, KindResponse, CompileFailure>>()?
    {
        return Err(crate::schema::SchemaFailure);
    }
    Ok(crate::bindings::MethodPort {
        name: contract.id.to_string(),
        contract: contract.clone(),
        request_schema: crate::schema::digest::<KindRequest>()?,
        result_schema: crate::schema::digest::<KindResponse>()?,
        direction: crate::bindings::PortDirection::Export,
        required: true,
    })
}

macro_rules! slot_methods {
    ($($slot:ident => ($id:literal, $request:ty, $response:ty, $failure:ty)),+ $(,)?) => {
        pub fn request_slot(request: &SlotRequest) -> crate::bindings::SlotKind {
            match request {
                SlotRequest::ConnectorDiscover(_) => crate::bindings::SlotKind::Connector,
                SlotRequest::SchemaKind(_) => crate::bindings::SlotKind::Schema,
                $(SlotRequest::$slot(_) => crate::bindings::SlotKind::$slot),+
            }
        }
        pub fn response_slot(response: &SlotResponse) -> crate::bindings::SlotKind {
            match response {
                SlotResponse::ConnectorDiscover(_) => crate::bindings::SlotKind::Connector,
                SlotResponse::SchemaKind(_) => crate::bindings::SlotKind::Schema,
                $(SlotResponse::$slot(_) => crate::bindings::SlotKind::$slot),+
            }
        }
        pub fn failure_slot(failure: &SlotFailure) -> crate::bindings::SlotKind {
            match failure { $(SlotFailure::$slot(_) => crate::bindings::SlotKind::$slot),+ }
        }
        pub fn slot_contract(slot: crate::bindings::SlotKind) -> Result<crate::sources::ContractRef, crate::schema::SchemaFailure> {
            match slot { $(crate::bindings::SlotKind::$slot => crate::schema::method::<$request, $response, $failure>($id)),+ }
        }
        pub fn slot_port(slot: crate::bindings::SlotKind) -> Result<crate::bindings::MethodPort, crate::schema::SchemaFailure> {
            let contract = slot_contract(slot)?;
            let (request_schema, result_schema) = match slot { $(crate::bindings::SlotKind::$slot => (crate::schema::digest::<$request>()?, crate::schema::digest::<$response>()?)),+ };
            Ok(crate::bindings::MethodPort { name: contract.id.to_string(), contract, request_schema, result_schema, direction: crate::bindings::PortDirection::Export, required: true })
        }
        pub fn request_contract(request: &SlotRequest) -> Result<crate::sources::ContractRef, crate::schema::SchemaFailure> {
            match request {
                SlotRequest::ConnectorDiscover(_) => crate::sources::discover_contract(),
                SlotRequest::SchemaKind(request) => kind_port(request.contract()).map(|port| port.contract),
                _ => slot_contract(request_slot(request)),
            }
        }
        pub fn request_port(request: &SlotRequest) -> Result<crate::bindings::MethodPort, crate::schema::SchemaFailure> {
            match request {
                SlotRequest::ConnectorDiscover(_) => discover_port(),
                SlotRequest::SchemaKind(request) => kind_port(request.contract()),
                _ => slot_port(request_slot(request)),
            }
        }
        pub fn response_contract(response: &SlotResponse) -> Result<crate::sources::ContractRef, crate::schema::SchemaFailure> {
            match response {
                SlotResponse::ConnectorDiscover(_) => crate::sources::discover_contract(),
                SlotResponse::SchemaKind(response) => kind_port(&response.contract).map(|port| port.contract),
                _ => slot_contract(response_slot(response)),
            }
        }
        pub fn response_port(response: &SlotResponse) -> Result<crate::bindings::MethodPort, crate::schema::SchemaFailure> {
            match response {
                SlotResponse::ConnectorDiscover(_) => discover_port(),
                SlotResponse::SchemaKind(response) => kind_port(&response.contract),
                _ => slot_port(response_slot(response)),
            }
        }
    };
}
slot_methods! {
    Connector => ("source.read", SourceReadPlan, crate::sources::SourcePage, crate::sources::SourceFailure),
    Identity => ("identity.resolve", crate::identity::IdentityResolveRequest, crate::identity::IdentityProposal, crate::identity::IdentityFailure),
    Schema => ("schema.compile", crate::compiler::CompileRequest, crate::compiler::TypedIr, crate::compiler::CompileFailure),
    Resolver => ("resolver.resolve", ResolveQueryRequest, ResolveQueryResult, crate::query::QueryFailure),
    Projection => ("projection.project", ProjectionRequest, ProjectionResult, ProjectionFailure),
    Provenance => ("provenance.recompute", crate::provenance::SupportSnapshot, crate::provenance::SupportDeltaProposal, crate::provenance::ProvenanceFailure),
    Compiler => ("compiler.compile", crate::compiler::CompilerPassRequest, crate::compiler::CompilerPassResult, crate::compiler::CompileFailure),
    Policy => ("policy.evaluate", PolicyEvaluationRequest, PolicyEvaluationResult, crate::authorization::AuthorizationFailure),
    Action => ("action.plan", ActionPlanRequest, ActionPlanResult, crate::actions::ActionFailure),
    Reconcile => ("reconcile.reconcile", ReconcileRequest, ReconcileResult, ReconcileFailure),
    Abstraction => ("abstraction.abstract", crate::abstraction::AbstractionRequest, crate::abstraction::AbstractionContract, crate::abstraction::AbstractionFailure),
    Evaluation => ("evaluation.evaluate", OracleRequest, OracleResult, OracleFailure),
    Context => ("context.build", ContextRequest, ContextResult, crate::abstraction::ContextFailure),
    AgentBridge => ("agent-bridge.dispatch", AgentBridgeRequest, AgentBridgeResult, BridgeFailure),
    Storage => ("storage.read", StorageReadRequest, StorageReadResult, crate::commit::CommitFailure),
}
