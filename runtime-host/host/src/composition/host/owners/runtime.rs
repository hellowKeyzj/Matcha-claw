use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

use foundation::{
    execution::{OwnedTask, OwnerRuntimeSystem},
    lifecycle::{EffectRegistration, ModuleScope, ScopedEffectKind},
};
use platform::state_dir::CanonicalStateDir;

use ::cron::CronModule;
use ::diagnostics::DiagnosticsModule;
use channels::{ChannelModule, ChannelOwnerInput};
use connectors::ConnectorModule;
use platform_tools::PlatformToolsModule;
use subagents::SubagentsModule;
use task_manager::TaskModule;
use toolchain::ToolchainModule;
use usage::UsageModule;
use wiki::WikiModule;
use workspace::WorkspaceModule;

use crate::composition::runtime_ports::{RuntimeDriver, RuntimeDriverIdentity};
use provider_module::ProviderModule;
use sessions_module::{SessionHandle, SessionModule, SessionOwnerInput};

use super::super::ConstructionError;

type FleetModule = ::fleet::FleetModule;
type FleetHandle = ::fleet::FleetHandle;
type OrganizationModule = organization::OrganizationModule;

pub(in crate::composition::host) struct OwnerRuntimeTasks {
    pub(in crate::composition::host) system: OwnerRuntimeSystem,
    provider_system: OwnerRuntimeSystem,
    pub(in crate::composition::host) peer: OwnedTask<()>,
    pub(in crate::composition::host) module_scopes: Vec<ModuleScope>,
    organization_calls: OrganizationModule,
    wiki_calls: wiki::WikiHandle,
    join_failures: Arc<Mutex<Vec<&'static str>>>,
    pub(in crate::composition::host) organization: OrganizationRuntime,
    closed: bool,
}

pub(in crate::composition::host) struct OrganizationRuntime {
    scope: ModuleScope,
    pub(in crate::composition::host) coordinator: organization::TeamRunCoordinator,
}

impl OrganizationRuntime {
    async fn dispose_after_session(&mut self) {
        self.scope.dispose_all_lifo().await;
    }
}

impl OwnerRuntimeTasks {
    pub(in crate::composition::host) fn join_failures(&self) -> Arc<Mutex<Vec<&'static str>>> {
        Arc::clone(&self.join_failures)
    }

    pub(in crate::composition::host) fn module_effect_registrations(
        &self,
    ) -> Vec<EffectRegistration> {
        self.module_scopes
            .iter()
            .chain(std::iter::once(&self.organization.scope))
            .flat_map(|scope| scope.effect_registrations().iter().copied())
            .collect()
    }

    pub(in crate::composition::host) async fn drain_and_join(&mut self) {
        if self.closed {
            return;
        }
        self.organization_calls.shutdown_call_workflows().await;
        self.wiki_calls.shutdown_call_workflows().await;
        self.dispose_module_scope("skills").await;
        self.dispose_module_scope("plugins").await;
        self.organization.coordinator.cancel();
        let _ = self.organization.coordinator.join().await;
        for scope in self
            .module_scopes
            .iter_mut()
            .rev()
            .filter(|scope| !is_runtime_dependency_scope(scope.id()))
        {
            scope.dispose_all_lifo().await;
        }
        if self.peer.drain_and_join().await.is_err() {
            record_join_failure(&self.join_failures, "peer");
        }
        self.dispose_module_scope("settings").await;
        self.dispose_module_scope("security").await;
        self.dispose_module_scope("sessions").await;
        self.dispose_module_scope("provider").await;
        if self.provider_system.drain_and_join().await.is_err() {
            record_join_failure(&self.join_failures, "provider-runtime-system");
        }
        self.organization.dispose_after_session().await;
        self.dispose_module_scope("runtime-directory").await;
        if self.system.drain_and_join().await.is_err() {
            record_join_failure(&self.join_failures, "owner-runtime-system");
        }
        self.closed = true;
    }

    pub(in crate::composition::host) fn module_scope_mut(
        &mut self,
        module_id: &'static str,
    ) -> Option<&mut ModuleScope> {
        self.module_scopes
            .iter_mut()
            .find(|scope| scope.id() == module_id)
    }

    pub(in crate::composition::host) fn route_scope_mut(
        &mut self,
        module_id: &'static str,
    ) -> Option<&mut ModuleScope> {
        if module_id == "organization" {
            return Some(&mut self.organization.scope);
        }
        self.module_scope_mut(module_id)
    }

    async fn dispose_module_scope(&mut self, module_id: &'static str) {
        if let Some(scope) = self
            .module_scopes
            .iter_mut()
            .find(|scope| scope.id() == module_id)
        {
            scope.dispose_all_lifo().await;
        }
    }
}

fn is_runtime_dependency_scope(module_id: &'static str) -> bool {
    matches!(
        module_id,
        "provider" | "sessions" | "settings" | "security" | "runtime-directory"
    )
}

fn record_join_failure(failures: &Mutex<Vec<&'static str>>, owner: &'static str) {
    failures
        .lock()
        .expect("owner join failure state lock poisoned")
        .push(owner);
}

fn runtime_directory_scope(
    runtime_directory: Arc<crate::composition::runtime_ports::RuntimeDriverDirectory>,
) -> ModuleScope {
    let mut scope = ModuleScope::new("runtime-directory");
    scope.register_runtime_endpoint("runtime-endpoint", move || async move {
        runtime_directory.close_runtime_endpoint();
    });
    scope
}

fn route_only_scope(id: &'static str) -> ModuleScope {
    ModuleScope::new(id)
}

fn capability_catalog_scope() -> ModuleScope {
    route_only_scope("capability-catalog")
}

pub(in crate::composition::host) struct RuntimeOwners {
    pub(in crate::composition::host) tasks: OwnerRuntimeTasks,
    pub(in crate::composition::host) runtime_directory:
        Arc<crate::composition::runtime_ports::RuntimeDriverDirectory>,
    pub(in crate::composition::host) peer_startup: crate::composition::peer::PeerStartupState,
    pub(in crate::composition::host) peer_handle: crate::composition::peer::PeerHandle,
    pub(in crate::composition::host) session_module: SessionModule,
    pub(in crate::composition::host) session_handle: SessionHandle,
    pub(in crate::composition::host) provider_module: ProviderModule,
    pub(in crate::composition::host) settings: settings::SettingsModule,
    pub(in crate::composition::host) connector: ConnectorModule,
    pub(in crate::composition::host) cron: CronModule,
    pub(in crate::composition::host) usage: UsageModule,
    pub(in crate::composition::host) diagnostics: DiagnosticsModule,
    pub(in crate::composition::host) task_manager: TaskModule,
    pub(in crate::composition::host) subagents: SubagentsModule,
    pub(in crate::composition::host) workspace: WorkspaceModule,
    pub(in crate::composition::host) wiki: WikiModule,
    pub(in crate::composition::host) toolchain: ToolchainModule,
    pub(in crate::composition::host) platform_tools: PlatformToolsModule,
    pub(in crate::composition::host) security: security::SecurityModule,
    pub(in crate::composition::host) channel: ChannelModule,
    pub(in crate::composition::host) fleet_handle: FleetHandle,
    pub(in crate::composition::host) fleet_module: FleetModule,
    pub(in crate::composition::host) organization_module: OrganizationModule,
    pub(in crate::composition::host) organization_handle: organization::OrganizationHandle,
    pub(in crate::composition::host) start_gate_registry:
        std::sync::Arc<organization::StartGateRegistry>,
}

pub(in crate::composition::host) struct RuntimeOwnerInput {
    pub(in crate::composition::host) calls: platform::call::CallRecorder,
    pub(in crate::composition::host) organization:
        super::super::resources::OrganizationOwnerProvision,
    pub(in crate::composition::host) runtime_state_dir: std::path::PathBuf,
    pub(in crate::composition::host) diagnostics_state_root: CanonicalStateDir,
    pub(in crate::composition::host) runtime_host_mcp_executable: std::path::PathBuf,
    pub(in crate::composition::host) runtime_host_mcp_state_dir: std::path::PathBuf,
    pub(in crate::composition::host) provider_cascade: provider_module::ProviderCascade,
    pub(in crate::composition::host) fleet_private_root: std::path::PathBuf,
    pub(in crate::composition::host) matcha_startup_diagnostics:
        ::diagnostics::RuntimeStartupDiagnostics,
    pub(in crate::composition::host) openclaw_startup_diagnostics:
        ::diagnostics::RuntimeStartupDiagnostics,
    pub(in crate::composition::host) runtime_observation: ::diagnostics::RuntimeFlightRecorder,
    pub(in crate::composition::host) diagnostics: ::diagnostics::DiagnosticsArchiveProducer,
    pub(in crate::composition::host) toolchain: Arc<toolchain::NativeToolchain>,
    pub(in crate::composition::host) open_claw: Arc<openclaw::driver::OpenClawDriver>,
    pub(in crate::composition::host) matcha_driver: Arc<dyn RuntimeDriver>,
    pub(in crate::composition::host) admission: Arc<crate::composition::admission::HostAdmission>,
    pub(in crate::composition::host) sealed_resource: sealed_resource::SealedResourceModule,
    pub(in crate::composition::host) session_delta: Option<sessions_module::SessionDeltaSource>,
    pub(in crate::composition::host) open_claw_runtime: Option<tokio::sync::mpsc::Sender<()>>,
    pub(in crate::composition::host) cron_events:
        Option<tokio::sync::mpsc::Sender<::cron::CronExecutionTerminalEvent>>,
}

pub(in crate::composition::host) fn spawn_runtime_owners(
    owner_input: RuntimeOwnerInput,
) -> Result<RuntimeOwners, ConstructionError> {
    let RuntimeOwnerInput {
        calls,
        organization,
        runtime_state_dir,
        diagnostics_state_root,
        runtime_host_mcp_executable,
        runtime_host_mcp_state_dir,
        provider_cascade,
        fleet_private_root,
        matcha_startup_diagnostics,
        openclaw_startup_diagnostics,
        runtime_observation,
        diagnostics,
        toolchain,
        open_claw,
        matcha_driver,
        admission,
        sealed_resource,
        session_delta,
        open_claw_runtime,
        cron_events,
    } = owner_input;
    let join_failures = Arc::new(Mutex::new(Vec::new()));
    let module_scope = |id: &'static str, mut task: OwnedTask<()>| {
        let mut scope = ModuleScope::new(id);
        let failures = Arc::clone(&join_failures);
        scope.register_effect_disposer(
            ScopedEffectKind::OwnerTask,
            "owner-task",
            move || async move {
                if task.drain_and_join().await.is_err() {
                    record_join_failure(&failures, id);
                }
            },
        );
        scope
    };
    let fleet_owner_input = ::fleet::FleetOwnerInput::new(
        runtime_state_dir.join("fleet-facts.log"),
        fleet_private_root,
        BTreeMap::from([(
            "com.matchaclaw.remote-fleet.managed".to_owned(),
            "true".to_owned(),
        )]),
        BTreeMap::new(),
        64,
        foundation::execution::LaneRetention::LowFrequency,
    );
    let open_claw_driver: Arc<dyn RuntimeDriver> = open_claw.clone();
    let runtime_directory = Arc::new(
        crate::composition::runtime_ports::RuntimeDriverDirectory::fixed_peers(
            open_claw_driver,
            matcha_driver,
        ),
    );
    let owner_runtime_system = OwnerRuntimeSystem::spawn_observed(
        foundation::execution::OwnerRuntimeConfig::new(
            64,
            foundation::execution::LaneRetention::MediumFrequency,
        ),
        runtime_observation.sink(),
    );
    let (fleet_module, fleet_task) = ::fleet::spawn_owner(&owner_runtime_system, fleet_owner_input)
        .map_err(|_| ConstructionError::Fleet)?;
    let fleet_module = fleet_module.with_call_recorder(calls.clone());
    let fleet_handle = fleet_module.handle().clone();
    let (security, security_task) = security::spawn_owner(
        &owner_runtime_system,
        security::SecurityOwnerInput {
            state_dir: diagnostics_state_root.as_path().to_path_buf(),
            runtime_directory: runtime_directory.clone(),
        },
    )
    .map_err(|_| ConstructionError::Security)?;
    let security = security.with_call_recorder(calls.clone());
    let channel_endpoint = RuntimeDriverIdentity::open_claw().endpoint();
    let (channel, channel_task) = channels::spawn_owner(
        &owner_runtime_system,
        ChannelOwnerInput {
            runtime_directory: runtime_directory.clone(),
            default_endpoint: channel_endpoint.clone(),
        },
    );

    let channel = channel.with_call_recorder(calls.clone());
    let (connector, connector_task) = connectors::spawn_owner(
        &owner_runtime_system,
        connectors::ConnectorOwnerInput {
            state_dir: diagnostics_state_root.as_path().to_path_buf(),
            runtime_directory: runtime_directory.clone(),
            runtime_host_mcp_executable,
            runtime_host_mcp_state_dir,
        },
    )
    .map_err(|_| ConstructionError::ExternalConnectors)?;
    let connector = connector.with_call_recorder(calls.clone());

    let (settings, settings_task) = settings::spawn_owner(
        &owner_runtime_system,
        settings::SettingsOwnerInput {
            state_dir: diagnostics_state_root.as_path().to_path_buf(),
            runtime_directory: runtime_directory.clone(),
        },
    )
    .map_err(|_| ConstructionError::Settings)?;
    let settings = settings.with_call_recorder(calls.clone());

    let provider_system = OwnerRuntimeSystem::spawn_observed(
        foundation::execution::OwnerRuntimeConfig {
            mailbox_capacity: 64,
            worker_count: 4,
            ready_queue_capacity: 8,
            ..foundation::execution::OwnerRuntimeConfig::default()
        },
        runtime_observation.sink(),
    );
    let (provider_module, provider_task) = provider_module::spawn_owner(
        &provider_system,
        provider_module::ProviderOwnerInput {
            cascade: provider_cascade,
            runtime_directory: runtime_directory.clone(),
        },
    );
    let provider_module = provider_module.with_call_recorder(calls.clone());
    let provider_handle = provider_module.handle().clone();

    let (organization_module, organization_task) = organization::spawn_owner(
        &owner_runtime_system,
        organization.into_owner_input(
            runtime_directory.clone() as Arc<dyn organization::OrganizationRuntimeDirectory>,
            Arc::new(super::super::ports::ProviderTeamMemberIntroductions::new(
                provider_handle.clone(),
            )),
        ),
    );
    let organization_module = organization_module.with_call_recorder(calls.clone());
    let organization_handle = organization_module.handle().clone();
    let mut organization_scope = module_scope("organization", organization_task);

    let session_terminal = Arc::new(
        super::super::ports::organization::OrganizationSessionTerminal::start(
            organization_handle.clone(),
            runtime_observation.sink(),
        ),
    );
    let session_terminal_scope = Arc::clone(&session_terminal);
    organization_scope.register_event_subscription("sessions.run-terminal", move || async move {
        let _ = session_terminal_scope.close_and_join().await;
    });
    let start_gate_registry = session_terminal.start_gate_registry();

    let (session_module, session_task) = sessions_module::spawn_owner(
        &owner_runtime_system,
        SessionOwnerInput {
            runtime_directory: Arc::clone(&runtime_directory)
                as Arc<dyn sessions_module::SessionRuntimeDirectory>,
            provider_handle: provider_handle.clone(),
            ownership_reader: Arc::new(
                super::super::ports::organization::OrganizationSessionOwnership::new(
                    organization_handle.clone(),
                    Arc::clone(&runtime_directory),
                ),
            ),
            session_delta,
            terminal_hook: Some(
                Arc::clone(&session_terminal) as Arc<dyn sessions_module::SessionTerminalHook>
            ),
        },
    );
    let session_module = session_module.with_call_recorder(calls.clone());
    let session_handle = session_module.handle().clone();
    session_terminal.bind_repair_session(super::super::ports::organization::repair_port(
        session_handle.clone(),
    ));

    let (cron, cron_task) = ::cron::spawn_owner(
        &owner_runtime_system,
        ::cron::CronOwnerInput {
            admission: admission.clone(),
            runtime_directory: runtime_directory.clone(),
            session_history: Arc::new(super::super::ports::CronSessionHistory::new(
                session_handle.clone(),
            )),
            events: cron_events,
            observation: runtime_observation.sink(),
        },
    );
    let cron = cron.with_call_recorder(calls.clone());
    let (usage, usage_task) = usage::spawn_owner(
        &owner_runtime_system,
        usage::UsageOwnerInput {
            admission: admission.clone(),
            runtime_directory: runtime_directory.clone(),
        },
    );
    let usage = usage.with_call_recorder(calls.clone());
    let (task_manager, task_manager_task) = task_manager::spawn_owner(
        &owner_runtime_system,
        task_manager::TaskOwnerInput {
            admission: admission.clone(),
            runtime_directory: runtime_directory.clone(),
        },
    );
    let task_manager = task_manager.with_call_recorder(calls.clone());
    let sealed_agents = sealed_resource.agents_port();
    let (subagents, subagents_task) = subagents::spawn_owner(
        &owner_runtime_system,
        subagents::SubagentOwnerInput {
            admission: admission.clone(),
            runtime_directory: runtime_directory.clone(),
            sealed_agents,
        },
    );
    let subagents = subagents.with_call_recorder(calls.clone());
    let (workspace, workspace_task) = workspace::spawn_owner(
        &owner_runtime_system,
        workspace::WorkspaceOwnerInput {
            admission: admission.clone(),
            runtime_directory: runtime_directory.clone(),
        },
    );
    let vector_index =
        Arc::new(wiki::index::LanceWikiVectorIndex::new().map_err(|_| ConstructionError::Wiki)?)
            as Arc<dyn wiki::index::WikiVectorIndex>;
    let (wiki, wiki_task) = wiki::spawn_owner(
        &owner_runtime_system,
        wiki::WikiOwnerInput::new(runtime_state_dir.clone())
            .with_vector_index(Some(vector_index))
            .with_ingest_llm(Some(Arc::new(
                super::super::ports::ProviderWikiIngestLlm::new(provider_handle.clone()),
            ))),
    )
    .map_err(|_| ConstructionError::Wiki)?;
    let wiki = wiki.with_call_recorder(calls.clone());
    let (toolchain, toolchain_task) = toolchain::spawn_owner(
        &owner_runtime_system,
        toolchain::ToolchainOwnerInput {
            admission: admission.clone(),
            toolchain,
        },
    );
    let toolchain = toolchain.with_call_recorder(calls.clone());
    let platform_tools_ops: Arc<dyn platform_tools::PlatformToolsOps> = open_claw.clone();
    let (platform_tools, platform_tools_task) = platform_tools::spawn_owner(
        &owner_runtime_system,
        platform_tools::PlatformToolsOwnerInput {
            admission: admission.clone(),
            tools: platform_tools_ops,
        },
    );

    let platform_tools = platform_tools.with_call_recorder(calls.clone());
    let activity_executor = Arc::new(super::super::ports::organization::TeamSessionExecutor::new(
        Arc::clone(&admission),
        session_handle.clone(),
        Arc::clone(&runtime_directory),
    ));
    let (admission_changes_tx, admission_changes) =
        tokio::sync::watch::channel(organization::AdmissionState::Changed);
    drop(admission_changes_tx);
    let (team_run_coordinator, team_run_coordinator_handle) =
        organization::TeamRunCoordinator::spawn(organization::TeamRunCoordinatorInput {
            admission: admission.clone() as Arc<dyn organization::TeamRunAdmission>,
            organization: organization_handle.clone(),
            activity_executor,
            admission_changes,
            observation: runtime_observation.sink(),
        });

    let peer_startup = crate::composition::peer::PeerStartupState::new();
    let peer_owner = crate::composition::peer::PeerOwner::new(
        Arc::clone(&admission),
        matcha_startup_diagnostics.clone(),
        Arc::clone(&open_claw),
        openclaw_startup_diagnostics.clone(),
        provider_handle.clone(),
        settings.clone(),
        security.clone(),
        team_run_coordinator_handle.clone(),
        organization_handle.clone(),
        Arc::clone(&runtime_directory),
        open_claw_runtime,
        peer_startup.clone(),
    );
    let (peer_owner_handle, peer_task) = owner_runtime_system.spawn_owner(
        peer_owner,
        foundation::execution::OwnerRuntimeConfig::new(
            64,
            crate::composition::peer::PeerOwner::lane_retention(),
        ),
    );
    let peer_handle =
        crate::composition::peer::PeerHandle::new(peer_owner_handle, Arc::clone(&admission), Arc::clone(&runtime_directory));
    let (diagnostics, diagnostics_task) = ::diagnostics::spawn_owner(
        &owner_runtime_system,
        ::diagnostics::DiagnosticsOwnerInput {
            admission: admission.clone(),
            archive: Arc::new(super::super::ports::HostDiagnosticsArchive::new(
                admission.clone(),
                diagnostics,
                peer_handle.clone(),
            )),
        },
    );

    let diagnostics = diagnostics.with_call_recorder(calls.clone());
    let workspace = workspace.with_call_recorder(calls);
    Ok(RuntimeOwners {
        tasks: OwnerRuntimeTasks {
            system: owner_runtime_system,
            provider_system,
            peer: peer_task,
            module_scopes: vec![
                module_scope("provider", provider_task),
                module_scope("sessions", session_task),
                module_scope("fleet", fleet_task),
                module_scope("security", security_task),
                module_scope("channel", channel_task),
                module_scope("connectors", connector_task),
                module_scope("settings", settings_task),
                module_scope("cron", cron_task),
                module_scope("usage", usage_task),
                module_scope("diagnostics", diagnostics_task),
                runtime_directory_scope(Arc::clone(&runtime_directory)),
                route_only_scope("runtime-control"),
                capability_catalog_scope(),
                route_only_scope("openclaw-gateway"),
                route_only_scope("openclaw-platform"),
                module_scope("task-manager", task_manager_task),
                module_scope("subagents", subagents_task),
                module_scope("workspace", workspace_task),
                module_scope("wiki", wiki_task),
                module_scope("toolchain", toolchain_task),
                module_scope("platform-tools", platform_tools_task),
                route_only_scope("plugins"),
                route_only_scope("sealed-resource"),
                route_only_scope("skills"),
            ],
            organization_calls: organization_module.clone(),
            wiki_calls: wiki.handle().clone(),
            join_failures,
            organization: OrganizationRuntime {
                scope: organization_scope,
                coordinator: team_run_coordinator,
            },
            closed: false,
        },
        runtime_directory,
        peer_startup,
        peer_handle,
        session_module,
        session_handle,
        provider_module,
        settings,
        connector,
        cron,
        usage,
        diagnostics,
        task_manager,
        subagents,
        workspace,
        wiki,
        toolchain,
        platform_tools,
        security,
        channel,
        fleet_handle,
        fleet_module,
        organization_module,
        organization_handle,
        start_gate_registry,
    })
}
