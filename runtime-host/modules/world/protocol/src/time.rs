use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use std::{fmt, str::FromStr};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidTime;
impl fmt::Display for InvalidTime {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("invalid UTC timestamp or interval")
    }
}
impl std::error::Error for InvalidTime {}

/// UTC RFC3339 instant. Business dates and calendars are separate values.
#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(try_from = "String", into = "String")]
pub struct Timestamp {
    text: String,
    instant: DateTime<Utc>,
}
impl Ord for Timestamp {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.instant.cmp(&other.instant)
    }
}
impl PartialOrd for Timestamp {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}
impl Timestamp {
    pub fn try_new(value: impl Into<String>) -> Result<Self, InvalidTime> {
        let parsed = DateTime::parse_from_rfc3339(&value.into()).map_err(|_| InvalidTime)?;
        let instant = parsed.with_timezone(&Utc);
        Ok(Self {
            text: instant.to_rfc3339_opts(SecondsFormat::Nanos, true),
            instant,
        })
    }
    pub fn as_str(&self) -> &str {
        &self.text
    }
    pub fn unix_millis(&self) -> i64 {
        self.instant.timestamp_millis()
    }
    pub fn unix_nanos(&self) -> i128 {
        i128::from(self.instant.timestamp()) * 1_000_000_000
            + i128::from(self.instant.timestamp_subsec_nanos())
    }
}
impl TryFrom<String> for Timestamp {
    type Error = InvalidTime;
    fn try_from(value: String) -> Result<Self, InvalidTime> {
        Self::try_new(value)
    }
}
impl From<Timestamp> for String {
    fn from(value: Timestamp) -> Self {
        value.text
    }
}
impl FromStr for Timestamp {
    type Err = InvalidTime;
    fn from_str(value: &str) -> Result<Self, InvalidTime> {
        Self::try_new(value)
    }
}
impl fmt::Display for Timestamp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.text)
    }
}

#[derive(
    Clone,
    Copy,
    Debug,
    Default,
    Eq,
    Ord,
    PartialEq,
    PartialOrd,
    Serialize,
    Deserialize,
    schemars::JsonSchema,
)]
#[serde(transparent)]
pub struct DurationMs(
    #[serde(with = "crate::wire::u64_decimal")]
    #[schemars(with = "String")]
    pub u64,
);

/// Half-open business interval [from, to); None means no upper bound.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(try_from = "IntervalWire", into = "IntervalWire")]
pub struct ValidTime {
    pub from: Timestamp,
    pub to: Option<Timestamp>,
}
impl ValidTime {
    pub fn try_new(from: Timestamp, to: Option<Timestamp>) -> Result<Self, InvalidTime> {
        if to.as_ref().is_some_and(|to| to <= &from) {
            return Err(InvalidTime);
        }
        Ok(Self { from, to })
    }
    pub fn contains(&self, at: &Timestamp) -> bool {
        &self.from <= at && self.to.as_ref().is_none_or(|to| at < to)
    }
}
#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IntervalWire {
    from: Timestamp,
    to: Option<Timestamp>,
}
impl TryFrom<IntervalWire> for ValidTime {
    type Error = InvalidTime;
    fn try_from(value: IntervalWire) -> Result<Self, InvalidTime> {
        Self::try_new(value.from, value.to)
    }
}
impl From<ValidTime> for IntervalWire {
    fn from(value: ValidTime) -> Self {
        Self {
            from: value.from,
            to: value.to,
        }
    }
}
