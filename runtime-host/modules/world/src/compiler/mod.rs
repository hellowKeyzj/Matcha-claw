mod check;
mod dependencies;
mod emit;
mod expression;
mod kinds;
mod passes;
mod pipeline;
mod prepared;
mod query;
mod scopes;
mod sdk;
mod types;

use std::collections::{BTreeMap, BTreeSet};

use world_protocol::{
    bindings::SlotKind,
    compiler::{
        ArtifactDraft, CompileFailure, CompileRequest, CompileResult, ExpressionAnnotation,
        ExternalContractKind, TypedIr,
    },
    definitions::{Definition, DefinitionBody, Scope},
    failure::FieldPath,
    ids::{DefinitionRef, Digest},
    query::QueryIr,
};

pub(crate) use dependencies::affected_definitions;
pub(crate) use emit::validate as validate_outputs;
pub(crate) use passes::{postcheck_pass, prepare_pass};
pub(crate) use pipeline::{
    CheckedCompilation, CompilationError, compile_with_passes, compiler_pass_node, compilation_access,
    restore_compilation, schema_node,
};
pub(crate) use prepared::{COMPILER_REGISTRATION, PreparedCompiler, PreparedSchema};
pub(crate) use scopes::check_scope;

pub(crate) use world_protocol::compiler::IR_VERSION;

/// Model validation is not pass execution or artifact sealing.
pub(crate) fn validate_model(request: &CompileRequest) -> Result<TypedIr, CompileFailure> {
    mandatory(request, None)
}

pub(crate) fn compile(request: &CompileRequest) -> Result<CompileResult, CompileFailure> {
    let ir = mandatory(request, None)?;
    reject_uninvoked_passes(request)?;
    finish(request, ir)
}

pub(crate) fn model_digest(request: &CompileRequest) -> Result<Digest, CompileFailure> {
    let mut definitions: Vec<_> = request
        .definitions
        .iter()
        .map(|definition| (&definition.reference, &definition.content_digest))
        .collect();
    definitions.sort_unstable_by(|left, right| left.0.cmp(right.0));
    let mut scopes: Vec<_> = request.scopes.iter().collect();
    scopes.sort_unstable_by(|left, right| (&left.world, &left.id).cmp(&(&right.world, &right.id)));
    crate::definitions::canonical_digest(&(
        IR_VERSION,
        &request.world,
        &request.base_release,
        definitions,
        scopes,
    ))
    .map_err(|failure| CompileFailure::Definition { failure })
}

fn finish(request: &CompileRequest, ir: TypedIr) -> Result<CompileResult, CompileFailure> {
    let outputs = emit::generate(request, &ir, None)?;
    result(request, ir, outputs)
}

fn result(
    request: &CompileRequest,
    ir: TypedIr,
    outputs: Vec<world_protocol::compiler::GeneratedArtifact>,
) -> Result<CompileResult, CompileFailure> {
    let checked_callers = ir
        .definitions
        .iter()
        .map(|definition| definition.reference.clone())
        .collect();
    Ok(CompileResult {
        draft: ArtifactDraft {
            model_digest: model_digest(request)?,
            targets: request.targets.clone(),
            dependencies: ir.dependencies.clone(),
            typed_ir: ir,
            outputs,
            checked_callers,
        },
        diagnostics: Vec::new(),
    })
}

/// Checks an unlowered model without claiming a checked execution IR.
pub(crate) fn validate_structure(request: &CompileRequest) -> Result<(), CompileFailure> {
    request_index(request)?;
    dependencies::evaluation_cycles(&request.definitions)?;
    crate::definitions::validate_structure(&request.definitions, &request.scopes)
        .map_err(|failure| CompileFailure::Definition { failure })
}

fn request_index(request: &CompileRequest) -> Result<BTreeMap<DefinitionRef, &Definition<DefinitionBody>>, CompileFailure> {
    if request.activation_lock.world != request.world
        || request.targets.is_empty()
        || request.definitions.len() > 65_536
    {
        return Err(CompileFailure::ArtifactInvalid {
            field: FieldPath(vec!["request".into()]),
        });
    }
    crate::extensions::bindings::BindingGraph::validate(request.activation_lock.clone()).map_err(
        |_| CompileFailure::ArtifactInvalid {
            field: FieldPath(vec!["activationLock".into()]),
        },
    )?;
    let mut targets = Vec::new();
    for target in &request.targets {
        if targets.contains(target) {
            return Err(CompileFailure::ArtifactInvalid {
                field: FieldPath(vec!["targets".into()]),
            });
        }
        targets.push(*target);
    }
    let mut index = BTreeMap::new();
    let mut stable_ids = BTreeSet::new();
    for definition in &request.definitions {
        if definition.reference.world != request.world {
            return Err(CompileFailure::Definition {
                failure: world_protocol::definitions::DefinitionFailure::CrossWorldReference {
                    reference: definition.reference.clone(),
                },
            });
        }
        if !stable_ids.insert(&definition.reference.id) {
            return Err(CompileFailure::ReferenceAmbiguous {
                id: definition.reference.id.clone(),
                field: FieldPath(vec!["definitions".into()]),
            });
        }
        index.insert(definition.reference.clone(), definition);
    }
    for external in &request.external_contracts {
        if !request.activation_lock.nodes.iter().any(|node| {
            node.implementation == external.implementation
                && node.implementation.contracts.contains(&external.contract)
        }) {
            return Err(CompileFailure::RequiredProviderMissing {
                contract: external.contract.clone(),
            });
        }
    }
    let mut scope_ids = BTreeSet::new();
    for (scope_index, scope) in request.scopes.iter().enumerate() {
        let field = FieldPath(vec!["scopes".into(), scope_index.to_string()]);
        if scope.world != request.world || !scope_ids.insert(&scope.id) {
            return Err(CompileFailure::ArtifactInvalid { field });
        }
        crate::definitions::validate_expression(&scope.predicate)
            .map_err(|failure| CompileFailure::Definition { failure })?;
        if !request
            .definitions
            .iter()
            .any(|definition| definition.scope == scope.id)
            && !matches!(
                scope.predicate,
                world_protocol::expression::ExpressionIr::Literal {
                    value: world_protocol::value::Value::Boolean { .. }
                }
            )
        {
            return Err(CompileFailure::ArtifactInvalid { field });
        }
    }
    Ok(index)
}

fn mandatory(
    request: &CompileRequest,
    reuse: Option<(&TypedIr, &BTreeSet<DefinitionRef>)>,
) -> Result<TypedIr, CompileFailure> {
    let index = request_index(request)?;
    dependencies::evaluation_cycles(&request.definitions)?;
    let validator =
        crate::definitions::DefinitionValidator::new(&request.definitions, &request.scopes)
            .map_err(|failure| CompileFailure::Definition { failure })?;
    let mut definitions = Vec::with_capacity(request.definitions.len());
    for definition in &request.definitions {
        // Every candidate crosses the mandatory boundary even when its expression memo is reusable.
        validator
            .validate(definition)
            .map_err(|failure| CompileFailure::Definition { failure })?;
        let scope = request
            .scopes
            .iter()
            .find(|scope| scope.world == definition.reference.world && scope.id == definition.scope)
            .ok_or_else(|| CompileFailure::ScopeMismatch {
                definition: definition.reference.clone(),
                field: FieldPath(vec!["scope".into()]),
            })?;
        scopes::check_scope(scope, definition, &request.definitions, &request.scopes)?;
        let reusable = reuse.and_then(|(previous, affected)| {
            if affected.contains(&definition.reference) {
                return None;
            }
            previous.definitions.iter().find(|old| {
                old.reference == definition.reference && old.body_hash == definition.content_digest
            })
        });
        if let Some(previous) = reusable {
            definitions.push(previous.clone());
            continue;
        }
        definitions.push(check::definition(request, definition, &index)?);
    }
    definitions.sort_by(|left, right| left.reference.cmp(&right.reference));
    let dependencies = dependencies::graph(request, &definitions);
    Ok(TypedIr {
        ir_version: IR_VERSION.into(),
        world: request.world.clone(),
        definitions,
        dependencies,
    })
}

fn reject_uninvoked_passes(request: &CompileRequest) -> Result<(), CompileFailure> {
    for node in request
        .activation_lock
        .nodes
        .iter()
        .filter(|node| node.slot == SlotKind::Compiler)
    {
        // A configured pass must actually run. The pure no-pass entry cannot silently skip it.
        let contract = node
            .ports
            .iter()
            .find(|port| port.direction == world_protocol::bindings::PortDirection::Export)
            .map(|port| port.contract.clone())
            .or_else(|| node.implementation.contracts.first().cloned());
        return match contract {
            Some(contract) => Err(CompileFailure::RequiredProviderMissing { contract }),
            None => Err(CompileFailure::PassContractInvalid {
                provider_id: node.provider_id.clone(),
            }),
        };
    }
    if let Some(external) = request
        .external_contracts
        .iter()
        .find(|contract| matches!(contract.kind, ExternalContractKind::CompilerPass { .. }))
    {
        return Err(CompileFailure::RequiredProviderMissing {
            contract: external.contract.clone(),
        });
    }
    Ok(())
}

/// The runtime query owner supplies its checked definition context; no hidden latest/network reads.
pub(crate) fn check_query(
    query: &QueryIr,
    owner: &Definition<DefinitionBody>,
    definitions: &[Definition<DefinitionBody>],
    scopes: &[Scope],
) -> Result<Vec<ExpressionAnnotation>, CompileFailure> {
    crate::definitions::validate_definition(owner, definitions, scopes)
        .map_err(|failure| CompileFailure::Definition { failure })?;
    let index = definitions
        .iter()
        .map(|definition| (definition.reference.clone(), definition))
        .collect();
    let mut context = expression::Context::new(owner, &index, scopes);
    context.parameters(&query.parameters, &["parameters".into()])?;
    query::bind_parameters(&mut context)?;
    query::check(&mut context, query, &["query".into()])?;
    Ok(context.annotations)
}

pub(crate) fn check_expression(
    expression: &world_protocol::expression::ExpressionIr,
    owner: &Definition<DefinitionBody>,
    definitions: &[Definition<DefinitionBody>],
    scopes: &[Scope],
    parameters: &[world_protocol::expression::Parameter],
    path: &FieldPath,
) -> Result<Vec<ExpressionAnnotation>, CompileFailure> {
    crate::definitions::validate_definition(owner, definitions, scopes)
        .map_err(|failure| CompileFailure::Definition { failure })?;
    dependencies::evaluation_cycles(definitions)?;
    let index = definitions
        .iter()
        .map(|definition| (definition.reference.clone(), definition))
        .collect();
    let mut context = expression::Context::new(owner, &index, scopes);
    context.parameters(parameters, &["parameters".into()])?;
    query::bind_parameters(&mut context)?;
    let inferred = context.infer(expression, None, &path.0, 0)?;
    context.read_only(&inferred, &path.0)?;
    Ok(context.annotations)
}

pub(crate) fn check_value(
    expression: &world_protocol::expression::ExpressionIr,
    expected: &world_protocol::value::ValueType,
    owner: &Definition<DefinitionBody>,
    definitions: &[Definition<DefinitionBody>],
    scopes: &[Scope],
    parameters: &[world_protocol::expression::Parameter],
    path: &FieldPath,
) -> Result<Vec<ExpressionAnnotation>, CompileFailure> {
    crate::definitions::validate_definition(owner, definitions, scopes)
        .map_err(|failure| CompileFailure::Definition { failure })?;
    dependencies::evaluation_cycles(definitions)?;
    let index = definitions
        .iter()
        .map(|definition| (definition.reference.clone(), definition))
        .collect();
    let mut context = expression::Context::new(owner, &index, scopes);
    context.parameters(parameters, &["parameters".into()])?;
    query::bind_parameters(&mut context)?;
    let inferred = context.infer(expression, Some(expected), &path.0, 0)?;
    context.read_only(&inferred, &path.0)?;
    Ok(context.annotations)
}

pub(crate) fn check_action(
    owner: &Definition<DefinitionBody>,
    definitions: &[Definition<DefinitionBody>],
    scopes: &[Scope],
) -> Result<world_protocol::compiler::DefinitionIr, CompileFailure> {
    crate::definitions::validate_definition(owner, definitions, scopes)
        .map_err(|failure| CompileFailure::Definition { failure })?;
    let DefinitionBody::ActionContract(body) = &owner.body else {
        return Err(invalid(&owner.reference, &["action".into()]));
    };
    dependencies::evaluation_cycles(definitions)?;
    let index = definitions
        .iter()
        .map(|definition| (definition.reference.clone(), definition))
        .collect();
    let mut context = expression::Context::new(owner, &index, scopes);
    let source = check::action(&mut context, body)?;
    context
        .annotations
        .sort_by(|left, right| left.field.0.cmp(&right.field.0));
    Ok(world_protocol::compiler::DefinitionIr {
        reference: owner.reference.clone(),
        body_hash: owner.content_digest.clone(),
        body: owner.body.clone(),
        scope: owner.scope.clone(),
        valid_time: owner.valid_time.clone(),
        annotations: context.annotations,
        policy_refs: body.policies.clone(),
        source_requirements: vec![source],
    })
}

pub(crate) fn check_rule(
    owner: &Definition<DefinitionBody>,
    definitions: &[Definition<DefinitionBody>],
    scopes: &[Scope],
) -> Result<world_protocol::compiler::DefinitionIr, CompileFailure> {
    crate::definitions::validate_definition(owner, definitions, scopes)
        .map_err(|failure| CompileFailure::Definition { failure })?;
    let DefinitionBody::Rule(body) = &owner.body else {
        return Err(invalid(&owner.reference, &["rule".into()]));
    };
    dependencies::evaluation_cycles(definitions)?;
    let index = definitions
        .iter()
        .map(|definition| (definition.reference.clone(), definition))
        .collect();
    let mut context = expression::Context::new(owner, &index, scopes);
    check::rule(&mut context, body)?;
    context
        .annotations
        .sort_by(|left, right| left.field.0.cmp(&right.field.0));
    Ok(world_protocol::compiler::DefinitionIr {
        reference: owner.reference.clone(),
        body_hash: owner.content_digest.clone(),
        body: owner.body.clone(),
        scope: owner.scope.clone(),
        valid_time: owner.valid_time.clone(),
        annotations: context.annotations,
        policy_refs: Vec::new(),
        source_requirements: Vec::new(),
    })
}

pub(crate) fn check_guard(
    expression: &world_protocol::expression::ExpressionIr,
    owner: &Definition<DefinitionBody>,
    definitions: &[Definition<DefinitionBody>],
    scopes: &[Scope],
    parameters: &[world_protocol::expression::Parameter],
    path: &FieldPath,
) -> Result<Vec<ExpressionAnnotation>, CompileFailure> {
    crate::definitions::validate_definition(owner, definitions, scopes)
        .map_err(|failure| CompileFailure::Definition { failure })?;
    dependencies::evaluation_cycles(definitions)?;
    let index = definitions
        .iter()
        .map(|definition| (definition.reference.clone(), definition))
        .collect();
    let mut context = expression::Context::new(owner, &index, scopes);
    context.parameters(parameters, &["parameters".into()])?;
    query::bind_parameters(&mut context)?;
    context.guard(expression, &path.0, true)?;
    Ok(context.annotations)
}

pub(crate) fn check_plan(
    steps: &[world_protocol::learning::StrategyStep],
    owner: &Definition<DefinitionBody>,
    definitions: &[Definition<DefinitionBody>],
    scopes: &[Scope],
    parameters: &[world_protocol::expression::Parameter],
) -> Result<Vec<ExpressionAnnotation>, CompileFailure> {
    crate::definitions::validate_definition(owner, definitions, scopes)
        .map_err(|failure| CompileFailure::Definition { failure })?;
    dependencies::evaluation_cycles(definitions)?;
    let index = definitions
        .iter()
        .map(|definition| (definition.reference.clone(), definition))
        .collect();
    let mut context = expression::Context::new(owner, &index, scopes);
    context.parameters(parameters, &["parameters".into()])?;
    query::bind_parameters(&mut context)?;
    check::strategy_steps(&mut context, steps)?;
    Ok(context.annotations)
}

/// Source predicates bind one canonical resource row, never an invented query or definition.
pub(crate) fn check_source_predicate(
    predicate: &world_protocol::expression::ExpressionIr,
    binding: &Definition<DefinitionBody>,
    input_type: &DefinitionRef,
    definitions: &[Definition<DefinitionBody>],
    scopes: &[Scope],
    row_symbol: &world_protocol::ids::SymbolId,
    resource: &str,
) -> Result<Vec<ExpressionAnnotation>, CompileFailure> {
    crate::definitions::validate_expression(predicate)
        .map_err(|failure| CompileFailure::Definition { failure })?;
    crate::definitions::validate_definition(binding, definitions, scopes)
        .map_err(|failure| CompileFailure::Definition { failure })?;
    let DefinitionBody::SourceBinding(source) = &binding.body else {
        return Err(invalid(&binding.reference, &["binding".into()]));
    };
    if resource != source.resource {
        return Err(invalid(&binding.reference, &["resource".into()]));
    }
    if source.identity_mapping.type_id != input_type.id {
        return Err(invalid(&binding.reference, &["inputType".into()]));
    }
    dependencies::evaluation_cycles(definitions)?;
    let index = definitions
        .iter()
        .map(|definition| (definition.reference.clone(), definition))
        .collect();
    let mut context = expression::Context::new(binding, &index, scopes);
    let target = context.stable(&source.identity_mapping.type_id, &["inputType".into()])?;
    if target.reference != *input_type
        || !matches!(
            target.body,
            DefinitionBody::ObjectType(_) | DefinitionBody::RelationType(_)
        )
    {
        return Err(invalid(&binding.reference, &["inputType".into()]));
    }
    context.bind(row_symbol, input_type, false, &["rowSymbol".into()])?;
    context.guard(predicate, &["predicate".into()], true)?;
    Ok(context.annotations)
}

/// Disposable memo only: no facts, publication, support or execution authority is persisted here.
#[derive(Default)]
pub(crate) struct CompilationCache {
    previous: Option<(CompileRequest, CompileResult, Digest)>,
}

impl CompilationCache {
    pub(crate) fn compile(
        &mut self,
        request: &CompileRequest,
    ) -> Result<CompileResult, CompileFailure> {
        reject_uninvoked_passes(request)?;
        self.compile_inner(request, None)
    }

    fn compile_checked(
        &mut self,
        request: &CompileRequest,
        ir: TypedIr,
    ) -> Result<CompileResult, CompileFailure> {
        self.compile_inner(request, Some(ir))
    }

    fn compile_inner(
        &mut self,
        request: &CompileRequest,
        checked: Option<TypedIr>,
    ) -> Result<CompileResult, CompileFailure> {
        let fingerprint = crate::definitions::canonical_digest(&(
            IR_VERSION,
            &request.world,
            &request.activation_lock,
            &request.scopes,
            &request.targets,
            &request.external_contracts,
            &request.config_digest,
        ))
        .map_err(|failure| CompileFailure::Definition { failure })?;
        let mut affected = BTreeSet::new();
        let previous = self
            .previous
            .as_ref()
            .filter(|(_, _, old_fingerprint)| old_fingerprint == &fingerprint);
        if let Some((old, result, _)) = previous {
            let old_by_id: BTreeMap<_, _> = old
                .definitions
                .iter()
                .map(|definition| (&definition.reference.id, definition))
                .collect();
            let current_by_id: BTreeMap<_, _> = request
                .definitions
                .iter()
                .map(|definition| (&definition.reference.id, definition))
                .collect();
            let changed: Vec<_> = old
                .definitions
                .iter()
                .filter(|definition| {
                    current_by_id
                        .get(&definition.reference.id)
                        .is_none_or(|current| {
                            current.reference != definition.reference
                                || current.content_digest != definition.content_digest
                        })
                })
                .map(|definition| definition.reference.clone())
                .chain(
                    request
                        .definitions
                        .iter()
                        .filter(|definition| {
                            old_by_id.get(&definition.reference.id).is_none_or(|old| {
                                old.reference != definition.reference
                                    || old.content_digest != definition.content_digest
                            })
                        })
                        .map(|definition| definition.reference.clone()),
                )
                .collect();
            affected.extend(affected_definitions(&result.draft.dependencies, &changed));
            let affected_ids: BTreeSet<_> = affected
                .iter()
                .map(|reference| reference.id.clone())
                .collect();
            affected.extend(
                request
                    .definitions
                    .iter()
                    .filter(|definition| affected_ids.contains(&definition.reference.id))
                    .map(|definition| definition.reference.clone()),
            );
        }
        let ir = match checked {
            Some(ir) => {
                if let Some((_, result, _)) = previous {
                    let changed: Vec<_> = ir.definitions.iter().filter(|definition| {
                        result.draft.typed_ir.definitions.iter()
                            .find(|old| old.reference == definition.reference) != Some(*definition)
                    }).map(|definition| definition.reference.clone()).collect();
                    affected.extend(affected_definitions(&result.draft.dependencies, &changed));
                    affected.extend(affected_definitions(&ir.dependencies, &changed));
                    affected.extend(changed);
                }
                ir
            }
            None => mandatory(
                request,
                previous.map(|(_, result, _)| (&result.draft.typed_ir, &affected)),
            )?,
        };
        let outputs = emit::generate(request, &ir, previous.map(|(_, result, _)| (&result.draft.typed_ir, result.draft.outputs.as_slice())))?;
        let mut result = result(request, ir, outputs)?;
        if previous.is_some() {
            result
                .draft
                .checked_callers
                .retain(|reference| affected.contains(reference));
        }
        self.previous = Some((request.clone(), result.clone(), fingerprint));
        Ok(result)
    }
}

fn invalid(definition: &DefinitionRef, path: &[String]) -> CompileFailure {
    CompileFailure::InvalidExpression {
        definition: definition.clone(),
        field: FieldPath(path.to_vec()),
    }
}

fn field(parent: &[String], name: impl ToString) -> Vec<String> {
    let mut path = parent.to_vec();
    path.push(name.to_string());
    path
}
