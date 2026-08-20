use super::{
    events::{EventActivity, EventProjectionResult, RunLifecycle, SessionEventProjector},
    model::{RunId, SessionId},
    protocol_event::EventEnvelope,
    receipt::TerminalRunStatus,
};

pub(crate) struct TerminalEventWatcher {
    projector: SessionEventProjector,
}

pub(crate) enum TerminalWatchStep {
    Pending,
    Terminal(TerminalRunStatus),
    Stop,
}

impl TerminalEventWatcher {
    pub(crate) fn new(session_id: SessionId, run_id: RunId) -> Self {
        Self {
            projector: SessionEventProjector::new(session_id, run_id),
        }
    }

    pub(crate) fn observe(&mut self, envelope: EventEnvelope) -> TerminalWatchStep {
        match self.projector.project(envelope) {
            EventProjectionResult::Projected(event) => match event.activity() {
                EventActivity::Run(RunLifecycle::Cancelled) => {
                    TerminalWatchStep::Terminal(TerminalRunStatus::Cancelled)
                }
                EventActivity::Run(RunLifecycle::Completed) => {
                    TerminalWatchStep::Terminal(TerminalRunStatus::Completed)
                }
                EventActivity::Run(RunLifecycle::Failed) => {
                    TerminalWatchStep::Terminal(TerminalRunStatus::Failed)
                }
                EventActivity::Run(RunLifecycle::Interrupted) => {
                    TerminalWatchStep::Terminal(TerminalRunStatus::Interrupted)
                }
                EventActivity::Run(_)
                | EventActivity::Message(_)
                | EventActivity::Tool(_)
                | EventActivity::Approval(_)
                | EventActivity::Ignored => TerminalWatchStep::Pending,
            },
            EventProjectionResult::Duplicate { .. } => TerminalWatchStep::Pending,
            EventProjectionResult::Rejected { .. }
            | EventProjectionResult::Gap { .. }
            | EventProjectionResult::Stale { .. }
            | EventProjectionResult::OutOfRun { .. }
            | EventProjectionResult::OutOfSession { .. } => TerminalWatchStep::Stop,
        }
    }
}

impl std::fmt::Debug for TerminalEventWatcher {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("TerminalEventWatcher")
            .finish_non_exhaustive()
    }
}

impl std::fmt::Debug for TerminalWatchStep {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Pending => formatter.write_str("Pending"),
            Self::Terminal(status) => formatter.debug_tuple("Terminal").field(status).finish(),
            Self::Stop => formatter.write_str("Stop"),
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;
    use crate::session::{
        model::{EventId, Sequence},
        protocol_event::Event,
    };

    fn sequence(value: u64) -> Sequence {
        Sequence::try_new(value).unwrap()
    }

    fn watcher() -> TerminalEventWatcher {
        TerminalEventWatcher::new(
            SessionId::try_new("session-1").unwrap(),
            RunId::try_new("run-1").unwrap(),
        )
    }

    fn envelope(seq: u64, session_id: &str, run_id: &str, event: Value) -> EventEnvelope {
        EventEnvelope {
            event_id: EventId::try_new(format!("event-{seq}")).unwrap(),
            session_id: SessionId::try_new(session_id).unwrap(),
            seq: sequence(seq),
            run_id: Some(RunId::try_new(run_id).unwrap()),
            worker_id: None,
            created_at: "now".to_owned(),
            event: Event::try_new(event).unwrap(),
        }
    }

    fn run_event(seq: u64, lifecycle: &str) -> EventEnvelope {
        envelope(
            seq,
            "session-1",
            "run-1",
            json!({"type": format!("run.{lifecycle}"), "runId": "run-1"}),
        )
    }

    #[test]
    fn accepts_only_valid_terminal_lifecycles_for_the_bound_identity() {
        for (lifecycle, expected) in [
            ("cancelled", TerminalRunStatus::Cancelled),
            ("completed", TerminalRunStatus::Completed),
            ("failed", TerminalRunStatus::Failed),
            ("interrupted", TerminalRunStatus::Interrupted),
        ] {
            let mut watcher = watcher();
            assert!(matches!(
                watcher.observe(run_event(1, lifecycle)),
                TerminalWatchStep::Terminal(status) if status == expected
            ));
        }
    }

    #[test]
    fn rejects_foreign_session_or_run_before_their_terminal_lifecycle() {
        let mut wrong_session = watcher();
        assert!(matches!(
            wrong_session.observe(envelope(
                1,
                "session-2",
                "run-1",
                json!({"type":"run.completed","runId":"run-1"}),
            )),
            TerminalWatchStep::Stop
        ));

        let mut wrong_run = watcher();
        assert!(matches!(
            wrong_run.observe(envelope(
                1,
                "session-1",
                "run-2",
                json!({"type":"run.completed","runId":"run-2"}),
            )),
            TerminalWatchStep::Stop
        ));
    }

    #[test]
    fn stops_on_sequence_or_protocol_faults_without_synthesizing_a_terminal() {
        let mut gap_watcher = watcher();
        assert!(matches!(
            gap_watcher.observe(run_event(2, "completed")),
            TerminalWatchStep::Stop
        ));

        let mut protocol_watcher = watcher();
        assert!(matches!(
            protocol_watcher.observe(envelope(
                1,
                "session-1",
                "run-1",
                json!({"type":"run.unknown","runId":"run-1"}),
            )),
            TerminalWatchStep::Stop
        ));
    }

    #[test]
    fn ignores_a_replayed_duplicate_without_accepting_active_lifecycles_as_terminal() {
        let mut watcher = watcher();
        assert!(matches!(
            watcher.observe(run_event(1, "cancelRequested")),
            TerminalWatchStep::Pending
        ));
        assert!(matches!(
            watcher.observe(run_event(1, "cancelRequested")),
            TerminalWatchStep::Pending
        ));
    }
}
