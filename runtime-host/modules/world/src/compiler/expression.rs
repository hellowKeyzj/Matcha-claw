use std::collections::BTreeMap;

use world_protocol::{
    compiler::{CompileFailure, ExpressionAnnotation},
    definitions::{Definition, DefinitionBody, DefinitionKind, Scope},
    expression::{AggregateOperator, BinaryOperator, Effect, ExpressionIr, Parameter, TimeWindow, UnaryOperator},
    failure::FieldPath,
    ids::{DefinitionId, DefinitionRef, ParameterId, SymbolId},
    value::{Value, ValueType},
};

use super::{field, invalid, types};

type Model = Definition<DefinitionBody>;

#[derive(Clone, Debug, PartialEq)]
pub(super) struct Symbol {
    pub reference: DefinitionRef,
    pub optional: bool,
}

#[derive(Clone, Debug)]
pub(super) struct Inferred {
    pub value_type: ValueType,
    pub nullable: bool,
    pub optional: bool,
    pub effects: Vec<Effect>,
}

impl Inferred {
    fn pure(value_type: ValueType) -> Self {
        Self { value_type, nullable: false, optional: false, effects: Vec::new() }
    }

    pub(super) fn merge(&mut self, other: &Self) {
        self.nullable |= other.nullable;
        self.optional |= other.optional;
        for effect in &other.effects { self.effect(*effect); }
    }

    pub(super) fn effect(&mut self, effect: Effect) {
        if effect != Effect::Pure && !self.effects.contains(&effect) { self.effects.push(effect); self.effects.sort(); }
    }
}

pub(super) struct Context<'a> {
    pub owner: &'a Model,
    pub definitions: &'a BTreeMap<DefinitionRef, &'a Model>,
    scopes: &'a [Scope],
    pub parameters: BTreeMap<ParameterId, Parameter>,
    pub symbols: BTreeMap<SymbolId, Symbol>,
    pub annotations: Vec<ExpressionAnnotation>,
    pub(super) snapshot_fields: bool,
    remaining: usize,
}

impl<'a> Context<'a> {
    pub(super) fn new(owner: &'a Model, definitions: &'a BTreeMap<DefinitionRef, &'a Model>, scopes: &'a [Scope]) -> Self {
        Self { owner, definitions, scopes, parameters: BTreeMap::new(), symbols: BTreeMap::new(), annotations: Vec::new(), snapshot_fields: false, remaining: 65_536 }
    }

    pub(super) fn parameters(&mut self, parameters: &[Parameter], path: &[String]) -> Result<(), CompileFailure> {
        for parameter in parameters {
            crate::definitions::validate_value_type(&parameter.value_type).map_err(|failure| CompileFailure::Definition { failure })?;
            if self.parameters.insert(parameter.id.clone(), parameter.clone()).is_some() {
                return Err(invalid(&self.owner.reference, path));
            }
        }
        Ok(())
    }

    pub(super) fn resolve(&self, reference: &DefinitionRef, path: &[String]) -> Result<&'a Model, CompileFailure> {
        let target = self.definitions.get(reference).copied().ok_or_else(|| CompileFailure::ReferenceMissing {
            reference: reference.clone(), field: FieldPath(path.to_vec()),
        })?;
        if reference.world != self.owner.reference.world {
            return Err(CompileFailure::Definition { failure: world_protocol::definitions::DefinitionFailure::CrossWorldReference { reference: reference.clone() } });
        }
        if !crate::definitions::valid_time_contains(&target.valid_time, &self.owner.valid_time) {
            return Err(CompileFailure::TimeMismatch { definition: self.owner.reference.clone(), field: FieldPath(path.to_vec()) });
        }
        if !crate::definitions::scope_contains(&reference.world, &target.scope, &self.owner.scope, self.scopes)
            .map_err(|failure| CompileFailure::Definition { failure })? {
            return Err(CompileFailure::ScopeMismatch { definition: self.owner.reference.clone(), field: FieldPath(path.to_vec()) });
        }
        Ok(target)
    }

    pub(super) fn stable(&self, id: &DefinitionId, path: &[String]) -> Result<&'a Model, CompileFailure> {
        let mut matches = self.owner.dependencies.iter().filter(|reference| &reference.id == id);
        let reference = matches.next().ok_or_else(|| CompileFailure::ReferenceAmbiguous { id: id.clone(), field: FieldPath(path.to_vec()) })?;
        if matches.next().is_some() {
            return Err(CompileFailure::ReferenceAmbiguous { id: id.clone(), field: FieldPath(path.to_vec()) });
        }
        self.resolve(reference, path)
    }

    pub(super) fn bind(&mut self, symbol: &SymbolId, reference: &DefinitionRef, optional: bool, path: &[String]) -> Result<(), CompileFailure> {
        if self.symbols.insert(symbol.clone(), Symbol { reference: reference.clone(), optional }).is_some() {
            return Err(invalid(&self.owner.reference, path));
        }
        Ok(())
    }

    pub(super) fn guard(&mut self, expression: &ExpressionIr, path: &[String], sensitive: bool) -> Result<Inferred, CompileFailure> {
        let inferred = self.infer(expression, Some(&ValueType::Boolean), path, 0)?;
        self.read_only(&inferred, path)?;
        if inferred.value_type == ValueType::Null { return Err(invalid(&self.owner.reference, path)); }
        if sensitive && inferred.effects.contains(&Effect::Probabilistic) {
            return Err(self.effect_failure(path, Effect::Probabilistic));
        }
        Ok(inferred)
    }

    pub(super) fn read_only(&self, inferred: &Inferred, path: &[String]) -> Result<(), CompileFailure> {
        if inferred.effects.contains(&Effect::ExternalWrite) { return Err(self.effect_failure(path, Effect::ExternalWrite)); }
        Ok(())
    }

    pub(super) fn declared(&self, inferred: &Inferred, effects: &[Effect], path: &[String]) -> Result<(), CompileFailure> {
        for effect in &inferred.effects {
            if !effects.contains(effect) { return Err(self.effect_failure(path, *effect)); }
        }
        Ok(())
    }

    fn effect_failure(&self, path: &[String], effect: Effect) -> CompileFailure {
        CompileFailure::EffectViolation { definition: self.owner.reference.clone(), field: FieldPath(path.to_vec()), effect }
    }

    pub(super) fn infer(
        &mut self, expression: &ExpressionIr, expected: Option<&ValueType>, path: &[String], depth: usize,
    ) -> Result<Inferred, CompileFailure> {
        if depth > 64 || self.remaining == 0 { return Err(CompileFailure::LimitExceeded { field: FieldPath(path.to_vec()) }); }
        self.remaining -= 1;
        let mut inferred = match expression {
            ExpressionIr::Literal { value } => {
                let value_type = types::literal(&self.owner.reference, path, value, expected, 0)?;
                crate::definitions::validate_value(&value_type, true, value).map_err(|failure| CompileFailure::Definition { failure })?;
                let mut inferred = Inferred::pure(value_type);
                inferred.nullable = matches!(value, Value::Null);
                inferred
            }
            ExpressionIr::Parameter { id } => {
                let parameter = self.parameters.get(id).ok_or_else(|| invalid(&self.owner.reference, path))?;
                let mut inferred = Inferred::pure(parameter.value_type.clone());
                inferred.nullable = parameter.nullable;
                inferred.optional = parameter.optional;
                inferred
            }
            ExpressionIr::Field { subject, property } => {
                let symbol = self.symbols.get(subject).ok_or_else(|| invalid(&self.owner.reference, path))?;
                let definition = self.resolve(property, path)?;
                let DefinitionBody::Property(property) = &definition.body else { return Err(wrong_kind(definition, DefinitionKind::Property)); };
                if !property.domain.contains(&symbol.reference.id) { return Err(invalid(&self.owner.reference, path)); }
                let mut inferred = Inferred::pure(property.value_type.clone());
                if property.cardinality.maximum != Some(1) {
                    inferred.value_type = ValueType::List {
                        element: Box::new(inferred.value_type), max_items: property.cardinality.maximum.unwrap_or(65_536).min(65_536),
                    };
                }
                inferred.nullable = property.nullable;
                inferred.optional = symbol.optional || property.cardinality.minimum == 0;
                if !self.snapshot_fields { inferred.effect(Effect::SourceRead); }
                inferred
            }
            ExpressionIr::Role { relation, role } => {
                let symbol = self.symbols.get(relation).ok_or_else(|| invalid(&self.owner.reference, path))?;
                let definition = self.resolve(&symbol.reference, path)?;
                let DefinitionBody::RelationType(relation) = &definition.body else { return Err(wrong_kind(definition, DefinitionKind::RelationType)); };
                let role = relation.roles.iter().find(|entry| &entry.id == role).ok_or_else(|| invalid(&self.owner.reference, path))?;
                let value_type = ValueType::Object { type_id: role.target_type.id.clone() };
                let mut inferred = Inferred::pure(if role.cardinality.maximum == Some(1) { value_type } else {
                    ValueType::List { element: Box::new(value_type), max_items: role.cardinality.maximum.unwrap_or(65_536).min(65_536) }
                });
                inferred.optional = symbol.optional || role.cardinality.minimum == 0;
                if !self.snapshot_fields { inferred.effect(Effect::SourceRead); }
                inferred
            }
            ExpressionIr::Unary { operator, operand } => {
                let operand_expected = if *operator == UnaryOperator::Not { Some(&ValueType::Boolean) } else { expected };
                let inferred = self.infer(operand, operand_expected, &field(path, "operand"), depth + 1)?;
                if *operator == UnaryOperator::Negate && !types::numeric(&inferred.value_type) {
                    return Err(invalid(&self.owner.reference, path));
                }
                inferred
            }
            ExpressionIr::Binary { operator, left, right } => self.binary(*operator, left, right, expected, path, depth + 1)?,
            ExpressionIr::All { terms } | ExpressionIr::Any { terms } => {
                let mut inferred = Inferred::pure(ValueType::Boolean);
                for (index, term) in terms.iter().enumerate() {
                    inferred.merge(&self.infer(term, Some(&ValueType::Boolean), &field(&field(path, "terms"), index), depth + 1)?);
                }
                inferred
            }
            ExpressionIr::If { condition, then_value, else_value } => {
                let condition = self.infer(condition, Some(&ValueType::Boolean), &field(path, "condition"), depth + 1)?;
                let (then_value, else_value) = self.pair(then_value, else_value, expected, path, depth + 1, "thenValue", "elseValue")?;
                let value_type = types::common(&then_value.value_type, &else_value.value_type).ok_or_else(|| invalid(&self.owner.reference, path))?;
                let mut inferred = Inferred::pure(value_type);
                inferred.merge(&condition);
                inferred.merge(&then_value);
                inferred.merge(&else_value);
                inferred
            }
            ExpressionIr::Call { function, arguments } => {
                let definition = self.resolve(function, path)?;
                let DefinitionBody::Function(function) = &definition.body else { return Err(wrong_kind(definition, DefinitionKind::Function)); };
                if arguments.len() > function.parameters.len() || function.parameters[arguments.len()..].iter().any(|parameter| !parameter.optional) {
                    return Err(invalid(&self.owner.reference, &field(path, "arguments")));
                }
                let callee_budget = self.remaining.min(function.max_evaluations.min(65_536) as usize);
                let mut callee = Context::new(definition, self.definitions, self.scopes);
                callee.remaining = callee_budget;
                callee.snapshot_fields = self.snapshot_fields;
                callee.parameters(&function.parameters, &field(path, "parameters"))?;
                super::query::bind_parameters(&mut callee)?;
                let mut inferred = callee.infer(&function.expression, Some(&function.result_type), &field(path, "callee"), depth + 1)?;
                callee.declared(&inferred, &function.effects, path)?;
                self.remaining -= callee_budget - callee.remaining;
                let result_nullable = inferred.nullable;
                let result_optional = inferred.optional;
                for (index, (argument, parameter)) in arguments.iter().zip(&function.parameters).enumerate() {
                    let argument_path = field(&field(path, "arguments"), index);
                    let argument = self.infer(argument, Some(&parameter.value_type), &argument_path, depth + 1)?;
                    if (argument.nullable && !parameter.nullable) || (argument.optional && !parameter.optional) {
                        return Err(invalid(&self.owner.reference, &argument_path));
                    }
                    inferred.merge(&argument);
                }
                inferred.nullable = result_nullable;
                inferred.optional = result_optional;
                for effect in &function.effects { inferred.effect(*effect); }
                inferred
            }
            ExpressionIr::Aggregate { operator, collection, expression, window } => {
                let symbol = self.symbols.get(collection).cloned().ok_or_else(|| invalid(&self.owner.reference, path))?;
                self.window(window.as_ref(), Some(&symbol.reference), &field(path, "window"))?;
                let input = self.infer(expression, None, &field(path, "expression"), depth + 1)?;
                aggregate(*operator, input, expected, &self.owner.reference, path)?
            }
            ExpressionIr::IsNull { operand } | ExpressionIr::IsKnown { operand } => {
                let operand = self.infer(operand, None, &field(path, "operand"), depth + 1)?;
                let mut inferred = Inferred::pure(ValueType::Boolean);
                inferred.effects = operand.effects;
                inferred
            }
        };
        if let Some(expected) = expected {
            if inferred.value_type != ValueType::Null { types::require(&self.owner.reference, path, expected, &inferred.value_type)?; }
        }
        inferred.effects.sort();
        self.annotations.push(ExpressionAnnotation {
            field: FieldPath(path.to_vec()), result_type: inferred.value_type.clone(), nullable: inferred.nullable,
            optional: inferred.optional, effects: inferred.effects.clone(),
        });
        Ok(inferred)
    }

    fn pair(
        &mut self, left: &ExpressionIr, right: &ExpressionIr, expected: Option<&ValueType>, path: &[String], depth: usize,
        left_name: &str, right_name: &str,
    ) -> Result<(Inferred, Inferred), CompileFailure> {
        let contextual = |expression: &ExpressionIr| matches!(expression,
            ExpressionIr::Literal { value: Value::Null | Value::Object { .. } | Value::Relation { .. } });
        if expected.is_none() && contextual(left) && !contextual(right) {
            let right = self.infer(right, None, &field(path, right_name), depth)?;
            let left = self.infer(left, Some(&right.value_type), &field(path, left_name), depth)?;
            return Ok((left, right));
        }
        let left = self.infer(left, expected, &field(path, left_name), depth)?;
        let right_expected = if contextual(right) { Some(&left.value_type) } else { expected };
        let right = self.infer(right, right_expected, &field(path, right_name), depth)?;
        Ok((left, right))
    }

    fn binary(
        &mut self, operator: BinaryOperator, left: &ExpressionIr, right: &ExpressionIr, expected: Option<&ValueType>, path: &[String], depth: usize,
    ) -> Result<Inferred, CompileFailure> {
        use BinaryOperator::*;
        let (left, right) = self.pair(left, right, None, path, depth, "left", "right")?;
        let left_type = if left.value_type == ValueType::Null { &right.value_type } else { &left.value_type };
        let right_type = if right.value_type == ValueType::Null { left_type } else { &right.value_type };
        let value_type = match operator {
            Equal | NotEqual | Less | LessOrEqual | Greater | GreaterOrEqual => {
                if types::common(&left.value_type, &right.value_type).is_none() {
                    types::require(&self.owner.reference, path, &left.value_type, &right.value_type)?;
                }
                if !matches!(operator, Equal | NotEqual) && !types::ordered(&left.value_type) { return Err(invalid(&self.owner.reference, path)); }
                ValueType::Boolean
            }
            Contains => {
                match &left.value_type {
                    ValueType::Text { .. } if matches!(right.value_type, ValueType::Text { .. }) => {}
                    ValueType::List { element, .. } => types::require(&self.owner.reference, path, element, &right.value_type)?,
                    _ => return Err(invalid(&self.owner.reference, path)),
                }
                ValueType::Boolean
            }
            Add | Subtract | Multiply | Divide => arithmetic(operator, left_type, right_type, expected, &self.owner.reference, path)?,
        };
        let mut inferred = Inferred::pure(value_type);
        inferred.merge(&left);
        inferred.merge(&right);
        Ok(inferred)
    }

    pub(super) fn window(&self, window: Option<&TimeWindow>, collection: Option<&DefinitionRef>, path: &[String]) -> Result<(), CompileFailure> {
        match window {
            Some(TimeWindow::Fixed { interval }) if interval.to.as_ref().is_some_and(|to| to <= &interval.from) => {
                return Err(CompileFailure::TimeMismatch { definition: self.owner.reference.clone(), field: FieldPath(path.to_vec()) });
            }
            Some(TimeWindow::Sliding { width, timestamp_property }) => {
                let definition = self.resolve(timestamp_property, path)?;
                let DefinitionBody::Property(property) = &definition.body else { return Err(wrong_kind(definition, DefinitionKind::Property)); };
                if width.0 == 0 || !matches!(property.value_type, ValueType::Timestamp { .. }) || property.cardinality.maximum != Some(1)
                    || collection.is_some_and(|collection| !property.domain.contains(&collection.id)) {
                    return Err(CompileFailure::TimeMismatch { definition: self.owner.reference.clone(), field: FieldPath(path.to_vec()) });
                }
            }
            _ => {}
        }
        Ok(())
    }
}

pub(super) fn aggregate(operator: AggregateOperator, input: Inferred, expected: Option<&ValueType>, definition: &DefinitionRef, path: &[String]) -> Result<Inferred, CompileFailure> {
    use AggregateOperator::*;
    let mut result = input.clone();
    result.value_type = match operator {
        Count => ValueType::Integer,
        Average if matches!(input.value_type, ValueType::Integer) => match expected {
            Some(expected @ ValueType::Decimal { .. }) => expected.clone(),
            // A finite mean of i64 values and a u64 count needs at most 19 integer and 63 fractional digits.
            _ => ValueType::Decimal { precision: 82, scale: 63 },
        },
        Any | All => { types::require(definition, path, &ValueType::Boolean, &input.value_type)?; ValueType::Boolean }
        Sum | Average if types::numeric(&input.value_type) => match (&input.value_type, expected) {
            (ValueType::Decimal { .. }, Some(expected @ ValueType::Decimal { .. })) => expected.clone(),
            (ValueType::Decimal { precision, scale }, None) if operator == Average => {
                let integer_digits = precision - scale;
                let scale = (scale + 63).min(128 - integer_digits);
                ValueType::Decimal { precision: (integer_digits + scale).max(1), scale }
            }
            _ => input.value_type.clone(),
        },
        Minimum | Maximum if types::ordered(&input.value_type) => input.value_type.clone(),
        _ => return Err(invalid(definition, path)),
    };
    result.nullable |= matches!(operator, Minimum | Maximum | Average);
    // Missing/conflicted/unavailable inputs remain runtime states; Count is not a proof of coverage.
    Ok(result)
}

fn arithmetic(operator: BinaryOperator, left: &ValueType, right: &ValueType, expected: Option<&ValueType>, definition: &DefinitionRef, path: &[String]) -> Result<ValueType, CompileFailure> {
    use BinaryOperator::*;
    if matches!(left, ValueType::Integer) && matches!(right, ValueType::Decimal { .. }) {
        return arithmetic(operator, &ValueType::Decimal { precision: 19, scale: 0 }, right, expected, definition, path);
    }
    if matches!(left, ValueType::Decimal { .. }) && matches!(right, ValueType::Integer) {
        return arithmetic(operator, left, &ValueType::Decimal { precision: 19, scale: 0 }, expected, definition, path);
    }
    if let (ValueType::Decimal { .. }, ValueType::Decimal { .. }, Some(expected @ ValueType::Decimal { .. })) = (left, right, expected) {
        return Ok(expected.clone());
    }
    if matches!(operator, Add | Subtract) {
        if !types::numeric(left) && !matches!(left, ValueType::Duration) { return Err(invalid(definition, path)); }
        if let (ValueType::Decimal { precision: lp, scale: ls }, ValueType::Decimal { precision: rp, scale: rs }) = (left, right) {
            let integer_digits = ((lp - ls).max(rp - rs) + 1).min(128);
            let scale = (*ls).max(*rs).min(128 - integer_digits);
            return Ok(ValueType::Decimal { precision: (integer_digits + scale).max(1), scale });
        }
        if let Some(result) = types::common(left, right) { return Ok(result); }
        types::require(definition, path, left, right)?;
    }
    match (left, right) {
        (ValueType::Integer, ValueType::Integer) if operator == Divide => match expected {
            Some(expected @ ValueType::Decimal { .. }) => Ok(expected.clone()),
            // A finite i64 quotient's denominator has only factors 2/5, with exponent at most 63.
            _ => Ok(ValueType::Decimal { precision: 82, scale: 63 }),
        },
        (ValueType::Integer, ValueType::Integer) => Ok(ValueType::Integer),
        (ValueType::Decimal { precision: lp, scale: ls }, ValueType::Decimal { precision: rp, scale: rs }) if operator == Multiply => {
            let integer_digits = (lp - ls + rp - rs).min(128);
            let scale = (ls + rs).min(128 - integer_digits);
            Ok(ValueType::Decimal { precision: (integer_digits + scale).max(1), scale })
        }
        (ValueType::Decimal { precision: lp, scale: ls }, ValueType::Decimal { precision: rp, scale: rs }) if operator == Divide => {
            if let Some(expected @ ValueType::Decimal { .. }) = expected { return Ok(expected.clone()); }
            let integer_digits = (lp - ls + rs).min(128);
            // log2(10) < 10/3 bounds the exponent of 2 in a denominator coefficient.
            let scale = (((u32::from(*rp) * 10).div_ceil(3) + u32::from(*ls)).saturating_sub(u32::from(*rs)))
                .min(u32::from(128 - integer_digits)) as u16;
            Ok(ValueType::Decimal { precision: (integer_digits + scale).max(1), scale })
        }
        (ValueType::Money { .. } | ValueType::Quantity { .. }, ValueType::Integer | ValueType::Decimal { .. }) => Ok(left.clone()),
        (ValueType::Integer | ValueType::Decimal { .. }, ValueType::Money { .. } | ValueType::Quantity { .. }) if operator == Multiply => Ok(right.clone()),
        _ => Err(invalid(definition, path)),
    }
}

fn wrong_kind(definition: &Model, expected: DefinitionKind) -> CompileFailure {
    CompileFailure::Definition { failure: world_protocol::definitions::DefinitionFailure::WrongKind {
        reference: definition.reference.clone(), expected, actual: definition.body.kind(),
    } }
}
