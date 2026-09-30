use ::cron::CronExecutionTerminalEvent;
use foundation::process::supervision::SupervisorSnapshot;
use openclaw::session::events::SessionEvent as OpenClawEvent;
use tokio::sync::{broadcast, mpsc};

const EVENT_CAPACITY: usize = 256;

#[derive(Debug)]
pub enum HostEvent {
    OpenClaw(OpenClawEvent),
    CronExecution(CronExecutionTerminalEvent),
    OpenClawRuntime,
    MatchaLifecycle(SupervisorSnapshot),
    CallChanged(platform::call::CallChanged),
    CallsResync,
}

pub struct HostEvents {
    open_claw: mpsc::Receiver<OpenClawEvent>,
    cron: mpsc::Receiver<CronExecutionTerminalEvent>,
    open_claw_runtime: mpsc::Receiver<()>,
    matcha_lifecycle: mpsc::Receiver<SupervisorSnapshot>,
    calls: Option<broadcast::Receiver<platform::call::CallChanged>>,
    open_claw_open: bool,
    cron_open: bool,
    open_claw_runtime_open: bool,
    matcha_lifecycle_open: bool,
}

impl HostEvents {
    pub(super) fn set_call_changes(
        &mut self,
        changes: broadcast::Receiver<platform::call::CallChanged>,
    ) {
        self.calls = Some(changes);
    }

    pub async fn next(&mut self) -> Option<HostEvent> {
        loop {
            if !self.open_claw_open
                && !self.cron_open
                && !self.open_claw_runtime_open
                && !self.matcha_lifecycle_open
                && self.calls.is_none()
            {
                return None;
            }
            tokio::select! {
                change = async {
                    match self.calls.as_mut() {
                        Some(calls) => calls.recv().await,
                        None => std::future::pending().await,
                    }
                } => match change {
                    Ok(change) => return Some(HostEvent::CallChanged(change)),
                    Err(broadcast::error::RecvError::Closed) => self.calls = None,
                    Err(broadcast::error::RecvError::Lagged(_)) => return Some(HostEvent::CallsResync),
                },
                event = self.open_claw.recv(), if self.open_claw_open => match event {
                    Some(event) => return Some(HostEvent::OpenClaw(event)),
                    None => self.open_claw_open = false,
                },
                event = self.cron.recv(), if self.cron_open => match event {
                    Some(event) => return Some(HostEvent::CronExecution(event)),
                    None => self.cron_open = false,
                },
                changed = self.open_claw_runtime.recv(), if self.open_claw_runtime_open => match changed {
                    Some(()) => return Some(HostEvent::OpenClawRuntime),
                    None => self.open_claw_runtime_open = false,
                },
                lifecycle = self.matcha_lifecycle.recv(), if self.matcha_lifecycle_open => match lifecycle {
                    Some(snapshot) => return Some(HostEvent::MatchaLifecycle(snapshot)),
                    None => self.matcha_lifecycle_open = false,
                },
            }
        }
    }
}

pub(super) struct EventSinks {
    open_claw: Option<mpsc::Sender<OpenClawEvent>>,
    cron: Option<mpsc::Sender<CronExecutionTerminalEvent>>,
    open_claw_runtime: Option<mpsc::Sender<()>>,
    matcha_lifecycle: Option<mpsc::Sender<SupervisorSnapshot>>,
}

impl EventSinks {
    pub(super) fn open_claw(&self) -> Option<mpsc::Sender<OpenClawEvent>> {
        self.open_claw.clone()
    }

    pub(super) fn cron(&self) -> Option<mpsc::Sender<CronExecutionTerminalEvent>> {
        self.cron.clone()
    }

    pub(super) fn open_claw_runtime(&self) -> Option<mpsc::Sender<()>> {
        self.open_claw_runtime.clone()
    }

    pub(super) fn matcha_lifecycle(&self) -> Option<mpsc::Sender<SupervisorSnapshot>> {
        self.matcha_lifecycle.clone()
    }

    pub(super) fn close_open_claw(&mut self) {
        self.open_claw = None;
        self.open_claw_runtime = None;
    }

    pub(super) fn close_cron(&mut self) {
        self.cron = None;
    }

    pub(super) fn close_matcha(&mut self) {
        self.matcha_lifecycle = None;
    }
}

pub(super) fn channels() -> (EventSinks, HostEvents) {
    let (open_claw, open_claw_events) = mpsc::channel(EVENT_CAPACITY);
    let (cron, cron_events) = mpsc::channel(EVENT_CAPACITY);
    let (open_claw_runtime, open_claw_runtime_events) = mpsc::channel(1);
    let (matcha_lifecycle, matcha_lifecycle_events) = mpsc::channel(1);
    (
        EventSinks {
            open_claw: Some(open_claw),
            cron: Some(cron),
            open_claw_runtime: Some(open_claw_runtime),
            matcha_lifecycle: Some(matcha_lifecycle),
        },
        HostEvents {
            open_claw: open_claw_events,
            cron: cron_events,
            open_claw_runtime: open_claw_runtime_events,
            matcha_lifecycle: matcha_lifecycle_events,
            calls: None,
            open_claw_open: true,
            cron_open: true,
            open_claw_runtime_open: true,
            matcha_lifecycle_open: true,
        },
    )
}

#[cfg(test)]
mod tests {
    use ::cron::CronExecutionTerminalStatus;
    use openclaw::session::events::{LifecycleEvent, SessionEvent};
    use tokio::sync::mpsc::error::TrySendError;

    use super::*;

    fn event(sequence: u64) -> SessionEvent {
        SessionEvent::lifecycle(LifecycleEvent::new(Some(sequence), true, false, true))
    }

    fn sequence(event: &SessionEvent) -> Option<u64> {
        event.lifecycle_event().and_then(|event| event.sequence())
    }

    #[tokio::test]
    async fn stream_preserves_openclaw_event_order() {
        let (sinks, mut events) = channels();
        let sender = sinks.open_claw().expect("OpenClaw event sink is open");
        sender.send(event(3)).await.unwrap();
        sender.send(event(5)).await.unwrap();

        assert!(matches!(
            events.next().await,
            Some(HostEvent::OpenClaw(event)) if sequence(&event) == Some(3)
        ));
        assert!(matches!(
            events.next().await,
            Some(HostEvent::OpenClaw(event)) if sequence(&event) == Some(5)
        ));
    }

    #[tokio::test]
    async fn host_queue_contains_only_safe_lifecycle_values() {
        let (sinks, mut events) = channels();
        sinks
            .open_claw()
            .expect("OpenClaw event sink is open")
            .send(event(7))
            .await
            .unwrap();

        let Some(HostEvent::OpenClaw(event)) = events.next().await else {
            panic!("expected queued OpenClaw lifecycle event");
        };
        assert_eq!(sequence(&event), Some(7));
        let lifecycle = event.lifecycle_event().expect("lifecycle event");
        assert!(lifecycle.has_run());
        assert!(!lifecycle.has_message());
        assert!(lifecycle.has_session_activity());
    }

    #[tokio::test]
    async fn runtime_state_changes_are_coalesced_without_peer_payloads() {
        let (sinks, mut events) = channels();
        let sender = sinks
            .open_claw_runtime()
            .expect("OpenClaw runtime sink is open");
        sender.try_send(()).unwrap();
        assert!(sender.try_send(()).is_err());

        assert!(matches!(
            events.next().await,
            Some(HostEvent::OpenClawRuntime)
        ));
    }

    #[tokio::test]
    async fn openclaw_event_ingress_is_bounded() {
        let (sinks, _events) = channels();
        let sender = sinks.open_claw().expect("OpenClaw event sink is open");
        for sequence in 0..EVENT_CAPACITY as u64 {
            sender.try_send(event(sequence)).unwrap();
        }

        assert!(matches!(
            sender.try_send(event(EVENT_CAPACITY as u64)),
            Err(TrySendError::Full(_))
        ));
    }

    #[tokio::test]
    async fn cron_execution_ingress_is_bounded_and_preserves_terminal_facts() {
        let (sinks, mut events) = channels();
        let sender = sinks.cron().expect("Cron event sink is open");
        for index in 0..EVENT_CAPACITY {
            sender
                .try_send(CronExecutionTerminalEvent::new(
                    format!("cron-job-{index}"),
                    format!("cron-run-{index}"),
                    CronExecutionTerminalStatus::Succeeded,
                ))
                .unwrap();
        }
        assert!(matches!(
            sender.try_send(CronExecutionTerminalEvent::new(
                "cron-job-overflow".to_owned(),
                "cron-run-overflow".to_owned(),
                CronExecutionTerminalStatus::Failed,
            )),
            Err(TrySendError::Full(_))
        ));

        assert!(matches!(
            events.next().await,
            Some(HostEvent::CronExecution(CronExecutionTerminalEvent {
                job_id,
                run_id,
                status: CronExecutionTerminalStatus::Succeeded,
            })) if job_id == "cron-job-0" && run_id == "cron-run-0"
        ));
    }

    #[tokio::test]
    async fn stream_drains_enqueued_events_before_closing() {
        let (mut sinks, mut events) = channels();
        sinks
            .open_claw()
            .expect("OpenClaw event sink is open")
            .send(event(7))
            .await
            .unwrap();
        sinks.close_open_claw();

        assert!(matches!(
            events.next().await,
            Some(HostEvent::OpenClaw(event)) if sequence(&event) == Some(7)
        ));
        sinks.close_cron();
        sinks.close_matcha();
        assert!(events.next().await.is_none());
    }

    #[tokio::test]
    async fn one_closed_event_stream_does_not_close_the_other() {
        let (mut sinks, mut events) = channels();
        sinks.close_open_claw();
        sinks
            .cron()
            .expect("Cron event sink is open")
            .send(CronExecutionTerminalEvent::new(
                "cron-job-1".to_owned(),
                "cron-run-1".to_owned(),
                CronExecutionTerminalStatus::Succeeded,
            ))
            .await
            .unwrap();

        assert!(matches!(
            events.next().await,
            Some(HostEvent::CronExecution(CronExecutionTerminalEvent {
                job_id,
                run_id,
                status: CronExecutionTerminalStatus::Succeeded,
            })) if job_id == "cron-job-1" && run_id == "cron-run-1"
        ));
    }
}
