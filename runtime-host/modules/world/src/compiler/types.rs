use world_protocol::{
    compiler::CompileFailure,
    failure::FieldPath,
    ids::DefinitionRef,
    value::{RecordField, Value, ValueType},
};

use super::invalid;

pub(super) fn accepts(expected: &ValueType, actual: &ValueType) -> bool {
    match (expected, actual) {
        (ValueType::Decimal { precision: ep, scale: es }, ValueType::Decimal { precision: ap, scale: a_s }) => {
            a_s <= es && ap - a_s <= ep - es
        }
        (ValueType::Text { max_length: expected }, ValueType::Text { max_length: actual }) => actual <= expected,
        (ValueType::List { element: expected, max_items: em }, ValueType::List { element: actual, max_items: am }) => {
            am <= em && accepts(expected, actual)
        }
        (ValueType::Record { fields: expected }, ValueType::Record { fields: actual }) => {
            actual.iter().all(|field| expected.iter().any(|entry| entry.name == field.name))
                && expected.iter().all(|entry| match actual.iter().find(|field| field.name == entry.name) {
                    Some(field) => accepts(&entry.value_type, &field.value_type)
                        && (!field.nullable || entry.nullable) && (!field.optional || entry.optional),
                    None => entry.optional,
                })
        }
        _ => expected == actual,
    }
}

pub(super) fn require(
    definition: &DefinitionRef, path: &[String], expected: &ValueType, actual: &ValueType,
) -> Result<(), CompileFailure> {
    if accepts(expected, actual) { return Ok(()); }
    Err(match (expected, actual) {
        (ValueType::Money { currency: expected }, ValueType::Money { currency: actual }) => CompileFailure::CurrencyMismatch {
            definition: definition.clone(), field: FieldPath(path.to_vec()), expected: expected.clone(), actual: actual.clone(),
        },
        (ValueType::Quantity { unit: expected }, ValueType::Quantity { unit: actual }) => CompileFailure::UnitMismatch {
            definition: definition.clone(), field: FieldPath(path.to_vec()), expected: expected.clone(), actual: actual.clone(),
        },
        (ValueType::Timestamp { .. }, ValueType::Timestamp { .. }) | (ValueType::Date { .. }, ValueType::Date { .. }) => {
            CompileFailure::TimeMismatch { definition: definition.clone(), field: FieldPath(path.to_vec()) }
        }
        _ => CompileFailure::TypeMismatch {
            definition: definition.clone(), field: FieldPath(path.to_vec()), expected: expected.clone(), actual: actual.clone(),
        },
    })
}

pub(super) fn common(left: &ValueType, right: &ValueType) -> Option<ValueType> {
    if matches!(left, ValueType::Null) { return Some(right.clone()); }
    if matches!(right, ValueType::Null) { return Some(left.clone()); }
    if accepts(left, right) { return Some(left.clone()); }
    if accepts(right, left) { return Some(right.clone()); }
    match (left, right) {
        (ValueType::Decimal { precision: lp, scale: ls }, ValueType::Decimal { precision: rp, scale: rs }) => {
            let scale = (*ls).max(*rs);
            let precision = (lp - ls).max(rp - rs) + scale;
            (precision <= 128).then_some(ValueType::Decimal { precision, scale })
        }
        (ValueType::List { element: left, max_items: lm }, ValueType::List { element: right, max_items: rm }) => {
            Some(ValueType::List { element: Box::new(common(left, right)?), max_items: (*lm).max(*rm) })
        }
        _ => None,
    }
}

pub(super) fn literal(
    definition: &DefinitionRef, path: &[String], value: &Value, expected: Option<&ValueType>, depth: usize,
) -> Result<ValueType, CompileFailure> {
    if depth > 64 { return Err(CompileFailure::LimitExceeded { field: FieldPath(path.to_vec()) }); }
    if let Some(expected) = expected {
        crate::definitions::validate_value(expected, true, value).map_err(|failure| CompileFailure::Definition { failure })?;
        if matches!(value, Value::Object { .. } | Value::Relation { .. } | Value::Timestamp { .. } | Value::List { .. } | Value::Record { .. }) {
            return Ok(expected.clone());
        }
    }
    Ok(match value {
        Value::Null => ValueType::Null,
        Value::Object { .. } | Value::Relation { .. } => return Err(invalid(definition, path)),
        Value::Boolean { .. } => ValueType::Boolean,
        Value::Integer { .. } => ValueType::Integer,
        Value::Decimal { value } => {
            let unsigned = value.as_str().trim_start_matches('-');
            let (integer, fraction) = unsigned.split_once('.').unwrap_or((unsigned, ""));
            ValueType::Decimal { precision: (integer.trim_start_matches('0').len() + fraction.len()).max(1) as u16, scale: fraction.len() as u16 }
        }
        Value::Text { value } => ValueType::Text { max_length: value.chars().count() as u32 },
        Value::Money { currency, .. } => ValueType::Money { currency: currency.clone() },
        Value::Quantity { unit, .. } => ValueType::Quantity { unit: unit.clone() },
        Value::Timestamp { .. } => ValueType::Timestamp { time_zone: "UTC".into() },
        Value::Date { calendar, .. } => ValueType::Date { calendar: calendar.clone() },
        Value::Duration { .. } => ValueType::Duration,
        Value::List { items } => {
            let mut element = None;
            for item in items {
                let next = literal(definition, path, item, None, depth + 1)?;
                element = Some(match element { None => next, Some(previous) => common(&previous, &next).ok_or_else(|| invalid(definition, path))? });
            }
            ValueType::List { element: Box::new(element.ok_or_else(|| invalid(definition, path))?), max_items: items.len() as u32 }
        }
        Value::Record { fields } => ValueType::Record { fields: fields.iter().map(|(name, value)| {
            Ok(RecordField { name: name.clone(), value_type: literal(definition, path, value, None, depth + 1)?, nullable: matches!(value, Value::Null), optional: false })
        }).collect::<Result<_, CompileFailure>>()? },
    })
}

pub(super) fn ordered(value_type: &ValueType) -> bool {
    matches!(value_type, ValueType::Integer | ValueType::Decimal { .. } | ValueType::Text { .. }
        | ValueType::Money { .. } | ValueType::Quantity { .. } | ValueType::Timestamp { .. }
        | ValueType::Date { .. } | ValueType::Duration)
}

pub(super) fn numeric(value_type: &ValueType) -> bool {
    matches!(value_type, ValueType::Integer | ValueType::Decimal { .. } | ValueType::Money { .. } | ValueType::Quantity { .. })
}
