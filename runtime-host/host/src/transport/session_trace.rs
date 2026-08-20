use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};

pub(crate) const HEADER: &str = "x-matchaclaw-session-trace";

pub(crate) fn trace_id<'a>(headers: &'a [(String, String)]) -> Option<&'a str> {
    headers
        .iter()
        .find(|(name, _)| name == HEADER)
        .map(|(_, value)| value.as_str())
        .filter(|value| {
            !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
        })
}

pub(crate) fn log(stage: &str, trace_id: Option<&str>, payload: Value) {
    if trace_id.is_none() || std::env::var("MATCHACLAW_SESSION_TRACE").as_deref() != Ok("1") {
        return;
    }
    let mut event = Map::new();
    event.insert("prefix".into(), Value::String("session-trace".into()));
    event.insert("source".into(), Value::String("runtime-host".into()));
    event.insert(
        "traceId".into(),
        Value::String(trace_id.unwrap_or_default().into()),
    );
    event.insert("stage".into(), Value::String(stage.into()));
    event.insert("at".into(), Value::Number(now_millis().into()));
    if let Value::Object(fields) = payload {
        event.extend(fields);
    }
    eprintln!("{}", Value::Object(event));
}

pub(crate) fn id_shape(value: Option<&str>) -> Value {
    match value {
        Some(value) => serde_json::json!({ "present": true, "length": value.len() }),
        None => serde_json::json!({ "present": false, "length": 0 }),
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
