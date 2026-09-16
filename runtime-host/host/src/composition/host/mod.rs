use std::sync::Arc;

use crate::runtime::{
    adapters::{
        matcha_agent::{MatchaAgentInput, MatchaAgentInstance, build_peer},
        openclaw::{OpenClawInput, OpenClawInstance},
    },
    driver::RuntimeDriver,
};
use foundation::execution::ObservationSink;
use matcha_agent::lifecycle::secret::Secret;
use openclaw::gateway::auth::GatewaySecret;
use organization::OrganizationStore;

use crate::{
    channel::ChannelHandle, fleet::handle::FleetHandle, provider::handle::ProviderHandle,
    sessions::handle::SessionHandle, transport::runtime::parent_callback::ParentCallbackClient,
};

use super::{
    admission::{HostAdmission, HostState as AdmissionState, HostTransitionError},
    events::{self, EventSinks, HostEvents},
    peer::PeerHandle,
};
mod diagnostics;
mod errors;
mod handles;
mod owner_runtime;
mod provisioning;
#[allow(dead_code)]
mod session_shutdown;
mod shutdown;
mod workspace_errors;

pub use errors::{ConstructionError, RuntimeLifecycleFailure, RuntimeStartFailure};
pub use session_shutdown::SessionShutdownFailure;
pub use shutdown::{
    Failures as ShutdownFailures, HostShutdownError, OwnerShutdownFailure, RuntimeExit,
    RuntimeShutdownFailure, RuntimeShutdownOutcome, ShutdownReport,
};
pub use workspace_errors::{
    WorkspaceBinaryError, WorkspaceListError, WorkspaceMediaError, WorkspaceReadError,
    WorkspaceStatError, WorkspaceWriteError,
};

pub struct HostInput {
    pub matcha: MatchaAgentInput,
    pub matcha_secret: Secret,
    pub open_claw: OpenClawInput,
    pub open_claw_secret: GatewaySecret,
    pub organization_store: OrganizationStore,
    pub runtime_state_dir: std::path::PathBuf,
    /// The desktop shell's own log directory, collected by the diagnostics archive.
    pub app_log_dir: std::path::PathBuf,
    pub parent_callback_base_url: String,
    pub parent_callback_dispatch_token: String,
    pub cron_transport_port: u16,
    pub runtime_observation: crate::diagnostics::RuntimeObservationConfig,
}

pub(crate) struct HostHandles {
    pub peer: PeerHandle,
    pub session: SessionHandle,
    pub provider: ProviderHandle,
    pub settings: crate::settings::SettingsHandle,
    pub connector: crate::connectors::ConnectorHandle,
    pub security: crate::security::SecurityHandle,
    pub channel: ChannelHandle,
    pub fleet: FleetHandle,
    pub organization: crate::organization::OrganizationHandle,
    pub platform_runtime: crate::facade::PlatformRuntimeHandle,
    pub toolchain: crate::facade::ToolchainHandle,
    pub platform_tools: crate::facade::PlatformToolsHandle,
    pub plugins: crate::facade::PluginsHandle,
    pub skills: crate::facade::SkillsHandle,
    pub clawhub_registry: clawhub::ClawHubRegistryClient,
    pub cron: crate::facade::CronHandle,
    pub agents: crate::facade::AgentsHandle,
    pub task_manager: crate::facade::TaskManagerHandle,
    pub workspace: crate::facade::WorkspaceHandle,
    pub usage: crate::facade::UsageHandle,
    pub diagnostics: crate::facade::DiagnosticsHandle,
    pub(crate) observation: ObservationSink,
    pub channel_endpoint: platform::endpoint::runtime_address::RuntimeEndpoint,
}

pub struct Host {
    pub(crate) admission: Arc<HostAdmission>,
    pub(crate) _parent_callback: ParentCallbackClient,
    session_handle: SessionHandle,
    peer_handle: PeerHandle,
    fleet_handle: FleetHandle,
    fleet_startup_dispatches: Vec<crate::fleet::owner::PendingDispatch>,
    owner_runtime_tasks: owner_runtime::OwnerRuntimeTasks,
    peer_startup: super::peer::PeerStartupState,
    matcha: MatchaAgentInstance,
    open_claw: Arc<OpenClawInstance>,
    cron_handle: crate::facade::CronHandle,
    event_sinks: EventSinks,
    runtime_observation: crate::diagnostics::RuntimeFlightRecorder,
    matcha_startup_diagnostics: crate::diagnostics::MatchaStartupDiagnostics,
    openclaw_startup_diagnostics: crate::diagnostics::OpenClawStartupDiagnostics,
    shutdown_failures: shutdown::ShutdownState,
}

impl Host {
    pub(crate) fn new(
        input: HostInput,
    ) -> Result<(Self, HostEvents, HostHandles), ConstructionError> {
        let HostInput {
            matcha,
            matcha_secret,
            open_claw,
            open_claw_secret,
            organization_store,
            runtime_state_dir,
            app_log_dir,
            parent_callback_base_url,
            parent_callback_dispatch_token,
            cron_transport_port: _,
            runtime_observation,
        } = input;
        let parent_callback =
            ParentCallbackClient::new(parent_callback_base_url, parent_callback_dispatch_token)
                .map_err(ConstructionError::ParentCallback)?;
        let mut prepared = provisioning::prepare_host(provisioning::PrepareHostInput {
            matcha,
            matcha_secret,
            open_claw,
            open_claw_secret,
            organization_store,
            runtime_state_dir,
            app_log_dir,
            runtime_observation,
        });
        let report_matcha_diagnostic =
            diagnostics::matcha_diagnostic_reporter(prepared.matcha_startup_diagnostics.clone());
        let report_openclaw_diagnostic = diagnostics::openclaw_diagnostic_reporter(
            prepared.openclaw_startup_diagnostics.clone(),
        );
        prepared.openclaw_input_mut().report_diagnostic = report_openclaw_diagnostic;
        let (openclaw_input, openclaw_secret, prepared) = prepared.into_openclaw_parts();
        let open_claw = OpenClawInstance::prepare(openclaw_input, openclaw_secret)
            .map_err(ConstructionError::OpenClaw)?;
        let sealed = provisioning::provision_sealed_resources(prepared)?;
        let (matcha_input, matcha_secret, sealed) = sealed.into_matcha_parts();
        let matcha = build_peer(
            matcha_input,
            matcha_secret,
            Arc::clone(&sealed.toolchain),
            report_matcha_diagnostic,
        )
        .map_err(ConstructionError::Matcha)?;
        let provisioned = provisioning::provision_runtime_stores(sealed)?;
        let mut matcha = MatchaAgentInstance::new(matcha);
        let (event_sinks, events) = events::channels();
        matcha.set_renderer_events(event_sinks.matcha());
        let peer_matcha_lifecycle_sink = event_sinks.matcha_lifecycle();
        let open_claw_event_sink = event_sinks
            .open_claw()
            .expect("OpenClaw event sink must be available during construction");
        let open_claw_runtime_sink = event_sinks
            .open_claw_runtime()
            .expect("OpenClaw runtime event sink must be available during construction");
        let open_claw_canonical_sink = event_sinks
            .open_claw_canonical()
            .expect("OpenClaw canonical event sink must be available during construction");
        let open_claw = open_claw
            .into_instance(
                open_claw_event_sink,
                open_claw_canonical_sink,
                parent_callback.handle(),
            )
            .map_err(ConstructionError::OpenClaw)?;
        let open_claw = Arc::new(open_claw);
        let admission = Arc::new(HostAdmission::new());
        let matcha_runtime_driver = matcha.runtime_driver();
        let owners = owner_runtime::spawn_runtime_owners(owner_runtime::RuntimeOwnerInput {
            organization_store: provisioned.organization_store,
            runtime_state_dir: provisioned.runtime_state_dir,
            diagnostics_state_root: provisioned.diagnostics_state_root,
            runtime_host_mcp_executable: provisioned.runtime_host_mcp_executable,
            team_run_mcp_state_dir: provisioned.team_run_mcp_state_dir,
            provider_cascade: provisioned.provider_cascade,
            fleet_private_root: provisioned.fleet_private_root,
            team_skill_selections: provisioned.team_skill_selections,
            matcha_startup_diagnostics: provisioned.matcha_startup_diagnostics.clone(),
            openclaw_startup_diagnostics: provisioned.openclaw_startup_diagnostics.clone(),
            runtime_observation: provisioned.runtime_observation.clone(),
            open_claw: Arc::clone(&open_claw),
            matcha_driver: matcha_runtime_driver.clone(),
            admission: Arc::clone(&admission),
            session_delta: event_sinks.session_delta(),
            open_claw_runtime: event_sinks.open_claw_runtime(),
        })?;
        let open_claw_runtime_readiness = open_claw.control_readiness();
        diagnostics::forward_openclaw_runtime_changes(
            open_claw.owner().subscribe(),
            open_claw_runtime_sink.clone(),
        );
        diagnostics::forward_openclaw_runtime_readiness_changes(
            open_claw_runtime_readiness,
            open_claw_runtime_sink,
        );
        if let Some(matcha_lifecycle_sink) = peer_matcha_lifecycle_sink {
            diagnostics::forward_matcha_lifecycle_changes(
                matcha_runtime_driver
                    .lifecycle_ops()
                    .expect("Matcha Agent lifecycle operations must be available")
                    .subscribe(),
                matcha_lifecycle_sink,
            );
        }
        let handles = handles::build_handles(
            handles::HostHandleInput {
                admission: Arc::clone(&admission),
                open_claw: Arc::clone(&open_claw),
                toolchain: Arc::clone(&provisioned.toolchain),
                runtime_directory: Arc::clone(&owners.runtime_directory),
                sealed_skill_store: provisioned.sealed_skill_store,
                sealed_agent_store: provisioned.sealed_agent_store,
                sealed_runtime_token: provisioned.sealed_runtime_token,
                diagnostics: provisioned.diagnostics,
                clawhub_registry: provisioned.clawhub_registry,
                runtime_observation: provisioned.runtime_observation.clone(),
            },
            &owners,
            &event_sinks,
        );
        let cron_handle = handles.cron.clone();

        Ok((
            Self {
                admission,
                _parent_callback: parent_callback,
                session_handle: owners.session_handle,
                peer_handle: owners.peer_handle,
                fleet_handle: owners.fleet_handle,
                fleet_startup_dispatches: owners.fleet_startup_dispatches,
                owner_runtime_tasks: owners.tasks,
                peer_startup: owners.peer_startup,
                matcha,
                open_claw,
                cron_handle,
                event_sinks,
                runtime_observation: provisioned.runtime_observation,
                matcha_startup_diagnostics: provisioned.matcha_startup_diagnostics,
                openclaw_startup_diagnostics: provisioned.openclaw_startup_diagnostics,
                shutdown_failures: shutdown::ShutdownState::new(),
            },
            events,
            handles,
        ))
    }

    fn runtime_driver(
        &self,
        endpoint: &platform::endpoint::runtime_address::RuntimeEndpoint,
    ) -> Option<&dyn RuntimeDriver> {
        if *endpoint == self.open_claw.endpoint() {
            Some(self.open_claw.as_ref())
        } else if *endpoint == self.matcha.endpoint() {
            Some(&self.matcha)
        } else {
            None
        }
    }

    pub(crate) fn sessions(&self) -> &SessionHandle {
        &self.session_handle
    }

    pub(crate) fn publish_session_delta(
        &self,
        delta: crate::sessions::state::SessionDelta,
    ) -> bool {
        self.event_sinks
            .session_delta()
            .is_some_and(|sink| sink.try_send(delta).is_ok())
    }

    pub async fn start(&mut self) -> Result<(), HostTransitionError> {
        self.start_with_open_claw(true).await
    }

    pub async fn start_admission_only(&mut self) -> Result<(), HostTransitionError> {
        match self.admission.state().phase() {
            super::admission::HostPhase::Created => self.admission.begin_start()?,
            super::admission::HostPhase::Starting => {}
            phase => return Err(HostTransitionError::StartFrom(phase)),
        }
        self.drain_fleet_startup_dispatches().await;
        self.admission.publish_ready()
    }

    async fn drain_fleet_startup_dispatches(&mut self) {
        let pending = std::mem::take(&mut self.fleet_startup_dispatches);
        for dispatch in pending {
            let _ = self.fleet_handle.begin_pending_dispatch(dispatch).await;
        }
    }

    pub async fn start_with_open_claw(
        &mut self,
        open_claw_auto_start: bool,
    ) -> Result<(), HostTransitionError> {
        self.start_admission_only().await?;
        let _ = self
            .peer_handle
            .request_peer_autostart(open_claw_auto_start)
            .await;
        Ok(())
    }

    pub fn admission_state(&self) -> AdmissionState {
        self.admission.state()
    }
}

#[cfg(test)]
mod tests;
