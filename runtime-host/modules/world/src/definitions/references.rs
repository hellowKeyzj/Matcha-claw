use std::collections::BTreeSet;

use world_protocol::{
    definitions::{DefinitionBody, DefinitionKind},
    expression::{ExpressionIr, TimeWindow},
    ids::{DefinitionId, DefinitionRef, ResourceRef},
    learning::StrategyOperation,
    query::{QueryIr, QueryNode},
    value::{Value, ValueType},
};

pub(crate) fn definition_references(body: &DefinitionBody) -> Vec<DefinitionRef> {
    let mut references = BTreeSet::new();
    visit_body(body, &mut |reference| {
        references.insert(reference.clone());
    });
    references.into_iter().collect()
}

pub(crate) fn query_references(query: &QueryIr) -> Vec<DefinitionRef> {
    let mut references = BTreeSet::new();
    visit_query(query, &mut |reference| {
        references.insert(reference.clone());
    });
    references.into_iter().collect()
}

pub(crate) fn expression_references(expression: &ExpressionIr) -> Vec<DefinitionRef> {
    let mut references = BTreeSet::new();
    visit_expression(expression, &mut |reference| {
        references.insert(reference.clone());
    });
    references.into_iter().collect()
}

pub(crate) fn value_type_resources(value_type: &ValueType) -> Vec<ResourceRef> {
    let mut types = Vec::new();
    visit_value_type(value_type, &mut types);
    let mut resources: Vec<_> = types
        .into_iter()
        .map(|(id, _)| ResourceRef::Definition { id })
        .collect();
    resources.sort_unstable();
    resources.dedup();
    resources
}

pub(crate) fn expression_resources(expression: &ExpressionIr) -> Vec<ResourceRef> {
    let mut references = Vec::new();
    let mut values = Vec::new();
    visit_expression_values(
        expression,
        &mut |reference| {
            references.push(ResourceRef::Definition {
                id: reference.id.clone(),
            })
        },
        &mut |value| super::value_resources(value, &mut values),
    );
    references.extend(values);
    references.sort_unstable();
    references.dedup();
    references
}

pub(crate) fn query_resources(query: &QueryIr) -> Vec<ResourceRef> {
    let mut references = Vec::new();
    let mut values = Vec::new();
    visit_query_values(
        query,
        &mut |reference| {
            references.push(ResourceRef::Definition {
                id: reference.id.clone(),
            })
        },
        &mut |value| super::value_resources(value, &mut values),
    );
    references.extend(values);
    for parameter in &query.parameters {
        let mut types = Vec::new();
        visit_value_type(&parameter.value_type, &mut types);
        references.extend(
            types
                .into_iter()
                .map(|(id, _)| ResourceRef::Definition { id }),
        );
    }
    references.sort_unstable();
    references.dedup();
    references
}

pub(super) fn visit_expression(expression: &ExpressionIr, visit: &mut impl FnMut(&DefinitionRef)) {
    visit_expression_values(expression, visit, &mut |_| {});
}

fn visit_expression_values(
    expression: &ExpressionIr,
    visit: &mut impl FnMut(&DefinitionRef),
    value: &mut impl FnMut(&Value),
) {
    let mut pending = vec![expression];
    while let Some(expression) = pending.pop() {
        match expression {
            ExpressionIr::Literal { value: literal } => value(literal),
            ExpressionIr::Field { property, .. } => visit(property),
            ExpressionIr::Call {
                function,
                arguments,
            } => {
                visit(function);
                pending.extend(arguments);
            }
            ExpressionIr::Unary { operand, .. }
            | ExpressionIr::IsNull { operand }
            | ExpressionIr::IsKnown { operand } => pending.push(operand),
            ExpressionIr::Binary { left, right, .. } => {
                pending.push(left);
                pending.push(right);
            }
            ExpressionIr::All { terms } | ExpressionIr::Any { terms } => pending.extend(terms),
            ExpressionIr::If {
                condition,
                then_value,
                else_value,
            } => pending.extend([condition.as_ref(), then_value.as_ref(), else_value.as_ref()]),
            ExpressionIr::Aggregate {
                expression, window, ..
            } => {
                pending.push(expression);
                if let Some(window) = window {
                    visit_window(window, visit);
                }
            }
            _ => {}
        }
    }
}

fn visit_window(window: &TimeWindow, visit: &mut impl FnMut(&DefinitionRef)) {
    if let TimeWindow::Sliding {
        timestamp_property, ..
    } = window
    {
        visit(timestamp_property);
    }
}

pub(super) fn visit_query(query: &QueryIr, visit: &mut impl FnMut(&DefinitionRef)) {
    visit_query_values(query, visit, &mut |_| {});
}

fn visit_query_values(
    query: &QueryIr,
    visit: &mut impl FnMut(&DefinitionRef),
    value: &mut impl FnMut(&Value),
) {
    for column in &query.output {
        visit_expression_values(&column.expression, visit, value);
    }
    let mut pending = vec![&query.root];
    while let Some(node) = pending.pop() {
        match node {
            QueryNode::Objects { type_ref, .. } | QueryNode::Relations { type_ref, .. } => {
                visit(type_ref)
            }
            QueryNode::Filter { input, predicate } => {
                pending.push(input);
                visit_expression_values(predicate, visit, value);
            }
            QueryNode::Join {
                left, right, on, ..
            } => {
                pending.extend([left.as_ref(), right.as_ref()]);
                visit_expression_values(on, visit, value);
            }
            QueryNode::Traverse {
                input,
                relation_type,
                ..
            } => {
                pending.push(input);
                visit(relation_type);
            }
            QueryNode::Project { input, columns } => {
                pending.push(input);
                for column in columns {
                    visit_expression_values(&column.expression, visit, value);
                }
            }
            QueryNode::Aggregate {
                input,
                group_by,
                aggregates,
            } => {
                pending.push(input);
                for column in group_by {
                    visit_expression_values(&column.expression, visit, value);
                }
                for aggregate in aggregates {
                    visit_expression_values(&aggregate.expression, visit, value);
                }
            }
            QueryNode::Sort { input, order } => {
                pending.push(input);
                for order in order {
                    visit_expression_values(&order.expression, visit, value);
                }
            }
            QueryNode::Distinct { input } | QueryNode::Limit { input, .. } => pending.push(input),
            QueryNode::Union { inputs } => pending.extend(inputs),
            QueryNode::NotExists {
                input,
                correlated,
                predicate,
            } => {
                pending.extend([input.as_ref(), correlated.as_ref()]);
                visit_expression_values(predicate, visit, value);
            }
        }
    }
}

pub(crate) fn definition_resources(body: &DefinitionBody) -> Vec<ResourceRef> {
    let mut references = Vec::new();
    let mut values = Vec::new();
    visit_body_values(
        body,
        &mut |reference| {
            references.push(ResourceRef::Definition {
                id: reference.id.clone(),
            })
        },
        &mut |value| super::value_resources(value, &mut values),
    );
    references.extend(values);
    references.extend(
        stable_type_references(body)
            .into_iter()
            .map(|(id, _)| ResourceRef::Definition { id }),
    );
    if let DefinitionBody::PolicyBinding(binding) = body {
        references.extend(binding.applies_to.iter().cloned());
    }
    references.sort_unstable();
    references.dedup();
    references
}

fn visit_body(body: &DefinitionBody, visit: &mut impl FnMut(&DefinitionRef)) {
    visit_body_values(body, visit, &mut |_| {});
}

fn visit_body_values(
    body: &DefinitionBody,
    visit: &mut impl FnMut(&DefinitionRef),
    literal: &mut impl FnMut(&Value),
) {
    match body {
        DefinitionBody::ObjectType(body) => {
            for reference in body
                .identity_rule
                .iter()
                .chain(body.properties.iter())
                .chain(body.interfaces.iter())
                .chain(body.state_model.iter())
                .chain(body.source_bindings.iter())
            {
                visit(reference);
            }
        }
        DefinitionBody::Property(_) => {}
        DefinitionBody::Extension(body) => literal(&body.payload),
        DefinitionBody::RelationType(body) => {
            for role in &body.roles {
                visit(&role.target_type);
            }
            for reference in &body.properties {
                visit(reference);
            }
        }
        DefinitionBody::Facet(body) => {
            visit_expression_values(&body.applicability, visit, literal);
            for reference in &body.definitions {
                visit(reference);
            }
        }
        DefinitionBody::ConceptView(body) => visit_query_values(&body.query, visit, literal),
        DefinitionBody::Rule(body) => {
            visit_expression_values(&body.condition, visit, literal);
            match &body.conclusion {
                world_protocol::definitions::RuleConclusion::Attribute {
                    subject,
                    property,
                    value,
                    ..
                } => {
                    visit(property);
                    visit_expression_values(subject, visit, literal);
                    visit_expression_values(value, visit, literal);
                }
                world_protocol::definitions::RuleConclusion::Relation {
                    relation,
                    relation_type,
                    roles,
                    ..
                } => {
                    visit(relation_type);
                    visit_expression_values(relation, visit, literal);
                    for role in roles {
                        visit_expression_values(&role.object, visit, literal);
                    }
                }
            }
        }
        DefinitionBody::Metric(body) => {
            visit_expression_values(&body.expression, visit, literal);
            for reference in &body.grain {
                visit(reference);
            }
            if let Some(window) = &body.window {
                visit_window(window, visit);
            }
        }
        DefinitionBody::Function(body) => visit_expression_values(&body.expression, visit, literal),
        DefinitionBody::StateModel(body) => {
            visit(&body.property);
            for transition in &body.transitions {
                visit_expression_values(&transition.guard, visit, literal);
                if let Some(action) = &transition.action {
                    visit(action);
                }
            }
        }
        DefinitionBody::ActionContract(body) => {
            for target in &body.targets {
                visit(&target.type_ref);
            }
            for reference in body.reads.iter().chain(body.writes.iter()) {
                visit(reference);
            }
            for expression in &body.preconditions {
                visit_expression_values(expression, visit, literal);
            }
            visit(&body.source_operation.binding);
            let fields: Vec<_> = match &body.source_operation.mutation {
                world_protocol::actions::SourceMutation::Insert { values } => {
                    values.iter().collect()
                }
                world_protocol::actions::SourceMutation::Update {
                    keys,
                    values,
                    expected,
                } => keys.iter().chain(values).chain(expected).collect(),
                world_protocol::actions::SourceMutation::Delete { keys, expected } => {
                    keys.iter().chain(expected).collect()
                }
            };
            for field in fields {
                visit_expression_values(&field.expression, visit, literal);
            }
            visit_expression_values(&body.expected_effect, visit, literal);
            visit_query_values(&body.verifier.query, visit, literal);
            visit_expression_values(&body.verifier.expected, visit, literal);
            if let Some(compensation) = &body.compensation {
                visit(&compensation.action);
                for argument in &compensation.arguments {
                    visit_expression_values(&argument.expression, visit, literal);
                }
                for expression in &compensation.preconditions {
                    visit_expression_values(expression, visit, literal);
                }
            }
        }
        DefinitionBody::Strategy(body) => {
            visit_expression_values(&body.guard, visit, literal);
            if let Some(fallback) = &body.fallback {
                visit(fallback);
            }
            for step in &body.steps {
                visit_expression_values(&step.guard, visit, literal);
                match &step.operation {
                    StrategyOperation::Query { query } => visit_query_values(query, visit, literal),
                    StrategyOperation::Action { action, arguments } => {
                        visit(action);
                        for argument in arguments {
                            literal(&argument.value);
                        }
                    }
                    StrategyOperation::Function {
                        function,
                        arguments,
                    } => {
                        visit(function);
                        for argument in arguments {
                            visit_expression_values(argument, visit, literal);
                        }
                    }
                    StrategyOperation::Stop { .. } => {}
                }
            }
        }
        DefinitionBody::PolicyBinding(body) => {
            visit_expression_values(&body.predicate, visit, literal)
        }
        DefinitionBody::SourceBinding(body) => {
            for mapping in &body.field_mapping {
                visit(&mapping.property);
            }
        }
    }
}

pub(super) fn stable_type_references(
    body: &DefinitionBody,
) -> Vec<(DefinitionId, Option<DefinitionKind>)> {
    let mut result = Vec::new();
    let mut types = Vec::new();
    let mut parameters = Vec::new();
    match body {
        DefinitionBody::Property(body) => {
            result.extend(body.domain.iter().cloned().map(|id| (id, None)));
            types.push(&body.value_type);
        }
        DefinitionBody::Facet(body) => {
            result.extend(body.attaches_to.iter().cloned().map(|id| (id, None)))
        }
        DefinitionBody::ConceptView(body) => {
            result.extend(body.inputs.iter().cloned().map(|id| (id, None)));
            parameters.extend(&body.query.parameters);
        }
        DefinitionBody::Rule(body) => parameters.extend(&body.parameters),
        DefinitionBody::Metric(body) => {
            parameters.extend(&body.parameters);
            types.push(&body.result_type);
        }
        DefinitionBody::Function(body) => {
            parameters.extend(&body.parameters);
            types.push(&body.result_type);
        }
        DefinitionBody::ActionContract(body) => {
            parameters.extend(&body.parameters);
            parameters.extend(&body.verifier.query.parameters);
            types.push(&body.result_type);
            for policy in &body.policies {
                for obligation in &policy.obligations {
                    if let world_protocol::authorization::PolicyObligation::Redact { fields } =
                        obligation
                    {
                        result.extend(
                            fields
                                .iter()
                                .cloned()
                                .map(|id| (id, Some(DefinitionKind::Property))),
                        );
                    }
                }
            }
        }
        DefinitionBody::Strategy(body) => {
            parameters.extend(&body.parameters);
            for step in &body.steps {
                if let StrategyOperation::Query { query } = &step.operation {
                    parameters.extend(&query.parameters);
                }
            }
        }
        DefinitionBody::PolicyBinding(body) => {
            result.extend(
                body.applies_to
                    .iter()
                    .filter_map(|resource| match resource {
                        ResourceRef::Definition { id } => Some((id.clone(), None)),
                        _ => None,
                    }),
            );
            for obligation in &body.policy.obligations {
                if let world_protocol::authorization::PolicyObligation::Redact { fields } =
                    obligation
                {
                    result.extend(fields.iter().cloned().map(|id| (id, None)));
                }
            }
        }
        DefinitionBody::SourceBinding(body) => {
            result.push((body.identity_mapping.type_id.clone(), None));
            result.extend(
                body.authority
                    .fields
                    .iter()
                    .cloned()
                    .map(|id| (id, Some(DefinitionKind::Property))),
            );
            types.extend(
                body.field_mapping
                    .iter()
                    .map(|mapping| &mapping.source_type),
            );
        }
        _ => {}
    }
    types.extend(parameters.iter().map(|parameter| &parameter.value_type));
    for value_type in types {
        visit_value_type(value_type, &mut result);
    }
    result.sort_unstable();
    result.dedup();
    result
}

fn visit_value_type(
    value_type: &ValueType,
    result: &mut Vec<(DefinitionId, Option<DefinitionKind>)>,
) {
    let mut types = vec![value_type];
    while let Some(value_type) = types.pop() {
        match value_type {
            ValueType::Object { type_id } => {
                result.push((type_id.clone(), Some(DefinitionKind::ObjectType)))
            }
            ValueType::Relation { type_id } => {
                result.push((type_id.clone(), Some(DefinitionKind::RelationType)))
            }
            ValueType::List { element, .. } => types.push(element),
            ValueType::Record { fields } => {
                types.extend(fields.iter().map(|field| &field.value_type))
            }
            _ => {}
        }
    }
}
