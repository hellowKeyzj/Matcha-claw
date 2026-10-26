use world_protocol::{
    time::Timestamp,
    value::{Decimal, Value},
};

pub(super) fn decimal(value: &Value) -> Option<Decimal> {
    match value {
        Value::Decimal { value } => Some(value.clone()),
        Value::Integer { value } => Decimal::try_new(value.to_string()).ok(),
        Value::Text { value } => Decimal::try_new(value.clone()).ok(),
        _ => None,
    }
}

pub(super) fn integer(value: &Value) -> Option<i64> {
    if let Value::Integer { value } = value {
        return Some(*value);
    }
    let decimal = decimal(value)?;
    let (integer, fraction) = decimal
        .as_str()
        .split_once('.')
        .unwrap_or((decimal.as_str(), ""));
    if !fraction.bytes().all(|digit| digit == b'0') {
        return None;
    }
    integer.parse().ok()
}

pub(super) fn timestamp(value: &Value) -> Option<Timestamp> {
    match value {
        Value::Timestamp { value } => Some(value.clone()),
        // An explicit RFC3339 offset is required; no machine-local zone inference.
        Value::Text { value } => Timestamp::try_new(value.clone()).ok(),
        _ => None,
    }
}
