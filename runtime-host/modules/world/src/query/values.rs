use std::cmp::Ordering;
use world_protocol::{
    expression::{BinaryOperator, ExpressionFailure}, failure::FieldPath,
    value::{Decimal, Value},
};
use super::decimal;

fn invalid(field: &FieldPath) -> ExpressionFailure { ExpressionFailure::InvalidOperand { field: field.clone() } }
fn overflow(field: &FieldPath) -> ExpressionFailure { ExpressionFailure::Overflow { field: field.clone() } }

pub(super) fn compare(left: &Value, right: &Value, field: &FieldPath) -> Result<Ordering, ExpressionFailure> {
    Ok(match (left, right) {
        (Value::Integer { value: left }, Value::Integer { value: right }) => left.cmp(right),
        (Value::Decimal { value: left }, Value::Decimal { value: right }) => left.cmp_numeric(right),
        (Value::Integer { .. }, Value::Decimal { .. }) | (Value::Decimal { .. }, Value::Integer { .. }) => scalar(left, field)?.cmp_numeric(&scalar(right, field)?),
        (Value::Text { value: left }, Value::Text { value: right }) => left.cmp(right),
        (Value::Money { amount: left, currency: lc }, Value::Money { amount: right, currency: rc }) if lc == rc => left.cmp_numeric(right),
        (Value::Quantity { amount: left, unit: lu }, Value::Quantity { amount: right, unit: ru }) if lu == ru => left.cmp_numeric(right),
        (Value::Timestamp { value: left }, Value::Timestamp { value: right }) => left.cmp(right),
        (Value::Date { value: left, calendar: lc }, Value::Date { value: right, calendar: rc }) if lc == rc => {
            // Validation owns supported calendars and canonical business-date representations.
            for value in [left, right] {
                crate::definitions::validate_value(&world_protocol::value::ValueType::Date { calendar: lc.clone() }, false,
                    &Value::Date { value: value.clone(), calendar: lc.clone() }).map_err(|_| invalid(field))?;
            }
            left.cmp(right)
        }
        (Value::Duration { milliseconds: left }, Value::Duration { milliseconds: right }) => left.cmp(right),
        _ => return Err(invalid(field)),
    })
}

pub(super) fn equal(left: &Value, right: &Value, field: &FieldPath) -> Result<bool, ExpressionFailure> {
    match (left, right) {
        (Value::Integer { .. }, Value::Decimal { .. }) | (Value::Decimal { .. }, Value::Integer { .. }) => Ok(scalar(left, field)? == scalar(right, field)?),
        (Value::Money { currency: left, .. }, Value::Money { currency: right, .. }) if left != right => Err(invalid(field)),
        (Value::Quantity { unit: left, .. }, Value::Quantity { unit: right, .. }) if left != right => Err(invalid(field)),
        (Value::Date { calendar: left, .. }, Value::Date { calendar: right, .. }) if left != right => Err(invalid(field)),
        (Value::List { items: left }, Value::List { items: right }) => {
            if left.len() != right.len() { return Ok(false); }
            for (left, right) in left.iter().zip(right) { if !equal(left, right, field)? { return Ok(false); } }
            Ok(true)
        }
        (Value::Record { fields: left }, Value::Record { fields: right }) => {
            if left.keys().ne(right.keys()) { return Ok(false); }
            for (key, value) in left { if !equal(value, &right[key], field)? { return Ok(false); } }
            Ok(true)
        }
        _ if std::mem::discriminant(left) == std::mem::discriminant(right) => Ok(left == right),
        _ => Err(invalid(field)),
    }
}

fn scalar(value: &Value, field: &FieldPath) -> Result<Decimal, ExpressionFailure> {
    match value {
        Value::Decimal { value } => Ok(value.clone()),
        Value::Integer { value } => Decimal::try_new(value.to_string()).map_err(|_| overflow(field)),
        _ => Err(invalid(field)),
    }
}

pub(super) fn binary(operator: BinaryOperator, left: &Value, right: &Value, field: &FieldPath) -> Result<Value, ExpressionFailure> {
    use BinaryOperator::*;
    if matches!(left, Value::Null) || matches!(right, Value::Null) { return Ok(Value::Null); }
    if matches!(operator, Equal | NotEqual) {
        let same = equal(left, right, field)?;
        return Ok(Value::Boolean { value: if operator == Equal { same } else { !same } });
    }
    if matches!(operator, Less | LessOrEqual | Greater | GreaterOrEqual) {
        let order = compare(left, right, field)?;
        return Ok(Value::Boolean { value: match operator { Less => order.is_lt(), LessOrEqual => !order.is_gt(), Greater => order.is_gt(), _ => !order.is_lt() } });
    }
    if operator == Contains {
        return Ok(Value::Boolean { value: match (left, right) {
            (Value::Text { value: left }, Value::Text { value: right }) => left.contains(right),
            (Value::List { items }, right) => { let mut found = false; for item in items { found |= equal(item, right, field)?; } found }
            _ => return Err(invalid(field)),
        } });
    }
    match (left, right) {
        (Value::Integer { value: left }, Value::Integer { value: right }) if operator != Divide => {
            let value = match operator { Add => left.checked_add(*right), Subtract => left.checked_sub(*right), Multiply => left.checked_mul(*right), _ => None };
            Ok(Value::Integer { value: value.ok_or_else(|| overflow(field))? })
        }
        (Value::Integer { .. } | Value::Decimal { .. }, Value::Integer { .. } | Value::Decimal { .. }) => {
            Ok(Value::Decimal { value: decimal::calculate(operator, &scalar(left, field)?, &scalar(right, field)?, field)? })
        }
        (Value::Money { amount: left, currency: lc }, Value::Money { amount: right, currency: rc }) if lc == rc && matches!(operator, Add | Subtract) => {
            Ok(Value::Money { amount: decimal::calculate(operator, left, right, field)?, currency: lc.clone() })
        }
        (Value::Quantity { amount: left, unit: lu }, Value::Quantity { amount: right, unit: ru }) if lu == ru && matches!(operator, Add | Subtract) => {
            Ok(Value::Quantity { amount: decimal::calculate(operator, left, right, field)?, unit: lu.clone() })
        }
        (Value::Money { amount, currency }, right) if matches!(operator, Multiply | Divide) => {
            Ok(Value::Money { amount: decimal::calculate(operator, amount, &scalar(right, field)?, field)?, currency: currency.clone() })
        }
        (Value::Quantity { amount, unit }, right) if matches!(operator, Multiply | Divide) => {
            Ok(Value::Quantity { amount: decimal::calculate(operator, amount, &scalar(right, field)?, field)?, unit: unit.clone() })
        }
        (left, Value::Money { amount, currency }) if operator == Multiply => {
            Ok(Value::Money { amount: decimal::calculate(operator, &scalar(left, field)?, amount, field)?, currency: currency.clone() })
        }
        (left, Value::Quantity { amount, unit }) if operator == Multiply => {
            Ok(Value::Quantity { amount: decimal::calculate(operator, &scalar(left, field)?, amount, field)?, unit: unit.clone() })
        }
        (Value::Duration { milliseconds: left }, Value::Duration { milliseconds: right }) if matches!(operator, Add | Subtract) => {
            Ok(Value::Duration { milliseconds: if operator == Add { left.checked_add(*right) } else { left.checked_sub(*right) }.ok_or_else(|| overflow(field))? })
        }
        _ => Err(invalid(field)),
    }
}

pub(super) fn negate(value: &Value, field: &FieldPath) -> Result<Value, ExpressionFailure> {
    Ok(match value {
        Value::Null => Value::Null,
        Value::Integer { value } => Value::Integer { value: value.checked_neg().ok_or_else(|| overflow(field))? },
        Value::Decimal { value } => Value::Decimal { value: decimal::negate(value, field)? },
        Value::Money { amount, currency } => Value::Money { amount: decimal::negate(amount, field)?, currency: currency.clone() },
        Value::Quantity { amount, unit } => Value::Quantity { amount: decimal::negate(amount, field)?, unit: unit.clone() },
        _ => return Err(invalid(field)),
    })
}
