use std::time::Instant;

use platform::trace::{channel_trace, current_channel_trace, with_channel_trace_sync};

pub struct CommandTrace {
    pub(crate) trace_id: Option<String>,
    queued_at: Instant,
}

impl CommandTrace {
    pub(crate) fn capture() -> Self {
        channel_trace("channel.owner.enqueue", "outcome=queued");
        Self {
            trace_id: current_channel_trace(),
            queued_at: Instant::now(),
        }
    }

    pub(crate) fn received(&self) {
        channel_trace(
            "channel.owner.receive",
            &format!("queueMs={}", self.queued_at.elapsed().as_millis()),
        );
    }
}

pub struct ChannelTraceSpan {
    phase: &'static str,
    trace_id: Option<String>,
    started: Instant,
    outcome: &'static str,
}

impl ChannelTraceSpan {
    pub fn begin(phase: &'static str) -> Self {
        channel_trace(phase, "boundary=begin");
        Self {
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

impl Drop for ChannelTraceSpan {
    fn drop(&mut self) {
        with_channel_trace_sync(self.trace_id.clone(), || {
            channel_trace(
                self.phase,
                &format!(
                    "boundary=end outcome={} elapsedMs={}",
                    self.outcome,
                    self.started.elapsed().as_millis()
                ),
            );
        });
    }
}
