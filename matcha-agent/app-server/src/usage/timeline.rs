use crate::{
    events::{Event, NativeResult, NativeResultCursor},
    rpc,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub(super) const DEFAULT_LIMIT: usize = 100;
pub(super) const MAX_LIMIT: usize = 1_000;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Cursor {
    at_ms: u64,
    session_id: String,
    seq: u64,
}

impl Cursor {
    pub(super) fn native(&self) -> rpc::Result<NativeResultCursor> {
        if self.session_id.is_empty()
            || self.seq == 0
            || self.at_ms > i64::MAX as u64
            || self.seq > i64::MAX as u64
        {
            return Err(rpc::Error::invalid("Usage cursor is invalid"));
        }
        Ok(NativeResultCursor {
            at_ms: self.at_ms,
            session_id: self.session_id.clone(),
            seq: self.seq,
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Page {
    pub entries: Vec<Point>,
    pub next_before: Option<Cursor>,
    pub coverage: &'static str,
    pub native_outcome_unknown: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Point {
    session_id: String,
    agent_id: String,
    instance_id: Option<String>,
    started_seq: Option<u64>,
    seq: u64,
    at_ms: u64,
    run_id: Option<String>,
    uuid: Option<String>,
    subtype: Option<String>,
    is_error: Option<bool>,
    usage: QueryUsage,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct QueryUsage {
    status: &'static str,
    scope: &'static str,
    value: Tokens,
    reason: Option<&'static str>,
}

// These native fields are mutually exclusive; absent is not zero.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Tokens {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cache_read_input_tokens: Option<u64>,
    cache_creation_input_tokens: Option<u64>,
}

impl Point {
    pub(super) fn new(result: NativeResult, agent_id: String) -> Self {
        let Event {
            session_id,
            seq,
            run_id,
            at_ms,
            payload,
            ..
        } = result.event;
        let uuid = payload
            .get("uuid")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .map(str::to_owned);
        let subtype = payload
            .get("subtype")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let mut reason =
            if payload.get("session_id").and_then(Value::as_str) != Some(session_id.as_str()) {
                Some("native_result_session_mismatch")
            } else if result.instance_id.as_deref().is_none_or(str::is_empty) || uuid.is_none() {
                Some("native_result_identity_missing")
            } else if super::projection::error_placeholder(&payload) {
                Some("native_execution_error_placeholder")
            } else if !matches!(
                subtype.as_deref(),
                Some(
                    "success"
                        | "error_during_execution"
                        | "error_max_turns"
                        | "error_max_budget_usd"
                        | "error_max_structured_output_retries"
                )
            ) {
                Some("native_usage_scope_unknown")
            } else {
                None
            };
        let value = payload.get("usage");
        let tokens = Tokens {
            input_tokens: value
                .and_then(|value| value.get("input_tokens"))
                .and_then(Value::as_u64),
            output_tokens: value
                .and_then(|value| value.get("output_tokens"))
                .and_then(Value::as_u64),
            cache_read_input_tokens: value
                .and_then(|value| value.get("cache_read_input_tokens"))
                .and_then(Value::as_u64),
            cache_creation_input_tokens: value
                .and_then(|value| value.get("cache_creation_input_tokens"))
                .and_then(Value::as_u64),
        };
        if [
            tokens.input_tokens,
            tokens.output_tokens,
            tokens.cache_read_input_tokens,
            tokens.cache_creation_input_tokens,
        ]
        .iter()
        .any(Option::is_none)
        {
            reason.get_or_insert("native_usage_missing_or_invalid");
        }
        Self {
            session_id,
            agent_id,
            instance_id: result.instance_id,
            started_seq: result.started_seq,
            seq,
            at_ms,
            run_id,
            uuid,
            subtype,
            is_error: payload.get("is_error").and_then(Value::as_bool),
            usage: QueryUsage {
                status: if reason.is_none() {
                    "available"
                } else {
                    "unknown"
                },
                scope: "observedNativeQuery",
                value: tokens,
                reason,
            },
        }
    }

    pub(super) fn cursor(&self) -> Cursor {
        Cursor {
            at_ms: self.at_ms,
            session_id: self.session_id.clone(),
            seq: self.seq,
        }
    }
}

pub(super) fn limit(value: Option<usize>) -> rpc::Result<usize> {
    let limit = value.unwrap_or(DEFAULT_LIMIT);
    if !(1..=MAX_LIMIT).contains(&limit) {
        return Err(rpc::Error::invalid(
            "Usage limit must be between 1 and 1000",
        ));
    }
    Ok(limit)
}
