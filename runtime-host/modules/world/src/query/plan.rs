use std::collections::{BTreeMap, BTreeSet};
use world_protocol::{
    compiler::{DefinitionIr, ExpressionAnnotation}, definitions::{Definition, DefinitionBody},
    expression::ExpressionIr, ids::{DefinitionRef, SymbolId}, query::{QueryIr, QueryNode},
    releases::Release,
};
use super::{QueryError, error::invalid};

pub(super) struct CheckedPlan {
    pub query: QueryIr,
    pub datasets: BTreeSet<DefinitionRef>,
    pub fields: BTreeSet<DefinitionRef>,
    pub annotations: Vec<ExpressionAnnotation>,
    pub functions: BTreeMap<DefinitionRef, DefinitionIr>,
}

pub(super) fn check(query: &QueryIr, release: &Release) -> Result<CheckedPlan, QueryError> {
    let owner = query_owner(&query.root, &release.definitions).ok_or_else(|| invalid("query.root"))?;
    let annotations = crate::compiler::check_query(query, owner, &release.definitions, &release.scopes)?;
    let mut datasets = BTreeSet::new();
    let mut fields = BTreeSet::new();
    let mut expressions: Vec<_> = query.output.iter().map(|column| &column.expression).collect();
    let mut nodes = vec![&query.root];
    while let Some(node) = nodes.pop() {
        match node {
            QueryNode::Objects { type_ref, .. } | QueryNode::Relations { type_ref, .. } => { datasets.insert(type_ref.clone()); },
            QueryNode::Filter { input, predicate } => { nodes.push(input); expressions.push(predicate); },
            QueryNode::Join { left, right, on, .. } => { nodes.extend([left.as_ref(), right.as_ref()]); expressions.push(on); },
            QueryNode::Traverse { input, relation_type, from_role, to_role, .. } => {
                nodes.push(input); datasets.insert(relation_type.clone());
                let definition = release.definitions.iter().find(|entry| entry.reference == *relation_type).ok_or_else(|| invalid("query.traverse"))?;
                let DefinitionBody::RelationType(relation) = &definition.body else { return Err(invalid("query.traverse")); };
                for role in relation.roles.iter().filter(|role| role.id == *from_role || role.id == *to_role) { datasets.insert(role.target_type.clone()); }
            },
            QueryNode::Project { input, columns } => { nodes.push(input); expressions.extend(columns.iter().map(|column| &column.expression)); },
            QueryNode::Aggregate { input, group_by, aggregates } => {
                nodes.push(input); expressions.extend(group_by.iter().map(|column| &column.expression)); expressions.extend(aggregates.iter().map(|aggregate| &aggregate.expression));
            }
            QueryNode::Sort { input, order } => { nodes.push(input); expressions.extend(order.iter().map(|order| &order.expression)); },
            QueryNode::Distinct { input } | QueryNode::Limit { input, .. } => nodes.push(input),
            QueryNode::Union { inputs } => nodes.extend(inputs),
            QueryNode::NotExists { input, correlated, predicate } => { nodes.extend([input.as_ref(), correlated.as_ref()]); expressions.push(predicate); },
        }
    }
    let mut called = BTreeSet::new();
    while let Some(expression) = expressions.pop() {
        match expression {
            ExpressionIr::Field { property, .. } => { fields.insert(property.clone()); },
            ExpressionIr::Unary { operand, .. } | ExpressionIr::IsNull { operand } | ExpressionIr::IsKnown { operand } => expressions.push(operand),
            ExpressionIr::Binary { left, right, .. } => expressions.extend([left.as_ref(), right.as_ref()]),
            ExpressionIr::All { terms } | ExpressionIr::Any { terms } => expressions.extend(terms),
            ExpressionIr::If { condition, then_value, else_value } => expressions.extend([condition.as_ref(), then_value.as_ref(), else_value.as_ref()]),
            ExpressionIr::Call { function, arguments } => {
                expressions.extend(arguments);
                if called.insert(function.clone()) {
                    let definition = release.definitions.iter().find(|definition| definition.reference == *function).ok_or_else(|| invalid("query.function"))?;
                    let DefinitionBody::Function(function) = &definition.body else { return Err(invalid("query.function")); };
                    expressions.push(&function.expression);
                }
            }
            ExpressionIr::Aggregate { expression, window, .. } => {
                expressions.push(expression);
                if let Some(world_protocol::expression::TimeWindow::Sliding { timestamp_property, .. }) = window { fields.insert(timestamp_property.clone()); }
            }
            _ => {},
        }
    }
    let mut functions = BTreeMap::new();
    for reference in called {
        let definition = release.definitions.iter().find(|definition| definition.reference == reference).ok_or_else(|| invalid("query.function"))?;
        let DefinitionBody::Function(function) = &definition.body else { return Err(invalid("query.function")); };
        let annotations = crate::compiler::check_value(&function.expression, &function.result_type, definition, &release.definitions, &release.scopes, &function.parameters,
            &world_protocol::failure::FieldPath(vec!["expression".into()]))?;
        functions.insert(reference, DefinitionIr { reference: definition.reference.clone(), body_hash: definition.content_digest.clone(), body: definition.body.clone(),
            scope: definition.scope.clone(), valid_time: definition.valid_time.clone(), annotations, policy_refs: Vec::new(), source_requirements: Vec::new() });
    }
    Ok(CheckedPlan { query: query.clone(), datasets, fields, annotations, functions })
}

pub(super) fn verifier(query: &QueryIr, release: &Release, reference: &DefinitionRef) -> Result<CheckedPlan, QueryError> {
    let owner = release.definitions.iter().find(|item| item.reference == *reference).ok_or_else(|| invalid("contract"))?;
    let DefinitionBody::ActionContract(action) = &owner.body else { return Err(invalid("contract")); };
    if action.verifier.query != *query { return Err(invalid("verifier.query")); }
    let ir = crate::compiler::check_action(owner, &release.definitions, &release.scopes)?;
    let mut plan = check(query, release)?;
    let (fields, functions) = super::current::expression_closure(&[&action.verifier.expected], release)?;
    plan.fields.extend(fields); plan.functions.extend(functions);
    plan.annotations.extend(ir.annotations);
    for parameter in &action.parameters {
        if !plan.query.parameters.iter().any(|item| item.id == parameter.id) { plan.query.parameters.push(parameter.clone()); }
        if let world_protocol::value::ValueType::Object { type_id } | world_protocol::value::ValueType::Relation { type_id } = &parameter.value_type {
            let definition = release.definitions.iter().find(|item| item.reference.id == *type_id).ok_or_else(|| invalid("verifier.parameters"))?;
            plan.datasets.insert(definition.reference.clone());
        }
    }
    Ok(plan)
}

fn query_owner<'a>(node: &QueryNode, definitions: &'a [Definition<DefinitionBody>]) -> Option<&'a Definition<DefinitionBody>> {
    match node {
        QueryNode::Objects { type_ref, .. } | QueryNode::Relations { type_ref, .. } => definitions.iter().find(|definition| definition.reference == *type_ref),
        QueryNode::Filter { input, .. } | QueryNode::Traverse { input, .. } | QueryNode::Project { input, .. }
        | QueryNode::Aggregate { input, .. } | QueryNode::Sort { input, .. } | QueryNode::Distinct { input } | QueryNode::Limit { input, .. }
        | QueryNode::NotExists { input, .. } => query_owner(input, definitions),
        QueryNode::Join { left, .. } => query_owner(left, definitions),
        QueryNode::Union { inputs } => inputs.first().and_then(|input| query_owner(input, definitions)),
    }
}

pub(super) fn bindings(node: &QueryNode, release: &Release) -> Result<BTreeMap<SymbolId, DefinitionRef>, QueryError> {
    let mut result = BTreeMap::new();
    let mut nodes = vec![node];
    while let Some(node) = nodes.pop() {
        match node {
            QueryNode::Objects { symbol, type_ref } | QueryNode::Relations { symbol, type_ref } => { result.insert(symbol.clone(), type_ref.clone()); },
            QueryNode::Traverse { input, target, relation_type, to_role, .. } => {
                let definition = release.definitions.iter().find(|definition| definition.reference == *relation_type).ok_or_else(|| invalid("query.traverse"))?;
                let DefinitionBody::RelationType(relation) = &definition.body else { return Err(invalid("query.traverse")); };
                let role = relation.roles.iter().find(|role| role.id == *to_role).ok_or_else(|| invalid("query.traverse"))?;
                result.insert(target.clone(), role.target_type.clone()); nodes.push(input);
            },
            QueryNode::Join { left, right, .. } => nodes.extend([left.as_ref(), right.as_ref()]),
            QueryNode::NotExists { input, .. } => nodes.push(input),
            QueryNode::Filter { input, .. } | QueryNode::Project { input, .. } | QueryNode::Aggregate { input, .. } | QueryNode::Sort { input, .. }
            | QueryNode::Distinct { input } | QueryNode::Limit { input, .. } => nodes.push(input),
            QueryNode::Union { inputs } => nodes.extend(inputs),
        }
    }
    Ok(result)
}
pub(super) fn column_names(node: &QueryNode) -> Vec<String> {
    match node {
        QueryNode::Objects { .. } | QueryNode::Relations { .. } => Vec::new(),
        QueryNode::Project { columns, .. } => columns.iter().map(|column| column.name.clone()).collect(),
        QueryNode::Aggregate { group_by, aggregates, .. } => group_by.iter().map(|column| column.name.clone()).chain(aggregates.iter().map(|column| column.name.clone())).collect(),
        QueryNode::Join { left, right, .. } => column_names(left).into_iter().chain(column_names(right)).collect(),
        QueryNode::Union { inputs } => inputs.first().map(column_names).unwrap_or_default(),
        QueryNode::Filter { input, .. } | QueryNode::Traverse { input, .. } | QueryNode::Sort { input, .. }
        | QueryNode::Distinct { input } | QueryNode::NotExists { input, .. } | QueryNode::Limit { input, .. } => column_names(input),
    }
}
