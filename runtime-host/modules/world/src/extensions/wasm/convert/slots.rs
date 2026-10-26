use super::*;

impl Wire for world_protocol::slots::SlotFailure {
    type Output = w::SlotFailure;
    fn lower(self) -> Result<Self::Output, WasmError> {
        component::SourceFailureArena::from_slot_failure(&self)?.lower()
    }
    fn lift(value: Self::Output) -> Result<Self, WasmError> {
        Ok(component::SourceFailureArena::lift(value)?.into_slot_failure()?)
    }
}
variant!(component::SlotFailureNode, SlotFailureNode; units []; tuples [Connector, Identity, Schema, Resolver, Projection, Provenance, Compiler, Policy, Action, Reconcile, Abstraction, Evaluation, Context, AgentBridge, Storage]; records []);
record!(world_protocol::slots::ResolveQueryRequest, ResolveQueryRequest; query, source_plans, budget);
record!(world_protocol::slots::PolicyEvaluationRequest, PolicyEvaluationRequest; world, impact, policies, scope_digest);
record!(world_protocol::slots::ActionPlanRequest, ActionPlanRequest; proposal, contract, basis);
record!(world_protocol::slots::ContextRequest, ContextRequest; world, task, query, budget);
record!(world_protocol::slots::AgentBridgeRequest, AgentBridgeRequest; peer, deadline);
record!(world_protocol::slots::StorageReadRequest, StorageReadRequest; world, resources, known_at);
record!(world_protocol::slots::ResolveQueryResult, ResolveQueryResult; page, actual_dependencies);
record!(world_protocol::slots::PolicyEvaluationResult, PolicyEvaluationResult; verdict, obligations, policies);
record!(world_protocol::slots::ActionPlanResult, ActionPlanResult; source_operation, arguments, dependencies, expected_effect);
record!(world_protocol::slots::ContextResult, ContextResult; view, receipt);
record!(world_protocol::slots::AgentBridgeResult, AgentBridgeResult; response, native_run_id);
record!(world_protocol::slots::StorageReadResult, StorageReadResult; assertions, definitions, evidence, revisions);
unit_enum!(world_protocol::slots::BridgeFailure, BridgeFailure; PrincipalInvalid, SessionUnavailable, RuntimeUnavailable, ProtocolMismatch, Timeout, Cancelled, InternalFault);
