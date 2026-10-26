use super::SourceError;
use std::collections::BTreeMap;
use world_protocol::{
    failure::{FailureStage, FieldPath},
    ids::{ObjectId, RelationId},
    sources::{RecordCell, RecordError, SourceFailure},
    time::Timestamp,
    value::{Decimal, Value, ValueType},
};

pub(super) fn from_text(text: Option<&str>, value_type: &ValueType, nullable: bool) -> RecordCell {
    let Some(text) = text else {
        return if nullable {
            RecordCell::Known { value: Value::Null }
        } else {
            RecordCell::Error {
                code: RecordError::UnsupportedValue,
            }
        };
    };
    let value = match value_type {
        ValueType::Boolean => match text {
            "true" | "t" => Some(Value::Boolean { value: true }),
            "false" | "f" => Some(Value::Boolean { value: false }),
            _ => None,
        },
        ValueType::Integer => text.parse().ok().map(|value| Value::Integer { value }),
        ValueType::Decimal { .. } => decimal(text).map(|value| Value::Decimal { value }),
        ValueType::Money { currency } => decimal(text).map(|amount| Value::Money {
            amount,
            currency: currency.clone(),
        }),
        ValueType::Quantity { unit } => decimal(text).map(|amount| Value::Quantity {
            amount,
            unit: unit.clone(),
        }),
        ValueType::Text { .. } => Some(Value::Text { value: text.into() }),
        ValueType::Timestamp { time_zone } => match timestamp(text, time_zone) {
            Ok(value) => Some(Value::Timestamp { value }),
            Err(code) => return RecordCell::Error { code },
        },
        ValueType::Date { calendar } => Some(Value::Date {
            value: text.into(),
            calendar: calendar.clone(),
        }),
        ValueType::Duration => text
            .parse()
            .ok()
            .map(|milliseconds| Value::Duration { milliseconds }),
        ValueType::Object { .. } => ObjectId::try_new(text).ok().map(|id| Value::Object { id }),
        ValueType::Relation { .. } => RelationId::try_new(text)
            .ok()
            .map(|id| Value::Relation { id }),
        ValueType::List { .. } | ValueType::Record { .. } => {
            serde_json::from_str::<serde_json::Value>(text)
                .ok()
                .and_then(|value| json_value(&value, value_type, 0))
        }
        ValueType::Null => None,
    };
    let Some(value) = value else {
        return RecordCell::Error {
            code: error_code(value_type),
        };
    };
    if crate::definitions::validate_value(value_type, nullable, &value).is_err() {
        return RecordCell::Error {
            code: error_code(value_type),
        };
    }
    RecordCell::Known { value }
}

pub(super) fn from_json(
    value: Option<&serde_json::Value>,
    value_type: &ValueType,
    nullable: bool,
) -> RecordCell {
    let Some(value) = value else {
        return RecordCell::Missing;
    };
    if value.is_null() {
        return from_text(None, value_type, nullable);
    }
    if let serde_json::Value::String(text) = value {
        if !matches!(
            value_type,
            ValueType::List { .. } | ValueType::Record { .. }
        ) {
            return from_text(Some(text), value_type, nullable);
        }
    }
    let parsed = json_value(value, value_type, 0);
    match parsed {
        Some(value) if crate::definitions::validate_value(value_type, nullable, &value).is_ok() => {
            RecordCell::Known { value }
        }
        _ => RecordCell::Error {
            code: error_code(value_type),
        },
    }
}

fn json_value(value: &serde_json::Value, value_type: &ValueType, depth: usize) -> Option<Value> {
    if depth > 64 {
        return None;
    }
    if value.is_null() {
        return Some(Value::Null);
    }
    match value_type {
        ValueType::List { element, max_items } => {
            let items = value.as_array()?;
            if items.len() > *max_items as usize {
                return None;
            }
            Some(Value::List {
                items: items
                    .iter()
                    .map(|item| json_value(item, element, depth + 1))
                    .collect::<Option<_>>()?,
            })
        }
        ValueType::Record { fields } => {
            let object = value.as_object()?;
            if object
                .keys()
                .any(|name| !fields.iter().any(|field| &field.name == name))
            {
                return None;
            }
            let mut result = BTreeMap::new();
            for field in fields {
                let Some(value) = object.get(&field.name) else {
                    if field.optional {
                        continue;
                    }
                    return None;
                };
                if value.is_null() && !field.nullable {
                    return None;
                }
                result.insert(
                    field.name.clone(),
                    json_value(value, &field.value_type, depth + 1)?,
                );
            }
            Some(Value::Record { fields: result })
        }
        _ => {
            let text = match (value_type, value) {
                (_, serde_json::Value::String(text)) => text.clone(),
                (
                    ValueType::Integer
                    | ValueType::Decimal { .. }
                    | ValueType::Money { .. }
                    | ValueType::Quantity { .. }
                    | ValueType::Duration,
                    serde_json::Value::Number(number),
                ) => number.to_string(),
                (ValueType::Boolean, serde_json::Value::Bool(value)) => value.to_string(),
                _ => return None,
            };
            match from_text(Some(&text), value_type, false) {
                RecordCell::Known { value } => Some(value),
                _ => None,
            }
        }
    }
}
fn decimal(text: &str) -> Option<Decimal> {
    let Some((mantissa, exponent)) = text.split_once(['e', 'E']) else {
        return Decimal::try_new(text).ok();
    };
    let exponent = exponent.parse::<i32>().ok()?;
    let mantissa = Decimal::try_new(mantissa).ok()?;
    if mantissa.as_str() == "0" {
        return Some(mantissa);
    }
    let unsigned = mantissa.as_str().trim_start_matches('-');
    let (integer, fraction) = unsigned.split_once('.').unwrap_or((unsigned, ""));
    let digits = format!("{integer}{fraction}");
    let first = digits.find(|digit: char| digit != '0')?;
    let digits = digits[first..].trim_end_matches('0');
    let point = integer.len() as i64 + i64::from(exponent) - first as i64;
    let negative = mantissa.as_str().starts_with('-');
    let length = if point <= 0 {
        2 - point + digits.len() as i64
    } else if point >= digits.len() as i64 {
        point
    } else {
        digits.len() as i64 + 1
    };
    if length + i64::from(negative) > 128 {
        return None;
    }
    let value = if point <= 0 {
        format!("0.{}{digits}", "0".repeat((-point) as usize))
    } else if point >= digits.len() as i64 {
        format!("{digits}{}", "0".repeat(point as usize - digits.len()))
    } else {
        format!(
            "{}.{}",
            &digits[..point as usize],
            &digits[point as usize..]
        )
    };
    Decimal::try_new(if negative { format!("-{value}") } else { value }).ok()
}

fn timestamp(text: &str, time_zone: &str) -> Result<Timestamp, RecordError> {
    use chrono::TimeZone;
    if let Some((_, suffix)) = text.split_once('.') {
        if suffix
            .bytes()
            .take_while(u8::is_ascii_digit)
            .skip(9)
            .any(|digit| digit != b'0')
        {
            return Err(RecordError::PrecisionLost);
        }
    }
    if let Ok(value) = Timestamp::try_new(text) {
        return Ok(value);
    }
    let zone = time_zone
        .parse::<chrono_tz::Tz>()
        .map_err(|_| RecordError::InvalidDate)?;
    let local = chrono::NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%M:%S%.f")
        .or_else(|_| chrono::NaiveDateTime::parse_from_str(text, "%Y-%m-%d %H:%M:%S%.f"))
        .map_err(|_| RecordError::InvalidDate)?;
    let instant = zone
        .from_local_datetime(&local)
        .single()
        .ok_or(RecordError::InvalidDate)?;
    Timestamp::try_new(instant.to_rfc3339_opts(chrono::SecondsFormat::Nanos, false))
        .map_err(|_| RecordError::InvalidDate)
}

/// Source identities use canonical typed values, never backend-specific textual formatting.
pub(in crate::sources) fn native_key(cells: &[RecordCell]) -> Result<String, SourceError> {
    world_protocol::sources::native_key(cells)
        .map_err(|failure| SourceError::new(failure, FailureStage::Decode))
}

fn error_code(value_type: &ValueType) -> RecordError {
    match value_type {
        ValueType::Integer
        | ValueType::Decimal { .. }
        | ValueType::Money { .. }
        | ValueType::Quantity { .. } => RecordError::InvalidNumber,
        ValueType::Date { .. } | ValueType::Timestamp { .. } => RecordError::InvalidDate,
        _ => RecordError::UnsupportedValue,
    }
}
pub(super) fn invalid_response(field: impl Into<String>) -> SourceError {
    SourceError::new(
        SourceFailure::ResponseInvalid {
            field: FieldPath(vec![field.into()]),
        },
        FailureStage::Decode,
    )
}
