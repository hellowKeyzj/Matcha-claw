use wasm_host::{CallState, wasmtime};
use world_protocol::{
    slots::{SlotFailure, SlotRequest, SlotResponse},
    *,
};

use super::{WasmError, convert::Wire, host::InvocationHost, prepared::Endpoint};
use crate::store::StoreFuture;

macro_rules! invoke_slots {
    ($($endpoint:ident::$slot:ident => (
        $module:ident::$pre:ident, $request:ty, $accessor:ident, $method:ident,
        $response:ty, $failure_variant:ident, $failure:ty
    )),+ $(,)?) => {
        pub(super) fn invoke<'a>(
            prepared: &'a super::PreparedWasm,
            store: &'a mut wasmtime::Store<CallState<InvocationHost>>,
            request: SlotRequest,
        ) -> StoreFuture<'a, Result<SlotResponse, SlotFailure>, WasmError> {
            match (&prepared.endpoint, request) {
                $((Endpoint::$endpoint(pre), SlotRequest::$slot(request)) => {
                    // Keep each typed future's construction out of the shared selector frame.
                    #[inline(never)]
                    fn execute_slot<'a>(
                        pre: &'a super::bindings::$module::$pre<CallState<InvocationHost>>,
                        store: &'a mut wasmtime::Store<CallState<InvocationHost>>,
                        request: $request,
                    ) -> StoreFuture<'a, Result<SlotResponse, SlotFailure>, WasmError> {
                        Box::pin(async move {
                            let wire = request.clone().lower()?;
                            let instance = pre.instantiate_async(&mut *store).await.map_err(super::call::instantiate)?;
                            let result = instance.$accessor().$method(&mut *store, &wire).await.map_err(super::call::call)?;
                            let result: Result<$response, $failure> = Wire::lift(result)?;
                            let result = result.map(SlotResponse::$slot).map_err(SlotFailure::$failure_variant);
                            if let Ok(SlotResponse::Connector(page)) = &result {
                                store.data().host().context.budget()
                                    .charge(budget::BudgetDimension::Rows, page.rows.len() as u64)?;
                            }
                            if let Ok(value) = &result {
                                super::validate::response(&store.data().host().context, &SlotRequest::$slot(request), value).await?;
                            }
                            super::call::account(store, &result, delivered(&result)).await?;
                            Ok(result)
                        })
                    }
                    execute_slot(pre, store, request)
                }),+
                _ => Box::pin(async { Err(WasmError::EntrypointUnsupported) }),
            }
        }
    };
}
invoke_slots! {
    Connector::ConnectorDiscover => (
        connector::ConnectorPluginPre, sources::SourceSchemaRequest, matcha_world_connector, call_discover,
        sources::SchemaObservation, Connector, sources::SourceFailure
    ),
    Schema::SchemaKind => (
        schema::SchemaPluginPre, definitions::KindRequest, matcha_world_schema, call_kind,
        definitions::KindResponse, Schema, compiler::CompileFailure
    ),
    Connector::Connector => (
        connector::ConnectorPluginPre, sources::SourceReadPlan, matcha_world_connector, call_read,
        sources::SourcePage, Connector, sources::SourceFailure
    ),
    Identity::Identity => (
        identity::IdentityPluginPre, identity::IdentityResolveRequest, matcha_world_identity, call_resolve,
        identity::IdentityProposal, Identity, identity::IdentityFailure
    ),
    Schema::Schema => (
        schema::SchemaPluginPre, compiler::CompileRequest, matcha_world_schema, call_compile,
        compiler::TypedIr, Schema, compiler::CompileFailure
    ),
    Resolver::Resolver => (
        resolver::ResolverPluginPre, slots::ResolveQueryRequest, matcha_world_resolver, call_resolve,
        slots::ResolveQueryResult, Resolver, query::QueryFailure
    ),
    Projection::Projection => (
        projection::ProjectionPluginPre, slots::ProjectionRequest, matcha_world_projection, call_project,
        slots::ProjectionResult, Projection, slots::ProjectionFailure
    ),
    Provenance::Provenance => (
        provenance::ProvenancePluginPre, provenance::SupportSnapshot, matcha_world_provenance, call_recompute,
        provenance::SupportDeltaProposal, Provenance, provenance::ProvenanceFailure
    ),
    Compiler::Compiler => (
        compiler::CompilerPluginPre, compiler::CompilerPassRequest, matcha_world_compiler, call_compile,
        compiler::CompilerPassResult, Compiler, compiler::CompileFailure
    ),
    Policy::Policy => (
        policy::PolicyPluginPre, slots::PolicyEvaluationRequest, matcha_world_policy, call_evaluate,
        slots::PolicyEvaluationResult, Policy, authorization::AuthorizationFailure
    ),
    Action::Action => (
        action::ActionPluginPre, slots::ActionPlanRequest, matcha_world_action, call_plan,
        slots::ActionPlanResult, Action, actions::ActionFailure
    ),
    Reconcile::Reconcile => (
        reconcile::ReconcilePluginPre, slots::ReconcileRequest, matcha_world_reconcile, call_reconcile,
        slots::ReconcileResult, Reconcile, slots::ReconcileFailure
    ),
    Abstraction::Abstraction => (
        abstraction::AbstractionPluginPre, abstraction::AbstractionRequest, matcha_world_abstraction, call_derive,
        abstraction::AbstractionContract, Abstraction, abstraction::AbstractionFailure
    ),
    Evaluation::Evaluation => (
        evaluation::EvaluationPluginPre, slots::OracleRequest, matcha_world_evaluation, call_evaluate,
        slots::OracleResult, Evaluation, slots::OracleFailure
    ),
    Context::Context => (
        context::ContextPluginPre, slots::ContextRequest, matcha_world_context, call_build,
        slots::ContextResult, Context, abstraction::ContextFailure
    ),
    AgentBridge::AgentBridge => (
        agent_bridge::AgentBridgePluginPre, slots::AgentBridgeRequest, matcha_world_agent_bridge, call_dispatch,
        slots::AgentBridgeResult, AgentBridge, slots::BridgeFailure
    ),
    Storage::Storage => (
        storage::StoragePluginPre, slots::StorageReadRequest, matcha_world_storage, call_read,
        slots::StorageReadResult, Storage, commit::CommitFailure
    ),
}

fn delivered(result: &Result<SlotResponse, SlotFailure>) -> u64 {
    let count = match result {
        Err(_) => 0,
        Ok(SlotResponse::Connector(value)) => value.rows.len(),
        Ok(SlotResponse::Resolver(value)) => {
            value.page.rows.items.len() + value.page.objects.len() + value.page.relations.len()
        }
        Ok(SlotResponse::Projection(value)) => value.cells.len(),
        Ok(SlotResponse::Provenance(value)) => value.upserts.len() + value.invalidate.len(),
        Ok(SlotResponse::Reconcile(value)) => {
            value.selected.len() + value.conflicts.len() + value.observations.len()
        }
        Ok(SlotResponse::Storage(value)) => {
            value.assertions.len() + value.definitions.len() + value.evidence.len()
        }
        Ok(_) => 1,
    };
    count as u64
}
