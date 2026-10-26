use world_protocol::{
    definitions::{DefinitionFailure, DefinitionFieldReason},
    ids::{DefinitionRef, SourceFieldId},
    sources::{MappingFailure, RecordError, SourceTransform},
    value::{Value, ValueType},
};

use super::{compatibility::type_compatible, exact};

pub(crate) fn compatible(
    transform: &SourceTransform,
    source: &ValueType,
    target: &ValueType,
) -> bool {
    match transform {
        SourceTransform::Identity => type_compatible(source, target),
        SourceTransform::ExactInteger => {
            matches!(
                source,
                ValueType::Integer | ValueType::Decimal { .. } | ValueType::Text { .. }
            ) && matches!(target, ValueType::Integer)
        }
        SourceTransform::ExactDecimal => {
            matches!(
                source,
                ValueType::Integer | ValueType::Decimal { .. } | ValueType::Text { .. }
            ) && matches!(target, ValueType::Decimal { .. })
        }
        SourceTransform::Money { currency } => {
            (matches!(
                source,
                ValueType::Integer | ValueType::Decimal { .. } | ValueType::Text { .. }
            ) || matches!(source, ValueType::Money { currency: actual } if actual == currency))
                && matches!(target, ValueType::Money { currency: expected } if currency == expected)
        }
        SourceTransform::Quantity { unit } => {
            (matches!(
                source,
                ValueType::Integer | ValueType::Decimal { .. } | ValueType::Text { .. }
            ) || matches!(source, ValueType::Quantity { unit: actual } if actual == unit))
                && matches!(target, ValueType::Quantity { unit: expected } if unit == expected)
        }
        SourceTransform::Timestamp => {
            matches!(source, ValueType::Timestamp { .. } | ValueType::Text { .. })
                && matches!(target, ValueType::Timestamp { .. })
        }
        SourceTransform::Text => {
            matches!(
                source,
                ValueType::Text { .. }
                    | ValueType::Boolean
                    | ValueType::Integer
                    | ValueType::Decimal { .. }
                    | ValueType::Timestamp { .. }
                    | ValueType::Date { .. }
            ) && matches!(target, ValueType::Text { .. })
        }
        SourceTransform::Boolean => {
            matches!(source, ValueType::Boolean | ValueType::Text { .. })
                && matches!(target, ValueType::Boolean)
        }
        SourceTransform::Date { calendar } => {
            (matches!(source, ValueType::Text { .. })
                || matches!(source, ValueType::Date { calendar: actual } if actual == calendar))
                && matches!(target, ValueType::Date { calendar: expected } if calendar == expected)
        }
    }
}

pub(crate) fn apply(
    transform: &SourceTransform,
    value: &Value,
    field: &SourceFieldId,
    property: &DefinitionRef,
    target: &ValueType,
    nullable: bool,
) -> Result<Value, MappingFailure> {
    let invalid = |reason| MappingFailure::InvalidValue {
        field: field.clone(),
        reason,
    };
    let unit = || MappingFailure::UnitMismatch {
        property: property.clone(),
    };
    let value = if matches!(value, Value::Null) {
        Value::Null
    } else {
        match transform {
            SourceTransform::Identity => value.clone(),
            SourceTransform::ExactInteger => Value::Integer {
                value: exact::integer(value).ok_or_else(|| invalid(RecordError::InvalidNumber))?,
            },
            SourceTransform::ExactDecimal => Value::Decimal {
                value: exact::decimal(value).ok_or_else(|| invalid(RecordError::InvalidNumber))?,
            },
            SourceTransform::Money { currency } => {
                let amount = match value {
                    Value::Money {
                        amount,
                        currency: actual,
                    } if currency == actual => amount.clone(),
                    Value::Money { .. } => return Err(unit()),
                    _ => {
                        exact::decimal(value).ok_or_else(|| invalid(RecordError::InvalidNumber))?
                    }
                };
                Value::Money {
                    amount,
                    currency: currency.clone(),
                }
            }
            SourceTransform::Quantity { unit: expected } => {
                let amount = match value {
                    Value::Quantity {
                        amount,
                        unit: actual,
                    } if expected == actual => amount.clone(),
                    Value::Quantity { .. } => return Err(unit()),
                    _ => {
                        exact::decimal(value).ok_or_else(|| invalid(RecordError::InvalidNumber))?
                    }
                };
                Value::Quantity {
                    amount,
                    unit: expected.clone(),
                }
            }
            SourceTransform::Timestamp => Value::Timestamp {
                value: exact::timestamp(value).ok_or_else(|| invalid(RecordError::InvalidDate))?,
            },
            SourceTransform::Text => Value::Text {
                value: match value {
                    Value::Text { value } => value.clone(),
                    Value::Boolean { value } => value.to_string(),
                    Value::Integer { value } => value.to_string(),
                    Value::Decimal { value } => value.to_string(),
                    Value::Timestamp { value } => value.to_string(),
                    Value::Date { value, .. } => value.clone(),
                    _ => return Err(invalid(RecordError::UnsupportedValue)),
                },
            },
            SourceTransform::Boolean => Value::Boolean {
                value: match value {
                    Value::Boolean { value } => *value,
                    Value::Text { value } if value == "true" => true,
                    Value::Text { value } if value == "false" => false,
                    _ => return Err(invalid(RecordError::UnsupportedValue)),
                },
            },
            SourceTransform::Date { calendar } => Value::Date {
                value: match value {
                    Value::Date {
                        value,
                        calendar: actual,
                    } if actual == calendar => value.clone(),
                    Value::Text { value } => value.clone(),
                    _ => return Err(invalid(RecordError::InvalidDate)),
                },
                calendar: calendar.clone(),
            },
        }
    };
    crate::definitions::validate_value(target, nullable, &value)
        .map_err(|failure| value_failure(failure, field, property))?;
    Ok(value)
}

pub(super) fn value_failure(
    failure: DefinitionFailure,
    field: &SourceFieldId,
    property: &DefinitionRef,
) -> MappingFailure {
    match failure {
        DefinitionFailure::UnitMismatch { .. } => MappingFailure::UnitMismatch {
            property: property.clone(),
        },
        DefinitionFailure::InvalidField {
            reason: DefinitionFieldReason::NullNotAllowed,
            ..
        } => MappingFailure::NullNotAllowed {
            property: property.clone(),
        },
        DefinitionFailure::InvalidField {
            reason: DefinitionFieldReason::InvalidScale | DefinitionFieldReason::InvalidPrecision,
            ..
        } => MappingFailure::InvalidValue {
            field: field.clone(),
            reason: RecordError::PrecisionLost,
        },
        DefinitionFailure::InvalidField {
            reason:
                DefinitionFieldReason::InvalidDate
                | DefinitionFieldReason::InvalidCalendar
                | DefinitionFieldReason::InvalidTimeZone,
            ..
        } => MappingFailure::InvalidValue {
            field: field.clone(),
            reason: RecordError::InvalidDate,
        },
        _ => MappingFailure::TypeMismatch {
            property: property.clone(),
        },
    }
}
