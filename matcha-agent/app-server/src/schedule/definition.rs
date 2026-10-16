use sha2::{Digest, Sha256};
use std::str::FromStr;

use chrono::{DateTime, Utc};
use chrono_tz::Tz;
use cron::Schedule;
use serde::{Deserialize, Serialize};

use crate::{
    config,
    rpc::{self, Error},
};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Definition {
    pub agent_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cron: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule: Option<Pattern>,
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default)]
    pub delivery: Delivery,
    #[serde(default = "enabled")]
    pub enabled: bool,
    #[serde(default = "enabled")]
    pub recurring: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at_ms: Option<u64>,
}

#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(super) enum Pattern {
    Cron {
        expr: String,
        tz: Option<String>,
    },
    At {
        at: String,
    },
    Every {
        #[serde(rename = "everyMs")]
        every_ms: u64,
        #[serde(rename = "anchorMs")]
        anchor_ms: Option<u64>,
    },
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(tag = "mode", rename_all = "camelCase", deny_unknown_fields)]
pub(super) enum Delivery {
    #[default]
    None,
    Announce {
        channel: String,
        to: String,
        #[serde(rename = "accountId")]
        account_id: String,
    },
}

pub(super) enum Timing {
    Cron(Vec<Schedule>, Tz),
    At(u64),
    Every { every_ms: u64, anchor_ms: u64 },
}

fn enabled() -> bool {
    true
}

impl Definition {
    pub fn validate(&self) -> rpc::Result<Timing> {
        config::validate_id(&self.agent_id)?;
        if self.prompt.trim().is_empty() {
            return Err(Error::invalid("Schedule prompt must not be empty"));
        }
        if self
            .name
            .as_ref()
            .is_some_and(|value| value.trim().is_empty())
            || self
                .model
                .as_ref()
                .is_some_and(|value| value.trim().is_empty() || value.contains(['\0', '\r', '\n']))
        {
            return Err(Error::invalid("Schedule name and model must not be empty"));
        }
        if !matches!(self.delivery, Delivery::None) {
            return Err(Error::unavailable(
                "schedule_delivery_unsupported",
                "Channel announce requires a native result-delivery producer; no prompt has been submitted",
            ));
        }
        if let Some(session_id) = &self.session_id {
            uuid::Uuid::parse_str(session_id)
                .map_err(|_| Error::invalid("sessionId must be a UUID"))?;
        }
        match (&self.cron, &self.schedule) {
            (Some(expr), None) => parse_cron(expr, None, false),
            (None, Some(Pattern::Cron { expr, tz })) => parse_cron(expr, tz.as_deref(), true),
            (None, Some(Pattern::At { at })) => {
                let at = DateTime::parse_from_rfc3339(at).map_err(|_| {
                    Error::invalid("at must be an RFC3339 timestamp with an offset")
                })?;
                let millis = u64::try_from(at.timestamp_millis())
                    .map_err(|_| Error::invalid("at must not predate the Unix epoch"))?;
                if at.timestamp_subsec_nanos() % 1_000_000 != 0 {
                    return Err(Error::invalid("at supports millisecond precision"));
                }
                Ok(Timing::At(millis))
            }
            (
                None,
                Some(Pattern::Every {
                    every_ms,
                    anchor_ms,
                }),
            ) => {
                if *every_ms == 0
                    || *every_ms > i64::MAX as u64
                    || anchor_ms.is_some_and(|value| value > i64::MAX as u64)
                {
                    return Err(Error::invalid(
                        "everyMs must be positive and timestamps must fit signed milliseconds",
                    ));
                }
                let anchor_ms = anchor_ms.or(self.created_at_ms).ok_or_else(|| {
                    Error::invalid(
                        "Every schedule requires a persisted anchorMs or creation timestamp",
                    )
                })?;
                Ok(Timing::Every {
                    every_ms: *every_ms,
                    anchor_ms,
                })
            }
            _ => Err(Error::invalid("Specify exactly one of cron or schedule")),
        }
    }

    pub fn fingerprint(&self) -> rpc::Result<String> {
        digest(self)
    }

    pub fn timing_fingerprint(&self) -> rpc::Result<String> {
        digest(&(self.enabled, self.recurring, &self.cron, &self.schedule))
    }

    pub fn execution_fingerprint(&self) -> rpc::Result<String> {
        digest(&(&self.agent_id, &self.model, &self.session_id))
    }
}

fn digest(value: &impl Serialize) -> rpc::Result<String> {
    let bytes = serde_json::to_vec(value).map_err(|_| Error::internal("schedule_encode"))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn parse_cron(expr: &str, tz: Option<&str>, product: bool) -> rpc::Result<Timing> {
    let fields: Vec<_> = expr.split_whitespace().collect();
    let expressions = if product {
        if !matches!(fields.len(), 5 | 6) {
            return Err(Error::invalid("schedule cron must have 5 or 6 fields"));
        }
        // Product cron uses Sunday=0/7; the native cron crate uses Sunday=1.
        let weekday = fields
            .last()
            .ok_or_else(|| Error::invalid("Missing weekday"))?;
        let weekday = product_weekdays(weekday)?;
        let mut fields = fields[..fields.len() - 1].to_vec();
        fields.push(&weekday);
        if fields.len() == 5 {
            fields.insert(0, "0");
        }
        // Product cron follows the usual day-of-month OR weekday rule.
        if !matches!(fields[3], "*" | "?")
            && !matches!(expr.split_whitespace().last(), Some("*" | "?"))
        {
            let mut month_day = fields.clone();
            month_day[5] = "*";
            fields[3] = "*";
            vec![month_day.join(" "), fields.join(" ")]
        } else {
            vec![fields.join(" ")]
        }
    } else {
        if !matches!(fields.len(), 6 | 7) {
            return Err(Error::invalid(
                "cron must have 6 or 7 native fields, evaluated in UTC",
            ));
        }
        vec![expr.to_owned()]
    };
    let timezone = tz
        .unwrap_or("UTC")
        .parse::<Tz>()
        .map_err(|_| Error::invalid("tz must be a supported IANA timezone"))?;
    let schedules = expressions
        .iter()
        .map(|expression| {
            Schedule::from_str(expression).map_err(|_| Error::invalid("Invalid cron expression"))
        })
        .collect::<rpc::Result<Vec<_>>>()?;
    Ok(Timing::Cron(schedules, timezone))
}

fn product_weekdays(value: &str) -> rpc::Result<String> {
    let mut days = std::collections::BTreeSet::new();
    for item in value.split(',') {
        let (range, step) = match item.split_once('/') {
            Some((range, step)) => (
                range,
                step.parse::<u8>()
                    .ok()
                    .filter(|step| *step > 0)
                    .ok_or_else(|| Error::invalid("Invalid cron weekday step"))?,
            ),
            None => (item, 1),
        };
        let number = |value: &str| -> rpc::Result<u8> {
            match value.to_ascii_uppercase().as_str() {
                "SUN" => Ok(0),
                "MON" => Ok(1),
                "TUE" => Ok(2),
                "WED" => Ok(3),
                "THU" => Ok(4),
                "FRI" => Ok(5),
                "SAT" => Ok(6),
                _ => value
                    .parse::<u8>()
                    .ok()
                    .filter(|day| *day <= 7)
                    .ok_or_else(|| Error::invalid("Invalid cron weekday")),
            }
        };
        let (start, end) = if matches!(range, "*" | "?") {
            (0, 6)
        } else if let Some((start, end)) = range.split_once('-') {
            (number(start)?, number(end)?)
        } else {
            let start = number(range)?;
            (start, if item.contains('/') { 7 } else { start })
        };
        if start > end {
            return Err(Error::invalid("Invalid cron weekday range"));
        }
        for day in (start..=end).step_by(usize::from(step)) {
            days.insert((day % 7 + 1).to_string());
        }
    }
    Ok(days.into_iter().collect::<Vec<_>>().join(","))
}

pub(super) fn next_fire(timing: &Timing, after_ms: u64) -> rpc::Result<Option<u64>> {
    match timing {
        Timing::At(at) => Ok((*at > after_ms).then_some(*at)),
        Timing::Every {
            every_ms,
            anchor_ms,
        } => {
            if after_ms < *anchor_ms {
                return Ok(Some(*anchor_ms));
            }
            let periods = (after_ms - anchor_ms) / every_ms + 1;
            Ok(periods
                .checked_mul(*every_ms)
                .and_then(|offset| anchor_ms.checked_add(offset))
                .filter(|next| *next <= i64::MAX as u64))
        }
        Timing::Cron(schedules, timezone) => {
            let after = i64::try_from(after_ms)
                .ok()
                .and_then(DateTime::<Utc>::from_timestamp_millis)
                .ok_or_else(|| {
                    Error::invalid("Schedule timestamp is outside the supported calendar")
                })?;
            schedules
                .iter()
                .filter_map(|schedule| {
                    schedule
                        .after(&after.with_timezone(timezone))
                        .find(|next| next.timestamp_millis() > after.timestamp_millis())
                })
                .min()
                .map(|next| {
                    u64::try_from(next.timestamp_millis())
                        .map_err(|_| Error::invalid("Cron occurrence predates Unix epoch"))
                })
                .transpose()
        }
    }
}
