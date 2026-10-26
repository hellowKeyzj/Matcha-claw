use world_protocol::{
    definitions::{DefinitionFailure, DefinitionFieldReason as Reason, Scope},
    expression::{BinaryOperator, ExpressionIr, UnaryOperator},
    ids::{ScopeId, WorldRef},
    time::ValidTime,
    value::Value,
};

use super::invalid;

pub(crate) fn valid_time_contains(outer: &ValidTime, inner: &ValidTime) -> bool {
    outer.from <= inner.from
        && match (&outer.to, &inner.to) {
            (None, _) => true,
            (Some(outer), Some(inner)) => inner <= outer,
            (Some(_), None) => false,
        }
}

pub(crate) fn scope_contains(
    world: &WorldRef,
    outer: &ScopeId,
    inner: &ScopeId,
    scopes: &[Scope],
) -> Result<bool, DefinitionFailure> {
    let resolve = |id: &ScopeId| {
        let mut found = scopes
            .iter()
            .filter(|scope| &scope.world == world && &scope.id == id);
        let result = found.next().ok_or_else(|| {
            invalid(
                &["scope".into(), id.to_string()],
                Reason::IncompleteContract,
            )
        })?;
        if found.next().is_some() {
            return Err(invalid(
                &["scope".into(), id.to_string()],
                Reason::Duplicate,
            ));
        }
        Ok(result)
    };
    let outer = resolve(outer)?;
    let inner = resolve(inner)?;
    Ok(implies(&inner.predicate, &outer.predicate, 0))
}

// A proof, not a best-effort predicate evaluator: unsupported implications fail closed.
fn implies(inner: &ExpressionIr, outer: &ExpressionIr, depth: usize) -> bool {
    if depth > 64 {
        return false;
    }
    if inner == outer || boolean(outer) == Some(true) || boolean(inner) == Some(false) {
        return true;
    }
    match (inner, outer) {
        (_, ExpressionIr::All { terms }) => {
            terms.iter().all(|term| implies(inner, term, depth + 1))
        }
        (ExpressionIr::Any { terms }, _) => {
            terms.iter().all(|term| implies(term, outer, depth + 1))
        }
        (ExpressionIr::All { terms }, _) => {
            terms.iter().any(|term| implies(term, outer, depth + 1))
        }
        (_, ExpressionIr::Any { terms }) => {
            terms.iter().any(|term| implies(inner, term, depth + 1))
        }
        (
            ExpressionIr::Unary {
                operator: UnaryOperator::Not,
                operand: left,
            },
            ExpressionIr::Unary {
                operator: UnaryOperator::Not,
                operand: right,
            },
        ) => implies(right, left, depth + 1),
        (
            ExpressionIr::Binary {
                operator: left_op,
                left: left_field,
                right: left_value,
            },
            ExpressionIr::Binary {
                operator: right_op,
                left: right_field,
                right: right_value,
            },
        ) if left_field == right_field => {
            let (ExpressionIr::Literal { value: left }, ExpressionIr::Literal { value: right }) =
                (left_value.as_ref(), right_value.as_ref())
            else {
                return false;
            };
            let Some(order) = compare(left, right) else {
                return false;
            };
            use BinaryOperator::*;
            use std::cmp::Ordering::{Equal as Eq, Greater as Gt, Less as Lt};
            match (left_op, right_op) {
                (Equal, Equal) => order == Eq,
                (Equal, NotEqual) => order != Eq,
                (Equal, Less) => order == Lt,
                (Equal, LessOrEqual) => order != Gt,
                (Equal, Greater) => order == Gt,
                (Equal, GreaterOrEqual) => order != Lt,
                (Greater, Greater | GreaterOrEqual) | (GreaterOrEqual, GreaterOrEqual) => {
                    order != Lt
                }
                (GreaterOrEqual, Greater) => order == Gt,
                (Less, Less | LessOrEqual) | (LessOrEqual, LessOrEqual) => order != Gt,
                (LessOrEqual, Less) => order == Lt,
                _ => false,
            }
        }
        _ => false,
    }
}

fn boolean(expression: &ExpressionIr) -> Option<bool> {
    match expression {
        ExpressionIr::Literal {
            value: Value::Boolean { value },
        } => Some(*value),
        _ => None,
    }
}

fn compare(left: &Value, right: &Value) -> Option<std::cmp::Ordering> {
    Some(match (left, right) {
        (Value::Integer { value: left }, Value::Integer { value: right }) => left.cmp(right),
        (Value::Decimal { value: left }, Value::Decimal { value: right }) => {
            compare_decimal(left.as_str(), right.as_str())
        }
        (
            Value::Money {
                amount: left,
                currency: left_unit,
            },
            Value::Money {
                amount: right,
                currency: right_unit,
            },
        ) if left_unit == right_unit => compare_decimal(left.as_str(), right.as_str()),
        (
            Value::Quantity {
                amount: left,
                unit: left_unit,
            },
            Value::Quantity {
                amount: right,
                unit: right_unit,
            },
        ) if left_unit == right_unit => compare_decimal(left.as_str(), right.as_str()),
        (Value::Timestamp { value: left }, Value::Timestamp { value: right }) => left.cmp(right),
        (Value::Text { value: left }, Value::Text { value: right }) => left.cmp(right),
        (Value::Boolean { value: left }, Value::Boolean { value: right }) => left.cmp(right),
        _ if left == right => std::cmp::Ordering::Equal,
        _ => return None,
    })
}

fn compare_decimal(left: &str, right: &str) -> std::cmp::Ordering {
    let left_negative = left.starts_with('-');
    let right_negative = right.starts_with('-');
    if left_negative != right_negative {
        return right_negative.cmp(&left_negative);
    }
    let (left_integer, left_fraction) = left
        .trim_start_matches('-')
        .split_once('.')
        .unwrap_or((left.trim_start_matches('-'), ""));
    let (right_integer, right_fraction) = right
        .trim_start_matches('-')
        .split_once('.')
        .unwrap_or((right.trim_start_matches('-'), ""));
    let order = left_integer
        .len()
        .cmp(&right_integer.len())
        .then_with(|| left_integer.cmp(right_integer))
        .then_with(|| {
            left_fraction
                .bytes()
                .chain(std::iter::repeat(b'0'))
                .take(left_fraction.len().max(right_fraction.len()))
                .cmp(
                    right_fraction
                        .bytes()
                        .chain(std::iter::repeat(b'0'))
                        .take(left_fraction.len().max(right_fraction.len())),
                )
        });
    if left_negative {
        order.reverse()
    } else {
        order
    }
}
