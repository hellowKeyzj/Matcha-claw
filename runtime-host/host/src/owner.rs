mod actor;
mod command;
pub(crate) mod lifecycle;
mod team_run_operations;
mod team_runtime_operations;
#[cfg(test)]
mod tests;

use std::{
    fmt,
    sync::{Arc, RwLock},
};

use tokio::{
    sync::{mpsc, oneshot},
    task::JoinError,
};

use foundation::execution::OwnedTask;
use openclaw::{
    agents::{AgentCreate, AgentDelete, AgentFileName, AgentUpdate},
    port::OpenClawSessionError,
    session::protocol::{
        ChatAbortParams, ChatAbortResult, ChatHistoryParams, ChatHistoryResult, ChatSendParams,
        ChatSendResult, SessionsListParams, SessionsListResult,
    },
};
use organization::{
    BeginCancellationOutcome, CreateGraphRunOutcome, GraphDefinition, GraphRunId, IdempotencyKey,
    ResumeOutcome, RoleChatAdmission, RoleChatAdmissionOutcome, RunCommand, StoreFault, TeamId,
    TeamRunQueryOutcome, TombstoneOutcome, TriggerFireRequest,
    package::{
        TeamSkillDependencyPlanResult, TeamSkillPackageValidation, TeamSkillSelectionError,
        TeamSkillSelectionId,
    },
    run::{
        approval::{HumanDecisionCommand, HumanDecisionOutcome},
        public_projection::TeamPublicQueryOutcome,
    },
};
use platform::exchange::InvocationOutcome;

use crate::{
    Host, HostShutdownError, HostState, RequestAdmissionClosed, RuntimeSessionError, RuntimeState,
    ShutdownReport,
    channel_status::{
        ChannelPairingOutcome, ChannelSnapshotOutcome, ChannelStatusFailure, ChannelStatusOutcome,
    },
    composition::{
        ControlLease, HostEvent, HostEvents, ManualTeamCreateOutcome,
        OpenClawGatewayHealthObservation, OpenClawGatewayStatusObservation, OpenClawLogSnapshot,
        TeamMaterializationCommandOutcome, TeamRunCommandOutcome, TeamRunTriggerOutcome,
    },
    diagnostics::{
        DiagnosticsArchiveCancellation, DiagnosticsArchiveError, DiagnosticsArchiveReceipt,
    },
    peer_directory::{Directory as RuntimeEndpointDirectory, RuntimeEndpointReadiness},
    plugin::{
        Catalog as PluginCatalog, ConfigurationOutcome as PluginConfigurationOutcome,
        Operation as PluginOperation, OperationOutcome as PluginOperationOutcome, PluginError,
        Runtime as PluginRuntime,
    },
    session_abort::{SessionAbortCommand, SessionAbortOutcome},
    session_approval::{
        PendingApprovalsCommand, PendingApprovalsOutcome, SessionApprovalCommand,
        SessionApprovalOutcome,
    },
    session_create::{SessionCreateCommand, SessionCreateOutcome},
    session_delete::{SessionDeleteCommand, SessionDeleteOutcome},
    session_model_selection::{SessionModelSelectionCommand, SessionModelSelectionOutcome},
    session_rename::{SessionRenameCommand, SessionRenameOutcome},
    session_send::{SessionSendCommand, SessionSendOutcome},
    session_state::{SessionApplyResult, SessionChange, SessionIdentity, SessionView},
    session_timeline::{Command as SessionTimelineCommand, Outcome as SessionTimelineOutcome},
    skill_install::{Command as SkillInstallCommand, Outcome as SkillInstallOutcome},
};

use self::command::{
    Command, DiagnosticsCommand, ExternalConnectorsCommand, FleetCommand, MatchaCommand,
    ProviderAccountsCommand, ProviderModelsCommand, ProviderRoutingCommand, RuntimeCommand,
    TeamRunCommand, TeamSkillCommand,
};
pub(crate) use self::command::{
    TeamNodeEventCommandOutcome, TeamRuntimeCommand, TeamRuntimeCommandOutcome,
    TeamRuntimeCreateSource, TeamRuntimePromptPhase, TeamRuntimeStatus,
};
pub(crate) use self::lifecycle::{
    RestartMatchaError, RestartOpenClawError, StartMatchaError, StartOpenClawError,
    StopMatchaError, StopOpenClawError,
};

const COMMAND_CAPACITY: usize = 32;
const EVENT_CAPACITY: usize = 256;
const SHUTDOWN_CAPACITY: usize = 1;

type ActorExit = Result<(), HostShutdownError>;
pub(super) type ShutdownRequest = oneshot::Sender<ShutdownAttempt>;

pub(crate) struct Owner {
    handle: Option<Handle>,
    task: OwnedTask<ActorExit>,
    events: Option<mpsc::Receiver<HostEvent>>,
}

#[derive(Clone)]
pub(crate) struct HostReadHandle {
    state: Arc<RwLock<HostState>>,
}

#[derive(Clone)]
pub(crate) struct HostStatePublisher {
    state: Arc<RwLock<HostState>>,
}

#[derive(Clone)]
pub(crate) struct Handle {
    commands: mpsc::Sender<Command>,
    shutdown: mpsc::Sender<ShutdownRequest>,
    #[cfg_attr(test, allow(dead_code))]
    state: Option<HostReadHandle>,
}

/// Owner ingress for the legacy resource registration route.
///
/// `requested_id` is caller input only. It is deliberately not a `ManagedResourceId`: without a
/// source-backed provider fact the owner must reject this request rather than promote caller input
/// to a canonical resource identity or write an observed record.
pub(crate) struct ManagedResourceRegistrationRequest {
    pub(crate) requested_id: String,
    pub(crate) connection_id: fleet::connection::ConnectionId,
    pub(crate) environment_id: fleet::environment::EnvironmentId,
    pub(crate) provider: fleet::environment::ManagedResourceProvider,
    pub(crate) kind: fleet::environment::ManagedResourceKind,
    pub(crate) remote_resource_id: String,
    pub(crate) ownership: fleet::environment::Ownership,
    pub(crate) cleanup_policy: fleet::environment::CleanupPolicy,
}

pub(crate) struct ShutdownAttempt {
    pub(crate) result: Result<ShutdownReport, HostShutdownError>,
    pub(crate) terminal: bool,
}

impl Owner {
    pub(crate) fn spawn(host: Host, events: HostEvents) -> Self {
        let (commands, receiver) = mpsc::channel(COMMAND_CAPACITY);
        let (shutdown, shutdown_receiver) = mpsc::channel(SHUTDOWN_CAPACITY);
        let (output, output_receiver) = mpsc::channel(EVENT_CAPACITY);
        let (state, publisher) = HostReadHandle::new(host.state());
        let handle = Handle {
            commands,
            shutdown,
            state: Some(state),
        };
        let (task, _) = OwnedTask::spawn(|_| {
            actor::run(host, events, receiver, shutdown_receiver, output, publisher)
        });
        Self {
            handle: Some(handle),
            task,
            events: Some(output_receiver),
        }
    }

    pub(crate) fn take_events(&mut self) -> Option<mpsc::Receiver<HostEvent>> {
        self.events.take()
    }

    pub(crate) fn handle(&self) -> Handle {
        self.handle
            .as_ref()
            .expect("Host owner handle must remain until terminal shutdown")
            .clone()
    }

    pub(crate) async fn join(&mut self) -> Result<ActorExit, Error> {
        self.handle.take();
        (&mut self.task).await.map_err(Error::Join)
    }
}

impl HostReadHandle {
    fn new(state: HostState) -> (Self, HostStatePublisher) {
        let state = Arc::new(RwLock::new(state));
        (
            Self {
                state: Arc::clone(&state),
            },
            HostStatePublisher { state },
        )
    }

    pub(crate) fn state(&self) -> HostState {
        *self
            .state
            .read()
            .expect("host lifecycle read state lock poisoned")
    }
}

impl HostStatePublisher {
    fn publish(&self, state: HostState) {
        *self
            .state
            .write()
            .expect("host lifecycle read state lock poisoned") = state;
    }
}

impl Handle {
    pub(crate) fn state(&self) -> HostState {
        self.state
            .as_ref()
            .expect("Host read state must be present on spawned owner handles")
            .state()
    }

    pub(crate) async fn runtime_endpoint_directory(&self) -> RuntimeEndpointDirectory {
        let state = self.state();
        let matcha_readiness = RuntimeEndpointReadiness::from_lifecycle(state.matcha().lifecycle());
        let open_claw_readiness = match self.control_lease().await {
            Ok(Ok(lease)) => match lease.snapshot_control().await {
                openclaw::port::OpenClawControlReadiness::Ready => RuntimeEndpointReadiness::Ready,
                openclaw::port::OpenClawControlReadiness::Starting => {
                    RuntimeEndpointReadiness::Starting
                }
                openclaw::port::OpenClawControlReadiness::Unavailable => {
                    RuntimeEndpointReadiness::Unavailable
                }
            },
            Ok(Err(_)) => RuntimeEndpointReadiness::Starting,
            Err(_) => RuntimeEndpointReadiness::Unavailable,
        };
        RuntimeEndpointDirectory::from_readiness(&state, matcha_readiness, open_claw_readiness)
    }

    pub(crate) async fn request_peer_autostart(
        &self,
        open_claw_auto_start: bool,
    ) -> Result<(), Error> {
        self.request(|reply| Command::PeerAutostart {
            open_claw_auto_start,
            reply,
        })
        .await
    }

    pub(crate) async fn team_runtime(
        &self,
        request: TeamRuntimeCommand,
    ) -> Result<TeamRuntimeCommandOutcome, Error> {
        self.request(|reply| Command::TeamRuntime { request, reply })
            .await
    }

    pub(crate) async fn shutdown(&self) -> Result<ShutdownAttempt, Error> {
        let (reply, response) = oneshot::channel();
        self.shutdown
            .send(reply)
            .await
            .map_err(|_| Error::CommandChannelClosed)?;
        response.await.map_err(|_| Error::ResponseChannelClosed)
    }

    pub(crate) async fn collect_diagnostics(
        &self,
        cancellation: DiagnosticsArchiveCancellation,
    ) -> Result<Result<DiagnosticsArchiveReceipt, RequestAdmissionClosed>, Error> {
        self.request(|reply| {
            Command::Diagnostics(DiagnosticsCommand::Submit {
                cancellation,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn download_diagnostics(
        &self,
        archive_id: String,
    ) -> Result<Result<Result<Vec<u8>, DiagnosticsArchiveError>, RequestAdmissionClosed>, Error>
    {
        self.request(|reply| {
            Command::Diagnostics(DiagnosticsCommand::Download { archive_id, reply })
        })
        .await
    }

    pub(crate) async fn skill_status(&self) -> Result<crate::skill_status::Outcome, Error> {
        self.request(|reply| Command::SkillStatus { reply }).await
    }

    pub(crate) async fn manage_skills(
        &self,
        command: crate::skill_management::Command,
    ) -> Result<crate::skill_management::Outcome, Error> {
        self.request(|reply| Command::SkillManagement { command, reply })
            .await
    }

    pub(crate) async fn channel_catalog(
        &self,
    ) -> Result<crate::channel_catalog::ChannelCatalogOutcome, Error> {
        self.request(|reply| Command::Runtime(RuntimeCommand::ChannelCatalog(reply)))
            .await
    }

    pub(crate) async fn read_channel_config(
        &self,
        channel: String,
        account_id: Option<String>,
    ) -> Result<crate::channel_config_read::Outcome, Error> {
        self.request(|reply| {
            Command::Runtime(RuntimeCommand::ChannelConfigRead {
                channel,
                account_id,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn validate_channel_credentials(
        &self,
        channel: String,
        config: zeroize::Zeroizing<Vec<u8>>,
    ) -> Result<crate::channel_credentials::Outcome, Error> {
        self.request(|reply| {
            Command::Runtime(RuntimeCommand::ChannelCredentialsValidate {
                channel,
                config,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn channel_configure_form(
        &self,
        channel: String,
    ) -> Result<crate::channel_catalog::ChannelConfigureFormOutcome, Error> {
        self.request(|reply| {
            Command::Runtime(RuntimeCommand::ChannelConfigureForm { channel, reply })
        })
        .await
    }

    pub(crate) async fn channel_configure(
        &self,
        channel: String,
        account_id: String,
        values: zeroize::Zeroizing<Vec<u8>>,
    ) -> Result<crate::channel_catalog::ChannelConfigureOutcome, Error> {
        self.request(|reply| {
            Command::Runtime(RuntimeCommand::ChannelConfigure {
                channel,
                account_id,
                values,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn delete_channel_config(
        &self,
        channel: String,
        account_id: String,
    ) -> Result<crate::channel_delete::Outcome, Error> {
        self.request(|reply| {
            Command::Runtime(RuntimeCommand::ChannelDeleteConfig {
                channel,
                account_id,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn start_channel_login(
        &self,
        channel: String,
        force: bool,
        timeout_ms: Option<u64>,
        account_id: Option<String>,
        config: zeroize::Zeroizing<Vec<u8>>,
    ) -> Result<crate::channel_login::Outcome, Error> {
        self.request(|reply| {
            Command::Runtime(RuntimeCommand::ChannelLoginStart {
                channel,
                force,
                timeout_ms,
                account_id,
                config,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn wait_channel_login(
        &self,
        channel: String,
        timeout_ms: Option<u64>,
        account_id: Option<String>,
        session_key: Option<String>,
        current_qr_data_url: Option<String>,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> Result<crate::channel_login::Outcome, Error> {
        self.request(|reply| {
            Command::Runtime(RuntimeCommand::ChannelLoginWait {
                channel,
                timeout_ms,
                account_id,
                session_key,
                current_qr_data_url,
                cancellation,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn cancel_channel_login(
        &self,
        channel: String,
        account_id: Option<String>,
    ) -> Result<crate::channel_login::Outcome, Error> {
        self.request(|reply| {
            Command::Runtime(RuntimeCommand::ChannelLoginCancel {
                channel,
                account_id,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn logout_channel(
        &self,
        channel: String,
        account_id: Option<String>,
    ) -> Result<crate::channel_login::Outcome, Error> {
        self.request(|reply| {
            Command::Runtime(RuntimeCommand::ChannelLogout {
                channel,
                account_id,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn fleet_terminal_open_allocated(
        &self,
        selector: crate::fleet::owner::FleetTerminalTargetSelector,
        dimensions: fleet::terminal::Dimensions,
    ) -> Result<
        Result<crate::fleet::owner::FleetTerminalOpenResult, fleet::terminal::TerminalSessionError>,
        Error,
    > {
        self.request(|reply| {
            Command::Fleet(FleetCommand::TerminalOpenAllocated {
                selector,
                dimensions,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn fleet_terminal_consume_ticket(
        &self,
        ticket: Vec<u8>,
    ) -> Result<Result<fleet::terminal::SessionSummary, fleet::terminal::TerminalSessionError>, Error>
    {
        self.request(|reply| Command::Fleet(FleetCommand::TerminalConsumeTicket { ticket, reply }))
            .await
    }

    pub(crate) async fn fleet_terminal_provider_open(
        &self,
        context: crate::transport::fleet_terminal::TerminalContext,
    ) -> Result<
        crate::transport::fleet_terminal::TerminalProviderOpen,
        crate::transport::fleet_terminal::ProviderError,
    > {
        self.request(|reply| Command::Fleet(FleetCommand::TerminalProviderOpen { context, reply }))
            .await
            .map_err(|_| {
                crate::transport::fleet_terminal::ProviderError::message("Fleet owner unavailable")
            })?
            .map_err(|_| {
                crate::transport::fleet_terminal::ProviderError::message(
                    "Fleet terminal provider failed",
                )
            })
    }

    pub(crate) async fn fleet_terminal_context(
        &self,
        summary: fleet::terminal::SessionSummary,
    ) -> Result<Option<crate::transport::fleet_terminal::TerminalContext>, Error> {
        self.request(|reply| Command::Fleet(FleetCommand::TerminalContext { summary, reply }))
            .await
    }

    pub(crate) async fn fleet_terminal_resolve_context(
        &self,
        selector: crate::fleet::owner::FleetTerminalTargetSelector,
        summary: fleet::terminal::SessionSummary,
    ) -> Result<Option<crate::transport::fleet_terminal::TerminalContext>, Error> {
        self.request(|reply| {
            Command::Fleet(FleetCommand::TerminalResolveContext {
                selector,
                summary,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn fleet_terminal_close(
        &self,
        session: fleet::terminal::SessionId,
    ) -> Result<Result<fleet::terminal::SessionSummary, fleet::terminal::TerminalSessionError>, Error>
    {
        self.request(|reply| Command::Fleet(FleetCommand::TerminalCloseCurrent { session, reply }))
            .await
    }

    pub(crate) async fn fleet_terminal_close_fenced(
        &self,
        session: fleet::terminal::SessionId,
        generation: fleet::terminal::Generation,
    ) -> Result<Result<fleet::terminal::SessionSummary, fleet::terminal::TerminalSessionError>, Error>
    {
        self.request(|reply| {
            Command::Fleet(FleetCommand::TerminalClose {
                session,
                generation,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn fleet_terminal_reconnect(
        &self,
        session: fleet::terminal::SessionId,
    ) -> Result<Result<fleet::terminal::OpenedSession, fleet::terminal::TerminalSessionError>, Error>
    {
        self.request(|reply| Command::Fleet(FleetCommand::TerminalReconnect { session, reply }))
            .await
    }

    pub(crate) async fn fleet_terminal_begin_close(
        &self,
        session: fleet::terminal::SessionId,
    ) -> Result<Result<fleet::terminal::SessionSummary, fleet::terminal::TerminalSessionError>, Error>
    {
        self.request(|reply| {
            Command::Fleet(FleetCommand::TerminalBeginCloseCurrent { session, reply })
        })
        .await
    }

    pub(crate) async fn fleet_terminal_begin_close_fenced(
        &self,
        session: fleet::terminal::SessionId,
        generation: fleet::terminal::Generation,
    ) -> Result<Result<fleet::terminal::SessionSummary, fleet::terminal::TerminalSessionError>, Error>
    {
        self.request(|reply| {
            Command::Fleet(FleetCommand::TerminalBeginClose {
                session,
                generation,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn fleet_terminal_finish_close(
        &self,
        session: fleet::terminal::SessionId,
    ) -> Result<Result<fleet::terminal::SessionSummary, fleet::terminal::TerminalSessionError>, Error>
    {
        self.request(|reply| {
            Command::Fleet(FleetCommand::TerminalFinishCloseCurrent { session, reply })
        })
        .await
    }

    pub(crate) async fn fleet_terminal_finish_close_fenced(
        &self,
        session: fleet::terminal::SessionId,
        generation: fleet::terminal::Generation,
    ) -> Result<Result<fleet::terminal::SessionSummary, fleet::terminal::TerminalSessionError>, Error>
    {
        self.request(|reply| {
            Command::Fleet(FleetCommand::TerminalFinishClose {
                session,
                generation,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn fleet_terminal_list(
        &self,
    ) -> Result<Vec<fleet::terminal::SessionSummary>, Error> {
        self.request(|reply| Command::Fleet(FleetCommand::TerminalList { reply }))
            .await
    }

    pub(crate) async fn fleet_query_snapshot(
        &self,
        now: std::time::SystemTime,
    ) -> Result<fleet::query::FleetQuerySnapshot, Error> {
        self.request(|reply| Command::Fleet(FleetCommand::QuerySnapshot { now, reply }))
            .await
    }

    pub(crate) async fn fleet_snapshot(
        &self,
        now: std::time::SystemTime,
    ) -> Result<crate::fleet::owner::FleetSnapshot, Error> {
        self.request(|reply| Command::Fleet(FleetCommand::Snapshot { now, reply }))
            .await
    }

    pub(crate) async fn fleet_selector_preview(
        &self,
        constraints: fleet::query::SelectorConstraints,
        now: std::time::SystemTime,
    ) -> Result<fleet::query::SelectorPreview, Error> {
        self.request(|reply| {
            Command::Fleet(FleetCommand::SelectorPreview {
                constraints,
                now,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn fleet_upsert_connection(
        &self,
        record: fleet::connection::ConnectionRecord,
    ) -> Result<Result<fleet::connection::ConnectionMutation, fleet::FleetDeliveryError>, Error>
    {
        self.request(|reply| Command::Fleet(FleetCommand::UpsertConnection { record, reply }))
            .await
    }

    pub(crate) async fn fleet_delete_connection(
        &self,
        id: fleet::connection::ConnectionId,
    ) -> Result<Result<fleet::connection::ConnectionMutation, fleet::FleetDeliveryError>, Error>
    {
        self.request(|reply| Command::Fleet(FleetCommand::DeleteConnection { id, reply }))
            .await
    }

    pub(crate) async fn fleet_begin_connection_probe(
        &self,
        id: fleet::connection::ConnectionId,
        command_id: fleet::command::CommandId,
    ) -> Result<Result<fleet::connection::ConnectionMutation, fleet::FleetDeliveryError>, Error>
    {
        self.request(|reply| {
            Command::Fleet(FleetCommand::BeginConnectionProbe {
                id,
                command_id,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn fleet_run_connection_probe(
        &self,
        id: fleet::connection::ConnectionId,
        command_id: fleet::command::CommandId,
    ) -> Result<
        Result<crate::fleet::lifecycle::FleetConnectionLifecycleOutcome, fleet::FleetDeliveryError>,
        Error,
    > {
        self.request(|reply| {
            Command::Fleet(FleetCommand::RunConnectionProbe {
                id,
                command_id,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn fleet_run_environment_deployment(
        &self,
        id: fleet::environment::EnvironmentId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
    ) -> Result<
        Result<crate::fleet::lifecycle::FleetLifecycleOutcome, fleet::FleetDeliveryError>,
        Error,
    > {
        self.request(|reply| {
            Command::Fleet(FleetCommand::RunEnvironmentDeployment {
                id,
                command_id,
                phase,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn fleet_run_environment_deletion(
        &self,
        id: fleet::environment::EnvironmentId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
    ) -> Result<
        Result<crate::fleet::lifecycle::FleetLifecycleOutcome, fleet::FleetDeliveryError>,
        Error,
    > {
        self.request(|reply| {
            Command::Fleet(FleetCommand::RunEnvironmentDeletion {
                id,
                command_id,
                phase,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn fleet_run_resource_provisioning(
        &self,
        id: fleet::environment::ManagedResourceId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
    ) -> Result<
        Result<crate::fleet::lifecycle::FleetLifecycleOutcome, fleet::FleetDeliveryError>,
        Error,
    > {
        self.request(|reply| {
            Command::Fleet(FleetCommand::RunResourceProvisioning {
                id,
                command_id,
                phase,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn fleet_run_resource_deletion(
        &self,
        id: fleet::environment::ManagedResourceId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
    ) -> Result<
        Result<crate::fleet::lifecycle::FleetLifecycleOutcome, fleet::FleetDeliveryError>,
        Error,
    > {
        self.request(|reply| {
            Command::Fleet(FleetCommand::RunResourceDeletion {
                id,
                command_id,
                phase,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn fleet_complete_connection_probe(
        &self,
        id: fleet::connection::ConnectionId,
        command_id: fleet::command::CommandId,
        outcome: fleet::connection::ProbeOutcome,
        message: Option<String>,
    ) -> Result<Result<fleet::connection::ConnectionMutation, fleet::FleetDeliveryError>, Error>
    {
        self.request(|reply| {
            Command::Fleet(FleetCommand::CompleteConnectionProbe {
                id,
                command_id,
                outcome,
                message,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn fleet_begin_environment_deployment(
        &self,
        id: fleet::environment::EnvironmentId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
    ) -> Result<Result<fleet::environment::EnvironmentMutation, fleet::FleetDeliveryError>, Error>
    {
        self.request(|reply| {
            Command::Fleet(FleetCommand::BeginEnvironmentDeployment {
                id,
                command_id,
                phase,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn fleet_complete_environment_deployment(
        &self,
        id: fleet::environment::EnvironmentId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
    ) -> Result<Result<fleet::environment::EnvironmentMutation, fleet::FleetDeliveryError>, Error>
    {
        self.request(|reply| {
            Command::Fleet(FleetCommand::CompleteEnvironmentDeployment {
                id,
                command_id,
                phase,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn fleet_fail_environment_deployment(
        &self,
        id: fleet::environment::EnvironmentId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
        message: String,
    ) -> Result<Result<fleet::environment::EnvironmentMutation, fleet::FleetDeliveryError>, Error>
    {
        self.request(|reply| {
            Command::Fleet(FleetCommand::FailEnvironmentDeployment {
                id,
                command_id,
                phase,
                message,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn fleet_begin_environment_deletion(
        &self,
        id: fleet::environment::EnvironmentId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
    ) -> Result<Result<fleet::environment::EnvironmentMutation, fleet::FleetDeliveryError>, Error>
    {
        self.request(|reply| {
            Command::Fleet(FleetCommand::BeginEnvironmentDeletion {
                id,
                command_id,
                phase,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn fleet_complete_environment_deletion(
        &self,
        id: fleet::environment::EnvironmentId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
    ) -> Result<Result<fleet::environment::EnvironmentMutation, fleet::FleetDeliveryError>, Error>
    {
        self.request(|reply| {
            Command::Fleet(FleetCommand::CompleteEnvironmentDeletion {
                id,
                command_id,
                phase,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn fleet_fail_environment_deletion(
        &self,
        id: fleet::environment::EnvironmentId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
        message: String,
    ) -> Result<Result<fleet::environment::EnvironmentMutation, fleet::FleetDeliveryError>, Error>
    {
        self.request(|reply| {
            Command::Fleet(FleetCommand::FailEnvironmentDeletion {
                id,
                command_id,
                phase,
                message,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn fleet_start_resource_provisioning(
        &self,
        id: fleet::environment::ManagedResourceId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
    ) -> Result<Result<fleet::environment::ManagedResourceMutation, fleet::FleetDeliveryError>, Error>
    {
        self.request(|reply| {
            Command::Fleet(FleetCommand::StartResourceProvisioning {
                id,
                command_id,
                phase,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn fleet_complete_resource_provisioning(
        &self,
        id: fleet::environment::ManagedResourceId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
    ) -> Result<Result<fleet::environment::ManagedResourceMutation, fleet::FleetDeliveryError>, Error>
    {
        self.request(|reply| {
            Command::Fleet(FleetCommand::CompleteResourceProvisioning {
                id,
                command_id,
                phase,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn fleet_start_resource_deletion(
        &self,
        id: fleet::environment::ManagedResourceId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
    ) -> Result<Result<fleet::environment::ManagedResourceMutation, fleet::FleetDeliveryError>, Error>
    {
        self.request(|reply| {
            Command::Fleet(FleetCommand::StartResourceDeletion {
                id,
                command_id,
                phase,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn fleet_complete_resource_deletion(
        &self,
        id: fleet::environment::ManagedResourceId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
    ) -> Result<Result<fleet::environment::ManagedResourceMutation, fleet::FleetDeliveryError>, Error>
    {
        self.request(|reply| {
            Command::Fleet(FleetCommand::CompleteResourceDeletion {
                id,
                command_id,
                phase,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn fleet_fail_resource_deletion(
        &self,
        id: fleet::environment::ManagedResourceId,
        command_id: fleet::command::CommandId,
        phase: fleet::effect::PhaseKey,
        message: String,
    ) -> Result<Result<fleet::environment::ManagedResourceMutation, fleet::FleetDeliveryError>, Error>
    {
        self.request(|reply| {
            Command::Fleet(FleetCommand::FailResourceDeletion {
                id,
                command_id,
                phase,
                message,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn fleet_register_environment(
        &self,
        record: fleet::environment::EnvironmentRecord,
    ) -> Result<Result<fleet::environment::EnvironmentMutation, fleet::FleetDeliveryError>, Error>
    {
        self.request(|reply| Command::Fleet(FleetCommand::RegisterEnvironment { record, reply }))
            .await
    }

    pub(crate) async fn fleet_register_resource(
        &self,
        request: ManagedResourceRegistrationRequest,
    ) -> Result<Result<fleet::environment::ManagedResourceMutation, fleet::FleetDeliveryError>, Error>
    {
        self.request(|reply| Command::Fleet(FleetCommand::RegisterResource { request, reply }))
            .await
    }

    pub(crate) async fn fleet_target_summaries(
        &self,
    ) -> Result<Vec<crate::fleet::owner::FleetTargetSummary>, Error> {
        self.request(|reply| Command::Fleet(FleetCommand::TargetSummaries { reply }))
            .await
    }

    pub(crate) async fn fleet_target_selector(
        &self,
        id: fleet::TargetId,
        revision: u64,
        kind: fleet::TargetKind,
    ) -> Result<Option<fleet::FleetTargetSelector>, Error> {
        self.request(|reply| {
            Command::Fleet(FleetCommand::TargetSelector {
                id,
                revision,
                kind,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn fleet_topology_summary(
        &self,
    ) -> Result<crate::fleet::owner::FleetTopologySummary, Error> {
        self.request(|reply| Command::Fleet(FleetCommand::TopologySummary { reply }))
            .await
    }

    pub(crate) async fn fleet_put_target(
        &self,
        id: fleet::TargetId,
        config: fleet::FleetTargetConfig,
    ) -> Result<Result<fleet::TargetSnapshot, fleet::FleetDeliveryError>, Error> {
        self.request(|reply| Command::Fleet(FleetCommand::PutTarget { id, config, reply }))
            .await
    }

    pub(crate) async fn fleet_remove_target(
        &self,
        id: fleet::TargetId,
    ) -> Result<Result<bool, fleet::FleetDeliveryError>, Error> {
        self.request(|reply| Command::Fleet(FleetCommand::RemoveTarget { id, reply }))
            .await
    }

    pub(crate) async fn fleet_submit(
        &self,
        request: fleet::FleetDeliveryRequest,
    ) -> Result<Result<fleet::FleetSubmitOutcome, fleet::FleetDeliveryError>, Error> {
        self.request(|reply| Command::Fleet(FleetCommand::Submit { request, reply }))
            .await
    }

    pub(crate) async fn fleet_node_command_request(
        &self,
        request: crate::fleet::owner::FleetNodeCommandRequest,
    ) -> Result<
        Result<crate::fleet::owner::FleetNodeCommandResolution, fleet::FleetDeliveryError>,
        Error,
    > {
        self.request(|reply| Command::Fleet(FleetCommand::NodeCommandRequest { request, reply }))
            .await
    }

    pub(crate) async fn fleet_begin(
        &self,
        dispatch_id: fleet::outbox::DispatchId,
    ) -> Result<Result<crate::fleet::owner::FleetDispatchResult, fleet::FleetDeliveryError>, Error>
    {
        self.request(|reply| Command::Fleet(FleetCommand::Begin { dispatch_id, reply }))
            .await
    }

    pub(crate) async fn fleet_accept(
        &self,
        dispatch_id: fleet::outbox::DispatchId,
        attempt: fleet::outbox::DispatchAttempt,
    ) -> Result<Result<fleet::FleetDeliveryOutcome, fleet::FleetDeliveryError>, Error> {
        self.request(|reply| {
            Command::Fleet(FleetCommand::Accept {
                dispatch_id,
                attempt,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn fleet_reject(
        &self,
        dispatch_id: fleet::outbox::DispatchId,
        attempt: fleet::outbox::DispatchAttempt,
    ) -> Result<Result<fleet::FleetDeliveryOutcome, fleet::FleetDeliveryError>, Error> {
        self.request(|reply| {
            Command::Fleet(FleetCommand::Reject {
                dispatch_id,
                attempt,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn fleet_unknown(
        &self,
        dispatch_id: fleet::outbox::DispatchId,
        attempt: fleet::outbox::DispatchAttempt,
    ) -> Result<Result<fleet::FleetDeliveryOutcome, fleet::FleetDeliveryError>, Error> {
        self.request(|reply| {
            Command::Fleet(FleetCommand::Unknown {
                dispatch_id,
                attempt,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn fleet_replay(
        &self,
        command_id: fleet::command::CommandId,
        dispatch_id: fleet::outbox::DispatchId,
    ) -> Result<Result<fleet::FleetDeliveryOutcome, fleet::FleetDeliveryError>, Error> {
        self.request(|reply| {
            Command::Fleet(FleetCommand::Replay {
                command_id,
                dispatch_id,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn fleet_retire_node(
        &self,
        id: fleet::topology::NodeId,
    ) -> Result<Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>, Error> {
        self.request(|reply| Command::Fleet(FleetCommand::RetireNode { id, reply }))
            .await
    }

    pub(crate) async fn fleet_begin_runtime_start(
        &self,
        id: fleet::topology::RuntimeId,
        command_id: fleet::command::CommandId,
    ) -> Result<Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>, Error> {
        self.request(|reply| {
            Command::Fleet(FleetCommand::BeginRuntimeStart {
                id,
                command_id,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn fleet_complete_runtime_start(
        &self,
        id: fleet::topology::RuntimeId,
        command_id: fleet::command::CommandId,
    ) -> Result<Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>, Error> {
        self.request(|reply| {
            Command::Fleet(FleetCommand::CompleteRuntimeStart {
                id,
                command_id,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn fleet_begin_runtime_stop(
        &self,
        id: fleet::topology::RuntimeId,
        command_id: fleet::command::CommandId,
    ) -> Result<Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>, Error> {
        self.request(|reply| {
            Command::Fleet(FleetCommand::BeginRuntimeStop {
                id,
                command_id,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn fleet_complete_runtime_stop(
        &self,
        id: fleet::topology::RuntimeId,
        command_id: fleet::command::CommandId,
    ) -> Result<Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>, Error> {
        self.request(|reply| {
            Command::Fleet(FleetCommand::CompleteRuntimeStop {
                id,
                command_id,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn fleet_retire_runtime(
        &self,
        id: fleet::topology::RuntimeId,
    ) -> Result<Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>, Error> {
        self.request(|reply| Command::Fleet(FleetCommand::RetireRuntime { id, reply }))
            .await
    }

    pub(crate) async fn fleet_drain_endpoint(
        &self,
        id: platform::endpoint::EndpointId,
    ) -> Result<Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>, Error> {
        self.request(|reply| Command::Fleet(FleetCommand::DrainEndpoint { id, reply }))
            .await
    }

    pub(crate) async fn fleet_retire_endpoint(
        &self,
        id: platform::endpoint::EndpointId,
    ) -> Result<Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>, Error> {
        self.request(|reply| Command::Fleet(FleetCommand::RetireEndpoint { id, reply }))
            .await
    }

    pub(crate) async fn fleet_begin_endpoint_probe(
        &self,
        id: platform::endpoint::EndpointId,
        command_id: fleet::command::CommandId,
    ) -> Result<Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>, Error> {
        self.request(|reply| {
            Command::Fleet(FleetCommand::BeginEndpointProbe {
                id,
                command_id,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn fleet_complete_endpoint_probe(
        &self,
        id: platform::endpoint::EndpointId,
        command_id: fleet::command::CommandId,
        health: fleet::topology::EndpointHealth,
    ) -> Result<Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>, Error> {
        self.request(|reply| {
            Command::Fleet(FleetCommand::CompleteEndpointProbe {
                id,
                command_id,
                health,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn fleet_begin_capability_sync(
        &self,
        id: platform::endpoint::EndpointId,
        command_id: fleet::command::CommandId,
    ) -> Result<Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>, Error> {
        self.request(|reply| {
            Command::Fleet(FleetCommand::BeginCapabilitySync {
                id,
                command_id,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn fleet_complete_capability_sync(
        &self,
        id: platform::endpoint::EndpointId,
        command_id: fleet::command::CommandId,
        sync: fleet::topology::CapabilitySync,
    ) -> Result<Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>, Error> {
        self.request(|reply| {
            Command::Fleet(FleetCommand::CompleteCapabilitySync {
                id,
                command_id,
                sync,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn fleet_upsert_node(
        &self,
        observation: fleet::topology::NodeObservation,
    ) -> Result<Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>, Error> {
        self.request(|reply| Command::Fleet(FleetCommand::UpsertNode { observation, reply }))
            .await
    }
    pub(crate) async fn fleet_upsert_agent(
        &self,
        observation: fleet::topology::AgentObservation,
    ) -> Result<Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>, Error> {
        self.request(|reply| Command::Fleet(FleetCommand::UpsertAgent { observation, reply }))
            .await
    }

    pub(crate) async fn fleet_write_credential(
        &self,
        request: crate::fleet::credentials::FleetCredentialWriteRequest,
    ) -> Result<
        Result<
            crate::fleet::credentials::FleetCredentialWriteOutcome,
            crate::fleet::credentials::FleetCredentialVaultError,
        >,
        Error,
    > {
        self.request(|reply| Command::Fleet(FleetCommand::WriteCredential { request, reply }))
            .await
    }

    pub(crate) async fn fleet_revoke_agent(
        &self,
        id: platform::endpoint::NativeAgentId,
    ) -> Result<Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>, Error> {
        self.request(|reply| Command::Fleet(FleetCommand::RevokeAgent { id, reply }))
            .await
    }
    pub(crate) async fn fleet_upsert_runtime(
        &self,
        observation: fleet::topology::RuntimeObservation,
    ) -> Result<Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>, Error> {
        self.request(|reply| Command::Fleet(FleetCommand::UpsertRuntime { observation, reply }))
            .await
    }
    pub(crate) async fn fleet_upsert_endpoint(
        &self,
        observation: fleet::topology::EndpointObservation,
    ) -> Result<Result<fleet::topology::TopologyMutation, fleet::FleetDeliveryError>, Error> {
        self.request(|reply| Command::Fleet(FleetCommand::UpsertEndpoint { observation, reply }))
            .await
    }

    pub(crate) async fn fleet_authenticate_runtime_agent_ingress(
        &self,
        identity: fleet::store::AgentIngressIdentity,
    ) -> Result<Result<fleet::store::IngressAuthentication, fleet::FleetDeliveryError>, Error> {
        self.request(|reply| {
            Command::Fleet(FleetCommand::AuthenticateRuntimeAgentIngress { identity, reply })
        })
        .await
    }

    pub(crate) async fn fleet_register_runtime_agent(
        &self,
        agent: fleet::runtime_agent::RuntimeAgent,
    ) -> Result<Result<(), fleet::FleetDeliveryError>, Error> {
        self.request(|reply| Command::Fleet(FleetCommand::RegisterRuntimeAgent { agent, reply }))
            .await
    }

    pub(crate) async fn fleet_register_runtime_agent_command(
        &self,
        agent_id: fleet::runtime_agent::RuntimeAgentId,
        correlation: fleet::runtime_agent::CommandCorrelation,
        queued_at: std::time::SystemTime,
        command_attempt: fleet::command::CommandAttempt,
        dispatch_attempt: fleet::outbox::DispatchAttempt,
    ) -> Result<Result<(), fleet::FleetDeliveryError>, Error> {
        self.request(|reply| {
            Command::Fleet(FleetCommand::RegisterRuntimeAgentCommand {
                agent_id,
                correlation,
                queued_at,
                command_attempt,
                dispatch_attempt,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn fleet_record_runtime_agent_heartbeat(
        &self,
        agent_id: fleet::runtime_agent::RuntimeAgentId,
        heartbeat: fleet::runtime_agent::RuntimeAgentHeartbeat,
    ) -> Result<
        Result<fleet::runtime_agent::RuntimeAgentReportOutcome, fleet::FleetDeliveryError>,
        Error,
    > {
        self.request(|reply| {
            Command::Fleet(FleetCommand::RecordRuntimeAgentHeartbeat {
                agent_id,
                heartbeat,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn fleet_record_runtime_agent_progress(
        &self,
        agent_id: fleet::runtime_agent::RuntimeAgentId,
        correlation: fleet::runtime_agent::CommandCorrelation,
        progress: fleet::runtime_agent::RuntimeAgentProgress,
        reported_at: std::time::SystemTime,
        command_attempt: fleet::command::CommandAttempt,
        dispatch_attempt: fleet::outbox::DispatchAttempt,
    ) -> Result<
        Result<fleet::runtime_agent::RuntimeAgentReportOutcome, fleet::FleetDeliveryError>,
        Error,
    > {
        self.request(|reply| {
            Command::Fleet(FleetCommand::RecordRuntimeAgentProgress {
                agent_id,
                correlation,
                progress,
                reported_at,
                command_attempt,
                dispatch_attempt,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn fleet_record_runtime_agent_result(
        &self,
        agent_id: fleet::runtime_agent::RuntimeAgentId,
        correlation: fleet::runtime_agent::CommandCorrelation,
        result: fleet::runtime_agent::RuntimeAgentResult,
        command_attempt: fleet::command::CommandAttempt,
        dispatch_attempt: fleet::outbox::DispatchAttempt,
    ) -> Result<
        Result<fleet::runtime_agent::RuntimeAgentReportOutcome, fleet::FleetDeliveryError>,
        Error,
    > {
        self.request(|reply| {
            Command::Fleet(FleetCommand::RecordRuntimeAgentResult {
                agent_id,
                correlation,
                result,
                command_attempt,
                dispatch_attempt,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn start_matcha(
        &self,
    ) -> Result<Result<RuntimeState, StartMatchaError>, Error> {
        self.request(|reply| Command::Matcha(MatchaCommand::Start(reply)))
            .await
    }

    pub(crate) async fn stop_matcha(&self) -> Result<Result<RuntimeState, StopMatchaError>, Error> {
        self.request(|reply| Command::Matcha(MatchaCommand::Stop(reply)))
            .await
    }

    pub(crate) async fn restart_matcha(
        &self,
    ) -> Result<Result<RuntimeState, RestartMatchaError>, Error> {
        self.request(|reply| Command::Matcha(MatchaCommand::Restart(reply)))
            .await
    }

    pub(crate) async fn open_claw_installation_status(
        &self,
    ) -> Result<Option<openclaw::projection::installation::Status>, Error> {
        self.request(|reply| Command::Runtime(RuntimeCommand::Environment(reply)))
            .await
    }

    pub(crate) async fn open_claw_runtime_paths(
        &self,
    ) -> Result<
        Result<
            openclaw::projection::runtime_paths::RuntimePaths,
            openclaw::projection::runtime_paths::RuntimePathsError,
        >,
        Error,
    > {
        self.request(|reply| Command::Runtime(RuntimeCommand::RuntimePaths(reply)))
            .await
    }

    pub(crate) async fn open_claw_cli_command(
        &self,
    ) -> Result<
        Result<
            openclaw::projection::runtime_paths::CliCommand,
            openclaw::projection::runtime_paths::CliCommandError,
        >,
        Error,
    > {
        self.request(|reply| Command::Runtime(RuntimeCommand::CliCommand(reply)))
            .await
    }

    pub(crate) async fn open_claw_tool_permission_mode(
        &self,
    ) -> Result<
        Result<
            openclaw::projection::tool_permission::Mode,
            openclaw::projection::tool_permission::Error,
        >,
        Error,
    > {
        self.request(|reply| Command::Runtime(RuntimeCommand::ToolPermissionMode(reply)))
            .await
    }

    pub(crate) async fn set_open_claw_tool_permission_mode(
        &self,
        mode: openclaw::projection::tool_permission::Mode,
    ) -> Result<
        Result<
            openclaw::projection::tool_permission::Effect,
            openclaw::projection::tool_permission::Error,
        >,
        Error,
    > {
        self.request(|reply| {
            Command::Runtime(RuntimeCommand::SetToolPermissionMode { mode, reply })
        })
        .await
    }

    pub(crate) async fn open_claw_toolchain_status(
        &self,
    ) -> Result<Result<openclaw::toolchain::ToolchainStatus, RequestAdmissionClosed>, Error> {
        self.request(|reply| Command::Runtime(RuntimeCommand::ToolchainStatus(reply)))
            .await
    }

    pub(crate) async fn install_open_claw_uv(
        &self,
    ) -> Result<Result<openclaw::toolchain::UvInstallOutcome, RequestAdmissionClosed>, Error> {
        self.request(|reply| Command::Runtime(RuntimeCommand::InstallToolchainUv(reply)))
            .await
    }

    pub(crate) async fn submit_open_claw_toolchain_install(
        &self,
    ) -> Result<Result<openclaw::toolchain::ToolchainJobSubmission, RequestAdmissionClosed>, Error>
    {
        self.request(|reply| Command::Runtime(RuntimeCommand::SubmitToolchainInstall(reply)))
            .await
    }

    pub(crate) async fn get_open_claw_toolchain_job(
        &self,
        job_id: String,
    ) -> Result<Result<openclaw::toolchain::ToolchainJobLookup, RequestAdmissionClosed>, Error>
    {
        self.request(|reply| Command::Runtime(RuntimeCommand::GetToolchainJob { job_id, reply }))
            .await
    }

    pub(crate) async fn get_compatible_runtime_job(
        &self,
        job_id: String,
    ) -> Result<
        Result<
            crate::projection::job_compatibility::JobCompatibilityLookup,
            RequestAdmissionClosed,
        >,
        Error,
    > {
        self.request(|reply| Command::GetCompatibleRuntimeJob { job_id, reply })
            .await
    }

    pub(crate) async fn plugins_catalog(
        &self,
    ) -> Result<Result<PluginCatalog, PluginError>, Error> {
        self.request(|reply| Command::Runtime(RuntimeCommand::PluginsCatalog(reply)))
            .await
    }

    pub(crate) async fn plugins_runtime(
        &self,
    ) -> Result<Result<PluginRuntime, PluginError>, Error> {
        self.request(|reply| Command::Runtime(RuntimeCommand::PluginsRuntime(reply)))
            .await
    }

    pub(crate) async fn plugins_set_enabled(
        &self,
        plugin_id: String,
        enabled: bool,
    ) -> Result<PluginConfigurationOutcome, Error> {
        self.request(|reply| {
            Command::Runtime(RuntimeCommand::PluginsSetEnabled {
                plugin_id,
                enabled,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn plugins_operation(
        &self,
        operation: PluginOperation,
        plugin_id: String,
    ) -> Result<PluginOperationOutcome, Error> {
        self.request(|reply| {
            Command::Runtime(RuntimeCommand::PluginsOperation {
                operation,
                plugin_id,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn list_subagent_templates(
        &self,
    ) -> Result<
        Result<
            openclaw::projection::subagent_templates::Catalog,
            openclaw::projection::subagent_templates::SubagentTemplateError,
        >,
        Error,
    > {
        self.request(|reply| Command::Runtime(RuntimeCommand::ListSubagentTemplates(reply)))
            .await
    }

    pub(crate) async fn subagent_template(
        &self,
        id: String,
    ) -> Result<
        Result<
            openclaw::projection::subagent_templates::Detail,
            openclaw::projection::subagent_templates::SubagentTemplateError,
        >,
        Error,
    > {
        self.request(|reply| Command::Runtime(RuntimeCommand::SubagentTemplate { id, reply }))
            .await
    }

    pub(crate) async fn start_open_claw(
        &self,
    ) -> Result<Result<RuntimeState, StartOpenClawError>, Error> {
        self.request(|reply| Command::Runtime(RuntimeCommand::Start(reply)))
            .await
    }

    pub(crate) async fn stop_open_claw(
        &self,
    ) -> Result<Result<RuntimeState, StopOpenClawError>, Error> {
        self.request(|reply| Command::Runtime(RuntimeCommand::Stop(reply)))
            .await
    }

    pub(crate) async fn restart_open_claw(
        &self,
    ) -> Result<Result<RuntimeState, RestartOpenClawError>, Error> {
        self.request(|reply| Command::Runtime(RuntimeCommand::Restart(reply)))
            .await
    }

    pub(crate) async fn open_claw_logs(
        &self,
        cursor: Option<u64>,
    ) -> Result<Result<OpenClawLogSnapshot, ()>, Error> {
        self.request(|reply| Command::Runtime(RuntimeCommand::Logs { cursor, reply }))
            .await
    }

    pub(crate) async fn open_claw_gateway_health(
        &self,
        probe: bool,
    ) -> Result<Result<openclaw::gateway::wire::GatewayHealthSnapshot, ()>, Error> {
        match self.open_claw_gateway_health_observation(probe).await {
            Ok(Ok(observation)) => Ok(observation.observe().await.map_err(|_| ())),
            Ok(Err(_)) => Ok(Err(())),
            Err(error) => Err(error),
        }
    }

    pub(crate) async fn open_claw_gateway_health_observation(
        &self,
        probe: bool,
    ) -> Result<Result<OpenClawGatewayHealthObservation, RequestAdmissionClosed>, Error> {
        self.request(|reply| Command::Runtime(RuntimeCommand::GatewayHealth { probe, reply }))
            .await
    }

    pub(crate) async fn open_claw_gateway_status(
        &self,
        include_channel_summary: bool,
    ) -> Result<Result<openclaw::gateway::wire::GatewayStatusSnapshot, ()>, Error> {
        match self
            .open_claw_gateway_status_observation(include_channel_summary)
            .await
        {
            Ok(Ok(observation)) => Ok(observation.observe().await.map_err(|_| ())),
            Ok(Err(_)) => Ok(Err(())),
            Err(error) => Err(error),
        }
    }

    pub(crate) async fn open_claw_gateway_status_observation(
        &self,
        include_channel_summary: bool,
    ) -> Result<Result<OpenClawGatewayStatusObservation, RequestAdmissionClosed>, Error> {
        self.request(|reply| {
            Command::Runtime(RuntimeCommand::GatewayStatus {
                include_channel_summary,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn open_claw_control_ui_url(&self) -> Result<String, Error> {
        self.request(|reply| Command::Runtime(RuntimeCommand::ControlUiUrl(reply)))
            .await
    }

    pub(crate) async fn control_lease(
        &self,
    ) -> Result<Result<ControlLease, RequestAdmissionClosed>, Error> {
        self.request(|reply| Command::Runtime(RuntimeCommand::ControlLease(reply)))
            .await
    }

    pub(crate) async fn trigger_open_claw_cron(
        &self,
        job_id: String,
    ) -> Result<Result<openclaw::port::CronTriggerOutcome, RequestAdmissionClosed>, Error> {
        self.request(|reply| Command::Runtime(RuntimeCommand::TriggerCron { job_id, reply }))
            .await
    }

    pub(crate) async fn observe_open_claw_channel_accounts(
        &self,
    ) -> Result<Result<ChannelStatusOutcome, ChannelStatusFailure>, Error> {
        self.request(|reply| Command::Runtime(RuntimeCommand::ChannelAccounts(reply)))
            .await
    }

    pub(crate) async fn observe_open_claw_channel_snapshot(
        &self,
    ) -> Result<Result<ChannelSnapshotOutcome, ChannelStatusFailure>, Error> {
        self.request(|reply| Command::Runtime(RuntimeCommand::ChannelSnapshot(reply)))
            .await
    }

    pub(crate) async fn control_open_claw_channel_account(
        &self,
        action: crate::channel_control::ChannelControlAction,
        channel: String,
        account: String,
    ) -> Result<crate::channel_control::ChannelControlOutcome, Error> {
        self.request(|reply| {
            Command::Runtime(RuntimeCommand::ChannelControl {
                action,
                channel,
                account,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn list_open_claw_channel_pairing(
        &self,
        channel: String,
        account: Option<String>,
    ) -> Result<ChannelPairingOutcome, Error> {
        self.request(|reply| {
            Command::Runtime(RuntimeCommand::ChannelPairing {
                channel,
                account,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn approve_open_claw_channel_pairing(
        &self,
        channel: String,
        account: Option<String>,
        code: zeroize::Zeroizing<Vec<u8>>,
    ) -> Result<crate::channel_status::ChannelPairingApprovalOutcome, Error> {
        self.request(|reply| {
            Command::Runtime(RuntimeCommand::ApproveChannelPairing {
                channel,
                account,
                code,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn install_clawhub_skill(
        &self,
        command: SkillInstallCommand,
    ) -> Result<SkillInstallOutcome, Error> {
        self.request(|reply| Command::SkillInstall { command, reply })
            .await
    }

    pub(crate) async fn skill_bundles(
        &self,
        command: crate::skill_bundle::Command,
    ) -> Result<crate::skill_bundle::Outcome, Error> {
        self.request(|reply| Command::SkillBundle { command, reply })
            .await
    }

    pub(crate) async fn external_connector_catalog(
        &self,
    ) -> Result<crate::external_connectors::CatalogOutcome, Error> {
        self.request(|reply| {
            Command::ExternalConnectors(ExternalConnectorsCommand::Catalog { reply })
        })
        .await
    }

    pub(crate) async fn list_external_connectors(
        &self,
    ) -> Result<crate::external_connectors::ListOutcome, Error> {
        self.request(|reply| Command::ExternalConnectors(ExternalConnectorsCommand::List { reply }))
            .await
    }

    pub(crate) async fn get_external_connector(
        &self,
        id: String,
    ) -> Result<crate::external_connectors::GetOutcome, Error> {
        self.request(|reply| {
            Command::ExternalConnectors(ExternalConnectorsCommand::Get { id, reply })
        })
        .await
    }

    pub(crate) async fn upsert_external_connector(
        &self,
        connector: environment::Connector,
    ) -> Result<crate::external_connectors::MutationOutcome, Error> {
        self.request(|reply| {
            Command::ExternalConnectors(ExternalConnectorsCommand::Upsert {
                connector: Box::new(connector),
                reply,
            })
        })
        .await
    }

    pub(crate) async fn remove_external_connector(
        &self,
        id: String,
    ) -> Result<crate::external_connectors::MutationOutcome, Error> {
        self.request(|reply| {
            Command::ExternalConnectors(ExternalConnectorsCommand::Remove { id, reply })
        })
        .await
    }

    pub(crate) async fn probe_external_connector(
        &self,
        id: String,
    ) -> Result<crate::external_connectors::ProbeOutcome, Error> {
        self.request(|reply| {
            Command::ExternalConnectors(ExternalConnectorsCommand::Probe { id, reply })
        })
        .await
    }

    pub(crate) async fn session_connector_status(
        &self,
        identity: crate::external_connectors::SessionIdentity,
    ) -> Result<crate::external_connectors::SessionStatusOutcome, Error> {
        self.request(|reply| {
            Command::ExternalConnectors(ExternalConnectorsCommand::SessionStatus {
                identity,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn configure_provider_private_resolver(
        &self,
        resolver: crate::transport::provider_accounts::private_auth::Resolver,
    ) -> Result<(), Error> {
        self.request(|reply| {
            Command::ProviderAccounts(ProviderAccountsCommand::ConfigurePrivateResolver {
                resolver,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn list_provider_accounts(
        &self,
    ) -> Result<crate::transport::provider_accounts::ProviderAccountsDelivery, Error> {
        self.request(|reply| Command::ProviderAccounts(ProviderAccountsCommand::List { reply }))
            .await
    }

    pub(crate) async fn get_provider_account(
        &self,
        id: environment::ProviderAccountId,
    ) -> Result<crate::transport::provider_accounts::ProviderAccountsDelivery, Error> {
        self.request(|reply| Command::ProviderAccounts(ProviderAccountsCommand::Get { id, reply }))
            .await
    }

    pub(crate) async fn replace_provider_account(
        &self,
        draft: crate::transport::provider_accounts::AccountDraft,
    ) -> Result<crate::transport::provider_accounts::ProviderAccountsDelivery, Error> {
        self.request(|reply| {
            Command::ProviderAccounts(ProviderAccountsCommand::Replace { draft, reply })
        })
        .await
    }

    pub(crate) async fn delete_provider_account(
        &self,
        id: environment::ProviderAccountId,
        revision: environment::ProviderAccountRevision,
    ) -> Result<crate::transport::provider_accounts::ProviderAccountsDelivery, Error> {
        self.request(|reply| {
            Command::ProviderAccounts(ProviderAccountsCommand::Delete {
                id,
                revision,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn list_provider_models(
        &self,
    ) -> Result<crate::provider_models::ProviderModelListOutcome, Error> {
        self.request(|reply| Command::ProviderModels(ProviderModelsCommand::List { reply }))
            .await
    }

    pub(crate) async fn selectable_provider_models(
        &self,
        capability: environment::ProviderModelCapability,
    ) -> Result<crate::provider_models::ProviderModelSelectableOutcome, Error> {
        self.request(|reply| {
            Command::ProviderModels(ProviderModelsCommand::Selectable { capability, reply })
        })
        .await
    }

    pub(crate) async fn replace_provider_models(
        &self,
        account_id: String,
        drafts: Vec<crate::provider_models::ProviderModelDraft>,
    ) -> Result<crate::provider_models::ProviderModelReplaceOutcome, Error> {
        self.request(|reply| {
            Command::ProviderModels(ProviderModelsCommand::Replace {
                account_id,
                drafts,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn list_provider_routing(
        &self,
    ) -> Result<crate::provider_routing::ProviderRoutingListOutcome, Error> {
        self.request(|reply| Command::ProviderRouting(ProviderRoutingCommand::List { reply }))
            .await
    }

    pub(crate) async fn replace_provider_routing(
        &self,
        routing: environment::ProviderRouting,
    ) -> Result<crate::provider_routing::ProviderRoutingReplaceOutcome, Error> {
        self.request(|reply| {
            Command::ProviderRouting(ProviderRoutingCommand::Replace { routing, reply })
        })
        .await
    }

    pub(crate) async fn platform_tools(&self) -> Result<crate::platform_tools::Outcome, Error> {
        self.request(|reply| Command::PlatformTools { reply }).await
    }

    pub(crate) async fn agents_list(
        &self,
        endpoint: crate::agents::NativeEndpoint,
    ) -> Result<crate::agents::Outcome, Error> {
        self.request(|reply| Command::Agents {
            command: crate::agents::Command::List { endpoint },
            reply,
        })
        .await
    }

    pub(crate) async fn agents_wait(
        &self,
        endpoint: crate::agents::NativeEndpoint,
        input: openclaw::agents::AgentWait,
    ) -> Result<crate::agents::Outcome, Error> {
        self.request(|reply| Command::Agents {
            command: crate::agents::Command::Wait { endpoint, input },
            reply,
        })
        .await
    }

    pub(crate) async fn agents_create(
        &self,
        endpoint: crate::agents::NativeEndpoint,
        input: AgentCreate,
    ) -> Result<crate::agents::Outcome, Error> {
        self.request(|reply| Command::Agents {
            command: crate::agents::Command::Create { endpoint, input },
            reply,
        })
        .await
    }

    pub(crate) async fn agents_update(
        &self,
        endpoint: crate::agents::NativeEndpoint,
        input: AgentUpdate,
    ) -> Result<crate::agents::Outcome, Error> {
        self.request(|reply| Command::Agents {
            command: crate::agents::Command::Update { endpoint, input },
            reply,
        })
        .await
    }

    pub(crate) async fn agents_delete(
        &self,
        endpoint: crate::agents::NativeEndpoint,
        input: AgentDelete,
    ) -> Result<crate::agents::Outcome, Error> {
        self.request(|reply| Command::Agents {
            command: crate::agents::Command::Delete { endpoint, input },
            reply,
        })
        .await
    }

    pub(crate) async fn agents_files_list(
        &self,
        endpoint: crate::agents::NativeEndpoint,
        agent_id: String,
    ) -> Result<crate::agents::Outcome, Error> {
        self.request(|reply| Command::Agents {
            command: crate::agents::Command::ListFiles { endpoint, agent_id },
            reply,
        })
        .await
    }

    pub(crate) async fn agents_files_get(
        &self,
        endpoint: crate::agents::NativeEndpoint,
        agent_id: String,
        name: AgentFileName,
    ) -> Result<crate::agents::Outcome, Error> {
        self.request(|reply| Command::Agents {
            command: crate::agents::Command::GetFile {
                endpoint,
                agent_id,
                name,
            },
            reply,
        })
        .await
    }

    pub(crate) async fn agents_files_set(
        &self,
        endpoint: crate::agents::NativeEndpoint,
        agent_id: String,
        name: AgentFileName,
        content: String,
    ) -> Result<crate::agents::Outcome, Error> {
        self.request(|reply| Command::Agents {
            command: crate::agents::Command::SetFile {
                endpoint,
                agent_id,
                name,
                content,
            },
            reply,
        })
        .await
    }

    pub(crate) async fn agents_configuration_display(
        &self,
        endpoint: crate::agents::NativeEndpoint,
    ) -> Result<crate::agents::Outcome, Error> {
        self.request(|reply| Command::Agents {
            command: crate::agents::Command::DisplayConfiguration { endpoint },
            reply,
        })
        .await
    }

    pub(crate) async fn agents_set_description(
        &self,
        endpoint: crate::agents::NativeEndpoint,
        agent_id: String,
        description: Option<String>,
    ) -> Result<crate::agents::Outcome, Error> {
        self.request(|reply| Command::Agents {
            command: crate::agents::Command::SetDescription {
                endpoint,
                agent_id,
                description,
            },
            reply,
        })
        .await
    }

    pub(crate) async fn agents_set_configuration_model(
        &self,
        endpoint: crate::agents::NativeEndpoint,
        agent_id: String,
        model: Option<openclaw::projection::agent_configuration::Model>,
    ) -> Result<crate::agents::Outcome, Error> {
        self.request(|reply| Command::Agents {
            command: crate::agents::Command::SetConfigurationModel {
                endpoint,
                agent_id,
                model,
            },
            reply,
        })
        .await
    }

    pub(crate) async fn agents_set_skills(
        &self,
        endpoint: crate::agents::NativeEndpoint,
        agent_id: String,
        skills: Vec<String>,
    ) -> Result<crate::agents::Outcome, Error> {
        self.request(|reply| Command::Agents {
            command: crate::agents::Command::SetSkills {
                endpoint,
                agent_id,
                skills,
            },
            reply,
        })
        .await
    }

    pub(crate) async fn agents_skill_configuration(
        &self,
        endpoint: crate::agents::NativeEndpoint,
        agent_id: String,
    ) -> Result<crate::agents::Outcome, Error> {
        self.request(|reply| Command::Agents {
            command: crate::agents::Command::SkillConfiguration { endpoint, agent_id },
            reply,
        })
        .await
    }

    pub(crate) async fn agents_set_skill_configuration(
        &self,
        endpoint: crate::agents::NativeEndpoint,
        agent_id: String,
        revision: String,
        selection: openclaw::projection::agent_configuration::SkillSelection,
    ) -> Result<crate::agents::Outcome, Error> {
        self.request(|reply| Command::Agents {
            command: crate::agents::Command::SetSkillConfiguration {
                endpoint,
                agent_id,
                revision,
                selection,
            },
            reply,
        })
        .await
    }

    pub(crate) async fn agents_tool_configuration(
        &self,
        endpoint: crate::agents::NativeEndpoint,
        agent_id: String,
    ) -> Result<crate::agents::Outcome, Error> {
        self.request(|reply| Command::Agents {
            command: crate::agents::Command::ToolConfiguration { endpoint, agent_id },
            reply,
        })
        .await
    }

    pub(crate) async fn agents_set_tool_configuration(
        &self,
        endpoint: crate::agents::NativeEndpoint,
        agent_id: String,
        revision: String,
        selection: openclaw::projection::agent_configuration::ToolSelection,
    ) -> Result<crate::agents::Outcome, Error> {
        self.request(|reply| Command::Agents {
            command: crate::agents::Command::SetToolConfiguration {
                endpoint,
                agent_id,
                revision,
                selection,
            },
            reply,
        })
        .await
    }

    pub(crate) async fn task_manager(
        &self,
        command: crate::task_manager::Command,
    ) -> Result<crate::task_manager::Outcome, Error> {
        self.request(|reply| Command::TaskManager { command, reply })
            .await
    }

    pub(crate) async fn list_matcha_sessions(
        &self,
    ) -> Result<crate::matcha_session_catalog::Outcome, Error> {
        self.request(|reply| Command::ListMatchaSessions { reply })
            .await
    }

    pub(crate) async fn list_cron_jobs(&self) -> Result<crate::cron::CronListOutcome, Error> {
        self.request(|reply| Command::CronList { reply }).await
    }

    pub(crate) async fn load_cron_history(
        &self,
        command: crate::cron::CronHistoryCommand,
    ) -> Result<crate::cron::CronHistoryOutcome, Error> {
        self.request(|reply| Command::CronHistory { command, reply })
            .await
    }

    pub(crate) async fn create_cron_job(
        &self,
        command: crate::cron::CronCreateCommand,
    ) -> Result<crate::cron::CronJobMutationOutcome, Error> {
        self.request(|reply| Command::CronCreate { command, reply })
            .await
    }

    pub(crate) async fn update_cron_job(
        &self,
        command: crate::cron::CronUpdateCommand,
    ) -> Result<crate::cron::CronJobMutationOutcome, Error> {
        self.request(|reply| Command::CronUpdate { command, reply })
            .await
    }

    pub(crate) async fn delete_cron_job(
        &self,
        command: crate::cron::CronDeleteCommand,
    ) -> Result<crate::cron::CronDeleteOutcome, Error> {
        self.request(|reply| Command::CronDelete { command, reply })
            .await
    }

    pub(crate) async fn execute_cron_broker(
        &self,
        request: crate::cron::CronBrokerRequest,
    ) -> Result<crate::cron::CronBrokerOutcome, Error> {
        self.request(|reply| Command::CronBroker { request, reply })
            .await
    }

    pub(crate) async fn create_team_run_for_team(
        &self,
        team_id: TeamId,
        run_id: GraphRunId,
        idempotency_key: String,
        workflow_plan: organization::WorkflowPlan,
        source_identity: String,
        template_revision: u64,
        created_at: u64,
    ) -> Result<Result<CreateGraphRunOutcome, StoreFault>, Error> {
        self.request(|reply| {
            Command::team_run(TeamRunCommand::CreateForTeam {
                team_id,
                run_id,
                idempotency_key,
                workflow_plan: Box::new(workflow_plan),
                source_identity,
                template_revision,
                created_at,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn materialize_manual_team_and_create_run(
        &self,
        input: crate::composition::ManualTeamMaterializationInput,
    ) -> Result<ManualTeamCreateOutcome, Error> {
        self.request(|reply| {
            Command::team_run(TeamRunCommand::MaterializeManualAndCreate {
                input: Box::new(input),
                reply,
            })
        })
        .await
    }

    pub(crate) async fn list_team_runs(
        &self,
        team_id: TeamId,
    ) -> Result<Vec<TeamRunQueryOutcome>, Error> {
        self.request(|reply| Command::team_run(TeamRunCommand::List { team_id, reply }))
            .await
    }

    pub(crate) async fn query_team_role_sessions(
        &self,
        team_id: TeamId,
    ) -> Result<organization::TeamRoleSessionQueryOutcome, Error> {
        self.request(|reply| Command::team_run(TeamRunCommand::RoleSessions { team_id, reply }))
            .await
    }

    pub(crate) async fn resume_team_runs(
        &self,
        team_id: TeamId,
    ) -> Result<Vec<ResumeOutcome>, Error> {
        self.request(|reply| Command::team_run(TeamRunCommand::Resume { team_id, reply }))
            .await
    }

    pub(crate) async fn delete_team_and_remove(
        &self,
        team_id: TeamId,
        idempotency_key: String,
        observed_at: u64,
    ) -> Result<Result<crate::composition::TeamDeleteOutcome, StoreFault>, Error> {
        self.request(|reply| {
            Command::team_run(TeamRunCommand::DeleteTeamAndRemove {
                team_id,
                idempotency_key,
                observed_at,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn begin_team_run_cancellation(
        &self,
        run_id: GraphRunId,
        idempotency_key: String,
        requested_at: u64,
    ) -> Result<Result<BeginCancellationOutcome, StoreFault>, Error> {
        self.request(|reply| {
            Command::team_run(TeamRunCommand::BeginCancellation {
                run_id,
                idempotency_key,
                requested_at,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn tombstone_team_run(
        &self,
        run_id: GraphRunId,
        idempotency_key: String,
        tombstoned_at: u64,
    ) -> Result<Result<TombstoneOutcome, StoreFault>, Error> {
        self.request(|reply| {
            Command::team_run(TeamRunCommand::Tombstone {
                run_id,
                idempotency_key,
                tombstoned_at,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn delete_team_run_and_purge(
        &self,
        run_id: GraphRunId,
        idempotency_key: String,
        observed_at: u64,
    ) -> Result<Result<organization::GraphRunPurgeOutcome, StoreFault>, Error> {
        self.request(|reply| {
            Command::team_run(TeamRunCommand::DeleteRunAndPurge {
                run_id,
                idempotency_key,
                observed_at,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn materialize_team_skill_selection(
        &self,
        selection_id: TeamSkillSelectionId,
        team_id: TeamId,
        idempotency_key: IdempotencyKey,
    ) -> Result<TeamMaterializationCommandOutcome, Error> {
        self.request(|reply| {
            Command::TeamSkill(TeamSkillCommand::Materialize {
                selection_id,
                team_id,
                idempotency_key,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn authorize_team_skill_selection(
        &self,
        package_root: std::path::PathBuf,
    ) -> Result<Result<TeamSkillSelectionId, TeamSkillSelectionError>, Error> {
        self.request(|reply| {
            Command::TeamSkill(TeamSkillCommand::Authorize {
                package_root,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn validate_team_skill_selection(
        &self,
        selection_id: TeamSkillSelectionId,
    ) -> Result<TeamSkillPackageValidation, Error> {
        self.request(|reply| {
            Command::TeamSkill(TeamSkillCommand::Validate {
                selection_id,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn plan_team_skill_dependencies(
        &self,
        selection_id: TeamSkillSelectionId,
    ) -> Result<TeamSkillDependencyPlanResult, Error> {
        self.request(|reply| {
            Command::TeamSkill(TeamSkillCommand::DependencyPlan {
                selection_id,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn query_team_public_projection(
        &self,
        team_id: organization::TeamId,
        run_id: GraphRunId,
    ) -> Result<TeamPublicQueryOutcome, Error> {
        self.request(|reply| {
            Command::team_run(TeamRunCommand::PublicProjection {
                team_id,
                run_id,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn task_board_read(
        &self,
        team_id: organization::TeamId,
        run_id: GraphRunId,
    ) -> Result<organization::run::task_board::TaskBoardFacts, Error> {
        self.request(|reply| {
            Command::team_run(TeamRunCommand::TaskBoardRead {
                team_id,
                run_id,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn task_board_mutate(
        &self,
        team_id: organization::TeamId,
        run_id: GraphRunId,
        operation: crate::transport::team_task_board::Operation,
    ) -> Result<Result<crate::transport::team_task_board::MutationResult, StoreFault>, Error> {
        self.request(|reply| {
            Command::team_run(TeamRunCommand::TaskBoardMutate {
                team_id,
                run_id,
                operation,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn query_team_pending_approvals(
        &self,
        team_id: organization::TeamId,
        run_id: GraphRunId,
    ) -> Result<organization::run::TeamPendingApprovalsQueryOutcome, Error> {
        self.request(|reply| {
            Command::team_run(TeamRunCommand::PendingApprovals {
                team_id,
                run_id,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn resolve_team_human_decision(
        &self,
        command: HumanDecisionCommand,
    ) -> Result<Result<HumanDecisionOutcome, StoreFault>, Error> {
        self.request(|reply| {
            Command::team_run(TeamRunCommand::ResolveHumanDecision { command, reply })
        })
        .await
    }

    pub(crate) async fn team_run_graph_definition(
        &self,
        team_id: organization::TeamId,
        run_id: GraphRunId,
    ) -> Result<Option<GraphDefinition>, Error> {
        self.request(|reply| {
            Command::team_run(TeamRunCommand::GraphDefinition {
                team_id,
                run_id,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn armed_team_triggers(
        &self,
        team_id: Option<organization::TeamId>,
    ) -> Result<Vec<crate::composition::ArmedTrigger>, Error> {
        self.request(|reply| Command::team_run(TeamRunCommand::ArmedTriggers { team_id, reply }))
            .await
    }

    pub(crate) async fn replace_team_run_graph(
        &self,
        command: RunCommand,
        definition: GraphDefinition,
    ) -> Result<Result<TeamRunCommandOutcome, StoreFault>, Error> {
        self.request(|reply| {
            Command::team_run(TeamRunCommand::ReplaceGraph {
                command: Box::new(command),
                definition,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn fire_team_run_trigger(
        &self,
        request: TriggerFireRequest,
        fired_at: u64,
    ) -> Result<Result<TeamRunTriggerOutcome, StoreFault>, Error> {
        self.request(|reply| {
            Command::team_run(TeamRunCommand::FireTrigger {
                request,
                fired_at,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn admit_team_run_role_chat(
        &self,
        admission: RoleChatAdmission,
    ) -> Result<Result<RoleChatAdmissionOutcome, StoreFault>, Error> {
        self.request(|reply| Command::team_run(TeamRunCommand::AdmitRoleChat { admission, reply }))
            .await
    }

    pub(crate) async fn list_open_claw_sessions(
        &self,
        params: SessionsListParams,
    ) -> Result<Result<SessionsListResult, RuntimeSessionError<OpenClawSessionError>>, Error> {
        self.request(|reply| Command::Runtime(RuntimeCommand::ListSessions { params, reply }))
            .await
    }

    pub(crate) async fn read_open_claw_workspace_text(
        &self,
        session_key: String,
        relative_path: String,
        limit: usize,
    ) -> Result<Result<openclaw::workspace::WorkspaceTextReceipt, crate::WorkspaceReadError>, Error>
    {
        self.request(|reply| {
            Command::Runtime(RuntimeCommand::ReadWorkspaceText {
                session_key,
                relative_path,
                limit,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn read_open_claw_workspace_binary(
        &self,
        session_key: String,
        relative_path: String,
        limit: usize,
    ) -> Result<
        Result<openclaw::workspace::WorkspaceBinaryReceipt, crate::WorkspaceBinaryError>,
        Error,
    > {
        self.request(|reply| {
            Command::Runtime(RuntimeCommand::ReadWorkspaceBinary {
                session_key,
                relative_path,
                limit,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn prepare_open_claw_workspace_media(
        &self,
        session_key: String,
        relative_path: String,
        mime_type: String,
    ) -> Result<
        Result<openclaw::workspace::media::WorkspaceMediaReceipt, crate::WorkspaceMediaError>,
        Error,
    > {
        self.request(|reply| {
            Command::Runtime(RuntimeCommand::PrepareWorkspaceMedia {
                session_key,
                relative_path,
                mime_type,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn resolve_open_claw_workspace_media(
        &self,
        session_key: String,
        reference: String,
    ) -> Result<
        Result<openclaw::workspace::media::ResolvedWorkspaceMedia, crate::WorkspaceMediaError>,
        Error,
    > {
        self.request(|reply| {
            Command::Runtime(RuntimeCommand::ResolveWorkspaceMedia {
                session_key,
                reference,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn thumbnail_open_claw_workspace_media(
        &self,
        session_key: String,
        relative_path: String,
        mime_type: String,
    ) -> Result<
        Result<openclaw::workspace::media::WorkspaceMediaThumbnail, crate::WorkspaceMediaError>,
        Error,
    > {
        self.request(|reply| {
            Command::Runtime(RuntimeCommand::ThumbnailWorkspaceMedia {
                session_key,
                relative_path,
                mime_type,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn thumbnail_open_claw_workspace_media_gateway(
        &self,
        session_key: String,
        gateway_url: String,
        mime_type: String,
        agent_id: String,
    ) -> Result<
        Result<openclaw::workspace::media::WorkspaceMediaThumbnail, crate::WorkspaceMediaError>,
        Error,
    > {
        self.request(|reply| {
            Command::Runtime(RuntimeCommand::ThumbnailWorkspaceMediaGateway {
                session_key,
                gateway_url,
                mime_type,
                agent_id,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn thumbnails_open_claw_workspace_media(
        &self,
        session_key: String,
        paths: Vec<openclaw::workspace::media::WorkspaceMediaPath>,
    ) -> Result<
        Result<
            Vec<openclaw::workspace::media::WorkspaceMediaThumbnailEntry>,
            crate::WorkspaceMediaError,
        >,
        Error,
    > {
        self.request(|reply| {
            Command::Runtime(RuntimeCommand::ThumbnailsWorkspaceMedia {
                session_key,
                paths,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn stage_paths_open_claw_workspace_media(
        &self,
        session_key: String,
        paths: Vec<openclaw::workspace::media::WorkspaceMediaPath>,
    ) -> Result<
        Result<Vec<openclaw::workspace::media::WorkspaceMediaReceipt>, crate::WorkspaceMediaError>,
        Error,
    > {
        self.request(|reply| {
            Command::Runtime(RuntimeCommand::StagePathsWorkspaceMedia {
                session_key,
                paths,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn stage_buffer_open_claw_workspace_media(
        &self,
        session_key: String,
        base64: String,
        file_name: String,
        mime_type: String,
    ) -> Result<
        Result<openclaw::workspace::media::WorkspaceMediaReceipt, crate::WorkspaceMediaError>,
        Error,
    > {
        self.request(|reply| {
            Command::Runtime(RuntimeCommand::StageBufferWorkspaceMedia {
                session_key,
                base64,
                file_name,
                mime_type,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn stat_open_claw_workspace_file(
        &self,
        session_key: String,
        relative_path: String,
    ) -> Result<Result<openclaw::workspace::WorkspaceStatReceipt, crate::WorkspaceStatError>, Error>
    {
        self.request(|reply| {
            Command::Runtime(RuntimeCommand::StatWorkspaceFile {
                session_key,
                relative_path,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn list_open_claw_workspace_directory(
        &self,
        session_key: String,
        relative_path: String,
        include_hidden: bool,
    ) -> Result<
        Result<openclaw::workspace::WorkspaceDirectoryReceipt, crate::WorkspaceListError>,
        Error,
    > {
        self.request(|reply| {
            Command::Runtime(RuntimeCommand::ListWorkspaceDirectory {
                session_key,
                relative_path,
                include_hidden,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn write_open_claw_workspace_text(
        &self,
        session_key: String,
        relative_path: String,
        content: String,
    ) -> Result<Result<openclaw::workspace::WorkspaceTextReceipt, crate::WorkspaceWriteError>, Error>
    {
        self.request(|reply| {
            Command::Runtime(RuntimeCommand::WriteWorkspaceText {
                session_key,
                relative_path,
                content,
                reply,
            })
        })
        .await
    }

    pub(crate) async fn abort_session(
        &self,
        command: SessionAbortCommand,
    ) -> Result<SessionAbortOutcome, Error> {
        self.request(|reply| Command::SessionAbort { command, reply })
            .await
    }

    pub(crate) async fn register_session_identity(
        &self,
        identity: SessionIdentity,
        route_key: Option<String>,
        run_id: Option<String>,
    ) -> Result<bool, Error> {
        self.request(|reply| Command::HostSessionRegister {
            identity,
            route_key,
            run_id,
            reply,
        })
        .await
    }

    pub(crate) async fn apply_session_change(
        &self,
        session_key: String,
        route_key: Option<String>,
        run_id: Option<String>,
        cursor: u64,
        changes: Vec<SessionChange>,
    ) -> Result<SessionApplyResult, Error> {
        self.request(|reply| Command::HostSessionApply {
            session_key,
            route_key,
            run_id,
            cursor,
            changes,
            reply,
        })
        .await
    }

    pub(crate) async fn session_view(
        &self,
        session_key: String,
    ) -> Result<Option<SessionView>, Error> {
        self.request(|reply| Command::HostSessionView { session_key, reply })
            .await
    }

    pub(crate) async fn session_epoch(&self) -> Result<u64, Error> {
        self.request(|reply| Command::HostSessionEpoch { reply })
            .await
    }

    pub(crate) async fn create_open_claw_session(
        &self,
        command: SessionCreateCommand,
    ) -> Result<SessionCreateOutcome, Error> {
        self.request(|reply| Command::SessionCreate { command, reply })
            .await
    }

    pub(crate) async fn rename_open_claw_session(
        &self,
        command: SessionRenameCommand,
    ) -> Result<SessionRenameOutcome, Error> {
        self.request(|reply| Command::SessionRename { command, reply })
            .await
    }

    pub(crate) async fn delete_open_claw_session(
        &self,
        command: SessionDeleteCommand,
    ) -> Result<SessionDeleteOutcome, Error> {
        self.request(|reply| Command::SessionDelete { command, reply })
            .await
    }

    pub(crate) async fn run_security_emergency(
        &self,
    ) -> Result<crate::security_emergency::SecurityEmergencyOutcome, Error> {
        self.request(|reply| Command::SecurityEmergency { reply })
            .await
    }

    pub(crate) async fn query_security_audit(
        &self,
        query: crate::security_audit::Query,
    ) -> Result<crate::security_audit::Outcome, Error> {
        self.request(|reply| Command::SecurityAudit { query, reply })
            .await
    }

    pub(crate) async fn sync_security_policy(
        &self,
        policy: serde_json::Value,
    ) -> Result<crate::security_delivery::Outcome, Error> {
        self.request(|reply| Command::SyncSecurityPolicy { policy, reply })
            .await
    }

    pub(crate) async fn security_operation(
        &self,
        operation_id: String,
        input: serde_json::Value,
    ) -> Result<openclaw::operations::SecurityActionEffect, Error> {
        self.request(|reply| Command::SecurityOperation {
            operation_id,
            input,
            reply,
        })
        .await
    }

    pub(crate) async fn pending_session_approvals(
        &self,
        command: PendingApprovalsCommand,
    ) -> Result<PendingApprovalsOutcome, Error> {
        self.request(|reply| Command::PendingApprovals { command, reply })
            .await
    }

    pub(crate) async fn respond_to_session_approval(
        &self,
        command: SessionApprovalCommand,
    ) -> Result<SessionApprovalOutcome, Error> {
        self.request(|reply| Command::SessionApproval { command, reply })
            .await
    }

    pub(crate) async fn send_session(
        &self,
        command: SessionSendCommand,
    ) -> Result<SessionSendOutcome, Error> {
        self.request(|reply| Command::SessionSend { command, reply })
            .await
    }

    pub(crate) async fn select_session_model(
        &self,
        command: SessionModelSelectionCommand,
    ) -> Result<SessionModelSelectionOutcome, Error> {
        self.request(|reply| Command::SessionModelSelection { command, reply })
            .await
    }

    pub(crate) async fn load_session_timeline(
        &self,
        command: SessionTimelineCommand,
    ) -> Result<SessionTimelineOutcome, Error> {
        self.request(|reply| Command::SessionTimeline { command, reply })
            .await
    }

    pub(crate) async fn load_matcha_history(
        &self,
        command: crate::matcha_history::Command,
    ) -> Result<crate::matcha_history::Outcome, Error> {
        self.request(|reply| Command::MatchaHistory { command, reply })
            .await
    }

    pub(crate) async fn history_open_claw_chat(
        &self,
        params: ChatHistoryParams,
    ) -> Result<Result<ChatHistoryResult, RuntimeSessionError<OpenClawSessionError>>, Error> {
        self.request(|reply| Command::Runtime(RuntimeCommand::HistoryChat { params, reply }))
            .await
    }

    pub(crate) async fn usage_open_claw_recent(
        &self,
        limit: usize,
    ) -> Result<Result<Vec<openclaw::usage::UsageEntry>, openclaw::usage::UsageHistoryError>, Error>
    {
        self.request(|reply| Command::Runtime(RuntimeCommand::UsageRecent { limit, reply }))
            .await
    }

    pub(crate) async fn send_open_claw_chat(
        &self,
        params: ChatSendParams,
    ) -> Result<
        Result<
            InvocationOutcome<ChatSendResult, OpenClawSessionError>,
            RuntimeSessionError<OpenClawSessionError>,
        >,
        Error,
    > {
        self.request(|reply| Command::Runtime(RuntimeCommand::SendChat { params, reply }))
            .await
    }

    pub(crate) async fn abort_open_claw_chat(
        &self,
        params: ChatAbortParams,
    ) -> Result<
        Result<
            InvocationOutcome<ChatAbortResult, OpenClawSessionError>,
            RuntimeSessionError<OpenClawSessionError>,
        >,
        Error,
    > {
        self.request(|reply| Command::Runtime(RuntimeCommand::AbortChat { params, reply }))
            .await
    }

    async fn request<T>(
        &self,
        command: impl FnOnce(oneshot::Sender<T>) -> Command,
    ) -> Result<T, Error> {
        let (reply, response) = oneshot::channel();
        self.commands
            .send(command(reply))
            .await
            .map_err(|_| Error::CommandChannelClosed)?;
        response.await.map_err(|_| Error::ResponseChannelClosed)
    }
}

pub(crate) enum Error {
    CommandChannelClosed,
    ResponseChannelClosed,
    Join(JoinError),
}

impl fmt::Debug for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, formatter)
    }
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::CommandChannelClosed => {
                formatter.write_str("Host owner is not accepting commands")
            }
            Self::ResponseChannelClosed => {
                formatter.write_str("Host owner stopped before returning a command response")
            }
            Self::Join(error) => write!(formatter, "Host owner task failed: {error}"),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Join(error) => Some(error),
            Self::CommandChannelClosed | Self::ResponseChannelClosed => None,
        }
    }
}
