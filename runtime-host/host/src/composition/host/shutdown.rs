use std::{
    fmt,
    future::Future,
    sync::{Arc, Mutex},
    task::Poll,
};

use foundation::{
    execution::{
        ObservationRecord, ObservationSink, ShutdownObservation, ShutdownReason, ShutdownStage,
        TraceContext,
    },
    lifecycle::{EffectRegistration, ModuleScope, ScopedEffectKind},
    process::{
        ShutdownOutcome,
        supervision::{SupervisorOutcome, SupervisorSnapshot},
    },
};
use platform::{
    call::CallLogError,
    module::{CapabilityKey, EffectKind, ModuleDescriptor, ModuleId},
};

use matcha_agent::driver::{MatchaAgentInstance, MatchaRuntimeDriver};

use openclaw::driver::OpenClawDriver;

use super::{
    Host, HostTransitionError,
    session_shutdown::{SessionShutdown, SessionShutdownFailure},
};
use openclaw::driver::PendingSupervisorJoin;

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

        if !self.shutdown_failures.cron_closed {
            self.cron_handle.cancel_operations().await;
            self.shutdown_failures.cron_closed = true;
        }
        observe_shutdown_start(&observation, "ownerRuntimeTasks");
        let owner_shutdown = self.owner_runtime_tasks.drain_and_join().await;
        self.shutdown_failures.organization = match owner_shutdown {
            Err(super::owners::OwnerRuntimeShutdownError::Organization(error)) => Some(error),
            _ => None,
        };
        self.shutdown_failures.organization_terminal = match owner_shutdown {
            Err(super::owners::OwnerRuntimeShutdownError::OrganizationTerminal(error)) => Some(error),
            _ => None,
        };
        self.shutdown_failures.sessions_terminal = match owner_shutdown {
            Err(super::owners::OwnerRuntimeShutdownError::SessionsTerminal(error)) => Some(error),
            _ => None,
        };
        let owner_shutdown_reason = match owner_shutdown {
            Err(error) if error.is_join_failure() => ShutdownReason::JoinFailed,
            Err(_) => ShutdownReason::Unresolved,
            Ok(()) => ShutdownReason::Completed,
        };
        observe_shutdown_settle(&observation, "ownerRuntimeTasks", owner_shutdown_reason);
        if owner_shutdown.is_err() {
            observe_shutdown_start(&observation, "shutdownReport");
            observe_shutdown_settle(&observation, "shutdownReport", owner_shutdown_reason);
            return Err(HostShutdownError::Resources {
                failures: self.shutdown_failures.failures(),
                report: self.shutdown_failures.report(),
            });
        }
        shutdown_open_claw_session(self, &observation).await;
        if self.shutdown_failures.open_claw_session.failure()
            == Some(SessionShutdownFailure::Join)
        {
            observe_shutdown_start(&observation, "shutdownReport");
            observe_shutdown_settle(&observation, "shutdownReport", ShutdownReason::JoinFailed);
            return Err(HostShutdownError::Resources {
                failures: self.shutdown_failures.failures(),
                report: self.shutdown_failures.report(),
            });
        }
        self.runtime_processes
            .dispose_open_claw(
                &self.open_claw,
                &observation,
                &self.shutdown_failures.open_claw,
            )
            .await;
        if self.shutdown_failures.open_claw_slot(SlotState::failure)
            == Some(OwnerShutdownFailure::Join)
        {
            observe_shutdown_start(&observation, "shutdownReport");
            observe_shutdown_settle(&observation, "shutdownReport", ShutdownReason::JoinFailed);
            return Err(HostShutdownError::Resources {
                failures: self.shutdown_failures.failures(),
                report: self.shutdown_failures.report(),
            });
        }
        self.runtime_processes
            .dispose_matcha(
                &mut self.event_sinks,
                &observation,
                &self.shutdown_failures.matcha,
            )
            .await;
        if !self.shutdown_failures.open_claw_slot(SlotState::is_settled)
            || !self.shutdown_failures.matcha_slot(SlotState::is_settled)
        {
            let failures = self.shutdown_failures.failures();
            let report = self.shutdown_failures.report();
            observe_shutdown_start(&observation, "shutdownReport");
            observe_shutdown_settle(
                &observation,
                "shutdownReport",
                if failures.open_claw() == Some(OwnerShutdownFailure::Join)
                    || failures.matcha() == Some(OwnerShutdownFailure::Join)
                {
                    ShutdownReason::JoinFailed
                } else {
                    ShutdownReason::Unresolved
                },
            );
            return Err(HostShutdownError::Resources { failures, report });
        }
        observe_shutdown_start(&observation, "callLog");
        self.call_scope.dispose_all_lifo().await;
        observe_shutdown_settle(
            &observation,
            "callLog",
            if self.shutdown_failures.failures().call_log().is_some() {
                ShutdownReason::Unresolved
            } else {
                ShutdownReason::Completed
            },
        );
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

pub(super) struct RuntimeProcessScopes {
    open_claw: ModuleScope,
    matcha: ModuleScope,
    matcha_runtime_driver: Arc<MatchaRuntimeDriver>,
    matcha_instance: Arc<tokio::sync::Mutex<MatchaAgentInstance>>,
}

impl RuntimeProcessScopes {
    pub(super) fn new(
        open_claw: Arc<OpenClawDriver>,
        matcha: MatchaAgentInstance,
        matcha_runtime_driver: Arc<MatchaRuntimeDriver>,
        observation: ObservationSink,
        shutdown: &ShutdownState,
    ) -> Self {
        let matcha = Arc::new(tokio::sync::Mutex::new(matcha));
        Self {
            open_claw: open_claw_process_scope(
                open_claw,
                observation.clone(),
                Arc::clone(&shutdown.open_claw),
            ),
            matcha: matcha_process_scope(
                Arc::clone(&matcha),
                observation,
                Arc::clone(&shutdown.matcha),
            ),
            matcha_runtime_driver,
            matcha_instance: matcha,
        }
    }

    pub(super) fn descriptors() -> [ModuleDescriptor; 2] {
        [open_claw_process_descriptor(), matcha_process_descriptor()]
    }

    pub(super) fn effect_registrations(&self) -> Vec<EffectRegistration> {
        self.open_claw
            .effect_registrations()
            .iter()
            .chain(self.matcha.effect_registrations())
            .copied()
            .collect()
    }

    async fn dispose_open_claw(
        &mut self,
        open_claw: &Arc<OpenClawDriver>,
        observation: &ObservationSink,
        state: &Arc<Mutex<SlotState>>,
    ) {
        if slot_is_pending(state) {
            self.open_claw.dispose_all_lifo().await;
        } else {
            shutdown_open_claw(Arc::clone(open_claw), observation.clone(), Arc::clone(state)).await;
        }
    }

    async fn dispose_matcha(
        &mut self,
        event_sinks: &mut super::events::EventSinks,
        observation: &ObservationSink,
        state: &Arc<Mutex<SlotState>>,
    ) {
        if slot_is_pending(state) {
            self.matcha_runtime_driver.advance_source_epoch();
            event_sinks.close_matcha();
            self.matcha.dispose_all_lifo().await;
        } else {
            shutdown_matcha(
                Arc::clone(&self.matcha_instance),
                observation.clone(),
                Arc::clone(state),
            )
            .await;
        }
    }
}

const OPEN_CLAW_EFFECTS: &[EffectKind] = &[EffectKind::EventSubscription, EffectKind::Process];
const OPEN_CLAW_EVENTS: &[&str] = &["gateway-control"];
const MATCHA_EFFECTS: &[EffectKind] = &[EffectKind::Process];
const NO_CAPABILITIES: &[CapabilityKey] = &[];
const NO_ROUTES: &[&str] = &[];
const NO_EVENTS: &[&str] = &[];

fn open_claw_process_descriptor() -> ModuleDescriptor {
    ModuleDescriptor::new(
        ModuleId::new("openclaw"),
        NO_CAPABILITIES,
        NO_CAPABILITIES,
        OPEN_CLAW_EFFECTS,
        NO_ROUTES,
        OPEN_CLAW_EVENTS,
        None,
    )
}

fn matcha_process_descriptor() -> ModuleDescriptor {
    ModuleDescriptor::new(
        ModuleId::new("matcha-agent"),
        NO_CAPABILITIES,
        NO_CAPABILITIES,
        MATCHA_EFFECTS,
        NO_ROUTES,
        NO_EVENTS,
        None,
    )
}

fn open_claw_process_scope(
    open_claw: Arc<OpenClawDriver>,
    observation: ObservationSink,
    state: Arc<Mutex<SlotState>>,
) -> ModuleScope {
    let mut scope = ModuleScope::new("openclaw");
    let control_supervisor_owner = Arc::clone(&open_claw);
    scope.register_event_subscription("gateway-control", move || async move {
        if let Some(supervisor) = control_supervisor_owner.take_control_supervisor() {
            supervisor.dispose().await;
        }
    });
    scope.register_process("process", move || async move {
        shutdown_open_claw(open_claw, observation, state).await;
    });
    scope
}

fn matcha_process_scope(
    matcha: Arc<tokio::sync::Mutex<MatchaAgentInstance>>,
    observation: ObservationSink,
    state: Arc<Mutex<SlotState>>,
) -> ModuleScope {
    let mut scope = ModuleScope::new("matcha-agent");
    scope.register_process("process", move || async move {
        shutdown_matcha(matcha, observation, state).await;
    });
    scope
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
    if !already_settled {
        host.shutdown_failures.open_claw_session.finish().await;
        if host.shutdown_failures.open_claw_session.is_settled()
            && host.shutdown_failures.open_claw_session.failure()
                != Some(SessionShutdownFailure::Join)
        {
            host.event_sinks.close_open_claw();
        }
    }
    let reason = if already_settled {
        ShutdownReason::AlreadyClosed
    } else {
        session_shutdown_reason(host.shutdown_failures.open_claw_session.failure())
    };
    observe_shutdown_settle(observation, "openClawSession", reason);
}

async fn shutdown_open_claw(
    open_claw: Arc<OpenClawDriver>,
    observation: ObservationSink,
    shared_state: Arc<Mutex<SlotState>>,
) {
    if slot_join_is_terminal(&shared_state)
        || finish_slot_join(&shared_state, &observation, "openClawJoin").await
    {
        return;
    }
    if slot_is_pending(&shared_state) {
        store_slot_state(&shared_state, SlotState::Shutdown);
    }
    let Some(owner) = open_claw.owner_if_present() else {
        observe_shutdown_start(&observation, "openClawConfirm");
        observe_shutdown_settle(
            &observation,
            "openClawConfirm",
            ShutdownReason::AlreadyClosed,
        );
        observe_shutdown_start(&observation, "openClawJoin");
        observe_shutdown_settle(&observation, "openClawJoin", ShutdownReason::AlreadyClosed);
        store_slot_state(&shared_state, SlotState::NoProcess);
        return;
    };

    observe_shutdown_start(&observation, "openClawConfirm");
    let confirmation = owner.confirm_shutdown().await;
    observe_shutdown_settle(
        &observation,
        "openClawConfirm",
        shutdown_outcome_reason(&confirmation),
    );
    let outcome = match confirmation {
        Ok(outcome @ ShutdownOutcome::Unresolved { .. }) => {
            store_slot_state(&shared_state, SlotState::Unresolved { outcome });
            return;
        }
        Ok(outcome) => Some(outcome),
        Err(
            openclaw::driver::SupervisorShutdownFailureKind::SupervisorStopped
            | openclaw::driver::SupervisorShutdownFailureKind::ShuttingDown
            | openclaw::driver::SupervisorShutdownFailureKind::MissingOutcome,
        ) => None,
        Err(
            openclaw::driver::SupervisorShutdownFailureKind::CompletionFailed
            | openclaw::driver::SupervisorShutdownFailureKind::Busy
            | openclaw::driver::SupervisorShutdownFailureKind::Rejected(_),
        ) => return,
    };
    let snapshot = owner.subscribe();
    observe_shutdown_start(&observation, "openClawJoin");
    let join = open_claw.take_owner().begin_join();
    store_slot_state(
        &shared_state,
        SlotState::Joining {
            snapshot,
            outcome,
            join: PendingJoin::OpenClaw(join),
        },
    );
    finish_slot_join(&shared_state, &observation, "openClawJoin").await;
}

async fn shutdown_matcha(
    matcha: Arc<tokio::sync::Mutex<MatchaAgentInstance>>,
    observation: ObservationSink,
    shared_state: Arc<Mutex<SlotState>>,
) {
    if slot_join_is_terminal(&shared_state)
        || finish_slot_join(&shared_state, &observation, "matchaJoin").await
    {
        return;
    }
    if slot_is_pending(&shared_state) {
        store_slot_state(&shared_state, SlotState::Shutdown);
    }
    let mut matcha = matcha.lock().await;
    if matcha.peer_if_present().is_none() {
        observe_shutdown_start(&observation, "matchaConfirm");
        observe_shutdown_settle(&observation, "matchaConfirm", ShutdownReason::AlreadyClosed);
        observe_shutdown_start(&observation, "matchaJoin");
        observe_shutdown_settle(&observation, "matchaJoin", ShutdownReason::AlreadyClosed);
        store_slot_state(&shared_state, SlotState::NoProcess);
        return;
    }
    observe_shutdown_start(&observation, "matchaConfirm");
    let confirmation = matcha.confirm_shutdown().await;
    observe_shutdown_settle(
        &observation,
        "matchaConfirm",
        shutdown_outcome_reason(&confirmation),
    );
    let outcome = match confirmation {
        Ok(outcome @ ShutdownOutcome::Unresolved { .. }) => {
            store_slot_state(&shared_state, SlotState::Unresolved { outcome });
            return;
        }
        Ok(outcome) => Some(outcome),
        Err(
            matcha_agent::peer::ShutdownError::SupervisorStopped
            | matcha_agent::peer::ShutdownError::ShuttingDown
            | matcha_agent::peer::ShutdownError::MissingOutcome,
        ) => None,
        Err(
            matcha_agent::peer::ShutdownError::CompletionFailed
            | matcha_agent::peer::ShutdownError::Busy
            | matcha_agent::peer::ShutdownError::Rejected(_),
        ) => return,
    };
    let snapshot = matcha.runtime_driver().lifecycle_handle().subscribe();
    observe_shutdown_start(&observation, "matchaJoin");
    let peer = matcha.take_peer();
    let join = tokio::spawn(peer.join());
    store_slot_state(
        &shared_state,
        SlotState::Joining {
            snapshot,
            outcome,
            join: PendingJoin::Matcha(join),
        },
    );
    drop(matcha);
    finish_slot_join(&shared_state, &observation, "matchaJoin").await;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ShutdownReport {
    open_claw: Option<RuntimeShutdownOutcome>,
    matcha: Option<RuntimeShutdownOutcome>,
}

impl ShutdownReport {
    pub const fn open_claw(&self) -> Option<&RuntimeShutdownOutcome> {
        self.open_claw.as_ref()
    }

    pub const fn matcha(&self) -> Option<&RuntimeShutdownOutcome> {
        self.matcha.as_ref()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimeShutdownOutcome {
    Detached,
    AuthorityLost,
    Failed(RuntimeShutdownFailure),
    Forced(RuntimeExit),
    Graceful(RuntimeExit),
    NoProcess,
    Unresolved { failure: RuntimeShutdownFailure },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeShutdownFailure {
    AuthorityLost,
    CleanupUnconfirmed,
    MaterialCleanupFailed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RuntimeExit {
    exit_code: Option<i32>,
    signal: Option<i32>,
}

impl RuntimeExit {
    pub const fn exit_code(&self) -> Option<i32> {
        self.exit_code
    }

    pub const fn signal(&self) -> Option<i32> {
        self.signal
    }
}

fn runtime_shutdown_outcome(outcome: &ShutdownOutcome) -> RuntimeShutdownOutcome {
    match outcome {
        ShutdownOutcome::Detached => RuntimeShutdownOutcome::Detached,
        ShutdownOutcome::Terminated(outcome) => runtime_termination_outcome(outcome),
        ShutdownOutcome::Unresolved { failure } => RuntimeShutdownOutcome::Unresolved {
            failure: runtime_shutdown_failure(*failure),
        },
    }
}

fn runtime_termination_outcome(
    outcome: &foundation::process::TerminationOutcome,
) -> RuntimeShutdownOutcome {
    match outcome {
        foundation::process::TerminationOutcome::AuthorityLost => {
            RuntimeShutdownOutcome::AuthorityLost
        }
        foundation::process::TerminationOutcome::Failed(failure) => {
            RuntimeShutdownOutcome::Failed(runtime_shutdown_failure(*failure))
        }
        foundation::process::TerminationOutcome::Forced(exit) => {
            RuntimeShutdownOutcome::Forced(runtime_exit(exit))
        }
        foundation::process::TerminationOutcome::Graceful(exit) => {
            RuntimeShutdownOutcome::Graceful(runtime_exit(exit))
        }
        foundation::process::TerminationOutcome::NoProcess => RuntimeShutdownOutcome::NoProcess,
    }
}

const fn runtime_shutdown_failure(
    failure: foundation::process::TerminationFailure,
) -> RuntimeShutdownFailure {
    match failure {
        foundation::process::TerminationFailure::AuthorityLost => {
            RuntimeShutdownFailure::AuthorityLost
        }
        foundation::process::TerminationFailure::CleanupUnconfirmed => {
            RuntimeShutdownFailure::CleanupUnconfirmed
        }
        foundation::process::TerminationFailure::MaterialCleanupFailed => {
            RuntimeShutdownFailure::MaterialCleanupFailed
        }
    }
}

const fn runtime_exit(exit: &foundation::process::ExitObservation) -> RuntimeExit {
    RuntimeExit {
        exit_code: exit.exit_code(),
        signal: exit.signal(),
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

impl Host {
    pub(crate) fn shutdown_is_retryable(&self, error: &HostShutdownError) -> bool {
        !self
            .shutdown_failures
            .open_claw_slot(SlotState::has_terminal_failure)
            && !self
                .shutdown_failures
                .matcha_slot(SlotState::has_terminal_failure)
            && error.is_retryable()
    }
}

impl HostShutdownError {
    fn is_retryable(&self) -> bool {
        match self {
            Self::Transition(_) => false,
            Self::Resources { failures, .. } => {
                failures.owner_joins().is_empty()
                    && failures.call_log().is_none()
                    && failures.organization() != Some(organization::OrganizationShutdownError::Join)
                    && failures.organization_terminal()
                        != Some(organization::OrganizationTerminalCloseError::Join)
                    && failures.sessions_terminal()
                        != Some(sessions_module::SessionTerminalCloseError::Join)
                    && failures.open_claw_session().is_none()
                    && failures.open_claw() != Some(OwnerShutdownFailure::Join)
                    && failures.matcha() != Some(OwnerShutdownFailure::Join)
            }
        }
    }
}

impl fmt::Display for HostShutdownError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Transition(error) => error.fmt(formatter),
            Self::Resources { failures, .. } => {
                formatter.write_str("one or more runtime resources did not shut down cleanly")?;
                if !failures.owner_joins().is_empty() {
                    write!(
                        formatter,
                        "; owner task join failed: {}; inspect runtime-host diagnostics before restarting",
                        failures.owner_joins().join(", ")
                    )?;
                }
                if let Some(error) = failures.call_log() {
                    write!(
                        formatter,
                        "; call log close failed: {error}; inspect runtime-host diagnostics before restarting"
                    )?;
                }
                if let Some(error) = failures.organization() {
                    write!(formatter, "; {error}")?;
                }
                if let Some(error) = failures.organization_terminal() {
                    write!(formatter, "; {error}")?;
                }
                if let Some(error) = failures.sessions_terminal() {
                    write!(formatter, "; {error}")?;
                }
                Ok(())
            }
        }
    }
}

impl std::error::Error for HostShutdownError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Transition(error) => Some(error),
            Self::Resources { failures, .. } => {
                if let Some(error) = &failures.call_log {
                    Some(error)
                } else if let Some(error) = &failures.organization {
                    Some(error)
                } else if let Some(error) = &failures.organization_terminal {
                    Some(error)
                } else {
                    failures
                        .sessions_terminal
                        .as_ref()
                        .map(|error| error as &(dyn std::error::Error + 'static))
                }
            }
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Failures {
    owner_joins: Vec<&'static str>,
    call_log: Option<CallLogError>,
    organization: Option<organization::OrganizationShutdownError>,
    organization_terminal: Option<organization::OrganizationTerminalCloseError>,
    sessions_terminal: Option<sessions_module::SessionTerminalCloseError>,
    open_claw_session: Option<SessionShutdownFailure>,
    open_claw: Option<OwnerShutdownFailure>,
    matcha: Option<OwnerShutdownFailure>,
}

impl Failures {
    pub fn owner_joins(&self) -> &[&'static str] {
        &self.owner_joins
    }

    pub const fn call_log(&self) -> Option<CallLogError> {
        self.call_log
    }

    pub const fn organization(&self) -> Option<organization::OrganizationShutdownError> {
        self.organization
    }

    pub const fn organization_terminal(&self) -> Option<organization::OrganizationTerminalCloseError> {
        self.organization_terminal
    }

    pub const fn sessions_terminal(&self) -> Option<sessions_module::SessionTerminalCloseError> {
        self.sessions_terminal
    }

    pub const fn open_claw_session(&self) -> Option<SessionShutdownFailure> {
        self.open_claw_session
    }

    pub const fn open_claw(&self) -> Option<OwnerShutdownFailure> {
        self.open_claw
    }

    pub const fn matcha(&self) -> Option<OwnerShutdownFailure> {
        self.matcha
    }

    fn any(&self) -> bool {
        !self.owner_joins.is_empty()
            || self.call_log.is_some()
            || self.organization.is_some()
            || self.organization_terminal.is_some()
            || self.sessions_terminal.is_some()
            || self.open_claw_session.is_some()
            || self.open_claw.is_some()
            || self.matcha.is_some()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OwnerShutdownFailure {
    Shutdown,
    Join,
}

pub(super) struct ShutdownState {
    cron_closed: bool,
    owner_joins: Arc<Mutex<Vec<&'static str>>>,
    call_log: Arc<Mutex<Option<Result<(), CallLogError>>>>,
    organization: Option<organization::OrganizationShutdownError>,
    organization_terminal: Option<organization::OrganizationTerminalCloseError>,
    sessions_terminal: Option<sessions_module::SessionTerminalCloseError>,
    open_claw_session: SessionShutdown,
    open_claw: Arc<Mutex<SlotState>>,
    matcha: Arc<Mutex<SlotState>>,
}

impl ShutdownState {
    pub(super) fn new(owner_joins: Arc<Mutex<Vec<&'static str>>>) -> Self {
        Self {
            cron_closed: false,
            owner_joins,
            call_log: Arc::new(Mutex::new(None)),
            organization: None,
            organization_terminal: None,
            sessions_terminal: None,
            open_claw_session: SessionShutdown::new(),
            open_claw: Arc::new(Mutex::new(SlotState::Pending)),
            matcha: Arc::new(Mutex::new(SlotState::Pending)),
        }
    }

    pub(super) fn call_log_scope(&self, calls: call_log::CallLogModule) -> ModuleScope {
        let mut scope = ModuleScope::new("call-log");
        let outcome = Arc::clone(&self.call_log);
        scope.register_effect_disposer(
            ScopedEffectKind::OwnerTask,
            "owner-task",
            move || async move {
                let result = calls.shutdown().await;
                *outcome
                    .lock()
                    .expect("call log shutdown state lock poisoned") = Some(result);
            },
        );
        scope
    }

    fn call_log_outcome(&self) -> Option<Result<(), CallLogError>> {
        *self
            .call_log
            .lock()
            .expect("call log shutdown state lock poisoned")
    }

    fn all_settled(&self) -> bool {
        self.call_log_outcome().is_some()
            && self.organization.is_none()
            && self.organization_terminal.is_none()
            && self.sessions_terminal.is_none()
            && self.open_claw_session.is_settled()
            && self.open_claw_slot(SlotState::is_settled)
            && self.matcha_slot(SlotState::is_settled)
    }

    fn failures(&self) -> Failures {
        Failures {
            owner_joins: self
                .owner_joins
                .lock()
                .expect("owner join failure state lock poisoned")
                .clone(),
            call_log: self.call_log_outcome().and_then(Result::err),
            organization: self.organization,
            organization_terminal: self.organization_terminal,
            sessions_terminal: self.sessions_terminal,
            open_claw_session: self.open_claw_session.failure(),
            open_claw: self.open_claw_slot(SlotState::failure),
            matcha: self.matcha_slot(SlotState::failure),
        }
    }

    fn report(&self) -> ShutdownReport {
        ShutdownReport {
            open_claw: self.open_claw_slot(SlotState::report_outcome),
            matcha: self.matcha_slot(SlotState::report_outcome),
        }
    }

    pub(super) fn open_claw_snapshot(&self) -> Option<SupervisorSnapshot> {
        self.open_claw_slot(SlotState::snapshot)
    }

    pub(super) fn matcha_snapshot(&self) -> Option<SupervisorSnapshot> {
        self.matcha_slot(SlotState::snapshot)
    }

    fn open_claw_slot<T>(&self, read: impl FnOnce(&SlotState) -> T) -> T {
        let state = self
            .open_claw
            .lock()
            .expect("OpenClaw shutdown state lock poisoned");
        read(&state)
    }

    fn matcha_slot<T>(&self, read: impl FnOnce(&SlotState) -> T) -> T {
        let state = self
            .matcha
            .lock()
            .expect("Matcha shutdown state lock poisoned");
        read(&state)
    }
}

enum PendingJoin {
    OpenClaw(PendingSupervisorJoin),
    Matcha(tokio::task::JoinHandle<Result<(), matcha_agent::peer::JoinError>>),
}

impl PendingJoin {
    async fn wait(&mut self) -> Result<(), ()> {
        match self {
            Self::OpenClaw(join) => join.wait().await.map_err(|_| ()),
            Self::Matcha(join) => join.await.map_err(|_| ())?.map_err(|_| ()),
        }
    }
}

enum SlotState {
    Pending,
    NoProcess,
    Shutdown,
    Unresolved {
        outcome: ShutdownOutcome,
    },
    Joining {
        snapshot: tokio::sync::watch::Receiver<SupervisorSnapshot>,
        outcome: Option<ShutdownOutcome>,
        join: PendingJoin,
    },
    JoinFailed {
        snapshot: SupervisorSnapshot,
        outcome: Option<ShutdownOutcome>,
    },
    Settled {
        snapshot: SupervisorSnapshot,
        outcome: Option<ShutdownOutcome>,
    },
}

impl SlotState {
    const fn is_settled(&self) -> bool {
        matches!(
            self,
            Self::NoProcess | Self::Settled { outcome: Some(_), .. }
        )
    }

    const fn join_is_terminal(&self) -> bool {
        matches!(
            self,
            Self::NoProcess | Self::Settled { .. } | Self::JoinFailed { .. }
        )
    }

    const fn has_terminal_failure(&self) -> bool {
        matches!(
            self,
            Self::JoinFailed { .. } | Self::Settled { outcome: None, .. }
        )
    }

    const fn failure(&self) -> Option<OwnerShutdownFailure> {
        match self {
            Self::Pending | Self::NoProcess | Self::Settled { outcome: Some(_), .. } => None,
            Self::Shutdown | Self::Unresolved { .. } | Self::Settled { outcome: None, .. } => {
                Some(OwnerShutdownFailure::Shutdown)
            }
            Self::Joining { .. } | Self::JoinFailed { .. } => Some(OwnerShutdownFailure::Join),
        }
    }

    const fn settle_reason(&self) -> Option<ShutdownReason> {
        match self {
            Self::NoProcess | Self::Settled { outcome: Some(_), .. } => Some(ShutdownReason::Completed),
            Self::JoinFailed { .. } => Some(ShutdownReason::JoinFailed),
            Self::Unresolved { .. } => Some(ShutdownReason::Unresolved),
            Self::Shutdown | Self::Settled { outcome: None, .. } => {
                Some(ShutdownReason::ConfirmationFailed)
            }
            Self::Pending | Self::Joining { .. } => None,
        }
    }

    const fn outcome(&self) -> Option<&ShutdownOutcome> {
        match self {
            Self::Unresolved { outcome } => Some(outcome),
            Self::Joining { outcome, .. }
            | Self::JoinFailed { outcome, .. }
            | Self::Settled { outcome, .. } => outcome.as_ref(),
            Self::Pending | Self::NoProcess | Self::Shutdown => None,
        }
    }

    fn report_outcome(&self) -> Option<RuntimeShutdownOutcome> {
        match self {
            Self::NoProcess => Some(RuntimeShutdownOutcome::NoProcess),
            _ => self.outcome().map(runtime_shutdown_outcome),
        }
    }

    fn snapshot(&self) -> Option<SupervisorSnapshot> {
        match self {
            Self::Joining { snapshot, .. } => Some(snapshot.borrow().clone()),
            Self::JoinFailed { snapshot, .. }
            | Self::Settled { snapshot, .. } => Some(snapshot.clone()),
            Self::Pending | Self::NoProcess | Self::Shutdown | Self::Unresolved { .. } => None,
        }
    }
}

async fn finish_slot_join(
    shared_state: &Mutex<SlotState>,
    observation: &ObservationSink,
    step: &'static str,
) -> bool {
    std::future::poll_fn(|context| {
        let mut state = shared_state
            .lock()
            .expect("runtime process shutdown state lock poisoned");
        let SlotState::Joining { join, .. } = &mut *state else {
            return Poll::Ready(false);
        };
        let result = std::pin::pin!(join.wait()).poll(context);
        let Poll::Ready(result) = result else {
            return Poll::Pending;
        };
        let SlotState::Joining { snapshot, outcome, .. } =
            std::mem::replace(&mut *state, SlotState::Shutdown)
        else {
            unreachable!("joining slot was polled");
        };
        let snapshot = snapshot.borrow().clone();
        let outcome = outcome.or_else(|| match snapshot.last_outcome() {
            Some(SupervisorOutcome::ShutDown(outcome)) => Some(outcome.clone()),
            _ => None,
        });
        *state = match result {
            Ok(()) => SlotState::Settled { snapshot, outcome },
            Err(()) => SlotState::JoinFailed { snapshot, outcome },
        };
        let reason = state.settle_reason().unwrap_or(ShutdownReason::Unresolved);
        drop(state);
        observe_shutdown_settle(observation, step, reason);
        Poll::Ready(true)
    })
    .await
}

fn slot_is_pending(shared_state: &Mutex<SlotState>) -> bool {
    matches!(
        *shared_state
            .lock()
            .expect("runtime process shutdown state lock poisoned"),
        SlotState::Pending
    )
}

fn slot_join_is_terminal(shared_state: &Mutex<SlotState>) -> bool {
    shared_state
        .lock()
        .expect("runtime process shutdown state lock poisoned")
        .join_is_terminal()
}

fn store_slot_state(shared_state: &Arc<Mutex<SlotState>>, state: SlotState) {
    *shared_state
        .lock()
        .expect("runtime process shutdown state lock poisoned") = state;
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
