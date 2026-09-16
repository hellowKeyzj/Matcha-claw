use std::sync::Arc;

use foundation::process::supervision::SupervisorSnapshot;

use crate::runtime::driver::{RuntimeDriver, RuntimeDriverIdentity};

use super::Host;

impl Host {
    pub fn state(&self) -> crate::diagnostics::HostState {
        let matcha = self.matcha_lifecycle_snapshot();
        let open_claw = self.open_claw_lifecycle_snapshot();
        crate::diagnostics::HostState::from_supervisors(
            self.admission.state().phase(),
            &matcha,
            self.matcha_startup_diagnostics.category(),
            &open_claw,
            self.openclaw_startup_diagnostics.category(),
        )
    }

    pub fn matcha_start_failure(&self) -> Option<super::RuntimeStartFailure> {
        self.peer_startup.matcha_start_failure()
    }

    pub fn open_claw_start_failure(&self) -> Option<super::RuntimeStartFailure> {
        self.peer_startup.open_claw_start_failure()
    }

    fn matcha_lifecycle_snapshot(&self) -> SupervisorSnapshot {
        if self.matcha.peer_if_present().is_none() {
            return self
                .shutdown_failures
                .matcha_snapshot()
                .cloned()
                .expect("matcha peer absence must retain a terminal snapshot");
        }
        self.runtime_driver(&RuntimeDriverIdentity::matcha_agent().endpoint())
            .and_then(RuntimeDriver::lifecycle_ops)
            .expect("Matcha Agent lifecycle operations must be available")
            .snapshot()
    }

    fn open_claw_lifecycle_snapshot(&self) -> SupervisorSnapshot {
        if self.open_claw.owner_if_present().is_none() {
            return self
                .shutdown_failures
                .open_claw_snapshot()
                .cloned()
                .expect("OpenClaw owner absence must retain a terminal snapshot");
        }
        self.runtime_driver(&RuntimeDriverIdentity::open_claw().endpoint())
            .and_then(RuntimeDriver::lifecycle_ops)
            .expect("OpenClaw lifecycle operations must be available")
            .snapshot()
    }
}

pub(super) fn matcha_diagnostic_reporter(
    diagnostics: crate::diagnostics::MatchaStartupDiagnostics,
) -> Arc<dyn Fn(matcha_agent::lifecycle::output::StartupDiagnosticCategory) + Send + Sync> {
    Arc::new(move |category| diagnostics.report(category))
}

pub(super) fn openclaw_diagnostic_reporter(
    diagnostics: crate::diagnostics::OpenClawStartupDiagnostics,
) -> Arc<dyn Fn(openclaw::lifecycle::logs::LifecycleDiagnostic) + Send + Sync> {
    Arc::new(
        move |diagnostic: openclaw::lifecycle::logs::LifecycleDiagnostic| {
            diagnostics.report(diagnostic.category())
        },
    )
}

pub(super) fn forward_openclaw_runtime_changes(
    mut snapshots: tokio::sync::watch::Receiver<SupervisorSnapshot>,
    events: tokio::sync::mpsc::Sender<()>,
) {
    tokio::spawn(async move {
        while snapshots.changed().await.is_ok() {
            if events.send(()).await.is_err() {
                break;
            }
        }
    });
}

pub(super) fn forward_matcha_lifecycle_changes(
    mut snapshots: tokio::sync::watch::Receiver<SupervisorSnapshot>,
    events: tokio::sync::mpsc::Sender<SupervisorSnapshot>,
) {
    tokio::spawn(async move {
        while snapshots.changed().await.is_ok() {
            let snapshot = snapshots.borrow().clone();
            if events.send(snapshot).await.is_err() {
                break;
            }
        }
    });
}

pub(super) fn forward_openclaw_runtime_readiness_changes(
    mut readiness: tokio::sync::watch::Receiver<u64>,
    events: tokio::sync::mpsc::Sender<()>,
) {
    tokio::spawn(async move {
        while readiness.changed().await.is_ok() {
            if events.send(()).await.is_err() {
                break;
            }
        }
    });
}
