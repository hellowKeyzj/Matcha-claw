use serde_json::Value;

pub fn security_trace(stage: &str, trace_id: Option<&str>, payload: Value) {
    eprintln!(
        "[startup-trace] source=security traceId={} stage={} payload={}",
        trace_id.unwrap_or("none"),
        stage,
        payload
    );
}
