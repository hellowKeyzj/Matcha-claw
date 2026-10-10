use std::{
    fmt::Display,
    future::Future,
    sync::OnceLock,
    time::{Instant, SystemTime, UNIX_EPOCH},
};

use serde_json::{Map, Value};

/// The process environment is fixed at launch; hot-path checks do not reparse it.
pub fn enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var("MATCHACLAW_TRACE").as_deref() == Ok("1"))
}

tokio::task_local! {
    static SESSION_TRACE: Option<String>;
}

pub async fn with_session_trace<F: Future>(trace_id: Option<String>, future: F) -> F::Output {
    SESSION_TRACE.scope(trace_id, future).await
}

pub fn current_session_trace() -> Option<String> {
    SESSION_TRACE.try_with(Clone::clone).ok().flatten()
}

/// Matches the Renderer identifier fingerprint; never log the identifier itself.
pub fn identifier_hash(value: &str) -> String {
    let hash = value.encode_utf16().fold(2_166_136_261u32, |hash, unit| {
        (hash ^ u32::from(unit)).wrapping_mul(16_777_619)
    });
    format!("{hash:08x}")
}

/// Only fixed labels, identifier hashes, booleans, counts and timings belong here.
pub fn session_trace(stage: &'static str, payload: impl FnOnce() -> Value) {
    if !enabled() {
        return;
    }
    let Some(trace_id) = current_session_trace() else {
        return;
    };
    emit_trace(stage, Some(trace_id), payload);
}

/// Background owners have no request-local trace; correlate them with identifier hashes.
/// Only fixed labels, identifier hashes, booleans, counts and timings belong here.
pub fn runtime_trace(stage: &'static str, payload: impl FnOnce() -> Value) {
    if enabled() {
        emit_trace(stage, current_session_trace(), payload);
    }
}

fn emit_trace(stage: &'static str, trace_id: Option<String>, payload: impl FnOnce() -> Value) {
    let mut event = Map::new();
    event.insert("prefix".into(), "session-trace".into());
    event.insert("source".into(), "runtime-host".into());
    if let Some(trace_id) = trace_id {
        event.insert("traceId".into(), trace_id.into());
    }
    event.insert("stage".into(), stage.into());
    event.insert(
        "at".into(),
        (SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64)
            .into(),
    );
    if let Value::Object(fields) = payload() {
        event.extend(fields);
    }
    eprintln!("{}", Value::Object(event));
}

tokio::task_local! {
    static CHANNEL_TRACE: Option<String>;
}

fn validated_trace_id(trace_id: Option<String>) -> Option<String> {
    trace_id.filter(|id| {
        id.len() == 36
            && id.bytes().enumerate().all(|(index, byte)| {
                if matches!(index, 8 | 13 | 18 | 23) {
                    byte == b'-'
                } else {
                    byte.is_ascii_hexdigit()
                }
            })
    })
}

pub async fn with_channel_trace<F: Future>(trace_id: Option<String>, future: F) -> F::Output {
    CHANNEL_TRACE
        .scope(validated_trace_id(trace_id), future)
        .await
}

pub fn current_channel_trace() -> Option<String> {
    CHANNEL_TRACE.try_with(Clone::clone).ok().flatten()
}

pub fn with_channel_trace_sync<T>(trace_id: Option<String>, action: impl FnOnce() -> T) -> T {
    CHANNEL_TRACE.sync_scope(validated_trace_id(trace_id), action)
}

/// Callers supply only fixed phase names and safe enum/bool/count/timing summaries.
pub fn channel_trace<D: Display>(phase: &str, detail: impl FnOnce() -> D) {
    if !enabled() {
        return;
    }
    let trace_id = current_channel_trace();
    eprintln!(
        "[startup-trace] source=channel traceId={} phase={} detail={}",
        trace_id.as_deref().unwrap_or("none"),
        phase,
        detail()
    );
}

pub struct TraceSpan {
    source: &'static str,
    phase: &'static str,
    trace_id: Option<String>,
    started: Option<Instant>,
    outcome: &'static str,
}

impl TraceSpan {
    pub fn begin(source: &'static str, phase: &'static str) -> Self {
        channel_trace(phase, || "boundary=begin");
        Self {
            source,
            phase,
            trace_id: enabled().then(current_channel_trace).flatten(),
            started: enabled().then(Instant::now),
            outcome: "interrupted",
        }
    }

    pub fn finish(&mut self, outcome: &'static str) {
        self.outcome = outcome;
    }
}

impl Drop for TraceSpan {
    fn drop(&mut self) {
        let Some(started) = self.started else {
            return;
        };
        with_channel_trace_sync(self.trace_id.clone(), || {
            channel_trace(self.phase, || {
                format!(
                    "source={} boundary=end outcome={} elapsedMs={}",
                    self.source,
                    self.outcome,
                    started.elapsed().as_millis()
                )
            });
        });
    }
}
