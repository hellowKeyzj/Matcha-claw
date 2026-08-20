use std::{
    num::NonZeroU64,
    sync::{
        Arc, RwLock,
        atomic::{AtomicBool, Ordering},
    },
};

use tokio::{sync::watch, time::Instant};
use tokio_util::sync::CancellationToken;

use super::super::{ProcessObservation, resource::ResourceEpoch};
use super::{
    ControlIntent, RestartEpisode, SupervisorFailure, SupervisorGeneration, SupervisorLease,
    SupervisorOperation, SupervisorOutcome, SupervisorPhase, SupervisorSnapshot,
    receipt::{Controls, Mutation},
    worker::StdioDrainCompletion,
};

pub(super) struct State {
    pub(super) phase: SupervisorPhase,
    pub(super) pending_epoch: Option<ResourceEpoch>,
    pub(super) active_epoch: Option<ResourceEpoch>,
    pub(super) observed: Option<(ResourceEpoch, ProcessObservation)>,
    pub(super) settled_epoch: Option<ResourceEpoch>,
    pub(super) startup_failure_epoch: Option<ResourceEpoch>,
    pub(super) active: Option<SupervisorOperation>,
    pub(super) generation: u64,
    next_lease_generation: NonZeroU64,
    lease: Option<SupervisorLease>,
    published_lease: Arc<RwLock<Option<SupervisorLease>>>,
    lease_issuance_closed: Arc<AtomicBool>,
    pub(super) episode: RestartEpisode,
    pub(super) failure: Option<SupervisorFailure>,
    pub(super) outcome: Option<SupervisorOutcome>,
    pub(super) mutation: Option<Mutation>,
    pub(super) controls: Controls,
    pub(super) intent: Option<ControlIntent>,
    pub(super) restarting: bool,
    pub(super) admission_closed: bool,
    pub(super) graceful_deadline: Option<Instant>,
    pub(super) graceful_started: bool,
    pub(super) kill_issued: Option<ResourceEpoch>,
    pub(super) shutdown_issued: bool,
    pub(super) begin_in_flight: Option<u64>,
    pub(super) pending_stdio_activation: Option<(u64, ResourceEpoch)>,
    pub(super) pending_native_activation: Option<(u64, ResourceEpoch)>,
    pub(super) stdio_failure_cleanup_epoch: Option<ResourceEpoch>,
    pub(super) stdio_drain_epoch: Option<ResourceEpoch>,
    pub(super) stdio_drain_result: Option<StdioDrainCompletion>,
    pub(super) stdio_drain_deadline: Option<Instant>,
    pub(super) owner_closed: bool,
    pub(super) recovery_after_cleanup: Option<Instant>,
    policy_cancellation: Option<CancellationToken>,
}

impl State {
    pub(super) fn new(initial: Option<(ResourceEpoch, ProcessObservation)>) -> Self {
        let lease_issuance_closed = Arc::new(AtomicBool::new(false));
        let (active_epoch, observed) = match initial {
            Some((epoch, observation)) => (Some(epoch), Some((epoch, observation))),
            None => (None, None),
        };
        Self {
            phase: if active_epoch.is_some() {
                SupervisorPhase::Running
            } else {
                SupervisorPhase::Idle
            },
            pending_epoch: None,
            active_epoch,
            observed,
            settled_epoch: None,
            startup_failure_epoch: None,
            active: None,
            generation: 0,
            next_lease_generation: NonZeroU64::MIN,
            lease: None,
            published_lease: Arc::new(RwLock::new(None)),
            lease_issuance_closed,
            episode: RestartEpisode::initial(),
            failure: None,
            outcome: None,
            mutation: None,
            controls: Controls::default(),
            intent: None,
            restarting: false,
            admission_closed: false,
            graceful_deadline: None,
            graceful_started: false,
            kill_issued: None,
            shutdown_issued: false,
            begin_in_flight: None,
            pending_stdio_activation: None,
            pending_native_activation: None,
            stdio_failure_cleanup_epoch: None,
            stdio_drain_epoch: None,
            stdio_drain_result: None,
            stdio_drain_deadline: None,
            owner_closed: false,
            recovery_after_cleanup: None,
            policy_cancellation: None,
        }
    }

    pub(super) fn published_lease(&self) -> Arc<RwLock<Option<SupervisorLease>>> {
        Arc::clone(&self.published_lease)
    }

    pub(super) fn lease_issuance_closed(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.lease_issuance_closed)
    }

    pub(super) fn close_lease_issuance(&mut self) {
        self.lease_issuance_closed.store(true, Ordering::Release);
        self.cancel_lease();
    }

    pub(super) fn issue_lease(&mut self) {
        self.cancel_lease();
        let generation = SupervisorGeneration::new(self.next_lease_generation);
        self.next_lease_generation = NonZeroU64::new(
            self.next_lease_generation
                .get()
                .checked_add(1)
                .expect("supervisor lease generation exhausted"),
        )
        .expect("supervisor lease generation must stay non-zero");
        let lease = SupervisorLease::new(generation, CancellationToken::new());
        let mut published = self
            .published_lease
            .write()
            .expect("supervisor lease state lock poisoned");
        if self.lease_issuance_closed.load(Ordering::Acquire) {
            lease.cancel();
            return;
        }
        *published = Some(lease.clone());
        self.lease = Some(lease);
    }

    pub(super) fn cancel_lease(&mut self) {
        if let Some(lease) = self.lease.take() {
            lease.cancel();
        }
        *self
            .published_lease
            .write()
            .expect("supervisor lease state lock poisoned") = None;
    }

    pub(super) fn issue_policy(&mut self) -> (u64, CancellationToken) {
        self.cancel_policy();
        let cancellation = CancellationToken::new();
        self.policy_cancellation = Some(cancellation.clone());
        (self.generation, cancellation)
    }

    pub(super) fn cancel_policy(&mut self) {
        if let Some(cancellation) = self.policy_cancellation.take() {
            cancellation.cancel();
        }
        self.generation = self
            .generation
            .checked_add(1)
            .expect("policy generation exhausted");
    }

    pub(super) fn observation(&self) -> Option<ProcessObservation> {
        self.observed.map(|(_, observation)| observation)
    }

    pub(super) fn is_attached(&self) -> bool {
        self.observation().is_some_and(super::action::is_attached)
    }

    pub(super) const fn has_process_or_begin(&self) -> bool {
        self.active_epoch.is_some()
            || self.pending_epoch.is_some()
            || self.begin_in_flight.is_some()
    }

    pub(super) const fn has_policy_work(&self) -> bool {
        matches!(
            self.phase,
            SupervisorPhase::Starting | SupervisorPhase::WaitingToRestart
        ) && self.policy_cancellation.is_some()
    }

    pub(super) fn settle_failure(&mut self) -> bool {
        let Some(episode) = self.episode.checked_next() else {
            return false;
        };
        self.episode = episode;
        true
    }

    #[cfg(test)]
    pub(super) fn set_episode(&mut self, episode: RestartEpisode) {
        self.episode = episode;
    }

    pub(super) fn reset_control_episode(&mut self) {
        self.intent = None;
        self.graceful_deadline = None;
        self.graceful_started = false;
        self.kill_issued = None;
        self.shutdown_issued = false;
        self.recovery_after_cleanup = None;
    }

    pub(super) fn publish(&self, snapshots: &watch::Sender<SupervisorSnapshot>) {
        let mut snapshot = SupervisorSnapshot::idle();
        snapshot.update(
            self.phase,
            self.observation(),
            self.active,
            self.episode,
            self.failure.clone(),
            self.outcome.clone(),
        );
        snapshots.send_replace(snapshot);
    }
}
