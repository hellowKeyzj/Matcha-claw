use std::{future::Future, time::Instant};

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
pub fn channel_trace(phase: &str, detail: &str) {
    let trace_id = current_channel_trace();
    eprintln!(
        "[startup-trace] source=channel traceId={} phase={} detail={}",
        trace_id.as_deref().unwrap_or("none"),
        phase,
        detail
    );
}

pub struct TraceSpan {
    source: &'static str,
    phase: &'static str,
    trace_id: Option<String>,
    started: Instant,
    outcome: &'static str,
}

impl TraceSpan {
    pub fn begin(source: &'static str, phase: &'static str) -> Self {
        channel_trace(phase, "boundary=begin");
        Self {
            source,
            phase,
            trace_id: current_channel_trace(),
            started: Instant::now(),
            outcome: "interrupted",
        }
    }

    pub fn finish(&mut self, outcome: &'static str) {
        self.outcome = outcome;
    }
}

impl Drop for TraceSpan {
    fn drop(&mut self) {
        with_channel_trace_sync(self.trace_id.clone(), || {
            channel_trace(
                self.phase,
                &format!(
                    "source={} boundary=end outcome={} elapsedMs={}",
                    self.source,
                    self.outcome,
                    self.started.elapsed().as_millis()
                ),
            );
        });
    }
}
