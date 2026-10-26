use std::collections::BTreeSet;

use crate::{
    definitions::{DefinitionFailure, DefinitionFieldReason as Reason},
    failure::FieldPath,
};
use chrono::NaiveDate;

use super::{Value, ValueType};

const MAX_DEPTH: usize = 64;
const MAX_ITEMS: usize = 65_536;

pub fn validate_value_type(value_type: &ValueType) -> Result<(), DefinitionFailure> {
    validate_type_at(value_type, &[], 0)
}

fn validate_type_at(
    value_type: &ValueType,
    path: &[String],
    depth: usize,
) -> Result<(), DefinitionFailure> {
    if depth > MAX_DEPTH {
        return Err(DefinitionFailure::LimitExceeded {
            field: FieldPath(path.to_vec()),
            maximum: MAX_DEPTH as u64,
        });
    }
    match value_type {
        ValueType::Decimal { precision, scale } => {
            if *precision == 0 || *precision > 128 {
                return Err(invalid(path, Reason::InvalidPrecision));
            }
            if scale > precision {
                return Err(invalid(path, Reason::InvalidScale));
            }
        }
        ValueType::Timestamp { time_zone } => {
            if time_zone.parse::<chrono_tz::Tz>().is_err() {
                return Err(invalid(path, Reason::InvalidTimeZone));
            }
        }
        ValueType::Date { calendar } => {
            if !matches!(calendar.as_str(), "gregorian" | "iso8601") {
                return Err(invalid(path, Reason::InvalidCalendar));
            }
        }
        ValueType::Quantity { unit } => {
            if super::Unit::try_new(&unit.code, &unit.dimension).is_err() {
                return Err(DefinitionFailure::UnitMismatch {
                    field: FieldPath(path.to_vec()),
                });
            }
        }
        ValueType::List { element, max_items } => {
            if *max_items as usize > MAX_ITEMS {
                return Err(DefinitionFailure::LimitExceeded {
                    field: FieldPath(path.to_vec()),
                    maximum: MAX_ITEMS as u64,
                });
            }
            validate_type_at(element, &field(path, "element"), depth + 1)?;
        }
        ValueType::Record { fields } => {
            if fields.len() > MAX_ITEMS {
                return Err(DefinitionFailure::LimitExceeded {
                    field: FieldPath(path.to_vec()),
                    maximum: MAX_ITEMS as u64,
                });
            }
            let mut names = BTreeSet::new();
            for entry in fields {
                let path = field(path, &entry.name);
                if entry.name.is_empty() {
                    return Err(invalid(&path, Reason::Empty));
                }
                if !names.insert(&entry.name) {
                    return Err(invalid(&path, Reason::Duplicate));
                }
                validate_type_at(&entry.value_type, &path, depth + 1)?;
            }
        }
        _ => {}
    }
    Ok(())
}

pub fn validate_value(
    value_type: &ValueType,
    nullable: bool,
    value: &Value,
) -> Result<(), DefinitionFailure> {
    validate_value_type(value_type)?;
    let mut remaining = MAX_ITEMS;
    validate_at(value_type, nullable, value, &[], 0, &mut remaining)
}

fn validate_at(
    value_type: &ValueType,
    nullable: bool,
    value: &Value,
    path: &[String],
    depth: usize,
    remaining: &mut usize,
) -> Result<(), DefinitionFailure> {
    if depth > MAX_DEPTH || *remaining == 0 {
        return Err(DefinitionFailure::LimitExceeded {
            field: FieldPath(path.to_vec()),
            maximum: MAX_ITEMS as u64,
        });
    }
    *remaining -= 1;
    if matches!(value, Value::Null) {
        return if nullable {
            Ok(())
        } else {
            Err(invalid(path, Reason::NullNotAllowed))
        };
    }
    match (value_type, value) {
        (ValueType::Boolean, Value::Boolean { .. })
        | (ValueType::Integer, Value::Integer { .. })
        | (ValueType::Duration, Value::Duration { .. })
        | (ValueType::Timestamp { .. }, Value::Timestamp { .. })
        | (ValueType::Object { .. }, Value::Object { .. })
        | (ValueType::Relation { .. }, Value::Relation { .. }) => {}
        (ValueType::Decimal { precision, scale }, Value::Decimal { value }) => {
            let unsigned = value.as_str().trim_start_matches('-');
            let (integer, fraction) = unsigned.split_once('.').unwrap_or((unsigned, ""));
            let integer_digits = integer.trim_start_matches('0').len();
            if fraction.len() > *scale as usize {
                return Err(invalid(path, Reason::InvalidScale));
            }
            if integer_digits > (*precision - *scale) as usize {
                return Err(invalid(path, Reason::InvalidPrecision));
            }
        }
        (ValueType::Text { max_length }, Value::Text { value }) => {
            if value.chars().count() > *max_length as usize {
                return Err(DefinitionFailure::LimitExceeded {
                    field: FieldPath(path.to_vec()),
                    maximum: *max_length as u64,
                });
            }
        }
        (ValueType::Money { currency: expected }, Value::Money { currency, .. })
            if expected == currency => {}
        (ValueType::Quantity { unit: expected }, Value::Quantity { unit, .. })
            if expected == unit => {}
        (ValueType::Money { .. }, Value::Money { .. })
        | (ValueType::Quantity { .. }, Value::Quantity { .. }) => {
            return Err(DefinitionFailure::UnitMismatch {
                field: FieldPath(path.to_vec()),
            });
        }
        (ValueType::Date { calendar: expected }, Value::Date { value, calendar }) => {
            if expected != calendar {
                return Err(invalid(path, Reason::InvalidCalendar));
            }
            if value.len() != 10
                || NaiveDate::parse_from_str(value, "%Y-%m-%d")
                    .map_or(true, |date| date.format("%Y-%m-%d").to_string() != *value)
            {
                return Err(invalid(path, Reason::InvalidDate));
            }
        }
        (ValueType::List { element, max_items }, Value::List { items }) => {
            if items.len() > *max_items as usize {
                return Err(DefinitionFailure::LimitExceeded {
                    field: FieldPath(path.to_vec()),
                    maximum: *max_items as u64,
                });
            }
            for (index, item) in items.iter().enumerate() {
                validate_at(
                    element,
                    false,
                    item,
                    &field(path, index),
                    depth + 1,
                    remaining,
                )?;
            }
        }
        (ValueType::Record { fields: schema }, Value::Record { fields }) => {
            for name in fields.keys() {
                if !schema.iter().any(|entry| &entry.name == name) {
                    return Err(DefinitionFailure::TypeMismatch {
                        field: FieldPath(field(path, name)),
                    });
                }
            }
            for entry in schema {
                let path = field(path, &entry.name);
                match fields.get(&entry.name) {
                    Some(value) => validate_at(
                        &entry.value_type,
                        entry.nullable,
                        value,
                        &path,
                        depth + 1,
                        remaining,
                    )?,
                    None if entry.optional => {}
                    None => {
                        return Err(DefinitionFailure::MissingField {
                            field: FieldPath(path),
                        });
                    }
                }
            }
        }
        _ => {
            return Err(DefinitionFailure::TypeMismatch {
                field: FieldPath(path.to_vec()),
            });
        }
    }
    Ok(())
}

fn invalid(path: &[String], reason: Reason) -> DefinitionFailure {
    DefinitionFailure::InvalidField {
        field: FieldPath(path.to_vec()),
        reason,
    }
}

fn field(parent: &[String], name: impl ToString) -> Vec<String> {
    let mut path = parent.to_vec();
    path.push(name.to_string());
    path
}
