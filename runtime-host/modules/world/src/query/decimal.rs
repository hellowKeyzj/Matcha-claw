use num_bigint::BigInt;
use num_traits::{Signed, Zero};
use world_protocol::{expression::{BinaryOperator, ExpressionFailure}, failure::FieldPath, value::Decimal};

fn parts(value: &Decimal) -> Result<(BigInt, u32), ExpressionFailure> {
    let (integer, fraction) = value.as_str().split_once('.').unwrap_or((value.as_str(), ""));
    let coefficient = format!("{integer}{fraction}").parse().map_err(|_| ExpressionFailure::InternalFault)?;
    Ok((coefficient, fraction.len() as u32))
}

fn ten(power: u32) -> BigInt { BigInt::from(10).pow(power) }

fn finish(coefficient: BigInt, scale: u32, field: &FieldPath) -> Result<Decimal, ExpressionFailure> {
    let negative = coefficient.is_negative();
    let mut digits = coefficient.abs().to_string();
    if scale != 0 {
        let width = scale as usize + 1;
        if digits.len() < width { digits = format!("{}{}", "0".repeat(width - digits.len()), digits); }
        digits.insert(digits.len() - scale as usize, '.');
    }
    if negative { digits.insert(0, '-'); }
    // Canonicalize before enforcing the wire capacity: exact division may introduce trailing zeros.
    if digits.contains('.') {
        digits.truncate(digits.trim_end_matches('0').len());
        if digits.ends_with('.') { digits.pop(); }
    }
    Decimal::try_new(digits).map_err(|_| ExpressionFailure::Overflow { field: field.clone() })
}

pub(super) fn calculate(operator: BinaryOperator, left: &Decimal, right: &Decimal, field: &FieldPath) -> Result<Decimal, ExpressionFailure> {
    let (left, ls) = parts(left)?;
    let (right, rs) = parts(right)?;
    match operator {
        BinaryOperator::Add | BinaryOperator::Subtract => {
            let scale = ls.max(rs);
            let left = left * ten(scale - ls);
            let right = right * ten(scale - rs);
            finish(if operator == BinaryOperator::Add { left + right } else { left - right }, scale, field)
        }
        BinaryOperator::Multiply => finish(left * right, ls + rs, field),
        BinaryOperator::Divide => {
            if right.is_zero() { return Err(ExpressionFailure::DivisionByZero { field: field.clone() }); }
            let mut numerator = left * ten(rs);
            let mut denominator = right * ten(ls);
            if denominator.is_negative() { numerator = -numerator; denominator = -denominator; }
            let mut a = numerator.abs();
            let mut b = denominator.clone();
            while !b.is_zero() { let remainder = &a % &b; a = b; b = remainder; }
            numerator /= &a;
            denominator /= a;
            let mut twos = 0;
            let mut fives = 0;
            while (&denominator % 2_u8).is_zero() { denominator /= 2_u8; twos += 1; }
            while (&denominator % 5_u8).is_zero() { denominator /= 5_u8; fives += 1; }
            if denominator != BigInt::from(1) { return Err(ExpressionFailure::NonTerminatingDecimal { field: field.clone() }); }
            let scale = twos.max(fives);
            numerator *= BigInt::from(2).pow(scale - twos) * BigInt::from(5).pow(scale - fives);
            finish(numerator, scale, field)
        }
        _ => Err(ExpressionFailure::InvalidOperand { field: field.clone() }),
    }
}

pub(super) fn negate(value: &Decimal, field: &FieldPath) -> Result<Decimal, ExpressionFailure> {
    let (coefficient, scale) = parts(value)?;
    finish(-coefficient, scale, field)
}
