use std::{cmp::Ordering, collections::{BTreeMap, BTreeSet}};
use tokio_util::sync::CancellationToken;
use world_protocol::{
    budget::BudgetDimension, expression::{ExpressionIr, TruthValue}, failure::FieldPath,
    identity::{IdentityRecord, SubjectRef}, ids::*, query::*, time::Timestamp,
    value::{Cell, UnknownReason, Value},
};
use crate::extensions::invocation::CallBudget;
use super::{QueryError, EvalCollection, EvalContext, EvalRow, truth_value, plan::CheckedPlan, projection::{Projection, ProjectedSubject}, values};

#[derive(Clone)]
struct Row { bindings: EvalRow, columns: Vec<NamedCell>, subjects: BTreeSet<SubjectRef> }
pub(super) struct EngineOutput { pub rows: Vec<QueryRow>, pub row_subjects: Vec<Vec<SubjectRef>>, pub bindings: Vec<EvalRow>, pub collections: BTreeMap<SymbolId, EvalCollection>, pub parameter_row: EvalRow, pub subjects: BTreeSet<SubjectRef>, pub incomplete: bool, pub truncated: bool }
struct Engine<'a> {
    plan: &'a CheckedPlan, release: &'a world_protocol::releases::Release, projection: &'a Projection, parameters: BTreeMap<ParameterId, Cell>,
    at: &'a Timestamp, budget: &'a CallBudget, cancel: &'a CancellationToken, incomplete: bool, parameter_row: EvalRow,
}
pub(super) fn run(plan: &CheckedPlan, release: &world_protocol::releases::Release, projection: &Projection, arguments: &[QueryArgument], at: &Timestamp, budget: &CallBudget, cancel: &CancellationToken) -> Result<EngineOutput, QueryError> {
    let parameters = parameters(&plan.query.parameters, arguments)?;
    let mut parameter_row = EvalRow::default();
    for parameter in &plan.query.parameters {
        let subject = match parameters.get(&parameter.id) {
            Some(Cell::Known { value: Value::Object { id } }) => SubjectRef::Object { id: id.clone() },
            Some(Cell::Known { value: Value::Relation { id } }) => SubjectRef::Relation { id: id.clone() }, _ => continue,
        };
        let projected = projection.subjects.get(&subject).ok_or(QueryFailure::BasisChanged)?;
        let actual = match &projected.identity.record { IdentityRecord::Object(object) => world_protocol::value::ValueType::Object { type_id: object.type_id.clone() }, IdentityRecord::Relation(relation) => world_protocol::value::ValueType::Relation { type_id: relation.type_id.clone() } };
        if parameter.value_type != actual { return Err(super::error::invalid("arguments.type")); }
        bind(&mut parameter_row, &SymbolId::try_new(parameter.id.as_str()).map_err(|_| QueryFailure::InternalFault)?, &subject, projected);
    }
    let mut engine = Engine { plan, release, projection, parameters, at, budget, cancel, incomplete: projection.incomplete, parameter_row: parameter_row.clone() };
    let mut rows = engine.node(&plan.query.root, &["query".into(), "root".into()])?;
    for row in &mut rows {
        engine.tick()?;
        row.subjects.extend(parameter_row.subjects.values().cloned());
        for (symbol, subject) in &parameter_row.subjects {
            if row.bindings.subjects.get(symbol).is_some_and(|bound| bound != subject) { return Err(super::error::invalid("query.parameters")); }
        }
        row.bindings.subjects.extend(parameter_row.subjects.clone()); row.bindings.fields.extend(parameter_row.fields.clone()); row.bindings.roles.extend(parameter_row.roles.clone());
    }
    if !plan.query.output.is_empty() {
        let all = engine.collections(&rows, &plan.query.root)?;
        for row in &mut rows { row.columns = engine.columns(&plan.query.output, &row.bindings, &all, &["query".into(), "output".into()])?; }
    }
    let truncated = rows.len() > plan.query.limit as usize;
    let all = engine.collections(&rows, &plan.query.root)?;
    rows.truncate(plan.query.limit as usize);
    let subjects = rows.iter().flat_map(|row| row.subjects.iter().cloned()).collect();
    let row_subjects = rows.iter().map(|row| row.subjects.iter().cloned().collect()).collect();
    let bindings = rows.iter().map(|row| row.bindings.clone()).collect();
    Ok(EngineOutput { row_subjects, rows: rows.into_iter().map(|row| QueryRow { columns: row.columns }).collect(), bindings, collections: all, parameter_row, subjects, incomplete: engine.incomplete, truncated })
}
pub(super) fn parameters(declarations: &[world_protocol::expression::Parameter], arguments: &[QueryArgument]) -> Result<BTreeMap<ParameterId, Cell>, QueryError> {
    let mut result = BTreeMap::new();
    for argument in arguments {
        let parameter = declarations.iter().find(|entry| entry.id == argument.parameter_id).ok_or_else(|| super::error::invalid("arguments"))?;
        crate::definitions::validate_value(&parameter.value_type, parameter.nullable, &argument.value).map_err(|_| super::error::invalid("arguments"))?;
        if result.insert(argument.parameter_id.clone(), Cell::Known { value: argument.value.clone() }).is_some() { return Err(super::error::invalid("arguments")); }
    }
    for parameter in declarations {
        if !result.contains_key(&parameter.id) {
            if !parameter.optional { return Err(super::error::invalid("arguments")); }
            result.insert(parameter.id.clone(), Cell::Unknown { reason: UnknownReason::NotObserved });
        }
    }
    Ok(result)
}
impl Engine<'_> {
    fn tick(&self) -> Result<(), QueryError> {
        if self.cancel.is_cancelled() { return Err(QueryFailure::Cancelled.into()); }
        self.budget.charge(BudgetDimension::Steps, 1).map_err(super::execution::budget_error)
    }
    fn value(&self, expression: &ExpressionIr, row: &EvalRow, collections: &BTreeMap<SymbolId, EvalCollection>, path: &[String]) -> Result<Cell, QueryError> {
        self.tick()?;
        Ok(super::evaluate::evaluate_metered(expression, &EvalContext { parameters: &self.parameters, row, collections, ranges: None, functions: &self.plan.functions, annotations: &self.plan.annotations, at: self.at,
            max_evaluations: self.budget.limit().max_steps.saturating_sub(self.budget.usage().steps), cancellation: self.cancel }, &FieldPath(path.to_vec()), self.budget)?)
    }
    fn columns(&self, columns: &[QueryColumn], row: &EvalRow, collections: &BTreeMap<SymbolId, EvalCollection>, path: &[String]) -> Result<Vec<NamedCell>, QueryError> {
        columns.iter().enumerate().map(|(index, column)| Ok(NamedCell { name: column.name.clone(), cell: self.value(&column.expression, row, collections, &child(&child(path, index), "expression"))? })).collect()
    }
    fn correlated(&mut self, node: &QueryNode, outer: &Row, path: &[String]) -> Result<Vec<Row>, QueryError> {
        let saved = std::mem::replace(&mut self.parameter_row, outer.bindings.clone());
        let result = self.node(node, path);
        self.parameter_row = saved;
        result.map(|mut rows| { for row in &mut rows { row.subjects.extend(outer.subjects.iter().cloned()); } rows })
    }
    fn null_extend(&self, row: &mut Row, node: &QueryNode) -> Result<(), QueryError> {
        for (symbol, reference) in super::plan::bindings(node, self.release)? {
            for property in &self.plan.fields {
                let definition = self.release.definitions.iter().find(|definition| definition.reference == *property).ok_or(QueryFailure::BasisChanged)?;
                if matches!(&definition.body, world_protocol::definitions::DefinitionBody::Property(body) if body.domain.contains(&reference.id)) {
                    row.bindings.fields.insert((symbol.clone(), property.clone()), Cell::Known { value: Value::Null });
                }
            }
            let definition = self.release.definitions.iter().find(|definition| definition.reference == reference).ok_or(QueryFailure::BasisChanged)?;
            if let world_protocol::definitions::DefinitionBody::RelationType(body) = &definition.body {
                for role in &body.roles { row.bindings.roles.insert((symbol.clone(), role.id.clone()), Cell::Known { value: Value::Null }); }
            }
        }
        row.columns.extend(super::plan::column_names(node).into_iter().map(|name| NamedCell { name, cell: Cell::Known { value: Value::Null } }));
        Ok(())
    }
    fn collections(&self, rows: &[Row], node: &QueryNode) -> Result<BTreeMap<SymbolId, EvalCollection>, QueryError> {
        let mut result = collections(rows);
        for symbol in super::plan::bindings(node, self.release)?.into_keys().chain(self.parameter_row.subjects.keys().cloned()) { result.entry(symbol).or_default(); }
        if self.incomplete { for collection in result.values_mut() { collection.incomplete = Some(Cell::Unknown { reason: UnknownReason::IncompleteCoverage }); } }
        Ok(result)
    }
    fn node(&mut self, node: &QueryNode, path: &[String]) -> Result<Vec<Row>, QueryError> {
        self.tick()?;
        let result = match node {
            QueryNode::Objects { type_ref, symbol } | QueryNode::Relations { type_ref, symbol } => {
                let object = matches!(node, QueryNode::Objects { .. });
                let mut rows = Vec::new();
                for (subject, projected) in &self.projection.subjects {
                    self.tick()?;
                    let matches = match &projected.identity.record { IdentityRecord::Object(record) => object && record.type_id == type_ref.id, IdentityRecord::Relation(record) => !object && record.type_id == type_ref.id };
                    if !matches || !object && projected.relation.is_none() { continue; }
                    let mut row = self.parameter_row.clone(); bind(&mut row, symbol, subject, projected);
                    rows.push(Row { subjects: row.subjects.values().cloned().collect(), bindings: row, columns: Vec::new() });
                }
                rows
            }
            QueryNode::Filter { input, predicate } => {
                let rows = self.node(input, &child(path, "input"))?;
                let collections = self.collections(&rows, input)?;
                let mut result = Vec::new();
                for row in rows {
                    match truth_value(&self.value(predicate, &row.bindings, &collections, &child(path, "predicate"))?)? {
                        TruthValue::True => result.push(row), TruthValue::False => {}, _ => self.incomplete = true,
                    }
                }
                result
            }
            QueryNode::Join { left, right, on, join_kind } => {
                let left = self.node(left, &child(path, "left"))?;
                let mut result = Vec::new();
                for row in left {
                    self.tick()?;
                    let right_rows = self.correlated(right, &row, &child(path, "right"))?;
                    let all = self.collections(&right_rows, right)?;
                    let mut matched = false;
                    let mut undecided = self.incomplete;
                    for other in &right_rows {
                        self.tick()?;
                        let joined = merge(&row, other)?;
                        match truth_value(&self.value(on, &joined.bindings, &all, &child(path, "on"))?)? {
                            TruthValue::True => { matched = true; result.push(joined); }, TruthValue::False => {}, _ => { undecided = true; self.incomplete = true; },
                        }
                    }
                    if !matched && !undecided && *join_kind == JoinKind::Left {
                        let mut row = row;
                        self.null_extend(&mut row, right)?;
                        result.push(row);
                    }
                }
                result
            }
            QueryNode::Traverse { input, relation_type, from_role, to_role, target } => {
                let rows = self.node(input, &child(path, "input"))?;
                let mut result = Vec::new();
                for row in rows {
                    let bound: BTreeSet<_> = row.bindings.subjects.values().filter_map(|subject| match subject { SubjectRef::Object { id } => Some(id), _ => None }).collect();
                    for relation in self.projection.subjects.values() {
                        self.tick()?;
                        let Some(relation) = &relation.relation else { continue; };
                        if relation.type_ref != *relation_type || !relation.roles.iter().any(|role| &role.role == from_role && bound.contains(&role.object_id)) { continue; }
                        if relation.cells.values().any(|cell| !matches!(cell, Cell::Known { .. })) { self.incomplete = true; continue; }
                        for role in relation.roles.iter().filter(|role| &role.role == to_role) {
                            self.tick()?;
                            let subject = SubjectRef::Object { id: role.object_id.clone() };
                            let Some(projected) = self.projection.subjects.get(&subject) else { self.incomplete = true; continue; };
                            let mut next = row.clone(); bind(&mut next.bindings, target, &subject, projected); next.subjects.insert(subject); result.push(next);
                        }
                    }
                }
                result
            }
            QueryNode::Project { input, columns: projected } => {
                let mut rows = self.node(input, &child(path, "input"))?;
                let collections = self.collections(&rows, input)?;
                for row in &mut rows { row.columns = self.columns(projected, &row.bindings, &collections, &child(path, "columns"))?; }
                rows
            }
            QueryNode::Aggregate { input, group_by, aggregates } => {
                let rows = self.node(input, &child(path, "input"))?;
                let all = self.collections(&rows, input)?;
                let mut groups: Vec<(Vec<NamedCell>, Vec<Row>)> = Vec::new();
                for row in rows {
                    let key = self.columns(group_by, &row.bindings, &all, &child(path, "groupBy"))?;
                    let mut found = None;
                    for (index, (existing, _)) in groups.iter().enumerate() { self.tick()?; if equal_columns(existing, &key, &FieldPath(path.to_vec()))? { found = Some(index); break; } }
                    if let Some(index) = found { groups[index].1.push(row); } else { groups.push((key, vec![row])); }
                }
                if groups.is_empty() && group_by.is_empty() { groups.push((Vec::new(), Vec::new())); }
                let mut result = Vec::new();
                for (mut columns, rows) in groups {
                    let collection = self.collections(&rows, input)?;
                    for (index, aggregate) in aggregates.iter().enumerate() {
                        let field = child(&child(path, "aggregates"), index);
                        let mut cells = Vec::new();
                        for row in &rows { cells.push(self.value(&aggregate.expression, &row.bindings, &collection, &child(&field, "expression"))?); }
                        if self.incomplete { cells.push(Cell::Unknown { reason: UnknownReason::IncompleteCoverage }); }
                        columns.push(NamedCell { name: aggregate.name.clone(), cell: super::evaluate::aggregate(aggregate.operator, &cells, &FieldPath(field))? });
                    }
                    result.push(Row { subjects: rows.iter().flat_map(|row| row.subjects.iter().cloned()).collect(), bindings: rows.first().map(|row| row.bindings.clone()).unwrap_or_default(), columns });
                }
                result
            }
            QueryNode::Sort { input, order } => {
                let rows = self.node(input, &child(path, "input"))?;
                let all = self.collections(&rows, input)?;
                let mut decorated = Vec::with_capacity(rows.len());
                for row in rows {
                    let mut keys = Vec::new();
                    for (index, item) in order.iter().enumerate() { keys.push(self.value(&item.expression, &row.bindings, &all, &child(&child(&child(path, "order"), index), "expression"))?); }
                    decorated.push((keys, row));
                }
                let mut failure = None;
                decorated.sort_by(|(left, _), (right, _)| {
                    if failure.is_some() { return Ordering::Equal; }
                    if let Err(error) = self.tick() { failure = Some(error); return Ordering::Equal; }
                    for (index, item) in order.iter().enumerate() {
                        match compare_cell(&left[index], &right[index], item.nulls, &FieldPath(path.to_vec())) {
                            Ok(Ordering::Equal) => {}, Ok(value) => return if item.descending && !matches!(&left[index], Cell::Known { value: Value::Null }) && !matches!(&right[index], Cell::Known { value: Value::Null }) { value.reverse() } else { value },
                            Err(error) => { failure = Some(error); return Ordering::Equal; },
                        }
                    }
                    Ordering::Equal
                });
                if let Some(error) = failure { return Err(error); }
                decorated.into_iter().map(|(_, row)| row).collect()
            }
            QueryNode::Distinct { input } => {
                let rows = self.node(input, &child(path, "input"))?;
                let mut result: Vec<Row> = Vec::new();
                for row in rows {
                    let mut found = None;
                    for (index, existing) in result.iter().enumerate() { self.tick()?; if equal_rows(existing, &row, &FieldPath(path.to_vec()))? { found = Some(index); break; } }
                    if let Some(index) = found { result[index].subjects.extend(row.subjects); } else { result.push(row); }
                }
                result
            }
            QueryNode::Union { inputs } => {
                let mut rows = Vec::new();
                for (index, input) in inputs.iter().enumerate() { rows.extend(self.node(input, &child(&child(path, "inputs"), index))?); }
                rows
            }
            QueryNode::NotExists { input, correlated, predicate } => {
                let rows = self.node(input, &child(path, "input"))?;
                let mut result = Vec::new();
                for row in rows {
                    self.tick()?;
                    let other = self.correlated(correlated, &row, &child(path, "correlated"))?;
                    let all = self.collections(&other, correlated)?;
                    let mut exists = false;
                    let mut uncertain = self.incomplete;
                    for other in &other {
                        self.tick()?;
                        let joined = merge(&row, other)?;
                        match truth_value(&self.value(predicate, &joined.bindings, &all, &child(path, "predicate"))?)? {
                            TruthValue::True => { exists = true; break; }, TruthValue::False => {}, _ => uncertain = true,
                        }
                    }
                    if !exists && !uncertain { result.push(row); }
                    self.incomplete |= uncertain;
                }
                result
            }
            QueryNode::Limit { input, count } => { let mut rows = self.node(input, &child(path, "input"))?; rows.truncate(*count as usize); rows },
        };
        if result.len() as u64 > self.budget.limit().max_rows { return Err(QueryFailure::BudgetExceeded { limit: TruncationReason::Rows }.into()); }
        Ok(result)
    }
}
pub(super) fn bind(row: &mut EvalRow, symbol: &SymbolId, subject: &SubjectRef, projected: &ProjectedSubject) {
    row.subjects.insert(symbol.clone(), subject.clone());
    for (property, field) in &projected.fields { row.fields.insert((symbol.clone(), property.clone()), field.cell.clone()); }
    if let Some(relation) = &projected.relation {
        row.valid_time = Some(relation.valid_time.clone());
        for (role, cell) in &relation.cells { row.roles.insert((symbol.clone(), role.clone()), cell.clone()); }
    }
}
fn merge(left: &Row, right: &Row) -> Result<Row, QueryError> {
    let mut row = left.clone();
    for (symbol, subject) in &right.bindings.subjects {
        if row.bindings.subjects.get(symbol).is_some_and(|previous| previous != subject) { return Err(super::error::invalid("query.join.symbol")); }
        row.bindings.subjects.insert(symbol.clone(), subject.clone());
    }
    row.bindings.fields.extend(right.bindings.fields.clone()); row.bindings.roles.extend(right.bindings.roles.clone()); row.columns.extend(right.columns.clone()); row.subjects.extend(right.subjects.iter().cloned());
    Ok(row)
}
fn collections(rows: &[Row]) -> BTreeMap<SymbolId, EvalCollection> {
    let mut result = BTreeMap::<SymbolId, EvalCollection>::new();
    for row in rows { for symbol in row.bindings.subjects.keys() { result.entry(symbol.clone()).or_default().rows.push(row.bindings.clone()); } }
    result
}
fn equal_cell(left: &Cell, right: &Cell, path: &FieldPath) -> Result<bool, QueryError> {
    match (left, right) {
        (Cell::Known { value: Value::Null }, Cell::Known { value: Value::Null }) => Ok(true),
        (Cell::Known { value: Value::Null }, Cell::Known { .. }) | (Cell::Known { .. }, Cell::Known { value: Value::Null }) => Ok(false),
        (Cell::Known { value: left }, Cell::Known { value: right }) => Ok(values::equal(left, right, path)?),
        _ => Ok(left == right),
    }
}
fn equal_columns(left: &[NamedCell], right: &[NamedCell], path: &FieldPath) -> Result<bool, QueryError> {
    if left.len() != right.len() { return Ok(false); }
    for (left, right) in left.iter().zip(right) { if left.name != right.name || !equal_cell(&left.cell, &right.cell, path)? { return Ok(false); } }
    Ok(true)
}
fn equal_rows(left: &Row, right: &Row, path: &FieldPath) -> Result<bool, QueryError> {
    if !left.columns.is_empty() || !right.columns.is_empty() { return equal_columns(&left.columns, &right.columns, path); }
    if left.bindings.subjects != right.bindings.subjects || left.bindings.valid_time != right.bindings.valid_time || left.bindings.fields.keys().ne(right.bindings.fields.keys()) || left.bindings.roles.keys().ne(right.bindings.roles.keys()) { return Ok(false); }
    for (left, right) in left.bindings.fields.values().chain(left.bindings.roles.values()).zip(right.bindings.fields.values().chain(right.bindings.roles.values())) { if !equal_cell(left, right, path)? { return Ok(false); } }
    Ok(true)
}
fn compare_cell(left: &Cell, right: &Cell, nulls: NullOrder, path: &FieldPath) -> Result<Ordering, QueryError> {
    match (left, right) {
        (Cell::Known { value: Value::Null }, Cell::Known { value: Value::Null }) => Ok(Ordering::Equal),
        (Cell::Known { value: Value::Null }, _) => Ok(if nulls == NullOrder::First { Ordering::Less } else { Ordering::Greater }),
        (_, Cell::Known { value: Value::Null }) => Ok(if nulls == NullOrder::First { Ordering::Greater } else { Ordering::Less }),
        (Cell::Known { value: left }, Cell::Known { value: right }) => Ok(values::compare(left, right, path)?),
        _ => Err(QueryFailure::GuaranteeUnsatisfied { mode: ReadMode::Authoritative, source_id: None }.into()),
    }
}
fn child(path: &[String], name: impl ToString) -> Vec<String> { let mut result = path.to_vec(); result.push(name.to_string()); result }
