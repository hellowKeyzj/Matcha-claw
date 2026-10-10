use std::sync::{Arc, Mutex};

use foundation::{
    execution::{CommandRoute, LaneRetention, OwnerSpec, QueryRoute},
    process::supervision::StartOutcome,
};

use crate::{
    composition::admission::HostAdmission, composition::runtime_ports::RuntimeDriverDirectory,
    composition::runtime_ports::RuntimeStartFailure as DriverStartFailure,
};
use organization::{OrganizationHandle, TeamRunCoordinatorHandle};
use provider_module::ProviderHandle;

use super::{
    AutostartOpenClawError, PeerCommand, PeerGlobalState, PeerKey, PeerLaneState, PeerQuery,
    RuntimeRestartCommandError, RuntimeStartCommandError, RuntimeStopCommandError,
    command::RuntimeLifecycleCall,
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
    matcha_startup_diagnostics: ::diagnostics::RuntimeStartupDiagnostics,
    open_claw: Arc<openclaw::driver::OpenClawDriver>,
    openclaw_startup_diagnostics: ::diagnostics::RuntimeStartupDiagnostics,
    provider: ProviderHandle,
    settings: settings::SettingsModule,
    security: security::SecurityModule,
    team_run: TeamRunCoordinatorHandle,
    organization: OrganizationHandle,
    runtime_directory: Arc<RuntimeDriverDirectory>,
    open_claw_runtime_events: Option<tokio::sync::mpsc::Sender<()>>,
    matcha_start: Arc<Mutex<Option<Result<StartOutcome, DriverStartFailure>>>>,
    open_claw_start: Arc<Mutex<Option<Result<StartOutcome, DriverStartFailure>>>>,
}

impl PeerShared {
    pub(super) fn admission(&self) -> &HostAdmission {
        &self.admission
    }

    pub(super) fn matcha_startup_diagnostics(&self) -> &::diagnostics::RuntimeStartupDiagnostics {
        &self.matcha_startup_diagnostics
    }

    pub(super) fn open_claw(&self) -> &Arc<openclaw::driver::OpenClawDriver> {
        &self.open_claw
    }

    pub(super) fn openclaw_startup_diagnostics(&self) -> &::diagnostics::RuntimeStartupDiagnostics {
        &self.openclaw_startup_diagnostics
    }

    pub(super) fn provider(&self) -> &ProviderHandle {
        &self.provider
    }

    pub(super) fn settings(&self) -> &settings::SettingsModule {
        &self.settings
    }

    pub(super) fn security(&self) -> &security::SecurityModule {
        &self.security
    }

    pub(super) fn team_run(&self) -> &TeamRunCoordinatorHandle {
        &self.team_run
    }

    pub(super) fn organization(&self) -> &OrganizationHandle {
        &self.organization
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
        matcha_startup_diagnostics: ::diagnostics::RuntimeStartupDiagnostics,
        open_claw: Arc<openclaw::driver::OpenClawDriver>,
        openclaw_startup_diagnostics: ::diagnostics::RuntimeStartupDiagnostics,
        provider: ProviderHandle,
        settings: settings::SettingsModule,
        security: security::SecurityModule,
        team_run: TeamRunCoordinatorHandle,
        organization: OrganizationHandle,
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
                organization,
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

async fn handle_command(shared: &PeerShared, key: &PeerKey, mut command: PeerCommand) {
    let _reservation = match &mut command {
        PeerCommand::AutostartOpenClaw { reservation, .. }
        | PeerCommand::StartRuntime { reservation, .. }
        | PeerCommand::StopRuntime { reservation, .. }
        | PeerCommand::RestartRuntime { reservation, .. }
        | PeerCommand::RepairRuntime { reservation, .. }
        | PeerCommand::RestartOpenClawAfterPluginChange { reservation, .. } => reservation.take(),
        PeerCommand::AutostartMatcha => None,
    };
    let Some(driver) = shared.runtime_directory().lookup(key) else {
        reject_missing_lifecycle(shared, command).await;
        return;
    };
    let Some(lifecycle) = driver.host_lifecycle_ops() else {
        reject_missing_lifecycle(shared, command).await;
        return;
    };
    match command {
        PeerCommand::AutostartMatcha => {
            super::matcha::autostart(shared, lifecycle).await;
        }
        PeerCommand::AutostartOpenClaw { reply, .. } => {
            let _ = reply.send(super::openclaw::autostart(shared, lifecycle).await);
        }
        PeerCommand::StartRuntime { call, .. } => {
            if !run_lifecycle_call(&call, key).await {
                return;
            }
            let result = start_runtime(shared, key, lifecycle).await;
            let status = match &result {
                Ok(state) => lifecycle_success_status(
                    key,
                    state,
                    runtime_directory::control_loopback::RuntimeControlOperation::LifecycleStart,
                ),
                Err(RuntimeStartCommandError::RuntimeStart(error)) => start_failure_status(*error),
            };
            let state = result
                .as_ref()
                .cloned()
                .unwrap_or_else(|_| runtime_state(shared, key));
            finish_manual_lifecycle_call(
                Some(call),
                key,
                status,
                &state,
                result
                    .as_ref()
                    .err()
                    .map(|_| runtime_directory::RuntimeControlLifecycleError::CommandFailed),
            )
            .await;
        }
        PeerCommand::StopRuntime { call, reply, .. } => {
            if let Some(call) = &call {
                if !run_lifecycle_call(call, key).await {
                    if let Some(reply) = reply {
                        let _ = reply.send(Err(RuntimeStopCommandError::AdmissionClosed));
                    }
                    return;
                }
            }
            let result = stop_runtime(shared, key, lifecycle).await;
            let status = match &result {
                Ok(state) => lifecycle_success_status(
                    key,
                    state,
                    runtime_directory::control_loopback::RuntimeControlOperation::LifecycleStop,
                ),
                Err(RuntimeStopCommandError::AdmissionClosed) => {
                    platform::call::CallStatus::Rejected
                }
                Err(RuntimeStopCommandError::RuntimeStop(error)) => {
                    lifecycle_failure_status(*error)
                }
            };
            let state = result
                .as_ref()
                .cloned()
                .unwrap_or_else(|_| runtime_state(shared, key));
            finish_manual_lifecycle_call(
                call,
                key,
                status,
                &state,
                result.as_ref().err().map(|error| match error {
                    RuntimeStopCommandError::AdmissionClosed => {
                        runtime_directory::RuntimeControlLifecycleError::Unavailable
                    }
                    RuntimeStopCommandError::RuntimeStop(_) => {
                        runtime_directory::RuntimeControlLifecycleError::CommandFailed
                    }
                }),
            )
            .await;
            if let Some(reply) = reply {
                let _ = reply.send(result);
            }
        }
        PeerCommand::RepairRuntime { call, .. } => {
            if !run_lifecycle_call(&call, key).await {
                return;
            }
            let result = super::openclaw::repair_manual(shared, lifecycle).await;
            let repair = shared.open_claw().repair_snapshot();
            let state = result.as_ref().cloned().unwrap_or_else(|_| runtime_state(shared, key));
            let status = if result.is_ok()
                && state.lifecycle() == crate::RuntimeLifecycle::Running
                && repair.phase == runtime_directory::RuntimeRepairPhase::Succeeded
            {
                platform::call::CallStatus::Succeeded
            } else if repair.phase == runtime_directory::RuntimeRepairPhase::Failed {
                platform::call::CallStatus::Failed
            } else {
                platform::call::CallStatus::Unknown
            };
            let mut detail = runtime_directory::call::RuntimeControlCallDetail::new(key);
            let observation = crate::composition::runtime_ports::runtime_control_status(&state);
            detail.lifecycle = Some(observation.lifecycle);
            detail.failure = observation.failure;
            detail.startup_diagnostic = observation.startup_diagnostic;
            detail.repair = Some(repair);
            detail.error = result.err().map(|_| runtime_directory::RuntimeControlLifecycleError::CommandFailed);
            detail.result = Some(match status {
                platform::call::CallStatus::Succeeded => runtime_directory::call::RuntimeControlCallResult::Succeeded,
                platform::call::CallStatus::Failed => runtime_directory::call::RuntimeControlCallResult::Failed,
                _ => runtime_directory::call::RuntimeControlCallResult::Unknown,
            });
            runtime_directory::call::finish_runtime_control_call(Some(call.context), status, &detail).await;
        }
        PeerCommand::RestartOpenClawAfterPluginChange { reply, .. } => {
            let _ = reply.send(super::openclaw::restart_admitted(shared, lifecycle).await);
        }
        PeerCommand::RestartRuntime { call, .. } => {
            if !run_lifecycle_call(&call, key).await {
                return;
            }
            let result = restart_runtime(shared, key, lifecycle).await;
            let status = match &result {
                Ok(state) => lifecycle_success_status(
                    key,
                    state,
                    runtime_directory::control_loopback::RuntimeControlOperation::LifecycleRestart,
                ),
                Err(RuntimeRestartCommandError::RuntimeRestart(error)) => {
                    lifecycle_failure_status(*error)
                }
            };
            let state = result
                .as_ref()
                .cloned()
                .unwrap_or_else(|_| runtime_state(shared, key));
            finish_manual_lifecycle_call(
                Some(call),
                key,
                status,
                &state,
                result
                    .as_ref()
                    .err()
                    .map(|_| runtime_directory::RuntimeControlLifecycleError::CommandFailed),
            )
            .await;
        }
    }
}

async fn start_runtime(
    shared: &PeerShared,
    key: &PeerKey,
    lifecycle: &dyn crate::composition::runtime_ports::LifecycleOps,
) -> Result<crate::RuntimeState, RuntimeStartCommandError> {
    if *key == crate::composition::runtime_ports::RuntimeDriverIdentity::open_claw().endpoint() {
        return super::openclaw::start_admitted(shared, lifecycle).await;
    }
    let result = lifecycle.start().await;
    super::status::runtime_start_result(result)
        .map(|()| runtime_state(shared, key))
        .map_err(RuntimeStartCommandError::RuntimeStart)
}

async fn stop_runtime(
    shared: &PeerShared,
    key: &PeerKey,
    lifecycle: &dyn crate::composition::runtime_ports::LifecycleOps,
) -> Result<crate::RuntimeState, RuntimeStopCommandError> {
    if *key == crate::composition::runtime_ports::RuntimeDriverIdentity::open_claw().endpoint() {
        return super::openclaw::stop(shared, lifecycle).await;
    }
    if shared.admission().admit_request().is_err() {
        return Err(RuntimeStopCommandError::AdmissionClosed);
    }
    let result = lifecycle.stop().await;
    super::status::runtime_stop_result(result)
        .map(|()| runtime_state(shared, key))
        .map_err(RuntimeStopCommandError::RuntimeStop)
}

async fn restart_runtime(
    shared: &PeerShared,
    key: &PeerKey,
    lifecycle: &dyn crate::composition::runtime_ports::LifecycleOps,
) -> Result<crate::RuntimeState, RuntimeRestartCommandError> {
    if *key == crate::composition::runtime_ports::RuntimeDriverIdentity::open_claw().endpoint() {
        return super::openclaw::restart_manual(shared, lifecycle).await;
    }
    let result = lifecycle.restart().await;
    super::status::runtime_restart_result(result)
        .map(|()| runtime_state(shared, key))
        .map_err(RuntimeRestartCommandError::RuntimeRestart)
}

fn runtime_state(shared: &PeerShared, key: &PeerKey) -> crate::RuntimeState {
    if *key == crate::composition::runtime_ports::RuntimeDriverIdentity::matcha_agent().endpoint() {
        super::status::matcha_state(shared)
    } else if *key
        == crate::composition::runtime_ports::RuntimeDriverIdentity::open_claw().endpoint()
    {
        super::status::open_claw_state(shared)
    } else {
        unreachable!("registered peer runtime must have a fixed status projection")
    }
}

async fn handle_query(shared: &PeerShared, query: PeerQuery) {
    match query {
        PeerQuery::State { reply } => {
            let _ = reply.send(super::status::host_state(shared));
        }
        PeerQuery::OpenClawRepairStatus { reply } => {
            let _ = reply.send(shared.open_claw().repair_snapshot());
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
        PeerQuery::OpenClawGatewaySnapshot { reply } => {
            let result = shared
                .admission()
                .admit_request()
                .map(|()| shared.open_claw().gateway_snapshot_observation());
            let _ = reply.send(result);
        }
        PeerQuery::OpenClawControlSnapshot { reply } => {
            let result = shared
                .admission()
                .admit_request()
                .map(|()| shared.open_claw().control_snapshot_observation());
            let _ = reply.send(result);
        }
        PeerQuery::RuntimeLogs {
            endpoint,
            cursor,
            reply,
        } => {
            let _ = reply.send(runtime_logs(shared, endpoint, cursor).await);
        }
        PeerQuery::RuntimeControlReadiness { endpoint, reply } => {
            let _ = reply.send(runtime_control_readiness(shared, endpoint).await);
        }
        PeerQuery::RuntimeGatewayHealth {
            endpoint,
            probe,
            reply,
        } => {
            let _ = reply.send(runtime_gateway_health(shared, endpoint, probe).await);
        }
        PeerQuery::RuntimeGatewayStatus {
            endpoint,
            include_channel_summary,
            reply,
        } => {
            let _ =
                reply.send(runtime_gateway_status(shared, endpoint, include_channel_summary).await);
        }
        PeerQuery::RuntimeControlUiUrl { endpoint, reply } => {
            let _ = reply.send(runtime_control_ui_url(shared, endpoint).await);
        }
        PeerQuery::OpenClawBrowserRequest {
            request,
            call,
            reply,
        } => {
            run_call(call.as_ref()).await;
            let result = match shared.admission().admit_request() {
                Ok(()) => Ok(shared.open_claw().browser_request(request).await),
                Err(error) => Err(error),
            };
            finish_gateway_call(
                call,
                openclaw::gateway::loopback::GatewayOperation::BrowserRequest,
                &result,
            )
            .await;
            let _ = reply.send(result);
        }
        PeerQuery::OpenClawMcpAppRequest {
            request,
            call,
            reply,
        } => {
            run_call(call.as_ref()).await;
            let result = match shared.admission().admit_request() {
                Ok(()) => Ok(shared.open_claw().mcp_app_request(request).await),
                Err(error) => Err(error),
            };
            finish_gateway_call(
                call,
                openclaw::gateway::loopback::GatewayOperation::McpAppRequest,
                &result,
            )
            .await;
            let _ = reply.send(result);
        }
        PeerQuery::OpenClawQuestionList { request, reply } => {
            let result = match shared.admission().admit_request() {
                Ok(()) => Ok(shared.open_claw().question_list(request).await),
                Err(error) => Err(error),
            };
            let _ = reply.send(result);
        }
        PeerQuery::OpenClawQuestionResolve {
            request,
            call,
            reply,
        } => {
            run_call(call.as_ref()).await;
            let result = match shared.admission().admit_request() {
                Ok(()) => Ok(shared.open_claw().question_resolve(request).await),
                Err(error) => Err(error),
            };
            finish_gateway_call(
                call,
                openclaw::gateway::loopback::GatewayOperation::QuestionResolve,
                &result,
            )
            .await;
            let _ = reply.send(result);
        }
    }
}

async fn reject_missing_lifecycle(shared: &PeerShared, command: PeerCommand) {
    match command {
        PeerCommand::AutostartMatcha => {
            shared.record_matcha_start(Err(DriverStartFailure::Unsupported));
        }
        PeerCommand::AutostartOpenClaw { reply, .. } => {
            shared.record_open_claw_start(Err(DriverStartFailure::Unsupported));
            shared.notify_open_claw_runtime();
            let _ = reply.send(Err(AutostartOpenClawError::RuntimeStart));
        }
        PeerCommand::StartRuntime { endpoint, call, .. } => {
            finish_lifecycle_call(
                Some(call),
                &endpoint,
                runtime_directory::control_loopback::RuntimeControlOperation::LifecycleStart,
                &Err(runtime_directory::RuntimeControlLifecycleError::Unsupported),
            )
            .await;
            if endpoint
                == crate::composition::runtime_ports::RuntimeDriverIdentity::open_claw().endpoint()
            {
                shared.record_open_claw_start(Err(DriverStartFailure::Unsupported));
                shared.notify_open_claw_runtime();
            }
        }
        PeerCommand::StopRuntime {
            endpoint,
            call,
            reply,
            ..
        } => {
            finish_lifecycle_call(
                call,
                &endpoint,
                runtime_directory::control_loopback::RuntimeControlOperation::LifecycleStop,
                &Err(runtime_directory::RuntimeControlLifecycleError::Unsupported),
            )
            .await;
            if endpoint
                == crate::composition::runtime_ports::RuntimeDriverIdentity::open_claw().endpoint()
            {
                shared.notify_open_claw_runtime();
            }
            if let Some(reply) = reply {
                let _ = reply.send(Err(RuntimeStopCommandError::RuntimeStop(
                    crate::RuntimeLifecycleFailure::Rejected,
                )));
            }
        }
        PeerCommand::RestartOpenClawAfterPluginChange { reply, .. } => {
            shared.notify_open_claw_runtime();
            let _ = reply.send(Err(RuntimeRestartCommandError::RuntimeRestart(
                crate::RuntimeLifecycleFailure::Rejected,
            )));
        }
        PeerCommand::RepairRuntime { endpoint, call, .. } => {
            finish_lifecycle_call(
                Some(call),
                &endpoint,
                runtime_directory::control_loopback::RuntimeControlOperation::LifecycleRepair,
                &Err(runtime_directory::RuntimeControlLifecycleError::Unsupported),
            ).await;
        }
        PeerCommand::RestartRuntime { endpoint, call, .. } => {
            finish_lifecycle_call(
                Some(call),
                &endpoint,
                runtime_directory::control_loopback::RuntimeControlOperation::LifecycleRestart,
                &Err(runtime_directory::RuntimeControlLifecycleError::Unsupported),
            )
            .await;
            if endpoint
                == crate::composition::runtime_ports::RuntimeDriverIdentity::open_claw().endpoint()
            {
                shared.notify_open_claw_runtime();
            }
        }
    }
}

async fn runtime_logs(
    shared: &PeerShared,
    endpoint: PeerKey,
    cursor: Option<u64>,
) -> Result<
    crate::composition::runtime_ports::RuntimeLogSnapshot,
    crate::composition::runtime_ports::RuntimeControlFailure,
> {
    let driver = runtime_control_driver(shared, &endpoint)?;
    match driver.runtime_control_ops() {
        Some(ops) => ops.logs(cursor).await,
        None => Err(crate::composition::runtime_ports::RuntimeControlFailure::Unsupported),
    }
}

async fn runtime_control_readiness(
    shared: &PeerShared,
    endpoint: PeerKey,
) -> Result<
    crate::composition::runtime_ports::RuntimeControlReadiness,
    crate::composition::runtime_ports::RuntimeControlFailure,
> {
    let driver = runtime_control_driver(shared, &endpoint)?;
    match driver.runtime_control_ops() {
        Some(ops) => ops.control_readiness().await,
        None => Err(crate::composition::runtime_ports::RuntimeControlFailure::Unsupported),
    }
}

async fn runtime_gateway_health(
    shared: &PeerShared,
    endpoint: PeerKey,
    probe: bool,
) -> Result<
    crate::composition::runtime_ports::RuntimeGatewayHealth,
    crate::composition::runtime_ports::RuntimeControlFailure,
> {
    let driver = runtime_control_driver(shared, &endpoint)?;
    match driver.runtime_control_ops() {
        Some(ops) => ops.gateway_health(probe).await,
        None => Err(crate::composition::runtime_ports::RuntimeControlFailure::Unsupported),
    }
}

async fn runtime_gateway_status(
    shared: &PeerShared,
    endpoint: PeerKey,
    include_channel_summary: bool,
) -> Result<
    crate::composition::runtime_ports::RuntimeGatewayStatus,
    crate::composition::runtime_ports::RuntimeControlFailure,
> {
    let driver = runtime_control_driver(shared, &endpoint)?;
    match driver.runtime_control_ops() {
        Some(ops) => ops.gateway_status(include_channel_summary).await,
        None => Err(crate::composition::runtime_ports::RuntimeControlFailure::Unsupported),
    }
}

async fn runtime_control_ui_url(
    shared: &PeerShared,
    endpoint: PeerKey,
) -> Result<String, crate::composition::runtime_ports::RuntimeControlFailure> {
    let driver = runtime_control_driver(shared, &endpoint)?;
    match driver.runtime_control_ops() {
        Some(ops) => ops.control_ui_url().await,
        None => Err(crate::composition::runtime_ports::RuntimeControlFailure::Unsupported),
    }
}

fn runtime_control_driver(
    shared: &PeerShared,
    endpoint: &PeerKey,
) -> Result<
    std::sync::Arc<dyn crate::composition::runtime_ports::RuntimeDriver>,
    crate::composition::runtime_ports::RuntimeControlFailure,
> {
    shared
        .admission()
        .admit_request()
        .map_err(|_| crate::composition::runtime_ports::RuntimeControlFailure::Unavailable)?;
    shared
        .runtime_directory()
        .lookup(endpoint)
        .ok_or(crate::composition::runtime_ports::RuntimeControlFailure::Unsupported)
}

async fn run_lifecycle_call(call: &RuntimeLifecycleCall, endpoint: &PeerKey) -> bool {
    let admission = async {
        call.accepted().await?;
        call.context.running().await
    }
    .await;
    if let Err(error) = admission {
        eprintln!(
            "[runtime-control] call_id={} admission audit failed; lifecycle effect withheld: {error}",
            call.context.id().as_str()
        );
        let mut detail = runtime_directory::call::RuntimeControlCallDetail::new(endpoint);
        detail.result = Some(runtime_directory::call::RuntimeControlCallResult::Unknown);
        detail.error = Some(runtime_directory::RuntimeControlLifecycleError::CommandFailed);
        runtime_directory::call::finish_runtime_control_call(
            Some(call.context.clone()),
            platform::call::CallStatus::Unknown,
            &detail,
        )
        .await;
        return false;
    }
    true
}

async fn run_call<D: platform::call::CallDetail>(call: Option<&platform::call::CallContext<D>>) {
    if let Some(call) = call {
        record_call_error(call.accepted().await.map(|_| ()));
        record_call_error(call.running().await);
    }
}

fn record_call_error(result: Result<(), platform::call::CallLogError>) {
    if let Err(error) = result {
        eprintln!("[peer] call transition could not be recorded: {error}");
    }
}

async fn finish_lifecycle_call(
    call: Option<RuntimeLifecycleCall>,
    endpoint: &PeerKey,
    operation: runtime_directory::control_loopback::RuntimeControlOperation,
    result: &Result<
        runtime_directory::RuntimeControlLifecycleStatus,
        runtime_directory::RuntimeControlLifecycleError,
    >,
) {
    if let Some(call) = &call {
        if !run_lifecycle_call(call, endpoint).await {
            return;
        }
    }
    let (status, detail) = runtime_directory::call::RuntimeControlCallDetail::lifecycle_result(
        endpoint, operation, result,
    );
    runtime_directory::call::finish_runtime_control_call(
        call.map(|call| call.context),
        status,
        &detail,
    )
    .await;
}

async fn finish_gateway_call(
    call: Option<openclaw::gateway::loopback::GatewayCallContext>,
    operation: openclaw::gateway::loopback::GatewayOperation,
    result: &Result<openclaw::port::OpenClawGatewayRequestOutcome, crate::RequestAdmissionClosed>,
) {
    if let Some(call) = call {
        let recorded = match result {
            Ok(outcome) => {
                openclaw::gateway::loopback::finish_gateway_call(&call, operation, outcome).await
            }
            Err(_) => {
                openclaw::gateway::loopback::finish_gateway_call_status(
                    &call,
                    operation,
                    platform::call::CallStatus::Rejected,
                )
                .await
            }
        };
        record_call_error(recorded);
    }
}

fn lifecycle_success_status(
    endpoint: &PeerKey,
    state: &crate::RuntimeState,
    operation: runtime_directory::control_loopback::RuntimeControlOperation,
) -> platform::call::CallStatus {
    runtime_directory::call::RuntimeControlCallDetail::lifecycle_result(
        endpoint,
        operation,
        &Ok(crate::composition::runtime_ports::runtime_control_status(
            state,
        )),
    )
    .0
}

fn start_failure_status(error: crate::RuntimeStartFailure) -> platform::call::CallStatus {
    use crate::RuntimeStartFailure;
    use platform::call::CallStatus;
    match error {
        RuntimeStartFailure::Busy
        | RuntimeStartFailure::Rejected
        | RuntimeStartFailure::ShuttingDown => CallStatus::Rejected,
        RuntimeStartFailure::CompletionFailed | RuntimeStartFailure::Cancelled => {
            CallStatus::Failed
        }
        RuntimeStartFailure::SupervisorStopped => CallStatus::Unknown,
    }
}

fn lifecycle_failure_status(error: crate::RuntimeLifecycleFailure) -> platform::call::CallStatus {
    use crate::RuntimeLifecycleFailure;
    use platform::call::CallStatus;
    match error {
        RuntimeLifecycleFailure::Busy
        | RuntimeLifecycleFailure::Rejected
        | RuntimeLifecycleFailure::ShuttingDown => CallStatus::Rejected,
        RuntimeLifecycleFailure::CompletionFailed | RuntimeLifecycleFailure::Cancelled => {
            CallStatus::Failed
        }
        RuntimeLifecycleFailure::SupervisorStopped | RuntimeLifecycleFailure::AlreadySatisfied => {
            CallStatus::Unknown
        }
    }
}

async fn finish_manual_lifecycle_call(
    call: Option<RuntimeLifecycleCall>,
    endpoint: &PeerKey,
    status: platform::call::CallStatus,
    state: &crate::RuntimeState,
    error: Option<runtime_directory::RuntimeControlLifecycleError>,
) {
    let mut detail = runtime_directory::call::RuntimeControlCallDetail::new(endpoint);
    let observation = crate::composition::runtime_ports::runtime_control_status(state);
    detail.lifecycle = Some(observation.lifecycle);
    detail.failure = observation.failure;
    detail.startup_diagnostic = observation.startup_diagnostic;
    detail.error = error;
    detail.result = Some(match status {
        platform::call::CallStatus::Succeeded => {
            runtime_directory::call::RuntimeControlCallResult::Succeeded
        }
        platform::call::CallStatus::Rejected => {
            runtime_directory::call::RuntimeControlCallResult::Unavailable
        }
        platform::call::CallStatus::Failed => {
            runtime_directory::call::RuntimeControlCallResult::Failed
        }
        _ => runtime_directory::call::RuntimeControlCallResult::Unknown,
    });
    runtime_directory::call::finish_runtime_control_call(
        call.map(|call| call.context),
        status,
        &detail,
    )
    .await;
}
