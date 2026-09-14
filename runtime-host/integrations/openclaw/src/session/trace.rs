use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};

const SESSION_TRACE_ENV: &str = "MATCHACLAW_SESSION_TRACE";

pub(crate) fn enabled() -> bool {
    std::env::var(SESSION_TRACE_ENV).as_deref() == Ok("1")
}

pub(crate) fn log_unscoped(stage: &str, payload: Value) {
    if !enabled() {
        return;
    }
    let mut event = Map::new();
    event.insert("prefix".into(), Value::String("session-trace".into()));
    event.insert("source".into(), Value::String("runtime-host".into()));
    event.insert("stage".into(), Value::String(stage.into()));
    event.insert("at".into(), Value::Number(now_millis().into()));
    if let Value::Object(fields) = payload {
        event.extend(fields);
    }
    eprintln!("{}", Value::Object(event));
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
