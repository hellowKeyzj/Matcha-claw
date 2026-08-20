use std::fmt;

use foundation::process::{ShutdownOutcome, supervision::SupervisorSnapshot};

use super::{Host, HostTransitionError};
use crate::composition::{
    owner::PendingSupervisorJoin,
    session::{SessionShutdown, SessionShutdownFailure},
};

impl Host {
    pub async fn shutdown(&mut self) -> Result<ShutdownReport, HostShutdownError> {
        match self.admission.state().phase() {
            super::super::admission::HostPhase::Created
            | super::super::admission::HostPhase::Starting
            | super::super::admission::HostPhase::Ready => self
                .admission
                .begin_shutdown()
                .map_err(HostShutdownError::Transition)?,
            super::super::admission::HostPhase::ShuttingDown => {}
            super::super::admission::HostPhase::ShutDown => {
                let failures = self.shutdown_failures.failures();
                let report = self.shutdown_failures.report();
                return if failures.any() {
                    Err(HostShutdownError::Resources { failures, report })
                } else {
                    Ok(report)
                };
            }
        }

        self.cancel_open_claw_toolchain_install().await;
        self.cancel_fleet_operations().await;
        self.cancel_peer_lifecycle_operations().await;
        self.event_sinks.close_session_delta();
        shutdown_open_claw_session(self).await;
        shutdown_open_claw(self).await;
        shutdown_matcha(self).await;
        if !self.shutdown_failures.all_settled() {
            return Err(HostShutdownError::Resources {
                failures: self.shutdown_failures.failures(),
                report: self.shutdown_failures.report(),
            });
        }
        if self.admission.state().phase() == super::super::admission::HostPhase::ShuttingDown {
            self.admission
                .complete_shutdown()
                .map_err(HostShutdownError::Transition)?;
        }
        let failures = self.shutdown_failures.failures();
        let report = self.shutdown_failures.report();
        if failures.any() {
            Err(HostShutdownError::Resources { failures, report })
        } else {
            Ok(report)
        }
    }
}

async fn shutdown_open_claw_session(host: &mut Host) {
    host.cancel_cron_operations().await;
    host.shutdown_failures.open_claw_session.finish().await;
    if host.shutdown_failures.open_claw_session.is_settled() {
        host.event_sinks.close_open_claw();
    }
}

async fn shutdown_open_claw(host: &mut Host) {
    if host.open_claw.owner_if_present().is_some() {
        let confirmation = host.open_claw.owner().confirm_shutdown().await;
        match confirmation {
            Ok(outcome @ ShutdownOutcome::Unresolved { .. }) => {
                host.shutdown_failures.open_claw = SlotState::Unresolved { outcome };
            }
            Ok(outcome) => {
                let snapshot = host.open_claw.owner().snapshot();
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
    host.shutdown_failures.open_claw.finish_join().await;
}

async fn shutdown_matcha(host: &mut Host) {
    host.cancel_matcha_renderer_events();
    host.event_sinks.close_matcha();
    if host.matcha.peer_if_present().is_none() {
        return;
    }
    let confirmation = host.matcha.confirm_shutdown().await;
    match confirmation {
        Ok(outcome @ ShutdownOutcome::Unresolved { .. }) => {
            host.shutdown_failures.matcha = SlotState::Unresolved { outcome };
        }
        Ok(outcome) => {
            let snapshot = host.matcha.snapshot();
            let peer = host.matcha.take_peer();
            host.shutdown_failures.matcha = match peer.join().await {
                Ok(()) => SlotState::Settled { snapshot, outcome },
                Err(_) => SlotState::JoinFailed { snapshot, outcome },
            };
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
