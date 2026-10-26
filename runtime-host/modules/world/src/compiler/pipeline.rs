use std::{error::Error, fmt, sync::Mutex};

use serde::Deserialize;
use world_protocol::{
    authorization::{AccessMode, AccessScope},
    bindings::{BindingFailure, PortDirection, SlotKind},
    budget::BudgetDimension,
    compiler::{
        CompileDependency, CompileFailure, CompileRequest, CompileResult, CompilerPassRequest,
        DependencyTarget, DependencyUse, TypedIr,
    },
    failure::FieldPath,
    ids::{NodeId, ResourceRef},
    process::HostFailure,
    slots::{SlotFailure, SlotRequest, SlotResponse},
};

use crate::definitions::{CheckedKind, KindPlan};
use crate::extensions::{
    bindings::BindingGraph,
    invocation::{
        CompositionFailure, CompositionOutcome, InvocationContext, InvocationFailure,
        InvocationServices, invoke_composition_checked,
    },
};

/// Only this owner can mint a compilation after Schema and every selected pass actually ran.
pub(crate) struct CheckedCompilation {
    request: CompileRequest,
    result: CompileResult,
    kinds: Vec<CheckedKind>,
    outcomes: Vec<CompositionOutcome>,
    observation: serde_json::Value,
}

impl CheckedCompilation {
    pub(crate) fn request(&self) -> &CompileRequest {
        &self.request
    }
    pub(crate) fn result(&self) -> &CompileResult {
        &self.result
    }
    pub(crate) fn outcomes(&self) -> &[CompositionOutcome] {
        &self.outcomes
    }
    pub(crate) fn kinds(&self) -> &[CheckedKind] { &self.kinds }
    pub(crate) fn observation(&self) -> &serde_json::Value {
        &self.observation
    }
}

pub(crate) enum CompilationError {
    Compile(CompileFailure),
    Invocation(CompositionFailure),
    Composition(Vec<CompositionOutcome>),
    Postcheck {
        failure: CompositionFailure,
        outcomes: Vec<CompositionOutcome>,
    },
}

impl CompilationError {
    pub(crate) fn outcomes(&self) -> &[CompositionOutcome] {
        match self {
            Self::Composition(outcomes) | Self::Postcheck { outcomes, .. } => outcomes,
            _ => &[],
        }
    }
    pub(crate) fn observation(&self) -> Result<Option<serde_json::Value>, serde_json::Error> {
        if self.outcomes().is_empty() {
            Ok(None)
        } else {
            retained_observation(self.outcomes()).map(Some)
        }
    }
    pub(crate) fn host_failure(&self) -> HostFailure {
        match self {
            Self::Compile(failure) => HostFailure::Slot(SlotFailure::Compiler(failure.clone())),
            Self::Invocation(failure) | Self::Postcheck { failure, .. } => failure.host_failure(),
            Self::Composition(outcomes) => outcomes
                .last()
                .expect("failed compilation composition")
                .result
                .as_ref()
                .err()
                .expect("failed compilation composition")
                .host_failure(),
        }
    }
}
impl From<CompileFailure> for CompilationError {
    fn from(failure: CompileFailure) -> Self {
        Self::Compile(failure)
    }
}
impl From<CompositionFailure> for CompilationError {
    fn from(failure: CompositionFailure) -> Self {
        Self::Invocation(failure)
    }
}
impl fmt::Debug for CompilationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("CompilationError")
            .field(&self.host_failure())
            .finish()
    }
}
impl fmt::Display for CompilationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("world.compilation_failed")
    }
}
impl Error for CompilationError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Invocation(failure) | Self::Postcheck { failure, .. } => Some(failure),
            Self::Composition(outcomes) => outcomes.last().and_then(|outcome| {
                outcome.result.as_ref().err().map(|failure| failure as _)
            }),
            Self::Compile(_) => None,
        }
    }
}

fn slot_node(graph: &BindingGraph, slot: SlotKind) -> Result<Option<NodeId>, CompilationError> {
    let contract = world_protocol::slots::slot_contract(slot)
        .map_err(|error| CompositionFailure::Invocation(InvocationFailure::Schema(error)))?;
    let exports = |node: &&world_protocol::bindings::BindingNode| node.slot == slot && node.ports.iter().any(|port|
        port.direction == PortDirection::Export && port.contract == contract);
    let Some(selected) = graph.lock().nodes.iter().filter(exports).next() else {
        return Ok(None);
    };
    let composition = graph.composition(&selected.binding_id).map_err(binding)?;
    if graph.lock().nodes.iter().filter(exports).any(|node| {
        !composition.nodes.contains(&node.id)
    }) {
        return Err(binding(BindingFailure::InvalidComposition {
            binding_id: selected.binding_id.clone(),
        }).into());
    }
    graph.composition_order(&selected.binding_id).map_err(binding)?
        .into_iter().next().map(Some).ok_or_else(|| {
            binding(BindingFailure::InvalidComposition {
                binding_id: selected.binding_id.clone(),
            }).into()
        })
}

pub(crate) fn schema_node(request: &CompileRequest) -> Result<NodeId, CompilationError> {
    let graph = BindingGraph::validate(request.activation_lock.clone()).map_err(binding)?;
    slot_node(&graph, SlotKind::Schema)?.ok_or_else(|| {
        match world_protocol::slots::slot_contract(SlotKind::Schema) {
            Ok(contract) => schema_failure(CompileFailure::RequiredProviderMissing { contract }).into(),
            Err(error) => CompositionFailure::Invocation(InvocationFailure::Schema(error)).into(),
        }
    })
}

/// The canonical order's entry selects the whole validated composition, not one pass.
pub(crate) fn compiler_pass_node(
    request: &CompileRequest,
) -> Result<Option<NodeId>, CompilationError> {
    let graph = BindingGraph::validate(request.activation_lock.clone()).map_err(binding)?;
    slot_node(&graph, SlotKind::Compiler)
}

/// Exact plugin execution requirements, including mandatory Schema when no pass is configured.
pub(crate) fn compilation_access(request: &CompileRequest) -> Result<Vec<AccessScope>, CompilationError> {
    let graph = BindingGraph::validate(request.activation_lock.clone()).map_err(binding)?;
    let mut roots = vec![schema_node(request)?];
    roots.extend(compiler_pass_node(request)?);
    roots.extend(super::kinds::roots(request)?);
    let mut resources = Vec::new();
    for root in roots {
        for node in graph.closure_nodes(&root).map_err(binding)? {
            let reference = ResourceRef::Binding {
                id: graph.node(&node).map_err(binding)?.binding_id.clone(),
            };
            if !resources.contains(&reference) {
                resources.push(reference);
            }
        }
    }
    if request.scopes.is_empty() {
        return Err(CompileFailure::ArtifactInvalid {
            field: FieldPath(vec!["scopes".into()]),
        }
        .into());
    }
    Ok(request.scopes.iter().map(|scope| AccessScope {
        resources: resources.clone(),
        fields: Vec::new(),
        modes: vec![AccessMode::Execute],
        scope: scope.id.clone(),
        valid_time: None,
    }).collect())
}

pub(crate) async fn compile_with_passes(
    request: &CompileRequest,
    context: InvocationContext,
    services: InvocationServices,
    compiler: Option<(InvocationContext, InvocationServices)>,
    kinds: Vec<(KindPlan, InvocationContext, InvocationServices)>,
    cache: &Mutex<super::CompilationCache>,
) -> Result<CheckedCompilation, CompilationError> {
    ready(&context)?;
    let graph = context.lease().graph();
    if graph.lock() != &request.activation_lock || context.node() != &schema_node(request)? {
        return Err(binding(BindingFailure::LockIdentityConflict).into());
    }
    let pass_root = compiler_pass_node(request)?;
    if compiler.as_ref().map(|(context, _)| context.node()) != pass_root.as_ref()
        || compiler.as_ref().is_some_and(|(pass, _)| {
            pass.lease().graph().lock() != graph.lock()
                || pass.lease().invocation() != context.lease().invocation()
                || !pass.budget().same_scope(context.budget())
        })
    {
        return Err(binding(BindingFailure::LockIdentityConflict).into());
    }
    let impact = crate::authorization::actual_impact(
        compilation_access(request)?, Vec::new(), Vec::new(), Vec::new(), Vec::new(),
    ).map_err(|error| CompositionFailure::Invocation(InvocationFailure::Output(error)))?;
    context.admission().require_access(&impact)
        .map_err(|error| CompositionFailure::Invocation(InvocationFailure::Output(error)))?;
    pure_composition(graph, context.node())?;
    let plans = kinds.iter().map(|(plan, _, _)| plan.clone()).collect::<Vec<_>>();
    let (checked_kinds, mut outcomes) = super::kinds::invoke(request, &context, &kinds).await?;
    let original = request;
    let lowered = super::kinds::lower(original, &checked_kinds).map_err(|failure| CompilationError::Postcheck {
        failure: schema_failure(failure), outcomes: std::mem::take(&mut outcomes),
    })?;
    let request = &lowered;
    let schema = invoke_composition_checked(
        context.clone(),
        SlotRequest::Schema(request.clone()),
        services,
        |_, input| {
            ready(&context)?;
            if input != SlotRequest::Schema(request.clone()) {
                return Err(schema_invalid());
            }
            Ok(input)
        },
        |_, input, proposal| {
            ready(&context)?;
            check_schema_response(request, input, proposal)
        },
    ).await;
    let outcome = match schema {
        Ok(outcome) => outcome,
        Err(failure) => return Err(CompilationError::Postcheck { failure, outcomes }),
    };
    outcomes.push(outcome);
    if outcomes.last().expect("Schema composition").result.is_err() {
        return Err(CompilationError::Composition(outcomes));
    }
    let mut initial = match outcomes.last().expect("Schema composition").result.as_ref().expect("successful Schema composition") {
        SlotResponse::Schema(ir) => ir.clone(),
        _ => return Err(CompilationError::Postcheck { failure: schema_invalid(), outcomes }),
    };
    super::kinds::dependencies(original, &plans, &mut initial).map_err(|failure| CompilationError::Postcheck {
        failure: schema_failure(failure), outcomes: std::mem::take(&mut outcomes),
    })?;
    let mut pass_input = None;
    if let Some((pass_context, pass_services)) = &compiler {
        let invoked = async {
            pure_composition(graph, pass_context.node())?;
            let selected = graph.node(pass_context.node()).map_err(binding)?;
            for node in &graph.composition(&selected.binding_id).map_err(binding)?.nodes {
                permissions(request, &initial, node).map_err(compile_failure)?;
            }
            let first = permissions(request, &initial, pass_context.node()).map_err(compile_failure)?;
            let outcome = invoke_composition_checked(
                pass_context.clone(),
                SlotRequest::Compiler(first.clone()),
                pass_services.clone(),
                |node, input| {
                    ready(pass_context)?;
                    let SlotRequest::Compiler(input) = input else {
                        return Err(compile_failure(CompileFailure::InternalFault));
                    };
                    permissions(request, &input.ir, node)
                        .map(SlotRequest::Compiler).map_err(compile_failure)
                },
                |node, input, proposal| {
                    ready(pass_context)?;
                    check_response(request, node, input, proposal, || ready(pass_context))
                },
            ).await?;
            Ok::<_, CompositionFailure>((first, outcome))
        }.await;
        match invoked {
            Ok((first, outcome)) => {
                pass_input = Some(first);
                outcomes.push(outcome);
            }
            Err(failure) => return Err(CompilationError::Postcheck { failure, outcomes }),
        }
        if outcomes.last().expect("invoked Compiler composition").result.is_err() {
            return Err(CompilationError::Composition(outcomes));
        }
    }
    let result = async {
        ready(&context)?;
        let mut result = {
            let mut cache = cache.lock().expect("release compiler cache poisoned");
            match (&compiler, &pass_input) {
            (Some((pass, _)), Some(first)) => {
                let SlotResponse::Compiler(merged) = outcomes.last().expect("Compiler composition")
                    .result.as_ref().expect("successful Compiler composition") else {
                    return Err(compile_failure(CompileFailure::InternalFault));
                };
                let selected = graph.node(pass.node()).map_err(binding)?;
                finish_checked(request, &selected.provider_id, first, merged, &mut cache)?
            }
            (None, None) => {
                super::reject_uninvoked_passes(request).map_err(compile_failure)?;
                cache.compile_checked(request, initial).map_err(compile_failure)?
            }
            _ => return Err(compile_failure(CompileFailure::InternalFault)),
            }
        };
        result.draft.model_digest = super::model_digest(original).map_err(schema_failure)?;
        for (_, kind, _) in &kinds {
            kind.check_current().await.map_err(|error| CompositionFailure::Invocation(InvocationFailure::Current(error)))?;
        }
        for output in &result.draft.outputs {
            context.budget().charge(BudgetDimension::Bytes, output.bytes.len() as u64)
                .map_err(|error| CompositionFailure::Invocation(InvocationFailure::Budget(error)))?;
        }
        context.check_current().await
            .map_err(|error| CompositionFailure::Invocation(InvocationFailure::Current(error)))?;
        if let Some((pass, _)) = &compiler {
            pass.check_current().await
                .map_err(|error| CompositionFailure::Invocation(InvocationFailure::Current(error)))?;
        }
        context.check_output(1).await
            .map_err(|error| CompositionFailure::Invocation(InvocationFailure::Output(error)))?;
        ready(&context)?;
        let observation = retained_observation(&outcomes)
            .map_err(|error| CompositionFailure::Invocation(InvocationFailure::Meter(error)))?;
        Ok((result, observation))
    }.await;
    match result {
        Ok((result, observation)) => Ok(CheckedCompilation {
            request: original.clone(), result, kinds: checked_kinds, outcomes, observation,
        }),
        Err(failure) => Err(CompilationError::Postcheck { failure, outcomes }),
    }
}

/// The caller must first prove the original compiler Step and observation commit settled.
/// Historical bytes are rechecked; they never recreate a lease or authorize another invocation.
pub(crate) fn restore_compilation(
    request: &CompileRequest,
    observation: &serde_json::Value,
    kinds: &[KindPlan],
    cache: &Mutex<super::CompilationCache>,
) -> Result<CheckedCompilation, CompilationError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Observation {
        compositions: Vec<serde_json::Value>,
    }
    let retained: Observation = serde_json::from_value(observation.clone())
        .map_err(|error| CompositionFailure::Invocation(InvocationFailure::Meter(error)))?;
    let root = schema_node(request)?;
    let pass = compiler_pass_node(request)?;
    let offset = kinds.len().checked_mul(6).ok_or_else(schema_invalid)?;
    if retained.compositions.len() != offset + 1 + usize::from(pass.is_some()) {
        return Err(schema_invalid().into());
    }
    let graph = BindingGraph::validate(request.activation_lock.clone()).map_err(binding)?;
    let checked_kinds = super::kinds::restore(request, &graph, kinds, &retained.compositions[..offset])?;
    let original = request;
    let lowered = super::kinds::lower(original, &checked_kinds)?;
    let request = &lowered;
    pure_composition(&graph, &root)?;
    let merged = crate::extensions::invocation::replay_composition_checked(
        &graph, &root, SlotRequest::Schema(request.clone()), &retained.compositions[offset],
        |_, input| {
            if input != SlotRequest::Schema(request.clone()) {
                return Err(schema_invalid());
            }
            Ok(input)
        },
        |_, input, proposal| check_schema_response(request, input, proposal),
    )?;
    let SlotResponse::Schema(mut initial) = merged else {
        return Err(schema_invalid().into());
    };
    super::kinds::dependencies(original, kinds, &mut initial)?;
    let mut result = if let Some(root) = pass {
        pure_composition(&graph, &root)?;
        let selected = graph.node(&root).map_err(binding)?;
        for member in &graph.composition(&selected.binding_id).map_err(binding)?.nodes {
            permissions(request, &initial, member)?;
        }
        let first = permissions(request, &initial, &root)?;
        let merged = crate::extensions::invocation::replay_composition_checked(
            &graph, &root, SlotRequest::Compiler(first.clone()), &retained.compositions[offset + 1],
            |node, input| {
                let SlotRequest::Compiler(input) = input else {
                    return Err(compile_failure(CompileFailure::InternalFault));
                };
                permissions(request, &input.ir, node)
                    .map(SlotRequest::Compiler).map_err(compile_failure)
            },
            |node, input, proposal| check_response(request, node, input, proposal, || Ok(())),
        )?;
        let SlotResponse::Compiler(merged) = merged else {
            return Err(compile_failure(CompileFailure::InternalFault).into());
        };
        finish_checked(request, &selected.provider_id, &first, &merged,
            &mut cache.lock().expect("release compiler cache poisoned"))?
    } else {
        super::reject_uninvoked_passes(request)?;
        cache.lock().expect("release compiler cache poisoned").compile_checked(request, initial)?
    };
    result.draft.model_digest = super::model_digest(original)?;
    Ok(CheckedCompilation {
        request: original.clone(), result, kinds: checked_kinds, outcomes: Vec::new(), observation: observation.clone(),
    })
}

fn retained_observation(outcomes: &[CompositionOutcome]) -> Result<serde_json::Value, serde_json::Error> {
    let compositions: Vec<_> = outcomes.iter()
        .map(|outcome| serde_json::to_value(outcome.retained())).collect::<Result<_, _>>()?;
    Ok(serde_json::json!({ "compositions": compositions }))
}

pub(super) fn pure_composition(graph: &BindingGraph, root: &NodeId) -> Result<(), CompositionFailure> {
    let selected = graph.node(root).map_err(binding)?;
    for member in &graph.composition(&selected.binding_id).map_err(binding)?.nodes {
        let node = graph.node(member).map_err(binding)?;
        // Compilation consumes frozen input only; untracked reads cannot enter a build key.
        if node.ports.iter().any(|port| {
            port.direction == PortDirection::Import && port.name != "logging.log"
        }) {
            let failure = CompileFailure::PassContractInvalid { provider_id: node.provider_id.clone() };
            return Err(if selected.slot == SlotKind::Schema {
                schema_failure(failure)
            } else {
                compile_failure(failure)
            });
        }
    }
    Ok(())
}

fn check_schema_response(
    request: &CompileRequest,
    input: &SlotRequest,
    proposal: &SlotResponse,
) -> Result<Option<SlotResponse>, CompositionFailure> {
    let (SlotRequest::Schema(input), SlotResponse::Schema(proposal)) = (input, proposal) else {
        return Err(schema_invalid());
    };
    if input != request {
        return Err(schema_invalid());
    }
    let checked = super::mandatory(request, None).map_err(schema_failure)?;
    if proposal != &checked {
        return Err(schema_invalid());
    }
    Ok(Some(SlotResponse::Schema(checked)))
}

fn finish_checked(
    request: &CompileRequest,
    provider: &world_protocol::ids::ProviderId,
    first: &CompilerPassRequest,
    merged: &world_protocol::compiler::CompilerPassResult,
    cache: &mut super::CompilationCache,
) -> Result<CompileResult, CompositionFailure> {
    let checked = super::postcheck_pass(request, provider, first, merged.clone()).map_err(compile_failure)?;
    let mut result = cache.compile_checked(request, checked).map_err(compile_failure)?;
    result.diagnostics = merged.diagnostics.clone();
    Ok(result)
}

fn check_response(
    request: &CompileRequest,
    node: &NodeId,
    input: &SlotRequest,
    proposal: &SlotResponse,
    mut check_budget: impl FnMut() -> Result<(), CompositionFailure>,
) -> Result<Option<SlotResponse>, CompositionFailure> {
    let (SlotRequest::Compiler(pass), SlotResponse::Compiler(proposal)) = (input, proposal) else {
        return Err(compile_failure(CompileFailure::InternalFault));
    };
    let provider = request
        .activation_lock
        .nodes
        .iter()
        .find(|member| &member.id == node)
        .ok_or_else(|| {
            binding(BindingFailure::MissingNode {
                node_id: node.clone(),
            })
        })?;
    let mut checked = proposal.clone();
    checked.ir = super::postcheck_pass(request, &provider.provider_id, pass, checked.clone())
        .map_err(compile_failure)?;
    // The entire frozen input is visible; changed bodies conservatively depend on all of it.
    for (before, after) in pass.ir.definitions.iter().zip(&checked.ir.definitions) {
        if before.body == after.body {
            continue;
        }
        for target in &pass.declared_reads {
            check_budget()?;
            let dependency = CompileDependency {
                dependent: after.reference.clone(),
                target: target.clone(),
                usage: DependencyUse::CompilerPass,
                selector: FieldPath(vec!["compilerPass".into(), node.to_string()]),
                invalidates: request.targets.clone(),
            };
            if !checked.observed_dependencies.contains(&dependency) {
                checked.observed_dependencies.push(dependency);
            }
        }
    }
    for dependency in &checked.observed_dependencies {
        if !checked.ir.dependencies.edges.contains(dependency) {
            checked.ir.dependencies.edges.push(dependency.clone());
        }
    }
    Ok(Some(SlotResponse::Compiler(checked)))
}

fn permissions(
    request: &CompileRequest,
    ir: &TypedIr,
    node: &NodeId,
) -> Result<CompilerPassRequest, CompileFailure> {
    let mut reads = vec![DependencyTarget::Config(request.config_digest.clone())];
    for target in ir
        .definitions
        .iter()
        .map(|definition| DependencyTarget::Definition(definition.reference.clone()))
        .chain(ir.dependencies.edges.iter().map(|edge| edge.target.clone()))
        .chain(request.external_contracts.iter().flat_map(|external| {
            [
                DependencyTarget::Contract(external.contract.clone()),
                DependencyTarget::Implementation(external.implementation.clone()),
            ]
        }))
    {
        if !reads.contains(&target) {
            reads.push(target);
        }
    }
    let mut rewrites = Vec::new();
    for (index, definition) in ir.definitions.iter().enumerate() {
        for annotation in definition
            .annotations
            .iter()
            .filter(|annotation| annotation.effects.is_empty() && !annotation.field.0.is_empty())
        {
            if definition.annotations.iter().any(|parent| {
                parent.effects.is_empty()
                    && !parent.field.0.is_empty()
                    && parent.field.0.len() < annotation.field.0.len()
                    && annotation.field.0.starts_with(&parent.field.0)
            }) {
                continue;
            }
            let mut path = vec!["definitions".into(), index.to_string(), "body".into()];
            path.extend(annotation.field.0.iter().cloned());
            rewrites.push(FieldPath(path));
        }
    }
    super::prepare_pass(request, ir, node, reads, rewrites)
}

pub(super) fn ready(context: &InvocationContext) -> Result<(), CompositionFailure> {
    if context.pipeline().is_cancelled() {
        return Err(compile_failure(CompileFailure::Cancelled));
    }
    context
        .budget()
        .charge(BudgetDimension::Steps, 1)
        .map_err(|error| CompositionFailure::Invocation(InvocationFailure::Budget(error)))
}
fn compile_failure(failure: CompileFailure) -> CompositionFailure {
    CompositionFailure::Slot(SlotFailure::Compiler(failure))
}
pub(super) fn schema_failure(failure: CompileFailure) -> CompositionFailure {
    CompositionFailure::Slot(SlotFailure::Schema(failure))
}
pub(super) fn schema_invalid() -> CompositionFailure {
    schema_failure(CompileFailure::ArtifactInvalid {
        field: FieldPath(vec!["schema".into(), "typedIr".into()]),
    })
}
pub(super) fn binding(failure: BindingFailure) -> CompositionFailure {
    CompositionFailure::Invocation(InvocationFailure::Binding(failure))
}
