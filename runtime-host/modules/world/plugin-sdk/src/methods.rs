use crate::protocol::{
    abstraction::{AbstractionContract, AbstractionFailure, AbstractionRequest, ContextFailure},
    actions::ActionFailure,
    authorization::AuthorizationFailure,
    commit::CommitFailure,
    compiler::{CompileFailure, CompileRequest, CompilerPassRequest, CompilerPassResult, TypedIr},
    identity::{IdentityFailure, IdentityProposal, IdentityResolveRequest},
    provenance::{ProvenanceFailure, SupportDeltaProposal, SupportSnapshot},
    query::QueryFailure,
    slots::{
        ActionPlanRequest, ActionPlanResult, AgentBridgeRequest, AgentBridgeResult, BridgeFailure,
        ContextRequest, ContextResult, OracleFailure, OracleRequest, OracleResult,
        PolicyEvaluationRequest, PolicyEvaluationResult, ProjectionFailure, ProjectionRequest,
        ProjectionResult, ReconcileFailure, ReconcileRequest, ReconcileResult, ResolveQueryRequest,
        ResolveQueryResult, StorageReadRequest, StorageReadResult,
    },
    sources::{SourceFailure, SourcePage, SourceReadPlan},
};

// Named, closed contracts; implementing a proposal method never grants the corresponding authority.
macro_rules! method {
    ($trait:ident, $method:ident, $request:ty, $response:ty, $failure:ty) => {
        pub trait $trait {
            fn $method(&mut self, request: $request) -> Result<$response, $failure>;
        }
    };
}

pub trait Connector {
    fn read(&mut self, request: SourceReadPlan) -> Result<SourcePage, SourceFailure>;
    fn discover(
        &mut self,
        _request: crate::protocol::sources::SourceSchemaRequest,
    ) -> Result<crate::protocol::sources::SchemaObservation, SourceFailure> {
        Err(SourceFailure::CapabilityMissing {
            capability: crate::protocol::sources::SourceCapability::SchemaDiscovery,
        })
    }
}
method!(
    Identity,
    resolve_identity,
    IdentityResolveRequest,
    IdentityProposal,
    IdentityFailure
);
pub trait Schema {
    fn compile(&mut self, request: CompileRequest) -> Result<TypedIr, CompileFailure>;
    fn kind(
        &mut self,
        request: crate::protocol::definitions::KindRequest,
    ) -> Result<crate::protocol::definitions::KindResponse, CompileFailure>;
}
method!(
    Resolver,
    resolve_query,
    ResolveQueryRequest,
    ResolveQueryResult,
    QueryFailure
);
method!(
    Projection,
    project,
    ProjectionRequest,
    ProjectionResult,
    ProjectionFailure
);
method!(
    Provenance,
    propagate,
    SupportSnapshot,
    SupportDeltaProposal,
    ProvenanceFailure
);
method!(
    Compiler,
    compile,
    CompilerPassRequest,
    CompilerPassResult,
    CompileFailure
);
method!(
    Policy,
    evaluate_policy,
    PolicyEvaluationRequest,
    PolicyEvaluationResult,
    AuthorizationFailure
);
method!(
    Action,
    plan_action,
    ActionPlanRequest,
    ActionPlanResult,
    ActionFailure
);
method!(
    Reconcile,
    reconcile,
    ReconcileRequest,
    ReconcileResult,
    ReconcileFailure
);
method!(
    Abstraction,
    abstract_task,
    AbstractionRequest,
    AbstractionContract,
    AbstractionFailure
);
method!(
    Evaluation,
    evaluate,
    OracleRequest,
    OracleResult,
    OracleFailure
);
method!(
    Context,
    build_context,
    ContextRequest,
    ContextResult,
    ContextFailure
);
method!(
    AgentBridge,
    bridge,
    AgentBridgeRequest,
    AgentBridgeResult,
    BridgeFailure
);
method!(
    Storage,
    read_storage,
    StorageReadRequest,
    StorageReadResult,
    CommitFailure
);
