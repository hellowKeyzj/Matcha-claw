use std::{
    fmt, fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use crate::runtime_driver::{RuntimeDriver, RuntimeDriverIdentity};
use environment::{ProviderCascade, migrate_provider_legacy_stores};
use foundation::{
    execution::{ObservationSink, OwnedTask, OwnerRuntimeSystem},
    process::supervision::SupervisorSnapshot,
};
use matcha_agent::lifecycle::secret::Secret;
use openclaw::gateway::auth::GatewaySecret;
use toolchain::NativeToolchain;

use crate::diagnostics::{
    DiagnosticsArchiveError, DiagnosticsArchiveProducer, DiagnosticsArchiveRoot, HostState,
    MatchaStartupDiagnostics, OpenClawStartupDiagnostics, RuntimeFlightRecorder,
    RuntimeObservationConfig,
};
use organization::{
    OrganizationStore, RecoveryQueryError, StoreFault, package::TeamSkillSelectionResolver,
};

use crate::{
    channel::{ChannelHandle, ChannelOwner, ChannelOwnerInput},
    connectors::{ConnectorHandle, ConnectorOwner, ConnectorOwnerInput},
    fleet::{handle::FleetHandle, owner::FleetOwner},
    parent_callback::{ParentCallbackClient, ParentCallbackConfigError},
    provider::handle::ProviderHandle,
    sessions::handle::SessionHandle,
};

use super::{
    admission::{
        HostAdmission, HostState as AdmissionState, HostTransitionError, RequestAdmissionClosed,
    },
    events::{self, EventSinks, HostEvents},
    matcha::{
        ConstructionError as MatchaConstructionError, MatchaAgentInput, MatchaAgentInstance,
        build_peer,
    },
    openclaw::{ConstructionError as OpenClawConstructionError, OpenClawInput, OpenClawInstance},
    peer::PeerHandle,
};

mod shutdown;

pub use shutdown::{
    Failures as ShutdownFailures, HostShutdownError, OwnerShutdownFailure, ShutdownReport,
};

pub struct HostInput {
    pub matcha: MatchaAgentInput,
    pub matcha_secret: Secret,
    pub open_claw: OpenClawInput,
    pub open_claw_secret: GatewaySecret,
    pub organization_store: OrganizationStore,
    pub runtime_state_dir: PathBuf,
    /// The desktop shell's own log directory, collected by the diagnostics archive.
    pub app_log_dir: PathBuf,
    pub parent_callback_base_url: String,
    pub parent_callback_dispatch_token: String,
    pub cron_transport_port: u16,
    pub runtime_observation: RuntimeObservationConfig,
}

pub struct HostHandles {
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

struct OwnerRuntimeTasks {
    system: OwnerRuntimeSystem,
    peer: OwnedTask<()>,
    security: OwnedTask<()>,
    channel: OwnedTask<()>,
    fleet: OwnedTask<()>,
    connector: OwnedTask<()>,
    settings: OwnedTask<()>,
    provider: OwnedTask<()>,
    session: OwnedTask<()>,
    organization: OrganizationRuntime,
}

struct OrganizationRuntime {
    owner: OwnedTask<()>,
    coordinator: crate::organization::TeamRunCoordinator,
}

impl OrganizationRuntime {
    async fn cancel_and_join(&mut self) {
        self.coordinator.cancel();
        let _ = self.coordinator.join().await;
        self.owner.cancel();
        let _ = self.owner.join().await;
    }
}

impl OwnerRuntimeTasks {
    async fn cancel_and_join(&mut self) {
        self.peer.cancel();
        self.security.cancel();
        self.channel.cancel();
        self.fleet.cancel();
        self.connector.cancel();
        self.settings.cancel();
        self.provider.cancel();
        self.session.cancel();
        self.organization.coordinator.cancel();
        let _ = self.peer.join().await;
        let _ = self.security.join().await;
        let _ = self.channel.join().await;
        let _ = self.fleet.join().await;
        let _ = self.connector.join().await;
        let _ = self.settings.join().await;
        let _ = self.provider.join().await;
        let _ = self.session.join().await;
        self.organization.cancel_and_join().await;
        let _ = self.system.cancel_and_join().await;
    }
}

pub struct Host {
    pub(crate) admission: Arc<HostAdmission>,
    pub(crate) parent_callback: ParentCallbackClient,
    session_handle: SessionHandle,
    peer_handle: PeerHandle,
    provider_handle: ProviderHandle,
    settings_handle: crate::settings::SettingsHandle,
    security_handle: crate::security::SecurityHandle,
    fleet_handle: FleetHandle,
    fleet_startup_dispatches: Vec<crate::fleet::owner::PendingDispatch>,
    owner_runtime_tasks: OwnerRuntimeTasks,
    peer_startup: super::peer::PeerStartupState,
    matcha: MatchaAgentInstance,
    open_claw: Arc<OpenClawInstance>,
    cron_handle: crate::facade::CronHandle,
    event_sinks: EventSinks,
    runtime_observation: RuntimeFlightRecorder,
    matcha_startup_diagnostics: MatchaStartupDiagnostics,
    openclaw_startup_diagnostics: OpenClawStartupDiagnostics,
    organization_handle: crate::organization::OrganizationHandle,
    shutdown_failures: shutdown::ShutdownState,
}

impl Host {
    pub fn new(input: HostInput) -> Result<(Self, HostEvents, HostHandles), ConstructionError> {
        let parent_callback = ParentCallbackClient::new(
            input.parent_callback_base_url,
            input.parent_callback_dispatch_token,
        )
        .map_err(ConstructionError::ParentCallback)?;
        let matcha_startup_diagnostics = MatchaStartupDiagnostics::new();
        let report_matcha_diagnostic = {
            let diagnostics = matcha_startup_diagnostics.clone();
            Arc::new(move |category| diagnostics.report(category))
        };
        let openclaw_startup_diagnostics = OpenClawStartupDiagnostics::new();
        let report_openclaw_diagnostic = {
            let diagnostics = openclaw_startup_diagnostics.clone();
            Arc::new(
                move |diagnostic: openclaw::lifecycle::logs::LifecycleDiagnostic| {
                    diagnostics.report(diagnostic.category())
                },
            )
        };
        let diagnostics_state_root = input.open_claw.state_dir.clone();
        let clawhub_registry =
            clawhub::ClawHubRegistryClient::new(diagnostics_state_root.as_path().to_owned());
        let runtime_state_dir = input.runtime_state_dir;
        let runtime_observation = RuntimeFlightRecorder::new(input.runtime_observation);
        #[cfg(windows)]
        let toolchain = NativeToolchain::local(input.open_claw.working_directory.clone());
        #[cfg(unix)]
        let toolchain = NativeToolchain::local(
            input.open_claw.working_directory.clone(),
            input.open_claw.guardian_executable.clone(),
        );
        let mut openclaw_input = input.open_claw;
        let runtime_host_mcp_executable = openclaw_input.team_run_mcp_executable.clone();
        let team_run_mcp_state_dir = openclaw_input.team_run_mcp_state_dir.clone();
        let sealed_runtime_token = openclaw_input.sealed_token.clone().map(Arc::<str>::from);
        openclaw_input.report_diagnostic = report_openclaw_diagnostic;
        let open_claw = OpenClawInstance::prepare(
            openclaw_input,
            input.open_claw_secret,
            Arc::clone(&toolchain),
        )
        .map_err(ConstructionError::OpenClaw)?;
        fs::create_dir_all(&runtime_state_dir).map_err(|_| ConstructionError::RuntimeState)?;
        let sealed_skill_private_root = runtime_state_dir
            .parent()
            .map(|root| root.join("runtime-local").join("sealed-skills"))
            .ok_or(ConstructionError::SealedSkills)?;
        let sealed_skill_store = Arc::new(
            crate::sealed_resource::SealedSkillStore::openclaw(
                diagnostics_state_root.clone(),
                sealed_skill_private_root,
            )
            .map_err(|_| ConstructionError::SealedSkills)?,
        );
        let sealed_agent_private_root = runtime_state_dir
            .parent()
            .map(|root| root.join("runtime-local").join("sealed-agents"))
            .ok_or(ConstructionError::SealedAgents)?;
        let sealed_agent_store = Arc::new(
            crate::sealed_resource::SealedAgentStore::openclaw(
                diagnostics_state_root.clone(),
                sealed_agent_private_root,
            )
            .map_err(|_| ConstructionError::SealedAgents)?,
        );
        let fleet_private_root_path = runtime_state_dir.join("fleet-private");
        let matcha = build_peer(
            input.matcha,
            input.matcha_secret,
            Arc::clone(&toolchain),
            report_matcha_diagnostic,
        )
        .map_err(ConstructionError::Matcha)?;
        let mut matcha = MatchaAgentInstance::new(matcha);
        provision_private_directory(&fleet_private_root_path)
            .map_err(|_| ConstructionError::Fleet)?;
        let fleet_private_root = fleet_private_root_path;
        let accounts_path = diagnostics_state_root
            .as_path()
            .join("matchaclaw-provider-accounts.json");
        let models_path = diagnostics_state_root
            .as_path()
            .join("matchaclaw-provider-models.json");
        let routing_path = diagnostics_state_root
            .as_path()
            .join("matchaclaw-capability-routing.json");
        migrate_provider_legacy_stores(&accounts_path, &models_path, &routing_path)
            .map_err(|_| ConstructionError::ProviderMigration)?;
        let provider_cascade = ProviderCascade::open(
            accounts_path.clone(),
            models_path.clone(),
            routing_path.clone(),
            diagnostics_state_root
                .as_path()
                .join("provider-cascade.v1.json"),
        )
        .map_err(|_| ConstructionError::ProviderAccounts)?;
        let fleet = FleetOwner::open(
            runtime_state_dir.join("fleet-facts.log"),
            &fleet_private_root,
            std::collections::BTreeMap::from([(
                "com.matchaclaw.remote-fleet.managed".to_owned(),
                "true".to_owned(),
            )]),
            std::collections::BTreeMap::new(),
        )
        .map_err(|_| ConstructionError::Fleet)?;
        let fleet_startup_dispatches = fleet.pending_dispatches();
        let diagnostics_root =
            DiagnosticsArchiveRoot::provision(diagnostics_state_root.as_path(), input.app_log_dir)
                .map_err(ConstructionError::Diagnostics)?;
        let diagnostics = DiagnosticsArchiveProducer::new_with_recorder(
            diagnostics_root,
            runtime_observation.clone(),
        )
        .map_err(ConstructionError::Diagnostics)?;
        let team_skill_selections = TeamSkillSelectionResolver::open(
            team_skill_selection_registry(diagnostics_state_root.as_path()),
        )
        .map_err(|_| ConstructionError::TeamSkillSelection)?;
        let (event_sinks, events) = events::channels();
        matcha.set_renderer_events(event_sinks.matcha());
        let peer_open_claw_runtime_sink = event_sinks.open_claw_runtime();
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
        let mut runtime_directory = crate::runtime_directory::RuntimeDriverDirectory::new();
        let open_claw = Arc::new(open_claw);
        runtime_directory.register_openclaw(Arc::clone(&open_claw));
        runtime_directory.register(matcha.runtime_driver());
        let runtime_directory = Arc::new(runtime_directory);
        let owner_runtime_system = OwnerRuntimeSystem::spawn_observed(
            foundation::execution::OwnerRuntimeConfig::new(
                64,
                foundation::execution::LaneRetention::MediumFrequency,
            ),
            runtime_observation.sink(),
        );
        let (fleet_owner_handle, fleet_task) = owner_runtime_system.spawn_owner(
            fleet,
            foundation::execution::OwnerRuntimeConfig::new(
                64,
                foundation::execution::LaneRetention::LowFrequency,
            ),
        );
        let fleet_handle = FleetHandle::new(fleet_owner_handle);
        let security_owner =
            crate::security::SecurityOwner::new(crate::security::SecurityOwnerInput {
                state_dir: diagnostics_state_root.as_path().to_path_buf(),
                runtime_directory: Arc::clone(&runtime_directory),
            })
            .map_err(|_| ConstructionError::Security)?;
        let (security_owner_handle, security_task) = owner_runtime_system.spawn_owner(
            security_owner,
            foundation::execution::OwnerRuntimeConfig::new(
                64,
                crate::security::SecurityOwner::lane_retention(),
            ),
        );
        let security_handle = crate::security::SecurityHandle::new(security_owner_handle);
        let channel_owner = ChannelOwner::new(ChannelOwnerInput {
            runtime_directory: Arc::clone(&runtime_directory),
        });
        let (channel_owner_handle, channel_task) = owner_runtime_system.spawn_owner(
            channel_owner,
            foundation::execution::OwnerRuntimeConfig::new(64, ChannelOwner::lane_retention()),
        );
        let channel_handle = ChannelHandle::new(channel_owner_handle);
        let channel_endpoint = RuntimeDriverIdentity::open_claw().endpoint();

        let connector_owner = ConnectorOwner::new(ConnectorOwnerInput {
            state_dir: diagnostics_state_root.clone(),
            runtime_directory: Arc::clone(&runtime_directory),
            runtime_host_mcp_executable,
            team_run_mcp_state_dir,
        })
        .map_err(|_| ConstructionError::ExternalConnectors)?;
        let (connector_owner_handle, connector_task) = owner_runtime_system.spawn_owner(
            connector_owner,
            foundation::execution::OwnerRuntimeConfig::new(
                64,
                foundation::execution::LaneRetention::LowFrequency,
            ),
        );
        let connector_handle = ConnectorHandle::new(connector_owner_handle);

        let settings_state =
            crate::settings::desired::DesiredState::open(diagnostics_state_root.as_path())
                .map_err(|_| ConstructionError::Settings)?;
        let settings_owner = crate::settings::actor::SettingsOwner::new(
            settings_state,
            Arc::clone(&runtime_directory),
        );
        let (settings_owner_handle, settings_task) = owner_runtime_system.spawn_owner(
            settings_owner,
            foundation::execution::OwnerRuntimeConfig::new(
                64,
                crate::settings::actor::SettingsOwner::lane_retention(),
            ),
        );
        let settings_handle = crate::settings::SettingsHandle::new(settings_owner_handle);

        let provider_owner = crate::provider::actor::ProviderOwner::new(
            provider_cascade,
            crate::provider::accounts::ProviderAccountsOwner::new(
                crate::transport::provider_accounts::private_auth::Resolver::disabled(),
            ),
            crate::provider::models::ProviderModelOwner::with_openclaw(Arc::clone(&open_claw)),
            crate::provider::routing::ProviderRoutingOwner::new(),
            Arc::clone(&runtime_directory),
        );
        let (provider_owner_handle, provider_task) = owner_runtime_system.spawn_owner(
            provider_owner,
            foundation::execution::OwnerRuntimeConfig::new(
                64,
                crate::provider::actor::ProviderOwner::lane_retention(),
            ),
        );
        let provider_handle = ProviderHandle::new(provider_owner_handle);

        let (session_owner, _session_snapshot) = crate::sessions::actor::SessionOwner::new(
            Arc::clone(&runtime_directory),
            provider_handle.clone(),
            event_sinks.session_delta(),
        );
        let (session_owner_handle, session_task) = owner_runtime_system.spawn_owner(
            session_owner,
            foundation::execution::OwnerRuntimeConfig::new(
                64,
                crate::sessions::actor::SessionOwner::lane_retention(),
            ),
        );
        let session_handle =
            SessionHandle::new(session_owner_handle, Arc::clone(&runtime_directory));
        let handles_session = session_handle.clone();

        let organization_owner = crate::organization::OrganizationOwner::new(
            crate::organization::OrganizationOwnerInput {
                store: input.organization_store,
                runtime_directory: Arc::clone(&runtime_directory),
                team_skill_selections,
            },
        );
        let (organization_owner_handle, organization_task) = owner_runtime_system.spawn_owner(
            organization_owner,
            foundation::execution::OwnerRuntimeConfig::new(
                256,
                crate::organization::OrganizationOwner::lane_retention(),
            ),
        );
        let organization_handle =
            crate::organization::OrganizationHandle::new(organization_owner_handle);
        let handles_organization = organization_handle.clone();
        let admission = Arc::new(HostAdmission::new());
        let (team_run_coordinator, team_run_coordinator_handle) =
            crate::organization::TeamRunCoordinator::spawn(
                crate::organization::TeamRunCoordinatorInput {
                    admission: Arc::clone(&admission),
                    organization: organization_handle.clone(),
                    runtime_directory: Arc::clone(&runtime_directory),
                    admission_changes: admission.subscribe(),
                    observation: runtime_observation.sink(),
                },
            );

        let peer_startup = super::peer::PeerStartupState::new();
        let peer_owner = super::peer::PeerOwner::new(
            Arc::clone(&admission),
            matcha_startup_diagnostics.clone(),
            Arc::clone(&open_claw),
            openclaw_startup_diagnostics.clone(),
            provider_handle.clone(),
            settings_handle.clone(),
            security_handle.clone(),
            team_run_coordinator_handle.clone(),
            Arc::clone(&runtime_directory),
            peer_open_claw_runtime_sink,
            peer_startup.clone(),
        );
        let (peer_owner_handle, peer_task) = owner_runtime_system.spawn_owner(
            peer_owner,
            foundation::execution::OwnerRuntimeConfig::new(
                64,
                super::peer::PeerOwner::lane_retention(),
            ),
        );
        let peer_handle = PeerHandle::new(peer_owner_handle);
        let handles_peer = peer_handle.clone();

        let open_claw_runtime_readiness = open_claw.control_readiness();
        forward_openclaw_runtime_changes(
            open_claw.owner().subscribe(),
            open_claw_runtime_sink.clone(),
        );
        forward_openclaw_runtime_readiness_changes(
            open_claw_runtime_readiness,
            open_claw_runtime_sink,
        );
        let matcha_runtime_driver = matcha.runtime_driver();
        if let Some(matcha_lifecycle_sink) = peer_matcha_lifecycle_sink {
            forward_matcha_lifecycle_changes(
                matcha_runtime_driver
                    .lifecycle_ops()
                    .expect("Matcha Agent lifecycle operations must be available")
                    .subscribe(),
                matcha_lifecycle_sink,
            );
        }

        let platform_runtime_handle = crate::facade::PlatformRuntimeHandle::new(
            Arc::clone(&admission),
            Arc::clone(&open_claw),
        );
        let toolchain_handle =
            crate::facade::ToolchainHandle::new(Arc::clone(&admission), Arc::clone(&toolchain));
        let platform_tools_handle =
            crate::facade::PlatformToolsHandle::new(Arc::clone(&admission), Arc::clone(&open_claw));
        let plugins_handle = crate::facade::PluginsHandle::new(
            Arc::clone(&admission),
            Arc::clone(&open_claw),
            peer_handle.clone(),
        );
        let skills_handle = crate::facade::SkillsHandle::new(
            Arc::clone(&admission),
            Arc::clone(&runtime_directory),
            sealed_skill_store,
            sealed_runtime_token.clone(),
        );
        let cron_handle = crate::facade::CronHandle::new(
            Arc::clone(&admission),
            Arc::clone(&runtime_directory),
            session_handle.clone(),
            event_sinks.open_claw_cron(),
            runtime_observation.sink(),
        );
        let agents_handle = crate::facade::AgentsHandle::new(
            Arc::clone(&admission),
            Arc::clone(&runtime_directory),
            sealed_agent_store,
            sealed_runtime_token,
        );
        let task_manager_handle = crate::facade::TaskManagerHandle::new(
            Arc::clone(&admission),
            Arc::clone(&runtime_directory),
        );
        let workspace_handle = crate::facade::WorkspaceHandle::new(
            Arc::clone(&admission),
            Arc::clone(&runtime_directory),
        );
        let usage_handle =
            crate::facade::UsageHandle::new(Arc::clone(&admission), Arc::clone(&open_claw));
        let diagnostics_handle = crate::facade::DiagnosticsHandle::new(
            Arc::clone(&admission),
            diagnostics.clone(),
            peer_handle.clone(),
        );

        Ok((
            Self {
                admission,
                parent_callback,
                session_handle,
                peer_handle,
                provider_handle: provider_handle.clone(),
                settings_handle: settings_handle.clone(),
                security_handle: security_handle.clone(),
                fleet_handle: fleet_handle.clone(),
                fleet_startup_dispatches,
                owner_runtime_tasks: OwnerRuntimeTasks {
                    system: owner_runtime_system,
                    peer: peer_task,
                    security: security_task,
                    channel: channel_task,
                    fleet: fleet_task,
                    connector: connector_task,
                    settings: settings_task,
                    provider: provider_task,
                    session: session_task,
                    organization: OrganizationRuntime {
                        owner: organization_task,
                        coordinator: team_run_coordinator,
                    },
                },
                peer_startup,
                matcha,
                open_claw,
                cron_handle: cron_handle.clone(),
                event_sinks,
                runtime_observation: runtime_observation.clone(),
                matcha_startup_diagnostics,
                openclaw_startup_diagnostics,
                organization_handle,
                shutdown_failures: shutdown::ShutdownState::new(),
            },
            events,
            HostHandles {
                peer: handles_peer,
                session: handles_session,
                provider: provider_handle,
                settings: settings_handle,
                connector: connector_handle,
                security: security_handle,
                channel: channel_handle,
                fleet: fleet_handle,
                organization: handles_organization,
                platform_runtime: platform_runtime_handle,
                toolchain: toolchain_handle,
                platform_tools: platform_tools_handle,
                plugins: plugins_handle,
                skills: skills_handle,
                clawhub_registry,
                cron: cron_handle,
                agents: agents_handle,
                task_manager: task_manager_handle,
                workspace: workspace_handle,
                usage: usage_handle,
                diagnostics: diagnostics_handle,
                observation: runtime_observation.sink(),
                channel_endpoint,
            },
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

    pub(crate) fn organization(&self) -> &crate::organization::OrganizationHandle {
        &self.organization_handle
    }

    pub fn state(&self) -> HostState {
        let matcha = self.matcha_lifecycle_snapshot();
        let open_claw = self.open_claw_lifecycle_snapshot();
        HostState::from_supervisors(
            self.admission.state().phase(),
            &matcha,
            self.matcha_startup_diagnostics.category(),
            &open_claw,
            self.openclaw_startup_diagnostics.category(),
        )
    }

    pub fn admission_state(&self) -> AdmissionState {
        self.admission.state()
    }

    pub fn matcha_start_failure(&self) -> Option<RuntimeStartFailure> {
        self.peer_startup.matcha_start_failure()
    }

    pub fn open_claw_start_failure(&self) -> Option<RuntimeStartFailure> {
        self.peer_startup.open_claw_start_failure()
    }

    pub(crate) fn matcha(&self) -> &matcha_agent::peer::MatchaPeer {
        self.matcha.peer()
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

fn provision_private_directory(path: &Path) -> std::io::Result<()> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                "private path is not a directory",
            ));
        }
        return Ok(());
    }
    fs::create_dir_all(path)
}

pub(crate) fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn forward_openclaw_runtime_changes(
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

fn forward_matcha_lifecycle_changes(
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

fn forward_openclaw_runtime_readiness_changes(
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

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum OrganizationRecoveryApplyError {
    AdmissionClosed(RequestAdmissionClosed),
    Recovery(RecoveryQueryError),
    Store(StoreFault),
}

impl From<RequestAdmissionClosed> for OrganizationRecoveryApplyError {
    fn from(value: RequestAdmissionClosed) -> Self {
        Self::AdmissionClosed(value)
    }
}

impl From<RecoveryQueryError> for OrganizationRecoveryApplyError {
    fn from(value: RecoveryQueryError) -> Self {
        Self::Recovery(value)
    }
}

impl From<StoreFault> for OrganizationRecoveryApplyError {
    fn from(value: StoreFault) -> Self {
        Self::Store(value)
    }
}

impl fmt::Display for OrganizationRecoveryApplyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AdmissionClosed(error) => error.fmt(formatter),
            Self::Recovery(error) => {
                write!(formatter, "organization recovery query failed: {error:?}")
            }
            Self::Store(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for OrganizationRecoveryApplyError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkspaceReadError {
    AdmissionClosed(RequestAdmissionClosed),
    InvalidPath,
    Unavailable,
    NotFile,
    TooLarge,
    Binary,
}

impl From<openclaw::workspace::WorkspaceReadFailure> for WorkspaceReadError {
    fn from(value: openclaw::workspace::WorkspaceReadFailure) -> Self {
        match value {
            openclaw::workspace::WorkspaceReadFailure::InvalidPath => Self::InvalidPath,
            openclaw::workspace::WorkspaceReadFailure::Unavailable => Self::Unavailable,
            openclaw::workspace::WorkspaceReadFailure::NotFile => Self::NotFile,
            openclaw::workspace::WorkspaceReadFailure::TooLarge => Self::TooLarge,
            openclaw::workspace::WorkspaceReadFailure::Binary => Self::Binary,
        }
    }
}

impl fmt::Display for WorkspaceReadError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AdmissionClosed(error) => error.fmt(formatter),
            Self::InvalidPath => formatter.write_str("workspace read path is invalid"),
            Self::Unavailable => formatter.write_str("workspace read is unavailable"),
            Self::NotFile => formatter.write_str("workspace read target is not a file"),
            Self::TooLarge => formatter.write_str("workspace read target exceeds the limit"),
            Self::Binary => formatter.write_str("workspace read target is binary"),
        }
    }
}

impl std::error::Error for WorkspaceReadError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkspaceMediaError {
    AdmissionClosed(RequestAdmissionClosed),
    InvalidPath,
    InvalidReference,
    Unavailable,
    NotFile,
    TooLarge,
}

impl From<openclaw::workspace::media::WorkspaceMediaFailure> for WorkspaceMediaError {
    fn from(value: openclaw::workspace::media::WorkspaceMediaFailure) -> Self {
        match value {
            openclaw::workspace::media::WorkspaceMediaFailure::InvalidPath => Self::InvalidPath,
            openclaw::workspace::media::WorkspaceMediaFailure::InvalidReference => {
                Self::InvalidReference
            }
            openclaw::workspace::media::WorkspaceMediaFailure::Unavailable => Self::Unavailable,
            openclaw::workspace::media::WorkspaceMediaFailure::NotFile => Self::NotFile,
            openclaw::workspace::media::WorkspaceMediaFailure::TooLarge => Self::TooLarge,
        }
    }
}

impl fmt::Display for WorkspaceMediaError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AdmissionClosed(error) => error.fmt(formatter),
            Self::InvalidPath => formatter.write_str("workspace media path is invalid"),
            Self::InvalidReference => formatter.write_str("workspace media reference is invalid"),
            Self::Unavailable => formatter.write_str("workspace media is unavailable"),
            Self::NotFile => formatter.write_str("workspace media target is not a file"),
            Self::TooLarge => formatter.write_str("workspace media target exceeds the limit"),
        }
    }
}

impl std::error::Error for WorkspaceMediaError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkspaceBinaryError {
    AdmissionClosed(RequestAdmissionClosed),
    InvalidPath,
    Unavailable,
    NotFile,
    TooLarge,
}

impl From<openclaw::workspace::WorkspaceBinaryFailure> for WorkspaceBinaryError {
    fn from(value: openclaw::workspace::WorkspaceBinaryFailure) -> Self {
        match value {
            openclaw::workspace::WorkspaceBinaryFailure::InvalidPath => Self::InvalidPath,
            openclaw::workspace::WorkspaceBinaryFailure::Unavailable => Self::Unavailable,
            openclaw::workspace::WorkspaceBinaryFailure::NotFile => Self::NotFile,
            openclaw::workspace::WorkspaceBinaryFailure::TooLarge => Self::TooLarge,
        }
    }
}

impl fmt::Display for WorkspaceBinaryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AdmissionClosed(error) => error.fmt(formatter),
            Self::InvalidPath => formatter.write_str("workspace binary path is invalid"),
            Self::Unavailable => formatter.write_str("workspace binary is unavailable"),
            Self::NotFile => formatter.write_str("workspace binary target is not a file"),
            Self::TooLarge => formatter.write_str("workspace binary target exceeds the limit"),
        }
    }
}

impl std::error::Error for WorkspaceBinaryError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkspaceStatError {
    AdmissionClosed(RequestAdmissionClosed),
    InvalidPath,
    Unavailable,
}

impl From<openclaw::workspace::WorkspaceStatFailure> for WorkspaceStatError {
    fn from(value: openclaw::workspace::WorkspaceStatFailure) -> Self {
        match value {
            openclaw::workspace::WorkspaceStatFailure::InvalidPath => Self::InvalidPath,
            openclaw::workspace::WorkspaceStatFailure::Unavailable => Self::Unavailable,
        }
    }
}

impl fmt::Display for WorkspaceStatError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AdmissionClosed(error) => error.fmt(formatter),
            Self::InvalidPath => formatter.write_str("workspace stat path is invalid"),
            Self::Unavailable => formatter.write_str("workspace stat is unavailable"),
        }
    }
}

impl std::error::Error for WorkspaceStatError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkspaceListError {
    AdmissionClosed(RequestAdmissionClosed),
    InvalidPath,
    Unavailable,
    NotDirectory,
}

impl From<openclaw::workspace::WorkspaceListFailure> for WorkspaceListError {
    fn from(value: openclaw::workspace::WorkspaceListFailure) -> Self {
        match value {
            openclaw::workspace::WorkspaceListFailure::InvalidPath => Self::InvalidPath,
            openclaw::workspace::WorkspaceListFailure::Unavailable => Self::Unavailable,
            openclaw::workspace::WorkspaceListFailure::NotDirectory => Self::NotDirectory,
        }
    }
}

impl fmt::Display for WorkspaceListError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AdmissionClosed(error) => error.fmt(formatter),
            Self::InvalidPath => formatter.write_str("workspace directory path is invalid"),
            Self::Unavailable => formatter.write_str("workspace directory is unavailable"),
            Self::NotDirectory => {
                formatter.write_str("workspace directory target is not a directory")
            }
        }
    }
}

impl std::error::Error for WorkspaceListError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkspaceWriteError {
    AdmissionClosed(RequestAdmissionClosed),
    InvalidPath,
    Unavailable,
    NotFile,
    TooLarge,
    OutcomeUnknown,
}

impl From<openclaw::workspace::WorkspaceWriteFailure> for WorkspaceWriteError {
    fn from(value: openclaw::workspace::WorkspaceWriteFailure) -> Self {
        match value {
            openclaw::workspace::WorkspaceWriteFailure::InvalidPath => Self::InvalidPath,
            openclaw::workspace::WorkspaceWriteFailure::Unavailable => Self::Unavailable,
            openclaw::workspace::WorkspaceWriteFailure::NotFile => Self::NotFile,
            openclaw::workspace::WorkspaceWriteFailure::TooLarge => Self::TooLarge,
            openclaw::workspace::WorkspaceWriteFailure::OutcomeUnknown => Self::OutcomeUnknown,
        }
    }
}

impl fmt::Display for WorkspaceWriteError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AdmissionClosed(error) => error.fmt(formatter),
            Self::InvalidPath => formatter.write_str("workspace write path is invalid"),
            Self::Unavailable => formatter.write_str("workspace write is unavailable"),
            Self::NotFile => formatter.write_str("workspace write target is not a file"),
            Self::TooLarge => formatter.write_str("workspace write content exceeds the limit"),
            Self::OutcomeUnknown => formatter.write_str("workspace write outcome is unknown"),
        }
    }
}

impl std::error::Error for WorkspaceWriteError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeStartFailure {
    Cancelled,
    CompletionFailed,
    SupervisorStopped,
    Busy,
    Rejected,
    ShuttingDown,
}

impl fmt::Display for RuntimeStartFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Cancelled => "runtime start was cancelled",
            Self::CompletionFailed => "runtime start failed",
            Self::SupervisorStopped => "runtime supervisor stopped during start",
            Self::Busy => "runtime supervisor is busy",
            Self::Rejected => "runtime start was rejected",
            Self::ShuttingDown => "runtime supervisor is shutting down",
        })
    }
}

impl std::error::Error for RuntimeStartFailure {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeLifecycleFailure {
    Cancelled,
    CompletionFailed,
    SupervisorStopped,
    AlreadySatisfied,
    Busy,
    Rejected,
    ShuttingDown,
}

impl fmt::Display for RuntimeLifecycleFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Cancelled => "runtime lifecycle command was cancelled",
            Self::CompletionFailed => "runtime lifecycle command failed",
            Self::SupervisorStopped => "runtime supervisor stopped during lifecycle command",
            Self::AlreadySatisfied => "runtime lifecycle command was already satisfied",
            Self::Busy => "runtime supervisor is busy",
            Self::Rejected => "runtime lifecycle command was rejected",
            Self::ShuttingDown => "runtime supervisor is shutting down",
        })
    }
}

impl std::error::Error for RuntimeLifecycleFailure {}

fn team_skill_selection_registry(state_dir: &std::path::Path) -> PathBuf {
    state_dir.join("team-skill-selections.v1.json")
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConstructionError {
    Diagnostics(DiagnosticsArchiveError),
    ParentCallback(ParentCallbackConfigError),
    TeamSkillSelection,
    ProviderAccounts,
    ProviderMigration,
    ProviderModels,
    ProviderRouting,
    ExternalConnectors,
    Fleet,
    Settings,
    Security,
    RuntimeState,
    SealedSkills,
    SealedAgents,
    Matcha(MatchaConstructionError),
    OpenClaw(OpenClawConstructionError),
}

impl fmt::Display for ConstructionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Diagnostics(error) => error.fmt(formatter),
            Self::ParentCallback(error) => error.fmt(formatter),
            Self::TeamSkillSelection => {
                formatter.write_str("TeamSkill selection owner could not be constructed")
            }
            Self::ProviderAccounts => {
                formatter.write_str("provider account owner could not be constructed")
            }
            Self::ProviderMigration => {
                formatter.write_str("provider legacy facts could not be migrated")
            }
            Self::ProviderModels => {
                formatter.write_str("provider model owner could not be constructed")
            }
            Self::ProviderRouting => {
                formatter.write_str("provider routing owner could not be constructed")
            }
            Self::ExternalConnectors => {
                formatter.write_str("external connector owner could not be constructed")
            }
            Self::Fleet => formatter.write_str("Fleet owner could not be constructed"),
            Self::Settings => formatter.write_str("settings owner could not be constructed"),
            Self::Security => formatter.write_str("security owner could not be constructed"),
            Self::RuntimeState => {
                formatter.write_str("runtime state directory could not be provisioned")
            }
            Self::SealedSkills => {
                formatter.write_str("sealed skill store could not be constructed")
            }
            Self::SealedAgents => {
                formatter.write_str("sealed agent store could not be constructed")
            }
            Self::Matcha(error) => error.fmt(formatter),
            Self::OpenClaw(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for ConstructionError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Diagnostics(error) => Some(error),
            Self::ParentCallback(error) => Some(error),
            Self::TeamSkillSelection
            | Self::ProviderAccounts
            | Self::ProviderMigration
            | Self::ProviderModels
            | Self::ProviderRouting
            | Self::ExternalConnectors
            | Self::Fleet
            | Self::Settings
            | Self::Security
            | Self::RuntimeState
            | Self::SealedSkills
            | Self::SealedAgents => None,
            Self::Matcha(error) => Some(error),
            Self::OpenClaw(error) => Some(error),
        }
    }
}

#[cfg(test)]
mod tests;
