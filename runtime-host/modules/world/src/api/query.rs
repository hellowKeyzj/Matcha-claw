use std::collections::{BTreeMap, BTreeSet};

use world_protocol::{
    api::{MAX_PAGE_ITEMS, MAX_QUERY_DEPTH, MAX_QUERY_NODES},
    definitions::DefinitionFailure,
    expression::{ExpressionIr, TimeWindow},
    failure::{FieldPath, InputFailure, InputLimit},
    wire::{self, CodecFailure},
    ids::{DefinitionRef, ParameterId, WorldRef},
    query::{QueryColumn, QueryNode, QueryRequest},
};

/// Private boundary errors; the adapter projects these into the shared failure contract.
#[derive(Debug)]
pub(crate) enum QueryInputError {
    Decode(CodecFailure),
    Input(InputFailure),
    Definition { field: FieldPath, failure: DefinitionFailure },
}

impl From<InputFailure> for QueryInputError {
    fn from(value: InputFailure) -> Self { Self::Input(value) }
}

pub(crate) fn decode_query_request(bytes: &[u8], max_bytes: usize) -> Result<QueryRequest, QueryInputError> {
    let request = wire::decode(bytes, max_bytes).map_err(QueryInputError::Decode)?;
    validate_query_request(&request)?;
    Ok(request)
}

pub(crate) fn validate_query_request(request: &QueryRequest) -> Result<(), QueryInputError> {
    if request.page.limit == 0 { return Err(invalid("page.limit")); }
    if request.page.limit > MAX_PAGE_ITEMS { return Err(limit(InputLimit::Items, MAX_PAGE_ITEMS as usize)); }
    if request.page.cursor.as_ref().is_some_and(|cursor| cursor.is_empty()) {
        return Err(invalid("page.cursor"));
    }
    if request.query.limit == 0 { return Err(invalid("query.limit")); }
    let mut remaining = MAX_QUERY_NODES;
    let mut parameters = BTreeMap::new();
    for parameter in &request.query.parameters {
        consume(&mut remaining, 0)?;
        if parameters.insert(&parameter.id, parameter).is_some() { return Err(invalid("query.parameters")); }
        crate::definitions::validate_value_type(&parameter.value_type).map_err(|failure| QueryInputError::Definition {
            field: path("query.parameters"), failure,
        })?;
    }
    let mut arguments = BTreeSet::new();
    for argument in &request.arguments {
        consume(&mut remaining, 0)?;
        if !arguments.insert(&argument.parameter_id) { return Err(invalid("arguments")); }
        let parameter = parameters.get(&argument.parameter_id).ok_or_else(|| invalid("arguments.parameterId"))?;
        crate::definitions::validate_value(&parameter.value_type, parameter.nullable, &argument.value)
            .map_err(|failure| QueryInputError::Definition { field: path("arguments.value"), failure })?;
    }
    if parameters.values().any(|parameter| !parameter.optional && !arguments.contains(&parameter.id)) {
        return Err(InputFailure::MissingField { field: path("arguments") }.into());
    }
    let mut expressions = Vec::new();
    columns(&request.query.output, "query.output", &mut expressions, &mut remaining)?;
    let mut nodes = vec![(&request.query.root, 0)];
    while let Some((node, depth)) = nodes.pop() {
        consume(&mut remaining, depth)?;
        match node {
            QueryNode::Objects { type_ref, .. } | QueryNode::Relations { type_ref, .. } => reference(type_ref, &request.world)?,
            QueryNode::Filter { input, predicate } => {
                nodes.push((input, depth + 1));
                expressions.push((predicate, depth + 1));
            }
            QueryNode::Join { left, right, on, .. } => {
                nodes.extend([(left.as_ref(), depth + 1), (right.as_ref(), depth + 1)]);
                expressions.push((on, depth + 1));
            }
            QueryNode::Traverse { input, relation_type, .. } => {
                reference(relation_type, &request.world)?;
                nodes.push((input, depth + 1));
            }
            QueryNode::Project { input, columns: projection } => {
                if projection.is_empty() { return Err(invalid("query.root.columns")); }
                columns(projection, "query.root.columns", &mut expressions, &mut remaining)?;
                nodes.push((input, depth + 1));
            }
            QueryNode::Aggregate { input, group_by, aggregates } => {
                if group_by.is_empty() && aggregates.is_empty() { return Err(invalid("query.root.aggregates")); }
                columns(group_by, "query.root.groupBy", &mut expressions, &mut remaining)?;
                let mut names: BTreeSet<&str> = group_by.iter().map(|column| column.name.as_str()).collect();
                for aggregate in aggregates {
                    consume(&mut remaining, depth + 1)?;
                    if aggregate.name.trim().is_empty() || !names.insert(&aggregate.name) {
                        return Err(invalid("query.root.aggregates.name"));
                    }
                    expressions.push((&aggregate.expression, depth + 1));
                }
                nodes.push((input, depth + 1));
            }
            QueryNode::Sort { input, order } => {
                if order.is_empty() { return Err(invalid("query.root.order")); }
                for order in order { expressions.push((&order.expression, depth + 1)); }
                nodes.push((input, depth + 1));
            }
            QueryNode::Distinct { input } => nodes.push((input, depth + 1)),
            QueryNode::Union { inputs } => {
                if inputs.is_empty() { return Err(invalid("query.root.inputs")); }
                for input in inputs { nodes.push((input, depth + 1)); }
            }
            QueryNode::NotExists { input, correlated, predicate } => {
                nodes.extend([(input.as_ref(), depth + 1), (correlated.as_ref(), depth + 1)]);
                expressions.push((predicate, depth + 1));
            }
            QueryNode::Limit { input, count } => {
                if *count == 0 { return Err(invalid("query.root.count")); }
                nodes.push((input, depth + 1));
            }
        }
        if nodes.len() + expressions.len() > remaining { return Err(limit(InputLimit::Items, MAX_QUERY_NODES)); }
    }
    validate_expressions(expressions, &parameters, &request.world, &mut remaining)
}

fn columns<'a>(
    columns: &'a [QueryColumn], field: &str, expressions: &mut Vec<(&'a ExpressionIr, usize)>, remaining: &mut usize,
) -> Result<(), QueryInputError> {
    let mut names = BTreeSet::new();
    for column in columns {
        consume(remaining, 0)?;
        if column.name.trim().is_empty() || !names.insert(&column.name) { return Err(invalid(field)); }
        expressions.push((&column.expression, 0));
    }
    Ok(())
}

fn validate_expressions(
    mut expressions: Vec<(&ExpressionIr, usize)>,
    parameters: &BTreeMap<&ParameterId, &world_protocol::expression::Parameter>,
    world: &WorldRef, remaining: &mut usize,
) -> Result<(), QueryInputError> {
    while let Some((expression, depth)) = expressions.pop() {
        consume(remaining, depth)?;
        match expression {
            ExpressionIr::Parameter { id } if !parameters.contains_key(id) => return Err(invalid("query.parameters")),
            ExpressionIr::Field { property, .. } => reference(property, world)?,
            ExpressionIr::Call { function, arguments } => {
                reference(function, world)?;
                for argument in arguments { expressions.push((argument, depth + 1)); }
            }
            ExpressionIr::Unary { operand, .. } | ExpressionIr::IsNull { operand } | ExpressionIr::IsKnown { operand } => {
                expressions.push((operand, depth + 1));
            }
            ExpressionIr::Binary { left, right, .. } => expressions.extend([(left.as_ref(), depth + 1), (right.as_ref(), depth + 1)]),
            ExpressionIr::All { terms } | ExpressionIr::Any { terms } => {
                for term in terms { expressions.push((term, depth + 1)); }
            }
            ExpressionIr::If { condition, then_value, else_value } => {
                expressions.extend([(condition.as_ref(), depth + 1), (then_value.as_ref(), depth + 1), (else_value.as_ref(), depth + 1)]);
            }
            ExpressionIr::Aggregate { expression, window, .. } => {
                if let Some(TimeWindow::Sliding { width, timestamp_property }) = window {
                    if width.0 == 0 { return Err(invalid("query.window.width")); }
                    reference(timestamp_property, world)?;
                }
                expressions.push((expression, depth + 1));
            }
            _ => {}
        }
        if expressions.len() > *remaining { return Err(limit(InputLimit::Items, MAX_QUERY_NODES)); }
    }
    Ok(())
}

fn reference(reference: &DefinitionRef, world: &WorldRef) -> Result<(), QueryInputError> {
    if &reference.world != world { return Err(invalid("query.reference.world")); }
    Ok(())
}

fn consume(remaining: &mut usize, depth: usize) -> Result<(), QueryInputError> {
    if depth > MAX_QUERY_DEPTH { return Err(limit(InputLimit::Depth, MAX_QUERY_DEPTH)); }
    if *remaining == 0 { return Err(limit(InputLimit::Items, MAX_QUERY_NODES)); }
    *remaining -= 1;
    Ok(())
}

fn path(field: &str) -> FieldPath { FieldPath(field.split('.').map(str::to_owned).collect()) }
fn invalid(field: &str) -> QueryInputError { InputFailure::InvalidValue { field: path(field) }.into() }
fn limit(dimension: InputLimit, maximum: usize) -> QueryInputError {
    InputFailure::LimitExceeded { limit: dimension, maximum: maximum as u64 }.into()
}
