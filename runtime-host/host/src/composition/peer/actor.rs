use std::sync::{Arc, Mutex};

use foundation::{
    execution::{CommandRoute, LaneRetention, OwnerSpec, QueryRoute},
    process::supervision::{
        RestartOutcome, StartOutcome, SupervisorPhase, SupervisorSnapshot, TerminationCompletion,
    },
};

use crate::{
    HostState, RuntimeState,
    composition::{ControlLease, OpenClawInstance, admission::HostAdmission},
    diagnostics::{MatchaStartupDiagnostics, OpenClawStartupDiagnostics},
    organization::TeamRunCoordinatorHandle,
    provider::handle::ProviderHandle,
    runtime_directory::RuntimeDriverDirectory,
    runtime_driver::{
        LifecycleOps, RuntimeDriverIdentity, RuntimeLifecycleFailure as DriverLifecycleFailure,
        RuntimeStartFailure as DriverStartFailure,
    },
    security::SecurityHandle,
    settings::SettingsHandle,
};

use super::{
    PeerCommand, PeerGlobalState, PeerKey, PeerLaneState, PeerQuery, RestartMatchaError,
    RestartOpenClawError, StartMatchaError, StartOpenClawError, StopMatchaError, StopOpenClawError,
};

#[derive(Clone)]
pub(crate) struct PeerStartupState {
    matcha_start: Arc<Mutex<Option<Result<StartOutcome, DriverStartFailure>>>>,
    open_claw_start: Arc<Mutex<Option<Result<StartOutcome, DriverStartFailure>>>>,
}

impl PeerStartupState {
    pub(crate) fn new() -> Self {
        Self {
            matcha_start: Arc::new(Mutex::new(None)),
            open_claw_start: Arc::new(Mutex::new(None)),
        }
    }

    pub(crate) fn matcha_start_failure(&self) -> Option<crate::RuntimeStartFailure> {
        self.matcha_start
            .lock()
            .expect("Matcha peer start result lock poisoned")
            .as_ref()
            .and_then(start_failure)
    }

    pub(crate) fn open_claw_start_failure(&self) -> Option<crate::RuntimeStartFailure> {
        self.open_claw_start
            .lock()
            .expect("OpenClaw peer start result lock poisoned")
            .as_ref()
            .and_then(start_failure)
    }
}

#[derive(Clone)]
pub(crate) struct PeerShared {
    admission: Arc<HostAdmission>,
    matcha_startup_diagnostics: MatchaStartupDiagnostics,
    open_claw: Arc<OpenClawInstance>,
    openclaw_startup_diagnostics: OpenClawStartupDiagnostics,
    provider: ProviderHandle,
    settings: SettingsHandle,
    security: SecurityHandle,
    team_run: TeamRunCoordinatorHandle,
    runtime_directory: Arc<RuntimeDriverDirectory>,
    open_claw_runtime_events: Option<tokio::sync::mpsc::Sender<()>>,
    matcha_start: Arc<Mutex<Option<Result<StartOutcome, DriverStartFailure>>>>,
    open_claw_start: Arc<Mutex<Option<Result<StartOutcome, DriverStartFailure>>>>,
}

pub(crate) struct PeerOwner {
    shared: PeerShared,
}

impl PeerOwner {
    pub(crate) fn new(
        admission: Arc<HostAdmission>,
        matcha_startup_diagnostics: MatchaStartupDiagnostics,
        open_claw: Arc<OpenClawInstance>,
        openclaw_startup_diagnostics: OpenClawStartupDiagnostics,
        provider: ProviderHandle,
        settings: SettingsHandle,
        security: SecurityHandle,
        team_run: TeamRunCoordinatorHandle,
        runtime_directory: Arc<RuntimeDriverDirectory>,
        open_claw_runtime_events: Option<tokio::sync::mpsc::Sender<()>>,
        startup: PeerStartupState,
    ) -> Self {
        Self {
            shared: PeerShared {
                admission,
                matcha_startup_diagnostics,
                open_claw,
                openclaw_startup_diagnostics,
                provider,
                settings,
                security,
                team_run,
                runtime_directory,
                open_claw_runtime_events,
                matcha_start: startup.matcha_start,
                open_claw_start: startup.open_claw_start,
            },
        }
    }

    pub(crate) fn lane_retention() -> LaneRetention {
        LaneRetention::LowFrequency
    }
}

impl OwnerSpec for PeerOwner {
    type Command = PeerCommand;
    type Query = PeerQuery;
    type Key = PeerKey;
    type Shared = PeerShared;
    type GlobalState = PeerGlobalState;
    type LaneState = PeerLaneState;

    fn split(self) -> (Self::Shared, Self::GlobalState) {
        (self.shared, ())
    }

    fn route_command(command: &Self::Command) -> CommandRoute<Self::Key> {
        command.route_command()
    }

    fn route_query(query: &Self::Query) -> QueryRoute<Self::Key> {
        query.route_query()
    }

    fn open_lane(_shared: &Self::Shared, _key: &Self::Key) -> Self::LaneState {}

    async fn handle_keyed_command(
        shared: Self::Shared,
        key: Self::Key,
        _lane: &mut Self::LaneState,
        command: Self::Command,
    ) {
        let Some(driver) = shared.runtime_directory.lookup(&key) else {
            reject_missing_lifecycle(&shared, command);
            return;
        };
        let Some(lifecycle) = driver.lifecycle_ops() else {
            reject_missing_lifecycle(&shared, command);
            return;
        };
        match command {
            PeerCommand::AutostartMatcha => {
                autostart_matcha(&shared, lifecycle).await;
            }
            PeerCommand::StartMatcha { reply } => {
                let _ = reply.send(start_matcha(&shared, lifecycle).await);
            }
            PeerCommand::StopMatcha { reply } => {
                let _ = reply.send(stop_matcha(&shared, lifecycle).await);
            }
            PeerCommand::RestartMatcha { reply } => {
                let _ = reply.send(restart_matcha(&shared, lifecycle).await);
            }
            PeerCommand::AutostartOpenClaw => {
                autostart_open_claw(&shared, lifecycle).await;
            }
            PeerCommand::StartOpenClaw { reply } => {
                let _ = reply.send(start_open_claw(&shared, lifecycle).await);
            }
            PeerCommand::StopOpenClaw { reply } => {
                let _ = reply.send(stop_open_claw(&shared, lifecycle).await);
            }
            PeerCommand::RestartOpenClaw { reply } => {
                let _ = reply.send(restart_open_claw(&shared, lifecycle).await);
            }
        }
    }

    async fn handle_global_command(
        _shared: Self::Shared,
        _global: &mut Self::GlobalState,
        _command: Self::Command,
    ) {
    }

    async fn handle_direct_query(shared: Self::Shared, query: Self::Query) {
        handle_query(&shared, query).await;
    }

    async fn handle_keyed_query(
        shared: Self::Shared,
        _key: Self::Key,
        _lane: &mut Self::LaneState,
        query: Self::Query,
    ) {
        handle_query(&shared, query).await;
    }

    async fn handle_global_query(
        shared: Self::Shared,
        _global: &mut Self::GlobalState,
        query: Self::Query,
    ) {
        handle_query(&shared, query).await;
    }

    async fn handle_exclusive_query(
        shared: Self::Shared,
        _global: &mut Self::GlobalState,
        query: Self::Query,
    ) {
        handle_query(&shared, query).await;
    }
}

async fn handle_query(shared: &PeerShared, query: PeerQuery) {
    match query {
        PeerQuery::State { reply } => {
            let _ = reply.send(host_state(shared));
        }
        PeerQuery::MatchaStatus { reply } => {
            let _ = reply.send(matcha_state(shared));
        }
        PeerQuery::OpenClawStatus { reply } => {
            let _ = reply.send(open_claw_state(shared));
        }
        PeerQuery::OpenClawLogs { cursor, reply } => {
            let result = match shared.admission.admit_request() {
                Ok(()) => shared.open_claw.logs(cursor).await,
                Err(_) => Err(()),
            };
            let _ = reply.send(result);
        }
        PeerQuery::OpenClawGatewayHealth { probe, reply } => {
            let result = shared
                .admission
                .admit_request()
                .map(|()| shared.open_claw.gateway_health_observation(probe));
            let _ = reply.send(result);
        }
        PeerQuery::OpenClawGatewayStatus {
            include_channel_summary,
            reply,
        } => {
            let result = shared.admission.admit_request().map(|()| {
                shared
                    .open_claw
                    .gateway_status_observation(include_channel_summary)
            });
            let _ = reply.send(result);
        }
        PeerQuery::OpenClawControlUiUrl { reply } => {
            let _ = reply.send(shared.open_claw.control_ui_url());
        }
        PeerQuery::OpenClawControlLease { reply } => {
            let snapshot = open_claw_lifecycle_snapshot(shared);
            let result = shared
                .admission
                .admit_request()
                .map(|()| control_lease_for_snapshot(shared, &snapshot));
            let _ = reply.send(result);
        }
    }
}

async fn autostart_matcha(shared: &PeerShared, lifecycle: &dyn LifecycleOps) {
    let result = lifecycle.start().await;
    if result.is_err() {
        record_matcha_start(shared, result);
    }
}

async fn autostart_open_claw(shared: &PeerShared, lifecycle: &dyn LifecycleOps) {
    apply_openclaw_prelaunch_projections(shared).await;
    let result = lifecycle.start().await;
    let start_succeeded = matches!(&result, Ok(StartOutcome::Started));
    record_open_claw_start(shared, result);
    if start_succeeded {
        shared.team_run.recover_materialization_receipts().await;
    }
    notify_open_claw_runtime(shared);
}

fn reject_missing_lifecycle(shared: &PeerShared, command: PeerCommand) {
    match command {
        PeerCommand::AutostartMatcha => {
            record_matcha_start(shared, Err(DriverStartFailure::Unsupported));
        }
        PeerCommand::StartMatcha { reply } => {
            record_matcha_start(shared, Err(DriverStartFailure::Unsupported));
            let _ = reply.send(Err(StartMatchaError::RuntimeStart));
        }
        PeerCommand::StopMatcha { reply } => {
            let _ = reply.send(Err(StopMatchaError::RuntimeStop));
        }
        PeerCommand::RestartMatcha { reply } => {
            let _ = reply.send(Err(RestartMatchaError::RuntimeRestart));
        }
        PeerCommand::AutostartOpenClaw => {
            record_open_claw_start(shared, Err(DriverStartFailure::Unsupported));
            notify_open_claw_runtime(shared);
        }
        PeerCommand::StartOpenClaw { reply } => {
            record_open_claw_start(shared, Err(DriverStartFailure::Unsupported));
            notify_open_claw_runtime(shared);
            let _ = reply.send(Err(StartOpenClawError::RuntimeStart));
        }
        PeerCommand::StopOpenClaw { reply } => {
            notify_open_claw_runtime(shared);
            let _ = reply.send(Err(StopOpenClawError::RuntimeStop));
        }
        PeerCommand::RestartOpenClaw { reply } => {
            notify_open_claw_runtime(shared);
            let _ = reply.send(Err(RestartOpenClawError::RuntimeRestart));
        }
    }
}

async fn start_matcha(
    shared: &PeerShared,
    lifecycle: &dyn LifecycleOps,
) -> Result<RuntimeState, StartMatchaError> {
    if shared.admission.admit_request().is_err() {
        return Err(StartMatchaError::AdmissionClosed);
    }
    let result = lifecycle.start().await;
    record_matcha_start(shared, result.clone());
    runtime_start_result(result)
        .map(|()| matcha_state(shared))
        .map_err(|_| StartMatchaError::RuntimeStart)
}

async fn stop_matcha(
    shared: &PeerShared,
    lifecycle: &dyn LifecycleOps,
) -> Result<RuntimeState, StopMatchaError> {
    if shared.admission.admit_request().is_err() {
        return Err(StopMatchaError::AdmissionClosed);
    }
    shared.team_run.cancel_matcha_terminal_watches().await;
    let result = lifecycle.stop().await;
    runtime_stop_result(result)
        .map(|()| matcha_state(shared))
        .map_err(|_| StopMatchaError::RuntimeStop)
}

async fn restart_matcha(
    shared: &PeerShared,
    lifecycle: &dyn LifecycleOps,
) -> Result<RuntimeState, RestartMatchaError> {
    if shared.admission.admit_request().is_err() {
        return Err(RestartMatchaError::AdmissionClosed);
    }
    shared.team_run.cancel_matcha_terminal_watches().await;
    let result = lifecycle.restart().await;
    runtime_restart_result(result)
        .map(|()| matcha_state(shared))
        .map_err(|_| RestartMatchaError::RuntimeRestart)
}

async fn start_open_claw(
    shared: &PeerShared,
    lifecycle: &dyn LifecycleOps,
) -> Result<RuntimeState, StartOpenClawError> {
    if shared.admission.admit_request().is_err() {
        return Err(StartOpenClawError::AdmissionClosed);
    }
    apply_openclaw_prelaunch_projections(shared).await;
    let result = lifecycle.start().await;
    record_open_claw_start(shared, result.clone());
    let outcome = runtime_start_result(result);
    notify_open_claw_runtime(shared);
    match outcome {
        Ok(()) => {
            shared.team_run.recover_materialization_receipts().await;
            Ok(open_claw_state(shared))
        }
        Err(_) => Err(StartOpenClawError::RuntimeStart),
    }
}

async fn stop_open_claw(
    shared: &PeerShared,
    lifecycle: &dyn LifecycleOps,
) -> Result<RuntimeState, StopOpenClawError> {
    if shared.admission.admit_request().is_err() {
        return Err(StopOpenClawError::AdmissionClosed);
    }
    let result = lifecycle.stop().await;
    notify_open_claw_runtime(shared);
    runtime_stop_result(result)
        .map(|()| open_claw_state(shared))
        .map_err(|_| StopOpenClawError::RuntimeStop)
}

async fn restart_open_claw(
    shared: &PeerShared,
    lifecycle: &dyn LifecycleOps,
) -> Result<RuntimeState, RestartOpenClawError> {
    if shared.admission.admit_request().is_err() {
        return Err(RestartOpenClawError::AdmissionClosed);
    }
    apply_openclaw_prelaunch_projections(shared).await;
    let result = lifecycle.restart().await;
    notify_open_claw_runtime(shared);
    match runtime_restart_result(result) {
        Ok(()) => {
            shared.team_run.recover_materialization_receipts().await;
            Ok(open_claw_state(shared))
        }
        Err(_) => Err(RestartOpenClawError::RuntimeRestart),
    }
}

async fn apply_openclaw_prelaunch_projections(shared: &PeerShared) {
    let _ = shared
        .provider
        .prepare_openclaw_private_bootstrap(shared.open_claw.state_dir().clone())
        .await;
    if shared.settings.apply_saved_projection().await != crate::settings::DesiredOutcome::Confirmed
    {
        report_openclaw_startup_configuration_rejected(shared);
    }
    if shared
        .security
        .apply_saved_policy_projection()
        .await
        .is_err()
    {
        report_openclaw_startup_configuration_rejected(shared);
    }
}

fn report_openclaw_startup_configuration_rejected(shared: &PeerShared) {
    shared
        .openclaw_startup_diagnostics
        .report(openclaw::lifecycle::logs::LifecycleDiagnosticCategory::ConfigurationRejected);
}

fn notify_open_claw_runtime(shared: &PeerShared) {
    if let Some(events) = &shared.open_claw_runtime_events {
        let _ = events.try_send(());
    }
}

fn record_matcha_start(shared: &PeerShared, result: Result<StartOutcome, DriverStartFailure>) {
    *shared
        .matcha_start
        .lock()
        .expect("Matcha peer start result lock poisoned") = Some(result);
}

fn record_open_claw_start(shared: &PeerShared, result: Result<StartOutcome, DriverStartFailure>) {
    *shared
        .open_claw_start
        .lock()
        .expect("OpenClaw peer start result lock poisoned") = Some(result);
}

fn host_state(shared: &PeerShared) -> HostState {
    let matcha = matcha_lifecycle_snapshot(shared);
    let open_claw = open_claw_lifecycle_snapshot(shared);
    HostState::from_supervisors(
        shared.admission.state().phase(),
        &matcha,
        shared.matcha_startup_diagnostics.category(),
        &open_claw,
        shared.openclaw_startup_diagnostics.category(),
    )
}

fn matcha_state(shared: &PeerShared) -> RuntimeState {
    RuntimeState::from_snapshot_with_startup_diagnostic(
        &matcha_lifecycle_snapshot(shared),
        shared.matcha_startup_diagnostics.category().map(Into::into),
    )
}

fn open_claw_state(shared: &PeerShared) -> RuntimeState {
    RuntimeState::from_snapshot_with_startup_diagnostic(
        &open_claw_lifecycle_snapshot(shared),
        shared
            .openclaw_startup_diagnostics
            .category()
            .map(Into::into),
    )
}

fn matcha_lifecycle_snapshot(shared: &PeerShared) -> SupervisorSnapshot {
    lifecycle_snapshot(shared, RuntimeDriverIdentity::matcha_agent())
}

fn open_claw_lifecycle_snapshot(shared: &PeerShared) -> SupervisorSnapshot {
    lifecycle_snapshot(shared, RuntimeDriverIdentity::open_claw())
}

fn lifecycle_snapshot(shared: &PeerShared, identity: RuntimeDriverIdentity) -> SupervisorSnapshot {
    let endpoint = identity.endpoint();
    let driver = shared
        .runtime_directory
        .lookup(&endpoint)
        .expect("peer runtime lifecycle driver must be registered");
    driver
        .lifecycle_ops()
        .expect("peer runtime lifecycle ops must be registered")
        .snapshot()
}

fn control_lease_for_snapshot(shared: &PeerShared, snapshot: &SupervisorSnapshot) -> ControlLease {
    match snapshot.phase() {
        SupervisorPhase::Starting | SupervisorPhase::Running => shared.open_claw.control_lease(),
        _ => ControlLease::unavailable(),
    }
}

fn start_failure(
    result: &Result<StartOutcome, DriverStartFailure>,
) -> Option<crate::RuntimeStartFailure> {
    match result {
        Ok(StartOutcome::Started) => None,
        Ok(StartOutcome::Cancelled { .. }) => Some(crate::RuntimeStartFailure::Cancelled),
        Err(error) => Some(map_start_failure(*error)),
    }
}

fn runtime_start_result(
    result: Result<StartOutcome, DriverStartFailure>,
) -> Result<(), crate::RuntimeStartFailure> {
    match result {
        Ok(StartOutcome::Started) => Ok(()),
        Ok(StartOutcome::Cancelled { .. }) => Err(crate::RuntimeStartFailure::Cancelled),
        Err(error) => Err(map_start_failure(error)),
    }
}

fn runtime_stop_result(
    result: Result<TerminationCompletion, DriverLifecycleFailure>,
) -> Result<(), crate::RuntimeLifecycleFailure> {
    result.map(|_| ()).map_err(map_lifecycle_failure)
}

fn runtime_restart_result(
    result: Result<RestartOutcome, DriverLifecycleFailure>,
) -> Result<(), crate::RuntimeLifecycleFailure> {
    match result {
        Ok(RestartOutcome::Restarted) => Ok(()),
        Ok(RestartOutcome::Cancelled { .. }) => Err(crate::RuntimeLifecycleFailure::Cancelled),
        Err(error) => Err(map_lifecycle_failure(error)),
    }
}

const fn map_start_failure(error: DriverStartFailure) -> crate::RuntimeStartFailure {
    match error {
        DriverStartFailure::CompletionFailed => crate::RuntimeStartFailure::CompletionFailed,
        DriverStartFailure::SupervisorStopped => crate::RuntimeStartFailure::SupervisorStopped,
        DriverStartFailure::Busy => crate::RuntimeStartFailure::Busy,
        DriverStartFailure::Rejected(_) | DriverStartFailure::Unsupported => {
            crate::RuntimeStartFailure::Rejected
        }
        DriverStartFailure::ShuttingDown => crate::RuntimeStartFailure::ShuttingDown,
    }
}

const fn map_lifecycle_failure(error: DriverLifecycleFailure) -> crate::RuntimeLifecycleFailure {
    match error {
        DriverLifecycleFailure::CompletionFailed => {
            crate::RuntimeLifecycleFailure::CompletionFailed
        }
        DriverLifecycleFailure::SupervisorStopped => {
            crate::RuntimeLifecycleFailure::SupervisorStopped
        }
        DriverLifecycleFailure::AlreadySatisfied => {
            crate::RuntimeLifecycleFailure::AlreadySatisfied
        }
        DriverLifecycleFailure::Busy => crate::RuntimeLifecycleFailure::Busy,
        DriverLifecycleFailure::Rejected(_) | DriverLifecycleFailure::Unsupported => {
            crate::RuntimeLifecycleFailure::Rejected
        }
        DriverLifecycleFailure::ShuttingDown => crate::RuntimeLifecycleFailure::ShuttingDown,
    }
}
