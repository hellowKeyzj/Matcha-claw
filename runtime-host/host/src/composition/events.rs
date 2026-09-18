use foundation::process::supervision::SupervisorSnapshot;
use matcha_agent::peer::SessionSubscriptionItem;
use openclaw::{
    port::{CanonicalIngressResult, CronExecutionStatus},
    session::events::SessionEvent as OpenClawEvent,
};
use tokio::sync::mpsc;

const EVENT_CAPACITY: usize = 256;

#[derive(Debug)]
pub enum HostEvent {
    OpenClaw(OpenClawEvent),
    OpenClawCanonical(CanonicalIngressResult),
    OpenClawCronExecution {
        job_id: String,
        run_id: String,
        status: CronExecutionStatus,
    },
    OpenClawRuntime,
    Matcha(SessionSubscriptionItem),
    MatchaLifecycle(SupervisorSnapshot),
}

pub struct HostEvents {
    open_claw: mpsc::Receiver<OpenClawEvent>,
    open_claw_canonical: mpsc::Receiver<CanonicalIngressResult>,
    open_claw_cron: mpsc::Receiver<(String, String, CronExecutionStatus)>,
    open_claw_runtime: mpsc::Receiver<()>,
    matcha: mpsc::Receiver<SessionSubscriptionItem>,
    matcha_lifecycle: mpsc::Receiver<SupervisorSnapshot>,
    open_claw_open: bool,
    open_claw_canonical_open: bool,
    open_claw_cron_open: bool,
    open_claw_runtime_open: bool,
    matcha_open: bool,
    matcha_lifecycle_open: bool,
}

impl HostEvents {
    pub async fn next(&mut self) -> Option<HostEvent> {
        loop {
            if !self.open_claw_open
                && !self.open_claw_canonical_open
                && !self.open_claw_cron_open
                && !self.open_claw_runtime_open
                && !self.matcha_open
                && !self.matcha_lifecycle_open
            {
                return None;
            }
            tokio::select! {
                event = self.open_claw.recv(), if self.open_claw_open => match event {
                    Some(event) => return Some(HostEvent::OpenClaw(event)),
                    None => self.open_claw_open = false,
                },
                canonical = self.open_claw_canonical.recv(), if self.open_claw_canonical_open => match canonical {
                    Some(canonical) => return Some(HostEvent::OpenClawCanonical(canonical)),
                    None => self.open_claw_canonical_open = false,
                },
                event = self.open_claw_cron.recv(), if self.open_claw_cron_open => match event {
                    Some((job_id, run_id, status)) => return Some(HostEvent::OpenClawCronExecution {
                        job_id,
                        run_id,
                        status,
                    }),
                    None => self.open_claw_cron_open = false,
                },
                changed = self.open_claw_runtime.recv(), if self.open_claw_runtime_open => match changed {
                    Some(()) => return Some(HostEvent::OpenClawRuntime),
                    None => self.open_claw_runtime_open = false,
                },
                event = self.matcha.recv(), if self.matcha_open => match event {
                    Some(event) => return Some(HostEvent::Matcha(event)),
                    None => self.matcha_open = false,
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
    open_claw_canonical: Option<mpsc::Sender<CanonicalIngressResult>>,
    open_claw_cron: Option<mpsc::Sender<(String, String, CronExecutionStatus)>>,
    open_claw_runtime: Option<mpsc::Sender<()>>,
    matcha: Option<mpsc::Sender<SessionSubscriptionItem>>,
    matcha_lifecycle: Option<mpsc::Sender<SupervisorSnapshot>>,
}

impl EventSinks {
    pub(super) fn open_claw(&self) -> Option<mpsc::Sender<OpenClawEvent>> {
        self.open_claw.clone()
    }

    pub(super) fn open_claw_canonical(&self) -> Option<mpsc::Sender<CanonicalIngressResult>> {
        self.open_claw_canonical.clone()
    }

    pub(super) fn open_claw_cron(
        &self,
    ) -> Option<mpsc::Sender<(String, String, CronExecutionStatus)>> {
        self.open_claw_cron.clone()
    }

    pub(super) fn open_claw_runtime(&self) -> Option<mpsc::Sender<()>> {
        self.open_claw_runtime.clone()
    }

    pub(super) fn matcha(&self) -> Option<mpsc::Sender<SessionSubscriptionItem>> {
        self.matcha.clone()
    }

    pub(super) fn matcha_lifecycle(&self) -> Option<mpsc::Sender<SupervisorSnapshot>> {
        self.matcha_lifecycle.clone()
    }

    pub(super) fn close_open_claw(&mut self) {
        self.open_claw = None;
        self.open_claw_canonical = None;
        self.open_claw_cron = None;
        self.open_claw_runtime = None;
    }

    pub(super) fn close_matcha(&mut self) {
        self.matcha = None;
        self.matcha_lifecycle = None;
    }
}

pub(super) fn channels() -> (EventSinks, HostEvents) {
    let (open_claw, open_claw_events) = mpsc::channel(EVENT_CAPACITY);
    let (open_claw_canonical, open_claw_canonical_events) = mpsc::channel(EVENT_CAPACITY);
    let (open_claw_cron, open_claw_cron_events) = mpsc::channel(EVENT_CAPACITY);
    let (open_claw_runtime, open_claw_runtime_events) = mpsc::channel(1);
    let (matcha, matcha_events) = mpsc::channel(EVENT_CAPACITY);
    let (matcha_lifecycle, matcha_lifecycle_events) = mpsc::channel(1);
    (
        EventSinks {
            open_claw: Some(open_claw),
            open_claw_canonical: Some(open_claw_canonical),
            open_claw_cron: Some(open_claw_cron),
            open_claw_runtime: Some(open_claw_runtime),
            matcha: Some(matcha),
            matcha_lifecycle: Some(matcha_lifecycle),
        },
        HostEvents {
            open_claw: open_claw_events,
            open_claw_canonical: open_claw_canonical_events,
            open_claw_cron: open_claw_cron_events,
            open_claw_runtime: open_claw_runtime_events,
            matcha: matcha_events,
            matcha_lifecycle: matcha_lifecycle_events,
            open_claw_open: true,
            open_claw_canonical_open: true,
            open_claw_cron_open: true,
            open_claw_runtime_open: true,
            matcha_open: true,
            matcha_lifecycle_open: true,
        },
    )
}

#[cfg(test)]
mod tests {
    use matcha_agent::peer::RendererEventEnvelope;
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
        let sender = sinks
            .open_claw_cron()
            .expect("OpenClaw cron event sink is open");
        for index in 0..EVENT_CAPACITY {
            sender
                .try_send((
                    format!("cron-job-{index}"),
                    format!("cron-run-{index}"),
                    CronExecutionStatus::Succeeded,
                ))
                .unwrap();
        }
        assert!(matches!(
            sender.try_send((
                "cron-job-overflow".to_owned(),
                "cron-run-overflow".to_owned(),
                CronExecutionStatus::Failed,
            )),
            Err(TrySendError::Full(_))
        ));

        assert!(matches!(
            events.next().await,
            Some(HostEvent::OpenClawCronExecution {
                job_id,
                run_id,
                status: CronExecutionStatus::Succeeded,
            }) if job_id == "cron-job-0" && run_id == "cron-run-0"
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
        sinks.close_matcha();
        assert!(events.next().await.is_none());
    }

    #[tokio::test]
    async fn one_closed_event_stream_does_not_close_the_other() {
        let (mut sinks, mut events) = channels();
        sinks.close_open_claw();
        sinks
            .matcha()
            .expect("Matcha event sink is open")
            .send(SessionSubscriptionItem::Event(RendererEventEnvelope::new(
                "renderer-route:test".to_owned(),
                "session:test".to_owned(),
                "run:test".to_owned(),
                1,
                None,
                matcha_agent::peer::RendererEvent::Run {
                    sequence: 1,
                    phase: matcha_agent::peer::RendererRunPhase::Started,
                },
            )))
            .await
            .unwrap();

        assert!(matches!(
            events.next().await,
            Some(HostEvent::Matcha(SessionSubscriptionItem::Event(envelope)))
                if envelope.route_key() == "renderer-route:test"
                    && matches!(envelope.event(), matcha_agent::peer::RendererEvent::Run { .. })
        ));
    }
}
