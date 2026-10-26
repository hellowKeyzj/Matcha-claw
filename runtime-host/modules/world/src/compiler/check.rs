use std::collections::{BTreeMap, BTreeSet};

use world_protocol::{
    actions::IdempotencyPolicy,
    authorization::PolicyRef,
    compiler::{CompileFailure, CompileRequest, DefinitionIr, ExternalContractKind, SourceRequirement},
    definitions::{Definition, DefinitionBody},
    expression::{Effect, ExpressionIr},
    failure::FieldPath,
    ids::DefinitionRef,
    learning::StrategyOperation,
    sources::{ChangeStreamCapability, SourceCapability, SyncPolicy},
    value::ValueType,
};

use super::{expression::Context, field, invalid, query};

type Model = Definition<DefinitionBody>;

pub(super) fn definition(
    request: &CompileRequest, model: &Model, index: &BTreeMap<DefinitionRef, &Model>,
) -> Result<DefinitionIr, CompileFailure> {
    let mut context = Context::new(model, index, &request.scopes);
    let mut policies = Vec::new();
    let mut sources = Vec::new();
    match &model.body {
        DefinitionBody::Function(body) => {
            context.parameters(&body.parameters, &["parameters".into()])?;
            query::bind_parameters(&mut context)?;
            let inferred = context.infer(&body.expression, Some(&body.result_type), &["expression".into()], 0)?;
            context.declared(&inferred, &body.effects, &["effects".into()])?;
            // Functions have no effect-intent protocol; writes belong to ActionContract.
            context.read_only(&inferred, &["expression".into()])?;
            if body.effects.contains(&Effect::ExternalWrite) { return Err(CompileFailure::EffectViolation {
                definition: model.reference.clone(), field: FieldPath(vec!["effects".into()]), effect: Effect::ExternalWrite,
            }); }
        }
        DefinitionBody::Rule(body) => {
            rule(&mut context, body)?;
        }
        DefinitionBody::Metric(body) => {
            context.parameters(&body.parameters, &["parameters".into()])?;
            query::bind_parameters(&mut context)?;
            query::read_expression(&mut context, &body.expression, Some(&body.result_type), &["expression".into()])?;
            context.window(body.window.as_ref(), None, &["window".into()])?;
            if let Some(unit) = &body.unit {
                if !matches!(&body.result_type, ValueType::Quantity { unit: actual } if actual == unit) {
                    return Err(invalid(&model.reference, &["unit".into()]));
                }
            }
        }
        DefinitionBody::ConceptView(body) => { query::check(&mut context, &body.query, &["query".into()])?; }
        DefinitionBody::Facet(body) => {
            for id in &body.attaches_to {
                let target = context.stable(id, &["attachesTo".into()])?;
                let symbol = world_protocol::ids::SymbolId::try_new(id.as_str()).map_err(|_| CompileFailure::InternalFault)?;
                context.bind(&symbol, &target.reference, false, &["attachesTo".into()])?;
            }
            context.guard(&body.applicability, &["applicability".into()], true)?;
        }
        DefinitionBody::StateModel(body) => {
            let property = context.resolve(&body.property, &["property".into()])?;
            let DefinitionBody::Property(property) = &property.body else { return Err(invalid(&model.reference, &["property".into()])); };
            for id in &property.domain {
                let target = context.stable(id, &["property".into()])?;
                let symbol = world_protocol::ids::SymbolId::try_new(id.as_str()).map_err(|_| CompileFailure::InternalFault)?;
                context.bind(&symbol, &target.reference, false, &["property".into()])?;
            }
            for (index, transition) in body.transitions.iter().enumerate() {
                context.guard(&transition.guard, &field(&field(&field(&[], "transitions"), index), "guard"), true)?;
            }
        }
        DefinitionBody::ActionContract(body) => {
            sources.push(action(&mut context, body)?);
            policies.extend(body.policies.clone());
        }
        DefinitionBody::Strategy(body) => {
            context.parameters(&body.parameters, &["parameters".into()])?;
            query::bind_parameters(&mut context)?;
            context.guard(&body.guard, &["guard".into()], true)?;
            strategy_steps(&mut context, &body.steps)?;
        }
        DefinitionBody::PolicyBinding(body) => {
            context.guard(&body.predicate, &["predicate".into()], true)?;
            policies.push(body.policy.clone());
        }
        DefinitionBody::SourceBinding(body) => {
            for (mapping_index, mapping) in body.field_mapping.iter().enumerate() {
                let path = field(&["fieldMapping".into()], mapping_index);
                let target = context.resolve(&mapping.property, &path)?;
                let DefinitionBody::Property(property) = &target.body else { return Err(invalid(&model.reference, &path)); };
                let identity = world_protocol::sources::SourceTransform::Identity;
                let transform = mapping.transform.as_ref().unwrap_or(&identity);
                if !crate::sources::mapping::transform_compatible(transform, &mapping.source_type, &property.value_type) {
                    return Err(invalid(&model.reference, &field(&path, "transform")));
                }
            }
            let external = request.external_contracts.iter().find(|contract| matches!(&contract.kind, ExternalContractKind::Source { binding, .. } if binding == &model.reference))
                .ok_or_else(|| CompileFailure::RequiredProviderMissing { contract: body.capabilities.contract.clone() })?;
            if external.contract != body.capabilities.contract { return Err(CompileFailure::RequiredProviderMissing { contract: body.capabilities.contract.clone() }); }
            let mut required = Vec::new();
            if matches!(body.sync, SyncPolicy::ChangeStream) { required.push(SourceCapability::ChangeStream); }
            if body.capabilities.historical_read { required.push(SourceCapability::History); }
            if body.capabilities.change_stream != ChangeStreamCapability::None { required.push(SourceCapability::ChangeStream); }
            sources.push(SourceRequirement { binding: model.reference.clone(), required });
            if !request.external_contracts.iter().any(|contract| matches!(&contract.kind,
                ExternalContractKind::Policy { policy } if policy.policy_id == body.authority.policy_id && policy.revision == body.authority.revision)) {
                return Err(CompileFailure::PolicyContractMissing { policy_id: body.authority.policy_id.clone() });
            }
        }
        DefinitionBody::ObjectType(_) | DefinitionBody::Property(_) | DefinitionBody::RelationType(_) => {}
        DefinitionBody::Extension(body) => return Err(CompileFailure::RequiredProviderMissing { contract: body.contract.clone() }),
    }
    for policy in &policies { policy_contract(request, policy)?; }
    for requirement in &sources { source_contract(request, requirement, index)?; }
    context.annotations.sort_by(|left, right| left.field.0.cmp(&right.field.0));
    Ok(DefinitionIr {
        reference: model.reference.clone(), body_hash: model.content_digest.clone(), body: model.body.clone(),
        scope: model.scope.clone(), valid_time: model.valid_time.clone(), annotations: context.annotations,
        policy_refs: policies, source_requirements: sources,
    })
}

pub(super) fn action(context: &mut Context<'_>, body: &world_protocol::actions::ActionContract) -> Result<SourceRequirement, CompileFailure> {
    context.parameters(&body.parameters, &["parameters".into()])?;
    query::bind_parameters(context)?;
    for (index, precondition) in body.preconditions.iter().enumerate() { context.guard(precondition, &field(&["preconditions".into()], index), true)?; }
    source_operation(context, &body.source_operation, &body.effects)?;
    context.guard(&body.expected_effect, &["expectedEffect".into()], true)?;
    let symbols = context.symbols.clone();
    query::check(context, &body.verifier.query, &["verifier".into(), "query".into()])?;
    context.guard(&body.verifier.expected, &["verifier".into(), "expected".into()], true)?;
    context.symbols = symbols;
    if let Some(compensation) = &body.compensation {
        let target = context.resolve(&compensation.action, &["compensation".into(), "action".into()])?;
        let DefinitionBody::ActionContract(target) = &target.body else { return Err(invalid(&context.owner.reference, &["compensation".into()])); };
        named_arguments(context, &compensation.arguments, &target.parameters, &["compensation".into(), "arguments".into()])?;
        for (index, condition) in compensation.preconditions.iter().enumerate() { context.guard(condition, &field(&["compensation".into(), "preconditions".into()], index), true)?; }
    }
    if !body.effects.contains(&Effect::ExternalWrite) && !body.writes.is_empty() { return Err(CompileFailure::EffectViolation {
        definition: context.owner.reference.clone(), field: FieldPath(vec!["writes".into()]), effect: Effect::ExternalWrite,
    }); }
    let mut required = Vec::new();
    if matches!(&body.source_operation.mutation, world_protocol::actions::SourceMutation::Update { expected, .. } | world_protocol::actions::SourceMutation::Delete { expected, .. } if !expected.is_empty()) { required.push(SourceCapability::ConditionalWrite); }
    match body.idempotency {
        IdempotencyPolicy::SourceKey => required.push(SourceCapability::Idempotency),
        IdempotencyPolicy::ConditionalWrite => required.push(SourceCapability::ConditionalWrite),
        IdempotencyPolicy::InspectBeforeRetry => required.push(SourceCapability::InspectEffect),
        IdempotencyPolicy::NoAutomaticRetry => {},
    }
    Ok(SourceRequirement { binding: body.source_operation.binding.clone(), required })
}

fn source_operation(
    context: &mut Context<'_>, operation: &world_protocol::actions::SourceOperation, effects: &[Effect],
) -> Result<(), CompileFailure> {
    use world_protocol::actions::SourceMutation;
    let root = ["sourceOperation".into()];
    let target = context.resolve(&operation.binding, &field(&root, "binding"))?;
    let DefinitionBody::SourceBinding(binding) = &target.body else { return Err(invalid(&context.owner.reference, &root)); };
    if operation.resource != binding.resource { return Err(invalid(&context.owner.reference, &field(&root, "resource"))); }
    if !effects.contains(&Effect::ExternalWrite) {
        return Err(CompileFailure::EffectViolation { definition: context.owner.reference.clone(), field: FieldPath(vec!["effects".into()]), effect: Effect::ExternalWrite });
    }
    let groups: Vec<(&str, &[world_protocol::actions::SourceFieldExpression])> = match &operation.mutation {
        SourceMutation::Insert { values } => vec![("values", values)],
        SourceMutation::Update { keys, values, expected } => vec![("keys", keys), ("values", values), ("expected", expected)],
        SourceMutation::Delete { keys, expected } => vec![("keys", keys), ("expected", expected)],
    };
    for (name, fields) in groups {
        let path = field(&field(&root, "mutation"), name);
        if fields.is_empty() && name != "expected" { return Err(invalid(&context.owner.reference, &path)); }
        let mut seen = BTreeSet::new();
        for (index, source_field) in fields.iter().enumerate() {
            let path = field(&path, index);
            if !seen.insert(&source_field.field) || !binding.selected_fields.contains(&source_field.field) { return Err(invalid(&context.owner.reference, &path)); }
            let expected = binding.field_mapping.iter().find(|mapping| mapping.source_field == source_field.field.as_str()).map(|mapping| &mapping.source_type);
            let inferred = query::read_expression(context, &source_field.expression, expected, &field(&path, "expression"))?;
            if inferred.optional || name == "keys" && inferred.nullable { return Err(invalid(&context.owner.reference, &path)); }
            context.declared(&inferred, effects, &path)?;
        }
    }
    Ok(())
}

fn named_arguments(
    context: &mut Context<'_>, arguments: &[world_protocol::actions::NamedExpression], parameters: &[world_protocol::expression::Parameter], path: &[String],
) -> Result<(), CompileFailure> {
    let mut seen = BTreeSet::new();
    for (index, argument) in arguments.iter().enumerate() {
        let path = field(path, index);
        let parameter = parameters.iter().find(|parameter| parameter.id.as_str() == argument.name).ok_or_else(|| invalid(&context.owner.reference, &path))?;
        if !seen.insert(&parameter.id) { return Err(invalid(&context.owner.reference, &path)); }
        let inferred = query::read_expression(context, &argument.expression, Some(&parameter.value_type), &field(&path, "expression"))?;
        if (inferred.nullable && !parameter.nullable) || (inferred.optional && !parameter.optional) { return Err(invalid(&context.owner.reference, &path)); }
    }
    if parameters.iter().any(|parameter| !parameter.optional && !seen.contains(&parameter.id)) { return Err(invalid(&context.owner.reference, path)); }
    Ok(())
}

pub(super) fn strategy_steps(context: &mut Context<'_>, body: &[world_protocol::learning::StrategyStep]) -> Result<(), CompileFailure> {
    let mut steps = BTreeMap::new();
    for step in body {
        if steps.insert(step.id.clone(), step).is_some() { return Err(invalid(&context.owner.reference, &["steps".into()])); }
    }
    let mut complete = BTreeSet::new();
    while complete.len() < steps.len() {
        let ready: Vec<_> = steps.values().filter(|step| !complete.contains(&step.id) && step.depends_on.iter().all(|dependency| complete.contains(dependency))).collect();
        if ready.is_empty() { return Err(invalid(&context.owner.reference, &["steps".into(), "dependsOn".into()])); }
        for step in ready { complete.insert(step.id.clone()); }
    }
    for (index, step) in body.iter().enumerate() {
        let path = field(&["steps".into()], index);
        context.guard(&step.guard, &field(&path, "guard"), true)?;
        match &step.operation {
            StrategyOperation::Query { query: plan } => {
                let symbols = context.symbols.clone();
                query::check(context, plan, &field(&path, "operation"))?;
                context.symbols = symbols;
            }
            StrategyOperation::Function { function, arguments } => {
                let call = ExpressionIr::Call { function: function.clone(), arguments: arguments.clone() };
                query::read_expression(context, &call, None, &field(&path, "operation"))?;
            }
            StrategyOperation::Action { action, arguments } => {
                let target = context.resolve(action, &path)?;
                let DefinitionBody::ActionContract(target) = &target.body else { return Err(invalid(&context.owner.reference, &path)); };
                let mut seen = BTreeSet::new();
                for argument in arguments {
                    let parameter = target.parameters.iter().find(|parameter| parameter.id == argument.parameter_id).ok_or_else(|| invalid(&context.owner.reference, &path))?;
                    if !seen.insert(&parameter.id) { return Err(invalid(&context.owner.reference, &path)); }
                    crate::definitions::validate_value(&parameter.value_type, parameter.nullable, &argument.value).map_err(|failure| CompileFailure::Definition { failure })?;
                }
                if target.parameters.iter().any(|parameter| !parameter.optional && !seen.contains(&parameter.id)) { return Err(invalid(&context.owner.reference, &path)); }
            }
            StrategyOperation::Stop { .. } => {}
        }
    }
    Ok(())
}

pub(super) fn rule(context: &mut Context<'_>, body: &world_protocol::definitions::Rule) -> Result<(), CompileFailure> {
    context.parameters(&body.parameters, &["parameters".into()])?;
    query::bind_parameters(context)?;
    let condition = context.guard(&body.condition, &["condition".into()], true)?;
    context.declared(&condition, &body.effects, &["effects".into()])?;
    rule_conclusion(context, &body.conclusion, &body.effects)
}

fn rule_conclusion(
    context: &mut Context<'_>, conclusion: &world_protocol::definitions::RuleConclusion, effects: &[Effect],
) -> Result<(), CompileFailure> {
    use world_protocol::definitions::RuleConclusion;
    let root = ["conclusion".into()];
    match conclusion {
        RuleConclusion::Attribute { subject, property, value, .. } => {
            let definition = context.resolve(property, &field(&root, "property"))?;
            let DefinitionBody::Property(property) = &definition.body else { return Err(invalid(&context.owner.reference, &root)); };
            let subject_path = field(&root, "subject");
            let subject_type = if property.domain.len() == 1 {
                let domain = context.stable(&property.domain[0], &subject_path)?;
                match domain.body { DefinitionBody::ObjectType(_) => Some(ValueType::Object { type_id: domain.reference.id.clone() }), DefinitionBody::RelationType(_) => Some(ValueType::Relation { type_id: domain.reference.id.clone() }), _ => None }
            } else { None };
            let subject = query::read_expression(context, subject, subject_type.as_ref(), &subject_path)?;
            let id = match &subject.value_type { ValueType::Object { type_id } | ValueType::Relation { type_id } => type_id, _ => return Err(invalid(&context.owner.reference, &subject_path)) };
            if subject.nullable || subject.optional || !property.domain.contains(id) { return Err(invalid(&context.owner.reference, &subject_path)); }
            let value_path = field(&root, "value");
            let value = query::read_expression(context, value, Some(&property.value_type), &value_path)?;
            if value.optional || value.nullable && !property.nullable { return Err(invalid(&context.owner.reference, &value_path)); }
            context.declared(&subject, effects, &subject_path)?;
            context.declared(&value, effects, &value_path)?;
        }
        RuleConclusion::Relation { relation, relation_type, roles, .. } => {
            let definition = context.resolve(relation_type, &field(&root, "relationType"))?;
            let DefinitionBody::RelationType(body) = &definition.body else { return Err(invalid(&context.owner.reference, &root)); };
            let relation_path = field(&root, "relation");
            let relation = query::read_expression(context, relation, Some(&ValueType::Relation { type_id: relation_type.id.clone() }), &relation_path)?;
            if relation.nullable || relation.optional { return Err(invalid(&context.owner.reference, &relation_path)); }
            context.declared(&relation, effects, &relation_path)?;
            let mut counts = BTreeMap::new();
            for (index, role) in roles.iter().enumerate() {
                let path = field(&field(&root, "roles"), index);
                let target = body.roles.iter().find(|target| target.id == role.role).ok_or_else(|| invalid(&context.owner.reference, &path))?;
                let object = query::read_expression(context, &role.object, Some(&ValueType::Object { type_id: target.target_type.id.clone() }), &field(&path, "object"))?;
                if object.nullable || object.optional { return Err(invalid(&context.owner.reference, &path)); }
                context.declared(&object, effects, &path)?;
                *counts.entry(&role.role).or_insert(0_u32) += 1;
            }
            for role in &body.roles {
                let count = counts.get(&role.id).copied().unwrap_or(0);
                if count < role.cardinality.minimum || role.cardinality.maximum.is_some_and(|maximum| count > maximum) {
                    return Err(invalid(&context.owner.reference, &field(&root, "roles")));
                }
            }
        }
    }
    Ok(())
}

fn policy_contract(request: &CompileRequest, policy: &PolicyRef) -> Result<(), CompileFailure> {
    let mut matches = request.external_contracts.iter().filter_map(|contract| match &contract.kind {
        ExternalContractKind::Policy { policy: available } if available.policy_id == policy.policy_id => Some((contract, available)), _ => None,
    });
    let (contract, available) = matches.next().ok_or_else(|| CompileFailure::PolicyContractMissing { policy_id: policy.policy_id.clone() })?;
    if available != policy || contract.contract != policy.contract || matches.next().is_some() {
        return Err(CompileFailure::PolicyContractMismatch { contract: policy.contract.clone() });
    }
    Ok(())
}

fn source_contract(request: &CompileRequest, requirement: &SourceRequirement, index: &BTreeMap<DefinitionRef, &Model>) -> Result<(), CompileFailure> {
    let model = index.get(&requirement.binding).ok_or_else(|| CompileFailure::ReferenceMissing { reference: requirement.binding.clone(), field: FieldPath(vec!["sourceRequirements".into()]) })?;
    let DefinitionBody::SourceBinding(binding) = &model.body else { return Err(invalid(&model.reference, &["sourceRequirements".into()])); };
    let mut contracts = request.external_contracts.iter().filter(|contract| matches!(&contract.kind, ExternalContractKind::Source { binding, .. } if binding == &requirement.binding));
    let contract = contracts.next().ok_or_else(|| CompileFailure::RequiredProviderMissing { contract: binding.capabilities.contract.clone() })?;
    if contracts.next().is_some() || contract.contract != binding.capabilities.contract { return Err(CompileFailure::RequiredProviderMissing { contract: binding.capabilities.contract.clone() }); }
    let ExternalContractKind::Source { capabilities, .. } = &contract.kind else { return Err(CompileFailure::InternalFault); };
    for capability in &requirement.required {
        let declared = match capability {
            // Discovery is declared by the exact external contract, not a SourceCapabilities flag.
            SourceCapability::SchemaDiscovery => true,
            SourceCapability::Snapshot => binding.capabilities.snapshot != world_protocol::sources::SnapshotCapability::None,
            SourceCapability::History => binding.capabilities.historical_read,
            SourceCapability::ChangeStream => binding.capabilities.change_stream != ChangeStreamCapability::None,
            SourceCapability::ConditionalWrite => binding.capabilities.conditional_write,
            SourceCapability::Idempotency => binding.capabilities.idempotency_key,
            SourceCapability::InspectEffect => binding.capabilities.inspect_effect,
            SourceCapability::Filter => binding.capabilities.predicate_pushdown,
            SourceCapability::Sort => binding.capabilities.ordering_pushdown,
            SourceCapability::Aggregate => binding.capabilities.aggregate_pushdown,
        };
        if !declared || !capabilities.contains(capability) { return Err(CompileFailure::SourceCapabilityMissing { binding: requirement.binding.clone(), capability: *capability }); }
    }
    Ok(())
}
