use foundation::{
    execution::OwnedTask, lifecycle::ModuleScope, process::supervision::SupervisorSnapshot,
};

use ::diagnostics::{HostLifecycle, HostState, RuntimeState};

use crate::composition::{HostPhase, runtime_ports::RuntimeDriverIdentity};

use super::Host;

impl Host {
    pub fn state(&self) -> HostState {
        let matcha = self.matcha_lifecycle_snapshot();
        let open_claw = self.open_claw_lifecycle_snapshot();
        let phase = self.admission.state().phase();
        HostState::from_runtime_states(
            phase == HostPhase::Ready,
            project_host_lifecycle(phase),
            RuntimeState::from_snapshot_with_startup_diagnostic(
                &matcha,
                self.matcha_startup_diagnostics.category(),
            ),
            RuntimeState::from_snapshot_with_startup_diagnostic(
                &open_claw,
                self.openclaw_startup_diagnostics.category(),
            ),
        )
    }

    pub fn matcha_start_failure(&self) -> Option<super::RuntimeStartFailure> {
        self.peer_startup.matcha_start_failure()
    }

    pub fn open_claw_start_failure(&self) -> Option<super::RuntimeStartFailure> {
        self.peer_startup.open_claw_start_failure()
    }

    fn matcha_lifecycle_snapshot(&self) -> SupervisorSnapshot {
        self.runtime_driver(&RuntimeDriverIdentity::matcha_agent().endpoint())
            .and_then(|driver| driver.host_lifecycle_ops())
            .map(|lifecycle| lifecycle.snapshot())
            .or_else(|| self.shutdown_failures.matcha_snapshot())
            .expect("Matcha Agent lifecycle operations must be available")
    }

    fn open_claw_lifecycle_snapshot(&self) -> SupervisorSnapshot {
        if self.open_claw.owner_if_present().is_none() {
            return self
                .shutdown_failures
                .open_claw_snapshot()
                .expect("OpenClaw owner absence must retain a terminal snapshot");
        }
        self.runtime_driver(&RuntimeDriverIdentity::open_claw().endpoint())
            .and_then(|driver| driver.host_lifecycle_ops())
            .expect("OpenClaw lifecycle operations must be available")
            .snapshot()
    }
}

pub(crate) const fn project_host_lifecycle(phase: HostPhase) -> HostLifecycle {
    match phase {
        HostPhase::Created => HostLifecycle::Created,
        HostPhase::Starting => HostLifecycle::Starting,
        HostPhase::Ready => HostLifecycle::Ready,
        HostPhase::ShuttingDown => HostLifecycle::ShuttingDown,
        HostPhase::ShutDown => HostLifecycle::ShutDown,
    }
}

pub(super) fn forward_openclaw_runtime_changes(
    scope: &mut ModuleScope,
    mut snapshots: tokio::sync::watch::Receiver<SupervisorSnapshot>,
    events: tokio::sync::mpsc::Sender<()>,
) {
    let (mut task, _) = OwnedTask::spawn(|cancellation| async move {
        loop {
            tokio::select! {
                _ = cancellation.cancelled() => break,
                changed = snapshots.changed() => {
                    if changed.is_err() {
                        break;
                    }
                    tokio::select! {
                        _ = cancellation.cancelled() => break,
                        sent = events.send(()) => {
                            if sent.is_err() {
                                break;
                            }
                        }
                    }
                }
            }
        }
    });
    scope.register_event_subscription("openclaw-runtime", move || async move {
        let _ = task.cancel_and_join().await;
    });
}

pub(super) fn forward_matcha_lifecycle_changes(
    scope: &mut ModuleScope,
    mut snapshots: tokio::sync::watch::Receiver<SupervisorSnapshot>,
    events: tokio::sync::mpsc::Sender<SupervisorSnapshot>,
) {
    let (mut task, _) = OwnedTask::spawn(|cancellation| async move {
        loop {
            tokio::select! {
                _ = cancellation.cancelled() => break,
                changed = snapshots.changed() => {
                    if changed.is_err() {
                        break;
                    }
                    let snapshot = snapshots.borrow().clone();
                    tokio::select! {
                        _ = cancellation.cancelled() => break,
                        sent = events.send(snapshot) => {
                            if sent.is_err() {
                                break;
                            }
                        }
                    }
                }
            }
        }
    });
    scope.register_event_subscription("matcha-lifecycle", move || async move {
        let _ = task.cancel_and_join().await;
    });
}

pub(super) fn forward_openclaw_runtime_readiness_changes(
    scope: &mut ModuleScope,
    mut readiness: tokio::sync::watch::Receiver<u64>,
    events: tokio::sync::mpsc::Sender<()>,
) {
    let (mut task, _) = OwnedTask::spawn(|cancellation| async move {
        loop {
            tokio::select! {
                _ = cancellation.cancelled() => break,
                changed = readiness.changed() => {
                    if changed.is_err() {
                        break;
                    }
                    tokio::select! {
                        _ = cancellation.cancelled() => break,
                        sent = events.send(()) => {
                            if sent.is_err() {
                                break;
                            }
                        }
                    }
                }
            }
        }
    });
    scope.register_event_subscription("openclaw-readiness", move || async move {
        let _ = task.cancel_and_join().await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_lifecycle_projection_covers_every_admission_phase() {
        let cases = [
            (HostPhase::Created, HostLifecycle::Created),
            (HostPhase::Starting, HostLifecycle::Starting),
            (HostPhase::Ready, HostLifecycle::Ready),
            (HostPhase::ShuttingDown, HostLifecycle::ShuttingDown),
            (HostPhase::ShutDown, HostLifecycle::ShutDown),
        ];

        for (phase, expected) in cases {
            assert_eq!(project_host_lifecycle(phase), expected);
        }
    }
}
