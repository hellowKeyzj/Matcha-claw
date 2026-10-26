use world_protocol::{
    actions::SourceMutation,
    authorization::PolicyObligation,
    definitions::{Definition, DefinitionBody, DefinitionLifecycle, RuleConclusion},
    expression::{ExpressionIr, Parameter, TimeWindow},
    facts::{AssertionOrigin, Claim, ObservationDraft},
    ids::{DefinitionId, DefinitionRef, ResourceRef},
    learning::{SemanticOperation, StrategyOperation},
    query::{QueryIr, QueryNode},
    value::ValueType,
};

pub(in crate::learning) trait Visitor {
    fn exact(&mut self, reference: &mut DefinitionRef);
    fn stable(&mut self, id: &mut DefinitionId);
}

pub(in crate::learning) fn model(definition: &mut Definition<DefinitionBody>, visit: &mut impl Visitor) {
    for reference in &mut definition.dependencies { visit.exact(reference); }
    if let Some(previous) = &mut definition.previous_ref { visit.exact(previous); }
    match &mut definition.lifecycle {
        DefinitionLifecycle::Available => {}
        DefinitionLifecycle::Deprecated { replacements, .. }
        | DefinitionLifecycle::Split { replacements, .. } => {
            for reference in replacements { visit.exact(reference); }
        }
    }
    match &mut definition.body {
        DefinitionBody::ObjectType(body) => {
            for reference in body.identity_rule.iter_mut().chain(&mut body.properties)
                .chain(&mut body.interfaces).chain(body.state_model.iter_mut())
                .chain(&mut body.source_bindings) { visit.exact(reference); }
        }
        DefinitionBody::Property(body) => {
            for id in &mut body.domain { visit.stable(id); }
            value_type(&mut body.value_type, visit);
        }
        DefinitionBody::Extension(_) => {
            // ContractRef and Value carry no definition identities; explicit dependencies were visited above.
        }
        DefinitionBody::RelationType(body) => {
            for role in &mut body.roles { visit.exact(&mut role.target_type); }
            for reference in &mut body.properties { visit.exact(reference); }
        }
        DefinitionBody::Facet(body) => {
            for id in &mut body.attaches_to { visit.stable(id); }
            expression(&mut body.applicability, visit);
            for reference in &mut body.definitions { visit.exact(reference); }
        }
        DefinitionBody::ConceptView(body) => {
            for id in &mut body.inputs { visit.stable(id); }
            query(&mut body.query, visit);
        }
        DefinitionBody::Rule(body) => {
            parameters(&mut body.parameters, visit);
            expression(&mut body.condition, visit);
            match &mut body.conclusion {
                RuleConclusion::Attribute { subject, property, value, .. } => {
                    expression(subject, visit);
                    visit.exact(property);
                    expression(value, visit);
                }
                RuleConclusion::Relation { relation, relation_type, roles, .. } => {
                    expression(relation, visit);
                    visit.exact(relation_type);
                    for role in roles { expression(&mut role.object, visit); }
                }
            }
        }
        DefinitionBody::Metric(body) => {
            parameters(&mut body.parameters, visit);
            expression(&mut body.expression, visit);
            value_type(&mut body.result_type, visit);
            for reference in &mut body.grain { visit.exact(reference); }
            if let Some(value) = &mut body.window { window(value, visit); }
        }
        DefinitionBody::Function(body) => {
            parameters(&mut body.parameters, visit);
            value_type(&mut body.result_type, visit);
            expression(&mut body.expression, visit);
        }
        DefinitionBody::StateModel(body) => {
            visit.exact(&mut body.property);
            for transition in &mut body.transitions {
                expression(&mut transition.guard, visit);
                if let Some(action) = &mut transition.action { visit.exact(action); }
            }
        }
        DefinitionBody::ActionContract(body) => {
            parameters(&mut body.parameters, visit);
            value_type(&mut body.result_type, visit);
            for target in &mut body.targets { visit.exact(&mut target.type_ref); }
            for reference in body.reads.iter_mut().chain(&mut body.writes) { visit.exact(reference); }
            for value in &mut body.preconditions { expression(value, visit); }
            for policy in &mut body.policies { obligations(&mut policy.obligations, visit); }
            visit.exact(&mut body.source_operation.binding);
            match &mut body.source_operation.mutation {
                SourceMutation::Insert { values } => {
                    for field in values { expression(&mut field.expression, visit); }
                }
                SourceMutation::Update { keys, values, expected } => {
                    for field in keys.iter_mut().chain(values).chain(expected) {
                        expression(&mut field.expression, visit);
                    }
                }
                SourceMutation::Delete { keys, expected } => {
                    for field in keys.iter_mut().chain(expected) { expression(&mut field.expression, visit); }
                }
            }
            expression(&mut body.expected_effect, visit);
            query(&mut body.verifier.query, visit);
            expression(&mut body.verifier.expected, visit);
            if let Some(compensation) = &mut body.compensation {
                visit.exact(&mut compensation.action);
                for argument in &mut compensation.arguments { expression(&mut argument.expression, visit); }
                for value in &mut compensation.preconditions { expression(value, visit); }
            }
        }
        DefinitionBody::Strategy(body) => {
            parameters(&mut body.parameters, visit);
            expression(&mut body.guard, visit);
            if let Some(fallback) = &mut body.fallback { visit.exact(fallback); }
            for step in &mut body.steps {
                expression(&mut step.guard, visit);
                strategy_operation(&mut step.operation, visit);
            }
        }
        DefinitionBody::PolicyBinding(body) => {
            obligations(&mut body.policy.obligations, visit);
            for target in &mut body.applies_to { resource(target, visit); }
            expression(&mut body.predicate, visit);
        }
        DefinitionBody::SourceBinding(body) => {
            visit.stable(&mut body.identity_mapping.type_id);
            for field in &mut body.field_mapping {
                visit.exact(&mut field.property);
                value_type(&mut field.source_type, visit);
            }
            for id in &mut body.authority.fields { visit.stable(id); }
        }
    }
}

pub(in crate::learning) fn operation(operation: &mut SemanticOperation, visit: &mut impl Visitor) {
    match operation {
        SemanticOperation::NoOp { .. } => {}
        SemanticOperation::AttachEvidence { target, .. } => resource(target, visit),
        SemanticOperation::EnrichAnnotation { target, .. } => visit.exact(target),
        SemanticOperation::CreateDefinition { definition } => {
            visit.exact(&mut definition.reference);
            model(definition, visit);
        }
        SemanticOperation::RefineDefinition { previous, replacement }
        | SemanticOperation::SupersedeRule { previous, replacement } => {
            visit.exact(previous);
            visit.exact(&mut replacement.reference);
            model(replacement, visit);
        }
        SemanticOperation::ScopeDefinition { previous, .. } => visit.exact(previous),
        SemanticOperation::DeprecateDefinition { previous, replacements, .. } => {
            visit.exact(previous);
            for reference in replacements { visit.exact(reference); }
        }
        SemanticOperation::LinkExisting { source, target, .. } => {
            visit.exact(source);
            visit.exact(target);
        }
        SemanticOperation::MergeAliases { sources, target, .. } => {
            for reference in sources { visit.exact(reference); }
            visit.exact(target);
        }
        SemanticOperation::SplitDefinition { previous, replacements, partition } => {
            visit.exact(previous);
            for replacement in replacements {
                visit.exact(&mut replacement.reference);
                model(replacement, visit);
            }
            for part in partition {
                visit.stable(&mut part.replacement);
                expression(&mut part.predicate, visit);
            }
        }
    }
}

pub(in crate::learning) fn observation(observation: &mut ObservationDraft, visit: &mut impl Visitor) {
    match &mut observation.claim {
        Claim::Attribute(claim) => visit.exact(&mut claim.property),
        Claim::Relation(claim) => visit.exact(&mut claim.relation_type),
    }
    match &mut observation.origin {
        AssertionOrigin::Source { binding, authority, .. } => {
            visit.exact(binding);
            for field in &mut authority.fields { visit.stable(field); }
        }
        AssertionOrigin::Derived {} | AssertionOrigin::HumanObservation { .. }
        | AssertionOrigin::Extraction { .. } => {}
    }
}

fn resource(resource: &mut ResourceRef, visit: &mut impl Visitor) {
    if let ResourceRef::Definition { id } = resource { visit.stable(id); }
}
fn obligations(obligations: &mut [PolicyObligation], visit: &mut impl Visitor) {
    for obligation in obligations {
        if let PolicyObligation::Redact { fields } = obligation {
            for field in fields { visit.stable(field); }
        }
    }
}
fn parameters(parameters: &mut [Parameter], visit: &mut impl Visitor) {
    for parameter in parameters { value_type(&mut parameter.value_type, visit); }
}
fn value_type(value: &mut ValueType, visit: &mut impl Visitor) {
    match value {
        ValueType::Object { type_id } | ValueType::Relation { type_id } => visit.stable(type_id),
        ValueType::List { element, .. } => value_type(element, visit),
        ValueType::Record { fields } => {
            for field in fields { value_type(&mut field.value_type, visit); }
        }
        _ => {}
    }
}
fn window(window: &mut TimeWindow, visit: &mut impl Visitor) {
    if let TimeWindow::Sliding { timestamp_property, .. } = window { visit.exact(timestamp_property); }
}
fn expression(value: &mut ExpressionIr, visit: &mut impl Visitor) {
    match value {
        ExpressionIr::Field { property, .. } => visit.exact(property),
        ExpressionIr::Call { function, arguments } => {
            visit.exact(function);
            for argument in arguments { expression(argument, visit); }
        }
        ExpressionIr::Unary { operand, .. } | ExpressionIr::IsNull { operand }
        | ExpressionIr::IsKnown { operand } => expression(operand, visit),
        ExpressionIr::Binary { left, right, .. } => {
            expression(left, visit);
            expression(right, visit);
        }
        ExpressionIr::All { terms } | ExpressionIr::Any { terms } => {
            for term in terms { expression(term, visit); }
        }
        ExpressionIr::If { condition, then_value, else_value } => {
            expression(condition, visit);
            expression(then_value, visit);
            expression(else_value, visit);
        }
        ExpressionIr::Aggregate { expression: value, window: time, .. } => {
            expression(value, visit);
            if let Some(time) = time { window(time, visit); }
        }
        ExpressionIr::Literal { .. } | ExpressionIr::Parameter { .. } | ExpressionIr::Role { .. } => {}
    }
}
fn query(query: &mut QueryIr, visit: &mut impl Visitor) {
    parameters(&mut query.parameters, visit);
    for column in &mut query.output { expression(&mut column.expression, visit); }
    query_node(&mut query.root, visit);
}
fn query_node(node: &mut QueryNode, visit: &mut impl Visitor) {
    match node {
        QueryNode::Objects { type_ref, .. } | QueryNode::Relations { type_ref, .. } => visit.exact(type_ref),
        QueryNode::Filter { input, predicate } => {
            query_node(input, visit);
            expression(predicate, visit);
        }
        QueryNode::Join { left, right, on, .. } => {
            query_node(left, visit);
            query_node(right, visit);
            expression(on, visit);
        }
        QueryNode::Traverse { input, relation_type, .. } => {
            query_node(input, visit);
            visit.exact(relation_type);
        }
        QueryNode::Project { input, columns } => {
            query_node(input, visit);
            for column in columns { expression(&mut column.expression, visit); }
        }
        QueryNode::Aggregate { input, group_by, aggregates } => {
            query_node(input, visit);
            for column in group_by { expression(&mut column.expression, visit); }
            for aggregate in aggregates { expression(&mut aggregate.expression, visit); }
        }
        QueryNode::Sort { input, order } => {
            query_node(input, visit);
            for order in order { expression(&mut order.expression, visit); }
        }
        QueryNode::Distinct { input } | QueryNode::Limit { input, .. } => query_node(input, visit),
        QueryNode::Union { inputs } => {
            for input in inputs { query_node(input, visit); }
        }
        QueryNode::NotExists { input, correlated, predicate } => {
            query_node(input, visit);
            query_node(correlated, visit);
            expression(predicate, visit);
        }
    }
}
fn strategy_operation(operation: &mut StrategyOperation, visit: &mut impl Visitor) {
    match operation {
        StrategyOperation::Query { query: value } => query(value, visit),
        StrategyOperation::Action { action, .. } => visit.exact(action),
        StrategyOperation::Function { function, arguments } => {
            visit.exact(function);
            for argument in arguments { expression(argument, visit); }
        }
        StrategyOperation::Stop { .. } => {}
    }
}
