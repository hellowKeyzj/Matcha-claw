use std::sync::{Arc, Mutex};

use foundation::process::{ProcessObservation, supervision::StartOutcome};
use runtime_directory::RuntimeStartFailure;

use crate::{HostPhase, RuntimeLifecycle, RuntimeState};

type StartResult = Result<StartOutcome, RuntimeStartFailure>;

#[derive(Clone, Debug)]
enum StartupAttempt {
    NotRequested,
    Pending,
    Settled {
        result: StartResult,
        process: Option<ProcessObservation>,
    },
}

#[derive(Clone)]
pub(crate) struct PeerStartupState {
    matcha: Arc<Mutex<StartupAttempt>>,
    open_claw: Arc<Mutex<StartupAttempt>>,
    runtime_events: Option<tokio::sync::mpsc::Sender<()>>,
    matcha_changes: tokio::sync::watch::Sender<()>,
}

impl PeerStartupState {
    pub(crate) fn new(runtime_events: Option<tokio::sync::mpsc::Sender<()>>) -> Self {
        Self {
            matcha: Arc::new(Mutex::new(StartupAttempt::NotRequested)),
            open_claw: Arc::new(Mutex::new(StartupAttempt::NotRequested)),
            runtime_events,
            matcha_changes: tokio::sync::watch::channel(()).0,
        }
    }

    pub(crate) fn matcha_start_failure(&self) -> Option<crate::RuntimeStartFailure> {
        start_failure(&self.matcha)
    }

    pub(crate) fn open_claw_start_failure(&self) -> Option<crate::RuntimeStartFailure> {
        start_failure(&self.open_claw)
    }

    pub(super) fn begin_matcha(&self) {
        self.set_matcha(StartupAttempt::Pending);
    }

    pub(super) fn begin_open_claw(&self) {
        self.set_open_claw(StartupAttempt::Pending);
    }

    pub(super) fn record_matcha(&self, result: StartResult, process: Option<ProcessObservation>) {
        self.set_matcha(StartupAttempt::Settled { result, process });
    }

    pub(super) fn record_open_claw(
        &self,
        result: StartResult,
        process: Option<ProcessObservation>,
    ) {
        self.set_open_claw(StartupAttempt::Settled { result, process });
    }

    pub(super) fn fail_open_claw_pending(&self) {
        let mut attempt = self
            .open_claw
            .lock()
            .expect("peer startup state lock poisoned");
        if matches!(*attempt, StartupAttempt::Pending) {
            *attempt = StartupAttempt::Settled {
                result: Err(RuntimeStartFailure::SupervisorStopped),
                process: None,
            };
            drop(attempt);
            self.notify();
        }
    }

    pub(super) fn clear_matcha(&self) {
        self.set_matcha(StartupAttempt::NotRequested);
    }

    pub(super) fn clear_open_claw(&self) {
        self.set_open_claw(StartupAttempt::NotRequested);
    }

    pub(crate) fn matcha_state(
        &self,
        phase: HostPhase,
        snapshot: impl FnOnce() -> (RuntimeState, Option<ProcessObservation>),
    ) -> RuntimeState {
        let attempt = self
            .matcha
            .lock()
            .expect("peer startup state lock poisoned");
        let (mut state, process) = snapshot();
        if !matches!(phase, HostPhase::ShuttingDown | HostPhase::ShutDown)
            && state.lifecycle() == RuntimeLifecycle::Running
            && !matches!(&*attempt, StartupAttempt::Settled { process: recorded, .. }
                if process.is_some() && *recorded == process)
        {
            state = state.with_startup_lifecycle(RuntimeLifecycle::Starting);
        }
        project_state(&attempt, phase, state, process)
    }

    pub(crate) fn open_claw_state(
        &self,
        phase: HostPhase,
        snapshot: impl FnOnce() -> (RuntimeState, Option<ProcessObservation>),
    ) -> RuntimeState {
        project(&self.open_claw, phase, snapshot)
    }

    pub(super) fn runtime_events(&self) -> Option<&tokio::sync::mpsc::Sender<()>> {
        self.runtime_events.as_ref()
    }

    pub(super) fn notify(&self) {
        if let Some(events) = self.runtime_events() {
            let _ = events.try_send(());
        }
    }

    pub(super) fn subscribe_matcha(&self) -> tokio::sync::watch::Receiver<()> {
        self.matcha_changes.subscribe()
    }

    fn set_matcha(&self, state: StartupAttempt) {
        *self
            .matcha
            .lock()
            .expect("peer startup state lock poisoned") = state;
        self.matcha_changes.send_replace(());
    }

    fn set_open_claw(&self, state: StartupAttempt) {
        *self
            .open_claw
            .lock()
            .expect("peer startup state lock poisoned") = state;
        self.notify();
    }
}

fn start_failure(attempt: &Mutex<StartupAttempt>) -> Option<crate::RuntimeStartFailure> {
    match &*attempt.lock().expect("peer startup state lock poisoned") {
        StartupAttempt::Settled { result, .. } => super::status::start_failure(result),
        StartupAttempt::NotRequested | StartupAttempt::Pending => None,
    }
}

fn project(
    attempt: &Mutex<StartupAttempt>,
    phase: HostPhase,
    snapshot: impl FnOnce() -> (RuntimeState, Option<ProcessObservation>),
) -> RuntimeState {
    let attempt = attempt.lock().expect("peer startup state lock poisoned");
    let (state, current_process) = snapshot();
    project_state(&attempt, phase, state, current_process)
}

fn project_state(
    attempt: &StartupAttempt,
    phase: HostPhase,
    state: RuntimeState,
    current_process: Option<ProcessObservation>,
) -> RuntimeState {
    if matches!(phase, HostPhase::ShuttingDown | HostPhase::ShutDown) {
        return state;
    }
    match (attempt, state.lifecycle()) {
        (
            StartupAttempt::Pending,
            RuntimeLifecycle::Idle
            | RuntimeLifecycle::Starting
            | RuntimeLifecycle::WaitingToRestart
            | RuntimeLifecycle::Stopping
            | RuntimeLifecycle::Failed
            | RuntimeLifecycle::Running,
        ) => state.with_startup_lifecycle(RuntimeLifecycle::Starting),
        (StartupAttempt::Settled { result, process }, lifecycle)
            if super::status::start_failure(result).is_some()
                && (lifecycle == RuntimeLifecycle::Idle
                    || (lifecycle == RuntimeLifecycle::Running
                        && process.is_some()
                        && *process == current_process)) =>
        {
            state.with_startup_lifecycle(RuntimeLifecycle::Failed)
        }
        _ => state,
    }
}
