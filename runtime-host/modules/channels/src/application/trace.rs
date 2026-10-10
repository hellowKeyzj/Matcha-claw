use std::time::Instant;

use platform::trace::{channel_trace, current_channel_trace, enabled, with_channel_trace_sync};

pub struct CommandTrace {
    pub(crate) trace_id: Option<String>,
    queued_at: Option<Instant>,
    pub(crate) call: Option<super::call::ChannelCall>,
}

impl CommandTrace {
    pub(crate) fn capture() -> Self {
        channel_trace("channel.owner.enqueue", || "outcome=queued");
        Self {
            trace_id: current_channel_trace(),
            queued_at: enabled().then(Instant::now),
            call: None,
        }
    }

    pub(crate) fn received(&self) {
        if let Some(queued_at) = self.queued_at {
            channel_trace("channel.owner.receive", || {
                format!("queueMs={}", queued_at.elapsed().as_millis())
            });
        }
    }
}

pub struct ChannelTraceSpan {
    phase: &'static str,
    trace_id: Option<String>,
    started: Option<Instant>,
    outcome: &'static str,
}

impl ChannelTraceSpan {
    pub fn begin(phase: &'static str) -> Self {
        channel_trace(phase, || "boundary=begin");
        Self {
            phase,
            trace_id: if enabled() {
                current_channel_trace()
            } else {
                None
            },
            started: enabled().then(Instant::now),
            outcome: "interrupted",
        }
    }

    pub fn finish(&mut self, outcome: &'static str) {
        self.outcome = outcome;
    }
}

impl Drop for ChannelTraceSpan {
    fn drop(&mut self) {
        let Some(started) = self.started else {
            return;
        };
        with_channel_trace_sync(self.trace_id.clone(), || {
            channel_trace(self.phase, || {
                format!(
                    "boundary=end outcome={} elapsedMs={}",
                    self.outcome,
                    started.elapsed().as_millis()
                )
            });
        });
    }
}
