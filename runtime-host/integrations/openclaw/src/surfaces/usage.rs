pub(crate) mod adapters;

use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

use serde_json::{Map, Value, json};

use crate::gateway::{
    client::GatewayClient,
    wire::{self, GatewayResponse},
};

const DEFAULT_LIMIT: usize = 100;
const MAX_LIMIT: usize = 1_000;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const SESSIONS_USAGE_METHOD: &str = "sessions.usage";

static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, PartialEq)]
pub struct UsageEntry {
    agent_id: String,
    session_id: String,
    timestamp: String,
    timestamp_millis: u64,
    model: Option<String>,
    provider: Option<String>,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_write_tokens: u64,
    total_tokens: u64,
    cost_usd: Option<f64>,
}

impl UsageEntry {
    pub fn new(
        agent_id: String,
        session_id: String,
        timestamp: String,
        timestamp_millis: u64,
        model: Option<String>,
        provider: Option<String>,
        tokens: UsageTokens,
        cost_usd: Option<f64>,
    ) -> Option<Self> {
        if !safe_agent_id(&agent_id)
            || !safe_session_id(&session_id)
            || chrono::DateTime::parse_from_rfc3339(&timestamp).is_err()
            || !tokens.is_safe()
            || cost_usd.is_some_and(|value| !valid_cost(value))
        {
            return None;
        }
        Some(Self {
            agent_id,
            session_id,
            timestamp,
            timestamp_millis,
            model: clean_optional_string(model),
            provider: clean_optional_string(provider),
            input_tokens: tokens.input,
            output_tokens: tokens.output,
            cache_read_tokens: tokens.cache_read,
            cache_write_tokens: tokens.cache_write,
            total_tokens: tokens.total,
            cost_usd,
        })
    }

    pub fn agent_id(&self) -> &str {
        &self.agent_id
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn timestamp(&self) -> &str {
        &self.timestamp
    }

    pub fn model(&self) -> Option<&str> {
        self.model.as_deref()
    }

    pub fn provider(&self) -> Option<&str> {
        self.provider.as_deref()
    }

    pub const fn input_tokens(&self) -> u64 {
        self.input_tokens
    }

    pub const fn output_tokens(&self) -> u64 {
        self.output_tokens
    }

    pub const fn cache_read_tokens(&self) -> u64 {
        self.cache_read_tokens
    }

    pub const fn cache_write_tokens(&self) -> u64 {
        self.cache_write_tokens
    }

    pub const fn total_tokens(&self) -> u64 {
        self.total_tokens
    }

    pub const fn cost_usd(&self) -> Option<f64> {
        self.cost_usd
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct UsageTokens {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
    total: u64,
}

impl UsageTokens {
    pub const fn new(
        input: u64,
        output: u64,
        cache_read: u64,
        cache_write: u64,
        total: u64,
    ) -> Self {
        Self {
            input,
            output,
            cache_read,
            cache_write,
            total,
        }
    }

    const fn is_safe(self) -> bool {
        self.input <= MAX_SAFE_INTEGER
            && self.output <= MAX_SAFE_INTEGER
            && self.cache_read <= MAX_SAFE_INTEGER
            && self.cache_write <= MAX_SAFE_INTEGER
            && self.total <= MAX_SAFE_INTEGER
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UsageReadError {
    Unavailable,
}

pub struct UsageProjection {
    gateway: Arc<GatewayClient>,
    session_keys: Mutex<HashMap<UsageSessionIdentity, String>>,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct UsageSessionIdentity {
    agent_id: String,
    session_id: String,
}

impl UsageProjection {
    pub fn new(gateway: Arc<GatewayClient>) -> Self {
        Self {
            gateway,
            session_keys: Mutex::new(HashMap::new()),
        }
    }

    pub async fn recent(&self, limit: usize) -> Result<Vec<UsageEntry>, UsageReadError> {
        let limit = limit.clamp(1, MAX_LIMIT);
        let request = sessions_usage_request(limit).map_err(|_| UsageReadError::Unavailable)?;
        let response = self
            .gateway
            .rpc_query(request)
            .await
            .map_err(|_| UsageReadError::Unavailable)?;
        match response {
            GatewayResponse::Success {
                payload: Some(payload),
                ..
            } => project_sessions_usage_payload(payload, limit, &self.session_keys),
            GatewayResponse::Success { payload: None, .. } | GatewayResponse::Failure { .. } => {
                Err(UsageReadError::Unavailable)
            }
        }
    }

    pub async fn session_timeseries(
        &self,
        agent_id: &str,
        session_id: &str,
    ) -> Result<Vec<UsageEntry>, UsageReadError> {
        if !safe_agent_id(agent_id) || !safe_session_id(session_id) {
            return Err(UsageReadError::Unavailable);
        }
        let key = UsageSessionIdentity {
            agent_id: agent_id.to_owned(),
            session_id: session_id.to_owned(),
        };
        let session_key = self
            .session_keys
            .lock()
            .map_err(|_| UsageReadError::Unavailable)?
            .get(&key)
            .cloned()
            .ok_or(UsageReadError::Unavailable)?;
        let request = sessions_usage_timeseries_request(&session_key)
            .map_err(|_| UsageReadError::Unavailable)?;
        let response = self
            .gateway
            .rpc_query(request)
            .await
            .map_err(|_| UsageReadError::Unavailable)?;
        match response {
            GatewayResponse::Success {
                payload: Some(payload),
                ..
            } => project_timeseries_payload(payload, agent_id, session_id),
            GatewayResponse::Success { payload: None, .. } | GatewayResponse::Failure { .. } => {
                Err(UsageReadError::Unavailable)
            }
        }
    }

    pub const fn default_limit() -> usize {
        DEFAULT_LIMIT
    }

    pub const fn max_limit() -> usize {
        MAX_LIMIT
    }
}

fn sessions_usage_request(limit: usize) -> Result<wire::RpcRequest, wire::WireError> {
    wire::operations_request(
        next_request_id("sessions-usage"),
        SESSIONS_USAGE_METHOD,
        json!({
            "agentScope": "all",
            "range": "all",
            "groupBy": "instance",
            "limit": limit,
            "includeContextWeight": false,
        }),
    )
}

fn sessions_usage_timeseries_request(key: &str) -> Result<wire::RpcRequest, wire::WireError> {
    wire::operations_request(
        next_request_id("sessions-usage-timeseries"),
        "sessions.usage.timeseries",
        json!({ "key": key }),
    )
}

fn next_request_id(operation: &str) -> String {
    let sequence = NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed);
    format!("usage-{operation}-{sequence}")
}

fn project_sessions_usage_payload(
    payload: Value,
    limit: usize,
    session_keys: &Mutex<HashMap<UsageSessionIdentity, String>>,
) -> Result<Vec<UsageEntry>, UsageReadError> {
    let sessions = payload
        .as_object()
        .and_then(|payload| payload.get("sessions"))
        .and_then(Value::as_array)
        .ok_or(UsageReadError::Unavailable)?;
    let mut entries = Vec::with_capacity(limit.min(sessions.len()));
    let mut next_keys = HashMap::with_capacity(sessions.len());
    for session in sessions {
        if let Some(projected) = project_session(session)? {
            if let Some(session_key) = projected.session_key {
                next_keys.insert(
                    UsageSessionIdentity {
                        agent_id: projected.entry.agent_id().to_owned(),
                        session_id: projected.entry.session_id().to_owned(),
                    },
                    session_key,
                );
            }
            entries.push(projected.entry);
        }
    }
    *session_keys
        .lock()
        .map_err(|_| UsageReadError::Unavailable)? = next_keys;
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.timestamp_millis));
    entries.truncate(limit);
    Ok(entries)
}

fn project_timeseries_payload(
    payload: Value,
    agent_id: &str,
    session_id: &str,
) -> Result<Vec<UsageEntry>, UsageReadError> {
    let points = payload
        .as_object()
        .and_then(|payload| payload.get("points"))
        .and_then(Value::as_array)
        .ok_or(UsageReadError::Unavailable)?;
    let mut entries = Vec::with_capacity(points.len());
    for point in points {
        if let Some(entry) = project_timeseries_point(point, agent_id, session_id)? {
            entries.push(entry);
        }
    }
    Ok(entries)
}

fn project_timeseries_point(
    value: &Value,
    agent_id: &str,
    session_id: &str,
) -> Result<Option<UsageEntry>, UsageReadError> {
    let point = value.as_object().ok_or(UsageReadError::Unavailable)?;
    let Some(timestamp_millis) = u64_field(point, "timestamp") else {
        return Ok(None);
    };
    let timestamp = iso_timestamp(timestamp_millis).ok_or(UsageReadError::Unavailable)?;
    let tokens = UsageTokens::new(
        required_u64(point, "input")?,
        required_u64(point, "output")?,
        required_u64(point, "cacheRead")?,
        u64_field(point, "cacheWrite").unwrap_or(0),
        required_u64(point, "totalTokens")?,
    );
    let cost_usd = optional_cost(point.get("cost"))?;
    Ok(UsageEntry::new(
        agent_id.to_owned(),
        session_id.to_owned(),
        timestamp,
        timestamp_millis,
        None,
        None,
        tokens,
        cost_usd,
    ))
}

struct ProjectedSession {
    entry: UsageEntry,
    session_key: Option<String>,
}

fn project_session(value: &Value) -> Result<Option<ProjectedSession>, UsageReadError> {
    let session = value.as_object().ok_or(UsageReadError::Unavailable)?;
    let Some(usage_value) = session.get("usage") else {
        return Err(UsageReadError::Unavailable);
    };
    if usage_value.is_null() {
        return Ok(None);
    }
    let usage = usage_value.as_object().ok_or(UsageReadError::Unavailable)?;
    let Some(agent_id) = string_field(session, "agentId").filter(|value| safe_agent_id(value))
    else {
        return Ok(None);
    };
    let session_key = session_key_field(session, "key");
    let Some(session_id) = string_field(session, "sessionId")
        .or_else(|| string_field(session, "currentSessionId"))
        .filter(|value| safe_session_id(value))
    else {
        return Ok(None);
    };
    let Some(timestamp_millis) = u64_field(usage, "lastActivity")
        .or_else(|| u64_field(session, "updatedAt"))
        .or_else(|| u64_field(usage, "firstActivity"))
    else {
        return Ok(None);
    };
    let timestamp = iso_timestamp(timestamp_millis).ok_or(UsageReadError::Unavailable)?;
    let tokens = UsageTokens::new(
        required_u64(usage, "input")?,
        required_u64(usage, "output")?,
        required_u64(usage, "cacheRead")?,
        required_u64(usage, "cacheWrite")?,
        required_u64(usage, "totalTokens")?,
    );
    if tokens.total == 0 {
        return Ok(None);
    }
    let (usage_model, usage_provider) = primary_model_usage(usage.get("modelUsage"));
    let model = string_field(session, "modelOverride")
        .or_else(|| string_field(session, "model"))
        .or(usage_model);
    let provider = string_field(session, "providerOverride")
        .or_else(|| string_field(session, "modelProvider"))
        .or(usage_provider);
    let cost_usd = optional_cost(usage.get("totalCost"))?;
    Ok(UsageEntry::new(
        agent_id.to_owned(),
        session_id.to_owned(),
        timestamp,
        timestamp_millis,
        model,
        provider,
        tokens,
        cost_usd,
    )
    .map(|entry| ProjectedSession { entry, session_key }))
}

fn primary_model_usage(value: Option<&Value>) -> (Option<String>, Option<String>) {
    let Some(entries) = value.and_then(Value::as_array) else {
        return (None, None);
    };
    entries
        .iter()
        .filter_map(Value::as_object)
        .find_map(|entry| {
            let model = string_field(entry, "model");
            let provider = string_field(entry, "provider");
            (model.is_some() || provider.is_some()).then_some((model, provider))
        })
        .unwrap_or((None, None))
}

fn required_u64(record: &Map<String, Value>, key: &str) -> Result<u64, UsageReadError> {
    record
        .get(key)
        .and_then(safe_u64)
        .ok_or(UsageReadError::Unavailable)
}

fn u64_field(record: &Map<String, Value>, key: &str) -> Option<u64> {
    record.get(key).and_then(safe_u64)
}

fn safe_u64(value: &Value) -> Option<u64> {
    value.as_u64().filter(|value| *value <= MAX_SAFE_INTEGER)
}

fn optional_cost(value: Option<&Value>) -> Result<Option<f64>, UsageReadError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let Some(value) = value.as_f64().filter(|value| valid_cost(*value)) else {
        return Err(UsageReadError::Unavailable);
    };
    Ok(Some(value))
}

fn valid_cost(value: f64) -> bool {
    value.is_finite() && value >= 0.0
}

fn string_field(record: &Map<String, Value>, key: &str) -> Option<String> {
    clean_optional_string(record.get(key).and_then(Value::as_str).map(str::to_owned))
}

fn session_key_field(record: &Map<String, Value>, key: &str) -> Option<String> {
    let value = record.get(key).and_then(Value::as_str)?.trim().to_owned();
    safe_session_key(&value).then_some(value)
}

fn clean_optional_string(value: Option<String>) -> Option<String> {
    let value = value?.trim().to_owned();
    (!value.is_empty() && value.len() <= 256).then_some(value)
}

fn safe_agent_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        && bytes.iter().all(|byte| !byte.is_ascii_uppercase())
}

fn safe_session_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 128
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        && !is_compaction_checkpoint_session_id(value)
}

/// OpenClaw's `validateSessionId` rejects `<id>.checkpoint.<uuid>` because that
/// shape names a derived compaction snapshot, which would double-index usage.
/// `COMPACTION_CHECKPOINT_TRANSCRIPT_RE` matches with `/i`, so the marker and
/// the uuid hex are both case-insensitive.
fn is_compaction_checkpoint_session_id(value: &str) -> bool {
    const MARKER: &[u8] = b".checkpoint.";
    let Some(index) = value
        .as_bytes()
        .windows(MARKER.len())
        .rposition(|window| window.eq_ignore_ascii_case(MARKER))
    else {
        return false;
    };
    index > 0 && is_uuid(&value[index + MARKER.len()..])
}

fn is_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            14 => matches!(byte, b'1'..=b'5'),
            19 => matches!(byte, b'8' | b'9' | b'a' | b'b' | b'A' | b'B'),
            _ => byte.is_ascii_hexdigit(),
        })
}

fn safe_session_key(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 512
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':'))
        && !value.contains("..")
}

fn iso_timestamp(milliseconds: u64) -> Option<String> {
    let milliseconds = i64::try_from(milliseconds).ok()?;
    chrono::DateTime::from_timestamp_millis(milliseconds)
        .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn projects_sessions_usage_response_to_recent_entries() {
        let session_keys = Mutex::new(HashMap::new());
        let entries = project_sessions_usage_payload(
            json!({
                "sessions": [
                    {
                        "key": "agent:main:first",
                        "sessionId": "session-1",
                        "updatedAt": 1770000000000_u64,
                        "agentId": "main",
                        "model": "store-model",
                        "modelProvider": "store-provider",
                        "usage": {
                            "input": 11,
                            "output": 5,
                            "cacheRead": 3,
                            "cacheWrite": 2,
                            "totalTokens": 21,
                            "totalCost": 0.12,
                            "lastActivity": 1770000000000_u64,
                            "modelUsage": [{ "provider": "usage-provider", "model": "usage-model", "count": 1, "totals": {} }]
                        }
                    },
                    {
                        "key": "agent:main:second",
                        "sessionId": "session-2",
                        "updatedAt": 1780000000000_u64,
                        "agentId": "main",
                        "usage": {
                            "input": 1,
                            "output": 2,
                            "cacheRead": 0,
                            "cacheWrite": 0,
                            "totalTokens": 3,
                            "lastActivity": 1780000000000_u64,
                            "modelUsage": [{ "provider": "p2", "model": "m2", "count": 1, "totals": {} }]
                        }
                    }
                ]
            }),
            1,
            &session_keys,
        )
        .unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(
            session_keys
                .lock()
                .unwrap()
                .get(&UsageSessionIdentity {
                    agent_id: "main".to_owned(),
                    session_id: "session-2".to_owned(),
                })
                .map(String::as_str),
            Some("agent:main:second")
        );
        assert_eq!(entries[0].session_id(), "session-2");
        assert_eq!(entries[0].agent_id(), "main");
        assert_eq!(entries[0].timestamp(), "2026-05-28T20:26:40.000Z");
        assert_eq!(entries[0].model(), Some("m2"));
        assert_eq!(entries[0].provider(), Some("p2"));
        assert_eq!(entries[0].total_tokens(), 3);
    }

    #[test]
    fn skips_sessions_without_usage_safe_public_identity_or_token_cost() {
        let session_keys = Mutex::new(HashMap::new());
        let entries = project_sessions_usage_payload(
            json!({
                "sessions": [
                    { "sessionId": "empty", "agentId": "main", "usage": null },
                    {
                        "key": "agent:main:zero",
                        "sessionId": "zero",
                        "agentId": "main",
                        "updatedAt": 1770000000000_u64,
                        "usage": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0 }
                    },
                    {
                        "sessionId": "../private",
                        "agentId": "main",
                        "updatedAt": 1770000000000_u64,
                        "usage": { "input": 1, "output": 1, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 2 }
                    },
                    {
                        "sessionId": "session-1",
                        "agentId": "Main",
                        "updatedAt": 1770000000000_u64,
                        "usage": { "input": 1, "output": 1, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 2 }
                    }
                ]
            }),
            100,
            &session_keys,
        )
        .unwrap();

        assert!(entries.is_empty());
        assert!(session_keys.lock().unwrap().is_empty());
    }

    #[test]
    fn projects_timeseries_points_with_openclaw_shape() {
        let entries = project_timeseries_payload(
            json!({
                "sessionId": "session-1",
                "points": [{
                    "timestamp": 1770000001000_u64,
                    "input": 10,
                    "output": 4,
                    "cacheRead": 2,
                    "totalTokens": 16,
                    "cost": 0.02,
                    "cumulativeTokens": 16,
                    "cumulativeCost": 0.02
                }]
            }),
            "main",
            "session-1",
        )
        .unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].session_id(), "session-1");
        assert_eq!(entries[0].cache_write_tokens(), 0);
        assert_eq!(entries[0].total_tokens(), 16);
    }

    #[test]
    fn rejects_malformed_sessions_usage_payload() {
        for payload in [
            json!({}),
            json!({ "sessions": [{}] }),
            json!({ "sessions": [{ "sessionId": "session-1", "agentId": "main", "usage": "raw" }] }),
            json!({
                "sessions": [{
                    "sessionId": "session-1",
                    "agentId": "main",
                    "updatedAt": 1770000000000_u64,
                    "usage": { "input": 1, "output": 1, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 2, "totalCost": -1 }
                }]
            }),
        ] {
            assert_eq!(
                project_sessions_usage_payload(payload, 100, &Mutex::new(HashMap::new())),
                Err(UsageReadError::Unavailable)
            );
        }
    }

    #[test]
    fn rejects_compaction_checkpoint_session_ids_case_insensitively() {
        assert!(!safe_session_id(
            "A.CHECKPOINT.0f8e1a2b-3c4d-4e5f-8a9b-1c2d3e4f5a6b"
        ));
        assert!(!safe_session_id(
            "s.checkpoint.0F8E1A2B-3C4D-4E5F-8A9B-1C2D3E4F5A6B"
        ));
        assert!(!safe_session_id(
            "s.CHECKPOINT.0F8E1A2B-3C4D-4E5F-8A9B-1C2D3E4F5A6B"
        ));
        assert!(!safe_session_id(
            "s.checkpoint.123e4567-e89b-42d3-a456-426614174000"
        ));
        assert!(safe_session_id("session-1"));
        assert!(safe_session_id("s.checkpoint.not-a-uuid"));
    }

    #[test]
    fn usage_request_uses_gateway_session_usage_method() {
        let request = sessions_usage_request(12).unwrap();
        assert_eq!(request.method(), SESSIONS_USAGE_METHOD);
        assert_eq!(
            request.params().and_then(|value| value.get("agentScope")),
            Some(&json!("all"))
        );
        assert_eq!(
            request.params().and_then(|value| value.get("range")),
            Some(&json!("all"))
        );
        assert_eq!(
            request.params().and_then(|value| value.get("limit")),
            Some(&json!(12))
        );
    }
}
