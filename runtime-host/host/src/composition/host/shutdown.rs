use std::fmt;

use foundation::{
    execution::{
        ObservationRecord, ObservationSink, ShutdownObservation, ShutdownReason, ShutdownStage,
        TraceContext,
    },
    process::{ShutdownOutcome, supervision::SupervisorSnapshot},
};

use super::{Host, HostTransitionError};
use crate::composition::{
    owner::PendingSupervisorJoin,
    session::{SessionShutdown, SessionShutdownFailure},
};

impl Host {
    pub async fn shutdown(&mut self) -> Result<ShutdownReport, HostShutdownError> {
        let observation = shutdown_observation_sink(self);
        match self.admission.state().phase() {
            super::super::admission::HostPhase::Created
            | super::super::admission::HostPhase::Starting
            | super::super::admission::HostPhase::Ready => {
                observe_shutdown_start(&observation, "closeAdmission");
                let result = self
                    .admission
                    .begin_shutdown()
                    .map_err(HostShutdownError::Transition);
                observe_shutdown_settle(
                    &observation,
                    "closeAdmission",
                    shutdown_reason_from_result(&result),
                );
                result?
            }
            super::super::admission::HostPhase::ShuttingDown => {
                observe_shutdown_start(&observation, "closeAdmission");
                observe_shutdown_settle(
                    &observation,
                    "closeAdmission",
                    ShutdownReason::AlreadyClosed,
                );
            }
            super::super::admission::HostPhase::ShutDown => {
                observe_shutdown_start(&observation, "closeAdmission");
                observe_shutdown_settle(
                    &observation,
                    "closeAdmission",
                    ShutdownReason::AlreadyClosed,
                );
                let failures = self.shutdown_failures.failures();
                let report = self.shutdown_failures.report();
                observe_shutdown_start(&observation, "shutdownReport");
                observe_shutdown_settle(
                    &observation,
                    "shutdownReport",
                    if failures.any() {
                        ShutdownReason::Unresolved
                    } else {
                        ShutdownReason::Completed
                    },
                );
                return if failures.any() {
                    Err(HostShutdownError::Resources { failures, report })
                } else {
                    Ok(report)
                };
            }
        }

        observe_shutdown_start(&observation, "ownerRuntimeTasks");
        self.owner_runtime_tasks.cancel_and_join().await;
        observe_shutdown_settle(&observation, "ownerRuntimeTasks", ShutdownReason::Completed);
        observe_shutdown_start(&observation, "sessionDeltaSinkClose");
        self.event_sinks.close_session_delta();
        observe_shutdown_settle(
            &observation,
            "sessionDeltaSinkClose",
            ShutdownReason::Completed,
        );
        shutdown_open_claw_session(self, &observation).await;
        shutdown_open_claw(self, &observation).await;
        shutdown_matcha(self, &observation).await;
        if !self.shutdown_failures.all_settled() {
            let failures = self.shutdown_failures.failures();
            let report = self.shutdown_failures.report();
            observe_shutdown_start(&observation, "shutdownReport");
            observe_shutdown_settle(&observation, "shutdownReport", ShutdownReason::Unresolved);
            return Err(HostShutdownError::Resources { failures, report });
        }
        if self.admission.state().phase() == super::super::admission::HostPhase::ShuttingDown {
            observe_shutdown_start(&observation, "closeAdmission");
            let result = self
                .admission
                .complete_shutdown()
                .map_err(HostShutdownError::Transition);
            observe_shutdown_settle(
                &observation,
                "closeAdmission",
                shutdown_reason_from_result(&result),
            );
            result?;
        }
        let failures = self.shutdown_failures.failures();
        let report = self.shutdown_failures.report();
        observe_shutdown_start(&observation, "shutdownReport");
        observe_shutdown_settle(
            &observation,
            "shutdownReport",
            if failures.any() {
                ShutdownReason::Unresolved
            } else {
                ShutdownReason::Completed
            },
        );
        if failures.any() {
            Err(HostShutdownError::Resources { failures, report })
        } else {
            Ok(report)
        }
    }
}

fn shutdown_observation_sink(host: &Host) -> ObservationSink {
    host.runtime_observation.sink()
}

fn observe_shutdown_start(sink: &ObservationSink, step: &'static str) {
    observe_shutdown_step(sink, step, ShutdownStage::Start, None);
}

fn observe_shutdown_settle(sink: &ObservationSink, step: &'static str, reason: ShutdownReason) {
    observe_shutdown_step(sink, step, ShutdownStage::Settle, Some(reason));
}

fn observe_shutdown_step(
    sink: &ObservationSink,
    step: &'static str,
    stage: ShutdownStage,
    reason: Option<ShutdownReason>,
) {
    sink.observe(ObservationRecord::Shutdown(ShutdownObservation {
        trace: TraceContext::absent(),
        step,
        stage,
        reason,
    }));
}

fn shutdown_reason_from_result<T, E>(result: &Result<T, E>) -> ShutdownReason {
    match result {
        Ok(_) => ShutdownReason::Completed,
        Err(_) => ShutdownReason::Unresolved,
    }
}

fn shutdown_outcome_reason<E>(result: &Result<ShutdownOutcome, E>) -> ShutdownReason {
    match result {
        Ok(ShutdownOutcome::Unresolved { .. }) => ShutdownReason::Unresolved,
        Ok(_) => ShutdownReason::Completed,
        Err(_) => ShutdownReason::ConfirmationFailed,
    }
}

fn session_shutdown_reason(failure: Option<SessionShutdownFailure>) -> ShutdownReason {
    match failure {
        None => ShutdownReason::Completed,
        Some(SessionShutdownFailure::Close) => ShutdownReason::Unresolved,
        Some(SessionShutdownFailure::Join) => ShutdownReason::JoinFailed,
    }
}

async fn shutdown_open_claw_session(host: &mut Host, observation: &ObservationSink) {
    observe_shutdown_start(observation, "openClawSession");
    let already_settled = host.shutdown_failures.open_claw_session.is_settled();
    host.cron_handle.cancel_operations().await;
    host.shutdown_failures.open_claw_session.finish().await;
    if host.shutdown_failures.open_claw_session.is_settled() {
        host.event_sinks.close_open_claw();
    }
    let reason = if already_settled {
        ShutdownReason::AlreadyClosed
    } else {
        session_shutdown_reason(host.shutdown_failures.open_claw_session.failure())
    };
    observe_shutdown_settle(observation, "openClawSession", reason);
}

async fn shutdown_open_claw(host: &mut Host, observation: &ObservationSink) {
    let mut join_started = false;
    if host.open_claw.owner_if_present().is_none() {
        observe_shutdown_start(observation, "openClawConfirm");
        observe_shutdown_settle(
            observation,
            "openClawConfirm",
            ShutdownReason::AlreadyClosed,
        );
    } else {
        observe_shutdown_start(observation, "openClawConfirm");
        let confirmation = host.open_claw.owner().confirm_shutdown().await;
        observe_shutdown_settle(
            observation,
            "openClawConfirm",
            shutdown_outcome_reason(&confirmation),
        );
        match confirmation {
            Ok(outcome @ ShutdownOutcome::Unresolved { .. }) => {
                host.shutdown_failures.open_claw = SlotState::Unresolved { outcome };
            }
            Ok(outcome) => {
                let snapshot = host.open_claw.owner().snapshot();
                observe_shutdown_start(observation, "openClawJoin");
                join_started = true;
                let join = host.open_claw.take_owner().begin_join();
                host.shutdown_failures.open_claw = SlotState::Joining {
                    snapshot,
                    outcome,
                    join,
                };
            }
            Err(_)
                if !matches!(
                    host.shutdown_failures.open_claw,
                    SlotState::Unresolved { .. }
                ) =>
            {
                host.shutdown_failures.open_claw = SlotState::Shutdown;
            }
            Err(_) => {}
        }
    }
    let already_settled = matches!(
        host.shutdown_failures.open_claw,
        SlotState::JoinFailed { .. } | SlotState::Settled { .. }
    );
    let pending_join = matches!(host.shutdown_failures.open_claw, SlotState::Joining { .. });
    if pending_join && !join_started {
        observe_shutdown_start(observation, "openClawJoin");
    }
    host.shutdown_failures.open_claw.finish_join().await;
    if already_settled {
        observe_shutdown_start(observation, "openClawJoin");
        observe_shutdown_settle(observation, "openClawJoin", ShutdownReason::AlreadyClosed);
    } else if pending_join || join_started {
        let reason = host
            .shutdown_failures
            .open_claw
            .settle_reason()
            .unwrap_or(ShutdownReason::Unresolved);
        observe_shutdown_settle(observation, "openClawJoin", reason);
    } else if host.open_claw.owner_if_present().is_none() {
        observe_shutdown_start(observation, "openClawJoin");
        observe_shutdown_settle(observation, "openClawJoin", ShutdownReason::AlreadyClosed);
    }
}

async fn shutdown_matcha(host: &mut Host, observation: &ObservationSink) {
    let _ = host
        .matcha
        .peer_if_present()
        .map(|peer| peer.advance_source_epoch());
    host.event_sinks.close_matcha();
    if host.matcha.peer_if_present().is_none() {
        observe_shutdown_start(observation, "matchaConfirm");
        observe_shutdown_settle(observation, "matchaConfirm", ShutdownReason::AlreadyClosed);
        observe_shutdown_start(observation, "matchaJoin");
        observe_shutdown_settle(observation, "matchaJoin", ShutdownReason::AlreadyClosed);
        return;
    }
    observe_shutdown_start(observation, "matchaConfirm");
    let confirmation = host.matcha.confirm_shutdown().await;
    observe_shutdown_settle(
        observation,
        "matchaConfirm",
        shutdown_outcome_reason(&confirmation),
    );
    match confirmation {
        Ok(outcome @ ShutdownOutcome::Unresolved { .. }) => {
            host.shutdown_failures.matcha = SlotState::Unresolved { outcome };
        }
        Ok(outcome) => {
            let snapshot = host.matcha.snapshot();
            observe_shutdown_start(observation, "matchaJoin");
            let peer = host.matcha.take_peer();
            host.shutdown_failures.matcha = match peer.join().await {
                Ok(()) => SlotState::Settled { snapshot, outcome },
                Err(_) => SlotState::JoinFailed { snapshot, outcome },
            };
            let reason = host
                .shutdown_failures
                .matcha
                .settle_reason()
                .unwrap_or(ShutdownReason::Unresolved);
            observe_shutdown_settle(observation, "matchaJoin", reason);
        }
        Err(_) if !matches!(host.shutdown_failures.matcha, SlotState::Unresolved { .. }) => {
            host.shutdown_failures.matcha = SlotState::Shutdown;
        }
        Err(_) => {}
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ShutdownReport {
    open_claw: Option<ShutdownOutcome>,
    matcha: Option<ShutdownOutcome>,
}

impl ShutdownReport {
    pub fn open_claw(&self) -> Option<&ShutdownOutcome> {
        self.open_claw.as_ref()
    }

    pub fn matcha(&self) -> Option<&ShutdownOutcome> {
        self.matcha.as_ref()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HostShutdownError {
    Transition(HostTransitionError),
    Resources {
        failures: Failures,
        report: ShutdownReport,
    },
}

impl fmt::Display for HostShutdownError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Transition(error) => error.fmt(formatter),
            Self::Resources { .. } => {
                formatter.write_str("one or more runtime resources did not shut down cleanly")
            }
        }
    }
}

impl std::error::Error for HostShutdownError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Failures {
    open_claw_session: Option<SessionShutdownFailure>,
    open_claw: Option<OwnerShutdownFailure>,
    matcha: Option<OwnerShutdownFailure>,
}

impl Failures {
    pub const fn open_claw_session(&self) -> Option<SessionShutdownFailure> {
        self.open_claw_session
    }

    pub const fn open_claw(&self) -> Option<OwnerShutdownFailure> {
        self.open_claw
    }

    pub const fn matcha(&self) -> Option<OwnerShutdownFailure> {
        self.matcha
    }

    const fn any(self) -> bool {
        self.open_claw_session.is_some() || self.open_claw.is_some() || self.matcha.is_some()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OwnerShutdownFailure {
    Shutdown,
    Join,
}

pub(super) struct ShutdownState {
    open_claw_session: SessionShutdown,
    open_claw: SlotState,
    matcha: SlotState,
}

impl ShutdownState {
    pub(super) const fn new() -> Self {
        Self {
            open_claw_session: SessionShutdown::new(),
            open_claw: SlotState::Pending,
            matcha: SlotState::Pending,
        }
    }

    const fn all_settled(&self) -> bool {
        self.open_claw_session.is_settled()
            && matches!(
                self.open_claw,
                SlotState::JoinFailed { .. } | SlotState::Settled { .. }
            )
            && matches!(
                self.matcha,
                SlotState::JoinFailed { .. } | SlotState::Settled { .. }
            )
    }

    const fn failures(&self) -> Failures {
        Failures {
            open_claw_session: self.open_claw_session.failure(),
            open_claw: self.open_claw.failure(),
            matcha: self.matcha.failure(),
        }
    }

    fn report(&self) -> ShutdownReport {
        ShutdownReport {
            open_claw: self.open_claw.outcome().cloned(),
            matcha: self.matcha.outcome().cloned(),
        }
    }

    pub(super) fn open_claw_snapshot(&self) -> Option<&SupervisorSnapshot> {
        self.open_claw.snapshot()
    }

    pub(super) fn matcha_snapshot(&self) -> Option<&SupervisorSnapshot> {
        self.matcha.snapshot()
    }
}

enum SlotState {
    Pending,
    Shutdown,
    Unresolved {
        outcome: ShutdownOutcome,
    },
    Joining {
        snapshot: SupervisorSnapshot,
        outcome: ShutdownOutcome,
        join: PendingSupervisorJoin,
    },
    JoinFailed {
        snapshot: SupervisorSnapshot,
        outcome: ShutdownOutcome,
    },
    Settled {
        snapshot: SupervisorSnapshot,
        outcome: ShutdownOutcome,
    },
}

impl SlotState {
    async fn finish_join(&mut self) {
        let Self::Joining {
            snapshot,
            outcome,
            join,
        } = self
        else {
            return;
        };
        let snapshot = snapshot.clone();
        let outcome = outcome.clone();
        *self = match join.wait().await {
            Ok(()) => Self::Settled { snapshot, outcome },
            Err(_) => Self::JoinFailed { snapshot, outcome },
        };
    }

    const fn failure(&self) -> Option<OwnerShutdownFailure> {
        match self {
            Self::Pending | Self::Settled { .. } => None,
            Self::Shutdown | Self::Unresolved { .. } => Some(OwnerShutdownFailure::Shutdown),
            Self::Joining { .. } | Self::JoinFailed { .. } => Some(OwnerShutdownFailure::Join),
        }
    }

    const fn settle_reason(&self) -> Option<ShutdownReason> {
        match self {
            Self::Settled { .. } => Some(ShutdownReason::Completed),
            Self::JoinFailed { .. } => Some(ShutdownReason::JoinFailed),
            Self::Unresolved { .. } => Some(ShutdownReason::Unresolved),
            Self::Shutdown => Some(ShutdownReason::ConfirmationFailed),
            Self::Pending | Self::Joining { .. } => None,
        }
    }

    const fn outcome(&self) -> Option<&ShutdownOutcome> {
        match self {
            Self::Unresolved { outcome }
            | Self::Joining { outcome, .. }
            | Self::JoinFailed { outcome, .. }
            | Self::Settled { outcome, .. } => Some(outcome),
            Self::Pending | Self::Shutdown => None,
        }
    }

    const fn snapshot(&self) -> Option<&SupervisorSnapshot> {
        match self {
            Self::Joining { snapshot, .. }
            | Self::JoinFailed { snapshot, .. }
            | Self::Settled { snapshot, .. } => Some(snapshot),
            Self::Pending | Self::Shutdown | Self::Unresolved { .. } => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use foundation::process::TerminationFailure;

    use super::*;

    #[test]
    fn unresolved_slot_retains_report_without_becoming_settled() {
        let outcome = ShutdownOutcome::Unresolved {
            failure: TerminationFailure::CleanupUnconfirmed,
        };
        let slot = SlotState::Unresolved {
            outcome: outcome.clone(),
        };

        assert_eq!(slot.failure(), Some(OwnerShutdownFailure::Shutdown));
        assert_eq!(slot.outcome(), Some(&outcome));
        assert!(slot.snapshot().is_none());
    }
}
