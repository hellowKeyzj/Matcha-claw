mod validation;
pub use validation::{validate_value, validate_value_type};

use crate::{ids::*, time::Timestamp};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidValue;
impl std::fmt::Display for InvalidValue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("invalid typed value")
    }
}
impl std::error::Error for InvalidValue {}

/// Exact base-10 text; no exponent, NaN, infinity or floating-point conversion.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(try_from = "String", into = "String")]
pub struct Decimal(String);
impl Decimal {
    pub fn try_new(value: impl Into<String>) -> Result<Self, InvalidValue> {
        let value = value.into();
        let unsigned = value.strip_prefix('-').unwrap_or(&value);
        let mut parts = unsigned.split('.');
        let integer = parts.next().unwrap_or_default();
        let fraction = parts.next();
        if value.len() > 128
            || integer.is_empty()
            || !integer.bytes().all(|b| b.is_ascii_digit())
            || (integer.len() > 1 && integer.starts_with('0'))
            || parts.next().is_some()
            || fraction.is_some_and(|s| s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()))
        {
            return Err(InvalidValue);
        }
        let fraction = fraction.unwrap_or_default().trim_end_matches('0');
        let zero = integer == "0" && fraction.is_empty();
        let sign = if value.starts_with('-') && !zero {
            "-"
        } else {
            ""
        };
        let canonical = if fraction.is_empty() {
            format!("{sign}{integer}")
        } else {
            format!("{sign}{integer}.{fraction}")
        };
        Ok(Self(canonical))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
    pub fn cmp_numeric(&self, other: &Self) -> std::cmp::Ordering {
        let parts = |value: &Self| {
            let unsigned = value.0.trim_start_matches('-');
            let (integer, fraction) = unsigned.split_once('.').unwrap_or((unsigned, ""));
            (integer.len(), integer.to_owned(), fraction.to_owned())
        };
        let negative = self.0.starts_with('-');
        let other_negative = other.0.starts_with('-');
        match negative.cmp(&other_negative) {
            std::cmp::Ordering::Less => std::cmp::Ordering::Greater,
            std::cmp::Ordering::Greater => std::cmp::Ordering::Less,
            std::cmp::Ordering::Equal => {
                let order = parts(self).cmp(&parts(other));
                if negative { order.reverse() } else { order }
            }
        }
    }
    /// Exact nonnegative accounting; overflow beyond the decimal text capacity is explicit.
    pub fn checked_add_nonnegative(&self, other: &Self) -> Option<Self> {
        if self.0.starts_with('-') || other.0.starts_with('-') {
            return None;
        }
        let (left_integer, left_fraction) = self.0.split_once('.').unwrap_or((&self.0, ""));
        let (right_integer, right_fraction) = other.0.split_once('.').unwrap_or((&other.0, ""));
        let scale = left_fraction.len().max(right_fraction.len());
        let digits = |integer: &str, fraction: &str| {
            let mut digits = format!("{integer}{fraction}").into_bytes();
            digits.resize(digits.len() + scale - fraction.len(), b'0');
            digits
        };
        let left = digits(left_integer, left_fraction);
        let right = digits(right_integer, right_fraction);
        let mut result = Vec::with_capacity(left.len().max(right.len()) + 1);
        let mut carry = 0;
        for offset in 0..left.len().max(right.len()) {
            let digit = |digits: &[u8]| {
                digits
                    .len()
                    .checked_sub(offset + 1)
                    .map_or(0, |index| digits[index] - b'0')
            };
            let sum = digit(&left) + digit(&right) + carry;
            result.push(b'0' + sum % 10);
            carry = sum / 10;
        }
        if carry != 0 {
            result.push(b'0' + carry);
        }
        result.reverse();
        if scale != 0 {
            result.insert(result.len() - scale, b'.');
        }
        Self::try_new(String::from_utf8(result).ok()?).ok()
    }
}
impl TryFrom<String> for Decimal {
    type Error = InvalidValue;
    fn try_from(value: String) -> Result<Self, InvalidValue> {
        Self::try_new(value)
    }
}
impl From<Decimal> for String {
    fn from(value: Decimal) -> Self {
        value.0
    }
}
impl std::str::FromStr for Decimal {
    type Err = InvalidValue;
    fn from_str(value: &str) -> Result<Self, InvalidValue> {
        Self::try_new(value)
    }
}
impl std::fmt::Display for Decimal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(try_from = "String", into = "String")]
pub struct Currency(String);
impl Currency {
    pub fn try_new(value: impl Into<String>) -> Result<Self, InvalidValue> {
        let value = value.into();
        if value.len() != 3 || !value.bytes().all(|b| b.is_ascii_uppercase()) {
            return Err(InvalidValue);
        }
        Ok(Self(value))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
impl TryFrom<String> for Currency {
    type Error = InvalidValue;
    fn try_from(value: String) -> Result<Self, InvalidValue> {
        Self::try_new(value)
    }
}
impl From<Currency> for String {
    fn from(value: Currency) -> Self {
        value.0
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(try_from = "UnitWire", into = "UnitWire")]
pub struct Unit {
    pub code: String,
    pub dimension: String,
}
impl Unit {
    pub fn try_new(
        code: impl Into<String>,
        dimension: impl Into<String>,
    ) -> Result<Self, InvalidValue> {
        let code = code.into();
        let dimension = dimension.into();
        if code.is_empty()
            || code.len() > 64
            || code.chars().any(char::is_control)
            || dimension.is_empty()
            || dimension.len() > 64
            || !dimension
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_./".contains(&b))
        {
            return Err(InvalidValue);
        }
        Ok(Self { code, dimension })
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UnitWire {
    code: String,
    dimension: String,
}
impl TryFrom<UnitWire> for Unit {
    type Error = InvalidValue;
    fn try_from(value: UnitWire) -> Result<Self, InvalidValue> {
        Self::try_new(value.code, value.dimension)
    }
}
impl From<Unit> for UnitWire {
    fn from(value: Unit) -> Self {
        Self {
            code: value.code,
            dimension: value.dimension,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Value {
    Null,
    Boolean {
        value: bool,
    },
    Integer {
        #[serde(with = "crate::wire::i64_decimal")]
        #[schemars(with = "String")]
        value: i64,
    },
    Decimal {
        value: Decimal,
    },
    Text {
        value: String,
    },
    Money {
        amount: Decimal,
        currency: Currency,
    },
    Quantity {
        amount: Decimal,
        unit: Unit,
    },
    Timestamp {
        value: Timestamp,
    },
    Date {
        value: String,
        calendar: String,
    },
    Duration {
        #[serde(with = "crate::wire::u64_decimal")]
        #[schemars(with = "String")]
        milliseconds: u64,
    },
    Object {
        id: ObjectId,
    },
    Relation {
        id: RelationId,
    },
    List {
        items: Vec<Value>,
    },
    Record {
        fields: BTreeMap<String, Value>,
    },
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ValueType {
    Null,
    Boolean,
    Integer,
    Decimal {
        precision: u16,
        scale: u16,
    },
    Text {
        max_length: u32,
    },
    Money {
        currency: Currency,
    },
    Quantity {
        unit: Unit,
    },
    Timestamp {
        time_zone: String,
    },
    Date {
        calendar: String,
    },
    Duration,
    Object {
        type_id: DefinitionId,
    },
    Relation {
        type_id: DefinitionId,
    },
    List {
        element: Box<ValueType>,
        max_items: u32,
    },
    Record {
        fields: Vec<RecordField>,
    },
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordField {
    pub name: String,
    pub value_type: ValueType,
    pub nullable: bool,
    pub optional: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Cell {
    Known {
        value: Value,
    },
    Unknown {
        reason: UnknownReason,
    },
    Conflicted {
        assertions: Vec<AssertionRef>,
    },
    SourceUnavailable {
        source_id: SourceId,
        failure: crate::sources::SourceFailure,
    },
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum UnknownReason {
    NotObserved,
    Unmapped,
    NeedsEvidence,
    Unsupported,
    IncompleteCoverage,
    PendingRecomputation,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum DirtyState {
    Clean,
    Dirty {
        generation: Generation,
        invalidated_at: Timestamp,
        watches: Vec<WatchId>,
    },
}
