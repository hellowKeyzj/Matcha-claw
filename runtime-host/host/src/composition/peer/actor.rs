use std::sync::{Arc, Mutex};

use foundation::{
    execution::{CommandRoute, LaneRetention, OwnerSpec, QueryRoute},
    process::supervision::StartOutcome,
};

use crate::{
    composition::admission::HostAdmission,
    diagnostics::{MatchaStartupDiagnostics, OpenClawStartupDiagnostics},
    organization::TeamRunCoordinatorHandle,
    provider::handle::ProviderHandle,
    runtime::adapters::openclaw::OpenClawInstance,
    runtime::directory::RuntimeDriverDirectory,
    runtime::driver::RuntimeStartFailure as DriverStartFailure,
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
            .and_then(super::status::start_failure)
    }

    pub(crate) fn open_claw_start_failure(&self) -> Option<crate::RuntimeStartFailure> {
        self.open_claw_start
            .lock()
            .expect("OpenClaw peer start result lock poisoned")
            .as_ref()
            .and_then(super::status::start_failure)
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

impl PeerShared {
    pub(super) fn admission(&self) -> &HostAdmission {
        &self.admission
    }

    pub(super) fn matcha_startup_diagnostics(&self) -> &MatchaStartupDiagnostics {
        &self.matcha_startup_diagnostics
    }

    pub(super) fn open_claw(&self) -> &Arc<OpenClawInstance> {
        &self.open_claw
    }

    pub(super) fn openclaw_startup_diagnostics(&self) -> &OpenClawStartupDiagnostics {
        &self.openclaw_startup_diagnostics
    }

    pub(super) fn provider(&self) -> &ProviderHandle {
        &self.provider
    }

    pub(super) fn settings(&self) -> &SettingsHandle {
        &self.settings
    }

    pub(super) fn security(&self) -> &SecurityHandle {
        &self.security
    }

    pub(super) fn team_run(&self) -> &TeamRunCoordinatorHandle {
        &self.team_run
    }

    pub(super) fn runtime_directory(&self) -> &RuntimeDriverDirectory {
        &self.runtime_directory
    }

    pub(super) fn open_claw_runtime_events(&self) -> Option<&tokio::sync::mpsc::Sender<()>> {
        self.open_claw_runtime_events.as_ref()
    }

    pub(super) fn record_matcha_start(&self, result: Result<StartOutcome, DriverStartFailure>) {
        *self
            .matcha_start
            .lock()
            .expect("Matcha peer start result lock poisoned") = Some(result);
    }

    pub(super) fn record_open_claw_start(&self, result: Result<StartOutcome, DriverStartFailure>) {
        *self
            .open_claw_start
            .lock()
            .expect("OpenClaw peer start result lock poisoned") = Some(result);
    }

    pub(super) fn notify_open_claw_runtime(&self) {
        if let Some(events) = self.open_claw_runtime_events() {
            let _ = events.try_send(());
        }
    }
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
        handle_command(&shared, &key, command).await;
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

async fn handle_command(shared: &PeerShared, key: &PeerKey, command: PeerCommand) {
    let Some(driver) = shared.runtime_directory().lookup(key) else {
        reject_missing_lifecycle(shared, command);
        return;
    };
    let Some(lifecycle) = driver.lifecycle_ops() else {
        reject_missing_lifecycle(shared, command);
        return;
    };
    match command {
        PeerCommand::AutostartMatcha => {
            super::matcha::autostart(shared, lifecycle).await;
        }
        PeerCommand::StartMatcha { reply } => {
            let _ = reply.send(super::matcha::start(shared, lifecycle).await);
        }
        PeerCommand::StopMatcha { reply } => {
            let _ = reply.send(super::matcha::stop(shared, lifecycle).await);
        }
        PeerCommand::RestartMatcha { reply } => {
            let _ = reply.send(super::matcha::restart(shared, lifecycle).await);
        }
        PeerCommand::AutostartOpenClaw => {
            super::openclaw::autostart(shared, lifecycle).await;
        }
        PeerCommand::StartOpenClaw { reply } => {
            let _ = reply.send(super::openclaw::start(shared, lifecycle).await);
        }
        PeerCommand::StopOpenClaw { reply } => {
            let _ = reply.send(super::openclaw::stop(shared, lifecycle).await);
        }
        PeerCommand::RestartOpenClaw { reply } => {
            let _ = reply.send(super::openclaw::restart(shared, lifecycle).await);
        }
    }
}

async fn handle_query(shared: &PeerShared, query: PeerQuery) {
    match query {
        PeerQuery::State { reply } => {
            let _ = reply.send(super::status::host_state(shared));
        }
        PeerQuery::MatchaStatus { reply } => {
            let _ = reply.send(super::status::matcha_state(shared));
        }
        PeerQuery::OpenClawStatus { reply } => {
            let _ = reply.send(super::status::open_claw_state(shared));
        }
        PeerQuery::OpenClawLogs { cursor, reply } => {
            let result = match shared.admission().admit_request() {
                Ok(()) => shared.open_claw().logs(cursor).await,
                Err(_) => Err(()),
            };
            let _ = reply.send(result);
        }
        PeerQuery::OpenClawGatewayHealth { probe, reply } => {
            let result = shared
                .admission()
                .admit_request()
                .map(|()| shared.open_claw().gateway_health_observation(probe));
            let _ = reply.send(result);
        }
        PeerQuery::OpenClawGatewayStatus {
            include_channel_summary,
            reply,
        } => {
            let result = shared.admission().admit_request().map(|()| {
                shared
                    .open_claw()
                    .gateway_status_observation(include_channel_summary)
            });
            let _ = reply.send(result);
        }
        PeerQuery::OpenClawControlUiUrl { reply } => {
            let _ = reply.send(shared.open_claw().control_ui_url());
        }
        PeerQuery::OpenClawControlLease { reply } => {
            let snapshot = super::status::open_claw_lifecycle_snapshot(shared);
            let result = shared
                .admission()
                .admit_request()
                .map(|()| super::status::control_lease_for_snapshot(shared, &snapshot));
            let _ = reply.send(result);
        }
        PeerQuery::OpenClawBrowserRequest { request, reply } => {
            let result = match shared.admission().admit_request() {
                Ok(()) => Ok(shared.open_claw().browser_request(request).await),
                Err(error) => Err(error),
            };
            let _ = reply.send(result);
        }
        PeerQuery::OpenClawMcpAppRequest { request, reply } => {
            let result = match shared.admission().admit_request() {
                Ok(()) => Ok(shared.open_claw().mcp_app_request(request).await),
                Err(error) => Err(error),
            };
            let _ = reply.send(result);
        }
    }
}

fn reject_missing_lifecycle(shared: &PeerShared, command: PeerCommand) {
    match command {
        PeerCommand::AutostartMatcha => {
            shared.record_matcha_start(Err(DriverStartFailure::Unsupported));
        }
        PeerCommand::StartMatcha { reply } => {
            shared.record_matcha_start(Err(DriverStartFailure::Unsupported));
            let _ = reply.send(Err(StartMatchaError::RuntimeStart));
        }
        PeerCommand::StopMatcha { reply } => {
            let _ = reply.send(Err(StopMatchaError::RuntimeStop));
        }
        PeerCommand::RestartMatcha { reply } => {
            let _ = reply.send(Err(RestartMatchaError::RuntimeRestart));
        }
        PeerCommand::AutostartOpenClaw => {
            shared.record_open_claw_start(Err(DriverStartFailure::Unsupported));
            shared.notify_open_claw_runtime();
        }
        PeerCommand::StartOpenClaw { reply } => {
            shared.record_open_claw_start(Err(DriverStartFailure::Unsupported));
            shared.notify_open_claw_runtime();
            let _ = reply.send(Err(StartOpenClawError::RuntimeStart));
        }
        PeerCommand::StopOpenClaw { reply } => {
            shared.notify_open_claw_runtime();
            let _ = reply.send(Err(StopOpenClawError::RuntimeStop));
        }
        PeerCommand::RestartOpenClaw { reply } => {
            shared.notify_open_claw_runtime();
            let _ = reply.send(Err(RestartOpenClawError::RuntimeRestart));
        }
    }
}
