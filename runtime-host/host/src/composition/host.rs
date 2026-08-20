use std::{
    collections::{BTreeMap, BTreeSet},
    fmt, fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use crate::runtime_driver::{
    ChannelOps, CronOps, LifecycleOps, OwnedRuntimeFuture, ProviderNativeConfigurationCommand,
    RuntimeDriver, RuntimeDriverIdentity, RuntimeOperationFailure, SessionOps, SkillOps,
    SubagentOps, TaskOps, TeamOps, WorkspaceOps,
};
use crate::transport::session_trace;
use environment::{
    ProviderAccountStore, ProviderCascade, ProviderModelCapability, ProviderModelStore,
    ProviderRoutingStore, migrate_provider_legacy_stores,
};
use foundation::{
    execution::OperationHandle,
    process::supervision::{
        RestartOutcome, StartOutcome, SupervisorOperation, SupervisorPhase, SupervisorSnapshot,
        TerminationCompletion,
    },
};
use matcha_agent::{
    lifecycle::secret::Secret,
    peer::{LifecycleError as MatchaLifecycleError, MatchaPeer, RoleTerminalWatch},
    session::{
        model::{RunId as MatchaRunId, SessionId as MatchaSessionId},
        receipt::TerminalRunStatus,
        role::{RoleRunId, RoleSessionId},
    },
};
use openclaw::{
    gateway::auth::GatewaySecret,
    port::{
        AppliedStatus, CanonicalIngressResult, ObservedStatus, OpenClawSessionError,
        ProviderNativeConfigurationDiagnostic, ProviderNativeConfigurationEffect,
        ProviderNativeConfigurationEvidence,
    },
    session::{
        events::TerminalOutcome,
        projection::{CanonicalRecoveryReason, CanonicalSessionChange},
        protocol::{
            ChatAbortParams, ChatAbortResult, ChatHistoryParams, ChatHistoryResult, ChatSendParams,
            ChatSendResult, MessageActivityLifecycle, SessionsListParams, SessionsListResult,
            ToolActivityPhase,
        },
    },
};
use platform::exchange::InvocationOutcome;

use crate::diagnostics::{
    DiagnosticsArchiveError, DiagnosticsArchiveProducer, DiagnosticsArchiveRoot, HostState,
    MatchaStartupDiagnostics, OpenClawStartupDiagnostics, RuntimeState,
};
use crate::plugin::{
    Catalog as PluginCatalog, ConfigurationOutcome as PluginConfigurationOutcome,
    Operation as PluginOperation, OperationOutcome as PluginOperationOutcome, PluginError,
    Runtime as PluginRuntime,
};
use organization::{
    DeliveryClaim, DeliveryId, DeliveryPhase, GraphDefinition, GraphPatch, GraphRunLifecycleState,
    IdempotencyKey, MaterializationRecordOutcome, OrganizationStore, RecoveryQueryError,
    RoleChatAdmission, RunCommand, RuntimeEndpointReference, StoreFault, TeamDecisionCommand,
    TeamDecisionReceipt, TeamGraphContextQuery, TeamGraphContextResult, TeamId, TeamNodeEvent,
    TeamNodeEventOutcome, TeamRunQueryOutcome, TeamRunRecoveryPlan, TeamTriggerFireOutcome,
    TeamTriggerFireRequest, TriggerFireRequest,
    package::{
        TeamSkillDependencyCatalog, TeamSkillDependencyPlanResult, TeamSkillPackageValidation,
        TeamSkillSelectionError, TeamSkillSelectionId, TeamSkillSelectionResolver,
    },
    run::scheduler::{NodePromptRetryDueQuery, NodePromptRetryDueQueryOutcome},
};

use crate::{
    external_connectors::Owner as ExternalConnectorOwner,
    fleet::owner::FleetOwner,
    parent_callback::{
        ParentCallbackClient, ParentCallbackConfigError, ParentGatewayEventName,
        ParentRuntimeJobEventName,
    },
    peer_directory::HostRuntimeDirectory,
    provider_accounts::ProviderAccountsOwner,
    provider_models::ProviderModelOwner,
    provider_routing::ProviderRoutingOwner,
    session_abort::{SessionAbortCommand, SessionAbortOutcome},
    session_approval::{
        PendingApprovalsCommand, PendingApprovalsOutcome, SessionApprovalCommand,
        SessionApprovalOutcome,
    },
    session_create::{SessionCreateCommand, SessionCreateOutcome},
    session_delete::{SessionDeleteCommand, SessionDeleteOutcome},
    session_model_selection::{
        ResolvedSessionModelSelection, SessionModelSelectionBinding, SessionModelSelectionCommand,
        SessionModelSelectionOutcome, SessionModelSelectionRejection,
    },
    session_rename::{SessionRenameCommand, SessionRenameOutcome},
    session_send::{SessionSendCommand, SessionSendOutcome},
    session_state::{
        ItemStatus, RecoveryReason, RunPhase, SessionApplyRejection, SessionApplyResult,
        SessionChange, SessionIdentity, SessionProvider, SessionSourceBinding, SessionState,
        SessionView, ToolPhase, ToolView,
    },
    skill_install::{Command as SkillInstallCommand, Outcome as SkillInstallOutcome},
    skill_management::{Command as SkillManagementCommand, Outcome as SkillManagementOutcome},
};

use super::{
    TeamMaterializationCommandOutcome,
    admission::{
        HostAdmission, HostState as AdmissionState, HostTransitionError, RequestAdmissionClosed,
    },
    events::{self, EventSinks, HostEvents},
    matcha::{
        ConstructionError as MatchaConstructionError, MatchaAgentInput, MatchaAgentInstance,
        build_peer,
    },
    openclaw::{
        ConstructionError as OpenClawConstructionError, ControlLease,
        OpenClawGatewayHealthObservation, OpenClawGatewayStatusObservation, OpenClawInput,
        OpenClawInstance,
    },
    openclaw_plugin::OpenClawPluginProvider,
    owner::{
        SupervisorLifecycleFailureKind, SupervisorRestart, SupervisorStart,
        SupervisorStartFailureKind,
    },
    review::{
        ReviewDispatchInput, ReviewDispatchPreparation, ReviewResolutionInput,
        prepare_review_dispatch,
    },
    session::RuntimeSessionError,
    team::{self, ManualTeamCreateOutcome},
    team_run::{
        MatchaDeliveryError, MatchaDeliveryOutcome, MatchaDeliveryStartOutcome,
        MatchaTerminalObservationError, MatchaTerminalObservationOutcome, OpenClawDeliveryError,
        OpenClawDeliveryOutcome, OpenClawDeliveryStart, TeamRunCommandOutcome, TeamRunOwner,
        TeamRunTriggerOutcome,
    },
    team_trigger::TeamTriggerFireResolution,
};

mod shutdown;

const CRON_OPERATION_CAPACITY: usize = 32;
const PARENT_EVENT_OPERATION_CAPACITY: usize = 128;
const FLEET_OPERATION_CAPACITY: usize = 32;
const PEER_LIFECYCLE_OPERATION_CAPACITY: usize = 8;

struct CronOperation {
    job_id: String,
    run_id: String,
    operation: OperationHandle<openclaw::port::CronExecutionStatus>,
}

struct FleetOperation<T> {
    operation: OperationHandle<Result<T, fleet::FleetDeliveryError>>,
}

struct PeerLifecycleOperation {
    operation: OperationHandle<PeerLifecycleCompletion>,
}

struct PeerLifecycleCompletion {
    matcha_start: Option<Result<StartOutcome, MatchaLifecycleError>>,
    open_claw_start: Option<Result<SupervisorStart, SupervisorStartFailureKind>>,
    refresh_organization_store: bool,
}

impl PeerLifecycleCompletion {
    const fn none() -> Self {
        Self {
            matcha_start: None,
            open_claw_start: None,
            refresh_organization_store: false,
        }
    }
}

struct MatchaRendererEventTask {
    session_key: String,
    run_id: String,
    route_key: String,
    trace_id: Option<String>,
    task: tokio::task::JoinHandle<()>,
}

enum MatchaRendererSubscription {
    Existing,
    Started(tokio::task::JoinHandle<()>),
}

struct ParentEventOperation {
    operation: OperationHandle<()>,
}

pub(crate) struct ChannelLoginWaitOperation {
    pub(crate) channel: String,
    pub(crate) account_id: Option<String>,
    pub(crate) operation: OperationHandle<crate::channel_login::Outcome>,
}

pub(crate) struct ChannelLoginWaitCompletion {
    pub(crate) outcome: crate::channel_login::Outcome,
}

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
}

pub struct Host {
    pub(crate) admission: HostAdmission,
    pub(crate) parent_callback: ParentCallbackClient,
    pub(crate) session_states: BTreeMap<String, SessionState>,
    pub(crate) session_epoch: u64,
    matcha: MatchaAgentInstance,
    open_claw: OpenClawInstance,
    matcha_start: Option<Result<StartOutcome, MatchaLifecycleError>>,
    session_trace_ids: BTreeMap<(String, String), String>,
    matcha_renderer_event_tasks: Vec<MatchaRendererEventTask>,
    cron_operations: Vec<CronOperation>,
    parent_event_operations: Vec<ParentEventOperation>,
    fleet_connection_operations:
        Vec<FleetOperation<crate::fleet::lifecycle::FleetConnectionLifecycleOutcome>>,
    fleet_lifecycle_operations: Vec<FleetOperation<crate::fleet::lifecycle::FleetLifecycleOutcome>>,
    fleet_dispatch_operations: Vec<FleetOperation<crate::fleet::owner::FleetDispatchResult>>,
    fleet_resource_registration_operations:
        Vec<FleetOperation<fleet::environment::ManagedResourceMutation>>,
    peer_lifecycle_operations: Vec<PeerLifecycleOperation>,
    open_claw_start: Option<Result<SupervisorStart, SupervisorStartFailureKind>>,
    event_sinks: EventSinks,
    matcha_startup_diagnostics: MatchaStartupDiagnostics,
    openclaw_startup_diagnostics: OpenClawStartupDiagnostics,
    pub(crate) provider_accounts: ProviderAccountsOwner,
    pub(crate) provider_models: ProviderModelOwner,
    pub(crate) provider_routing: ProviderRoutingOwner,
    pub(crate) external_connectors: ExternalConnectorOwner,
    fleet: FleetOwner,
    organization_store: OrganizationStore,
    team_run: TeamRunOwner,
    team_skill_selections: TeamSkillSelectionResolver,
    pending_channel_login_configs: BTreeMap<(String, Option<String>), zeroize::Zeroizing<Vec<u8>>>,
    diagnostics: DiagnosticsArchiveProducer,
    shutdown_failures: shutdown::ShutdownState,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ControlLeaseProjection {
    Unavailable,
    ProbeGateway,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RuntimeReadinessFailure {
    Unsupported,
    Unavailable,
}

impl Host {
    pub fn new(input: HostInput) -> Result<(Self, HostEvents), ConstructionError> {
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
        let runtime_state_dir = input.runtime_state_dir;
        let mut openclaw_input = input.open_claw;
        openclaw_input.report_diagnostic = report_openclaw_diagnostic;
        let open_claw = OpenClawInstance::prepare(openclaw_input, input.open_claw_secret)
            .map_err(ConstructionError::OpenClaw)?;
        fs::create_dir_all(&runtime_state_dir).map_err(|_| ConstructionError::RuntimeState)?;
        let fleet_private_root_path = runtime_state_dir.join("fleet-private");
        let matcha = build_peer(input.matcha, input.matcha_secret, report_matcha_diagnostic)
            .map_err(ConstructionError::Matcha)?;
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
        let provider_models = ProviderModelStore::open(models_path.clone())
            .map_err(|_| ConstructionError::ProviderModels)?;
        let provider_routing = ProviderRoutingStore::open(
            diagnostics_state_root
                .as_path()
                .join("matchaclaw-capability-routing.json"),
        )
        .map_err(|_| ConstructionError::ProviderRouting)?;
        let provider_accounts = ProviderAccountsOwner::new(
            ProviderCascade::open(
                accounts_path.clone(),
                models_path.clone(),
                routing_path.clone(),
                diagnostics_state_root
                    .as_path()
                    .join("provider-cascade.v1.json"),
            )
            .map_err(|_| ConstructionError::ProviderAccounts)?,
            crate::transport::provider_accounts::private_auth::Resolver::disabled(),
        );
        let provider_routing = ProviderRoutingOwner::new(
            ProviderAccountStore::open(accounts_path.clone())
                .map_err(|_| ConstructionError::ProviderRouting)?,
            ProviderModelStore::open(models_path.clone())
                .map_err(|_| ConstructionError::ProviderRouting)?,
            provider_routing,
        );
        let provider_models = ProviderModelOwner::new(
            ProviderAccountStore::open(accounts_path.clone())
                .map_err(|_| ConstructionError::ProviderModels)?,
            provider_models,
        );
        let external_connectors = ExternalConnectorOwner::open(diagnostics_state_root.clone())
            .map_err(|_| ConstructionError::ExternalConnectors)?;
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
        let diagnostics_root =
            DiagnosticsArchiveRoot::provision(diagnostics_state_root.as_path(), input.app_log_dir)
                .map_err(ConstructionError::Diagnostics)?;
        let diagnostics = DiagnosticsArchiveProducer::new(diagnostics_root)
            .map_err(ConstructionError::Diagnostics)?;
        let team_skill_selections = TeamSkillSelectionResolver::open(
            team_skill_selection_registry(diagnostics_state_root.as_path()),
        )
        .map_err(|_| ConstructionError::TeamSkillSelection)?;
        let (event_sinks, events) = events::channels();
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
            .into_instance(open_claw_event_sink, open_claw_canonical_sink)
            .map_err(ConstructionError::OpenClaw)?;
        let open_claw_runtime_readiness = open_claw.control_readiness();
        forward_openclaw_runtime_changes(
            open_claw.owner().subscribe(),
            open_claw_runtime_sink.clone(),
        );
        forward_openclaw_runtime_readiness_changes(
            open_claw_runtime_readiness,
            open_claw_runtime_sink,
        );

        Ok((
            Self {
                admission: HostAdmission::new(),
                parent_callback,
                session_states: BTreeMap::new(),
                session_epoch: 1,
                matcha: MatchaAgentInstance::new(matcha),
                open_claw,
                matcha_start: None,
                session_trace_ids: BTreeMap::new(),
                matcha_renderer_event_tasks: Vec::new(),
                cron_operations: Vec::new(),
                parent_event_operations: Vec::new(),
                fleet_connection_operations: Vec::new(),
                fleet_lifecycle_operations: Vec::new(),
                fleet_dispatch_operations: Vec::new(),
                fleet_resource_registration_operations: Vec::new(),
                peer_lifecycle_operations: Vec::new(),
                open_claw_start: None,
                event_sinks,
                matcha_startup_diagnostics,
                openclaw_startup_diagnostics,
                provider_accounts,
                provider_models,
                provider_routing,
                external_connectors,
                fleet,
                organization_store: input.organization_store,
                team_run: TeamRunOwner::new(),
                team_skill_selections,
                pending_channel_login_configs: BTreeMap::new(),
                diagnostics,
                shutdown_failures: shutdown::ShutdownState::new(),
            },
            events,
        ))
    }

    fn runtime_driver(
        &self,
        endpoint: &platform::endpoint::runtime_address::RuntimeEndpoint,
    ) -> Option<&dyn RuntimeDriver> {
        if *endpoint == self.open_claw.endpoint() {
            Some(&self.open_claw)
        } else if *endpoint == self.matcha.endpoint() {
            Some(&self.matcha)
        } else {
            None
        }
    }

    fn running_runtime_driver(
        &self,
        endpoint: &platform::endpoint::runtime_address::RuntimeEndpoint,
    ) -> Result<&dyn RuntimeDriver, RuntimeReadinessFailure> {
        let driver = self
            .runtime_driver(endpoint)
            .ok_or(RuntimeReadinessFailure::Unsupported)?;
        if driver.lifecycle_ops().is_some_and(LifecycleOps::readiness) {
            Ok(driver)
        } else {
            Err(RuntimeReadinessFailure::Unavailable)
        }
    }

    fn running_session_ops(
        &self,
        endpoint: Option<platform::endpoint::runtime_address::RuntimeEndpoint>,
    ) -> Result<&dyn SessionOps, RuntimeOperationFailure> {
        let endpoint = endpoint.ok_or(RuntimeOperationFailure::Unsupported)?;
        self.running_runtime_driver(&endpoint)
            .map_err(|failure| match failure {
                RuntimeReadinessFailure::Unsupported => RuntimeOperationFailure::Unsupported,
                RuntimeReadinessFailure::Unavailable => RuntimeOperationFailure::Unavailable,
            })?
            .session_ops()
            .ok_or(RuntimeOperationFailure::Unsupported)
    }

    fn running_open_claw_driver(&self) -> Result<&dyn RuntimeDriver, RuntimeOperationFailure> {
        self.running_runtime_driver(&RuntimeDriverIdentity::open_claw().endpoint())
            .map_err(|failure| match failure {
                RuntimeReadinessFailure::Unsupported => RuntimeOperationFailure::Unsupported,
                RuntimeReadinessFailure::Unavailable => RuntimeOperationFailure::Unavailable,
            })
    }

    fn running_cron_ops(&self) -> Result<&dyn CronOps, RuntimeOperationFailure> {
        self.running_open_claw_driver()?
            .cron_ops()
            .ok_or(RuntimeOperationFailure::Unsupported)
    }

    fn running_skill_ops(&self) -> Result<&dyn SkillOps, RuntimeOperationFailure> {
        self.running_open_claw_driver()?
            .skill_ops()
            .ok_or(RuntimeOperationFailure::Unsupported)
    }

    fn running_channel_ops(&self) -> Result<&dyn ChannelOps, RuntimeOperationFailure> {
        self.running_open_claw_driver()?
            .channel_ops()
            .ok_or(RuntimeOperationFailure::Unsupported)
    }

    fn running_task_ops(&self) -> Result<&dyn TaskOps, RuntimeOperationFailure> {
        self.running_open_claw_driver()?
            .task_ops()
            .ok_or(RuntimeOperationFailure::Unsupported)
    }

    fn running_subagent_ops(
        &self,
        endpoint: platform::endpoint::runtime_address::RuntimeEndpoint,
    ) -> Result<&dyn SubagentOps, RuntimeOperationFailure> {
        self.running_runtime_driver(&endpoint)
            .map_err(|failure| match failure {
                RuntimeReadinessFailure::Unsupported => RuntimeOperationFailure::Unsupported,
                RuntimeReadinessFailure::Unavailable => RuntimeOperationFailure::Unavailable,
            })?
            .subagent_ops()
            .ok_or(RuntimeOperationFailure::Unsupported)
    }

    fn running_workspace_ops(&self) -> Result<&dyn WorkspaceOps, RuntimeOperationFailure> {
        self.running_open_claw_driver()?
            .workspace_ops()
            .ok_or(RuntimeOperationFailure::Unsupported)
    }

    fn runtime_driver_for_team_endpoint(
        &self,
        endpoint: &RuntimeEndpointReference,
    ) -> Option<&dyn RuntimeDriver> {
        [&self.open_claw as &dyn RuntimeDriver, &self.matcha]
            .into_iter()
            .find(|driver| driver.identity().runtime_endpoint_reference() == endpoint.as_str())
    }

    fn team_ops_for_endpoint(
        &self,
        endpoint: &RuntimeEndpointReference,
    ) -> Result<&dyn TeamOps, RuntimeOperationFailure> {
        self.runtime_driver_for_team_endpoint(endpoint)
            .ok_or(RuntimeOperationFailure::Unsupported)?
            .team_ops()
            .ok_or(RuntimeOperationFailure::Unsupported)
    }

    fn team_ops_for_bindings(
        &self,
        bindings: &[organization::RoleSessionReceipt],
    ) -> Result<&dyn TeamOps, RuntimeOperationFailure> {
        let first = bindings
            .first()
            .ok_or(RuntimeOperationFailure::Unsupported)?;
        if !bindings
            .iter()
            .all(|binding| binding.endpoint() == first.endpoint())
        {
            return Err(RuntimeOperationFailure::TargetRejected);
        }
        self.team_ops_for_endpoint(first.endpoint())
    }

    /// Applies only private provider desired state before the Gateway is started.
    /// A returned restart preparation is not a health, reload, or terminal receipt.
    pub(crate) fn prepare_openclaw_bootstrap(
        &self,
    ) -> openclaw::bootstrap::PrivateProjectionEffect {
        self.open_claw.prepare_private_projection(
            self.provider_accounts.accounts(),
            self.provider_accounts.catalog(),
            self.provider_accounts.routing(),
        )
    }

    async fn prepare_openclaw_start(&self) -> Result<(), SupervisorStartFailureKind> {
        let _bootstrap = self.prepare_openclaw_bootstrap();
        self.apply_openclaw_prelaunch_projections();
        if self.open_claw_lifecycle_snapshot().phase() != SupervisorPhase::Running {
            openclaw::lifecycle::port_guard::ensure_gateway_port_available(
                self.open_claw.gateway_port(),
            )
            .await
            .map_err(|_| SupervisorStartFailureKind::CompletionFailed)?;
        }
        self.prepare_openclaw_plugin_readiness();
        Ok(())
    }

    fn apply_openclaw_prelaunch_projections(&self) {
        if crate::settings_delivery::apply_prelaunch_projection(
            self.open_claw.state_dir().as_path(),
        )
        .is_err()
        {
            self.report_openclaw_startup_configuration_rejected();
        }
        if crate::security_delivery::Owner::open(self.open_claw.state_dir().as_path())
            .and_then(|owner| owner.saved_runtime_projection())
            .and_then(|projection| {
                projection
                    .apply(self.open_claw.state_dir().clone())
                    .map(|_| ())
                    .map_err(|_| ())
            })
            .is_err()
        {
            self.report_openclaw_startup_configuration_rejected();
        }
    }

    fn prepare_openclaw_plugin_readiness(&self) {
        let plugins = self.open_claw.plugins();
        let enabled_ids = match plugins.catalog() {
            Ok(catalog) => catalog.execution.enabled_plugin_ids,
            Err(_) => {
                self.report_openclaw_startup_configuration_rejected();
                return;
            }
        };
        match plugins.configured_channel_plugin_ids() {
            Ok(ids) if plugins.reconcile_configured_channel_plugins(&ids).is_err() => {
                self.report_openclaw_startup_configuration_rejected();
            }
            Err(_) => self.report_openclaw_startup_configuration_rejected(),
            Ok(_) => {}
        }
        if plugins
            .reconcile_enabled_managed_plugins(&enabled_ids)
            .is_err()
        {
            self.report_openclaw_startup_configuration_rejected();
        }
        if plugins.apply_startup_lifecycle(&enabled_ids).is_err() {
            self.report_openclaw_startup_configuration_rejected();
        }
    }

    fn report_openclaw_startup_configuration_rejected(&self) {
        self.openclaw_startup_diagnostics
            .report(openclaw::lifecycle::logs::LifecycleDiagnosticCategory::ConfigurationRejected);
    }

    /// Re-project durable provider facts before an explicit Gateway restart.
    /// Reuses the same launch preparation as start; provider, settings, security, and plugin
    /// projections are startup readiness materialization, not lifecycle admission gates.
    async fn prepare_openclaw_restart(&self) -> Result<(), ()> {
        self.prepare_openclaw_start().await.map_err(|_| ())
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
        self.admission.publish_ready()
    }

    pub async fn start_with_open_claw(
        &mut self,
        open_claw_auto_start: bool,
    ) -> Result<(), HostTransitionError> {
        self.start_admission_only().await?;
        self.request_peer_autostart(open_claw_auto_start).await;
        Ok(())
    }

    pub async fn request_peer_autostart(&mut self, open_claw_auto_start: bool) {
        let open_claw_start_admitted = if open_claw_auto_start {
            match self.prepare_openclaw_start().await {
                Ok(()) => true,
                Err(error) => {
                    self.open_claw_start = Some(Err(error));
                    false
                }
            }
        } else {
            false
        };
        let matcha_result = self.matcha().request_start().await;
        if let Err(error) = matcha_result {
            self.matcha_start = Some(Err(error));
        }
        if open_claw_start_admitted {
            self.spawn_openclaw_start_operation(None);
        }
    }

    pub async fn start_matcha(
        &mut self,
    ) -> Result<Result<RuntimeState, RuntimeStartFailure>, RequestAdmissionClosed> {
        self.admission.admit_request()?;
        let result = self.matcha().start().await;
        self.matcha_start = Some(result.clone());
        Ok(matcha_runtime_start_result(result).map(|()| self.matcha_state()))
    }

    pub async fn stop_matcha(
        &mut self,
    ) -> Result<Result<RuntimeState, RuntimeLifecycleFailure>, RequestAdmissionClosed> {
        self.admission.admit_request()?;
        self.cancel_matcha_renderer_events();
        let result = self.matcha().stop().await;
        Ok(matcha_runtime_stop_result(result).map(|()| self.matcha_state()))
    }

    pub async fn restart_matcha(
        &mut self,
    ) -> Result<Result<RuntimeState, RuntimeLifecycleFailure>, RequestAdmissionClosed> {
        self.admission.admit_request()?;
        self.cancel_matcha_renderer_events();
        if matches!(
            self.apply_matcha_session_recovery(RecoveryReason::NativeUnavailable),
            SessionApplyResult::Rejected { .. }
        ) {
            return Ok(Err(RuntimeLifecycleFailure::CompletionFailed));
        }
        let result = self.matcha().restart().await;
        Ok(matcha_runtime_restart_result(result).map(|()| self.matcha_state()))
    }

    pub async fn start_open_claw(
        &mut self,
    ) -> Result<Result<(), RuntimeStartFailure>, RequestAdmissionClosed> {
        self.admission.admit_request()?;
        if let Err(error) = self.prepare_openclaw_start().await {
            self.open_claw_start = Some(Err(error));
            return Ok(Err(map_start_failure(error)));
        }
        let result = self.open_claw.owner().start().await;
        self.open_claw_start = Some(result.clone());
        let outcome = runtime_start_result(result);
        if outcome.is_ok() {
            self.recover_team_materialization_receipts().await;
        }
        Ok(outcome)
    }

    pub async fn stop_open_claw(
        &mut self,
    ) -> Result<Result<RuntimeState, RuntimeLifecycleFailure>, RequestAdmissionClosed> {
        self.admission.admit_request()?;
        let result = self.open_claw.owner().stop().await;
        Ok(runtime_stop_result(result).map(|()| self.open_claw_state()))
    }

    pub async fn restart_open_claw(
        &mut self,
    ) -> Result<Result<RuntimeState, RuntimeLifecycleFailure>, RequestAdmissionClosed> {
        self.admission.admit_request()?;
        if self.prepare_openclaw_restart().await.is_err() {
            return Ok(Err(RuntimeLifecycleFailure::CompletionFailed));
        }
        let result = self.open_claw.owner().restart().await;
        let outcome = runtime_restart_result(result).map(|()| self.open_claw_state());
        if outcome.is_ok() {
            self.recover_team_materialization_receipts().await;
        }
        Ok(outcome)
    }

    pub(crate) fn start_matcha_operation(
        &mut self,
        reply: tokio::sync::oneshot::Sender<
            Result<RuntimeState, crate::owner::lifecycle::StartMatchaError>,
        >,
    ) {
        if !self.admit_peer_lifecycle_operation() {
            let _ = reply.send(Err(
                crate::owner::lifecycle::StartMatchaError::AdmissionClosed,
            ));
            return;
        }
        let handle = self.matcha.lifecycle_handle();
        let startup_diagnostic = self.matcha_startup_diagnostics.category().map(Into::into);
        self.spawn_peer_lifecycle_operation(move || async move {
            let result = handle.start().await;
            let completion = result.clone();
            let outcome = matcha_runtime_start_result(result);
            let state = RuntimeState::from_snapshot_with_startup_diagnostic(
                &handle.snapshot(),
                startup_diagnostic,
            );
            let _ = reply.send(
                outcome
                    .map(|()| state)
                    .map_err(|_| crate::owner::lifecycle::StartMatchaError::RuntimeStart),
            );
            PeerLifecycleCompletion {
                matcha_start: Some(completion),
                ..PeerLifecycleCompletion::none()
            }
        });
    }

    pub(crate) fn stop_matcha_operation(
        &mut self,
        reply: tokio::sync::oneshot::Sender<
            Result<RuntimeState, crate::owner::lifecycle::StopMatchaError>,
        >,
    ) {
        if !self.admit_peer_lifecycle_operation() {
            let _ = reply.send(Err(
                crate::owner::lifecycle::StopMatchaError::AdmissionClosed,
            ));
            return;
        }
        self.cancel_matcha_renderer_events();
        let handle = self.matcha.lifecycle_handle();
        let startup_diagnostic = self.matcha_startup_diagnostics.category().map(Into::into);
        self.spawn_peer_lifecycle_operation(move || async move {
            let result = handle.stop().await;
            let state = RuntimeState::from_snapshot_with_startup_diagnostic(
                &handle.snapshot(),
                startup_diagnostic,
            );
            let _ = reply.send(
                matcha_runtime_stop_result(result)
                    .map(|()| state)
                    .map_err(|_| crate::owner::lifecycle::StopMatchaError::RuntimeStop),
            );
            PeerLifecycleCompletion::none()
        });
    }

    pub(crate) fn restart_matcha_operation(
        &mut self,
        reply: tokio::sync::oneshot::Sender<
            Result<RuntimeState, crate::owner::lifecycle::RestartMatchaError>,
        >,
    ) {
        if !self.admit_peer_lifecycle_operation() {
            let _ = reply.send(Err(
                crate::owner::lifecycle::RestartMatchaError::AdmissionClosed,
            ));
            return;
        }
        self.cancel_matcha_renderer_events();
        if matches!(
            self.apply_matcha_session_recovery(RecoveryReason::NativeUnavailable),
            SessionApplyResult::Rejected { .. }
        ) {
            let _ = reply.send(Err(
                crate::owner::lifecycle::RestartMatchaError::RuntimeRestart,
            ));
            return;
        }
        let handle = self.matcha.lifecycle_handle();
        let startup_diagnostic = self.matcha_startup_diagnostics.category().map(Into::into);
        self.spawn_peer_lifecycle_operation(move || async move {
            let result = handle.restart().await;
            let state = RuntimeState::from_snapshot_with_startup_diagnostic(
                &handle.snapshot(),
                startup_diagnostic,
            );
            let _ = reply.send(
                matcha_runtime_restart_result(result)
                    .map(|()| state)
                    .map_err(|_| crate::owner::lifecycle::RestartMatchaError::RuntimeRestart),
            );
            PeerLifecycleCompletion::none()
        });
    }

    pub(crate) fn start_open_claw_operation(
        &mut self,
        reply: tokio::sync::oneshot::Sender<
            Result<RuntimeState, crate::owner::lifecycle::StartOpenClawError>,
        >,
    ) {
        if !self.admit_peer_lifecycle_operation() {
            let _ = reply.send(Err(
                crate::owner::lifecycle::StartOpenClawError::AdmissionClosed,
            ));
            return;
        }
        self.apply_openclaw_prelaunch_projections();
        self.prepare_openclaw_plugin_readiness();
        self.spawn_openclaw_start_operation(Some(reply));
    }

    fn spawn_openclaw_start_operation(
        &mut self,
        reply: Option<
            tokio::sync::oneshot::Sender<
                Result<RuntimeState, crate::owner::lifecycle::StartOpenClawError>,
            >,
        >,
    ) {
        let handle = self.open_claw.owner().lifecycle_handle();
        let startup_diagnostic = self.openclaw_startup_diagnostics.category().map(Into::into);
        let gateway_port = self.open_claw.gateway_port();
        self.spawn_peer_lifecycle_operation(move || async move {
            let result =
                match openclaw::lifecycle::port_guard::ensure_gateway_port_available(gateway_port)
                    .await
                {
                    Ok(_) => handle.start().await,
                    Err(_) => Err(SupervisorStartFailureKind::CompletionFailed),
                };
            let state = RuntimeState::from_snapshot_with_startup_diagnostic(
                &handle.snapshot(),
                startup_diagnostic,
            );
            let outcome = runtime_start_result(result.clone());
            let refresh_organization_store = outcome.is_ok();
            if let Some(reply) = reply {
                let _ = reply.send(
                    outcome
                        .map(|()| state)
                        .map_err(|_| crate::owner::lifecycle::StartOpenClawError::RuntimeStart),
                );
            }
            PeerLifecycleCompletion {
                open_claw_start: Some(result),
                refresh_organization_store,
                ..PeerLifecycleCompletion::none()
            }
        });
    }

    pub(crate) fn stop_open_claw_operation(
        &mut self,
        reply: tokio::sync::oneshot::Sender<
            Result<RuntimeState, crate::owner::lifecycle::StopOpenClawError>,
        >,
    ) {
        if !self.admit_peer_lifecycle_operation() {
            let _ = reply.send(Err(
                crate::owner::lifecycle::StopOpenClawError::AdmissionClosed,
            ));
            return;
        }
        let handle = self.open_claw.owner().lifecycle_handle();
        let startup_diagnostic = self.openclaw_startup_diagnostics.category().map(Into::into);
        self.spawn_peer_lifecycle_operation(move || async move {
            let result = handle.stop().await;
            let state = RuntimeState::from_snapshot_with_startup_diagnostic(
                &handle.snapshot(),
                startup_diagnostic,
            );
            let _ = reply.send(
                runtime_stop_result(result)
                    .map(|()| state)
                    .map_err(|_| crate::owner::lifecycle::StopOpenClawError::RuntimeStop),
            );
            PeerLifecycleCompletion::none()
        });
    }

    pub(crate) fn restart_open_claw_operation(
        &mut self,
        reply: tokio::sync::oneshot::Sender<
            Result<RuntimeState, crate::owner::lifecycle::RestartOpenClawError>,
        >,
    ) {
        if !self.admit_peer_lifecycle_operation() {
            let _ = reply.send(Err(
                crate::owner::lifecycle::RestartOpenClawError::AdmissionClosed,
            ));
            return;
        }
        let handle = self.open_claw.owner().lifecycle_handle();
        let startup_diagnostic = self.openclaw_startup_diagnostics.category().map(Into::into);
        self.apply_openclaw_prelaunch_projections();
        self.prepare_openclaw_plugin_readiness();
        let gateway_port = self.open_claw.gateway_port();
        self.spawn_peer_lifecycle_operation(move || async move {
            let result =
                match openclaw::lifecycle::port_guard::ensure_gateway_port_available(gateway_port)
                    .await
                {
                    Ok(_) => handle.restart().await,
                    Err(_) => Err(SupervisorLifecycleFailureKind::CompletionFailed),
                };
            let state = RuntimeState::from_snapshot_with_startup_diagnostic(
                &handle.snapshot(),
                startup_diagnostic,
            );
            let outcome = runtime_restart_result(result);
            let refresh_organization_store = outcome.is_ok();
            let _ = reply.send(
                outcome
                    .map(|()| state)
                    .map_err(|_| crate::owner::lifecycle::RestartOpenClawError::RuntimeRestart),
            );
            PeerLifecycleCompletion {
                refresh_organization_store,
                ..PeerLifecycleCompletion::none()
            }
        });
    }

    fn admit_peer_lifecycle_operation(&mut self) -> bool {
        if self.admission.admit_request().is_err() {
            return false;
        }
        self.peer_lifecycle_operations
            .iter()
            .filter(|operation| !operation.operation.is_finished())
            .count()
            < PEER_LIFECYCLE_OPERATION_CAPACITY
    }

    fn spawn_peer_lifecycle_operation<F, U>(&mut self, future: F)
    where
        F: FnOnce() -> U + Send + 'static,
        U: std::future::Future<Output = PeerLifecycleCompletion> + Send + 'static,
    {
        let (operation, _) = OperationHandle::spawn(move |_| future());
        self.peer_lifecycle_operations
            .push(PeerLifecycleOperation { operation });
    }

    pub(crate) async fn reap_peer_lifecycle_operations(&mut self) -> bool {
        let mut pending = Vec::with_capacity(self.peer_lifecycle_operations.len());
        let mut refresh_organization_store = false;
        let mut pending_matcha_start = Vec::new();
        let mut pending_open_claw_start = Vec::new();
        let operations = std::mem::take(&mut self.peer_lifecycle_operations);
        for mut operation in operations {
            if !operation.operation.is_finished() {
                pending.push(operation);
                continue;
            }
            let Ok(completion) = operation.operation.join().await else {
                continue;
            };
            if let Some(result) = completion.matcha_start {
                pending_matcha_start.push(result);
            }
            if let Some(result) = completion.open_claw_start {
                pending_open_claw_start.push(result);
            }
            refresh_organization_store |= completion.refresh_organization_store;
        }
        self.peer_lifecycle_operations = pending;
        let lifecycle_changed =
            !pending_matcha_start.is_empty() || !pending_open_claw_start.is_empty();
        for result in pending_matcha_start {
            self.matcha_start = Some(result);
        }
        for result in pending_open_claw_start {
            self.open_claw_start = Some(result);
        }
        if refresh_organization_store {
            self.recover_team_materialization_receipts().await;
        }
        lifecycle_changed
    }

    pub(crate) fn has_peer_lifecycle_operations(&self) -> bool {
        !self.peer_lifecycle_operations.is_empty()
    }

    pub(crate) async fn cancel_peer_lifecycle_operations(&mut self) {
        for operation in &self.peer_lifecycle_operations {
            operation.operation.cancel();
        }
        while let Some(mut operation) = self.peer_lifecycle_operations.pop() {
            let _ = operation.operation.cancel_and_join().await;
        }
    }

    pub(crate) fn open_claw_is_running(&self) -> bool {
        self.open_claw.owner().snapshot().phase() == SupervisorPhase::Running
    }

    pub(crate) fn open_claw_installation_status(
        &self,
    ) -> Option<openclaw::projection::installation::Status> {
        self.open_claw.installation_status()
    }

    pub(crate) fn open_claw_runtime_paths(
        &self,
    ) -> Result<
        openclaw::projection::runtime_paths::RuntimePaths,
        openclaw::projection::runtime_paths::RuntimePathsError,
    > {
        self.admission
            .admit_request()
            .map_err(|_| openclaw::projection::runtime_paths::RuntimePathsError::Unavailable)?;
        self.open_claw.runtime_paths()
    }

    pub(crate) fn open_claw_cli_command(
        &self,
    ) -> Result<
        openclaw::projection::runtime_paths::CliCommand,
        openclaw::projection::runtime_paths::CliCommandError,
    > {
        self.admission
            .admit_request()
            .map_err(|_| openclaw::projection::runtime_paths::CliCommandError::Unavailable)?;
        self.open_claw.cli_command()
    }

    pub(crate) fn open_claw_tool_permission_mode(
        &self,
    ) -> Result<
        openclaw::projection::tool_permission::Mode,
        openclaw::projection::tool_permission::Error,
    > {
        self.admission
            .admit_request()
            .map_err(|_| openclaw::projection::tool_permission::Error::Unavailable)?;
        self.open_claw.tool_permission_mode()
    }

    pub(crate) fn set_open_claw_tool_permission_mode(
        &self,
        mode: openclaw::projection::tool_permission::Mode,
    ) -> Result<
        openclaw::projection::tool_permission::Effect,
        openclaw::projection::tool_permission::Error,
    > {
        self.admission
            .admit_request()
            .map_err(|_| openclaw::projection::tool_permission::Error::Unavailable)?;
        self.open_claw.set_tool_permission_mode(mode)
    }

    pub(crate) async fn open_claw_toolchain_status(
        &self,
    ) -> Result<openclaw::toolchain::ToolchainStatus, RequestAdmissionClosed> {
        self.admission.admit_request()?;
        Ok(self.open_claw.toolchain_status().await)
    }

    pub(crate) async fn install_open_claw_uv(
        &self,
    ) -> Result<openclaw::toolchain::UvInstallOutcome, RequestAdmissionClosed> {
        self.admission.admit_request()?;
        Ok(self.open_claw.install_toolchain_uv().await)
    }

    pub(crate) async fn submit_open_claw_toolchain_install(
        &self,
    ) -> Result<openclaw::toolchain::ToolchainJobSubmission, RequestAdmissionClosed> {
        self.admission.admit_request()?;
        Ok(self.open_claw.submit_toolchain_install().await)
    }

    pub(crate) async fn toolchain_event_state(
        &self,
    ) -> Option<openclaw::toolchain::ToolchainOperationEventState> {
        self.open_claw.toolchain_event_state().await
    }

    pub(crate) async fn settle_open_claw_toolchain_install(
        &self,
        job_id: &str,
    ) -> openclaw::toolchain::ToolchainJobLookup {
        self.open_claw.settle_toolchain_install(job_id).await
    }

    pub(crate) async fn cancel_open_claw_toolchain_install(
        &self,
    ) -> openclaw::toolchain::ToolchainJobLookup {
        self.open_claw.cancel_toolchain_install().await
    }

    pub(crate) async fn get_open_claw_toolchain_job(
        &self,
        job_id: &str,
    ) -> Result<openclaw::toolchain::ToolchainJobLookup, RequestAdmissionClosed> {
        self.admission.admit_request()?;
        Ok(self.open_claw.toolchain_job_get(job_id).await)
    }

    pub(crate) async fn get_compatible_runtime_job(
        &self,
        job_id: &str,
    ) -> Result<crate::projection::job_compatibility::JobCompatibilityLookup, RequestAdmissionClosed>
    {
        self.admission.admit_request()?;
        match crate::projection::job_compatibility::route_job_id(job_id) {
            crate::projection::job_compatibility::JobCompatibilityOwnerRoute::OpenClawToolchain {
                job_id,
            } => Ok(crate::projection::job_compatibility::openclaw_toolchain_lookup(
                self.open_claw.toolchain_job_get(job_id).await,
            )),
            crate::projection::job_compatibility::JobCompatibilityOwnerRoute::Unknown => Ok(
                crate::projection::job_compatibility::JobCompatibilityLookup::unknown(),
            ),
        }
    }

    fn openclaw_plugin_provider(&self) -> OpenClawPluginProvider {
        OpenClawPluginProvider::new(self.open_claw.plugins())
    }

    pub(crate) fn plugins_catalog(&self) -> Result<PluginCatalog, PluginError> {
        self.openclaw_plugin_provider().catalog()
    }

    pub(crate) fn plugins_runtime(&self) -> Result<PluginRuntime, PluginError> {
        self.openclaw_plugin_provider()
            .runtime(self.open_claw_is_running())
    }

    pub(crate) async fn set_plugin_enabled(
        &mut self,
        plugin_id: String,
        enabled: bool,
    ) -> PluginConfigurationOutcome {
        let outcome = self
            .openclaw_plugin_provider()
            .set_enabled(&plugin_id, enabled);
        if outcome != PluginConfigurationOutcome::Configured {
            return outcome;
        }
        match self.restart_open_claw().await {
            Ok(Ok(_)) => outcome,
            Ok(Err(_)) | Err(_) => PluginConfigurationOutcome::Unknown,
        }
    }

    pub(crate) async fn plugin_operation(
        &mut self,
        operation: PluginOperation,
        plugin_id: String,
    ) -> PluginOperationOutcome {
        if self.admission.admit_request().is_err()
            || self.open_claw.owner().snapshot().phase() != SupervisorPhase::Running
        {
            return PluginOperationOutcome::Unknown;
        }
        let provider = self.openclaw_plugin_provider();
        let outcome = provider.operation(operation, &plugin_id);
        if outcome != PluginOperationOutcome::Configured {
            return outcome;
        }
        match self.restart_open_claw().await {
            Ok(Ok(_)) if operation == PluginOperation::Uninstall => {
                provider.finalize_uninstall(&plugin_id)
            }
            Ok(Ok(_)) => PluginOperationOutcome::Configured,
            Ok(Err(_)) | Err(_) => PluginOperationOutcome::Unknown,
        }
    }

    pub(crate) async fn open_claw_logs(
        &self,
        cursor: Option<u64>,
    ) -> Result<crate::composition::OpenClawLogSnapshot, ()> {
        self.admission.admit_request().map_err(|_| ())?;
        self.open_claw.logs(cursor).await
    }

    pub(crate) fn open_claw_gateway_health_observation(
        &self,
        probe: bool,
    ) -> Result<OpenClawGatewayHealthObservation, RequestAdmissionClosed> {
        self.admission.admit_request()?;
        Ok(self.open_claw.gateway_health_observation(probe))
    }

    pub(crate) fn open_claw_gateway_status_observation(
        &self,
        include_channel_summary: bool,
    ) -> Result<OpenClawGatewayStatusObservation, RequestAdmissionClosed> {
        self.admission.admit_request()?;
        Ok(self
            .open_claw
            .gateway_status_observation(include_channel_summary))
    }

    pub(crate) fn open_claw_control_ui_url(&self) -> String {
        self.open_claw.control_ui_url()
    }

    pub(crate) fn list_subagent_templates(
        &self,
    ) -> Result<
        openclaw::projection::subagent_templates::Catalog,
        openclaw::projection::subagent_templates::SubagentTemplateError,
    > {
        self.admission.admit_request().map_err(|_| {
            openclaw::projection::subagent_templates::SubagentTemplateError::Unavailable
        })?;
        self.open_claw.subagent_template_catalog()
    }

    pub(crate) fn subagent_template(
        &self,
        id: &str,
    ) -> Result<
        openclaw::projection::subagent_templates::Detail,
        openclaw::projection::subagent_templates::SubagentTemplateError,
    > {
        self.admission.admit_request().map_err(|_| {
            openclaw::projection::subagent_templates::SubagentTemplateError::Unavailable
        })?;
        self.open_claw.subagent_template(id)
    }

    pub(crate) fn admit_diagnostics(
        &self,
    ) -> Result<crate::diagnostics::DiagnosticsArchiveAdmission, RequestAdmissionClosed> {
        self.admission.admit_request()?;
        Ok(self.diagnostics.admit(self.state()))
    }

    pub(crate) fn control_lease(&self) -> Result<ControlLease, RequestAdmissionClosed> {
        self.admission.admit_request()?;
        Ok(self.control_lease_for_snapshot(&self.open_claw_lifecycle_snapshot()))
    }

    pub(crate) async fn trigger_open_claw_cron(
        &mut self,
        job_id: String,
    ) -> Result<openclaw::port::CronTriggerOutcome, RequestAdmissionClosed> {
        self.admission.admit_request()?;
        if self.running_cron_ops().is_err() {
            return Ok(openclaw::port::CronTriggerOutcome::OutcomeUnknown);
        }
        self.reap_cron_operations().await;
        if self.cron_operations.len() >= CRON_OPERATION_CAPACITY {
            return Ok(openclaw::port::CronTriggerOutcome::OutcomeUnknown);
        }
        let Some(cron_events) = self.event_sinks.open_claw_cron() else {
            return Ok(openclaw::port::CronTriggerOutcome::OutcomeUnknown);
        };
        let admission = match self.running_cron_ops() {
            Ok(ops) => match ops.admit_cron_execution(job_id.clone()).await {
                Ok(Ok(admission)) => admission,
                Ok(Err(status)) => return Ok(status),
                Err(_) => return Ok(openclaw::port::CronTriggerOutcome::OutcomeUnknown),
            },
            Err(_) => return Ok(openclaw::port::CronTriggerOutcome::OutcomeUnknown),
        };
        let run_id = admission.run_id().to_owned();
        let event_job_id = job_id.clone();
        let event_run_id = run_id.clone();
        let (operation, _) = OperationHandle::spawn(move |cancellation| async move {
            let status = openclaw::port::await_cron_execution(admission, cancellation).await;
            // The Renderer event is a best-effort refresh hint; it must not hold the
            // operation or Host shutdown behind a stalled consumer.
            let _ = cron_events.try_send((event_job_id, event_run_id, status));
            status
        });
        self.cron_operations.push(CronOperation {
            job_id,
            run_id,
            operation,
        });
        Ok(openclaw::port::CronTriggerOutcome::Accepted)
    }

    pub(crate) async fn cancel_cron_operations(&mut self) {
        let cron_events = self.event_sinks.open_claw_cron();
        for operation in &self.cron_operations {
            operation.operation.cancel();
        }
        for mut operation in self.cron_operations.drain(..) {
            if operation.operation.join().await.is_err() {
                if let Some(cron_events) = &cron_events {
                    let _ = cron_events.try_send((
                        operation.job_id,
                        operation.run_id,
                        openclaw::port::CronExecutionStatus::OutcomeUnknown,
                    ));
                }
            }
        }
    }

    pub(crate) fn emit_parent_team_event(&mut self, payload: serde_json::Value) {
        let parent_callback = self.parent_callback.handle();
        self.spawn_parent_event(move || async move {
            let _ = parent_callback
                .emit_parent_gateway_event(ParentGatewayEventName::TeamEvent, payload)
                .await;
        });
    }

    pub(crate) fn emit_parent_runtime_job_event(
        &mut self,
        event_name: ParentRuntimeJobEventName,
        payload: serde_json::Value,
    ) {
        let parent_callback = self.parent_callback.handle();
        self.spawn_parent_event(move || async move {
            let _ = parent_callback
                .emit_parent_runtime_job_event(event_name, payload)
                .await;
        });
    }

    fn spawn_parent_event<F, U>(&mut self, future: F)
    where
        F: FnOnce() -> U + Send + 'static,
        U: std::future::Future<Output = ()> + Send + 'static,
    {
        self.reap_parent_event_operations();
        if self.parent_event_operations.len() >= PARENT_EVENT_OPERATION_CAPACITY {
            return;
        }
        let (operation, _) = OperationHandle::spawn(move |_| future());
        self.parent_event_operations
            .push(ParentEventOperation { operation });
    }

    pub(crate) fn reap_parent_event_operations(&mut self) {
        self.parent_event_operations
            .retain(|operation| !operation.operation.is_finished());
    }

    pub(crate) fn cancel_parent_event_operations(&mut self) {
        for operation in &self.parent_event_operations {
            operation.operation.cancel();
        }
        self.parent_event_operations.clear();
    }

    pub(crate) async fn reap_cron_operations(&mut self) {
        let cron_events = self.event_sinks.open_claw_cron();
        let mut pending = Vec::with_capacity(self.cron_operations.len());
        for mut operation in self.cron_operations.drain(..) {
            if operation.operation.is_finished() {
                if operation.operation.join().await.is_err() {
                    if let Some(cron_events) = &cron_events {
                        let _ = cron_events.try_send((
                            operation.job_id,
                            operation.run_id,
                            openclaw::port::CronExecutionStatus::OutcomeUnknown,
                        ));
                    }
                }
            } else {
                pending.push(operation);
            }
        }
        self.cron_operations = pending;
    }

    pub(crate) async fn list_cron_jobs(&self) -> crate::cron::CronListOutcome {
        if self.admission.admit_request().is_err() {
            return crate::cron::CronListOutcome::Unavailable;
        }
        match self.running_cron_ops() {
            Ok(ops) => ops.list_cron_jobs().await,
            Err(_) => crate::cron::CronListOutcome::Unavailable,
        }
    }

    pub(crate) async fn execute_cron_broker(
        &mut self,
        request: crate::cron::CronBrokerRequest,
    ) -> crate::cron::CronBrokerOutcome {
        if self.admission.admit_request().is_err() || self.running_cron_ops().is_err() {
            return crate::cron::CronBrokerOutcome::Unavailable {
                code: "OWNER_UNAVAILABLE",
                message: "Cron owner is unavailable",
            };
        }
        match request.operation {
            crate::cron::CronBrokerOperation::List => crate::cron::CronBrokerOutcome::Applied(
                crate::cron::CronBrokerResult::List(self.list_cron_jobs().await),
            ),
            crate::cron::CronBrokerOperation::History { command } => {
                crate::cron::CronBrokerOutcome::Applied(crate::cron::CronBrokerResult::History(
                    self.load_cron_history(command).await,
                ))
            }
            crate::cron::CronBrokerOperation::Create { command } => {
                crate::cron::CronBrokerOutcome::Applied(crate::cron::CronBrokerResult::Job(
                    self.add_cron_job(command).await,
                ))
            }
            crate::cron::CronBrokerOperation::Update {
                command,
                expected_revision: _,
            } => crate::cron::CronBrokerOutcome::Applied(crate::cron::CronBrokerResult::Job(
                self.update_cron_job(command).await,
            )),
            crate::cron::CronBrokerOperation::Delete {
                command,
                expected_revision: _,
            } => crate::cron::CronBrokerOutcome::Applied(crate::cron::CronBrokerResult::Delete(
                self.delete_cron_job(command).await,
            )),
        }
    }

    pub(crate) async fn load_cron_history(
        &mut self,
        command: crate::cron::CronHistoryCommand,
    ) -> crate::cron::CronHistoryOutcome {
        if self.admission.admit_request().is_err() {
            return crate::cron::CronHistoryOutcome::Unavailable;
        }
        let receipts = match self.running_cron_ops() {
            Ok(ops) => {
                ops.cron_run_history(command.job_id().to_owned(), command.limit())
                    .await
            }
            Err(_) => return crate::cron::CronHistoryOutcome::Unavailable,
        };
        let receipts = match receipts {
            Ok(receipts) => receipts,
            Err(openclaw::port::CronHistoryReadFailure::Rejected) => {
                return crate::cron::CronHistoryOutcome::Rejected;
            }
            Err(openclaw::port::CronHistoryReadFailure::Protocol) => {
                return crate::cron::CronHistoryOutcome::Protocol;
            }
            Err(openclaw::port::CronHistoryReadFailure::Deadline) => {
                return crate::cron::CronHistoryOutcome::Deadline;
            }
            Err(openclaw::port::CronHistoryReadFailure::Unavailable) => {
                return crate::cron::CronHistoryOutcome::Unavailable;
            }
        };
        let session_key = match canonical_cron_session_key(&command, receipts) {
            Some(session_key) => session_key,
            None => return crate::cron::CronHistoryOutcome::Rejected,
        };
        let session_key = match openclaw::session::protocol::SessionKey::try_new(session_key) {
            Ok(session_key) => session_key,
            Err(_) => return crate::cron::CronHistoryOutcome::Protocol,
        };
        let params = match ChatHistoryParams::new(session_key).try_with_limit(command.limit()) {
            Ok(params) => params,
            Err(_) => return crate::cron::CronHistoryOutcome::Protocol,
        };
        match self.history_open_claw_chat(params).await {
            Ok(history) => crate::cron::CronHistoryOutcome::Loaded(history),
            Err(
                RuntimeSessionError::AdmissionClosed(_) | RuntimeSessionError::RuntimeUnavailable,
            ) => crate::cron::CronHistoryOutcome::Unavailable,
            Err(RuntimeSessionError::Client(OpenClawSessionError::TargetRejected)) => {
                crate::cron::CronHistoryOutcome::Rejected
            }
            Err(RuntimeSessionError::Client(OpenClawSessionError::RequestDeadline)) => {
                crate::cron::CronHistoryOutcome::Deadline
            }
            Err(RuntimeSessionError::Client(
                OpenClawSessionError::Protocol | OpenClawSessionError::UnknownResponse,
            )) => crate::cron::CronHistoryOutcome::Protocol,
            Err(RuntimeSessionError::Client(_)) => crate::cron::CronHistoryOutcome::Unavailable,
        }
    }

    pub(crate) async fn list_matcha_sessions(&self) -> crate::matcha_session_catalog::Outcome {
        if self.admission.admit_request().is_err()
            || self.matcha().snapshot().phase() != SupervisorPhase::Running
        {
            return crate::matcha_session_catalog::Outcome::Unavailable;
        }
        match self.matcha().list_history().await {
            matcha_agent::session::history::HistoryResult::Complete(catalog) => {
                crate::matcha_session_catalog::Outcome::Listed(
                    crate::matcha_session_catalog::project(catalog),
                )
            }
            matcha_agent::session::history::HistoryResult::NotFound
            | matcha_agent::session::history::HistoryResult::Unavailable
            | matcha_agent::session::history::HistoryResult::Unknown
            | matcha_agent::session::history::HistoryResult::Incomplete(_) => {
                crate::matcha_session_catalog::Outcome::Unavailable
            }
        }
    }

    pub(crate) async fn add_cron_job(
        &self,
        command: crate::cron::CronCreateCommand,
    ) -> crate::cron::CronJobMutationOutcome {
        if self.admission.admit_request().is_err() {
            return crate::cron::CronJobMutationOutcome::Unavailable;
        }
        match self.running_cron_ops() {
            Ok(ops) => ops.add_cron_job(command).await,
            Err(_) => crate::cron::CronJobMutationOutcome::Unavailable,
        }
    }

    pub(crate) async fn update_cron_job(
        &self,
        command: crate::cron::CronUpdateCommand,
    ) -> crate::cron::CronJobMutationOutcome {
        if self.admission.admit_request().is_err() {
            return crate::cron::CronJobMutationOutcome::Unavailable;
        }
        match self.running_cron_ops() {
            Ok(ops) => ops.update_cron_job(command).await,
            Err(_) => crate::cron::CronJobMutationOutcome::Unavailable,
        }
    }

    pub(crate) async fn delete_cron_job(
        &self,
        command: crate::cron::CronDeleteCommand,
    ) -> crate::cron::CronDeleteOutcome {
        if self.admission.admit_request().is_err() {
            return crate::cron::CronDeleteOutcome::Unavailable;
        }
        match self.running_cron_ops() {
            Ok(ops) => ops.delete_cron_job(command).await,
            Err(_) => crate::cron::CronDeleteOutcome::Unavailable,
        }
    }

    fn control_lease_for_snapshot(&self, snapshot: &SupervisorSnapshot) -> ControlLease {
        match control_lease_projection(snapshot.phase(), snapshot.active_operation()) {
            ControlLeaseProjection::Unavailable => ControlLease::unavailable(),
            ControlLeaseProjection::ProbeGateway => self.open_claw.control_lease(),
        }
    }

    pub fn read_open_claw_workspace_text(
        &self,
        session_key: &str,
        relative_path: &str,
        limit: usize,
    ) -> Result<openclaw::workspace::WorkspaceTextReceipt, WorkspaceReadError> {
        self.admission
            .admit_request()
            .map_err(WorkspaceReadError::AdmissionClosed)?;
        self.running_workspace_ops()
            .map_err(|_| WorkspaceReadError::Unavailable)?
            .read_text(session_key, relative_path, limit)
            .map_err(WorkspaceReadError::from)
    }

    pub fn read_open_claw_workspace_binary(
        &self,
        session_key: &str,
        relative_path: &str,
        limit: usize,
    ) -> Result<openclaw::workspace::WorkspaceBinaryReceipt, WorkspaceBinaryError> {
        self.admission
            .admit_request()
            .map_err(WorkspaceBinaryError::AdmissionClosed)?;
        self.running_workspace_ops()
            .map_err(|_| WorkspaceBinaryError::Unavailable)?
            .read_binary(session_key, relative_path, limit)
            .map_err(WorkspaceBinaryError::from)
    }

    pub fn prepare_open_claw_workspace_media(
        &self,
        session_key: &str,
        relative_path: &str,
        mime_type: &str,
    ) -> Result<openclaw::workspace::media::WorkspaceMediaReceipt, WorkspaceMediaError> {
        self.admission
            .admit_request()
            .map_err(WorkspaceMediaError::AdmissionClosed)?;
        self.running_workspace_ops()
            .map_err(|_| WorkspaceMediaError::Unavailable)?
            .prepare_media(session_key, relative_path, mime_type)
            .map_err(WorkspaceMediaError::from)
    }

    pub fn resolve_open_claw_workspace_media(
        &self,
        session_key: &str,
        reference: &str,
    ) -> Result<openclaw::workspace::media::ResolvedWorkspaceMedia, WorkspaceMediaError> {
        self.admission
            .admit_request()
            .map_err(WorkspaceMediaError::AdmissionClosed)?;
        self.running_workspace_ops()
            .map_err(|_| WorkspaceMediaError::Unavailable)?
            .resolve_media(session_key, reference)
            .map_err(WorkspaceMediaError::from)
    }

    pub fn thumbnail_open_claw_workspace_media(
        &self,
        session_key: &str,
        relative_path: &str,
        mime_type: &str,
    ) -> Result<openclaw::workspace::media::WorkspaceMediaThumbnail, WorkspaceMediaError> {
        self.admission
            .admit_request()
            .map_err(WorkspaceMediaError::AdmissionClosed)?;
        self.running_workspace_ops()
            .map_err(|_| WorkspaceMediaError::Unavailable)?
            .thumbnail_media(session_key, relative_path, mime_type)
            .map_err(WorkspaceMediaError::from)
    }

    pub fn thumbnail_open_claw_workspace_media_gateway(
        &self,
        session_key: &str,
        gateway_url: &str,
        mime_type: &str,
        agent_id: &str,
    ) -> Result<openclaw::workspace::media::WorkspaceMediaThumbnail, WorkspaceMediaError> {
        self.admission
            .admit_request()
            .map_err(WorkspaceMediaError::AdmissionClosed)?;
        self.running_workspace_ops()
            .map_err(|_| WorkspaceMediaError::Unavailable)?
            .thumbnail_media_gateway(session_key, gateway_url, mime_type, agent_id)
            .map_err(WorkspaceMediaError::from)
    }

    pub fn thumbnails_open_claw_workspace_media(
        &self,
        session_key: &str,
        paths: &[openclaw::workspace::media::WorkspaceMediaPath],
    ) -> Result<Vec<openclaw::workspace::media::WorkspaceMediaThumbnailEntry>, WorkspaceMediaError>
    {
        self.admission
            .admit_request()
            .map_err(WorkspaceMediaError::AdmissionClosed)?;
        self.running_workspace_ops()
            .map_err(|_| WorkspaceMediaError::Unavailable)?
            .thumbnails_media(session_key, paths)
            .map_err(WorkspaceMediaError::from)
    }

    pub fn stage_paths_open_claw_workspace_media(
        &self,
        session_key: &str,
        paths: &[openclaw::workspace::media::WorkspaceMediaPath],
    ) -> Result<Vec<openclaw::workspace::media::WorkspaceMediaReceipt>, WorkspaceMediaError> {
        self.admission
            .admit_request()
            .map_err(WorkspaceMediaError::AdmissionClosed)?;
        self.running_workspace_ops()
            .map_err(|_| WorkspaceMediaError::Unavailable)?
            .stage_paths_media(session_key, paths)
            .map_err(WorkspaceMediaError::from)
    }

    pub fn stage_buffer_open_claw_workspace_media(
        &self,
        session_key: &str,
        base64: &str,
        file_name: &str,
        mime_type: &str,
    ) -> Result<openclaw::workspace::media::WorkspaceMediaReceipt, WorkspaceMediaError> {
        self.admission
            .admit_request()
            .map_err(WorkspaceMediaError::AdmissionClosed)?;
        self.running_workspace_ops()
            .map_err(|_| WorkspaceMediaError::Unavailable)?
            .stage_buffer_media(session_key, base64, file_name, mime_type)
            .map_err(WorkspaceMediaError::from)
    }

    pub fn stat_open_claw_workspace_file(
        &self,
        session_key: &str,
        relative_path: &str,
    ) -> Result<openclaw::workspace::WorkspaceStatReceipt, WorkspaceStatError> {
        self.admission
            .admit_request()
            .map_err(WorkspaceStatError::AdmissionClosed)?;
        self.running_workspace_ops()
            .map_err(|_| WorkspaceStatError::Unavailable)?
            .stat_file(session_key, relative_path)
            .map_err(WorkspaceStatError::from)
    }

    pub fn list_open_claw_workspace_directory(
        &self,
        session_key: &str,
        relative_path: &str,
        include_hidden: bool,
    ) -> Result<openclaw::workspace::WorkspaceDirectoryReceipt, WorkspaceListError> {
        self.admission
            .admit_request()
            .map_err(WorkspaceListError::AdmissionClosed)?;
        self.running_workspace_ops()
            .map_err(|_| WorkspaceListError::Unavailable)?
            .list_directory(session_key, relative_path, include_hidden)
            .map_err(WorkspaceListError::from)
    }

    pub(crate) async fn task_manager(
        &mut self,
        command: crate::task_manager::Command,
    ) -> crate::task_manager::Outcome {
        match self.admission.admit_request() {
            Ok(()) => match self.running_task_ops() {
                Ok(ops) => ops.task_manager(command).await,
                Err(error) => crate::task_manager::Outcome::from_failure(command, error),
            },
            Err(_) => crate::task_manager::Outcome::unavailable(command),
        }
    }

    pub(crate) async fn agents(
        &mut self,
        command: crate::agents::Command,
    ) -> crate::agents::Outcome {
        if self.admission.admit_request().is_err() {
            return crate::agents::Outcome::Unavailable;
        }
        let endpoint = command.endpoint().runtime_endpoint();
        match self.running_subagent_ops(endpoint) {
            Ok(ops) => ops.agents(command).await,
            Err(RuntimeOperationFailure::Unsupported) => crate::agents::Outcome::Unsupported,
            Err(RuntimeOperationFailure::Unavailable) => crate::agents::Outcome::Unavailable,
            Err(RuntimeOperationFailure::TargetRejected) => crate::agents::Outcome::Rejected,
            Err(RuntimeOperationFailure::Unknown) => crate::agents::Outcome::Unknown,
        }
    }

    pub(crate) async fn platform_tools(&mut self) -> crate::platform_tools::Outcome {
        if self.admission.admit_request().is_err()
            || self.open_claw.owner().snapshot().phase() != SupervisorPhase::Running
        {
            return crate::platform_tools::Outcome::Unavailable;
        }
        self.open_claw.platform_tools().await
    }

    pub fn write_open_claw_workspace_text(
        &self,
        session_key: &str,
        relative_path: &str,
        content: &str,
    ) -> Result<openclaw::workspace::WorkspaceTextReceipt, WorkspaceWriteError> {
        self.admission
            .admit_request()
            .map_err(WorkspaceWriteError::AdmissionClosed)?;
        self.running_workspace_ops()
            .map_err(|_| WorkspaceWriteError::Unavailable)?
            .write_text(session_key, relative_path, content)
            .map_err(WorkspaceWriteError::from)
    }

    pub async fn list_open_claw_sessions(
        &mut self,
        params: SessionsListParams,
    ) -> Result<SessionsListResult, RuntimeSessionError<OpenClawSessionError>> {
        self.admission
            .admit_request()
            .map_err(RuntimeSessionError::AdmissionClosed)?;
        self.running_session_ops(Some(RuntimeDriverIdentity::open_claw().endpoint()))
            .map_err(|_| RuntimeSessionError::RuntimeUnavailable)?
            .list_sessions(params)
            .await
    }

    pub async fn history_open_claw_chat(
        &mut self,
        params: ChatHistoryParams,
    ) -> Result<ChatHistoryResult, RuntimeSessionError<OpenClawSessionError>> {
        self.admission
            .admit_request()
            .map_err(RuntimeSessionError::AdmissionClosed)?;
        self.running_session_ops(Some(RuntimeDriverIdentity::open_claw().endpoint()))
            .map_err(|_| RuntimeSessionError::RuntimeUnavailable)?
            .history(params)
            .await
    }

    pub(crate) async fn open_claw_history_window(
        &self,
        params: ChatHistoryParams,
        request: openclaw::session_window::PageRequest,
    ) -> Result<openclaw::session_window::SessionWindow, RuntimeSessionError<OpenClawSessionError>>
    {
        self.admission
            .admit_request()
            .map_err(RuntimeSessionError::AdmissionClosed)?;
        self.running_session_ops(Some(RuntimeDriverIdentity::open_claw().endpoint()))
            .map_err(|_| RuntimeSessionError::RuntimeUnavailable)?
            .history_window(params, request)
            .await
    }

    pub(crate) async fn observe_open_claw_mcp_server_status(
        &self,
        session_key: String,
        endpoint_session_id: Option<String>,
    ) -> Result<openclaw::gateway::wire::McpServerStatusList, ()> {
        if self.admission.admit_request().is_err()
            || self.open_claw.owner().snapshot().phase() != SupervisorPhase::Running
        {
            return Err(());
        }
        self.open_claw
            .observe_mcp_server_status(session_key, endpoint_session_id)
            .await
            .map_err(|_| ())
    }

    pub(crate) async fn apply_provider_native_configurations(
        &self,
        accounts: &[environment::ProviderAccount],
        catalog: &environment::ProviderModelCatalog,
        routing: Option<&environment::ProviderRouting>,
        retired: &[environment::ProviderAccount],
        required_auth_accounts: &BTreeSet<environment::ProviderAccountId>,
        now_millis: u64,
    ) -> ProviderNativeConfigurationEffect {
        if self.admission.admit_request().is_err() {
            return self.provider_native_unavailable("host-admission", "host-admission-closed", None);
        }

        eprintln!(
            "[startup-trace] source=provider-native-config phase=start detail=fanout-provider-config accounts={} retired={} routing={}",
            accounts.len(),
            retired.len(),
            routing.is_some()
        );
        let mut fanout = ProviderNativeConfigurationFanout::default();
        for identity in HostRuntimeDirectory::declared_driver_identities() {
            let endpoint = identity.endpoint();
            let Some(driver) = self.runtime_driver(&endpoint) else {
                eprintln!(
                    "[startup-trace] source=provider-native-config phase=skip detail=runtime-driver-missing runtime={} endpoint={}",
                    identity.display_name(),
                    identity.endpoint_id()
                );
                continue;
            };
            let Some(ops) = driver.provider_config_ops() else {
                eprintln!(
                    "[startup-trace] source=provider-native-config phase=skip detail=provider-config-ops-missing runtime={} endpoint={}",
                    identity.display_name(),
                    identity.endpoint_id()
                );
                continue;
            };
            if !driver.lifecycle_ops().is_some_and(LifecycleOps::readiness) {
                eprintln!(
                    "[startup-trace] source=provider-native-config phase=runtime-unavailable detail=runtime-not-ready runtime={} endpoint={}",
                    identity.display_name(),
                    identity.endpoint_id()
                );
                fanout.push(self.provider_native_unavailable(
                    "runtime-readiness",
                    "runtime-not-ready",
                    Some(format!("runtime={} endpoint={}", identity.display_name(), identity.endpoint_id())),
                ));
                continue;
            }
            fanout.push(
                ops.reconcile_provider_native_configuration(ProviderNativeConfigurationCommand {
                    accounts,
                    models: catalog,
                    routing,
                    retired,
                    required_auth_accounts,
                    now_millis,
                })
                .await,
            );
        }
        let effect = fanout.finish().unwrap_or_else(|| {
            self.provider_native_unavailable(
                "runtime-discovery",
                "no-provider-config-runtime",
                Some("no ready runtime exposed provider config operations".to_owned()),
            )
        });
        trace_provider_native_effect(&effect);
        effect
    }

    pub(crate) fn provider_native_unavailable(
        &self,
        phase: &'static str,
        reason: &'static str,
        detail: Option<String>,
    ) -> ProviderNativeConfigurationEffect {
        let mut config_path = PathBuf::from(self.open_claw.state_dir().as_path());
        config_path.push("openclaw.json");
        ProviderNativeConfigurationEffect::Evidence(
            ProviderNativeConfigurationEvidence::with_diagnostic(
                false,
                AppliedStatus::Unknown,
                ObservedStatus::Unavailable,
                ProviderNativeConfigurationDiagnostic::new(
                    phase,
                    reason,
                    config_path.display().to_string(),
                    None,
                    Some("models.providers"),
                    detail,
                ),
            ),
        )
    }

    pub(crate) fn usage_open_claw_recent(
        &self,
        limit: usize,
    ) -> Result<Vec<openclaw::usage::UsageEntry>, openclaw::usage::UsageHistoryError> {
        self.admission
            .admit_request()
            .map_err(|_| openclaw::usage::UsageHistoryError::Unavailable)?;
        self.open_claw.usage_recent(limit)
    }

    pub(crate) async fn install_clawhub_skill(
        &mut self,
        command: SkillInstallCommand,
    ) -> SkillInstallOutcome {
        if self.admission.admit_request().is_err() {
            return SkillInstallOutcome::Unknown;
        }
        match self.running_skill_ops() {
            Ok(ops) => ops.install_clawhub_skill(command).await,
            Err(_) => SkillInstallOutcome::Unknown,
        }
    }

    pub(crate) async fn skill_status(&mut self) -> crate::skill_status::Outcome {
        if self.admission.admit_request().is_err() {
            return crate::skill_status::Outcome::Unavailable;
        }
        match self.running_skill_ops() {
            Ok(ops) => ops.skill_status().await,
            Err(_) => crate::skill_status::Outcome::Unavailable,
        }
    }

    pub(crate) async fn manage_skills(
        &mut self,
        command: SkillManagementCommand,
    ) -> SkillManagementOutcome {
        if self.admission.admit_request().is_err() {
            return SkillManagementOutcome::Unavailable;
        }
        match self.running_skill_ops() {
            Ok(ops) => ops.manage_skills(command).await,
            Err(_) => SkillManagementOutcome::Unavailable,
        }
    }

    pub(crate) async fn skill_bundles(
        &self,
        command: crate::skill_bundle::Command,
    ) -> crate::skill_bundle::Outcome {
        match self.running_skill_ops() {
            Ok(ops) => ops.skill_bundles(command).await,
            Err(_) => crate::skill_bundle::Outcome::Unknown,
        }
    }

    pub(crate) async fn sync_security_policy(
        &self,
        policy: serde_json::Value,
    ) -> crate::security_delivery::Outcome {
        if self.admission.admit_request().is_err()
            || self.open_claw.owner().snapshot().phase() != SupervisorPhase::Running
        {
            return crate::security_delivery::Outcome::Unknown;
        }
        match self.open_claw.sync_security_policy(policy).await {
            openclaw::operations::SecurityPolicyEffect::Applied(_) => {
                crate::security_delivery::Outcome::Confirmed
            }
            openclaw::operations::SecurityPolicyEffect::RuntimeRejected => {
                crate::security_delivery::Outcome::Rejected
            }
            openclaw::operations::SecurityPolicyEffect::Unavailable
            | openclaw::operations::SecurityPolicyEffect::OutcomeUnknown => {
                crate::security_delivery::Outcome::Unknown
            }
        }
    }

    pub(crate) async fn security_operation(
        &self,
        operation_id: String,
        input: serde_json::Value,
    ) -> openclaw::operations::SecurityActionEffect {
        if self.admission.admit_request().is_err()
            || self.open_claw.owner().snapshot().phase() != SupervisorPhase::Running
        {
            return openclaw::operations::SecurityActionEffect::Unavailable;
        }
        self.open_claw
            .security_operation(&operation_id, input)
            .await
    }

    pub(crate) async fn run_security_emergency(
        &mut self,
    ) -> crate::security_emergency::SecurityEmergencyOutcome {
        if self.admission.admit_request().is_err()
            || self.open_claw.owner().snapshot().phase() != SupervisorPhase::Running
        {
            return crate::security_emergency::SecurityEmergencyOutcome::Unavailable;
        }
        self.open_claw.run_security_emergency().await
    }

    pub(crate) async fn query_security_audit(
        &mut self,
        query: crate::security_audit::Query,
    ) -> crate::security_audit::Outcome {
        if self.admission.admit_request().is_err()
            || self.open_claw.owner().snapshot().phase() != SupervisorPhase::Running
        {
            return crate::security_audit::Outcome::Unavailable;
        }
        self.open_claw.query_security_audit(query).await
    }

    pub(crate) async fn control_open_claw_channel_account(
        &mut self,
        action: crate::channel_control::ChannelControlAction,
        channel: String,
        account: String,
    ) -> crate::channel_control::ChannelControlOutcome {
        if self.admission.admit_request().is_err() {
            return crate::channel_control::ChannelControlOutcome::OutcomeUnknown;
        }
        match self.running_channel_ops() {
            Ok(ops) => ops.control_channel_account(action, channel, account).await,
            Err(_) => crate::channel_control::ChannelControlOutcome::OutcomeUnknown,
        }
    }

    pub(crate) async fn start_channel_login(
        &mut self,
        channel: String,
        force: bool,
        timeout_ms: Option<u64>,
        account_id: Option<String>,
        config: zeroize::Zeroizing<Vec<u8>>,
    ) -> crate::channel_login::Outcome {
        if self.admission.admit_request().is_err() || self.running_channel_ops().is_err() {
            return crate::channel_login::Outcome::Unknown;
        }
        let config_key = (channel.clone(), account_id.clone());
        self.pending_channel_login_configs
            .insert(config_key, config);
        let outcome = match self.running_channel_ops() {
            Ok(ops) => {
                ops.start_channel_login(channel.clone(), force, timeout_ms, account_id.clone())
                    .await
            }
            Err(_) => crate::channel_login::Outcome::Unknown,
        };
        self.complete_channel_login(channel, account_id, outcome)
            .await
    }

    pub(crate) fn start_channel_login_wait(
        &mut self,
        channel: String,
        timeout_ms: Option<u64>,
        account_id: Option<String>,
        session_key: Option<String>,
        current_qr_data_url: Option<String>,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> Result<ChannelLoginWaitOperation, crate::channel_login::Outcome> {
        if self.admission.admit_request().is_err() {
            return Err(crate::channel_login::Outcome::Unknown);
        }
        let wait = match self.running_channel_ops() {
            Ok(ops) => ops.wait_channel_login_owned(
                channel.clone(),
                timeout_ms,
                account_id.clone(),
                session_key,
                current_qr_data_url,
                cancellation,
            ),
            Err(_) => return Err(crate::channel_login::Outcome::Unknown),
        };
        let (operation, _) = OperationHandle::spawn(move |_| wait);
        Ok(ChannelLoginWaitOperation {
            channel,
            account_id,
            operation,
        })
    }

    pub(crate) async fn join_channel_login_wait(
        &mut self,
        mut operation: ChannelLoginWaitOperation,
    ) -> ChannelLoginWaitCompletion {
        let outcome = operation
            .operation
            .join()
            .await
            .unwrap_or(crate::channel_login::Outcome::Unknown);
        let outcome = self
            .complete_channel_login(
                operation.channel.clone(),
                operation.account_id.clone(),
                outcome,
            )
            .await;
        ChannelLoginWaitCompletion { outcome }
    }

    pub(crate) async fn wait_channel_login(
        &mut self,
        channel: String,
        timeout_ms: Option<u64>,
        account_id: Option<String>,
        session_key: Option<String>,
        current_qr_data_url: Option<String>,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> crate::channel_login::Outcome {
        let operation = match self.start_channel_login_wait(
            channel,
            timeout_ms,
            account_id,
            session_key,
            current_qr_data_url,
            cancellation,
        ) {
            Ok(operation) => operation,
            Err(outcome) => return outcome,
        };
        self.join_channel_login_wait(operation).await.outcome
    }

    async fn complete_channel_login(
        &mut self,
        channel: String,
        requested_account_id: Option<String>,
        outcome: crate::channel_login::Outcome,
    ) -> crate::channel_login::Outcome {
        let crate::channel_login::Outcome::Progress(progress) = &outcome else {
            self.pending_channel_login_configs
                .remove(&(channel, requested_account_id));
            return outcome;
        };
        if !progress.is_connected() {
            return outcome;
        }
        let Some(account_id) = progress.account_id.clone() else {
            return crate::channel_login::Outcome::Unknown;
        };
        let Some(config) = self
            .pending_channel_login_configs
            .remove(&(channel.clone(), Some(account_id.clone())))
            .or_else(|| {
                self.pending_channel_login_configs
                    .remove(&(channel.clone(), requested_account_id))
            })
            .or_else(|| {
                self.pending_channel_login_configs
                    .remove(&(channel.clone(), None))
            })
        else {
            return outcome;
        };
        let configuration = self
            .configure_logged_in_channel(channel, account_id, config)
            .await;
        match configuration {
            crate::channel_catalog::ChannelConfigureOutcome::Confirmed => {
                match self.restart_open_claw().await {
                    Ok(Ok(_)) => outcome,
                    Ok(Err(_)) | Err(_) => crate::channel_login::Outcome::Unknown,
                }
            }
            crate::channel_catalog::ChannelConfigureOutcome::TargetRejected => {
                crate::channel_login::Outcome::Rejected
            }
            crate::channel_catalog::ChannelConfigureOutcome::Unknown => {
                crate::channel_login::Outcome::Unknown
            }
        }
    }

    async fn configure_logged_in_channel(
        &self,
        channel: String,
        account_id: String,
        config: zeroize::Zeroizing<Vec<u8>>,
    ) -> crate::channel_catalog::ChannelConfigureOutcome {
        let Ok(mut values) =
            serde_json::from_slice::<serde_json::Map<String, serde_json::Value>>(&config)
        else {
            return crate::channel_catalog::ChannelConfigureOutcome::TargetRejected;
        };
        drop(config);
        values.insert("enabled".to_owned(), serde_json::Value::Bool(true));
        let Ok(bytes) = serde_json::to_vec(&values) else {
            return crate::channel_catalog::ChannelConfigureOutcome::Unknown;
        };
        match self.running_channel_ops() {
            Ok(ops) => {
                ops.channel_configure(channel, account_id, zeroize::Zeroizing::new(bytes))
                    .await
            }
            Err(_) => crate::channel_catalog::ChannelConfigureOutcome::Unknown,
        }
    }

    pub(crate) async fn cancel_channel_login(
        &mut self,
        channel: String,
        account_id: Option<String>,
    ) -> crate::channel_login::Outcome {
        match &account_id {
            Some(account_id) => {
                self.pending_channel_login_configs
                    .remove(&(channel.clone(), Some(account_id.clone())));
            }
            None => self
                .pending_channel_login_configs
                .retain(|(pending_channel, _), _| pending_channel != &channel),
        }
        if self.admission.admit_request().is_err() {
            return crate::channel_login::Outcome::Cancelled;
        }
        match self.running_channel_ops() {
            Ok(ops) => ops.stop_channel_login(channel, account_id).await,
            Err(_) => crate::channel_login::Outcome::Unknown,
        }
    }

    pub(crate) async fn logout_channel(
        &mut self,
        channel: String,
        account_id: Option<String>,
    ) -> crate::channel_login::Outcome {
        if self.admission.admit_request().is_err() {
            return crate::channel_login::Outcome::Unknown;
        }
        match self.running_channel_ops() {
            Ok(ops) => ops.logout_channel(channel, account_id).await,
            Err(_) => crate::channel_login::Outcome::Unknown,
        }
    }

    pub(crate) async fn list_open_claw_channel_pairing(
        &mut self,
        channel: String,
        account: Option<String>,
    ) -> crate::channel_status::ChannelPairingOutcome {
        if self.admission.admit_request().is_err() {
            return crate::channel_status::ChannelPairingOutcome::OutcomeUnknown;
        }
        match self.running_channel_ops() {
            Ok(ops) => ops.list_channel_pairing(channel, account).await,
            Err(_) => crate::channel_status::ChannelPairingOutcome::OutcomeUnknown,
        }
    }

    pub(crate) async fn approve_open_claw_channel_pairing(
        &mut self,
        channel: String,
        account: Option<String>,
        code: zeroize::Zeroizing<Vec<u8>>,
    ) -> crate::channel_status::ChannelPairingApprovalOutcome {
        if self.admission.admit_request().is_err() {
            return crate::channel_status::ChannelPairingApprovalOutcome::Unknown;
        }
        match self.running_channel_ops() {
            Ok(ops) => ops.approve_channel_pairing(channel, account, code).await,
            Err(_) => crate::channel_status::ChannelPairingApprovalOutcome::Unknown,
        }
    }

    pub(crate) async fn observe_open_claw_channel_accounts(
        &mut self,
    ) -> Result<
        crate::channel_status::ChannelStatusOutcome,
        crate::channel_status::ChannelStatusFailure,
    > {
        self.admission
            .admit_request()
            .map_err(|_| crate::channel_status::ChannelStatusFailure::Unavailable)?;
        match self.running_channel_ops() {
            Ok(ops) => ops.observe_channel_accounts().await,
            Err(_) => Err(crate::channel_status::ChannelStatusFailure::Unavailable),
        }
    }

    pub(crate) async fn observe_open_claw_channel_snapshot(
        &mut self,
    ) -> Result<
        crate::channel_status::ChannelSnapshotOutcome,
        crate::channel_status::ChannelStatusFailure,
    > {
        self.admission
            .admit_request()
            .map_err(|_| crate::channel_status::ChannelStatusFailure::Unavailable)?;
        match self.running_channel_ops() {
            Ok(ops) => ops.observe_channel_snapshot().await,
            Err(_) => Err(crate::channel_status::ChannelStatusFailure::Unavailable),
        }
    }

    pub(crate) async fn read_channel_config(
        &mut self,
        channel: String,
        account_id: Option<String>,
    ) -> crate::channel_config_read::Outcome {
        if self.admission.admit_request().is_err() {
            return crate::channel_config_read::Outcome::Unavailable;
        }
        match self.running_channel_ops() {
            Ok(ops) => ops.read_channel_config(channel, account_id).await,
            Err(_) => crate::channel_config_read::Outcome::Unavailable,
        }
    }

    pub(crate) async fn validate_channel_credentials(
        &mut self,
        channel: String,
        config: zeroize::Zeroizing<Vec<u8>>,
    ) -> crate::channel_credentials::Outcome {
        if self.admission.admit_request().is_err() {
            return crate::channel_credentials::Outcome::Unknown;
        }
        match self.running_channel_ops() {
            Ok(ops) => ops.validate_channel_credentials(channel, config).await,
            Err(_) => crate::channel_credentials::Outcome::Unknown,
        }
    }

    pub(crate) async fn channel_catalog(
        &mut self,
    ) -> crate::channel_catalog::ChannelCatalogOutcome {
        if self.admission.admit_request().is_err() {
            return crate::channel_catalog::ChannelCatalogOutcome::Unknown;
        }
        match self.running_channel_ops() {
            Ok(ops) => ops.channel_catalog().await,
            Err(_) => crate::channel_catalog::ChannelCatalogOutcome::Unknown,
        }
    }

    pub(crate) async fn channel_configure_form(
        &mut self,
        channel: String,
    ) -> crate::channel_catalog::ChannelConfigureFormOutcome {
        if self.admission.admit_request().is_err() {
            return crate::channel_catalog::ChannelConfigureFormOutcome::Unknown;
        }
        match self.running_channel_ops() {
            Ok(ops) => ops.channel_configure_form(channel).await,
            Err(_) => crate::channel_catalog::ChannelConfigureFormOutcome::Unknown,
        }
    }

    pub(crate) async fn channel_configure(
        &mut self,
        channel: String,
        account_id: String,
        values: zeroize::Zeroizing<Vec<u8>>,
    ) -> crate::channel_catalog::ChannelConfigureOutcome {
        if self.admission.admit_request().is_err() {
            return crate::channel_catalog::ChannelConfigureOutcome::Unknown;
        }
        match self.running_channel_ops() {
            Ok(ops) => ops.channel_configure(channel, account_id, values).await,
            Err(_) => crate::channel_catalog::ChannelConfigureOutcome::Unknown,
        }
    }

    pub(crate) async fn channel_delete_config(
        &mut self,
        channel: String,
        account_id: String,
    ) -> crate::channel_delete::Outcome {
        if self.admission.admit_request().is_err() {
            return crate::channel_delete::Outcome::Unknown;
        }
        match self.running_channel_ops() {
            Ok(ops) => ops.channel_delete_config(channel, account_id).await,
            Err(_) => crate::channel_delete::Outcome::Unknown,
        }
    }

    pub(crate) fn register_session_identity(
        &mut self,
        identity: SessionIdentity,
        _route_key: Option<String>,
        _run_id: Option<String>,
    ) -> bool {
        let session_key = identity.session_key().to_owned();
        if let Some(existing) = self.session_states.get(&session_key) {
            return existing.identity() == &identity;
        }
        let Ok(state) = SessionState::new(identity, self.session_epoch) else {
            return false;
        };
        self.session_states.insert(session_key, state);
        true
    }

    fn retain_live_matcha_renderer_event_tasks(&mut self) {
        let mut live = Vec::with_capacity(self.matcha_renderer_event_tasks.len());
        for task in std::mem::take(&mut self.matcha_renderer_event_tasks) {
            if task.task.is_finished() {
                self.clear_session_trace_id_with(
                    &task.session_key,
                    Some(&task.run_id),
                    task.trace_id.as_deref(),
                );
            } else {
                live.push(task);
            }
        }
        self.matcha_renderer_event_tasks = live;
    }

    fn register_session_trace_id(
        &mut self,
        session_key: &str,
        run_id: &str,
        trace_id: Option<&str>,
    ) {
        if let Some(trace_id) = trace_id {
            self.session_trace_ids.insert(
                (session_key.to_owned(), run_id.to_owned()),
                trace_id.to_owned(),
            );
            session_trace::log(
                "runtime.session-trace.registered",
                Some(trace_id),
                serde_json::json!({
                    "sessionKey": session_trace::id_shape(Some(session_key)),
                    "runId": session_trace::id_shape(Some(run_id)),
                }),
            );
        }
    }

    pub(crate) fn session_trace_id(&self, session_key: &str, run_id: Option<&str>) -> Option<&str> {
        if let Some(run_id) = run_id {
            return self
                .session_trace_ids
                .get(&(session_key.to_owned(), run_id.to_owned()))
                .map(String::as_str);
        }
        let mut matching = self
            .session_trace_ids
            .iter()
            .filter(|((key, _), _)| key == session_key);
        let trace_id = matching.next()?.1.as_str();
        matching.next().is_none().then_some(trace_id)
    }

    fn clear_session_trace_id(&mut self, session_key: &str, run_id: Option<&str>) {
        self.clear_session_trace_id_with(session_key, run_id, None);
    }

    fn clear_session_trace_id_with(
        &mut self,
        session_key: &str,
        run_id: Option<&str>,
        trace_id_hint: Option<&str>,
    ) {
        if let Some(run_id) = run_id {
            let trace_id = self
                .session_trace_ids
                .remove(&(session_key.to_owned(), run_id.to_owned()))
                .or_else(|| trace_id_hint.map(str::to_owned));
            if let Some(trace_id) = trace_id {
                session_trace::log(
                    "runtime.session-trace.cleared",
                    Some(&trace_id),
                    serde_json::json!({
                        "sessionKey": session_trace::id_shape(Some(session_key)),
                        "runId": session_trace::id_shape(Some(run_id)),
                    }),
                );
            }
            return;
        }
        let keys = self
            .session_trace_ids
            .keys()
            .filter(|(key, _)| key == session_key)
            .cloned()
            .collect::<Vec<_>>();
        for (session_key, run_id) in keys {
            self.clear_session_trace_id_with(&session_key, Some(&run_id), None);
        }
    }

    fn terminal_trace_run_id(changes: &[SessionChange]) -> Option<String> {
        changes.iter().find_map(|change| match change {
            SessionChange::RunPhaseChanged { run_id, phase }
                if matches!(
                    *phase,
                    RunPhase::Cancelled
                        | RunPhase::Completed
                        | RunPhase::Failed
                        | RunPhase::Interrupted
                ) =>
            {
                Some(run_id.clone())
            }
            _ => None,
        })
    }

    fn trace_apply_result(
        &mut self,
        stage: &str,
        session_key: &str,
        run_id: Option<&str>,
        change_count: usize,
        result: &SessionApplyResult,
    ) {
        let trace_id = self
            .session_trace_id(session_key, run_id)
            .map(str::to_owned);
        let Some(trace_id) = trace_id.as_deref() else {
            return;
        };
        session_trace::log(
            stage,
            Some(trace_id),
            serde_json::json!({
                "sessionKey": session_trace::id_shape(Some(session_key)),
                "runId": session_trace::id_shape(run_id),
                "changeCount": change_count,
                "result": Self::session_apply_result_name(result),
                "rejection": Self::session_apply_rejection_name(result),
            }),
        );
    }

    fn session_apply_result_name(result: &SessionApplyResult) -> &'static str {
        match result {
            SessionApplyResult::Applied(_) => "applied",
            SessionApplyResult::Duplicate { .. } => "duplicate",
            SessionApplyResult::Stale { .. } => "stale",
            SessionApplyResult::Gap { .. } => "gap",
            SessionApplyResult::Rejected { .. } => "rejected",
        }
    }

    fn session_apply_rejection_name(result: &SessionApplyResult) -> Option<&'static str> {
        match result {
            SessionApplyResult::Rejected { reason } => Some(match reason {
                SessionApplyRejection::InvalidInput => "invalid_input",
                SessionApplyRejection::InvalidChange => "invalid_change",
                SessionApplyRejection::CursorConflict { .. } => "cursor_conflict",
                SessionApplyRejection::SequenceExhausted => "sequence_exhausted",
                SessionApplyRejection::EventBackpressure => "event_backpressure",
                SessionApplyRejection::EventSinkUnavailable => "event_sink_unavailable",
            }),
            _ => None,
        }
    }

    pub(crate) fn trace_matcha_renderer_event(
        &self,
        event: &matcha_agent::peer::RendererEventEnvelope,
    ) {
        let Some(trace_id) = self.session_trace_id(event.session_key(), Some(event.run_id()))
        else {
            return;
        };
        let (event_kind, message_lifecycle, has_message_text, message_text_length) = match event
            .event()
        {
            matcha_agent::peer::RendererEvent::Run { .. } => ("run", None, None, None),
            matcha_agent::peer::RendererEvent::Message {
                lifecycle,
                message_text,
                ..
            } => (
                "message",
                Some(match lifecycle {
                    matcha_agent::peer::RendererMessageLifecycle::Started => "started",
                    matcha_agent::peer::RendererMessageLifecycle::Delta => "delta",
                    matcha_agent::peer::RendererMessageLifecycle::Completed => "completed",
                }),
                Some(message_text.is_some()),
                message_text.as_ref().map(String::len),
            ),
            matcha_agent::peer::RendererEvent::Tool { .. } => ("tool", None, None, None),
            matcha_agent::peer::RendererEvent::Approval { .. } => ("approval", None, None, None),
        };
        session_trace::log(
            "runtime.matcha.renderer-event",
            Some(trace_id),
            serde_json::json!({
                "sessionKey": session_trace::id_shape(Some(event.session_key())),
                "runId": session_trace::id_shape(Some(event.run_id())),
                "sourceCursor": event.source_cursor(),
                "sourceEpoch": event.source_epoch(),
                "eventKind": event_kind,
                "messageLifecycle": message_lifecycle,
                "hasMessageText": has_message_text,
                "messageTextLength": message_text_length,
            }),
        );
    }

    pub(crate) fn trace_matcha_subscription_recovery(
        &self,
        session_key: &str,
        run_id: &str,
        native_cursor: u64,
        source_epoch: Option<u64>,
        recovery: &matcha_agent::session::recovery::RecoveryReason,
    ) {
        let Some(trace_id) = self.session_trace_id(session_key, Some(run_id)) else {
            return;
        };
        let recovery_reason = match recovery {
            matcha_agent::session::recovery::RecoveryReason::CursorGap { .. } => "cursor_gap",
            matcha_agent::session::recovery::RecoveryReason::CursorStale { .. } => "cursor_stale",
            matcha_agent::session::recovery::RecoveryReason::EventOverflow => "event_overflow",
            matcha_agent::session::recovery::RecoveryReason::BroadcastLagged { .. } => {
                "broadcast_lagged"
            }
            matcha_agent::session::recovery::RecoveryReason::ConnectionClosed { .. } => {
                "connection_closed"
            }
            matcha_agent::session::recovery::RecoveryReason::Restart => "restart",
            matcha_agent::session::recovery::RecoveryReason::ReplayBoundary { .. } => {
                "replay_boundary"
            }
            matcha_agent::session::recovery::RecoveryReason::ProjectionRejected { .. } => {
                "projection_rejected"
            }
        };
        session_trace::log(
            "runtime.matcha.subscription-recovery",
            Some(trace_id),
            serde_json::json!({
                "sessionKey": session_trace::id_shape(Some(session_key)),
                "runId": session_trace::id_shape(Some(run_id)),
                "nativeCursor": native_cursor,
                "sourceEpoch": source_epoch,
                "recoveryReason": recovery_reason,
            }),
        );
    }

    fn trace_matcha_native_apply(
        &self,
        session_key: &str,
        run_id: Option<&str>,
        native_cursor: Option<u64>,
        source_epoch: Option<u64>,
        result: &SessionApplyResult,
    ) {
        let Some(trace_id) = self.session_trace_id(session_key, run_id) else {
            return;
        };
        session_trace::log(
            "runtime.matcha.native-apply",
            Some(trace_id),
            serde_json::json!({
                "sessionKey": session_trace::id_shape(Some(session_key)),
                "runId": session_trace::id_shape(run_id),
                "nativeCursor": native_cursor,
                "sourceEpoch": source_epoch,
                "result": Self::session_apply_result_name(result),
                "rejection": Self::session_apply_rejection_name(result),
            }),
        );
    }

    pub(crate) fn apply_session_change(
        &mut self,
        session_key: String,
        route_key: Option<String>,
        run_id: Option<String>,
        cursor: u64,
        changes: Vec<SessionChange>,
    ) -> SessionApplyResult {
        let Some(state) = self.session_states.get(&session_key) else {
            return SessionApplyResult::Rejected {
                reason: SessionApplyRejection::InvalidInput,
            };
        };
        let change_count = changes.len();
        let terminal_run_id = Self::terminal_trace_run_id(&changes);
        let mut next = state.clone();
        let result = next.apply(route_key, run_id.clone(), cursor, changes);
        self.trace_apply_result(
            "runtime.session.apply",
            &session_key,
            run_id.as_deref(),
            change_count,
            &result,
        );
        let SessionApplyResult::Applied(delta) = &result else {
            return result;
        };
        let Some(sink) = self.event_sinks.session_delta() else {
            return SessionApplyResult::Rejected {
                reason: SessionApplyRejection::EventSinkUnavailable,
            };
        };
        if let Err(error) = sink.try_send(delta.clone()) {
            return SessionApplyResult::Rejected {
                reason: match error {
                    tokio::sync::mpsc::error::TrySendError::Full(_) => {
                        SessionApplyRejection::EventBackpressure
                    }
                    tokio::sync::mpsc::error::TrySendError::Closed(_) => {
                        SessionApplyRejection::EventSinkUnavailable
                    }
                },
            };
        }
        self.session_states.insert(session_key.clone(), next);
        if let Some(terminal_run_id) = terminal_run_id.as_deref() {
            self.clear_session_trace_id(&session_key, Some(terminal_run_id));
        }
        result
    }

    pub(crate) fn apply_native_session_change(
        &mut self,
        provider: SessionProvider,
        binding: SessionSourceBinding,
        identity: Option<SessionIdentity>,
        run_id: Option<String>,
        native_cursor: Option<u64>,
        changes: Vec<SessionChange>,
    ) -> SessionApplyResult {
        let session_key = binding.session_key().to_owned();
        let state = match self.session_states.get(&session_key) {
            Some(state) if state.identity().provider() == provider => state,
            Some(_) => {
                return SessionApplyResult::Rejected {
                    reason: SessionApplyRejection::InvalidInput,
                };
            }
            None => {
                let Some(identity) = identity else {
                    return SessionApplyResult::Rejected {
                        reason: SessionApplyRejection::InvalidInput,
                    };
                };
                if identity.session_key() != session_key || identity.provider() != provider {
                    return SessionApplyResult::Rejected {
                        reason: SessionApplyRejection::InvalidInput,
                    };
                }
                let Ok(state) = SessionState::new(identity, self.session_epoch) else {
                    return SessionApplyResult::Rejected {
                        reason: SessionApplyRejection::InvalidInput,
                    };
                };
                return self.commit_native_session_change(
                    provider,
                    session_key,
                    state,
                    binding,
                    run_id,
                    native_cursor,
                    changes,
                );
            }
        };
        self.commit_native_session_change(
            provider,
            session_key,
            state.clone(),
            binding,
            run_id,
            native_cursor,
            changes,
        )
    }

    fn commit_native_session_change(
        &mut self,
        provider: SessionProvider,
        session_key: String,
        state: SessionState,
        binding: SessionSourceBinding,
        run_id: Option<String>,
        native_cursor: Option<u64>,
        changes: Vec<SessionChange>,
    ) -> SessionApplyResult {
        let source_epoch = binding.source_epoch();
        let mut next = state;
        let result = next.apply_native_bound(binding, run_id.clone(), native_cursor, changes);
        if provider == SessionProvider::MatchaAgent {
            self.trace_matcha_native_apply(
                &session_key,
                run_id.as_deref(),
                native_cursor,
                source_epoch,
                &result,
            );
        }
        let SessionApplyResult::Applied(delta) = &result else {
            return result;
        };
        let Some(sink) = self.event_sinks.session_delta() else {
            return SessionApplyResult::Rejected {
                reason: SessionApplyRejection::EventSinkUnavailable,
            };
        };
        if let Err(error) = sink.try_send(delta.clone()) {
            return SessionApplyResult::Rejected {
                reason: match error {
                    tokio::sync::mpsc::error::TrySendError::Full(_) => {
                        SessionApplyRejection::EventBackpressure
                    }
                    tokio::sync::mpsc::error::TrySendError::Closed(_) => {
                        SessionApplyRejection::EventSinkUnavailable
                    }
                },
            };
        }
        self.session_states.insert(session_key, next);
        result
    }

    pub(crate) fn apply_openclaw_canonical(
        &mut self,
        ingress: CanonicalIngressResult,
    ) -> SessionApplyResult {
        let (session_key, route_key, source_epoch, source_cursor, run_id, changes) = match ingress {
            CanonicalIngressResult::Produced(delta) => {
                let session_key = delta.session_key().as_str().to_owned();
                let route_key = delta.route_key().map(str::to_owned);
                let source_epoch = delta.source_epoch();
                let source_cursor = delta.source_cursor();
                let run_id = delta.run_id().map(|id| id.as_str().to_owned());
                let changes = openclaw_canonical_changes(
                    delta.changes(),
                    delta.run_id().map(|id| id.as_str()),
                );
                (
                    session_key,
                    route_key,
                    source_epoch,
                    source_cursor,
                    run_id,
                    changes,
                )
            }
            CanonicalIngressResult::Unknown { provenance } => {
                let session_key = provenance.session_key().as_str().to_owned();
                let route_key = provenance.route_key().map(str::to_owned);
                let source_epoch = provenance.source_epoch();
                let run_id = provenance.run_id().map(|id| id.as_str().to_owned());
                (
                    session_key,
                    route_key,
                    source_epoch,
                    provenance.source_cursor(),
                    run_id,
                    vec![SessionChange::RecoveryRequired {
                        reason: RecoveryReason::NativeUnknown,
                    }],
                )
            }
        };
        let binding = match SessionSourceBinding::new(session_key.clone(), route_key, source_epoch)
        {
            Some(binding) => binding,
            None => {
                return SessionApplyResult::Rejected {
                    reason: SessionApplyRejection::InvalidInput,
                };
            }
        };
        let identity = SessionIdentity::new(session_key, SessionProvider::OpenClaw, None);
        if self
            .session_states
            .get(binding.session_key())
            .is_some_and(|state| state.native_source_epoch_changed(&binding))
        {
            let recovery = self.apply_session_recovery(
                SessionProvider::OpenClaw,
                binding.clone(),
                identity.clone(),
                None,
                source_cursor,
                RecoveryReason::EpochChanged,
            );
            if !matches!(recovery, SessionApplyResult::Applied(_)) {
                return recovery;
            }
        }
        if let [SessionChange::RecoveryRequired { reason }] = changes.as_slice() {
            return self.apply_session_recovery(
                SessionProvider::OpenClaw,
                binding,
                identity,
                run_id,
                source_cursor,
                *reason,
            );
        }
        self.apply_native_session_change(
            SessionProvider::OpenClaw,
            binding,
            identity,
            run_id,
            source_cursor,
            changes,
        )
    }

    pub(crate) fn apply_session_recovery(
        &mut self,
        provider: SessionProvider,
        binding: SessionSourceBinding,
        identity: Option<SessionIdentity>,
        run_id: Option<String>,
        native_cursor: Option<u64>,
        reason: RecoveryReason,
    ) -> SessionApplyResult {
        self.apply_native_recovery_session_change(
            provider,
            binding,
            identity,
            run_id,
            native_cursor,
            reason,
        )
    }

    fn apply_native_recovery_session_change(
        &mut self,
        provider: SessionProvider,
        binding: SessionSourceBinding,
        identity: Option<SessionIdentity>,
        run_id: Option<String>,
        native_cursor: Option<u64>,
        reason: RecoveryReason,
    ) -> SessionApplyResult {
        let session_key = binding.session_key().to_owned();
        let state = match self.session_states.get(&session_key) {
            Some(state) if state.identity().provider() == provider => state.clone(),
            Some(_) => {
                return SessionApplyResult::Rejected {
                    reason: SessionApplyRejection::InvalidInput,
                };
            }
            None => {
                let Some(identity) = identity else {
                    return SessionApplyResult::Rejected {
                        reason: SessionApplyRejection::InvalidInput,
                    };
                };
                if identity.session_key() != session_key || identity.provider() != provider {
                    return SessionApplyResult::Rejected {
                        reason: SessionApplyRejection::InvalidInput,
                    };
                }
                let Ok(state) = SessionState::new(identity, self.session_epoch) else {
                    return SessionApplyResult::Rejected {
                        reason: SessionApplyRejection::InvalidInput,
                    };
                };
                state
            }
        };
        let source_epoch = binding.source_epoch();
        let mut next = state;
        let result =
            next.apply_native_recovery_bound(binding, run_id.clone(), native_cursor, reason);
        if provider == SessionProvider::MatchaAgent {
            self.trace_matcha_native_apply(
                &session_key,
                run_id.as_deref(),
                native_cursor,
                source_epoch,
                &result,
            );
        }
        let SessionApplyResult::Applied(delta) = &result else {
            return result;
        };
        let Some(sink) = self.event_sinks.session_delta() else {
            return SessionApplyResult::Rejected {
                reason: SessionApplyRejection::EventSinkUnavailable,
            };
        };
        if let Err(error) = sink.try_send(delta.clone()) {
            return SessionApplyResult::Rejected {
                reason: match error {
                    tokio::sync::mpsc::error::TrySendError::Full(_) => {
                        SessionApplyRejection::EventBackpressure
                    }
                    tokio::sync::mpsc::error::TrySendError::Closed(_) => {
                        SessionApplyRejection::EventSinkUnavailable
                    }
                },
            };
        }
        self.session_states.insert(session_key, next);
        result
    }

    pub(crate) fn session_view(&self, session_key: &str) -> Option<SessionView> {
        self.session_states.get(session_key).map(SessionState::view)
    }

    pub(crate) fn next_session_epoch(&mut self) -> u64 {
        self.session_epoch = self
            .session_epoch
            .checked_add(1)
            .filter(|epoch| *epoch != 0)
            .unwrap_or(1);
        self.session_epoch
    }

    pub(crate) fn session_epoch(&self) -> u64 {
        self.session_epoch
    }

    pub(crate) async fn abort_session(
        &mut self,
        command: SessionAbortCommand,
    ) -> SessionAbortOutcome {
        if self.admission.admit_request().is_err() {
            return SessionAbortOutcome::Unavailable;
        }
        match self.running_session_ops(command.endpoint.runtime_endpoint()) {
            Ok(ops) => ops.abort_session(command).await,
            Err(RuntimeOperationFailure::Unsupported) => SessionAbortOutcome::Unsupported,
            Err(RuntimeOperationFailure::Unavailable) => SessionAbortOutcome::Unavailable,
            Err(RuntimeOperationFailure::TargetRejected | RuntimeOperationFailure::Unknown) => {
                SessionAbortOutcome::Unknown
            }
        }
    }

    pub(crate) async fn create_session(
        &mut self,
        command: SessionCreateCommand,
    ) -> SessionCreateOutcome {
        if self.admission.admit_request().is_err() {
            return SessionCreateOutcome::Unknown;
        }
        let command = if command.endpoint_session_id_missing() {
            let Some(endpoint_session_id) = generated_endpoint_session_id() else {
                return SessionCreateOutcome::Unavailable;
            };
            match command.with_endpoint_session_id(endpoint_session_id) {
                Ok(command) => command,
                Err(_) => return SessionCreateOutcome::TargetRejected,
            }
        } else {
            command
        };
        let epoch = self.session_epoch();
        match self.running_session_ops(command.endpoint.runtime_endpoint()) {
            Ok(ops) => ops.create_session(command, epoch).await,
            Err(RuntimeOperationFailure::Unsupported | RuntimeOperationFailure::Unavailable) => {
                SessionCreateOutcome::Unknown
            }
            Err(RuntimeOperationFailure::TargetRejected) => SessionCreateOutcome::TargetRejected,
            Err(RuntimeOperationFailure::Unknown) => SessionCreateOutcome::Unknown,
        }
    }

    pub(crate) async fn rename_open_claw_session(
        &mut self,
        command: SessionRenameCommand,
    ) -> SessionRenameOutcome {
        if self.admission.admit_request().is_err() {
            return SessionRenameOutcome::Unknown;
        }
        match self.running_session_ops(Some(RuntimeDriverIdentity::open_claw().endpoint())) {
            Ok(ops) => ops.rename_session(command).await,
            Err(_) => SessionRenameOutcome::Unknown,
        }
    }

    pub(crate) async fn delete_open_claw_session(
        &mut self,
        command: SessionDeleteCommand,
    ) -> SessionDeleteOutcome {
        if self.admission.admit_request().is_err() {
            return SessionDeleteOutcome::Unknown;
        }
        match self.running_session_ops(Some(RuntimeDriverIdentity::open_claw().endpoint())) {
            Ok(ops) => ops.delete_session(command).await,
            Err(_) => SessionDeleteOutcome::Unknown,
        }
    }

    pub(crate) async fn pending_session_approvals(
        &mut self,
        command: PendingApprovalsCommand,
    ) -> PendingApprovalsOutcome {
        if self.admission.admit_request().is_err() {
            return PendingApprovalsOutcome::Unavailable;
        }
        match self.running_session_ops(command.endpoint.runtime_endpoint()) {
            Ok(ops) => ops.pending_approvals(command).await,
            Err(RuntimeOperationFailure::Unsupported) => PendingApprovalsOutcome::Unsupported,
            Err(RuntimeOperationFailure::Unavailable) => PendingApprovalsOutcome::Unavailable,
            Err(RuntimeOperationFailure::TargetRejected | RuntimeOperationFailure::Unknown) => {
                PendingApprovalsOutcome::Unavailable
            }
        }
    }

    pub(crate) async fn respond_to_session_approval(
        &mut self,
        command: SessionApprovalCommand,
    ) -> SessionApprovalOutcome {
        if self.admission.admit_request().is_err() {
            return SessionApprovalOutcome::Unavailable;
        }
        match self.running_session_ops(command.endpoint.runtime_endpoint()) {
            Ok(ops) => ops.respond_to_approval(command).await,
            Err(RuntimeOperationFailure::Unsupported) => SessionApprovalOutcome::Unsupported,
            Err(RuntimeOperationFailure::Unavailable) => SessionApprovalOutcome::Unavailable,
            Err(RuntimeOperationFailure::TargetRejected | RuntimeOperationFailure::Unknown) => {
                SessionApprovalOutcome::Unavailable
            }
        }
    }

    pub(crate) async fn send_session(&mut self, command: SessionSendCommand) -> SessionSendOutcome {
        if self.admission.admit_request().is_err() {
            return SessionSendOutcome::Unavailable;
        }
        let Some(endpoint) = command.endpoint.runtime_endpoint() else {
            return SessionSendOutcome::Unsupported;
        };
        let is_matcha = endpoint == self.matcha.endpoint();
        let is_openclaw = endpoint == self.open_claw.endpoint();
        let command = if is_matcha {
            match command.canonical_run_id().map(str::to_owned) {
                Some(run_id) => match command.with_resolved_run_id(run_id) {
                    Ok(command) => command,
                    Err(_) => return SessionSendOutcome::Rejected,
                },
                None => command,
            }
        } else {
            command
        };
        let session_key = command.session_key.clone();
        let route_key = command.route_key.clone();
        let trace_run_id = command.canonical_run_id().map(str::to_owned);
        let trace_id = command.trace_id().map(str::to_owned);
        if is_matcha {
            if let Some(run_id) = trace_run_id.as_deref() {
                self.register_session_trace_id(&session_key, run_id, trace_id.as_deref());
            }
        }
        let subscription = if is_matcha {
            let Some(run_id) = command.run_id.clone() else {
                return SessionSendOutcome::Rejected;
            };
            let Some(subscription) = self
                .subscribe_matcha_renderer_events(&session_key, &run_id, route_key.clone())
                .await
            else {
                return SessionSendOutcome::Unavailable;
            };
            Some((run_id, subscription))
        } else {
            None
        };
        let outcome = match self.running_session_ops(Some(endpoint)) {
            Ok(ops) => ops.send_session(command).await,
            Err(RuntimeOperationFailure::Unsupported) => SessionSendOutcome::Unsupported,
            Err(RuntimeOperationFailure::Unavailable) => SessionSendOutcome::Unavailable,
            Err(RuntimeOperationFailure::TargetRejected) => SessionSendOutcome::Rejected,
            Err(RuntimeOperationFailure::Unknown) => SessionSendOutcome::Unknown,
        };
        if is_openclaw {
            if let SessionSendOutcome::Queued { run_id } = &outcome {
                if let Some(trace_id) = trace_id.as_deref() {
                    self.register_session_trace_id(&session_key, run_id, Some(trace_id));
                }
                let Some(binding) =
                    SessionSourceBinding::new(session_key.clone(), Some(route_key.clone()), None)
                else {
                    return SessionSendOutcome::Rejected;
                };
                let _ = self.apply_native_session_change(
                    SessionProvider::OpenClaw,
                    binding,
                    SessionIdentity::new(session_key.clone(), SessionProvider::OpenClaw, None),
                    Some(run_id.clone()),
                    None,
                    vec![SessionChange::RunPhaseChanged {
                        run_id: run_id.clone(),
                        phase: RunPhase::Started,
                    }],
                );
            }
        }
        if let Some((run_id, subscription)) = subscription {
            match (
                matches!(outcome, SessionSendOutcome::Succeeded { .. }),
                subscription,
            ) {
                (true, MatchaRendererSubscription::Started(task)) => {
                    self.matcha_renderer_event_tasks
                        .push(MatchaRendererEventTask {
                            session_key: session_key.clone(),
                            run_id: run_id.clone(),
                            route_key,
                            trace_id: self
                                .session_trace_id(&session_key, Some(&run_id))
                                .map(str::to_owned),
                            task,
                        });
                }
                (false, MatchaRendererSubscription::Started(task)) => task.abort(),
                (_, MatchaRendererSubscription::Existing) => {}
            }
        }
        let outcome_run_id = match &outcome {
            SessionSendOutcome::Queued { run_id }
            | SessionSendOutcome::Succeeded { run_id, .. } => Some(run_id.as_str()),
            _ => trace_run_id.as_deref(),
        };
        if let Some(trace_id) = self
            .session_trace_id(&session_key, outcome_run_id)
            .map(str::to_owned)
        {
            session_trace::log(
                "runtime.session.send",
                Some(&trace_id),
                serde_json::json!({
                    "sessionKey": session_trace::id_shape(Some(&session_key)),
                    "runId": session_trace::id_shape(outcome_run_id),
                    "result": match &outcome {
                        SessionSendOutcome::Queued { .. } => "queued",
                        SessionSendOutcome::Succeeded { .. } => "succeeded",
                        SessionSendOutcome::Rejected => "rejected",
                        SessionSendOutcome::Unknown => "unknown",
                        SessionSendOutcome::Unsupported => "unsupported",
                        SessionSendOutcome::Unavailable => "unavailable",
                    },
                }),
            );
        }
        outcome
    }

    fn cancel_matcha_renderer_events(&mut self) {
        let source_epoch = self
            .matcha
            .peer_if_present()
            .map(MatchaPeer::advance_source_epoch);
        let tasks = self
            .matcha_renderer_event_tasks
            .drain(..)
            .collect::<Vec<_>>();
        let active_sessions = tasks
            .iter()
            .map(|task| task.session_key.clone())
            .collect::<BTreeSet<_>>();
        for task in tasks {
            task.task.abort();
            let Some(binding) = SessionSourceBinding::new(
                task.session_key.clone(),
                Some(task.route_key),
                source_epoch,
            ) else {
                continue;
            };
            let _ = self.apply_session_recovery(
                SessionProvider::MatchaAgent,
                binding,
                None,
                Some(task.run_id),
                None,
                RecoveryReason::EpochChanged,
            );
        }
        let session_keys = self
            .session_states
            .iter()
            .filter_map(|(session_key, state)| {
                (state.identity().provider() == SessionProvider::MatchaAgent
                    && !active_sessions.contains(session_key))
                .then(|| session_key.clone())
            })
            .collect::<Vec<_>>();
        for session_key in session_keys {
            let route_key = self
                .session_states
                .get(&session_key)
                .and_then(SessionState::source_route_key)
                .map(str::to_owned);
            let Some(binding) = SessionSourceBinding::new(session_key, route_key, source_epoch)
            else {
                continue;
            };
            let _ = self.apply_session_recovery(
                SessionProvider::MatchaAgent,
                binding,
                None,
                None,
                None,
                RecoveryReason::EpochChanged,
            );
        }
    }

    fn apply_matcha_session_recovery(&mut self, reason: RecoveryReason) -> SessionApplyResult {
        let session_keys = self
            .session_states
            .iter()
            .filter_map(|(session_key, state)| {
                (state.identity().provider() == SessionProvider::MatchaAgent)
                    .then(|| session_key.clone())
            })
            .collect::<Vec<_>>();
        for session_key in session_keys {
            let Some(binding) = SessionSourceBinding::new(session_key.clone(), None, None) else {
                return SessionApplyResult::Rejected {
                    reason: SessionApplyRejection::InvalidInput,
                };
            };
            let result = self.apply_session_recovery(
                SessionProvider::MatchaAgent,
                binding,
                None,
                None,
                None,
                reason,
            );
            match result {
                SessionApplyResult::Applied(_) | SessionApplyResult::Duplicate { .. } => {}
                rejection => return rejection,
            }
        }
        SessionApplyResult::Duplicate { cursor: 0 }
    }

    async fn subscribe_matcha_renderer_events(
        &mut self,
        session_key: &str,
        run_id: &str,
        route_key: String,
    ) -> Option<MatchaRendererSubscription> {
        self.retain_live_matcha_renderer_event_tasks();
        if self
            .matcha_renderer_event_tasks
            .iter()
            .any(|task| task.session_key == session_key && task.run_id == run_id)
        {
            return Some(MatchaRendererSubscription::Existing);
        }
        let session_id = MatchaSessionId::try_new(session_key).ok()?;
        let run_id = MatchaRunId::try_new(run_id).ok()?;
        let event_sink = self.event_sinks.matcha()?;
        self.matcha()
            .subscribe_renderer_events(session_id, run_id, route_key, event_sink)
            .await
            .ok()
            .map(MatchaRendererSubscription::Started)
    }

    pub(crate) async fn select_session_model(
        &mut self,
        command: SessionModelSelectionCommand,
    ) -> SessionModelSelectionOutcome {
        if self.admission.admit_request().is_err() {
            return SessionModelSelectionOutcome::Unavailable;
        }
        let Some(endpoint) = command.endpoint.runtime_endpoint() else {
            return SessionModelSelectionOutcome::Unsupported;
        };
        if let Err(failure) = self.running_session_ops(Some(endpoint.clone())).map(|_| ()) {
            return match failure {
                RuntimeOperationFailure::Unsupported => SessionModelSelectionOutcome::Unsupported,
                RuntimeOperationFailure::Unavailable => SessionModelSelectionOutcome::Unavailable,
                RuntimeOperationFailure::TargetRejected => {
                    SessionModelSelectionOutcome::target_rejected(
                        SessionModelSelectionRejection::RuntimeTargetRejected,
                    )
                }
                RuntimeOperationFailure::Unknown => SessionModelSelectionOutcome::OutcomeUnknown,
            };
        }
        let command = match self.resolve_session_model_selection(command) {
            Ok(command) => command,
            Err(outcome) => return outcome,
        };
        let diagnostic = command.diagnostic.clone();
        match self.running_session_ops(Some(endpoint)) {
            Ok(ops) => ops
                .select_session_model(command)
                .await
                .with_diagnostic(diagnostic),
            Err(RuntimeOperationFailure::Unsupported) => SessionModelSelectionOutcome::Unsupported,
            Err(RuntimeOperationFailure::Unavailable) => SessionModelSelectionOutcome::Unavailable,
            Err(RuntimeOperationFailure::TargetRejected) => {
                SessionModelSelectionOutcome::target_rejected(
                    SessionModelSelectionRejection::RuntimeTargetRejected,
                )
            }
            Err(RuntimeOperationFailure::Unknown) => SessionModelSelectionOutcome::OutcomeUnknown,
        }
    }

    fn resolve_session_model_selection(
        &mut self,
        command: SessionModelSelectionCommand,
    ) -> Result<ResolvedSessionModelSelection, SessionModelSelectionOutcome> {
        let model_selection_id = command.model_selection_id.clone();
        if self.provider_models.reload().is_err() {
            return Err(SessionModelSelectionOutcome::Unavailable);
        }
        let model = self
            .provider_models
            .resolve_selection(ProviderModelCapability::Chat, &model_selection_id)
            .map_err(|_| SessionModelSelectionOutcome::Unavailable)?
            .ok_or(SessionModelSelectionOutcome::target_rejected(
                SessionModelSelectionRejection::ModelSelectionNotFound,
            ))?;
        let binding = match command.endpoint {
            crate::session_model_selection::NativeEndpoint::OpenClawLocal => {
                let model_ref = self
                    .provider_models
                    .openclaw_model_ref(&model)
                    .map_err(|_| SessionModelSelectionOutcome::Unavailable)?;
                let model =
                    openclaw::session::protocol::ModelRef::try_new(model_ref).map_err(|_| {
                        SessionModelSelectionOutcome::target_rejected_with_diagnostic(
                            SessionModelSelectionRejection::OpenClawModelRefInvalid,
                            Some(model.diagnostic()),
                        )
                    })?;
                SessionModelSelectionBinding::OpenClaw(model)
            }
            crate::session_model_selection::NativeEndpoint::MatchaAgentLocal => {
                let matcha_binding =
                    self.provider_models
                        .matcha_model_binding(&model)
                        .map_err(|_| {
                            SessionModelSelectionOutcome::target_rejected_with_diagnostic(
                                SessionModelSelectionRejection::MatchaProviderRuntimeUnavailable,
                                Some(model.diagnostic()),
                            )
                        })?;
                SessionModelSelectionBinding::Matcha {
                    model: matcha_binding.model,
                    provider_fingerprint: matcha_binding.provider_fingerprint,
                    provider_runtime: matcha_binding.provider_runtime,
                }
            }
            crate::session_model_selection::NativeEndpoint::Unsupported => {
                return Err(SessionModelSelectionOutcome::Unsupported);
            }
        };
        Ok(ResolvedSessionModelSelection {
            endpoint: command.endpoint,
            session_key: command.session_key,
            binding,
            diagnostic: Some(model.diagnostic()),
        })
    }

    pub async fn send_open_claw_chat(
        &mut self,
        params: ChatSendParams,
    ) -> Result<
        InvocationOutcome<ChatSendResult, OpenClawSessionError>,
        RuntimeSessionError<OpenClawSessionError>,
    > {
        self.admission
            .admit_request()
            .map_err(RuntimeSessionError::AdmissionClosed)?;
        self.running_session_ops(Some(RuntimeDriverIdentity::open_claw().endpoint()))
            .map_err(|_| RuntimeSessionError::RuntimeUnavailable)?
            .send_open_claw_chat(params)
            .await
    }

    pub async fn abort_open_claw_chat(
        &mut self,
        params: ChatAbortParams,
    ) -> Result<
        InvocationOutcome<ChatAbortResult, OpenClawSessionError>,
        RuntimeSessionError<OpenClawSessionError>,
    > {
        self.admission
            .admit_request()
            .map_err(RuntimeSessionError::AdmissionClosed)?;
        self.running_session_ops(Some(RuntimeDriverIdentity::open_claw().endpoint()))
            .map_err(|_| RuntimeSessionError::RuntimeUnavailable)?
            .abort_open_claw_chat(params)
            .await
    }

    /// Private typed seam for Fleet terminal session lifecycle.
    pub(crate) fn fleet_terminal_open_allocated(
        &mut self,
        selector: crate::fleet::owner::FleetTerminalTargetSelector,
        dimensions: fleet::terminal::Dimensions,
    ) -> Result<crate::fleet::owner::FleetTerminalOpenResult, fleet::terminal::TerminalSessionError>
    {
        self.fleet
            .terminal_open_allocated(&selector, dimensions, std::time::SystemTime::now())
    }

    pub(crate) fn fleet_terminal_reconnect(
        &mut self,
        session: fleet::terminal::SessionId,
    ) -> Result<fleet::terminal::OpenedSession, fleet::terminal::TerminalSessionError> {
        self.fleet
            .terminal_reconnect(session, std::time::SystemTime::now())
    }

    pub(crate) fn fleet_terminal_begin_close(
        &mut self,
        session: fleet::terminal::SessionId,
        generation: fleet::terminal::Generation,
    ) -> Result<fleet::terminal::SessionSummary, fleet::terminal::TerminalSessionError> {
        self.fleet
            .terminal_begin_close(&session, generation, std::time::SystemTime::now())
    }

    pub(crate) fn fleet_terminal_begin_close_current(
        &mut self,
        session: fleet::terminal::SessionId,
    ) -> Result<fleet::terminal::SessionSummary, fleet::terminal::TerminalSessionError> {
        let generation = self
            .fleet
            .terminal_list()
            .into_iter()
            .find(|summary| summary.id() == &session)
            .map(|summary| summary.generation())
            .ok_or(fleet::terminal::TerminalSessionError::NotFound)?;
        self.fleet
            .terminal_begin_close(&session, generation, std::time::SystemTime::now())
    }

    pub(crate) fn fleet_terminal_finish_close(
        &mut self,
        session: fleet::terminal::SessionId,
        generation: fleet::terminal::Generation,
    ) -> Result<fleet::terminal::SessionSummary, fleet::terminal::TerminalSessionError> {
        self.fleet
            .terminal_finish_close(&session, generation, std::time::SystemTime::now())
    }

    pub(crate) fn fleet_terminal_finish_close_current(
        &mut self,
        session: fleet::terminal::SessionId,
    ) -> Result<fleet::terminal::SessionSummary, fleet::terminal::TerminalSessionError> {
        let generation = self
            .fleet
            .terminal_list()
            .into_iter()
            .find(|summary| summary.id() == &session)
            .map(|summary| summary.generation())
            .ok_or(fleet::terminal::TerminalSessionError::NotFound)?;
        self.fleet
            .terminal_finish_close(&session, generation, std::time::SystemTime::now())
    }

    pub(crate) fn fleet_terminal_list(&self) -> Vec<fleet::terminal::SessionSummary> {
        self.fleet.terminal_list()
    }

    pub(crate) fn fleet_terminal_consume_ticket(
        &mut self,
        ticket: Vec<u8>,
    ) -> Result<fleet::terminal::SessionSummary, fleet::terminal::TerminalSessionError> {
        self.fleet
            .terminal_consume_ticket(&ticket, std::time::SystemTime::now())
    }

    pub(crate) async fn fleet_terminal_provider_open(
        &mut self,
        context: crate::transport::fleet_terminal::TerminalContext,
    ) -> Result<crate::transport::fleet_terminal::TerminalProviderOpen, ()> {
        self.fleet.terminal_provider_open(context).await
    }

    pub(crate) fn fleet_terminal_context(
        &self,
        summary: fleet::terminal::SessionSummary,
    ) -> Option<crate::transport::fleet_terminal::TerminalContext> {
        self.fleet.terminal_context(&summary)
    }

    pub(crate) fn fleet_terminal_resolve_context(
        &self,
        selector: crate::fleet::owner::FleetTerminalTargetSelector,
        summary: fleet::terminal::SessionSummary,
    ) -> Option<crate::transport::fleet_terminal::TerminalContext> {
        self.fleet.resolve_terminal_context(&selector, &summary)
    }

    pub(crate) fn fleet_terminal_close(
        &mut self,
        session: fleet::terminal::SessionId,
        generation: fleet::terminal::Generation,
    ) -> Result<fleet::terminal::SessionSummary, fleet::terminal::TerminalSessionError> {
        self.fleet
            .terminal_close(&session, generation, std::time::SystemTime::now())
    }

    pub(crate) fn fleet_terminal_close_current(
        &mut self,
        session: fleet::terminal::SessionId,
    ) -> Result<fleet::terminal::SessionSummary, fleet::terminal::TerminalSessionError> {
        let generation = self
            .fleet
            .terminal_list()
            .into_iter()
            .find(|summary| summary.id() == &session)
            .map(|summary| summary.generation())
            .ok_or(fleet::terminal::TerminalSessionError::NotFound)?;
        self.fleet
            .terminal_close(&session, generation, std::time::SystemTime::now())
    }

    /// Private typed seam for Organization's durable TeamRun creation.
    pub(crate) fn fleet_query_snapshot(
        &self,
        now: std::time::SystemTime,
    ) -> fleet::query::FleetQuerySnapshot {
        self.fleet.query_snapshot(now)
    }

    pub(crate) fn fleet_snapshot(
        &self,
        now: std::time::SystemTime,
    ) -> crate::fleet::owner::FleetSnapshot {
        self.fleet.snapshot(now)
    }

    pub(crate) fn fleet_selector_preview(
        &self,
        constraints: fleet::query::SelectorConstraints,
        now: std::time::SystemTime,
    ) -> fleet::query::SelectorPreview {
        self.fleet.selector_preview(constraints, now)
    }

    pub(crate) fn fleet_target_summaries(&self) -> Vec<crate::fleet::owner::FleetTargetSummary> {
        self.fleet.target_summaries()
    }

    pub(crate) fn fleet_target_selector(
        &self,
        id: &fleet::TargetId,
        revision: u64,
        kind: fleet::TargetKind,
    ) -> Option<fleet::FleetTargetSelector> {
        self.fleet.target_selector(id, revision, kind)
    }

    pub(crate) fn fleet_topology_summary(&self) -> crate::fleet::owner::FleetTopologySummary {
        self.fleet.topology_summary()
    }

    pub(crate) fn fleet_put_target(
        &mut self,
        id: fleet::TargetId,
        config: fleet::FleetTargetConfig,
    ) -> Result<fleet::TargetSnapshot, fleet::FleetDeliveryError> {
        self.fleet.put_target(id, config)
    }

    pub(crate) fn fleet_remove_target(
        &mut self,
        id: &fleet::TargetId,
    ) -> Result<bool, fleet::FleetDeliveryError> {
        self.fleet.remove_target(id)
    }

    pub(crate) fn fleet_submit(
        &mut self,
        request: fleet::FleetDeliveryRequest,
        at: std::time::SystemTime,
    ) -> Result<fleet::FleetSubmitOutcome, fleet::FleetDeliveryError> {
        self.fleet.submit(request, at)
    }

    pub(crate) fn fleet_node_command_request(
        &self,
        request: crate::fleet::owner::FleetNodeCommandRequest,
        queued_at: std::time::SystemTime,
    ) -> Result<crate::fleet::owner::FleetNodeCommandResolution, fleet::FleetDeliveryError> {
        self.fleet.node_command_request(request, queued_at)
    }

    pub(crate) fn fleet_start_dispatch_operation(
        &mut self,
        dispatch_id: fleet::outbox::DispatchId,
        reply: tokio::sync::oneshot::Sender<
            Result<crate::fleet::owner::FleetDispatchResult, fleet::FleetDeliveryError>,
        >,
    ) {
        self.reap_finished_fleet_operations();
        if self.fleet_operation_count() >= FLEET_OPERATION_CAPACITY {
            let _ = reply.send(Err(fleet::FleetDeliveryError::AlreadyInFlight));
            return;
        }
        let Ok(mut owner) = self.fleet.operation_owner() else {
            let _ = reply.send(Err(fleet::FleetDeliveryError::InvalidTransition));
            return;
        };
        let (operation, _) = OperationHandle::spawn(move |_| async move {
            let result = owner
                .dispatch(&dispatch_id, std::time::SystemTime::now())
                .await;
            let _ = reply.send(result.clone());
            result
        });
        self.fleet_dispatch_operations
            .push(FleetOperation { operation });
    }

    pub(crate) fn fleet_accept(
        &mut self,
        dispatch_id: &fleet::outbox::DispatchId,
        attempt: &fleet::outbox::DispatchAttempt,
        at: std::time::SystemTime,
    ) -> Result<fleet::FleetDeliveryOutcome, fleet::FleetDeliveryError> {
        self.fleet.accept(dispatch_id, attempt, at)
    }

    pub(crate) fn fleet_reject(
        &mut self,
        dispatch_id: &fleet::outbox::DispatchId,
        attempt: &fleet::outbox::DispatchAttempt,
        at: std::time::SystemTime,
    ) -> Result<fleet::FleetDeliveryOutcome, fleet::FleetDeliveryError> {
        self.fleet.reject(dispatch_id, attempt, at)
    }

    pub(crate) fn fleet_unknown(
        &mut self,
        dispatch_id: &fleet::outbox::DispatchId,
        attempt: &fleet::outbox::DispatchAttempt,
        at: std::time::SystemTime,
    ) -> Result<fleet::FleetDeliveryOutcome, fleet::FleetDeliveryError> {
        self.fleet.mark_unknown(dispatch_id, attempt, at)
    }

    pub(crate) fn fleet_replay(
        &mut self,
        command_id: &fleet::command::CommandId,
        dispatch_id: &fleet::outbox::DispatchId,
        at: std::time::SystemTime,
    ) -> Result<fleet::FleetDeliveryOutcome, fleet::FleetDeliveryError> {
        self.fleet.authorize_replay(command_id, dispatch_id, at)
    }

    pub(crate) fn fleet_upsert_connection(
        &mut self,
        record: fleet::connection::ConnectionRecord,
    ) -> Result<fleet::connection::ConnectionMutation, fleet::FleetDeliveryError> {
        self.fleet
            .upsert_connection(record, std::time::SystemTime::now())
    }
    pub(crate) fn fleet_delete_connection(
        &mut self,
        id: fleet::connection::ConnectionId,
    ) -> Result<fleet::connection::ConnectionMutation, fleet::FleetDeliveryError> {
        self.fleet
            .delete_connection(&id, std::time::SystemTime::now())
    }
    pub(crate) fn fleet_register_environment(
        &mut self,
        record: fleet::environment::EnvironmentRecord,
    ) -> Result<fleet::environment::EnvironmentMutation, fleet::FleetDeliveryError> {
        self.fleet
            .register_environment(record, std::time::SystemTime::now())
    }
    pub(crate) fn fleet_start_resource_registration_operation(
        &mut self,
        request: crate::owner::ManagedResourceRegistrationRequest,
        reply: tokio::sync::oneshot::Sender<
            Result<fleet::environment::ManagedResourceMutation, fleet::FleetDeliveryError>,
        >,
    ) {
        self.reap_finished_fleet_operations();
        if self.fleet_operation_count() >= FLEET_OPERATION_CAPACITY {
            let _ = reply.send(Err(fleet::FleetDeliveryError::AlreadyInFlight));
            return;
        }
        let Ok(mut owner) = self.fleet.operation_owner() else {
            let _ = reply.send(Err(fleet::FleetDeliveryError::InvalidTransition));
            return;
        };
        let (operation, _) = OperationHandle::spawn(move |_| async move {
            let result = owner.register_source_backed_resource(request).await;
            let _ = reply.send(result.clone());
            result
        });
        self.fleet_resource_registration_operations
            .push(FleetOperation { operation });
    }
    pub(crate) fn fleet_begin_connection_probe(
        &mut self,
        id: fleet::connection::ConnectionId,
        command_id: fleet::command::CommandId,
    ) -> Result<fleet::connection::ConnectionMutation, fleet::FleetDeliveryError> {
        self.fleet
            .begin_connection_probe(&id, command_id, std::time::SystemTime::now())
    }
    pub(crate) fn fleet_start_connection_probe_operation(
        &mut self,
        id: fleet::connection::ConnectionId,
        command_id: fleet::command::CommandId,
        reply: tokio::sync::oneshot::Sender<
            Result<
                crate::fleet::lifecycle::FleetConnectionLifecycleOutcome,
                fleet::FleetDeliveryError,
            >,
        >,
    ) {
        self.reap_finished_fleet_operations();
        if self.fleet_operation_count() >= FLEET_OPERATION_CAPACITY {
            let _ = reply.send(Err(fleet::FleetDeliveryError::AlreadyInFlight));
            return;
        }
        let Ok(mut owner) = self.fleet.operation_owner() else {
            let _ = reply.send(Err(fleet::FleetDeliveryError::InvalidTransition));
            return;
        };
        let (operation, _) = OperationHandle::spawn(move |_| async move {
            let result = crate::fleet::lifecycle::FleetLifecycleOrchestrator::new(&mut owner)
                .probe_connection(id, command_id, std::time::SystemTime::now())
                .await;
            let _ = reply.send(result.clone());
            result
        });
        self.fleet_connection_operations
            .push(FleetOperation { operation });
    }

    fn start_fleet_lifecycle_operation<F, U>(
        &mut self,
        reply: tokio::sync::oneshot::Sender<
            Result<crate::fleet::lifecycle::FleetLifecycleOutcome, fleet::FleetDeliveryError>,
        >,
        run: F,
    ) where
        F: FnOnce(crate::fleet::owner::FleetOwner) -> U + Send + 'static,
        U: std::future::Future<
                Output = Result<
                    crate::fleet::lifecycle::FleetLifecycleOutcome,
                    fleet::FleetDeliveryError,
                >,
            > + Send
            + 'static,
    {
        self.reap_finished_fleet_operations();
        if self.fleet_operation_count() >= FLEET_OPERATION_CAPACITY {
            let _ = reply.send(Err(fleet::FleetDeliveryError::AlreadyInFlight));
            return;
        }
        let Ok(owner) = self.fleet.operation_owner() else {
            let _ = reply.send(Err(fleet::FleetDeliveryError::InvalidTransition));
            return;
        };
        let (operation, _) = OperationHandle::spawn(move |_| async move {
            let result = run(owner).await;
            let _ = reply.send(result.clone());
            result
        });
        self.fleet_lifecycle_operations
            .push(FleetOperation { operation });
    }

    fn reap_finished_fleet_operations(&mut self) {
        let mut refreshed = false;
        let pending_connection = self
            .fleet_connection_operations
            .drain(..)
            .filter(|operation| {
                let finished = operation.operation.is_finished();
                refreshed |= finished;
                !finished
            })
            .collect();
        self.fleet_connection_operations = pending_connection;

        let pending_lifecycle = self
            .fleet_lifecycle_operations
            .drain(..)
            .filter(|operation| {
                let finished = operation.operation.is_finished();
                refreshed |= finished;
                !finished
            })
            .collect();
        self.fleet_lifecycle_operations = pending_lifecycle;

        let pending_dispatch = self
            .fleet_dispatch_operations
            .drain(..)
            .filter(|operation| {
                let finished = operation.operation.is_finished();
                refreshed |= finished;
                !finished
            })
            .collect();
        self.fleet_dispatch_operations = pending_dispatch;

        let pending_registration = self
            .fleet_resource_registration_operations
            .drain(..)
            .filter(|operation| {
                let finished = operation.operation.is_finished();
                refreshed |= finished;
                !finished
            })
            .collect();
        self.fleet_resource_registration_operations = pending_registration;

        if refreshed {
            let _ = self.fleet.refresh_from_store();
        }
    }

    pub(crate) fn reap_fleet_operations(&mut self) {
        self.reap_finished_fleet_operations();
    }

    pub(crate) async fn cancel_fleet_operations(&mut self) {
        for operation in &self.fleet_connection_operations {
            operation.operation.cancel();
        }
        for operation in &self.fleet_lifecycle_operations {
            operation.operation.cancel();
        }
        for operation in &self.fleet_dispatch_operations {
            operation.operation.cancel();
        }
        for operation in &self.fleet_resource_registration_operations {
            operation.operation.cancel();
        }
        for mut operation in self.fleet_connection_operations.drain(..) {
            let _ = operation.operation.join().await;
        }
        for mut operation in self.fleet_lifecycle_operations.drain(..) {
            let _ = operation.operation.join().await;
        }
        for mut operation in self.fleet_dispatch_operations.drain(..) {
            let _ = operation.operation.join().await;
        }
        for mut operation in self.fleet_resource_registration_operations.drain(..) {
            let _ = operation.operation.join().await;
        }
        let _ = self.fleet.refresh_from_store();
    }

    fn fleet_operation_count(&self) -> usize {
        self.fleet_connection_operations.len()
            + self.fleet_lifecycle_operations.len()
            + self.fleet_dispatch_operations.len()
            + self.fleet_resource_registration_operations.len()
    }

    pub(crate) fn fleet_complete_connection_probe(
        &mut self,
        id: fleet::connection::ConnectionId,
        command_id: fleet::command::CommandId,
        outcome: fleet::connection::ProbeOutcome,
        message: Option<String>,
    ) -> Result<fleet::connection::ConnectionMutation, fleet::FleetDeliveryError> {
        self.fleet.complete_connection_probe(
            &id,
            &command_id,
            outcome,
            std::time::SystemTime::now(),
            message,
        )
    }
    pub(crate) fn fleet_retire_node(
        &mut self,
        id: fleet::topology::NodeId,
    ) -> Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError> {
        self.fleet.retire_node(&id, std::time::SystemTime::now())
    }
    pub(crate) fn fleet_begin_runtime_start(
        &mut self,
        id: fleet::topology::RuntimeId,
        command_id: fleet::command::CommandId,
    ) -> Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError> {
        self.fleet
            .begin_runtime_start(&id, command_id, std::time::SystemTime::now())
    }
    pub(crate) fn fleet_complete_runtime_start(
        &mut self,
        id: fleet::topology::RuntimeId,
        command_id: fleet::command::CommandId,
    ) -> Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError> {
        self.fleet
            .complete_runtime_start(&id, &command_id, std::time::SystemTime::now())
    }
    pub(crate) fn fleet_begin_runtime_stop(
        &mut self,
        id: fleet::topology::RuntimeId,
        command_id: fleet::command::CommandId,
    ) -> Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError> {
        self.fleet
            .begin_runtime_stop(&id, command_id, std::time::SystemTime::now())
    }
    pub(crate) fn fleet_complete_runtime_stop(
        &mut self,
        id: fleet::topology::RuntimeId,
        command_id: fleet::command::CommandId,
    ) -> Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError> {
        self.fleet
            .complete_runtime_stop(&id, &command_id, std::time::SystemTime::now())
    }
    pub(crate) fn fleet_retire_runtime(
        &mut self,
        id: fleet::topology::RuntimeId,
    ) -> Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError> {
        self.fleet.retire_runtime(&id, std::time::SystemTime::now())
    }
    pub(crate) fn fleet_drain_endpoint(
        &mut self,
        id: platform::endpoint::EndpointId,
    ) -> Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError> {
        self.fleet.drain_endpoint(&id, std::time::SystemTime::now())
    }
    pub(crate) fn fleet_retire_endpoint(
        &mut self,
        id: platform::endpoint::EndpointId,
    ) -> Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError> {
        self.fleet
            .retire_endpoint(&id, std::time::SystemTime::now())
    }
    pub(crate) fn fleet_begin_endpoint_probe(
        &mut self,
        id: platform::endpoint::EndpointId,
        command_id: fleet::command::CommandId,
    ) -> Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError> {
        self.fleet
            .begin_endpoint_probe(&id, command_id, std::time::SystemTime::now())
    }
    pub(crate) fn fleet_complete_endpoint_probe(
        &mut self,
        id: platform::endpoint::EndpointId,
        command_id: fleet::command::CommandId,
        health: fleet::topology::EndpointHealth,
    ) -> Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError> {
        self.fleet
            .complete_endpoint_probe(&id, &command_id, health, std::time::SystemTime::now())
    }
    pub(crate) fn fleet_begin_capability_sync(
        &mut self,
        id: platform::endpoint::EndpointId,
        command_id: fleet::command::CommandId,
    ) -> Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError> {
        self.fleet
            .begin_capability_sync(&id, command_id, std::time::SystemTime::now())
    }
    pub(crate) fn fleet_complete_capability_sync(
        &mut self,
        id: platform::endpoint::EndpointId,
        command_id: fleet::command::CommandId,
        sync: fleet::topology::CapabilitySync,
    ) -> Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError> {
        self.fleet
            .complete_capability_sync(&id, &command_id, sync, std::time::SystemTime::now())
    }

    pub(crate) fn fleet_upsert_node(
        &mut self,
        observation: fleet::topology::NodeObservation,
    ) -> Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError> {
        self.fleet
            .upsert_node(observation, std::time::SystemTime::now())
    }
    pub(crate) fn fleet_upsert_agent(
        &mut self,
        observation: fleet::topology::AgentObservation,
    ) -> Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError> {
        self.fleet
            .upsert_agent(observation, std::time::SystemTime::now())
    }
    pub(crate) fn fleet_write_credential(
        &mut self,
        request: crate::fleet::credentials::FleetCredentialWriteRequest,
    ) -> Result<
        crate::fleet::credentials::FleetCredentialWriteOutcome,
        crate::fleet::credentials::FleetCredentialVaultError,
    > {
        self.fleet.write_credential(request)
    }

    pub(crate) fn fleet_revoke_agent(
        &mut self,
        id: platform::endpoint::NativeAgentId,
    ) -> Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError> {
        self.fleet.revoke_agent(&id, std::time::SystemTime::now())
    }
    pub(crate) fn fleet_upsert_runtime(
        &mut self,
        observation: fleet::topology::RuntimeObservation,
    ) -> Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError> {
        self.fleet
            .upsert_runtime(observation, std::time::SystemTime::now())
    }
    pub(crate) fn fleet_upsert_endpoint(
        &mut self,
        observation: fleet::topology::EndpointObservation,
    ) -> Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError> {
        self.fleet
            .upsert_endpoint(observation, std::time::SystemTime::now())
    }

    pub(crate) fn fleet_authenticate_runtime_agent_ingress(
        &mut self,
        identity: fleet::store::AgentIngressIdentity,
    ) -> Result<fleet::store::IngressAuthentication, fleet::FleetDeliveryError> {
        self.fleet.authenticate_runtime_agent_ingress(identity)
    }
    pub(crate) fn fleet_register_runtime_agent(
        &mut self,
        agent: fleet::runtime_agent::RuntimeAgent,
    ) -> Result<(), fleet::FleetDeliveryError> {
        self.fleet.register_runtime_agent(agent)
    }
    pub(crate) fn fleet_register_runtime_agent_command(
        &mut self,
        agent_id: fleet::runtime_agent::RuntimeAgentId,
        correlation: fleet::runtime_agent::CommandCorrelation,
        queued_at: std::time::SystemTime,
        command_attempt: fleet::command::CommandAttempt,
        dispatch_attempt: fleet::outbox::DispatchAttempt,
    ) -> Result<(), fleet::FleetDeliveryError> {
        self.fleet.register_runtime_agent_command(
            &agent_id,
            correlation,
            queued_at,
            command_attempt,
            dispatch_attempt,
        )
    }
    pub(crate) fn fleet_record_runtime_agent_heartbeat(
        &mut self,
        agent_id: fleet::runtime_agent::RuntimeAgentId,
        heartbeat: fleet::runtime_agent::RuntimeAgentHeartbeat,
    ) -> Result<fleet::runtime_agent::RuntimeAgentReportOutcome, fleet::FleetDeliveryError> {
        self.fleet
            .record_runtime_agent_heartbeat(&agent_id, heartbeat)
    }
    pub(crate) fn fleet_record_runtime_agent_progress(
        &mut self,
        agent_id: fleet::runtime_agent::RuntimeAgentId,
        correlation: fleet::runtime_agent::CommandCorrelation,
        progress: fleet::runtime_agent::RuntimeAgentProgress,
        reported_at: std::time::SystemTime,
        command_attempt: fleet::command::CommandAttempt,
        dispatch_attempt: fleet::outbox::DispatchAttempt,
    ) -> Result<fleet::runtime_agent::RuntimeAgentReportOutcome, fleet::FleetDeliveryError> {
        self.fleet.record_runtime_agent_progress(
            &agent_id,
            &correlation,
            progress,
            reported_at,
            &command_attempt,
            &dispatch_attempt,
        )
    }
    pub(crate) fn fleet_record_runtime_agent_result(
        &mut self,
        agent_id: fleet::runtime_agent::RuntimeAgentId,
        correlation: fleet::runtime_agent::CommandCorrelation,
        result: fleet::runtime_agent::RuntimeAgentResult,
        command_attempt: fleet::command::CommandAttempt,
        dispatch_attempt: fleet::outbox::DispatchAttempt,
    ) -> Result<fleet::runtime_agent::RuntimeAgentReportOutcome, fleet::FleetDeliveryError> {
        self.fleet.record_runtime_agent_result(
            &agent_id,
            &correlation,
            result,
            &command_attempt,
            &dispatch_attempt,
        )
    }

    pub(crate) fn fleet_start_environment_deployment_operation(
        &mut self,
        id: fleet::environment::EnvironmentId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
        reply: tokio::sync::oneshot::Sender<
            Result<crate::fleet::lifecycle::FleetLifecycleOutcome, fleet::FleetDeliveryError>,
        >,
    ) {
        self.start_fleet_lifecycle_operation(reply, move |mut owner| async move {
            let target = owner
                .environment_target_resolution(&id)
                .ok_or(fleet::FleetDeliveryError::InvalidTransition)?;
            crate::fleet::lifecycle::FleetLifecycleOrchestrator::new(&mut owner)
                .deploy_environment(id, command_id, phase, target, std::time::SystemTime::now())
                .await
                .map(|(_, outcome)| outcome)
        });
    }
    pub(crate) fn fleet_start_environment_deletion_operation(
        &mut self,
        id: fleet::environment::EnvironmentId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
        reply: tokio::sync::oneshot::Sender<
            Result<crate::fleet::lifecycle::FleetLifecycleOutcome, fleet::FleetDeliveryError>,
        >,
    ) {
        self.start_fleet_lifecycle_operation(reply, move |mut owner| async move {
            let target = owner
                .environment_target_resolution(&id)
                .ok_or(fleet::FleetDeliveryError::InvalidTransition)?;
            crate::fleet::lifecycle::FleetLifecycleOrchestrator::new(&mut owner)
                .delete_environment(id, command_id, phase, target, std::time::SystemTime::now())
                .await
                .map(|(_, outcome)| outcome)
        });
    }
    pub(crate) fn fleet_start_resource_provisioning_operation(
        &mut self,
        id: fleet::environment::ManagedResourceId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
        reply: tokio::sync::oneshot::Sender<
            Result<crate::fleet::lifecycle::FleetLifecycleOutcome, fleet::FleetDeliveryError>,
        >,
    ) {
        self.start_fleet_lifecycle_operation(reply, move |mut owner| async move {
            let target = owner
                .resource_target_resolution(&id)
                .ok_or(fleet::FleetDeliveryError::InvalidTransition)?;
            crate::fleet::lifecycle::FleetLifecycleOrchestrator::new(&mut owner)
                .provision_resource(id, command_id, phase, target, std::time::SystemTime::now())
                .await
                .map(|(_, outcome)| outcome)
        });
    }
    pub(crate) fn fleet_start_resource_deletion_operation(
        &mut self,
        id: fleet::environment::ManagedResourceId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
        reply: tokio::sync::oneshot::Sender<
            Result<crate::fleet::lifecycle::FleetLifecycleOutcome, fleet::FleetDeliveryError>,
        >,
    ) {
        self.start_fleet_lifecycle_operation(reply, move |mut owner| async move {
            let target = owner
                .resource_target_resolution(&id)
                .ok_or(fleet::FleetDeliveryError::InvalidTransition)?;
            crate::fleet::lifecycle::FleetLifecycleOrchestrator::new(&mut owner)
                .delete_resource(id, command_id, phase, target, std::time::SystemTime::now())
                .await
                .map(|(_, outcome)| outcome)
        });
    }

    pub(crate) fn fleet_begin_environment_deployment(
        &mut self,
        id: fleet::environment::EnvironmentId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
    ) -> Result<fleet::environment::EnvironmentMutation, fleet::FleetDeliveryError> {
        self.fleet.start_environment_deployment(
            &id,
            command_id,
            phase,
            std::time::SystemTime::now(),
        )
    }
    pub(crate) fn fleet_complete_environment_deployment(
        &mut self,
        id: fleet::environment::EnvironmentId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
    ) -> Result<fleet::environment::EnvironmentMutation, fleet::FleetDeliveryError> {
        self.fleet.complete_environment_deployment(
            &id,
            &command_id,
            &phase,
            std::time::SystemTime::now(),
        )
    }
    pub(crate) fn fleet_fail_environment_deployment(
        &mut self,
        id: fleet::environment::EnvironmentId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
        message: String,
    ) -> Result<fleet::environment::EnvironmentMutation, fleet::FleetDeliveryError> {
        self.fleet.fail_environment_deployment(
            &id,
            &command_id,
            &phase,
            message,
            std::time::SystemTime::now(),
        )
    }
    pub(crate) fn fleet_begin_environment_deletion(
        &mut self,
        id: fleet::environment::EnvironmentId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
    ) -> Result<fleet::environment::EnvironmentMutation, fleet::FleetDeliveryError> {
        self.fleet
            .start_environment_deletion(&id, command_id, phase, std::time::SystemTime::now())
    }
    pub(crate) fn fleet_complete_environment_deletion(
        &mut self,
        id: fleet::environment::EnvironmentId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
    ) -> Result<fleet::environment::EnvironmentMutation, fleet::FleetDeliveryError> {
        self.fleet.complete_environment_deletion(
            &id,
            &command_id,
            &phase,
            std::time::SystemTime::now(),
        )
    }
    pub(crate) fn fleet_fail_environment_deletion(
        &mut self,
        id: fleet::environment::EnvironmentId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
        message: String,
    ) -> Result<fleet::environment::EnvironmentMutation, fleet::FleetDeliveryError> {
        self.fleet.fail_environment_deletion(
            &id,
            &command_id,
            &phase,
            message,
            std::time::SystemTime::now(),
        )
    }
    pub(crate) fn fleet_start_resource_provisioning(
        &mut self,
        id: fleet::environment::ManagedResourceId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
    ) -> Result<fleet::environment::ManagedResourceMutation, fleet::FleetDeliveryError> {
        self.fleet
            .start_resource_provisioning(&id, command_id, phase, std::time::SystemTime::now())
    }
    pub(crate) fn fleet_fail_resource_provisioning(
        &mut self,
        id: fleet::environment::ManagedResourceId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
        message: String,
    ) -> Result<fleet::environment::ManagedResourceMutation, fleet::FleetDeliveryError> {
        self.fleet.fail_resource_provisioning(
            &id,
            &command_id,
            &phase,
            message,
            std::time::SystemTime::now(),
        )
    }
    pub(crate) fn fleet_complete_resource_provisioning(
        &mut self,
        id: fleet::environment::ManagedResourceId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
    ) -> Result<fleet::environment::ManagedResourceMutation, fleet::FleetDeliveryError> {
        self.fleet.complete_resource_provisioning(
            &id,
            &command_id,
            &phase,
            std::time::SystemTime::now(),
        )
    }
    pub(crate) fn fleet_start_resource_deletion(
        &mut self,
        id: fleet::environment::ManagedResourceId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
    ) -> Result<fleet::environment::ManagedResourceMutation, fleet::FleetDeliveryError> {
        self.fleet
            .start_resource_deletion(&id, command_id, phase, std::time::SystemTime::now())
    }
    pub(crate) fn fleet_complete_resource_deletion(
        &mut self,
        id: fleet::environment::ManagedResourceId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
    ) -> Result<fleet::environment::ManagedResourceMutation, fleet::FleetDeliveryError> {
        self.fleet.complete_resource_deletion(
            &id,
            &command_id,
            &phase,
            std::time::SystemTime::now(),
        )
    }
    pub(crate) fn fleet_fail_resource_deletion(
        &mut self,
        id: fleet::environment::ManagedResourceId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
        message: String,
    ) -> Result<fleet::environment::ManagedResourceMutation, fleet::FleetDeliveryError> {
        self.fleet.fail_resource_deletion(
            &id,
            &command_id,
            &phase,
            message,
            std::time::SystemTime::now(),
        )
    }

    pub(crate) async fn create_team_run_for_team(
        &mut self,
        team_id: TeamId,
        run_id: organization::GraphRunId,
        idempotency_key: String,
        workflow_plan: organization::WorkflowPlan,
        source_identity: String,
        template_revision: u64,
        created_at: u64,
    ) -> Result<organization::CreateGraphRunOutcome, StoreFault> {
        self.organization_store.create_workflow_plan_run(
            team_id,
            run_id,
            &idempotency_key,
            workflow_plan,
            source_identity,
            template_revision,
            created_at,
        )
    }

    pub(crate) fn begin_manual_team_materialization(
        &mut self,
        input: team::ManualTeamMaterializationInput,
    ) -> Result<
        (
            TeamId,
            organization::TeamMaterializationRequest,
            organization::GraphRunFacts,
            String,
        ),
        ManualTeamCreateOutcome,
    > {
        if self.admission.admit_request().is_err() {
            return Err(ManualTeamCreateOutcome::Unavailable);
        }
        let team::ManualTeamMaterializationInput {
            team_id,
            team_name,
            endpoint,
            roles,
            materialization_idempotency_key,
            run,
            run_idempotency_key,
        } = input;
        let materialization = organization::compile_manual_team_materialization(
            team_id,
            team_name,
            endpoint,
            roles,
            materialization_idempotency_key,
        )
        .map_err(|_| ManualTeamCreateOutcome::Rejected)?;
        let team_id = materialization.definition().team_id().clone();
        let request = materialization.request().clone();
        match self
            .organization_store
            .create_team_materialization(materialization)
        {
            Ok(MaterializationRecordOutcome::Recorded) => {
                Ok((team_id, request, run, run_idempotency_key))
            }
            Ok(MaterializationRecordOutcome::Replayed) => {
                Err(ManualTeamCreateOutcome::OutcomeUnknown)
            }
            Err(_) => Err(ManualTeamCreateOutcome::Unavailable),
        }
    }

    pub(crate) fn complete_manual_team_materialization(
        &mut self,
        team_id: &TeamId,
        run: organization::GraphRunFacts,
        run_idempotency_key: &str,
        outcome: organization::MaterializationOperationOutcome,
    ) -> Result<
        (
            organization::CreateGraphRunOutcome,
            organization::RunRuntimeReceipt,
        ),
        ManualTeamCreateOutcome,
    > {
        if self
            .organization_store
            .record_team_materialization_outcome(team_id, outcome.clone())
            .is_err()
        {
            return Err(ManualTeamCreateOutcome::Unavailable);
        }
        if !matches!(
            outcome,
            organization::MaterializationOperationOutcome::Confirmed { .. }
        ) {
            return Err(manual_materialization_outcome(outcome));
        }
        let run_id = run.run_id().clone();
        let created = self
            .team_run
            .create(&mut self.organization_store, run, run_idempotency_key)
            .map_err(|_| ManualTeamCreateOutcome::Unavailable)?;
        if matches!(
            created,
            organization::CreateGraphRunOutcome::ConflictingIdempotency
        ) {
            return Err(ManualTeamCreateOutcome::Unavailable);
        }
        let receipt = team::prepare_runtime_receipt(&self.organization_store, team_id, &run_id)
            .map_err(manual_runtime_receipt_outcome)?;
        Ok((created, receipt))
    }

    pub(crate) fn install_manual_team_run_runtime_receipt(
        &mut self,
        created: organization::CreateGraphRunOutcome,
        receipt: organization::RunRuntimeReceipt,
        outcome: team::RuntimeReceiptOutcome,
    ) -> ManualTeamCreateOutcome {
        match outcome {
            team::RuntimeReceiptOutcome::Installed => {
                team::install_prepared_runtime_receipt(&mut self.organization_store, receipt)
                    .map_or(ManualTeamCreateOutcome::Unavailable, |_| {
                        ManualTeamCreateOutcome::Created(created)
                    })
            }
            outcome => manual_runtime_receipt_outcome(outcome),
        }
    }

    pub(crate) async fn materialize_manual_team_and_create_run(
        &mut self,
        input: team::ManualTeamMaterializationInput,
    ) -> ManualTeamCreateOutcome {
        let (team_id, request, run, run_idempotency_key) =
            match self.begin_manual_team_materialization(input) {
                Ok(start) => start,
                Err(outcome) => return outcome,
            };
        let outcome = self.team_materialize(request).await;
        let (created, receipt) = match self.complete_manual_team_materialization(
            &team_id,
            run,
            &run_idempotency_key,
            outcome,
        ) {
            Ok(result) => result,
            Err(outcome) => return outcome,
        };
        let outcome = self.team_confirm_receipt(receipt.clone()).await;
        self.install_manual_team_run_runtime_receipt(created, receipt, outcome)
    }

    async fn recover_team_materialization_receipts(&mut self) {
        for team_id in self
            .organization_store
            .materialization_receipt_recovery_teams()
        {
            if self
                .organization_store
                .facts()
                .materialization(&team_id)
                .is_some()
            {
                continue;
            }
            let Some(request) = self
                .organization_store
                .team_materialization_recovery_request(&team_id)
            else {
                continue;
            };
            let Ok(ops) = self.team_ops_for_endpoint(request.intent().endpoint()) else {
                continue;
            };
            let outcome = ops.recover_team_materialization(request).await;
            let organization::MaterializationOperationOutcome::Confirmed { receipt } = outcome
            else {
                continue;
            };
            let _ = self
                .organization_store
                .confirm_team_materialization(receipt);
        }
    }

    pub(crate) fn list_team_runs(
        &self,
        team_id: &organization::TeamId,
    ) -> Vec<TeamRunQueryOutcome> {
        self.team_run.list(&self.organization_store, team_id)
    }

    pub(crate) fn query_team_role_sessions(
        &self,
        team_id: &organization::TeamId,
    ) -> organization::TeamRoleSessionQueryOutcome {
        organization::query_team_role_sessions(self.organization_store.facts(), team_id)
    }

    pub(crate) fn resume_team_runs(
        &self,
        team_id: &organization::TeamId,
    ) -> Vec<organization::ResumeOutcome> {
        self.team_run.resume(&self.organization_store, team_id)
    }

    pub(crate) fn query_team_graph_context(
        &self,
        query: &TeamGraphContextQuery,
    ) -> TeamGraphContextResult {
        organization::query_team_graph_context(self.organization_store.facts(), query)
    }

    pub(crate) fn query_team_run_retry_due(
        &self,
        query: &NodePromptRetryDueQuery,
    ) -> NodePromptRetryDueQueryOutcome {
        self.team_run.retry_due(&self.organization_store, query)
    }

    pub(crate) fn query_team_run_recovery(
        &self,
        run_id: &organization::GraphRunId,
    ) -> Result<TeamRunRecoveryPlan, RecoveryQueryError> {
        organization::query_team_run_recovery(self.organization_store.facts(), run_id.clone(), None)
    }

    pub(crate) fn query_organization_recovery(
        &self,
    ) -> Result<organization::OrganizationRecoveryPlan, RecoveryQueryError> {
        organization::plan_organization_recovery(self.organization_store.facts())
    }

    pub(crate) fn apply_organization_recovery(
        &mut self,
        observed_at: u64,
    ) -> Result<organization::OrganizationRecoveryApply, OrganizationRecoveryApplyError> {
        self.admission.admit_request()?;
        let mut facts = self.organization_store.facts().clone();
        let apply = organization::apply_organization_recovery(&mut facts, observed_at)?;
        self.organization_store.replace_facts(facts)?;
        Ok(apply)
    }

    pub(crate) fn active_team_run_ids_for_team(
        &self,
        team_id: &TeamId,
    ) -> Vec<organization::GraphRunId> {
        self.organization_store
            .facts()
            .runs()
            .filter(|run| run.team() == team_id)
            .map(|run| run.run_id().clone())
            .collect()
    }

    pub(crate) fn complete_team_delete_removal(
        &mut self,
        team_id: &TeamId,
        idempotency_key: &str,
        outcome: Option<organization::MaterializationOperationOutcome>,
    ) -> Result<team::TeamDeleteOutcome, StoreFault> {
        let cleanup_key = IdempotencyKey::try_new(idempotency_key.to_owned())
            .map_err(|_| StoreFault::InvalidFacts)?;
        self.organization_store
            .tombstone_team(team_id, cleanup_key)?;
        if self
            .organization_store
            .team_materialization_cleanup_confirmed(team_id)
        {
            return Ok(team::TeamDeleteOutcome::Deleted);
        }
        let Some(outcome) = outcome else {
            return Ok(team::TeamDeleteOutcome::OutcomeUnknown);
        };
        self.organization_store
            .record_team_materialization_cleanup_outcome(team_id, outcome.clone())?;
        Ok(match outcome {
            organization::MaterializationOperationOutcome::Confirmed { .. } => {
                team::TeamDeleteOutcome::Deleted
            }
            organization::MaterializationOperationOutcome::Accepted { .. }
            | organization::MaterializationOperationOutcome::Rejected { .. }
            | organization::MaterializationOperationOutcome::OutcomeUnknown => {
                team::TeamDeleteOutcome::OutcomeUnknown
            }
        })
    }

    pub(crate) fn team_materialization_removal(
        &self,
        team_id: &TeamId,
    ) -> Option<organization::TeamMaterializationRemoval> {
        self.organization_store
            .team_materialization_removal(team_id)
    }

    pub(crate) fn begin_team_run_cancellation(
        &mut self,
        run_id: &organization::GraphRunId,
        idempotency_key: &str,
        requested_at: u64,
    ) -> Result<organization::BeginCancellationOutcome, StoreFault> {
        self.team_run.begin_cancellation(
            &mut self.organization_store,
            run_id,
            idempotency_key,
            requested_at,
        )
    }

    pub(crate) fn settle_team_run_cancellation_outcome(
        &mut self,
        run_id: &organization::GraphRunId,
        idempotency_key: &str,
        outcome: organization::RoleAbortOutcome,
        observed_at: u64,
    ) -> Result<organization::BeginCancellationOutcome, StoreFault> {
        team::settle_public_cancellation(
            &mut self.organization_store,
            &self.team_run,
            run_id,
            idempotency_key,
            outcome,
            observed_at,
        )
    }

    pub(crate) fn settle_team_run_cancellation_raw(
        &mut self,
        run_id: &organization::GraphRunId,
        idempotency_key: &str,
        outcome: organization::RoleAbortOutcome,
        observed_at: u64,
    ) -> Result<organization::SettleCancellationOutcome, StoreFault> {
        self.team_run.settle_cancellation(
            &mut self.organization_store,
            run_id,
            idempotency_key,
            outcome,
            observed_at,
        )
    }

    pub(crate) fn team_run_bindings(
        &self,
        run_id: &organization::GraphRunId,
    ) -> Vec<organization::RoleSessionReceipt> {
        self.organization_store
            .facts()
            .run(run_id)
            .and_then(|run| run.runtime())
            .map(|runtime| runtime.bindings().to_vec())
            .unwrap_or_default()
    }

    pub(crate) fn complete_team_run_delete_native_evidence(
        &mut self,
        run_id: organization::GraphRunId,
        idempotency_key: &str,
        native: organization::NativeDeletionEvidence,
        observed_at: u64,
    ) -> Result<organization::GraphRunPurgeOutcome, StoreFault> {
        if matches!(native, organization::NativeDeletionEvidence::Confirmed(_)) {
            match self.team_run.settle_cancellation(
                &mut self.organization_store,
                &run_id,
                idempotency_key,
                organization::RoleAbortOutcome::Confirmed,
                observed_at,
            )? {
                organization::SettleCancellationOutcome::Cancelled
                | organization::SettleCancellationOutcome::Replayed
                | organization::SettleCancellationOutcome::Tombstoned => {}
                organization::SettleCancellationOutcome::OutcomeUnknown => {
                    return Ok(organization::GraphRunPurgeOutcome::OutcomeUnknown(
                        organization::GraphRunPurgeUnknown::NativeDeletionOutcomeUnknown,
                    ));
                }
            }
            match self.team_run.tombstone(
                &mut self.organization_store,
                &run_id,
                idempotency_key,
                observed_at,
            )? {
                organization::TombstoneOutcome::Tombstoned
                | organization::TombstoneOutcome::Replayed => {}
                organization::TombstoneOutcome::CancellationRequired(_)
                | organization::TombstoneOutcome::OutcomeUnknown => {
                    return Ok(organization::GraphRunPurgeOutcome::OutcomeUnknown(
                        organization::GraphRunPurgeUnknown::NativeDeletionOutcomeUnknown,
                    ));
                }
            }
        } else {
            let _ = self.team_run.settle_cancellation(
                &mut self.organization_store,
                &run_id,
                idempotency_key,
                organization::RoleAbortOutcome::OutcomeUnknown,
                observed_at,
            )?;
        }
        self.team_run.purge(
            &mut self.organization_store,
            organization::TeamRunPurgeRequest::new(run_id, idempotency_key.to_owned(), native),
        )
    }

    pub(crate) fn tombstone_team_run(
        &mut self,
        run_id: &organization::GraphRunId,
        idempotency_key: &str,
        tombstoned_at: u64,
    ) -> Result<organization::TombstoneOutcome, StoreFault> {
        self.team_run.tombstone(
            &mut self.organization_store,
            run_id,
            idempotency_key,
            tombstoned_at,
        )
    }

    pub(crate) async fn materialize_team_skill_selection(
        &mut self,
        selection_id: TeamSkillSelectionId,
        team_id: TeamId,
        idempotency_key: IdempotencyKey,
    ) -> TeamMaterializationCommandOutcome {
        let materialization =
            match self.compile_team_skill_materialization(selection_id, team_id, idempotency_key) {
                Ok(materialization) => materialization,
                Err(crate::owner::TeamRuntimeStatus::Rejected) => {
                    return TeamMaterializationCommandOutcome::Rejected;
                }
                Err(
                    crate::owner::TeamRuntimeStatus::OutcomeUnknown
                    | crate::owner::TeamRuntimeStatus::Unavailable,
                ) => {
                    return TeamMaterializationCommandOutcome::Unavailable;
                }
            };
        self.materialize_team_skill_materialization(materialization)
            .await
    }

    fn compile_team_skill_materialization(
        &self,
        selection_id: TeamSkillSelectionId,
        team_id: TeamId,
        idempotency_key: IdempotencyKey,
    ) -> Result<organization::TeamMaterialization, crate::owner::TeamRuntimeStatus> {
        let endpoint = RuntimeEndpointReference::try_new(
            RuntimeDriverIdentity::open_claw().runtime_endpoint_reference(),
        )
        .expect("fixed OpenClaw endpoint must be valid");
        self.team_skill_selections
            .with_package(&selection_id, |package| {
                organization::compile_team_skill_materialization(
                    package,
                    team_id,
                    endpoint,
                    idempotency_key,
                )
            })
            .map_err(|error| match error {
                TeamSkillSelectionError::InvalidSelection => {
                    crate::owner::TeamRuntimeStatus::Rejected
                }
                TeamSkillSelectionError::Unavailable => {
                    crate::owner::TeamRuntimeStatus::Unavailable
                }
            })?
            .map_err(|_| crate::owner::TeamRuntimeStatus::Rejected)
    }

    pub(crate) fn begin_team_skill_materialization(
        &mut self,
        selection_id: TeamSkillSelectionId,
        team_id: TeamId,
        idempotency_key: IdempotencyKey,
    ) -> Result<(TeamId, organization::TeamMaterializationRequest), TeamMaterializationCommandOutcome>
    {
        let materialization = self
            .compile_team_skill_materialization(selection_id, team_id, idempotency_key)
            .map_err(|error| match error {
                crate::owner::TeamRuntimeStatus::Rejected => {
                    TeamMaterializationCommandOutcome::Rejected
                }
                crate::owner::TeamRuntimeStatus::OutcomeUnknown
                | crate::owner::TeamRuntimeStatus::Unavailable => {
                    TeamMaterializationCommandOutcome::Unavailable
                }
            })?;
        self.begin_team_materialization(materialization)
    }

    fn begin_team_materialization(
        &mut self,
        materialization: organization::TeamMaterialization,
    ) -> Result<(TeamId, organization::TeamMaterializationRequest), TeamMaterializationCommandOutcome>
    {
        let team = materialization.definition().team_id().clone();
        let request = materialization.request().clone();
        match self
            .organization_store
            .create_team_materialization(materialization)
        {
            Ok(MaterializationRecordOutcome::Recorded) => Ok((team, request)),
            // A durable request without a receipt may have reached OpenClaw before an
            // earlier caller stopped. Never issue that materialization a second time.
            Ok(MaterializationRecordOutcome::Replayed) => {
                Err(TeamMaterializationCommandOutcome::OutcomeUnknown)
            }
            Err(_) => Err(TeamMaterializationCommandOutcome::Unavailable),
        }
    }

    pub(crate) fn settle_team_materialization_outcome(
        &mut self,
        team: &TeamId,
        outcome: organization::MaterializationOperationOutcome,
    ) -> TeamMaterializationCommandOutcome {
        self.organization_store
            .record_team_materialization_outcome(team, outcome.clone())
            .map_or(
                TeamMaterializationCommandOutcome::Unavailable,
                |_| match outcome {
                    organization::MaterializationOperationOutcome::Confirmed { .. } => {
                        TeamMaterializationCommandOutcome::Materialized
                    }
                    organization::MaterializationOperationOutcome::Rejected { .. } => {
                        TeamMaterializationCommandOutcome::Rejected
                    }
                    organization::MaterializationOperationOutcome::Accepted { .. }
                    | organization::MaterializationOperationOutcome::OutcomeUnknown => {
                        TeamMaterializationCommandOutcome::OutcomeUnknown
                    }
                },
            )
    }

    async fn materialize_team_skill_materialization(
        &mut self,
        materialization: organization::TeamMaterialization,
    ) -> TeamMaterializationCommandOutcome {
        let (team, request) = match self.begin_team_materialization(materialization) {
            Ok(start) => start,
            Err(outcome) => return outcome,
        };
        let outcome = self.team_materialize(request).await;
        self.settle_team_materialization_outcome(&team, outcome)
    }

    pub(crate) async fn create_team_skill_run(
        &mut self,
        selection_id: TeamSkillSelectionId,
        team_id: TeamId,
        run_id: organization::GraphRunId,
        idempotency_key: IdempotencyKey,
        created_at: u64,
    ) -> Result<organization::CreateGraphRunOutcome, crate::owner::TeamRuntimeStatus> {
        if self.admission.admit_request().is_err() {
            return Err(crate::owner::TeamRuntimeStatus::Unavailable);
        }
        let (materialized_team, request) = self
            .begin_team_skill_materialization(
                selection_id,
                team_id.clone(),
                idempotency_key.clone(),
            )
            .map_err(team_materialization_status)?;
        if materialized_team != team_id {
            return Err(crate::owner::TeamRuntimeStatus::Rejected);
        }
        let outcome = self.team_materialize(request).await;
        match self.settle_team_materialization_outcome(&team_id, outcome) {
            TeamMaterializationCommandOutcome::Materialized => {}
            TeamMaterializationCommandOutcome::Rejected => {
                return Err(crate::owner::TeamRuntimeStatus::Rejected);
            }
            TeamMaterializationCommandOutcome::OutcomeUnknown => {
                return Err(crate::owner::TeamRuntimeStatus::OutcomeUnknown);
            }
            TeamMaterializationCommandOutcome::Unavailable => {
                return Err(crate::owner::TeamRuntimeStatus::Unavailable);
            }
        }
        let (created, receipt) = self.prepare_team_run_from_existing_team_receipt(
            &team_id,
            run_id,
            idempotency_key.as_str(),
            created_at,
        )?;
        let outcome = self.team_confirm_receipt(receipt.clone()).await;
        self.install_team_run_runtime_receipt(created, receipt, outcome)
    }

    pub(crate) async fn create_team_run_from_existing_team(
        &mut self,
        team_id: &TeamId,
        run_id: organization::GraphRunId,
        idempotency_key: &str,
        created_at: u64,
    ) -> Result<organization::CreateGraphRunOutcome, crate::owner::TeamRuntimeStatus> {
        if self.admission.admit_request().is_err() {
            return Err(crate::owner::TeamRuntimeStatus::Unavailable);
        }
        let (created, receipt) = self.prepare_team_run_from_existing_team_receipt(
            team_id,
            run_id,
            idempotency_key,
            created_at,
        )?;
        let outcome = self.team_confirm_receipt(receipt.clone()).await;
        self.install_team_run_runtime_receipt(created, receipt, outcome)
    }

    pub(crate) fn prepare_team_run_from_existing_team_receipt(
        &mut self,
        team_id: &TeamId,
        run_id: organization::GraphRunId,
        idempotency_key: &str,
        created_at: u64,
    ) -> Result<
        (
            organization::CreateGraphRunOutcome,
            organization::RunRuntimeReceipt,
        ),
        crate::owner::TeamRuntimeStatus,
    > {
        if self.admission.admit_request().is_err() {
            return Err(crate::owner::TeamRuntimeStatus::Unavailable);
        }
        let run = self
            .team_run
            .run_from_team_template(
                &self.organization_store,
                team_id,
                run_id.clone(),
                idempotency_key,
                created_at,
            )
            .map_err(|_| crate::owner::TeamRuntimeStatus::Rejected)?;
        let created = self
            .team_run
            .create(&mut self.organization_store, run, idempotency_key)
            .map_err(|_| crate::owner::TeamRuntimeStatus::Unavailable)?;
        if matches!(
            created,
            organization::CreateGraphRunOutcome::ConflictingIdempotency
        ) {
            return Err(crate::owner::TeamRuntimeStatus::Unavailable);
        }
        let receipt = team::prepare_runtime_receipt(&self.organization_store, team_id, &run_id)
            .map_err(runtime_receipt_status)?;
        Ok((created, receipt))
    }

    pub(crate) fn install_team_run_runtime_receipt(
        &mut self,
        created: organization::CreateGraphRunOutcome,
        receipt: organization::RunRuntimeReceipt,
        outcome: team::RuntimeReceiptOutcome,
    ) -> Result<organization::CreateGraphRunOutcome, crate::owner::TeamRuntimeStatus> {
        match outcome {
            team::RuntimeReceiptOutcome::Installed => {
                team::install_prepared_runtime_receipt(&mut self.organization_store, receipt)
                    .map_err(|_| crate::owner::TeamRuntimeStatus::Unavailable)?;
                Ok(created)
            }
            team::RuntimeReceiptOutcome::Rejected => Err(crate::owner::TeamRuntimeStatus::Rejected),
            team::RuntimeReceiptOutcome::OutcomeUnknown => {
                Err(crate::owner::TeamRuntimeStatus::OutcomeUnknown)
            }
            team::RuntimeReceiptOutcome::Unavailable => {
                Err(crate::owner::TeamRuntimeStatus::Unavailable)
            }
        }
    }

    pub(crate) fn authorize_team_skill_selection(
        &mut self,
        package_root: PathBuf,
    ) -> Result<TeamSkillSelectionId, TeamSkillSelectionError> {
        self.team_skill_selections.authorize(package_root)
    }

    pub(crate) fn validate_team_skill_selection(
        &self,
        selection_id: TeamSkillSelectionId,
    ) -> TeamSkillPackageValidation {
        self.team_skill_selections.validate(&selection_id)
    }

    pub(crate) async fn plan_team_skill_dependencies(
        &mut self,
        selection_id: TeamSkillSelectionId,
    ) -> TeamSkillDependencyPlanResult {
        let catalog = match self.open_claw_installed_skill_catalog().await {
            Some(catalog) => catalog,
            None => return TeamSkillDependencyPlanResult::Unavailable,
        };
        self.plan_team_skill_dependencies_from_catalog(selection_id, catalog)
    }

    pub(crate) fn plan_team_skill_dependencies_from_catalog(
        &self,
        selection_id: TeamSkillSelectionId,
        catalog: openclaw::skill::InstalledSkillCatalog,
    ) -> TeamSkillDependencyPlanResult {
        let catalog =
            TeamSkillDependencyCatalog::from_installed_names(catalog.names().iter().cloned());
        self.team_skill_selections
            .dependency_plan(&selection_id, &catalog)
    }

    pub(crate) fn query_team_public_projection(
        &self,
        team_id: &organization::TeamId,
        run_id: &organization::GraphRunId,
    ) -> organization::run::public_projection::TeamPublicQueryOutcome {
        organization::run::public_projection::query_team_public_projection(
            self.organization_store.facts(),
            team_id,
            run_id,
        )
    }

    pub(crate) fn query_team_run_public_snapshot(
        &self,
        request: &organization::run::public_projection::TeamRunPublicSnapshotRequest,
    ) -> organization::run::public_projection::TeamRunPublicSnapshotQueryOutcome {
        organization::run::public_projection::produce_team_run_public_snapshot(
            self.organization_store.facts(),
            request,
        )
    }

    pub(crate) fn query_team_run_public_snapshot_for_run(
        &self,
        run_id: &organization::GraphRunId,
        event_cursor: u64,
        event_limit: Option<u64>,
    ) -> Result<
        organization::run::public_projection::TeamRunPublicSnapshotQueryOutcome,
        organization::run::public_projection::TeamRunPublicSnapshotRequestError,
    > {
        organization::run::public_projection::produce_team_run_public_snapshot_for_run(
            self.organization_store.facts(),
            run_id,
            event_cursor,
            event_limit,
        )
    }

    pub(crate) fn query_team_run_diagnostics_for_run(
        &self,
        run_id: &organization::GraphRunId,
    ) -> organization::TeamRunDiagnosticsQueryOutcome {
        let Some(run) = self.organization_store.facts().run(run_id) else {
            return organization::TeamRunDiagnosticsQueryOutcome::Unavailable(
                organization::TeamRunDiagnosticsUnavailableReason::MissingRun,
            );
        };
        organization::query_team_run_diagnostics(
            self.organization_store.facts(),
            run.team(),
            run_id,
        )
    }

    pub(crate) fn task_board_read(
        &self,
        team_id: &organization::TeamId,
        run_id: &organization::GraphRunId,
    ) -> organization::run::task_board::TaskBoardFacts {
        self.organization_store.task_board().scoped(team_id, run_id)
    }

    pub(crate) fn task_board_mutate(
        &mut self,
        team_id: organization::TeamId,
        run_id: organization::GraphRunId,
        operation: crate::transport::team_task_board::Operation,
    ) -> Result<crate::transport::team_task_board::MutationResult, organization::StoreFault> {
        use crate::transport::team_task_board::{MutationResult, Operation};

        let result = self
            .organization_store
            .task_board_mutate(|board| match operation {
                Operation::ClaimNext {
                    agent_id,
                    session,
                    lease_seconds,
                    now,
                } => organization::run::task_board::claim_next(
                    board,
                    &team_id,
                    &run_id,
                    &agent_id,
                    &session,
                    lease_seconds,
                    now,
                )
                .map(|task_id| MutationResult::ClaimNext { task_id }),
                Operation::Heartbeat {
                    task_id,
                    agent_id,
                    session,
                    lease_seconds,
                    now,
                } => organization::run::task_board::heartbeat(
                    board,
                    &team_id,
                    &run_id,
                    &task_id,
                    &agent_id,
                    &session,
                    lease_seconds,
                    now,
                )
                .map(|_| MutationResult::Changed),
                Operation::Release {
                    task_id,
                    agent_id,
                    session,
                    now,
                } => organization::run::task_board::release(
                    board, &team_id, &run_id, &task_id, &agent_id, &session, now,
                )
                .map(|_| MutationResult::Changed),
                Operation::Transition {
                    task_id,
                    next,
                    agent,
                    summary,
                    error,
                    now,
                } => organization::run::task_board::transition(
                    board,
                    &team_id,
                    &run_id,
                    &task_id,
                    next,
                    agent
                        .as_ref()
                        .map(|(agent_id, session)| (agent_id.as_str(), session.as_str())),
                    summary,
                    error,
                    now,
                )
                .map(|_| MutationResult::Changed),
                Operation::StartRunner {
                    runner_id,
                    session,
                    now,
                } => organization::run::task_board::start_runner(
                    board, &team_id, &run_id, &runner_id, &session, now,
                )
                .map(|_| MutationResult::Changed),
                Operation::PauseRunner {
                    runner_id,
                    session,
                    now,
                } => organization::run::task_board::pause_runner(
                    board, &team_id, &run_id, &runner_id, &session, now,
                )
                .map(|_| MutationResult::Changed),
                Operation::CloseRunner {
                    runner_id,
                    session,
                    now,
                } => organization::run::task_board::close_runner(
                    board, &team_id, &run_id, &runner_id, &session, now,
                )
                .map(|_| MutationResult::Changed),
                Operation::ReclaimExpired { now } => Ok(MutationResult::Reclaimed {
                    count: organization::run::task_board::reclaim_expired(board, now),
                }),
                Operation::PostMailbox { message } => {
                    if message.team_id() != &team_id || message.run_id() != &run_id {
                        return Err(organization::run::task_board::TaskBoardError::InvalidIdentity);
                    }
                    organization::run::task_board::post(board, message)
                        .map(|posted| MutationResult::Posted { posted })
                }
                Operation::PullMailbox { cursor, limit } => organization::run::task_board::pull(
                    board,
                    &team_id,
                    &run_id,
                    cursor.as_deref(),
                    limit,
                )
                .map(|(messages, next_cursor)| MutationResult::Messages {
                    messages,
                    next_cursor,
                }),
                Operation::UpsertPlan {
                    plan,
                    now,
                    fingerprint,
                } => {
                    if plan
                        .iter()
                        .any(|entry| entry.team_id != team_id || entry.run_id != run_id)
                    {
                        return Err(organization::run::task_board::TaskBoardError::InvalidIdentity);
                    }
                    organization::run::task_board::upsert_plan(board, plan, now, &fingerprint)
                        .map(|task_ids| MutationResult::Plan { task_ids })
                }
            })
            .map_err(|_| organization::StoreFault::InvalidFacts);
        result
    }

    pub(crate) fn query_team_pending_approvals(
        &self,
        team_id: &organization::TeamId,
        run_id: &organization::GraphRunId,
    ) -> organization::run::TeamPendingApprovalsQueryOutcome {
        organization::run::query_team_pending_approvals(
            self.organization_store.facts(),
            team_id,
            run_id,
        )
    }

    pub(crate) fn resolve_team_human_decision(
        &mut self,
        command: organization::run::approval::HumanDecisionCommand,
    ) -> Result<organization::run::approval::HumanDecisionOutcome, StoreFault> {
        self.organization_store.resolve_human_decision(command)
    }

    pub(crate) fn submit_team_decision(
        &mut self,
        command: TeamDecisionCommand,
    ) -> Result<TeamDecisionReceipt, StoreFault> {
        self.organization_store.record_decision(command)
    }

    pub(crate) fn record_team_node_event(
        &mut self,
        command: RunCommand,
        event: TeamNodeEvent,
    ) -> Result<TeamNodeEventOutcome, StoreFault> {
        self.organization_store.team_node_event(command, event)
    }

    pub(crate) fn settle_team_node_prompt(
        &mut self,
        session_key: &str,
        prompt_run_id: &str,
        phase: organization::NativeTerminalStatus,
        settled_at: u64,
    ) -> Result<crate::composition::TeamNodePromptSettledResult, StoreFault> {
        self.team_run.settle_node_prompt(
            &mut self.organization_store,
            session_key,
            prompt_run_id,
            phase,
            settled_at,
        )
    }

    pub(crate) fn resolve_team_node_terminal(
        &mut self,
        run_id: &organization::GraphRunId,
        node_execution_id: &organization::run::event::OpaqueId,
        event: &str,
        terminal: Option<&crate::composition::team_run_mcp::TeamNodeTerminalResolution>,
        summary: &str,
        output_port: Option<&str>,
        idempotency_key: &str,
        resolved_at: u64,
    ) -> Result<crate::composition::TeamNodeTerminalResult, StoreFault> {
        self.team_run.resolve_node_terminal(
            &mut self.organization_store,
            run_id,
            node_execution_id,
            event,
            terminal,
            summary,
            output_port,
            idempotency_key,
            resolved_at,
        )
    }

    pub(crate) fn team_run_graph_definition(
        &self,
        team_id: &organization::TeamId,
        run_id: &organization::GraphRunId,
    ) -> Option<GraphDefinition> {
        self.team_run
            .graph_definition(&self.organization_store, team_id, run_id)
    }

    pub(crate) fn team_run_graph_yaml(&self, run_id: &organization::GraphRunId) -> Option<String> {
        let run = self.organization_store.facts().run(run_id)?;
        Some(organization::export_yaml(run.graph().definition()))
    }

    pub(crate) fn armed_team_triggers(
        &self,
        team_id: Option<&organization::TeamId>,
    ) -> Vec<super::ArmedTrigger> {
        self.team_run
            .armed_triggers(&self.organization_store, team_id)
    }

    pub(crate) fn replace_team_run_graph(
        &mut self,
        command: RunCommand,
        definition: GraphDefinition,
    ) -> Result<TeamRunCommandOutcome, StoreFault> {
        self.team_run
            .replace_graph(&mut self.organization_store, command, definition)
    }

    pub(crate) fn apply_team_graph_patch(
        &mut self,
        command: RunCommand,
        patch: GraphPatch,
    ) -> Result<TeamRunCommandOutcome, StoreFault> {
        let run_id = organization::GraphRunId::new(command.run_id().as_str());
        self.organization_store.team_graph_patch(command, patch)?;
        let team = self
            .organization_store
            .facts()
            .run(&run_id)
            .expect("graph patch preserves its extant TeamRun")
            .team()
            .clone();
        Ok(self.team_run.recover(
            &self.organization_store,
            organization::TeamRunQuery::get(team, run_id),
        ))
    }

    pub(crate) fn fire_team_run_trigger(
        &mut self,
        request: TriggerFireRequest,
        fired_at: u64,
    ) -> Result<TeamRunTriggerOutcome, StoreFault> {
        self.team_run
            .fire_trigger(&mut self.organization_store, request, fired_at)
    }

    pub(crate) fn resolve_team_webhook_trigger(
        &self,
        webhook_path: &str,
        idempotency_key: String,
    ) -> TeamTriggerFireResolution {
        self.team_run.resolve_webhook_fire(
            self.team_run.armed_triggers(&self.organization_store, None),
            webhook_path,
            idempotency_key,
        )
    }

    pub(crate) fn fire_team_webhook_trigger(
        &mut self,
        request: TeamTriggerFireRequest,
        fired_at: u64,
    ) -> Result<TeamTriggerFireOutcome, StoreFault> {
        self.team_run
            .fire_team_trigger(&mut self.organization_store, request, fired_at)
    }

    pub(crate) fn admit_team_run_role_chat(
        &mut self,
        admission: organization::RoleChatAdmission,
    ) -> Result<organization::RoleChatAdmissionOutcome, StoreFault> {
        self.organization_store.admit_role_chat(admission)
    }

    pub(crate) fn admit_team_run_role_chat_for_run(
        &mut self,
        run_id: organization::GraphRunId,
        role_id: organization::RoleId,
        message: String,
        idempotency_key: String,
        requested_at: u64,
    ) -> Result<organization::RoleChatAdmissionOutcome, StoreFault> {
        let Some(run) = self.organization_store.facts().run(&run_id) else {
            return Ok(organization::RoleChatAdmissionOutcome::Rejected(
                organization::RoleChatRejection::RunUnavailable,
            ));
        };
        let admission = organization::RoleChatAdmission::new(
            run.team().clone(),
            run_id,
            role_id,
            message,
            idempotency_key,
            requested_at,
        )
        .map_err(|_| StoreFault::InvalidFacts)?;
        self.organization_store.admit_role_chat(admission)
    }

    /// Reconciles durable ready graph facts into the existing delivery admission seam.
    ///
    /// Organization remains the owner of graph readiness, role/session bindings, and delivery
    /// identity. Host only supplies the native delivery effect and never keeps a scheduler shadow
    /// state. A delivery is considered active from its durable phase until its terminal phase;
    /// this preserves local-session reservation across accepted prompts and terminal observation.
    pub(crate) fn active_team_run_ids(&self) -> Vec<organization::GraphRunId> {
        self.organization_store
            .facts()
            .runs()
            .filter(|run| matches!(run.lifecycle().state(), GraphRunLifecycleState::Active))
            .map(|run| run.run_id().clone())
            .collect()
    }

    pub(crate) fn schedule_team_run_ready_nodes(
        &mut self,
        run_id: &organization::GraphRunId,
        now: u64,
    ) -> Result<Vec<DeliveryId>, StoreFault> {
        const MAX_ACTIVE_ROLE_PROMPTS: usize = 2;
        let Some(run) = self.organization_store.facts().run(run_id).cloned() else {
            return Ok(Vec::new());
        };
        if !matches!(run.lifecycle().state(), GraphRunLifecycleState::Active) {
            return Ok(Vec::new());
        }
        let active_local_sessions = self.active_team_run_local_sessions(run_id);
        let selected = organization::run::scheduler::schedule_ready_nodes(
            run.graph(),
            MAX_ACTIVE_ROLE_PROMPTS,
            active_local_sessions.len().min(MAX_ACTIVE_ROLE_PROMPTS),
        )
        .map_err(|_| StoreFault::InvalidFacts)?;
        let bindings = run
            .runtime()
            .map(|runtime| runtime.bindings())
            .unwrap_or(&[]);
        let mut reserved = active_local_sessions;
        let mut delivery_ids = Vec::new();
        for item in selected {
            let Some(node) = run.graph().definition().node(item.node_id()) else {
                continue;
            };
            let (role_id, prompt) = match node.kind() {
                organization::NodeKind::Work => {
                    let Some(work) = node.work_assignment() else {
                        continue;
                    };
                    (work.role_id().to_owned(), work.prompt().to_owned())
                }
                organization::NodeKind::Review => {
                    let Some(review) = node.review_assignment() else {
                        continue;
                    };
                    let preparation = prepare_review_dispatch(ReviewDispatchInput {
                        team_id: run.team(),
                        run_id,
                        graph: run.graph(),
                        node_id: item.node_id(),
                        fence: item.fence(),
                        binding: bindings
                            .iter()
                            .find(|binding| binding.role().as_str() == review.role_id())
                            .ok_or(StoreFault::InvalidFacts)?,
                        workflow_plan_id: run.graph().definition().workflow_plan_id(),
                        title: node.title(),
                        instruction: Some(review.prompt()),
                        requested_at: now,
                    })
                    .map_err(|_| StoreFault::InvalidFacts)?;
                    let delivery = preparation.delivery_request().clone();
                    match self.organization_store.register_delivery(delivery)? {
                        organization::RegisterOutcome::Recorded(delivery)
                        | organization::RegisterOutcome::Replayed(delivery) => {
                            delivery_ids.push(delivery.facts().delivery_id.clone());
                        }
                        organization::RegisterOutcome::ConflictingIdempotencyKey
                        | organization::RegisterOutcome::ConflictingDeliveryId { .. } => {
                            return Err(StoreFault::InvalidFacts);
                        }
                    }
                    continue;
                }
                _ => continue,
            };
            let Some(binding) = bindings
                .iter()
                .find(|binding| binding.role().as_str() == role_id)
            else {
                continue;
            };
            if !reserved.insert(binding.local_session().as_str().to_owned()) {
                continue;
            }
            let admission = RoleChatAdmission::new(
                run.team().clone(),
                run_id.clone(),
                organization::RoleId::try_new(role_id).map_err(|_| StoreFault::InvalidFacts)?,
                prompt,
                format!("team-graph-delivery:{}", item.fence().attempt_id().as_str()),
                now,
            )
            .map_err(|_| StoreFault::InvalidFacts)?;
            let outcome = self.organization_store.admit_role_chat(admission)?;
            if let organization::RoleChatAdmissionOutcome::Accepted { delivery_id } = outcome {
                delivery_ids.push(delivery_id);
            }
        }
        Ok(delivery_ids)
    }

    fn active_team_run_local_sessions(
        &self,
        run_id: &organization::GraphRunId,
    ) -> BTreeSet<String> {
        let mut active = BTreeSet::new();
        for delivery in self.organization_store.facts().deliveries().deliveries() {
            if delivery.facts().run_id != run_id.as_str() {
                continue;
            }
            if matches!(
                delivery.phase(),
                DeliveryPhase::Pending
                    | DeliveryPhase::RetryScheduled { .. }
                    | DeliveryPhase::Delivering(_)
                    | DeliveryPhase::Delivered { .. }
            ) {
                if let Some(run) = self.organization_store.facts().run(run_id) {
                    if let Some(runtime) = run.runtime() {
                        if let Some(binding) = runtime
                            .bindings()
                            .iter()
                            .find(|binding| binding.role().as_str() == delivery.facts().role_id)
                        {
                            active.insert(binding.local_session().as_str().to_owned());
                        }
                    }
                }
            }
        }
        active
    }

    pub(crate) fn claim_team_run_matcha_delivery(
        &mut self,
        delivery_id: DeliveryId,
        claimed_at: u64,
    ) -> Result<MatchaDeliveryStartOutcome, MatchaDeliveryError> {
        self.team_run
            .claim_matcha_delivery(&mut self.organization_store, delivery_id, claimed_at)
    }

    pub(crate) fn claim_team_run_openclaw_delivery(
        &mut self,
        delivery_id: DeliveryId,
        claimed_at: u64,
    ) -> Result<OpenClawDeliveryStart, OpenClawDeliveryError> {
        self.team_run
            .claim_openclaw_delivery(&mut self.organization_store, delivery_id, claimed_at)
    }

    pub(crate) fn settle_team_run_openclaw_delivery(
        &mut self,
        claim: DeliveryClaim,
        outcome: organization::PromptDeliveryOutcome,
        retry_at: u64,
    ) -> Result<OpenClawDeliveryOutcome, OpenClawDeliveryError> {
        self.team_run.settle_openclaw_delivery(
            &mut self.organization_store,
            claim,
            outcome,
            retry_at,
        )
    }

    pub(crate) fn settle_team_run_matcha_delivery(
        &mut self,
        claim: DeliveryClaim,
        delivery: organization::PromptDeliveryRequest,
        outcome: organization::PromptDeliveryOutcome,
        retry_at: u64,
    ) -> Result<MatchaDeliveryOutcome, MatchaDeliveryError> {
        self.team_run.settle_matcha_delivery(
            &mut self.organization_store,
            claim,
            delivery,
            outcome,
            retry_at,
        )
    }

    pub(crate) fn deliver_team_prompt(
        &self,
        request: organization::PromptDeliveryRequest,
    ) -> OwnedRuntimeFuture<organization::PromptDeliveryOutcome> {
        match self.team_ops_for_endpoint(request.binding().endpoint()) {
            Ok(ops) => ops.deliver_prompt(request),
            Err(_) => Box::pin(async {
                organization::PromptDeliveryOutcome::Rejected {
                    rejection: organization::DeliveryRejection::Permanent,
                }
            }),
        }
    }

    pub(crate) fn open_claw_delivery_unavailable(&self) -> bool {
        self.admission.admit_request().is_err()
            || self.open_claw.owner().snapshot().phase() != SupervisorPhase::Running
    }

    pub(crate) fn team_materialize(
        &self,
        request: organization::TeamMaterializationRequest,
    ) -> OwnedRuntimeFuture<organization::MaterializationOperationOutcome> {
        match self.team_ops_for_endpoint(request.intent().endpoint()) {
            Ok(ops) => ops.materialize_team(request),
            Err(RuntimeOperationFailure::TargetRejected) => Box::pin(async {
                organization::MaterializationOperationOutcome::Rejected {
                    rejection: organization::MaterializationRejection::Permanent,
                }
            }),
            Err(_) => {
                Box::pin(async { organization::MaterializationOperationOutcome::OutcomeUnknown })
            }
        }
    }

    pub(crate) fn team_remove(
        &self,
        removal: organization::TeamMaterializationRemoval,
    ) -> OwnedRuntimeFuture<organization::MaterializationOperationOutcome> {
        match self.team_ops_for_endpoint(removal.receipt().endpoint()) {
            Ok(ops) => ops.remove_team(removal),
            Err(RuntimeOperationFailure::TargetRejected) => Box::pin(async {
                organization::MaterializationOperationOutcome::Rejected {
                    rejection: organization::MaterializationRejection::Permanent,
                }
            }),
            Err(_) => {
                Box::pin(async { organization::MaterializationOperationOutcome::OutcomeUnknown })
            }
        }
    }

    pub(crate) fn team_confirm_receipt(
        &self,
        receipt: organization::RunRuntimeReceipt,
    ) -> OwnedRuntimeFuture<crate::composition::RuntimeReceiptOutcome> {
        match self.team_ops_for_bindings(receipt.bindings()) {
            Ok(ops) => ops.confirm_team_run_receipt(receipt),
            Err(RuntimeOperationFailure::TargetRejected) => {
                Box::pin(async { crate::composition::RuntimeReceiptOutcome::Rejected })
            }
            Err(_) => Box::pin(async { crate::composition::RuntimeReceiptOutcome::OutcomeUnknown }),
        }
    }

    pub(crate) fn team_abort_role_sessions(
        &self,
        bindings: Vec<organization::RoleSessionReceipt>,
    ) -> OwnedRuntimeFuture<organization::RoleAbortOutcome> {
        match self.team_ops_for_bindings(&bindings) {
            Ok(ops) => ops.abort_role_sessions(bindings),
            Err(_) => Box::pin(async { organization::RoleAbortOutcome::OutcomeUnknown }),
        }
    }

    pub(crate) fn team_delete_role_sessions(
        &self,
        run_id: organization::GraphRunId,
        bindings: Vec<organization::RoleSessionReceipt>,
        abort_first: bool,
    ) -> OwnedRuntimeFuture<organization::NativeDeletionEvidence> {
        match self.team_ops_for_bindings(&bindings) {
            Ok(ops) => ops.delete_role_sessions(run_id, bindings, abort_first),
            Err(_) => Box::pin(async { organization::NativeDeletionEvidence::OutcomeUnknown }),
        }
    }

    pub(crate) fn terminal_observation_deliveries(&self) -> Vec<DeliveryId> {
        self.team_run
            .terminal_observation_deliveries(&self.organization_store)
    }

    pub(crate) fn pending_team_run_deliveries(&self, now: u64) -> Vec<DeliveryId> {
        self.team_run
            .pending_delivery_ids(&self.organization_store, now)
    }

    pub(crate) fn team_run_delivery_target(
        &self,
        delivery_id: &DeliveryId,
    ) -> Option<super::TeamRunDeliveryTarget> {
        let open_claw_endpoint = RuntimeEndpointReference::try_new(
            RuntimeDriverIdentity::open_claw().runtime_endpoint_reference(),
        )
        .expect("fixed OpenClaw endpoint must be valid");
        let matcha_endpoint = RuntimeEndpointReference::try_new(
            RuntimeDriverIdentity::matcha_agent().runtime_endpoint_reference(),
        )
        .expect("fixed Matcha endpoint must be valid");
        self.team_run.delivery_target(
            &self.organization_store,
            delivery_id,
            &open_claw_endpoint,
            &matcha_endpoint,
        )
    }

    pub(crate) fn terminal_watch(&self, delivery_id: &DeliveryId) -> Option<RoleTerminalWatch> {
        let target = self
            .team_run
            .matcha_terminal_target(&self.organization_store, delivery_id)?;
        let session_id =
            RoleSessionId::try_new(target.correlation().external_session().as_str().to_owned())
                .ok()?;
        let run_id = RoleRunId::try_new(
            target
                .correlation()
                .native_run_receipt()
                .as_str()
                .to_owned(),
        )
        .ok()?;
        self.matcha().watch_role_terminal(session_id, run_id)
    }

    pub(crate) fn observe_team_run_matcha_terminal(
        &mut self,
        delivery_id: DeliveryId,
        status: TerminalRunStatus,
        observed_at: u64,
    ) -> Result<MatchaTerminalObservationOutcome, MatchaTerminalObservationError> {
        let Some(target) = self
            .team_run
            .matcha_terminal_target(&self.organization_store, &delivery_id)
        else {
            return Ok(MatchaTerminalObservationOutcome::NotFound);
        };
        let native_terminal = match status {
            TerminalRunStatus::Completed => organization::NativeTerminalStatus::Completed,
            TerminalRunStatus::Cancelled => organization::NativeTerminalStatus::Cancelled,
            TerminalRunStatus::Failed => organization::NativeTerminalStatus::Failed,
            TerminalRunStatus::Interrupted => organization::NativeTerminalStatus::Interrupted,
        };
        self.team_run
            .observe_matcha_terminal(
                &mut self.organization_store,
                target,
                native_terminal,
                observed_at,
            )
            .map(MatchaTerminalObservationOutcome::Observed)
            .map_err(MatchaTerminalObservationError::Store)
    }

    pub(crate) fn resolve_team_run_authorized_graph_outcome(
        &mut self,
        resolution: organization::AuthorizedGraphResolution,
    ) -> Result<TeamRunCommandOutcome, StoreFault> {
        self.team_run
            .resolve_authorized_graph_outcome(&mut self.organization_store, resolution)
    }

    /// Native terminal status is intentionally not enough to call this consumer. The caller must
    /// supply the trusted summary and authorization receipt from the native/event producer after
    /// `observe_team_run_matcha_terminal` has recorded observation.
    pub(crate) fn resolve_team_run_review_after_terminal_observation(
        &mut self,
        preparation: &ReviewDispatchPreparation,
        input: ReviewResolutionInput,
    ) -> Result<TeamRunCommandOutcome, StoreFault> {
        self.team_run.resolve_review_after_terminal_observation(
            &mut self.organization_store,
            preparation,
            input,
        )
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
        self.matcha_start
            .as_ref()
            .and_then(|result| matcha_start_failure(result.as_ref()))
    }

    pub fn open_claw_start_failure(&self) -> Option<RuntimeStartFailure> {
        self.open_claw_start
            .as_ref()
            .and_then(|result| start_failure(result.as_ref()))
    }

    pub(crate) fn matcha(&self) -> &MatchaPeer {
        self.matcha.peer()
    }

    fn matcha_state(&self) -> RuntimeState {
        RuntimeState::from_snapshot_with_startup_diagnostic(
            &self.matcha_lifecycle_snapshot(),
            self.matcha_startup_diagnostics.category().map(Into::into),
        )
    }

    fn open_claw_state(&self) -> RuntimeState {
        RuntimeState::from_snapshot_with_startup_diagnostic(
            &self.open_claw_lifecycle_snapshot(),
            self.openclaw_startup_diagnostics.category().map(Into::into),
        )
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

    pub(crate) fn open_claw_installed_skill_catalog(
        &self,
    ) -> OwnedRuntimeFuture<Option<openclaw::skill::InstalledSkillCatalog>> {
        match self.running_skill_ops() {
            Ok(ops) => ops.installed_skill_catalog(),
            Err(_) => Box::pin(async { None }),
        }
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

fn generated_endpoint_session_id() -> Option<String> {
    let mut entropy = [0u8; 16];
    getrandom::fill(&mut entropy).ok()?;
    let mut id = format!("session-{}-", now_millis());
    for byte in entropy {
        use std::fmt::Write as _;
        write!(&mut id, "{byte:02x}").ok()?;
    }
    Some(id)
}

fn openclaw_canonical_changes(
    changes: &[CanonicalSessionChange],
    run_id: Option<&str>,
) -> Vec<SessionChange> {
    let mut projected = Vec::with_capacity(changes.len() + 1);
    if let Some(run_id) = run_id {
        if changes.iter().any(|change| {
            matches!(
                change,
                CanonicalSessionChange::RunDelta { .. }
                    | CanonicalSessionChange::MessageActivity { .. }
                    | CanonicalSessionChange::ToolActivity { .. }
            )
        }) {
            projected.push(SessionChange::RunPhaseChanged {
                run_id: run_id.to_owned(),
                phase: RunPhase::Started,
            });
        }
    }
    for change in changes {
        match change {
            CanonicalSessionChange::RunDelta {
                run_id,
                message_id,
                text,
                replace,
            } => projected.push(SessionChange::MessageDelta {
                item_id: message_id
                    .as_ref()
                    .map(|id| id.as_str().to_owned())
                    .unwrap_or_else(|| run_id.as_str().to_owned()),
                run_id: Some(run_id.as_str().to_owned()),
                message_id: message_id.as_ref().map(|id| id.as_str().to_owned()),
                text: text.clone(),
                replace: *replace,
                status: ItemStatus::Streaming,
            }),
            CanonicalSessionChange::MessageActivity {
                run_id,
                message_id,
                lifecycle,
                text,
            } => projected.push(SessionChange::MessageDelta {
                item_id: message_id.as_str().to_owned(),
                run_id: Some(run_id.as_str().to_owned()),
                message_id: Some(message_id.as_str().to_owned()),
                text: text.clone().unwrap_or_default(),
                replace: false,
                status: match lifecycle {
                    MessageActivityLifecycle::Started | MessageActivityLifecycle::Delta => {
                        ItemStatus::Streaming
                    }
                    MessageActivityLifecycle::Completed => ItemStatus::Final,
                },
            }),
            CanonicalSessionChange::ToolActivity {
                run_id,
                tool_id,
                phase,
                summary,
            } => projected.push(SessionChange::ToolUpdated {
                tool: ToolView {
                    tool_call_id: tool_id.as_str().to_owned(),
                    run_id: Some(run_id.as_str().to_owned()),
                    name: None,
                    phase: match phase {
                        ToolActivityPhase::Started => ToolPhase::Started,
                        ToolActivityPhase::Updated => ToolPhase::Updated,
                        ToolActivityPhase::Completed => ToolPhase::Completed,
                        ToolActivityPhase::Failed => ToolPhase::Failed,
                    },
                    summary: summary.clone(),
                    is_error: matches!(phase, ToolActivityPhase::Failed).then_some(true),
                },
            }),
            CanonicalSessionChange::Terminal {
                outcome,
                run_id,
                message_id,
                message_text,
                ..
            } => {
                if let Some(text) = message_text {
                    projected.push(SessionChange::MessageDelta {
                        item_id: message_id
                            .as_ref()
                            .map(|id| id.as_str().to_owned())
                            .unwrap_or_else(|| run_id.as_str().to_owned()),
                        run_id: Some(run_id.as_str().to_owned()),
                        message_id: message_id.as_ref().map(|id| id.as_str().to_owned()),
                        text: text.clone(),
                        replace: true,
                        status: match outcome {
                            TerminalOutcome::Completed => ItemStatus::Final,
                            TerminalOutcome::Aborted => ItemStatus::Aborted,
                            TerminalOutcome::Error => ItemStatus::Error,
                        },
                    });
                }
                projected.push(SessionChange::RunPhaseChanged {
                    run_id: run_id.as_str().to_owned(),
                    phase: match outcome {
                        TerminalOutcome::Completed => crate::session_state::RunPhase::Completed,
                        TerminalOutcome::Aborted => crate::session_state::RunPhase::Cancelled,
                        TerminalOutcome::Error => crate::session_state::RunPhase::Failed,
                    },
                });
            }
            CanonicalSessionChange::RecoveryRequired { reason } => {
                projected.push(SessionChange::RecoveryRequired {
                    reason: match reason {
                        CanonicalRecoveryReason::CursorGap => RecoveryReason::CursorGap,
                        CanonicalRecoveryReason::CursorStale => RecoveryReason::CursorStale,
                        CanonicalRecoveryReason::EpochChanged => RecoveryReason::EpochChanged,
                        CanonicalRecoveryReason::EventOverflow => RecoveryReason::EventOverflow,
                        CanonicalRecoveryReason::NativeUnavailable => {
                            RecoveryReason::NativeUnavailable
                        }
                        CanonicalRecoveryReason::NativeUnknown => RecoveryReason::NativeUnknown,
                    },
                });
            }
        }
    }
    projected
}

fn canonical_cron_session_key(
    command: &crate::cron::CronHistoryCommand,
    receipts: Vec<openclaw::gateway::wire::CronRunHistoryEntry>,
) -> Option<String> {
    let keys: BTreeSet<_> = receipts
        .into_iter()
        .filter(|receipt| {
            receipt.job_id == command.job_id()
                && command.matches_run_session(receipt.session_id.as_deref())
        })
        .filter_map(|receipt| receipt.session_key)
        .collect();
    (keys.len() == 1).then(|| keys.into_iter().next()).flatten()
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

fn runtime_start_result(
    result: Result<SupervisorStart, SupervisorStartFailureKind>,
) -> Result<(), RuntimeStartFailure> {
    match result {
        Ok(SupervisorStart::Started) => Ok(()),
        Ok(SupervisorStart::Cancelled) => Err(RuntimeStartFailure::Cancelled),
        Err(error) => Err(map_start_failure(error)),
    }
}

fn matcha_runtime_start_result(
    result: Result<StartOutcome, MatchaLifecycleError>,
) -> Result<(), RuntimeStartFailure> {
    match result {
        Ok(StartOutcome::Started) => Ok(()),
        Ok(StartOutcome::Cancelled { .. }) => Err(RuntimeStartFailure::Cancelled),
        Err(error) => Err(map_matcha_start_failure(error)),
    }
}

fn matcha_runtime_stop_result(
    result: Result<TerminationCompletion, MatchaLifecycleError>,
) -> Result<(), RuntimeLifecycleFailure> {
    result.map(|_| ()).map_err(map_matcha_lifecycle_failure)
}

fn matcha_runtime_restart_result(
    result: Result<RestartOutcome, MatchaLifecycleError>,
) -> Result<(), RuntimeLifecycleFailure> {
    match result {
        Ok(RestartOutcome::Restarted) => Ok(()),
        Ok(RestartOutcome::Cancelled { .. }) => Err(RuntimeLifecycleFailure::Cancelled),
        Err(error) => Err(map_matcha_lifecycle_failure(error)),
    }
}

fn matcha_start_failure(
    result: Result<&StartOutcome, &MatchaLifecycleError>,
) -> Option<RuntimeStartFailure> {
    match result {
        Ok(StartOutcome::Started) => None,
        Ok(StartOutcome::Cancelled { .. }) => Some(RuntimeStartFailure::Cancelled),
        Err(error) => Some(map_matcha_start_failure(*error)),
    }
}

const fn map_matcha_start_failure(error: MatchaLifecycleError) -> RuntimeStartFailure {
    match error {
        MatchaLifecycleError::CompletionFailed => RuntimeStartFailure::CompletionFailed,
        MatchaLifecycleError::SupervisorStopped => RuntimeStartFailure::SupervisorStopped,
        MatchaLifecycleError::AlreadySatisfied => RuntimeStartFailure::Rejected,
        MatchaLifecycleError::Busy => RuntimeStartFailure::Busy,
        MatchaLifecycleError::Rejected(_) => RuntimeStartFailure::Rejected,
        MatchaLifecycleError::ShuttingDown => RuntimeStartFailure::ShuttingDown,
    }
}

const fn map_matcha_lifecycle_failure(error: MatchaLifecycleError) -> RuntimeLifecycleFailure {
    match error {
        MatchaLifecycleError::CompletionFailed => RuntimeLifecycleFailure::CompletionFailed,
        MatchaLifecycleError::SupervisorStopped => RuntimeLifecycleFailure::SupervisorStopped,
        MatchaLifecycleError::AlreadySatisfied => RuntimeLifecycleFailure::AlreadySatisfied,
        MatchaLifecycleError::Busy => RuntimeLifecycleFailure::Busy,
        MatchaLifecycleError::Rejected(_) => RuntimeLifecycleFailure::Rejected,
        MatchaLifecycleError::ShuttingDown => RuntimeLifecycleFailure::ShuttingDown,
    }
}

fn runtime_stop_result(
    result: Result<TerminationCompletion, SupervisorLifecycleFailureKind>,
) -> Result<(), RuntimeLifecycleFailure> {
    result.map(|_| ()).map_err(map_lifecycle_failure)
}

fn runtime_restart_result(
    result: Result<SupervisorRestart, SupervisorLifecycleFailureKind>,
) -> Result<(), RuntimeLifecycleFailure> {
    match result {
        Ok(SupervisorRestart::Restarted) => Ok(()),
        Ok(SupervisorRestart::Cancelled) => Err(RuntimeLifecycleFailure::Cancelled),
        Err(error) => Err(map_lifecycle_failure(error)),
    }
}

fn start_failure(
    result: Result<&SupervisorStart, &SupervisorStartFailureKind>,
) -> Option<RuntimeStartFailure> {
    match result {
        Ok(SupervisorStart::Started) => None,
        Ok(SupervisorStart::Cancelled) => Some(RuntimeStartFailure::Cancelled),
        Err(error) => Some(map_start_failure(*error)),
    }
}

pub(super) const fn map_start_failure(error: SupervisorStartFailureKind) -> RuntimeStartFailure {
    match error {
        SupervisorStartFailureKind::CompletionFailed => RuntimeStartFailure::CompletionFailed,
        SupervisorStartFailureKind::SupervisorStopped => RuntimeStartFailure::SupervisorStopped,
        SupervisorStartFailureKind::Busy => RuntimeStartFailure::Busy,
        SupervisorStartFailureKind::Rejected(_) => RuntimeStartFailure::Rejected,
        SupervisorStartFailureKind::ShuttingDown => RuntimeStartFailure::ShuttingDown,
    }
}

pub(super) const fn map_lifecycle_failure(
    error: SupervisorLifecycleFailureKind,
) -> RuntimeLifecycleFailure {
    match error {
        SupervisorLifecycleFailureKind::CompletionFailed => {
            RuntimeLifecycleFailure::CompletionFailed
        }
        SupervisorLifecycleFailureKind::SupervisorStopped => {
            RuntimeLifecycleFailure::SupervisorStopped
        }
        SupervisorLifecycleFailureKind::AlreadySatisfied => {
            RuntimeLifecycleFailure::AlreadySatisfied
        }
        SupervisorLifecycleFailureKind::Busy => RuntimeLifecycleFailure::Busy,
        SupervisorLifecycleFailureKind::Rejected(_) => RuntimeLifecycleFailure::Rejected,
        SupervisorLifecycleFailureKind::ShuttingDown => RuntimeLifecycleFailure::ShuttingDown,
    }
}

fn manual_materialization_outcome(
    outcome: organization::MaterializationOperationOutcome,
) -> ManualTeamCreateOutcome {
    match outcome {
        organization::MaterializationOperationOutcome::Confirmed { .. } => {
            ManualTeamCreateOutcome::OutcomeUnknown
        }
        organization::MaterializationOperationOutcome::Rejected { .. } => {
            ManualTeamCreateOutcome::Rejected
        }
        organization::MaterializationOperationOutcome::Accepted { .. }
        | organization::MaterializationOperationOutcome::OutcomeUnknown => {
            ManualTeamCreateOutcome::OutcomeUnknown
        }
    }
}

const fn manual_runtime_receipt_outcome(
    outcome: team::RuntimeReceiptOutcome,
) -> ManualTeamCreateOutcome {
    match outcome {
        team::RuntimeReceiptOutcome::Installed => ManualTeamCreateOutcome::OutcomeUnknown,
        team::RuntimeReceiptOutcome::Rejected => ManualTeamCreateOutcome::Rejected,
        team::RuntimeReceiptOutcome::OutcomeUnknown => ManualTeamCreateOutcome::OutcomeUnknown,
        team::RuntimeReceiptOutcome::Unavailable => ManualTeamCreateOutcome::Unavailable,
    }
}

const fn team_materialization_status(
    outcome: TeamMaterializationCommandOutcome,
) -> crate::owner::TeamRuntimeStatus {
    match outcome {
        TeamMaterializationCommandOutcome::Materialized => {
            crate::owner::TeamRuntimeStatus::OutcomeUnknown
        }
        TeamMaterializationCommandOutcome::Rejected => crate::owner::TeamRuntimeStatus::Rejected,
        TeamMaterializationCommandOutcome::OutcomeUnknown => {
            crate::owner::TeamRuntimeStatus::OutcomeUnknown
        }
        TeamMaterializationCommandOutcome::Unavailable => {
            crate::owner::TeamRuntimeStatus::Unavailable
        }
    }
}

const fn runtime_receipt_status(
    outcome: team::RuntimeReceiptOutcome,
) -> crate::owner::TeamRuntimeStatus {
    match outcome {
        team::RuntimeReceiptOutcome::Installed => crate::owner::TeamRuntimeStatus::OutcomeUnknown,
        team::RuntimeReceiptOutcome::Rejected => crate::owner::TeamRuntimeStatus::Rejected,
        team::RuntimeReceiptOutcome::OutcomeUnknown => {
            crate::owner::TeamRuntimeStatus::OutcomeUnknown
        }
        team::RuntimeReceiptOutcome::Unavailable => crate::owner::TeamRuntimeStatus::Unavailable,
    }
}

fn team_skill_selection_registry(state_dir: &std::path::Path) -> PathBuf {
    state_dir.join("team-skill-selections.v1.json")
}

const fn control_lease_projection(
    phase: SupervisorPhase,
    _active_operation: Option<SupervisorOperation>,
) -> ControlLeaseProjection {
    match phase {
        SupervisorPhase::Starting | SupervisorPhase::Running => {
            ControlLeaseProjection::ProbeGateway
        }
        _ => ControlLeaseProjection::Unavailable,
    }
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
    RuntimeState,
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
            Self::RuntimeState => {
                formatter.write_str("runtime state directory could not be provisioned")
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
            | Self::RuntimeState => None,
            Self::Matcha(error) => Some(error),
            Self::OpenClaw(error) => Some(error),
        }
    }
}

#[derive(Default)]
struct ProviderNativeConfigurationFanout {
    evidence: Option<ProviderNativeConfigurationEvidence>,
    unavailable: bool,
}

impl ProviderNativeConfigurationFanout {
    fn push(&mut self, effect: ProviderNativeConfigurationEffect) {
        match effect {
            ProviderNativeConfigurationEffect::Evidence(evidence) => {
                self.evidence = Some(match self.evidence.take() {
                    Some(current) => merge_provider_native_evidence(current, evidence),
                    None => evidence,
                });
            }
            ProviderNativeConfigurationEffect::Unavailable => {
                self.unavailable = true;
            }
        }
    }

    fn finish(self) -> Option<ProviderNativeConfigurationEffect> {
        let Some(evidence) = self.evidence else {
            return None;
        };
        if self.unavailable {
            ProviderNativeConfigurationEffect::Evidence(ProviderNativeConfigurationEvidence::with_diagnostic(
                evidence.changed(),
                AppliedStatus::Unknown,
                merge_observed_status(evidence.observed(), ObservedStatus::Unavailable),
                evidence.diagnostic().cloned().unwrap_or_else(|| ProviderNativeConfigurationDiagnostic::new(
                    "runtime-readiness",
                    "runtime-not-ready",
                    String::new(),
                    None,
                    Some("models.providers"),
                    None,
                )),
            ))
        } else {
            ProviderNativeConfigurationEffect::Evidence(evidence)
        }.into()
    }
}

fn merge_provider_native_evidence(
    left: ProviderNativeConfigurationEvidence,
    right: ProviderNativeConfigurationEvidence,
) -> ProviderNativeConfigurationEvidence {
    let changed = left.changed() || right.changed();
    let applied = merge_applied_status(left.applied(), right.applied());
    let observed = merge_observed_status(left.observed(), right.observed());
    match left.diagnostic().or_else(|| right.diagnostic()).cloned() {
        Some(diagnostic) => ProviderNativeConfigurationEvidence::with_diagnostic(
            changed,
            applied,
            observed,
            diagnostic,
        ),
        None => ProviderNativeConfigurationEvidence::new(changed, applied, observed),
    }
}

fn trace_provider_native_effect(effect: &ProviderNativeConfigurationEffect) {
    match effect {
        ProviderNativeConfigurationEffect::Evidence(evidence) => {
            if let Some(diagnostic) = evidence.diagnostic() {
                eprintln!(
                    "[startup-trace] source=provider-native-config phase={} detail={} changed={} applied={:?} observed={:?} config_path={} method={} expected_path={} error={}",
                    diagnostic.phase(),
                    diagnostic.reason(),
                    evidence.changed(),
                    evidence.applied(),
                    evidence.observed(),
                    diagnostic.config_path(),
                    diagnostic.method().unwrap_or("none"),
                    diagnostic.expected_path().unwrap_or("none"),
                    diagnostic.detail().unwrap_or("none")
                );
            } else {
                eprintln!(
                    "[startup-trace] source=provider-native-config phase=finish detail=provider-config-sync-finished changed={} applied={:?} observed={:?}",
                    evidence.changed(),
                    evidence.applied(),
                    evidence.observed()
                );
            }
        }
        ProviderNativeConfigurationEffect::Unavailable => {
            eprintln!(
                "[startup-trace] source=provider-native-config phase=finish detail=provider-config-sync-unavailable"
            );
        }
    }
}

const fn merge_applied_status(left: AppliedStatus, right: AppliedStatus) -> AppliedStatus {
    match (left, right) {
        (AppliedStatus::Confirmed, AppliedStatus::Confirmed) => AppliedStatus::Confirmed,
        (AppliedStatus::Confirmed | AppliedStatus::Unknown, _) => AppliedStatus::Unknown,
    }
}

const fn merge_observed_status(left: ObservedStatus, right: ObservedStatus) -> ObservedStatus {
    match (left, right) {
        (ObservedStatus::Mismatch, _) | (_, ObservedStatus::Mismatch) => ObservedStatus::Mismatch,
        (ObservedStatus::Unavailable, _) | (_, ObservedStatus::Unavailable) => {
            ObservedStatus::Unavailable
        }
        (ObservedStatus::Matches, ObservedStatus::Matches) => ObservedStatus::Matches,
    }
}

#[cfg(test)]
mod tests;
