use std::collections::{BTreeMap, BTreeSet};

use world_protocol::{
    compiler::CompileFailure,
    definitions::{DefinitionBody, DefinitionKind},
    expression::ExpressionIr,
    ids::SymbolId,
    query::{JoinKind, QueryColumn, QueryIr, QueryNode},
    value::ValueType,
};

use super::{expression::{aggregate, Context, Inferred, Symbol}, field, invalid, types};

pub(super) fn check(context: &mut Context<'_>, query: &QueryIr, path: &[String]) -> Result<Vec<(String, Inferred)>, CompileFailure> {
    if query.limit == 0 { return Err(invalid(&context.owner.reference, &field(path, "limit"))); }
    let saved_parameters = context.parameters.clone();
    let mut parameter_ids = BTreeSet::new();
    for parameter in &query.parameters {
        if !parameter_ids.insert(&parameter.id) {
            return Err(invalid(&context.owner.reference, &field(path, "parameters")));
        }
        if let Some(existing) = context.parameters.get(&parameter.id) {
            if existing != parameter { return Err(invalid(&context.owner.reference, &field(path, "parameters"))); }
        } else {
            context.parameters(std::slice::from_ref(parameter), &field(path, "parameters"))?;
        }
    }
    let mut remaining = 65_536;
    let schema = node(context, &query.root, &field(path, "root"), 0, &mut remaining)?;
    let result = if query.output.is_empty() { schema } else { columns(context, &query.output, &field(path, "output"))? };
    if result.is_empty() { return Err(invalid(&context.owner.reference, &field(path, "output"))); }
    context.parameters = saved_parameters;
    Ok(result)
}

fn node(
    context: &mut Context<'_>, query: &QueryNode, path: &[String], depth: usize, remaining: &mut usize,
) -> Result<Vec<(String, Inferred)>, CompileFailure> {
    if depth > 64 || *remaining == 0 { return Err(world_protocol::compiler::CompileFailure::LimitExceeded { field: world_protocol::failure::FieldPath(path.to_vec()) }); }
    *remaining -= 1;
    match query {
        QueryNode::Objects { type_ref, symbol } | QueryNode::Relations { type_ref, symbol } => {
            let definition = context.resolve(type_ref, path)?;
            let expected = if matches!(query, QueryNode::Objects { .. }) { DefinitionKind::ObjectType } else { DefinitionKind::RelationType };
            if definition.body.kind() != expected { return Err(invalid(&context.owner.reference, path)); }
            context.bind(symbol, type_ref, false, path)?;
            Ok(Vec::new())
        }
        QueryNode::Filter { input, predicate } => {
            let schema = node(context, input, &field(path, "input"), depth + 1, remaining)?;
            context.guard(predicate, &field(path, "predicate"), false)?;
            Ok(schema)
        }
        QueryNode::Join { left, right, on, join_kind } => {
            let mut schema = node(context, left, &field(path, "left"), depth + 1, remaining)?;
            let left_symbols: BTreeSet<_> = context.symbols.keys().cloned().collect();
            let right_schema = node(context, right, &field(path, "right"), depth + 1, remaining)?;
            context.guard(on, &field(path, "on"), false)?;
            if *join_kind == JoinKind::Left {
                for (name, symbol) in &mut context.symbols { if !left_symbols.contains(name) { symbol.optional = true; } }
            }
            for (name, mut column) in right_schema {
                if schema.iter().any(|(existing, _)| existing == &name) { return Err(invalid(&context.owner.reference, path)); }
                column.optional |= *join_kind == JoinKind::Left;
                schema.push((name, column));
            }
            Ok(schema)
        }
        QueryNode::Traverse { input, relation_type, from_role, to_role, target } => {
            let schema = node(context, input, &field(path, "input"), depth + 1, remaining)?;
            let definition = context.resolve(relation_type, path)?;
            let DefinitionBody::RelationType(relation) = &definition.body else { return Err(invalid(&context.owner.reference, path)); };
            let from = relation.roles.iter().find(|role| &role.id == from_role).ok_or_else(|| invalid(&context.owner.reference, path))?;
            let to = relation.roles.iter().find(|role| &role.id == to_role).ok_or_else(|| invalid(&context.owner.reference, path))?;
            if !context.symbols.values().any(|symbol| symbol.reference == from.target_type) { return Err(invalid(&context.owner.reference, path)); }
            context.bind(target, &to.target_type, false, path)?;
            Ok(schema)
        }
        QueryNode::Project { input, columns: projected } => {
            node(context, input, &field(path, "input"), depth + 1, remaining)?;
            columns(context, projected, &field(path, "columns"))
        }
        QueryNode::Aggregate { input, group_by, aggregates } => {
            node(context, input, &field(path, "input"), depth + 1, remaining)?;
            let mut schema = columns(context, group_by, &field(path, "groupBy"))?;
            for (index, entry) in aggregates.iter().enumerate() {
                let path = field(&field(path, "aggregates"), index);
                if entry.name.is_empty() || schema.iter().any(|(name, _)| name == &entry.name) { return Err(invalid(&context.owner.reference, &path)); }
                let inferred = context.infer(&entry.expression, None, &field(&path, "expression"), 0)?;
                context.read_only(&inferred, &path)?;
                schema.push((entry.name.clone(), aggregate(entry.operator, inferred, None, &context.owner.reference, &path)?));
            }
            Ok(schema)
        }
        QueryNode::Sort { input, order } => {
            let schema = node(context, input, &field(path, "input"), depth + 1, remaining)?;
            for (index, entry) in order.iter().enumerate() {
                let path = field(&field(path, "order"), index);
                let inferred = context.infer(&entry.expression, None, &field(&path, "expression"), 0)?;
                context.read_only(&inferred, &path)?;
                if !types::ordered(&inferred.value_type) { return Err(invalid(&context.owner.reference, &path)); }
            }
            Ok(schema)
        }
        QueryNode::Distinct { input } => node(context, input, &field(path, "input"), depth + 1, remaining),
        QueryNode::Limit { input, count } => {
            if *count == 0 { return Err(invalid(&context.owner.reference, path)); }
            node(context, input, &field(path, "input"), depth + 1, remaining)
        }
        QueryNode::Union { inputs } => {
            if inputs.is_empty() { return Err(invalid(&context.owner.reference, path)); }
            let before = context.symbols.clone();
            let mut output: Option<(BTreeMap<SymbolId, Symbol>, Vec<(String, Inferred)>)> = None;
            for (index, input) in inputs.iter().enumerate() {
                context.symbols = before.clone();
                let schema = node(context, input, &field(&field(path, "inputs"), index), depth + 1, remaining)?;
                if let Some((symbols, expected)) = &mut output {
                    if symbols != &context.symbols || expected.len() != schema.len() { return Err(invalid(&context.owner.reference, path)); }
                    for ((name, previous), (next_name, next)) in expected.iter_mut().zip(schema) {
                        if *name != next_name { return Err(invalid(&context.owner.reference, path)); }
                        previous.value_type = types::common(&previous.value_type, &next.value_type).ok_or_else(|| invalid(&context.owner.reference, path))?;
                        previous.merge(&next);
                    }
                } else { output = Some((context.symbols.clone(), schema)); }
            }
            let (symbols, schema) = output.ok_or_else(|| invalid(&context.owner.reference, path))?;
            context.symbols = symbols;
            Ok(schema)
        }
        QueryNode::NotExists { input, correlated, predicate } => {
            let schema = node(context, input, &field(path, "input"), depth + 1, remaining)?;
            let symbols = context.symbols.clone();
            node(context, correlated, &field(path, "correlated"), depth + 1, remaining)?;
            context.guard(predicate, &field(path, "predicate"), false)?;
            context.symbols = symbols;
            Ok(schema)
        }
    }
}

fn columns(context: &mut Context<'_>, columns: &[QueryColumn], path: &[String]) -> Result<Vec<(String, Inferred)>, CompileFailure> {
    let mut names = BTreeSet::new();
    let mut result = Vec::with_capacity(columns.len());
    for (index, column) in columns.iter().enumerate() {
        let path = field(path, index);
        if column.name.is_empty() || !names.insert(&column.name) { return Err(invalid(&context.owner.reference, &path)); }
        let inferred = context.infer(&column.expression, None, &field(&path, "expression"), 0)?;
        context.read_only(&inferred, &path)?;
        result.push((column.name.clone(), inferred));
    }
    Ok(result)
}

pub(super) fn bind_parameters(context: &mut Context<'_>) -> Result<(), CompileFailure> {
    let parameters: Vec<_> = context.parameters.values().cloned().collect();
    for parameter in parameters {
        let type_id = match &parameter.value_type { ValueType::Object { type_id } | ValueType::Relation { type_id } => type_id, _ => continue };
        let definition = context.stable(type_id, &["parameters".into(), parameter.id.to_string()])?;
        let expected_kind = match parameter.value_type {
            ValueType::Object { .. } => DefinitionKind::ObjectType,
            ValueType::Relation { .. } => DefinitionKind::RelationType,
            _ => continue,
        };
        if definition.body.kind() != expected_kind { return Err(invalid(&context.owner.reference, &["parameters".into(), parameter.id.to_string()])); }
        let symbol = SymbolId::try_new(parameter.id.as_str()).map_err(|_| CompileFailure::InternalFault)?;
        context.bind(&symbol, &definition.reference, parameter.optional || parameter.nullable, &["parameters".into()])?;
    }
    Ok(())
}

pub(super) fn read_expression(context: &mut Context<'_>, expression: &ExpressionIr, expected: Option<&ValueType>, path: &[String]) -> Result<Inferred, CompileFailure> {
    let inferred = context.infer(expression, expected, path, 0)?;
    context.read_only(&inferred, path)?;
    Ok(inferred)
}
