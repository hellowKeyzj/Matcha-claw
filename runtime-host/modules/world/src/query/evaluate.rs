use std::collections::{BTreeMap, BTreeSet};

use tokio_util::sync::CancellationToken;
use world_protocol::{
    budget::BudgetDimension,
    compiler::{DefinitionIr, ExpressionAnnotation},
    definitions::DefinitionBody,
    expression::{AggregateOperator, BinaryOperator, Effect, ExpressionFailure, ExpressionIr, TimeWindow, TruthValue, UnaryOperator},
    failure::FieldPath,
    ids::{DefinitionId, DefinitionRef, ParameterId, RoleId, SymbolId},
    time::Timestamp,
    value::{Cell, Decimal, UnknownReason, Value, ValueType},
};

use super::values;

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct EvalRow {
    pub subjects: BTreeMap<SymbolId, world_protocol::identity::SubjectRef>,
    pub fields: BTreeMap<(SymbolId, DefinitionRef), Cell>,
    pub roles: BTreeMap<(SymbolId, RoleId), Cell>,
    pub valid_time: Option<world_protocol::time::ValidTime>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct EvalCollection {
    pub rows: Vec<EvalRow>,
    /// None means the producer supplied the whole collection, not a completeness proof.
    pub incomplete: Option<Cell>,
}
impl EvalCollection {
    pub(super) fn rebind(&self, source: &SymbolId, target: &SymbolId) -> Self {
        Self { rows: self.rows.iter().map(|row| EvalRow {
            subjects: row.subjects.get(source).map(|subject| (target.clone(), subject.clone())).into_iter().collect(),
            fields: row.fields.iter().filter(|((owner, _), _)| owner == source).map(|((_, property), cell)| ((target.clone(), property.clone()), cell.clone())).collect(),
            roles: row.roles.iter().filter(|((owner, _), _)| owner == source).map(|((_, role), cell)| ((target.clone(), role.clone()), cell.clone())).collect(),
            valid_time: row.valid_time.clone(),
        }).collect(), incomplete: self.incomplete.clone() }
    }
}

/// Pure inputs only. This context never grants access, establishes source coverage or proves a rule.
pub(crate) struct EvalContext<'a> {
    pub parameters: &'a BTreeMap<ParameterId, Cell>,
    pub row: &'a EvalRow,
    pub collections: &'a BTreeMap<SymbolId, EvalCollection>,
    pub ranges: Option<&'a BTreeMap<DefinitionId, (SymbolId, EvalCollection)>>,
    pub functions: &'a BTreeMap<DefinitionRef, DefinitionIr>,
    pub annotations: &'a [ExpressionAnnotation],
    pub at: &'a Timestamp,
    pub max_evaluations: u64,
    pub cancellation: &'a CancellationToken,
}

pub(crate) fn evaluate(expression: &ExpressionIr, context: &EvalContext<'_>) -> Result<Cell, ExpressionFailure> {
    evaluate_at(expression, context, &FieldPath(vec!["expression".into()]))
}

pub(crate) fn evaluate_at(expression: &ExpressionIr, context: &EvalContext<'_>, path: &FieldPath) -> Result<Cell, ExpressionFailure> {
    evaluate_counted(expression, context, path).0
}

pub(super) fn evaluate_counted(expression: &ExpressionIr, context: &EvalContext<'_>, path: &FieldPath) -> (Result<Cell, ExpressionFailure>, u64) {
    let mut state = State { remaining: context.max_evaluations, calls: BTreeSet::new(), cancellation: context.cancellation, budget: None };
    let result = state.eval(expression, context, &path.0, 0);
    (result, context.max_evaluations - state.remaining)
}

pub(crate) fn evaluate_metered(expression: &ExpressionIr, context: &EvalContext<'_>, path: &FieldPath, budget: &crate::extensions::invocation::CallBudget) -> Result<Cell, ExpressionFailure> {
    let mut state = State { remaining: context.max_evaluations, calls: BTreeSet::new(), cancellation: context.cancellation, budget: Some(budget) };
    state.eval(expression, context, &path.0, 0)
}

pub(crate) fn truth_value(cell: &Cell) -> Result<TruthValue, ExpressionFailure> {
    Ok(match cell {
        Cell::Known { value: Value::Boolean { value: true } } => TruthValue::True,
        Cell::Known { value: Value::Boolean { value: false } } => TruthValue::False,
        Cell::Known { value: Value::Null } | Cell::Unknown { .. } => TruthValue::Unknown,
        Cell::Conflicted { .. } => TruthValue::Conflicted,
        Cell::SourceUnavailable { .. } => TruthValue::SourceUnavailable,
        _ => return Err(invalid(&[])),
    })
}

struct State<'a> {
    remaining: u64,
    calls: BTreeSet<DefinitionRef>,
    cancellation: &'a CancellationToken,
    budget: Option<&'a crate::extensions::invocation::CallBudget>,
}

impl State<'_> {
    fn tick(&mut self, depth: usize) -> Result<(), ExpressionFailure> {
        if self.cancellation.is_cancelled() { return Err(ExpressionFailure::Cancelled); }
        if self.remaining == 0 || depth > world_protocol::api::MAX_QUERY_DEPTH {
            return Err(ExpressionFailure::BudgetExceeded { dimension: BudgetDimension::Steps });
        }
        if let Some(budget) = self.budget { budget.charge(BudgetDimension::Steps, 1).map_err(|failure| ExpressionFailure::BudgetExceeded { dimension: failure.dimension })?; }
        self.remaining -= 1;
        Ok(())
    }

    fn eval(&mut self, expression: &ExpressionIr, context: &EvalContext<'_>, path: &[String], depth: usize) -> Result<Cell, ExpressionFailure> {
        self.tick(depth)?;
        let result = match expression {
            ExpressionIr::Literal { value } => known(value.clone()),
            ExpressionIr::Parameter { id } => context.parameters.get(id).cloned().ok_or_else(|| invalid(path))?,
            ExpressionIr::Field { subject, property } => context.row.fields.get(&(subject.clone(), property.clone())).cloned().ok_or_else(|| invalid(path))?,
            ExpressionIr::Role { relation, role } => context.row.roles.get(&(relation.clone(), role.clone())).cloned().ok_or_else(|| invalid(path))?,
            ExpressionIr::Unary { operator, operand } => {
                let cell = self.eval(operand, context, &child(path, "operand"), depth + 1)?;
                match cell {
                    Cell::Known { value } => known(match operator {
                        UnaryOperator::Not => match value { Value::Boolean { value } => Value::Boolean { value: !value }, Value::Null => Value::Null, _ => return Err(invalid(path)) },
                        UnaryOperator::Negate => values::negate(&value, &FieldPath(path.to_vec()))?,
                    }),
                    other => other,
                }
            }
            ExpressionIr::Binary { operator, left, right } => {
                let left = self.eval(left, context, &child(path, "left"), depth + 1)?;
                let right = self.eval(right, context, &child(path, "right"), depth + 1)?;
                match uncertain(&[left.clone(), right.clone()]) {
                    Some(cell) => cell,
                    None => match (left, right) { (Cell::Known { value: left }, Cell::Known { value: right }) => known(values::binary(*operator, &left, &right, &FieldPath(path.to_vec()))?), _ => return Err(ExpressionFailure::InternalFault) },
                }
            }
            ExpressionIr::All { terms } | ExpressionIr::Any { terms } => {
                let mut cells = Vec::with_capacity(terms.len());
                for (index, term) in terms.iter().enumerate() { cells.push(self.eval(term, context, &child(&child(path, "terms"), index), depth + 1)?); }
                boolean_fold(matches!(expression, ExpressionIr::All { .. }), &cells, path)?
            }
            ExpressionIr::If { condition, then_value, else_value } => {
                let condition = self.eval(condition, context, &child(path, "condition"), depth + 1)?;
                match condition {
                    Cell::Known { value: Value::Boolean { value: true } } => self.eval(then_value, context, &child(path, "thenValue"), depth + 1)?,
                    Cell::Known { value: Value::Boolean { value: false } } => self.eval(else_value, context, &child(path, "elseValue"), depth + 1)?,
                    Cell::Known { value: Value::Null } => known(Value::Null),
                    Cell::Known { .. } => return Err(invalid(path)),
                    other => other,
                }
            }
            ExpressionIr::IsNull { operand } => {
                match self.eval(operand, context, &child(path, "operand"), depth + 1)? {
                    Cell::Known { value } => known(Value::Boolean { value: matches!(value, Value::Null) }),
                    other => other,
                }
            }
            ExpressionIr::IsKnown { operand } => {
                let cell = self.eval(operand, context, &child(path, "operand"), depth + 1)?;
                known(Value::Boolean { value: matches!(cell, Cell::Known { .. }) })
            }
            ExpressionIr::Call { function, arguments } => self.call(function, arguments, context, path, depth + 1)?,
            ExpressionIr::Aggregate { operator, collection, expression, window } => {
                let collection_rows = context.collections.get(collection).ok_or_else(|| invalid(path))?;
                let mut cells = Vec::with_capacity(collection_rows.rows.len());
                if let Some(incomplete) = &collection_rows.incomplete {
                    if matches!(incomplete, Cell::Known { .. }) { return Err(invalid(path)); }
                    cells.push(incomplete.clone());
                }
                for row in &collection_rows.rows {
                    if let Some(window) = window {
                        match in_window(window, collection, row, context.at, path)? {
                            Cell::Known { value: Value::Boolean { value: false } } => continue,
                            Cell::Known { value: Value::Boolean { value: true } } => {},
                            other => { cells.push(other); continue; },
                        }
                    }
                    let context = EvalContext { row, ..*context };
                    cells.push(self.eval(expression, &context, &child(path, "expression"), depth + 1)?);
                }
                aggregate(*operator, &cells, &FieldPath(path.to_vec()))?
            }
        };
        checked(result, context.annotations.iter().find(|annotation| annotation.field.0 == path), path)
    }

    fn call(&mut self, reference: &DefinitionRef, arguments: &[ExpressionIr], context: &EvalContext<'_>, path: &[String], depth: usize) -> Result<Cell, ExpressionFailure> {
        let definition = context.functions.get(reference).ok_or_else(|| invalid(path))?;
        if &definition.reference != reference { return Err(invalid(path)); }
        let DefinitionBody::Function(function) = &definition.body else { return Err(invalid(path)); };
        if function.effects.iter().any(|effect| !matches!(effect, Effect::Pure | Effect::SourceRead))
            || arguments.len() > function.parameters.len() || function.parameters[arguments.len()..].iter().any(|parameter| !parameter.optional) {
            return Err(invalid(path));
        }
        let mut parameters = BTreeMap::new();
        for (index, parameter) in function.parameters.iter().enumerate() {
            let cell = match arguments.get(index) {
                Some(argument) => self.eval(argument, context, &child(&child(path, "arguments"), index), depth)?,
                None => Cell::Unknown { reason: UnknownReason::NotObserved },
            };
            if let Cell::Known { value } = &cell {
                crate::definitions::validate_value(&parameter.value_type, parameter.nullable, value).map_err(|_| invalid(path))?;
            }
            parameters.insert(parameter.id.clone(), cell);
        }
        if !self.calls.insert(reference.clone()) { return Err(invalid(path)); }
        let outer_remaining = self.remaining;
        let allowed = self.remaining.min(function.max_evaluations);
        self.remaining = allowed;
        let mut row = EvalRow { valid_time: context.row.valid_time.clone(), ..Default::default() };
        let mut sources = BTreeMap::new();
        for (parameter, cell) in &parameters {
            let subject = match cell {
                Cell::Known { value: Value::Object { id } } => Some(world_protocol::identity::SubjectRef::Object { id: id.clone() }),
                Cell::Known { value: Value::Relation { id } } => Some(world_protocol::identity::SubjectRef::Relation { id: id.clone() }),
                _ => None,
            };
            let symbol = SymbolId::try_new(parameter.as_str()).map_err(|_| invalid(path))?;
            if let Some(subject) = subject {
                let source = context.row.subjects.iter().find(|(_, actual)| **actual == subject).map(|(symbol, _)| symbol);
                let source = source.ok_or_else(|| invalid(path))?;
                sources.insert(symbol.clone(), source.clone());
                row.subjects.insert(symbol.clone(), subject);
                for ((owner, property), value) in &context.row.fields { if owner == source { row.fields.insert((symbol.clone(), property.clone()), value.clone()); } }
                for ((owner, role), value) in &context.row.roles { if owner == source { row.roles.insert((symbol.clone(), role.clone()), value.clone()); } }
            } else if let Some(parameter) = function.parameters.iter().find(|entry| entry.id == *parameter) {
                let type_id = match &parameter.value_type { ValueType::Object { type_id } | ValueType::Relation { type_id } => Some(type_id), _ => None };
                if type_id.is_some() {
                    for ((_, property), _) in &context.row.fields { row.fields.insert((symbol.clone(), property.clone()), cell.clone()); }
                    for ((_, role), _) in &context.row.roles { row.roles.insert((symbol.clone(), role.clone()), cell.clone()); }
                }
            }
        }
        let mut collections = BTreeMap::new();
        for (index, parameter) in function.parameters.iter().enumerate() {
            let type_id = match &parameter.value_type { ValueType::Object { type_id } | ValueType::Relation { type_id } => type_id, _ => continue };
            let symbol = SymbolId::try_new(parameter.id.as_str()).map_err(|_| invalid(path))?;
            let source = sources.get(&symbol).cloned().or_else(|| match arguments.get(index) {
                Some(ExpressionIr::Parameter { id }) => SymbolId::try_new(id.as_str()).ok(), _ => None,
            });
            let actual = context.ranges.and_then(|ranges| ranges.get(type_id)).map(|(source, collection)| (source, collection))
                .or_else(|| source.as_ref().and_then(|source| context.collections.get(source).map(|collection| (source, collection))));
            if let Some((source, collection)) = actual {
                let mut collection = collection.rebind(source, &symbol);
                for item in &mut collection.rows {
                    self.tick(depth)?;
                    let mut bound = row.clone();
                    bound.subjects.extend(item.subjects.clone()); bound.fields.extend(item.fields.clone()); bound.roles.extend(item.roles.clone());
                    bound.valid_time = item.valid_time.clone(); *item = bound;
                }
                collections.insert(symbol, collection);
            }
        }
        let callee = EvalContext { parameters: &parameters, row: &row, collections: &collections, annotations: &definition.annotations, ..*context };
        let result = self.eval(&function.expression, &callee, &["expression".into()], depth);
        let consumed = allowed - self.remaining;
        self.remaining = outer_remaining - consumed;
        self.calls.remove(reference);
        let result = result?;
        checked(result, Some(&ExpressionAnnotation { field: FieldPath(path.to_vec()), result_type: function.result_type.clone(), nullable: true, optional: false, effects: function.effects.clone() }), path)
    }
}

fn known(value: Value) -> Cell { Cell::Known { value } }
fn invalid(path: &[String]) -> ExpressionFailure { ExpressionFailure::InvalidOperand { field: FieldPath(path.to_vec()) } }
fn child(path: &[String], name: impl ToString) -> Vec<String> { let mut result = path.to_vec(); result.push(name.to_string()); result }

fn uncertain(cells: &[Cell]) -> Option<Cell> {
    if let Some(cell) = cells.iter().find(|cell| matches!(cell, Cell::SourceUnavailable { .. })) { return Some(cell.clone()); }
    let mut assertions = BTreeSet::new();
    let mut conflicted = false;
    for cell in cells { if let Cell::Conflicted { assertions: refs } = cell { conflicted = true; assertions.extend(refs.iter().cloned()); } }
    if conflicted { return Some(Cell::Conflicted { assertions: assertions.into_iter().collect() }); }
    cells.iter().find(|cell| matches!(cell, Cell::Unknown { .. })).cloned()
}

fn boolean_fold(all: bool, cells: &[Cell], path: &[String]) -> Result<Cell, ExpressionFailure> {
    for cell in cells { truth_value(cell).map_err(|_| invalid(path))?; }
    if let Some(cell) = uncertain(cells) { return Ok(cell); }
    if cells.iter().any(|cell| matches!(cell, Cell::Known { value: Value::Boolean { value } } if *value != all)) {
        return Ok(known(Value::Boolean { value: !all }));
    }
    if cells.iter().any(|cell| matches!(cell, Cell::Known { value: Value::Null })) { return Ok(known(Value::Null)); }
    Ok(known(Value::Boolean { value: all }))
}

fn checked(cell: Cell, annotation: Option<&ExpressionAnnotation>, path: &[String]) -> Result<Cell, ExpressionFailure> {
    let (Cell::Known { value }, Some(annotation)) = (&cell, annotation) else { return Ok(cell); };
    if let (Value::Decimal { value }, ValueType::Decimal { precision, scale }) = (value, &annotation.result_type) {
        let unsigned = value.as_str().trim_start_matches('-');
        let (integer, fraction) = unsigned.split_once('.').unwrap_or((unsigned, ""));
        if fraction.len() > *scale as usize || integer.trim_start_matches('0').len() > (precision - scale) as usize {
            return Err(ExpressionFailure::PrecisionExceeded { field: FieldPath(path.to_vec()), precision: *precision, scale: *scale });
        }
    }
    crate::definitions::validate_value(&annotation.result_type, annotation.nullable, value).map_err(|_| invalid(path))?;
    Ok(cell)
}

fn in_window(window: &TimeWindow, collection: &SymbolId, row: &EvalRow, at: &Timestamp, path: &[String]) -> Result<Cell, ExpressionFailure> {
    let TimeWindow::Sliding { width, timestamp_property } = window else {
        let TimeWindow::Fixed { interval } = window else { return Err(invalid(path)); };
        let actual = row.valid_time.as_ref().ok_or_else(|| invalid(path))?;
        return Ok(known(Value::Boolean { value: actual.to.as_ref().is_none_or(|to| &interval.from < to)
            && interval.to.as_ref().is_none_or(|to| &actual.from < to) }));
    };
    let cell = row.fields.get(&(collection.clone(), timestamp_property.clone())).ok_or_else(|| invalid(path))?;
    match cell {
        Cell::Known { value: Value::Timestamp { value } } => {
            let left = chrono::DateTime::parse_from_rfc3339(value.as_str()).map_err(|_| invalid(path))?;
            let end = chrono::DateTime::parse_from_rfc3339(at.as_str()).map_err(|_| invalid(path))?;
            let start = end.checked_sub_signed(chrono::TimeDelta::milliseconds(i64::try_from(width.0).map_err(|_| invalid(path))?)).ok_or_else(|| invalid(path))?;
            Ok(known(Value::Boolean { value: start <= left && left < end }))
        }
        Cell::Known { .. } => Err(invalid(path)),
        other => Ok(other.clone()),
    }
}

pub(super) fn aggregate(operator: AggregateOperator, cells: &[Cell], field: &FieldPath) -> Result<Cell, ExpressionFailure> {
    use AggregateOperator::*;
    if let Some(cell) = uncertain(cells) { return Ok(cell); }
    if matches!(operator, Any | All) { return boolean_fold(operator == All, cells, &field.0); }
    let values: Vec<_> = cells.iter().filter_map(|cell| match cell { Cell::Known { value: Value::Null } => None, Cell::Known { value } => Some(value), _ => None }).collect();
    if operator == Count {
        return Ok(known(Value::Integer { value: i64::try_from(values.len()).map_err(|_| ExpressionFailure::Overflow { field: field.clone() })? }));
    }
    let Some(first) = values.first() else { return Ok(known(Value::Null)); };
    let mut result = (*first).clone();
    for value in &values[1..] {
        result = match operator {
            Sum | Average => values::binary(BinaryOperator::Add, &result, value, field)?,
            Minimum | Maximum => {
                let order = values::compare(value, &result, field)?;
                if (operator == Minimum && order.is_lt()) || (operator == Maximum && order.is_gt()) { (*value).clone() } else { result }
            }
            _ => return Err(invalid(&field.0)),
        };
    }
    if operator == Average {
        let count = Decimal::try_new(values.len().to_string()).map_err(|_| ExpressionFailure::Overflow { field: field.clone() })?;
        result = match result {
            Value::Integer { value } => Value::Decimal { value: super::decimal::calculate(BinaryOperator::Divide, &Decimal::try_new(value.to_string()).map_err(|_| invalid(&field.0))?, &count, field)? },
            Value::Decimal { value } => Value::Decimal { value: super::decimal::calculate(BinaryOperator::Divide, &value, &count, field)? },
            Value::Money { amount, currency } => Value::Money { amount: super::decimal::calculate(BinaryOperator::Divide, &amount, &count, field)?, currency },
            Value::Quantity { amount, unit } => Value::Quantity { amount: super::decimal::calculate(BinaryOperator::Divide, &amount, &count, field)?, unit },
            _ => return Err(invalid(&field.0)),
        };
    }
    Ok(known(result))
}
