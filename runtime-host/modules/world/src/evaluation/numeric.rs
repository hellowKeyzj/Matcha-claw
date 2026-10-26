use std::cmp::Ordering;
use world_protocol::value::Decimal;

pub(super) fn compare(left: &Decimal, right: &Decimal) -> Ordering {
    left.cmp_numeric(right)
}

pub(super) fn add(left: &Decimal, right: &Decimal) -> Option<Decimal> {
    left.checked_add_nonnegative(right)
}

pub(super) fn integer(value: u64) -> Decimal {
    Decimal::try_new(value.to_string()).expect("u64 is an exact decimal")
}

pub(super) fn ratio(numerator: u64, denominator: u64) -> Option<Decimal> {
    if denominator == 0 {
        return None;
    }
    let scaled = (numerator as u128) * 1_000_000_000 / denominator as u128;
    Decimal::try_new(format!(
        "{}.{:09}",
        scaled / 1_000_000_000,
        scaled % 1_000_000_000
    ))
    .ok()
}
