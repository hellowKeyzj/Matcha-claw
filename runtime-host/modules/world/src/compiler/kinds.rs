use world_protocol::{
    bindings::PortDirection,
    compiler::{CompileDependency, CompileFailure, CompileRequest, DependencyTarget, DependencyUse, TypedIr},
    definitions::{DefinitionBody, KindRequest, KindResponse, KindResult},
    failure::FieldPath,
    ids::NodeId,
    slots::{SlotRequest, SlotResponse},
};

use crate::{
    definitions::{CheckedKind, KindPlan, KindRegistry},
    extensions::{bindings::BindingGraph, invocation::{
        CompositionFailure, CompositionOutcome, InvocationContext, InvocationServices,
        invoke_composition_checked, replay_composition_checked,
    }},
};
use super::pipeline::{CompilationError, binding, pure_composition, ready, schema_failure, schema_invalid};

pub(super) fn roots(request: &CompileRequest) -> Result<Vec<NodeId>, CompositionFailure> {
    let mut roots = Vec::new();
    for definition in &request.definitions {
        let DefinitionBody::Extension(body) = &definition.body else { continue };
        let nodes = request.activation_lock.nodes.iter().filter(|node|
            node.slot == world_protocol::bindings::SlotKind::Schema
                && node.implementation.contracts.contains(&body.contract)
                && node.ports.iter().any(|port| port.direction == PortDirection::Export && port.contract == body.contract))
            .collect::<Vec<_>>();
        if nodes.is_empty() { return Err(schema_failure(CompileFailure::RequiredProviderMissing { contract: body.contract.clone() })); }
        for node in nodes { if !roots.contains(&node.id) { roots.push(node.id.clone()); } }
    }
    Ok(roots)
}

pub(super) async fn invoke(
    request: &CompileRequest, context: &InvocationContext,
    invocations: &[(KindPlan, InvocationContext, InvocationServices)],
) -> Result<(Vec<CheckedKind>, Vec<CompositionOutcome>), CompilationError> {
    let plans = invocations.iter().map(|(plan, _, _)| plan.clone()).collect::<Vec<_>>();
    KindRegistry::validate_plans(request, &plans).map_err(definition)?;
    let mut checked = Vec::new();
    let mut outcomes = Vec::new();
    for (plan, invocation, services) in invocations {
        let execute = async {
            ready(invocation)?;
            if invocation.node() != plan.node() || invocation.lease().graph().lock() != &request.activation_lock
                || invocation.lease().invocation() != context.lease().invocation()
                || !invocation.budget().same_scope(context.budget()) {
                return Err(binding(world_protocol::bindings::BindingFailure::LockIdentityConflict));
            }
            pure_composition(invocation.lease().graph(), invocation.node())?;
            let mut responses = Vec::new();
            for call in plan.requests(request) {
                let outcome = invoke_composition_checked(invocation.clone(), SlotRequest::SchemaKind(call.clone()), services.clone(),
                    |_, input| { ready(invocation)?; check_input(&call, input) },
                    |_, input, proposal| { ready(invocation)?; check_response(&call, input, proposal) },
                ).await?;
                let response = match &outcome.result {
                    Ok(SlotResponse::SchemaKind(response)) => Some(response.clone()),
                    Err(_) => None,
                    _ => return Err(schema_invalid()),
                };
                outcomes.push(outcome);
                let Some(response) = response else { return Ok(None) };
                responses.push(response);
            }
            invocation.check_current().await.map_err(|error| CompositionFailure::Invocation(
                crate::extensions::invocation::InvocationFailure::Current(error)))?;
            KindRegistry::check_results(request, plan, &responses).map(Some).map_err(definition)
        }.await;
        match execute {
            Ok(Some(kind)) => checked.push(kind),
            Ok(None) => return Err(CompilationError::Composition(outcomes)),
            Err(failure) => return Err(CompilationError::Postcheck { failure, outcomes }),
        }
    }
    Ok((checked, outcomes))
}

pub(super) fn restore(
    request: &CompileRequest, graph: &BindingGraph, plans: &[KindPlan], observations: &[serde_json::Value],
) -> Result<Vec<CheckedKind>, CompilationError> {
    KindRegistry::validate_plans(request, plans).map_err(definition)?;
    if observations.len() != plans.len() * 6 { return Err(schema_invalid().into()); }
    let mut checked = Vec::new();
    let mut cursor = 0;
    for plan in plans {
        pure_composition(graph, plan.node())?;
        let mut responses = Vec::new();
        for call in plan.requests(request) {
            let response = replay_composition_checked(graph, plan.node(), SlotRequest::SchemaKind(call.clone()), &observations[cursor],
                |_, input| check_input(&call, input),
                |_, input, proposal| check_response(&call, input, proposal),
            )?;
            let SlotResponse::SchemaKind(response) = response else { return Err(schema_invalid().into()); };
            responses.push(response); cursor += 1;
        }
        checked.push(KindRegistry::check_results(request, plan, &responses).map_err(definition)?);
    }
    Ok(checked)
}

/// The original immutable Extension remains canonical; only this checked standard copy enters the compiler.
pub(super) fn lower(request: &CompileRequest, kinds: &[CheckedKind]) -> Result<CompileRequest, CompileFailure> {
    let mut lowered = request.clone();
    for kind in kinds {
        let definition = lowered.definitions.iter_mut().find(|definition| definition.reference == kind.definition().reference)
            .ok_or_else(|| CompileFailure::ArtifactInvalid { field: FieldPath(vec!["kind".into(), "definition".into()]) })?;
        if definition != kind.definition() || matches!(kind.lowered(), DefinitionBody::Extension(_)) {
            return Err(CompileFailure::ArtifactInvalid { field: FieldPath(vec!["kind".into(), "lower".into()]) });
        }
        definition.body = kind.lowered().clone();
        definition.content_digest = crate::definitions::content_digest(definition).map_err(|failure| CompileFailure::Definition { failure })?;
    }
    if let Some(definition) = lowered.definitions.iter().find(|definition| matches!(definition.body, DefinitionBody::Extension(_))) {
        let DefinitionBody::Extension(body) = &definition.body else { unreachable!() };
        return Err(CompileFailure::RequiredProviderMissing { contract: body.contract.clone() });
    }
    Ok(lowered)
}

pub(super) fn dependencies(request: &CompileRequest, plans: &[KindPlan], ir: &mut TypedIr) -> Result<(), CompileFailure> {
    for plan in plans {
        let node = request.activation_lock.nodes.iter().find(|node| &node.id == plan.node()).ok_or(CompileFailure::InternalFault)?;
        let kind = plan.contract();
        let targets = [&kind.schema, &kind.validate, &kind.lower, &kind.index, &kind.migrate, &kind.reducer, &kind.lifecycle]
            .into_iter().map(|contract| DependencyTarget::Contract(contract.clone()))
            .chain(std::iter::once(DependencyTarget::Implementation(node.implementation.clone())));
        for target in targets {
            let dependency = CompileDependency { dependent: plan.definition().reference.clone(), target,
                usage: DependencyUse::Provider, selector: FieldPath(vec!["kind".into()]), invalidates: request.targets.clone() };
            if !ir.dependencies.edges.contains(&dependency) { ir.dependencies.edges.push(dependency); }
        }
    }
    Ok(())
}

fn check_input(call: &KindRequest, input: SlotRequest) -> Result<SlotRequest, CompositionFailure> {
    if input != SlotRequest::SchemaKind(call.clone()) { return Err(schema_invalid()); }
    Ok(input)
}
fn check_response(call: &KindRequest, input: &SlotRequest, proposal: &SlotResponse) -> Result<Option<SlotResponse>, CompositionFailure> {
    let SlotResponse::SchemaKind(response) = proposal else { return Err(schema_invalid()); };
    if input != &SlotRequest::SchemaKind(call.clone()) || &response.contract != call.contract() { return Err(schema_invalid()); }
    use world_protocol::definitions::KindOperation;
    if !matches!((&call.operation, &response.result),
        (KindOperation::Validate, KindResult::Validated) | (KindOperation::Lower, KindResult::Lowered { .. })
        | (KindOperation::Index, KindResult::Indexed { .. }) | (KindOperation::Migrate, KindResult::Migrated { .. })
        | (KindOperation::Reducer { .. }, KindResult::Reduced { .. }) | (KindOperation::Lifecycle, KindResult::LifecycleChecked)) {
        return Err(schema_invalid());
    }
    Ok(Some(SlotResponse::SchemaKind(KindResponse { contract: response.contract.clone(), result: response.result.clone() })))
}
fn definition(failure: world_protocol::definitions::DefinitionFailure) -> CompositionFailure {
    schema_failure(CompileFailure::Definition { failure })
}
