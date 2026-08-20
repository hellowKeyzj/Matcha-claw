use std::{
    collections::HashSet,
    fmt,
    net::{Ipv4Addr, SocketAddr},
    path::PathBuf,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(unix)]
use foundation::process::InvalidGuardianExecutable;
use foundation::process::{ProcessContainment, supervise};
use openclaw::{
    gateway::{
        auth::GatewaySecret,
        client::{GatewayClientError, GatewayClientMetadata, GatewayEndpoint},
        control_ui::{ControlUiUrlError, PublicControlUiUrl},
    },
    lifecycle::{
        launch::{LaunchError, LaunchFactory, OpenClawLaunchInput},
        logs::{LifecycleDiagnostic, LifecycleLogBuffer, sanitize_log_line},
        recovery::{DoctorRepairError, OpenClawDoctorRepair, OpenClawStartRecovery},
        restart::OpenClawRestartPolicy,
        state_dir::CanonicalStateDir,
        stdio::OpenClawStdioActivation,
    },
    port::{OpenClawControlReadiness, OpenClawGateway},
};
use organization::TeamNativeEffectsPort;
use platform::{exchange::InvocationOutcome, listener_identity::ListenerIdentity};
use serde_json::Value;
use tokio::sync::{Mutex, mpsc, watch};
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

use super::owner::SupervisorOwner;
use crate::{
    runtime_driver::{
        ChannelOps, CronOps, LifecycleOps, OwnedRuntimeFuture, ProviderConfigOps,
        ProviderNativeConfigurationCommand, RuntimeCapabilitySurface, RuntimeDriver,
        RuntimeDriverIdentity, SessionFuture, SessionOps, SkillOps, SubagentOps, TaskOps, TeamOps,
        WorkspaceOps,
    },
    session_abort::{SessionAbortCommand, SessionAbortOutcome},
    session_create::{
        SessionCreateCommand, SessionCreateOutcome,
        project_openclaw_client_error as project_create_client_error, project_openclaw_create,
    },
    session_delete::{
        SessionDeleteCommand, SessionDeleteOutcome,
        project_openclaw_client_error as project_delete_client_error, project_openclaw_delete,
    },
    session_model_selection::{
        OpenClawPatchRejection, ResolvedSessionModelSelection, SessionModelSelectionBinding,
        SessionModelSelectionOutcome, SessionModelSelectionRejection,
    },
    session_rename::{
        SessionRenameCommand, SessionRenameOutcome,
        project_openclaw_client_error as project_rename_client_error, project_openclaw_rename,
    },
    session_send::{Attachment, SessionSendCommand, SessionSendOutcome},
};

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
        .unwrap_or(u64::MAX)
}

pub struct OpenClawInput {
    pub electron_image: PathBuf,
    pub working_directory: PathBuf,
    pub openclaw_dir: PathBuf,
    pub managed_plugin_root: PathBuf,
    pub companion_skill_source_root: PathBuf,
    pub subagent_template_dir: PathBuf,
    pub entry: PathBuf,
    pub state_dir: CanonicalStateDir,
    pub port: u16,
    pub client_metadata: GatewayClientMetadata,
    pub report_diagnostic: Arc<dyn Fn(LifecycleDiagnostic) + Send + Sync>,
    #[cfg(unix)]
    pub guardian_executable: PathBuf,
}

pub(crate) struct OpenClawLogEntry {
    pub(crate) source: &'static str,
    pub(crate) line: String,
}

pub(crate) struct OpenClawLogSnapshot {
    pub(crate) entries: Vec<OpenClawLogEntry>,
    pub(crate) cursor: u64,
    pub(crate) reset: bool,
    pub(crate) truncated: bool,
    pub(crate) lifecycle_tail_evicted: bool,
}

pub(super) struct OpenClawInstance {
    owner: Option<SupervisorOwner>,
    gateway: Arc<Mutex<OpenClawGateway>>,
    control_readiness: watch::Receiver<u64>,
    lifecycle_logs: LifecycleLogBuffer,
    workspace: openclaw::workspace::OpenClawWorkspaceAccess,
    usage: openclaw::usage::UsageHistory,
    toolchain: openclaw::toolchain::OpenClawToolchain,
    state_dir: CanonicalStateDir,
    gateway_port: u16,
    control_ui_url: PublicControlUiUrl,
    openclaw_dir: PathBuf,
    managed_plugin_root: PathBuf,
    companion_skill_source_root: PathBuf,
    subagent_templates: openclaw::projection::subagent_templates::SubagentTemplateDirectory,
}

pub(super) struct PreparedOpenClaw {
    launch: LaunchFactory,
    doctor_repair: OpenClawDoctorRepair,
    working_directory: PathBuf,
    electron_image: PathBuf,
    entry: PathBuf,
    openclaw_dir: PathBuf,
    managed_plugin_root: PathBuf,
    companion_skill_source_root: PathBuf,
    subagent_templates: openclaw::projection::subagent_templates::SubagentTemplateDirectory,
    endpoint: GatewayEndpoint,
    state_dir: CanonicalStateDir,
    secret: Arc<GatewaySecret>,
    listener_identity: Arc<ListenerIdentity>,
    client_metadata: GatewayClientMetadata,
    control_ui_url: PublicControlUiUrl,
    report_diagnostic: Arc<dyn Fn(LifecycleDiagnostic) + Send + Sync>,
    #[cfg(unix)]
    guardian_executable: PathBuf,
}

impl OpenClawInstance {
    pub(super) fn installation_status(&self) -> Option<openclaw::projection::installation::Status> {
        openclaw::projection::installation::Status::inspect(&self.openclaw_dir)
    }

    pub(super) fn runtime_paths(
        &self,
    ) -> Result<
        openclaw::projection::runtime_paths::RuntimePaths,
        openclaw::projection::runtime_paths::RuntimePathsError,
    > {
        openclaw::projection::runtime_paths::RuntimePaths::inspect(
            &self.openclaw_dir,
            &self.state_dir,
            &self.workspace,
        )
    }

    pub(super) fn cli_command(
        &self,
    ) -> Result<
        openclaw::projection::runtime_paths::CliCommand,
        openclaw::projection::runtime_paths::CliCommandError,
    > {
        openclaw::projection::runtime_paths::CliCommand::inspect(&self.openclaw_dir)
    }

    pub(super) fn tool_permission_mode(
        &self,
    ) -> Result<
        openclaw::projection::tool_permission::Mode,
        openclaw::projection::tool_permission::Error,
    > {
        openclaw::projection::tool_permission::Mode::read(self.state_dir.clone())
    }

    pub(super) fn set_tool_permission_mode(
        &self,
        mode: openclaw::projection::tool_permission::Mode,
    ) -> Result<
        openclaw::projection::tool_permission::Effect,
        openclaw::projection::tool_permission::Error,
    > {
        mode.apply(self.state_dir.clone())
    }

    pub(super) async fn toolchain_status(&self) -> openclaw::toolchain::ToolchainStatus {
        self.toolchain.status().await
    }

    pub(super) async fn install_toolchain_uv(&self) -> openclaw::toolchain::UvInstallOutcome {
        self.toolchain.install_uv().await
    }

    pub(super) async fn submit_toolchain_install(
        &self,
    ) -> openclaw::toolchain::ToolchainJobSubmission {
        self.toolchain.submit_install().await
    }

    pub(super) async fn toolchain_event_state(
        &self,
    ) -> Option<openclaw::toolchain::ToolchainOperationEventState> {
        self.toolchain.event_state().await
    }

    pub(super) async fn settle_toolchain_install(
        &self,
        job_id: &str,
    ) -> openclaw::toolchain::ToolchainJobLookup {
        self.toolchain.settle_install(job_id).await
    }

    pub(super) async fn cancel_toolchain_install(&self) -> openclaw::toolchain::ToolchainJobLookup {
        self.toolchain.cancel_install().await
    }

    pub(super) async fn toolchain_job_get(
        &self,
        job_id: &str,
    ) -> openclaw::toolchain::ToolchainJobLookup {
        self.toolchain.job_get(job_id).await
    }

    pub(super) fn plugins(&self) -> openclaw::projection::plugins::PluginProjection {
        openclaw::projection::plugins::PluginProjection::new(
            self.state_dir.clone(),
            self.companion_skill_source_root.clone(),
            self.managed_plugin_root.clone(),
        )
    }

    pub(super) fn state_dir(&self) -> &CanonicalStateDir {
        &self.state_dir
    }

    pub(super) fn gateway_port(&self) -> u16 {
        self.gateway_port
    }

    pub(super) async fn logs(&self, cursor: Option<u64>) -> Result<OpenClawLogSnapshot, ()> {
        let lifecycle = self.lifecycle_logs.snapshot_with_coverage();
        let gateway = self
            .gateway
            .lock()
            .await
            .tail_logs(cursor, 500, 250_000)
            .await
            .map_err(|_| ())?;
        let mut seen = HashSet::with_capacity(lifecycle.entries.len() + gateway.lines.len());
        let mut entries = Vec::with_capacity(lifecycle.entries.len() + gateway.lines.len());
        for entry in lifecycle.entries {
            let source = match entry.stream() {
                openclaw::lifecycle::logs::LogStream::Stdout => "stdout",
                openclaw::lifecycle::logs::LogStream::Stderr => "stderr",
            };
            let line = entry.line().to_owned();
            if seen.insert((source, line.clone())) {
                entries.push(OpenClawLogEntry { source, line });
            }
        }
        for line in gateway.lines {
            let line = sanitize_log_line(line.as_bytes());
            if !line.is_empty() && seen.insert(("gateway", line.clone())) {
                entries.push(OpenClawLogEntry {
                    source: "gateway",
                    line,
                });
            }
        }
        Ok(OpenClawLogSnapshot {
            entries,
            cursor: gateway.cursor,
            reset: gateway.reset,
            truncated: gateway.truncated,
            lifecycle_tail_evicted: lifecycle.tail_evicted,
        })
    }

    pub(super) fn subagent_template_catalog(
        &self,
    ) -> Result<
        openclaw::projection::subagent_templates::Catalog,
        openclaw::projection::subagent_templates::SubagentTemplateError,
    > {
        openclaw::projection::subagent_templates::SubagentTemplateCatalog::list(
            &self.subagent_templates,
        )
    }

    pub(super) fn subagent_template(
        &self,
        id: &str,
    ) -> Result<
        openclaw::projection::subagent_templates::Detail,
        openclaw::projection::subagent_templates::SubagentTemplateError,
    > {
        openclaw::projection::subagent_templates::SubagentTemplateCatalog::detail(
            &self.subagent_templates,
            id,
        )
    }

    pub(super) fn prepare_private_projection(
        &self,
        accounts: &[environment::ProviderAccount],
        models: &environment::ProviderModelCatalog,
        routing: Option<&environment::ProviderRouting>,
    ) -> openclaw::bootstrap::PrivateProjectionEffect {
        openclaw::bootstrap::PrivateProjectionEffect::apply(
            self.state_dir.clone(),
            accounts,
            models,
            routing,
            now_millis(),
        )
    }

    pub(super) fn prepare(
        input: OpenClawInput,
        secret: GatewaySecret,
    ) -> Result<PreparedOpenClaw, ConstructionError> {
        let endpoint =
            GatewayEndpoint::try_new(SocketAddr::from((Ipv4Addr::LOCALHOST, input.port)))
                .map_err(ConstructionError::Endpoint)?;
        let listener_identity = Arc::new(
            ListenerIdentity::generate_loopback()
                .map_err(|_| ConstructionError::ListenerIdentity)?,
        );
        let secret = Arc::new(secret);
        let control_ui_url = PublicControlUiUrl::for_gateway(endpoint.address(), secret.as_ref())
            .map_err(ConstructionError::ControlUiUrl)?;
        let working_directory = input.working_directory.clone();
        let electron_image = input.electron_image.clone();
        let entry = input.entry.clone();
        let openclaw_dir = input.openclaw_dir.clone();
        let managed_plugin_root = input.managed_plugin_root.clone();
        let companion_skill_source_root = input.companion_skill_source_root.clone();
        let state_dir = input.state_dir.clone();
        let subagent_templates =
            openclaw::projection::subagent_templates::SubagentTemplateDirectory::try_new(
                input.subagent_template_dir.clone(),
            )
            .map_err(|_| {
                ConstructionError::WorkspaceProjection(
                    openclaw::projection::workspace::WorkspaceProjectionError::TemplateUnavailable,
                )
            })?;
        let templates = openclaw::projection::workspace::WorkspaceTemplateDirectory::from_openclaw_installation(
            &input.openclaw_dir,
        )
        .map_err(ConstructionError::WorkspaceProjection)?;
        let managed_templates = openclaw::projection::workspace::ManagedWorkspaceTemplateDirectory::from_openclaw_installation(
            &input.openclaw_dir,
        )
        .map_err(ConstructionError::WorkspaceProjection)?;
        let context =
            openclaw::projection::workspace::WorkspaceContextDirectory::from_openclaw_installation(
                &input.openclaw_dir,
            )
            .map_err(ConstructionError::WorkspaceProjection)?;
        let workspace = openclaw::workspace::OpenClawWorkspaceAccess::new(state_dir.clone());
        for workspace in workspace.maintenance_workspace_directories().map_err(|_| {
            ConstructionError::WorkspaceProjection(
                openclaw::projection::workspace::WorkspaceProjectionError::WorkspaceUnavailable,
            )
        })? {
            let workspace = openclaw::projection::workspace::AgentWorkspaceDirectory::try_new(
                PathBuf::from(workspace.as_str()),
            )
            .map_err(ConstructionError::WorkspaceProjection)?;
            let request =
                openclaw::projection::workspace::AgentWorkspaceMaterializationRequest::new(
                    workspace,
                    templates.clone(),
                );
            let request = match &managed_templates {
                Some(templates) => request.with_managed_templates(templates.clone()),
                None => request,
            };
            let request = match &context {
                Some(context) => request.with_context(context.clone()),
                None => request,
            };
            openclaw::projection::workspace::AgentWorkspaceProjection::materialize(request)
                .map_err(ConstructionError::WorkspaceProjection)?;
        }
        openclaw::projection::settings::ensure_default_session_idle(state_dir.clone())
            .map_err(ConstructionError::Projection)?;
        openclaw::projection::control_ui::ensure_matcha_operator_device_auth_policy(
            state_dir.clone(),
        )
        .map_err(ConstructionError::ControlUiPolicy)?;
        let launch_input = OpenClawLaunchInput {
            electron_image: input.electron_image,
            working_directory: working_directory.clone(),
            openclaw_dir: input.openclaw_dir,
            entry: input.entry,
            state_dir: state_dir.clone(),
            port: input.port,
            secret: Arc::clone(&secret),
        };
        let launch = launch_input.clone().try_into_launch_factory()?;
        let doctor_repair = OpenClawDoctorRepair::new(launch_input)?;
        #[cfg(unix)]
        if !input.guardian_executable.is_absolute() {
            return Err(ConstructionError::Guardian(InvalidGuardianExecutable));
        }

        Ok(PreparedOpenClaw {
            launch,
            doctor_repair,
            working_directory,
            electron_image,
            entry,
            openclaw_dir,
            managed_plugin_root,
            companion_skill_source_root,
            subagent_templates,
            endpoint,
            state_dir,
            secret,
            listener_identity,
            client_metadata: input.client_metadata,
            control_ui_url,
            report_diagnostic: input.report_diagnostic,
            #[cfg(unix)]
            guardian_executable: input.guardian_executable,
        })
    }

    pub(super) fn owner(&self) -> &SupervisorOwner {
        self.owner
            .as_ref()
            .expect("OpenClaw supervisor owner must be present")
    }

    pub(super) fn owner_if_present(&self) -> Option<&SupervisorOwner> {
        self.owner.as_ref()
    }

    pub(super) fn take_owner(&mut self) -> SupervisorOwner {
        self.owner
            .take()
            .expect("OpenClaw supervisor owner must be present")
    }

    pub(super) async fn list_sessions(
        &self,
        params: openclaw::session::protocol::SessionsListParams,
    ) -> Result<openclaw::session::protocol::SessionsListResult, openclaw::port::OpenClawSessionError>
    {
        self.gateway.lock().await.list_sessions(params).await
    }

    pub(super) async fn history(
        &self,
        params: openclaw::session::protocol::ChatHistoryParams,
    ) -> Result<openclaw::session::protocol::ChatHistoryResult, openclaw::port::OpenClawSessionError>
    {
        self.gateway.lock().await.history(params).await
    }

    pub(super) async fn history_window(
        &self,
        params: openclaw::session::protocol::ChatHistoryParams,
        request: openclaw::session_window::PageRequest,
    ) -> Result<openclaw::session_window::SessionWindow, openclaw::port::OpenClawSessionError> {
        self.gateway
            .lock()
            .await
            .history_window(params, request)
            .await
    }

    pub(super) async fn send_chat(
        &self,
        params: openclaw::session::protocol::ChatSendParams,
    ) -> Result<
        InvocationOutcome<
            openclaw::session::protocol::ChatSendResult,
            openclaw::port::OpenClawSessionError,
        >,
        openclaw::port::OpenClawSessionError,
    > {
        self.gateway.lock().await.send_chat(params).await
    }

    pub(super) async fn abort_chat(
        &self,
        params: openclaw::session::protocol::ChatAbortParams,
    ) -> Result<
        InvocationOutcome<
            openclaw::session::protocol::ChatAbortResult,
            openclaw::port::OpenClawSessionError,
        >,
        openclaw::port::OpenClawSessionError,
    > {
        self.gateway.lock().await.abort_chat(params).await
    }

    pub(super) async fn patch_session_label(
        &self,
        params: openclaw::session::protocol::SessionLabelPatchParams,
    ) -> Result<
        InvocationOutcome<
            openclaw::session::protocol::SessionLabelPatchResult,
            openclaw::port::OpenClawSessionError,
        >,
        openclaw::port::OpenClawSessionError,
    > {
        self.gateway.lock().await.patch_session_label(params).await
    }

    pub(super) async fn delete_session(
        &self,
        params: openclaw::session::protocol::SessionDeleteParams,
    ) -> Result<
        InvocationOutcome<
            openclaw::session::protocol::SessionDeleteResult,
            openclaw::port::OpenClawSessionError,
        >,
        openclaw::port::OpenClawSessionError,
    > {
        self.gateway.lock().await.delete_session(params).await
    }

    pub(super) async fn reconcile_provider_native_configuration(
        &self,
        accounts: &[environment::ProviderAccount],
        models: &environment::ProviderModelCatalog,
        routing: Option<&environment::ProviderRouting>,
        retired: &[environment::ProviderAccount],
        required_auth_accounts: &std::collections::BTreeSet<environment::ProviderAccountId>,
        now_millis: u64,
    ) -> openclaw::port::ProviderNativeConfigurationEvidence {
        self.gateway
            .lock()
            .await
            .reconcile_provider_native_configuration(
                accounts,
                models,
                routing,
                retired,
                required_auth_accounts,
                now_millis,
            )
            .await
    }

    pub(super) async fn observe_mcp_server_status(
        &self,
        session_key: String,
        endpoint_session_id: Option<String>,
    ) -> Result<
        openclaw::gateway::wire::McpServerStatusList,
        openclaw::gateway::client::GatewayClientError,
    > {
        self.gateway
            .lock()
            .await
            .observe_mcp_server_status(session_key, endpoint_session_id)
            .await
    }

    pub(super) async fn connect_channel_account(
        &self,
        channel: String,
        account: String,
    ) -> openclaw::operations::channel_control::ChannelControlEffect {
        self.gateway
            .lock()
            .await
            .connect_channel_account(channel, account)
            .await
    }

    pub(super) async fn disconnect_channel_account(
        &self,
        channel: String,
        account: String,
    ) -> openclaw::operations::channel_control::ChannelControlEffect {
        self.gateway
            .lock()
            .await
            .disconnect_channel_account(channel, account)
            .await
    }

    pub(super) async fn channel_runtime_stop(
        &self,
        channel: String,
        account: Option<String>,
    ) -> openclaw::port::ChannelRuntimeEffect {
        self.gateway
            .lock()
            .await
            .channel_runtime(openclaw::port::ChannelRuntimeAction::Stop, channel, account)
            .await
    }

    pub(super) async fn web_login_start(
        &self,
        channel: String,
        input: openclaw::port::WebLoginStart,
    ) -> openclaw::port::WebLoginStartEffect {
        self.gateway
            .lock()
            .await
            .web_login_start(channel, input)
            .await
    }

    pub(super) async fn channel_login_wait(
        &self,
        channel: String,
        input: openclaw::port::WebLoginWait,
        cancellation: CancellationToken,
    ) -> openclaw::port::WebLoginWaitEffect {
        self.gateway
            .lock()
            .await
            .web_login_wait_with_cancellation(channel, input, cancellation)
            .await
    }

    pub(super) async fn logout_channel(
        &self,
        channel: String,
        account: Option<String>,
    ) -> openclaw::port::ChannelRuntimeEffect {
        self.gateway
            .lock()
            .await
            .channel_runtime(
                openclaw::port::ChannelRuntimeAction::Logout,
                channel,
                account,
            )
            .await
    }

    pub(super) async fn list_channel_pairing(
        &self,
        channel: String,
        account: Option<String>,
    ) -> openclaw::operations::channel_pairing::ChannelPairingEffect {
        self.gateway
            .lock()
            .await
            .list_channel_pairing(channel, account)
            .await
    }

    pub(super) async fn approve_channel_pairing(
        &self,
        channel: String,
        account: Option<String>,
        code: Zeroizing<Vec<u8>>,
    ) -> openclaw::operations::channel_pairing::ChannelPairingApprovalEffect {
        self.gateway
            .lock()
            .await
            .approve_channel_pairing(channel, account, code)
            .await
    }

    pub(super) async fn observe_channel_accounts(
        &self,
    ) -> openclaw::operations::channel_status::ChannelStatusEffect {
        self.gateway.lock().await.observe_channel_accounts().await
    }

    pub(super) async fn observe_channel_snapshot(
        &self,
    ) -> openclaw::operations::channel_status::ChannelSnapshotEffect {
        self.gateway.lock().await.observe_channel_snapshot().await
    }

    pub(super) async fn channel_catalog(&self) -> openclaw::port::ChannelCatalogEffect {
        self.gateway.lock().await.channel_catalog().await
    }

    pub(super) async fn channel_configure_form(
        &self,
        channel: String,
    ) -> openclaw::port::ChannelConfigSchemaEffect {
        self.gateway
            .lock()
            .await
            .channel_configure_form(channel)
            .await
    }

    pub(super) async fn read_channel_config(
        &self,
        channel: String,
        account_id: Option<String>,
    ) -> openclaw::port::ChannelConfigReadEffect {
        self.gateway
            .lock()
            .await
            .read_channel_config(channel, account_id)
            .await
    }

    pub(super) async fn validate_channel_credentials(
        &self,
        channel: String,
        account: Option<String>,
        config: Zeroizing<Vec<u8>>,
    ) -> openclaw::operations::channel_credentials::ChannelCredentialsEffect {
        self.gateway
            .lock()
            .await
            .validate_channel_credentials(channel, account, config)
            .await
    }

    pub(super) async fn channel_configure(
        &self,
        channel: String,
        account_id: String,
        patch: serde_json::Map<String, serde_json::Value>,
    ) -> openclaw::port::ChannelConfigMutationOutcome {
        self.gateway
            .lock()
            .await
            .configure_channel(channel, account_id, patch)
            .await
    }

    pub(super) async fn delete_channel_config(
        &self,
        channel: String,
        account_id: String,
    ) -> openclaw::port::DeleteConfigOutcome {
        self.gateway
            .lock()
            .await
            .delete_channel_config(channel, account_id)
            .await
    }

    pub(super) async fn install_clawhub_skill(
        &self,
        request: openclaw::skill::ClawHubSkillInstall,
    ) -> openclaw::skill::ClawHubSkillInstallOutcome {
        self.gateway
            .lock()
            .await
            .install_clawhub_skill(request)
            .await
    }

    pub(super) async fn skill_status_catalog(
        &self,
    ) -> Result<openclaw::skill::SkillStatusCatalog, openclaw::skill::SkillStatusCatalogError> {
        self.gateway.lock().await.skill_status_catalog().await
    }

    pub(super) async fn search_skills(
        &self,
        request: openclaw::port::SkillSearchRequest,
    ) -> Result<Vec<openclaw::port::SkillSearchResult>, openclaw::port::SkillReadError> {
        self.gateway.lock().await.search_skills(request).await
    }

    pub(super) async fn detail_skill(
        &self,
        request: openclaw::port::SkillDetailRequest,
    ) -> Result<openclaw::port::SkillDetail, openclaw::port::SkillReadError> {
        self.gateway.lock().await.detail_skill(request).await
    }

    pub(super) async fn update_skill(
        &self,
        request: openclaw::port::SkillUpdateRequest,
    ) -> openclaw::port::SkillMutationOutcome {
        self.gateway.lock().await.update_skill(request).await
    }

    pub(super) async fn install_skill(
        &self,
        request: openclaw::port::SkillInstallRequest,
    ) -> openclaw::port::SkillMutationOutcome {
        self.gateway.lock().await.install_skill(request).await
    }

    pub(super) async fn begin_skill_upload(
        &self,
        request: openclaw::port::SkillUploadBegin,
    ) -> openclaw::port::SkillUploadOutcome {
        self.gateway.lock().await.begin_skill_upload(request).await
    }

    pub(super) async fn chunk_skill_upload(
        &self,
        request: openclaw::port::SkillUploadChunk,
    ) -> openclaw::port::SkillUploadOutcome {
        self.gateway.lock().await.chunk_skill_upload(request).await
    }

    pub(super) async fn commit_skill_upload(
        &self,
        request: openclaw::port::SkillUploadCommit,
    ) -> openclaw::port::SkillUploadOutcome {
        self.gateway.lock().await.commit_skill_upload(request).await
    }

    pub(super) fn workspace(&self) -> &openclaw::workspace::OpenClawWorkspaceAccess {
        &self.workspace
    }

    pub(super) fn skill_bundles(&self) -> openclaw::skill::bundle::SkillBundleStore {
        openclaw::skill::bundle::SkillBundleStore::new(self.state_dir.clone())
    }

    pub(super) fn skill_readme(&self) -> openclaw::skill::readme::SkillReadmeStore {
        openclaw::skill::readme::SkillReadmeStore::new(self.state_dir.clone())
    }

    pub(super) fn usage_recent(
        &self,
        limit: usize,
    ) -> Result<Vec<openclaw::usage::UsageEntry>, openclaw::usage::UsageHistoryError> {
        self.usage.recent(limit)
    }

    pub(super) async fn agents(&self, command: crate::agents::Command) -> crate::agents::Outcome {
        use crate::agents::{Command, NativeEndpoint, Outcome};

        if command.endpoint() == NativeEndpoint::MatchaAgentLocal {
            return Outcome::Unsupported;
        }
        match command {
            Command::List { .. } => {
                crate::agents::read(self.gateway.lock().await.list_agents().await)
            }
            Command::Wait { input, .. } => {
                crate::agents::wait(self.gateway.lock().await.wait_agent(input).await)
            }
            Command::Create { input, .. } => crate::agents::mutation(
                self.gateway.lock().await.create_agent(input).await,
                Outcome::Created,
            ),
            Command::Update { input, .. } => crate::agents::mutation(
                self.gateway.lock().await.update_agent(input).await,
                Outcome::Updated,
            ),
            Command::Delete { input, .. } => crate::agents::mutation(
                self.gateway.lock().await.delete_agent(input).await,
                Outcome::Deleted,
            ),
            Command::ListFiles { agent_id, .. } => {
                crate::agents::files(self.gateway.lock().await.list_agent_files(agent_id).await)
            }
            Command::GetFile { agent_id, name, .. } => crate::agents::file(
                self.gateway
                    .lock()
                    .await
                    .get_agent_file(agent_id, name)
                    .await,
            ),
            Command::SetFile {
                agent_id,
                name,
                content,
                ..
            } => crate::agents::mutation(
                self.gateway
                    .lock()
                    .await
                    .set_agent_file(agent_id, name, content)
                    .await,
                Outcome::File,
            ),
            Command::DisplayConfiguration { .. } => crate::agents::configuration(
                self.gateway
                    .lock()
                    .await
                    .agent_configuration_display()
                    .await,
            ),
            Command::SetDescription {
                agent_id,
                description,
                ..
            } => crate::agents::configuration_mutation(
                self.gateway
                    .lock()
                    .await
                    .set_agent_description(agent_id, description)
                    .await,
            ),
            Command::SetConfigurationModel {
                agent_id, model, ..
            } => crate::agents::configuration_mutation(
                self.gateway
                    .lock()
                    .await
                    .set_agent_configuration_model(agent_id, model)
                    .await,
            ),
            Command::SetSkills {
                agent_id, skills, ..
            } => crate::agents::configuration_mutation(
                self.gateway
                    .lock()
                    .await
                    .set_agent_skills(agent_id, skills)
                    .await,
            ),
            Command::SkillConfiguration { agent_id, .. } => crate::agents::skill_configuration(
                self.gateway
                    .lock()
                    .await
                    .agent_skill_configuration(agent_id)
                    .await,
            ),
            Command::SetSkillConfiguration {
                agent_id,
                revision,
                selection,
                ..
            } => crate::agents::skill_configuration(
                self.gateway
                    .lock()
                    .await
                    .set_agent_skill_configuration(agent_id, revision, selection)
                    .await,
            ),
            Command::ToolConfiguration { agent_id, .. } => crate::agents::tool_configuration(
                self.gateway
                    .lock()
                    .await
                    .agent_tool_configuration(agent_id)
                    .await,
            ),
            Command::SetToolConfiguration {
                agent_id,
                revision,
                selection,
                ..
            } => crate::agents::tool_configuration(
                self.gateway
                    .lock()
                    .await
                    .set_agent_tool_configuration(agent_id, revision, selection)
                    .await,
            ),
        }
    }

    pub(super) async fn platform_tools(&self) -> crate::platform_tools::Outcome {
        crate::platform_tools::catalog(self.gateway.lock().await.platform_tools_catalog().await)
    }

    pub(super) async fn list_cron_jobs(
        &self,
    ) -> Result<openclaw::gateway::wire::CronJobs, openclaw::port::CronReadFailure> {
        self.gateway.lock().await.list_cron_jobs().await
    }

    pub(super) async fn cron_run_history(
        &self,
        job_id: String,
        limit: u64,
    ) -> Result<
        Vec<openclaw::gateway::wire::CronRunHistoryEntry>,
        openclaw::port::CronHistoryReadFailure,
    > {
        self.gateway
            .lock()
            .await
            .cron_run_history(job_id, limit)
            .await
    }

    pub(super) async fn add_cron_job(
        &self,
        job: openclaw::gateway::wire::CronJobCreate,
    ) -> openclaw::port::CronMutationOutcome<openclaw::gateway::wire::CronJob> {
        self.gateway.lock().await.add_cron_job(job).await
    }

    pub(super) async fn update_cron_job(
        &self,
        job_id: String,
        patch: openclaw::gateway::wire::CronJobPatch,
    ) -> openclaw::port::CronMutationOutcome<openclaw::gateway::wire::CronJob> {
        self.gateway
            .lock()
            .await
            .update_cron_job(job_id, patch)
            .await
    }

    pub(super) async fn remove_cron_job(
        &self,
        job_id: String,
    ) -> openclaw::port::CronMutationOutcome<openclaw::gateway::wire::CronRemoved> {
        self.gateway.lock().await.remove_cron_job(job_id).await
    }

    pub(super) async fn admit_cron_execution(
        &self,
        job_id: String,
    ) -> Result<
        Result<openclaw::port::CronExecutionAdmission, openclaw::port::CronTriggerOutcome>,
        openclaw::gateway::client::GatewayClientError,
    > {
        self.gateway.lock().await.admit_cron_execution(job_id).await
    }

    pub(super) fn control_lease(&self) -> ControlLease {
        match self.owner().lease() {
            Some(lease) => ControlLease::probe(Arc::clone(&self.gateway), lease),
            None => ControlLease::unavailable(),
        }
    }

    pub(super) fn gateway_health_observation(
        &self,
        probe: bool,
    ) -> OpenClawGatewayHealthObservation {
        OpenClawGatewayHealthObservation {
            gateway: Arc::clone(&self.gateway),
            probe,
        }
    }

    pub(super) fn gateway_status_observation(
        &self,
        include_channel_summary: bool,
    ) -> OpenClawGatewayStatusObservation {
        OpenClawGatewayStatusObservation {
            gateway: Arc::clone(&self.gateway),
            include_channel_summary,
        }
    }

    pub(super) fn control_readiness(&self) -> watch::Receiver<u64> {
        self.control_readiness.clone()
    }

    pub(super) fn control_ui_url(&self) -> String {
        self.control_ui_url.to_string()
    }

    pub(super) async fn run_security_emergency(
        &self,
    ) -> crate::security_emergency::SecurityEmergencyOutcome {
        match self.gateway.lock().await.run_security_emergency().await {
            openclaw::operations::SecurityEmergencyEffect::Applied(_) => {
                crate::security_emergency::SecurityEmergencyOutcome::Applied
            }
            openclaw::operations::SecurityEmergencyEffect::RuntimeRejected => {
                crate::security_emergency::SecurityEmergencyOutcome::Rejected
            }
            openclaw::operations::SecurityEmergencyEffect::OutcomeUnknown => {
                crate::security_emergency::SecurityEmergencyOutcome::OutcomeUnknown
            }
        }
    }

    pub(super) async fn query_security_audit(
        &self,
        query: crate::security_audit::Query,
    ) -> crate::security_audit::Outcome {
        let query = match openclaw::operations::security_audit::SecurityAuditQuery::new(
            query.page,
            query.page_size,
        ) {
            Some(query) => query,
            None => return crate::security_audit::Outcome::Unknown,
        };
        match self.gateway.lock().await.query_security_audit(query).await {
            openclaw::operations::security_audit::SecurityAuditEffect::Observed(receipt) => {
                crate::security_audit::Outcome::Observed(crate::security_audit::Receipt {
                    page: receipt.page(),
                    page_size: receipt.page_size(),
                    total: receipt.total(),
                    items: receipt
                        .items()
                        .iter()
                        .map(|item| crate::security_audit::Item {
                            ts: item.ts(),
                            tool_name: item.tool_name().to_owned(),
                            risk: item.risk().to_owned(),
                            action: item.action().to_owned(),
                            decision: item.decision().to_owned(),
                            rule_id: item.rule_id().map(str::to_owned),
                        })
                        .collect(),
                })
            }
            openclaw::operations::security_audit::SecurityAuditEffect::RuntimeRejected => {
                crate::security_audit::Outcome::Rejected
            }
            openclaw::operations::security_audit::SecurityAuditEffect::Unavailable => {
                crate::security_audit::Outcome::Unavailable
            }
            openclaw::operations::security_audit::SecurityAuditEffect::OutcomeUnknown => {
                crate::security_audit::Outcome::Unknown
            }
        }
    }

    pub(super) async fn sync_security_policy(
        &self,
        policy: Value,
    ) -> openclaw::operations::SecurityPolicyEffect {
        self.gateway.lock().await.sync_security_policy(policy).await
    }

    pub(super) async fn security_operation(
        &self,
        operation_id: &str,
        input: Value,
    ) -> openclaw::operations::SecurityActionEffect {
        self.gateway
            .lock()
            .await
            .security_operation(operation_id, input)
            .await
    }

    pub(super) async fn abort_session(&self, command: SessionAbortCommand) -> SessionAbortOutcome {
        let session_key =
            match openclaw::session::protocol::SessionKey::try_new(command.session_key) {
                Ok(session_key) => session_key,
                Err(_) => return SessionAbortOutcome::Rejected,
            };
        let params = match command.run_id {
            Some(run_id) => match openclaw::session::protocol::RunId::try_new(run_id) {
                Ok(run_id) => {
                    openclaw::session::protocol::ChatAbortParams::new(session_key).for_run(run_id)
                }
                Err(_) => return SessionAbortOutcome::Rejected,
            },
            None => openclaw::session::protocol::ChatAbortParams::new(session_key),
        };
        match self.gateway.lock().await.abort_chat(params).await {
            Ok(InvocationOutcome::Succeeded(_)) => SessionAbortOutcome::Succeeded,
            Ok(InvocationOutcome::TargetRejected(_)) => SessionAbortOutcome::Rejected,
            Ok(InvocationOutcome::Cancelled | InvocationOutcome::Unknown) | Err(_) => {
                SessionAbortOutcome::Unknown
            }
        }
    }

    pub(super) async fn select_session_model(
        &self,
        command: ResolvedSessionModelSelection,
    ) -> SessionModelSelectionOutcome {
        let session_key =
            match openclaw::session::protocol::SessionKey::try_new(command.session_key) {
                Ok(session_key) => session_key,
                Err(_) => {
                    return SessionModelSelectionOutcome::target_rejected(
                        SessionModelSelectionRejection::InvalidSessionKey,
                    );
                }
            };
        let model = match command.binding {
            SessionModelSelectionBinding::OpenClaw(model) => model,
            SessionModelSelectionBinding::Matcha { .. } => {
                return SessionModelSelectionOutcome::target_rejected(
                    SessionModelSelectionRejection::BindingMismatch,
                );
            }
        };
        let params =
            openclaw::session::protocol::SessionModelPatchParams::new(session_key, Some(model));
        match self
            .gateway
            .lock()
            .await
            .patch_session_model_diagnostic(params)
            .await
        {
            Ok(InvocationOutcome::Succeeded(_)) => SessionModelSelectionOutcome::Succeeded,
            Ok(InvocationOutcome::TargetRejected(
                openclaw::port::SessionModelPatchFailure::TargetRejected(Some(rejection)),
            )) => SessionModelSelectionOutcome::target_rejected(
                SessionModelSelectionRejection::OpenClawRuntimeTargetRejected(
                    OpenClawPatchRejection::new(
                        rejection.code().to_owned(),
                        rejection.message().to_owned(),
                    ),
                ),
            ),
            Ok(InvocationOutcome::TargetRejected(_)) => {
                SessionModelSelectionOutcome::target_rejected(
                    SessionModelSelectionRejection::RuntimeTargetRejected,
                )
            }
            Ok(InvocationOutcome::Cancelled | InvocationOutcome::Unknown) | Err(_) => {
                SessionModelSelectionOutcome::OutcomeUnknown
            }
        }
    }

    pub(super) async fn send_session(&self, command: SessionSendCommand) -> SessionSendOutcome {
        let idempotency_key = match command
            .idempotency_key
            .as_deref()
            .or(command.run_id.as_deref())
            .map(str::to_owned)
        {
            Some(idempotency_key) => idempotency_key,
            None => return SessionSendOutcome::Rejected,
        };
        let session_key =
            match openclaw::session::protocol::SessionKey::try_new(command.session_key) {
                Ok(session_key) => session_key,
                Err(_) => return SessionSendOutcome::Rejected,
            };
        let idempotency_key = match openclaw::session::protocol::RunId::try_new(idempotency_key) {
            Ok(idempotency_key) => idempotency_key,
            Err(_) => return SessionSendOutcome::Rejected,
        };
        let mut params = match openclaw::session::protocol::ChatSendParams::try_new(
            session_key,
            command.message,
            idempotency_key,
        ) {
            Ok(params) => params,
            Err(_) => return SessionSendOutcome::Rejected,
        };
        for attachment in command.attachments {
            let attachment = match map_attachment(attachment) {
                Ok(attachment) => attachment,
                Err(()) => return SessionSendOutcome::Rejected,
            };
            params = match params.try_with_attachment(attachment) {
                Ok(params) => params,
                Err(_) => return SessionSendOutcome::Rejected,
            };
        }
        match self
            .gateway
            .lock()
            .await
            .enqueue_chat(params, command.route_key)
            .await
        {
            Ok(result) => SessionSendOutcome::Queued {
                run_id: result.run_id.as_str().to_owned(),
            },
            Err(_) => SessionSendOutcome::Unavailable,
        }
    }
}

impl RuntimeDriver for OpenClawInstance {
    fn identity(&self) -> RuntimeDriverIdentity {
        RuntimeDriverIdentity::open_claw()
    }

    fn capability_surface(&self) -> RuntimeCapabilitySurface {
        RuntimeCapabilitySurface::open_claw()
    }

    fn session_ops(&self) -> Option<&dyn SessionOps> {
        Some(self)
    }

    fn task_ops(&self) -> Option<&dyn TaskOps> {
        Some(self)
    }

    fn subagent_ops(&self) -> Option<&dyn SubagentOps> {
        Some(self)
    }

    fn team_ops(&self) -> Option<&dyn TeamOps> {
        Some(self)
    }

    fn cron_ops(&self) -> Option<&dyn CronOps> {
        Some(self)
    }

    fn workspace_ops(&self) -> Option<&dyn WorkspaceOps> {
        Some(self)
    }

    fn skill_ops(&self) -> Option<&dyn SkillOps> {
        Some(self)
    }

    fn channel_ops(&self) -> Option<&dyn ChannelOps> {
        Some(self)
    }

    fn lifecycle_ops(&self) -> Option<&dyn LifecycleOps> {
        Some(self)
    }

    fn provider_config_ops(&self) -> Option<&dyn ProviderConfigOps> {
        Some(self)
    }
}

impl SessionOps for OpenClawInstance {
    fn abort_session<'a>(
        &'a self,
        command: SessionAbortCommand,
    ) -> crate::runtime_driver::SessionFuture<'a, SessionAbortOutcome> {
        Box::pin(self.abort_session(command))
    }

    fn create_session<'a>(
        &'a self,
        command: SessionCreateCommand,
        epoch: u64,
    ) -> crate::runtime_driver::SessionFuture<'a, SessionCreateOutcome> {
        Box::pin(async move {
            let params = match command.clone().into_openclaw_params() {
                Ok(params) => params,
                Err(_) => return SessionCreateOutcome::TargetRejected,
            };
            match self.gateway.lock().await.create_session(params).await {
                Ok(outcome) => project_openclaw_create(&command, outcome, epoch),
                Err(error) => project_create_client_error(error),
            }
        })
    }

    fn list_sessions<'a>(
        &'a self,
        params: openclaw::session::protocol::SessionsListParams,
    ) -> crate::runtime_driver::SessionFuture<
        'a,
        Result<
            openclaw::session::protocol::SessionsListResult,
            crate::composition::session::RuntimeSessionError<openclaw::port::OpenClawSessionError>,
        >,
    > {
        Box::pin(async move {
            self.list_sessions(params)
                .await
                .map_err(crate::composition::session::RuntimeSessionError::Client)
        })
    }

    fn history<'a>(
        &'a self,
        params: openclaw::session::protocol::ChatHistoryParams,
    ) -> crate::runtime_driver::SessionFuture<
        'a,
        Result<
            openclaw::session::protocol::ChatHistoryResult,
            crate::composition::session::RuntimeSessionError<openclaw::port::OpenClawSessionError>,
        >,
    > {
        Box::pin(async move {
            self.history(params)
                .await
                .map_err(crate::composition::session::RuntimeSessionError::Client)
        })
    }

    fn history_window<'a>(
        &'a self,
        params: openclaw::session::protocol::ChatHistoryParams,
        request: openclaw::session_window::PageRequest,
    ) -> crate::runtime_driver::SessionFuture<
        'a,
        Result<
            openclaw::session_window::SessionWindow,
            crate::composition::session::RuntimeSessionError<openclaw::port::OpenClawSessionError>,
        >,
    > {
        Box::pin(async move {
            self.history_window(params, request)
                .await
                .map_err(crate::composition::session::RuntimeSessionError::Client)
        })
    }

    fn rename_session<'a>(
        &'a self,
        command: SessionRenameCommand,
    ) -> crate::runtime_driver::SessionFuture<'a, SessionRenameOutcome> {
        Box::pin(async move {
            let params = match command.into_openclaw_params() {
                Ok(params) => params,
                Err(_) => return SessionRenameOutcome::TargetRejected,
            };
            match self.patch_session_label(params).await {
                Ok(outcome) => project_openclaw_rename(outcome),
                Err(error) => project_rename_client_error(error),
            }
        })
    }

    fn delete_session<'a>(
        &'a self,
        command: SessionDeleteCommand,
    ) -> crate::runtime_driver::SessionFuture<'a, SessionDeleteOutcome> {
        Box::pin(async move {
            let params = match command.into_openclaw_params() {
                Ok(params) => params,
                Err(_) => return SessionDeleteOutcome::TargetRejected,
            };
            match self.delete_session(params).await {
                Ok(outcome) => project_openclaw_delete(outcome),
                Err(error) => project_delete_client_error(error),
            }
        })
    }

    fn send_open_claw_chat<'a>(
        &'a self,
        params: openclaw::session::protocol::ChatSendParams,
    ) -> crate::runtime_driver::SessionFuture<
        'a,
        Result<
            InvocationOutcome<
                openclaw::session::protocol::ChatSendResult,
                openclaw::port::OpenClawSessionError,
            >,
            crate::composition::session::RuntimeSessionError<openclaw::port::OpenClawSessionError>,
        >,
    > {
        Box::pin(async move {
            self.send_chat(params)
                .await
                .map_err(crate::composition::session::RuntimeSessionError::Client)
        })
    }

    fn send_session<'a>(
        &'a self,
        command: SessionSendCommand,
    ) -> crate::runtime_driver::SessionFuture<'a, SessionSendOutcome> {
        Box::pin(self.send_session(command))
    }

    fn abort_open_claw_chat<'a>(
        &'a self,
        params: openclaw::session::protocol::ChatAbortParams,
    ) -> crate::runtime_driver::SessionFuture<
        'a,
        Result<
            InvocationOutcome<
                openclaw::session::protocol::ChatAbortResult,
                openclaw::port::OpenClawSessionError,
            >,
            crate::composition::session::RuntimeSessionError<openclaw::port::OpenClawSessionError>,
        >,
    > {
        Box::pin(async move {
            self.abort_chat(params)
                .await
                .map_err(crate::composition::session::RuntimeSessionError::Client)
        })
    }

    fn select_session_model<'a>(
        &'a self,
        command: ResolvedSessionModelSelection,
    ) -> crate::runtime_driver::SessionFuture<'a, SessionModelSelectionOutcome> {
        Box::pin(self.select_session_model(command))
    }
}
impl SubagentOps for OpenClawInstance {
    fn agents<'a>(
        &'a self,
        command: crate::agents::Command,
    ) -> SessionFuture<'a, crate::agents::Outcome> {
        Box::pin(self.agents(command))
    }
}

impl TaskOps for OpenClawInstance {
    fn task_manager<'a>(
        &'a self,
        command: crate::task_manager::Command,
    ) -> crate::runtime_driver::SessionFuture<'a, crate::task_manager::Outcome> {
        Box::pin(async move {
            use crate::task_manager::{Command, MutationOutcome, Outcome, ReadOutcome};

            match command {
                Command::List { target } => {
                    let scope = match task_scope(self, &target) {
                        Ok(scope) => scope,
                        Err(()) => return Outcome::List(ReadOutcome::Unavailable),
                    };
                    Outcome::List(self.gateway.lock().await.list_tasks(scope).await.into())
                }
                Command::Get { target, task_id } => {
                    let scope = match task_scope(self, &target) {
                        Ok(scope) => scope,
                        Err(()) => return Outcome::Get(ReadOutcome::Unavailable),
                    };
                    Outcome::Get(
                        self.gateway
                            .lock()
                            .await
                            .get_task(scope, task_id)
                            .await
                            .into(),
                    )
                }
                Command::Create { target, input } => {
                    let scope = match task_scope(self, &target) {
                        Ok(scope) => scope,
                        Err(()) => return Outcome::Create(MutationOutcome::OutcomeUnknown),
                    };
                    Outcome::Create(
                        self.gateway
                            .lock()
                            .await
                            .create_task(scope, input)
                            .await
                            .into(),
                    )
                }
                Command::Update { target, input } => {
                    let scope = match task_scope(self, &target) {
                        Ok(scope) => scope,
                        Err(()) => return Outcome::Update(MutationOutcome::OutcomeUnknown),
                    };
                    Outcome::Update(
                        self.gateway
                            .lock()
                            .await
                            .update_task(scope, input)
                            .await
                            .into(),
                    )
                }
                Command::TodoWrite {
                    target,
                    old_todos,
                    new_todos,
                } => {
                    let scope = match task_scope(self, &target) {
                        Ok(scope) => scope,
                        Err(()) => return Outcome::TodoWrite(MutationOutcome::OutcomeUnknown),
                    };
                    Outcome::TodoWrite(
                        self.gateway
                            .lock()
                            .await
                            .write_todos(scope, old_todos, new_todos)
                            .await
                            .into(),
                    )
                }
                Command::TodoGet { target } => {
                    let scope = match task_scope(self, &target) {
                        Ok(scope) => scope,
                        Err(()) => return Outcome::TodoGet(ReadOutcome::Unavailable),
                    };
                    Outcome::TodoGet(self.gateway.lock().await.get_todos(scope).await.into())
                }
                Command::Output { target, task_id } => {
                    let scope = match task_scope(self, &target) {
                        Ok(scope) => scope,
                        Err(()) => return Outcome::Output(ReadOutcome::Unavailable),
                    };
                    Outcome::Output(
                        self.gateway
                            .lock()
                            .await
                            .task_output(scope, task_id)
                            .await
                            .into(),
                    )
                }
                Command::Stop { target, task_id } => {
                    let scope = match task_scope(self, &target) {
                        Ok(scope) => scope,
                        Err(()) => return Outcome::Stop(MutationOutcome::OutcomeUnknown),
                    };
                    Outcome::Stop(
                        self.gateway
                            .lock()
                            .await
                            .stop_task(scope, task_id)
                            .await
                            .into(),
                    )
                }
            }
        })
    }
}
impl TeamOps for OpenClawInstance {
    fn materialize_team(
        &self,
        request: organization::TeamMaterializationRequest,
    ) -> OwnedRuntimeFuture<organization::MaterializationOperationOutcome> {
        let gateway = Arc::clone(&self.gateway);
        Box::pin(async move {
            let mut gateway = gateway.lock().await;
            openclaw::team::OpenClawTeamNativeEffects::new(&mut gateway)
                .materialize(request)
                .await
        })
    }

    fn remove_team(
        &self,
        removal: organization::TeamMaterializationRemoval,
    ) -> OwnedRuntimeFuture<organization::MaterializationOperationOutcome> {
        let gateway = Arc::clone(&self.gateway);
        Box::pin(async move {
            let mut gateway = gateway.lock().await;
            openclaw::team::OpenClawTeamNativeEffects::new(&mut gateway)
                .remove(removal)
                .await
        })
    }

    fn recover_team_materialization(
        &self,
        request: organization::TeamMaterializationRequest,
    ) -> OwnedRuntimeFuture<organization::MaterializationOperationOutcome> {
        let gateway = Arc::clone(&self.gateway);
        Box::pin(async move {
            let mut gateway = gateway.lock().await;
            openclaw::team::OpenClawTeamNativeEffects::new(&mut gateway)
                .recover_materialization(request)
                .await
        })
    }

    fn confirm_team_run_receipt(
        &self,
        receipt: organization::RunRuntimeReceipt,
    ) -> OwnedRuntimeFuture<crate::composition::RuntimeReceiptOutcome> {
        let gateway = Arc::clone(&self.gateway);
        Box::pin(async move {
            crate::composition::confirm_runtime_receipt_native(&gateway, receipt).await
        })
    }

    fn deliver_prompt(
        &self,
        request: organization::PromptDeliveryRequest,
    ) -> OwnedRuntimeFuture<organization::PromptDeliveryOutcome> {
        let gateway = Arc::clone(&self.gateway);
        Box::pin(async move {
            let mut gateway = gateway.lock().await;
            openclaw::team::OpenClawTeamNativeEffects::new(&mut gateway)
                .deliver(request)
                .await
        })
    }

    fn abort_role_sessions(
        &self,
        bindings: Vec<organization::RoleSessionReceipt>,
    ) -> OwnedRuntimeFuture<organization::RoleAbortOutcome> {
        let gateway = Arc::clone(&self.gateway);
        Box::pin(async move {
            let mut gateway = gateway.lock().await;
            let mut effects = openclaw::team::OpenClawTeamNativeEffects::new(&mut gateway);
            for binding in &bindings {
                match effects.abort(binding).await {
                    organization::RoleSessionAbortOutcome::Confirmed { .. } => {}
                    organization::RoleSessionAbortOutcome::Failed { .. }
                    | organization::RoleSessionAbortOutcome::OutcomeUnknown => {
                        return organization::RoleAbortOutcome::OutcomeUnknown;
                    }
                }
            }
            organization::RoleAbortOutcome::Confirmed
        })
    }

    fn delete_role_sessions(
        &self,
        run_id: organization::GraphRunId,
        bindings: Vec<organization::RoleSessionReceipt>,
        abort_first: bool,
    ) -> OwnedRuntimeFuture<organization::NativeDeletionEvidence> {
        let gateway = Arc::clone(&self.gateway);
        Box::pin(async move {
            let mut gateway = gateway.lock().await;
            let mut effects = openclaw::team::OpenClawTeamNativeEffects::new(&mut gateway);
            if abort_first {
                for binding in &bindings {
                    match effects.abort(binding).await {
                        organization::RoleSessionAbortOutcome::Confirmed { .. } => {}
                        organization::RoleSessionAbortOutcome::Failed { .. } => {
                            return organization::NativeDeletionEvidence::Rejected;
                        }
                        organization::RoleSessionAbortOutcome::OutcomeUnknown => {
                            return organization::NativeDeletionEvidence::OutcomeUnknown;
                        }
                    }
                }
            }
            let mut confirmations = Vec::with_capacity(bindings.len());
            for binding in &bindings {
                match effects.delete(binding).await {
                    organization::RoleSessionDeleteOutcome::Confirmed { receipt } => {
                        let Ok(confirmation) =
                            organization::RoleSessionDeletionConfirmation::try_new(
                                binding.clone(),
                                receipt,
                            )
                        else {
                            return organization::NativeDeletionEvidence::Rejected;
                        };
                        confirmations.push(confirmation);
                    }
                    organization::RoleSessionDeleteOutcome::Failed { .. } => {
                        return organization::NativeDeletionEvidence::Rejected;
                    }
                    organization::RoleSessionDeleteOutcome::OutcomeUnknown => {
                        return organization::NativeDeletionEvidence::OutcomeUnknown;
                    }
                }
            }
            organization::NativeDeletionProof::try_new(run_id, confirmations).map_or(
                organization::NativeDeletionEvidence::Rejected,
                organization::NativeDeletionEvidence::Confirmed,
            )
        })
    }
}
impl CronOps for OpenClawInstance {
    fn list_cron_jobs<'a>(&'a self) -> SessionFuture<'a, crate::cron::CronListOutcome> {
        Box::pin(async move {
            match self.gateway.lock().await.list_cron_jobs().await {
                Ok(jobs) => crate::cron::CronListOutcome::Listed(jobs),
                Err(failure) => failure.into(),
            }
        })
    }

    fn cron_run_history<'a>(
        &'a self,
        job_id: String,
        limit: u64,
    ) -> SessionFuture<
        'a,
        Result<
            Vec<openclaw::gateway::wire::CronRunHistoryEntry>,
            openclaw::port::CronHistoryReadFailure,
        >,
    > {
        Box::pin(async move {
            self.gateway
                .lock()
                .await
                .cron_run_history(job_id, limit)
                .await
        })
    }

    fn admit_cron_execution<'a>(
        &'a self,
        job_id: String,
    ) -> SessionFuture<
        'a,
        Result<
            Result<openclaw::port::CronExecutionAdmission, openclaw::port::CronTriggerOutcome>,
            openclaw::gateway::client::GatewayClientError,
        >,
    > {
        Box::pin(async move { self.gateway.lock().await.admit_cron_execution(job_id).await })
    }

    fn add_cron_job<'a>(
        &'a self,
        command: crate::cron::CronCreateCommand,
    ) -> SessionFuture<'a, crate::cron::CronJobMutationOutcome> {
        Box::pin(async move {
            let job = match command.into_gateway() {
                Ok(job) => job,
                Err(_) => return crate::cron::CronJobMutationOutcome::Rejected,
            };
            self.gateway.lock().await.add_cron_job(job).await.into()
        })
    }

    fn update_cron_job<'a>(
        &'a self,
        command: crate::cron::CronUpdateCommand,
    ) -> SessionFuture<'a, crate::cron::CronJobMutationOutcome> {
        Box::pin(async move {
            let (job_id, patch) = match command.into_gateway() {
                Ok(parts) => parts,
                Err(_) => return crate::cron::CronJobMutationOutcome::Rejected,
            };
            self.gateway
                .lock()
                .await
                .update_cron_job(job_id, patch)
                .await
                .into()
        })
    }

    fn delete_cron_job<'a>(
        &'a self,
        command: crate::cron::CronDeleteCommand,
    ) -> SessionFuture<'a, crate::cron::CronDeleteOutcome> {
        Box::pin(async move {
            self.gateway
                .lock()
                .await
                .remove_cron_job(command.job_id)
                .await
                .into()
        })
    }
}
impl WorkspaceOps for OpenClawInstance {
    fn trusted_workspace_directory(
        &self,
        session_key: &str,
    ) -> Result<
        openclaw::workspace::TrustedWorkspaceDirectory,
        openclaw::workspace::WorkspaceDirectoryFailure,
    > {
        self.workspace.trusted_workspace_directory(session_key)
    }

    fn read_text(
        &self,
        session_key: &str,
        relative_path: &str,
        limit: usize,
    ) -> Result<openclaw::workspace::WorkspaceTextReceipt, openclaw::workspace::WorkspaceReadFailure>
    {
        self.workspace.read_text(session_key, relative_path, limit)
    }

    fn read_binary(
        &self,
        session_key: &str,
        relative_path: &str,
        limit: usize,
    ) -> Result<
        openclaw::workspace::WorkspaceBinaryReceipt,
        openclaw::workspace::WorkspaceBinaryFailure,
    > {
        self.workspace
            .read_binary(session_key, relative_path, limit)
    }

    fn stat_file(
        &self,
        session_key: &str,
        relative_path: &str,
    ) -> Result<openclaw::workspace::WorkspaceStatReceipt, openclaw::workspace::WorkspaceStatFailure>
    {
        self.workspace.stat(session_key, relative_path)
    }

    fn list_directory(
        &self,
        session_key: &str,
        relative_path: &str,
        include_hidden: bool,
    ) -> Result<
        openclaw::workspace::WorkspaceDirectoryReceipt,
        openclaw::workspace::WorkspaceListFailure,
    > {
        self.workspace
            .list_dir_with_options(session_key, relative_path, include_hidden)
    }

    fn write_text(
        &self,
        session_key: &str,
        relative_path: &str,
        content: &str,
    ) -> Result<openclaw::workspace::WorkspaceTextReceipt, openclaw::workspace::WorkspaceWriteFailure>
    {
        self.workspace
            .write_text(session_key, relative_path, content)
    }

    fn prepare_media(
        &self,
        session_key: &str,
        relative_path: &str,
        mime_type: &str,
    ) -> Result<
        openclaw::workspace::media::WorkspaceMediaReceipt,
        openclaw::workspace::media::WorkspaceMediaFailure,
    > {
        self.workspace
            .prepare_media(session_key, relative_path, mime_type)
    }

    fn resolve_media(
        &self,
        session_key: &str,
        reference: &str,
    ) -> Result<
        openclaw::workspace::media::ResolvedWorkspaceMedia,
        openclaw::workspace::media::WorkspaceMediaFailure,
    > {
        self.workspace.resolve_media(session_key, reference)
    }

    fn thumbnail_media(
        &self,
        session_key: &str,
        relative_path: &str,
        mime_type: &str,
    ) -> Result<
        openclaw::workspace::media::WorkspaceMediaThumbnail,
        openclaw::workspace::media::WorkspaceMediaFailure,
    > {
        self.workspace
            .thumbnail_media(session_key, relative_path, mime_type)
    }

    fn thumbnail_media_gateway(
        &self,
        session_key: &str,
        gateway_url: &str,
        mime_type: &str,
        agent_id: &str,
    ) -> Result<
        openclaw::workspace::media::WorkspaceMediaThumbnail,
        openclaw::workspace::media::WorkspaceMediaFailure,
    > {
        self.workspace
            .thumbnail_media_gateway(session_key, gateway_url, mime_type, agent_id)
    }

    fn thumbnails_media(
        &self,
        session_key: &str,
        paths: &[openclaw::workspace::media::WorkspaceMediaPath],
    ) -> Result<
        Vec<openclaw::workspace::media::WorkspaceMediaThumbnailEntry>,
        openclaw::workspace::media::WorkspaceMediaFailure,
    > {
        self.workspace.thumbnails_media(session_key, paths)
    }

    fn stage_paths_media(
        &self,
        session_key: &str,
        paths: &[openclaw::workspace::media::WorkspaceMediaPath],
    ) -> Result<
        Vec<openclaw::workspace::media::WorkspaceMediaReceipt>,
        openclaw::workspace::media::WorkspaceMediaFailure,
    > {
        self.workspace.stage_paths_media(session_key, paths)
    }

    fn stage_buffer_media(
        &self,
        session_key: &str,
        base64: &str,
        file_name: &str,
        mime_type: &str,
    ) -> Result<
        openclaw::workspace::media::WorkspaceMediaReceipt,
        openclaw::workspace::media::WorkspaceMediaFailure,
    > {
        self.workspace
            .stage_buffer_media(session_key, base64, file_name, mime_type)
    }
}
impl SkillOps for OpenClawInstance {
    fn installed_skill_catalog(
        &self,
    ) -> OwnedRuntimeFuture<Option<openclaw::skill::InstalledSkillCatalog>> {
        let gateway = Arc::clone(&self.gateway);
        Box::pin(async move { gateway.lock().await.installed_skill_catalog().await })
    }

    fn install_clawhub_skill<'a>(
        &'a self,
        command: crate::skill_install::Command,
    ) -> SessionFuture<'a, crate::skill_install::Outcome> {
        Box::pin(async move {
            super::openclaw_skill::OpenClawSkillProvider::openclaw(self)
                .install_clawhub(command)
                .await
        })
    }

    fn skill_status<'a>(&'a self) -> SessionFuture<'a, crate::skill_status::Outcome> {
        Box::pin(async move {
            super::openclaw_skill::OpenClawSkillProvider::openclaw(self)
                .status()
                .await
        })
    }

    fn manage_skills<'a>(
        &'a self,
        command: crate::skill_management::Command,
    ) -> SessionFuture<'a, crate::skill_management::Outcome> {
        Box::pin(async move {
            super::openclaw_skill::OpenClawSkillProvider::openclaw(self)
                .manage(command)
                .await
        })
    }

    fn skill_bundles<'a>(
        &'a self,
        command: crate::skill_bundle::Command,
    ) -> SessionFuture<'a, crate::skill_bundle::Outcome> {
        Box::pin(async move {
            super::openclaw_skill::OpenClawSkillProvider::openclaw(self)
                .bundles(command)
                .await
        })
    }
}
impl ChannelOps for OpenClawInstance {
    fn control_channel_account<'a>(
        &'a self,
        action: crate::channel_control::ChannelControlAction,
        channel: String,
        account: String,
    ) -> SessionFuture<'a, crate::channel_control::ChannelControlOutcome> {
        Box::pin(async move {
            super::openclaw_channel::OpenClawChannelProvider::openclaw(self)
                .control(action, channel, account)
                .await
        })
    }

    fn start_channel_login<'a>(
        &'a self,
        channel: String,
        force: bool,
        timeout_ms: Option<u64>,
        account_id: Option<String>,
    ) -> SessionFuture<'a, crate::channel_login::Outcome> {
        Box::pin(async move {
            super::openclaw_channel::OpenClawChannelProvider::openclaw(self)
                .login_start(channel, force, timeout_ms, account_id)
                .await
        })
    }

    fn wait_channel_login_owned(
        &self,
        channel: String,
        timeout_ms: Option<u64>,
        account_id: Option<String>,
        session_key: Option<String>,
        current_qr_data_url: Option<String>,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> OwnedRuntimeFuture<crate::channel_login::Outcome> {
        let gateway = Arc::clone(&self.gateway);
        Box::pin(async move {
            super::openclaw_channel::OpenClawChannelProvider::login_wait(
                channel,
                timeout_ms,
                account_id,
                session_key,
                current_qr_data_url,
                cancellation,
                gateway,
            )
            .await
        })
    }

    fn stop_channel_login<'a>(
        &'a self,
        channel: String,
        account_id: Option<String>,
    ) -> SessionFuture<'a, crate::channel_login::Outcome> {
        Box::pin(async move {
            super::openclaw_channel::OpenClawChannelProvider::openclaw(self)
                .stop_login(channel, account_id)
                .await
        })
    }

    fn logout_channel<'a>(
        &'a self,
        channel: String,
        account_id: Option<String>,
    ) -> SessionFuture<'a, crate::channel_login::Outcome> {
        Box::pin(async move {
            super::openclaw_channel::OpenClawChannelProvider::openclaw(self)
                .logout(channel, account_id)
                .await
        })
    }

    fn list_channel_pairing<'a>(
        &'a self,
        channel: String,
        account: Option<String>,
    ) -> SessionFuture<'a, crate::channel_status::ChannelPairingOutcome> {
        Box::pin(async move {
            super::openclaw_channel::OpenClawChannelProvider::openclaw(self)
                .pairing_list(channel, account)
                .await
        })
    }

    fn approve_channel_pairing<'a>(
        &'a self,
        channel: String,
        account: Option<String>,
        code: zeroize::Zeroizing<Vec<u8>>,
    ) -> SessionFuture<'a, crate::channel_status::ChannelPairingApprovalOutcome> {
        Box::pin(async move {
            super::openclaw_channel::OpenClawChannelProvider::openclaw(self)
                .pairing_approve(channel, account, code)
                .await
        })
    }

    fn observe_channel_accounts<'a>(
        &'a self,
    ) -> SessionFuture<
        'a,
        Result<
            crate::channel_status::ChannelStatusOutcome,
            crate::channel_status::ChannelStatusFailure,
        >,
    > {
        Box::pin(async move {
            super::openclaw_channel::OpenClawChannelProvider::openclaw(self)
                .status()
                .await
        })
    }

    fn observe_channel_snapshot<'a>(
        &'a self,
    ) -> SessionFuture<
        'a,
        Result<
            crate::channel_status::ChannelSnapshotOutcome,
            crate::channel_status::ChannelStatusFailure,
        >,
    > {
        Box::pin(async move {
            super::openclaw_channel::OpenClawChannelProvider::openclaw(self)
                .snapshot()
                .await
        })
    }

    fn read_channel_config<'a>(
        &'a self,
        channel: String,
        account_id: Option<String>,
    ) -> SessionFuture<'a, crate::channel_config_read::Outcome> {
        Box::pin(async move {
            super::openclaw_channel::OpenClawChannelProvider::openclaw(self)
                .read_channel_config(channel, account_id)
                .await
        })
    }

    fn validate_channel_credentials<'a>(
        &'a self,
        channel: String,
        config: zeroize::Zeroizing<Vec<u8>>,
    ) -> SessionFuture<'a, crate::channel_credentials::Outcome> {
        Box::pin(async move {
            super::openclaw_channel::OpenClawChannelProvider::openclaw(self)
                .validate_channel_credentials(channel, config)
                .await
        })
    }

    fn channel_catalog<'a>(
        &'a self,
    ) -> SessionFuture<'a, crate::channel_catalog::ChannelCatalogOutcome> {
        Box::pin(async move {
            super::openclaw_channel::OpenClawChannelProvider::openclaw(self)
                .catalog()
                .await
        })
    }

    fn channel_configure_form<'a>(
        &'a self,
        channel: String,
    ) -> SessionFuture<'a, crate::channel_catalog::ChannelConfigureFormOutcome> {
        Box::pin(async move {
            super::openclaw_channel::OpenClawChannelProvider::openclaw(self)
                .configure_form(channel)
                .await
        })
    }

    fn channel_configure<'a>(
        &'a self,
        channel: String,
        account_id: String,
        values: zeroize::Zeroizing<Vec<u8>>,
    ) -> SessionFuture<'a, crate::channel_catalog::ChannelConfigureOutcome> {
        Box::pin(async move {
            super::openclaw_channel::OpenClawChannelProvider::openclaw(self)
                .configure(channel, account_id, values)
                .await
        })
    }

    fn channel_delete_config<'a>(
        &'a self,
        channel: String,
        account_id: String,
    ) -> SessionFuture<'a, crate::channel_delete::Outcome> {
        Box::pin(async move {
            super::openclaw_channel::OpenClawChannelProvider::openclaw(self)
                .delete_config(channel, account_id)
                .await
        })
    }
}

impl ProviderConfigOps for OpenClawInstance {
    fn reconcile_provider_native_configuration<'a>(
        &'a self,
        command: ProviderNativeConfigurationCommand<'a>,
    ) -> SessionFuture<'a, openclaw::port::ProviderNativeConfigurationEffect> {
        Box::pin(async move {
            openclaw::port::ProviderNativeConfigurationEffect::Evidence(
                OpenClawInstance::reconcile_provider_native_configuration(
                    self,
                    command.accounts,
                    command.models,
                    command.routing,
                    command.retired,
                    command.required_auth_accounts,
                    command.now_millis,
                )
                .await,
            )
        })
    }
}

impl LifecycleOps for OpenClawInstance {
    fn snapshot(&self) -> foundation::process::supervision::SupervisorSnapshot {
        self.owner().snapshot()
    }
}

fn task_scope<T>(
    open_claw: &OpenClawInstance,
    target: &T,
) -> Result<openclaw::task_manager::TaskScope, ()>
where
    T: TaskScopeTarget,
{
    let workspace = open_claw
        .trusted_workspace_directory(target.session_key())
        .map_err(|_| ())?;
    target.scope(workspace.as_str().to_owned()).map_err(|_| ())
}

trait TaskScopeTarget {
    fn session_key(&self) -> &str;

    fn scope(
        &self,
        workspace_dir: String,
    ) -> Result<openclaw::task_manager::TaskScope, crate::task_manager::InvalidIdentity>;
}

impl TaskScopeTarget for crate::task_manager::TaskTarget {
    fn session_key(&self) -> &str {
        self.session_key()
    }

    fn scope(
        &self,
        workspace_dir: String,
    ) -> Result<openclaw::task_manager::TaskScope, crate::task_manager::InvalidIdentity> {
        self.scope(workspace_dir)
    }
}

impl TaskScopeTarget for crate::task_manager::SessionTarget {
    fn session_key(&self) -> &str {
        self.session_key()
    }

    fn scope(
        &self,
        workspace_dir: String,
    ) -> Result<openclaw::task_manager::TaskScope, crate::task_manager::InvalidIdentity> {
        self.scope(workspace_dir)
    }
}

fn map_attachment(
    attachment: Attachment,
) -> Result<openclaw::session::protocol::ChatAttachment, ()> {
    openclaw::session::protocol::ChatAttachment::try_new(
        attachment.mime_type,
        attachment.file_name,
        attachment.content,
    )
    .map_err(|_| ())
}

pub(crate) struct OpenClawGatewayHealthObservation {
    gateway: Arc<Mutex<OpenClawGateway>>,
    probe: bool,
}

impl OpenClawGatewayHealthObservation {
    pub(crate) async fn observe(
        self,
    ) -> Result<
        openclaw::gateway::wire::GatewayHealthSnapshot,
        openclaw::gateway::client::GatewayClientError,
    > {
        self.gateway.lock().await.observe_health(self.probe).await
    }
}

pub(crate) struct OpenClawGatewayStatusObservation {
    gateway: Arc<Mutex<OpenClawGateway>>,
    include_channel_summary: bool,
}

impl OpenClawGatewayStatusObservation {
    pub(crate) async fn observe(
        self,
    ) -> Result<
        openclaw::gateway::wire::GatewayStatusSnapshot,
        openclaw::gateway::client::GatewayClientError,
    > {
        self.gateway
            .lock()
            .await
            .observe_status(self.include_channel_summary)
            .await
    }
}

pub(crate) struct ControlLease(ControlLeaseInner);

enum ControlLeaseInner {
    Unavailable,
    Probe {
        gateway: Arc<Mutex<OpenClawGateway>>,
        lease: foundation::process::supervision::SupervisorLease,
    },
}

impl ControlLease {
    pub(super) const fn unavailable() -> Self {
        Self(ControlLeaseInner::Unavailable)
    }

    fn probe(
        gateway: Arc<Mutex<OpenClawGateway>>,
        lease: foundation::process::supervision::SupervisorLease,
    ) -> Self {
        Self(ControlLeaseInner::Probe { gateway, lease })
    }

    pub(crate) async fn observe_control(self) -> OpenClawControlReadiness {
        match self.0 {
            ControlLeaseInner::Unavailable => OpenClawControlReadiness::Unavailable,
            ControlLeaseInner::Probe { lease, .. } if lease.is_cancelled() => {
                OpenClawControlReadiness::Unavailable
            }
            ControlLeaseInner::Probe { gateway, lease } => {
                let readiness = gateway.lock().await.control_readiness_snapshot().await;
                if lease.is_cancelled() {
                    gateway.lock().await.invalidate_control().await;
                    OpenClawControlReadiness::Unavailable
                } else {
                    readiness
                }
            }
        }
    }

    pub(crate) async fn snapshot_control(&self) -> OpenClawControlReadiness {
        match &self.0 {
            ControlLeaseInner::Unavailable => OpenClawControlReadiness::Unavailable,
            ControlLeaseInner::Probe { lease, .. } if lease.is_cancelled() => {
                OpenClawControlReadiness::Unavailable
            }
            ControlLeaseInner::Probe { gateway, .. } => {
                gateway.lock().await.control_readiness_snapshot().await
            }
        }
    }
}

impl PreparedOpenClaw {
    pub(super) fn into_instance(
        self,
        events: mpsc::Sender<openclaw::port::SessionEvent>,
        canonical_events: mpsc::Sender<openclaw::port::CanonicalIngressResult>,
    ) -> Result<OpenClawInstance, ConstructionError> {
        let pairing = openclaw::operations::channel_pairing::ChannelPairingOperation::try_new(
            self.electron_image.clone(),
            self.entry.clone(),
            self.openclaw_dir.clone(),
            self.state_dir.as_path().to_owned(),
        )
        .expect("prepared OpenClaw pairing command inputs must be absolute");
        let credentials =
            openclaw::operations::channel_credentials::ChannelCredentialsOperation::try_new(
                self.electron_image.clone(),
                self.entry.clone(),
                self.openclaw_dir.clone(),
                self.state_dir.as_path().to_owned(),
            )
            .expect("prepared OpenClaw credentials command inputs must be absolute");
        let fingerprint = self.listener_identity.fingerprint();
        let gateway = OpenClawGateway::new_with_state_dir(
            self.endpoint,
            fingerprint,
            self.secret,
            self.client_metadata,
            self.state_dir.clone(),
            events,
            canonical_events,
        )
        .with_channel_pairing_operation(pairing)
        .with_channel_credentials_operation(credentials)
        .with_team_state_dir(self.state_dir.clone());
        let control_readiness = gateway.control_readiness();
        let readiness = gateway.readiness_policy();
        let graceful_stop = gateway.graceful_stop_policy();
        let gateway = Arc::new(Mutex::new(gateway));
        let lifecycle_logs = LifecycleLogBuffer::new();
        let diagnostic_state = openclaw::lifecycle::logs::LifecycleDiagnosticState::new();
        let report_diagnostic = self.report_diagnostic;
        let diagnostic_reporter = {
            let diagnostic_state = diagnostic_state.clone();
            Arc::new(move |diagnostic| {
                diagnostic_state.record(diagnostic);
                report_diagnostic(diagnostic);
            })
        };
        let stdio_activation =
            OpenClawStdioActivation::with_log_buffer(diagnostic_reporter, lifecycle_logs.clone());

        #[cfg(windows)]
        let containment = ProcessContainment::job();
        #[cfg(unix)]
        let containment = ProcessContainment::guardian(self.guardian_executable)
            .expect("prepared OpenClaw guardian executable must be absolute");
        let supervisor = supervise(
            containment,
            self.launch,
            stdio_activation,
            readiness,
            graceful_stop,
            OpenClawStartRecovery::with_diagnostics_and_invalid_config_repair(
                diagnostic_state,
                Arc::new(self.doctor_repair),
            ),
            OpenClawRestartPolicy,
        );

        let workspace = openclaw::workspace::OpenClawWorkspaceAccess::new(self.state_dir.clone());
        let usage = openclaw::usage::UsageHistory::new(self.state_dir.as_path());
        #[cfg(windows)]
        let toolchain_commands =
            Arc::new(openclaw::toolchain::FoundationToolchainCommandPort::new(
                self.working_directory.clone(),
            ));
        #[cfg(unix)]
        let toolchain_commands =
            Arc::new(openclaw::toolchain::FoundationToolchainCommandPort::new(
                self.working_directory.clone(),
                self.guardian_executable.clone(),
            ));
        let toolchain_runtime = openclaw::toolchain::NativeToolchainRuntime::new(
            openclaw::toolchain::ToolchainPlatform::current(),
            std::env::consts::ARCH,
            self.working_directory.clone(),
            std::env::var_os("MATCHACLAW_UV_BIN").map(PathBuf::from),
            toolchain_commands,
        );
        let toolchain =
            openclaw::toolchain::OpenClawToolchain::new(self.state_dir.clone(), toolchain_runtime);
        let control_ui_url = self.control_ui_url;
        Ok(OpenClawInstance {
            owner: Some(SupervisorOwner::new(supervisor)),
            gateway,
            control_readiness,
            lifecycle_logs,
            workspace,
            usage,
            toolchain,
            state_dir: self.state_dir,
            gateway_port: self.endpoint.address().port(),
            control_ui_url,
            openclaw_dir: self.openclaw_dir,
            managed_plugin_root: self.managed_plugin_root,
            companion_skill_source_root: self.companion_skill_source_root,
            subagent_templates: self.subagent_templates,
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConstructionError {
    Endpoint(GatewayClientError),
    ListenerIdentity,
    ControlUiUrl(ControlUiUrlError),
    ControlUiPolicy(openclaw::projection::control_ui::Error),
    WorkspaceProjection(openclaw::projection::workspace::WorkspaceProjectionError),
    Projection(openclaw::projection::settings::SettingsProjectionError),
    Launch(LaunchError),
    DoctorRepair(DoctorRepairError),
    #[cfg(unix)]
    Guardian(InvalidGuardianExecutable),
}

impl fmt::Display for ConstructionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Endpoint(error) => error.fmt(formatter),
            Self::ListenerIdentity => formatter.write_str("listener identity generation failed"),
            Self::ControlUiUrl(error) => error.fmt(formatter),
            Self::ControlUiPolicy(error) => error.fmt(formatter),
            Self::WorkspaceProjection(error) => error.fmt(formatter),
            Self::Projection(error) => error.fmt(formatter),
            Self::Launch(error) => error.fmt(formatter),
            Self::DoctorRepair(error) => error.fmt(formatter),
            #[cfg(unix)]
            Self::Guardian(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for ConstructionError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Endpoint(error) => Some(error),
            Self::ListenerIdentity => None,
            Self::ControlUiUrl(error) => Some(error),
            Self::ControlUiPolicy(error) => Some(error),
            Self::WorkspaceProjection(error) => Some(error),
            Self::Projection(error) => Some(error),
            Self::Launch(error) => Some(error),
            Self::DoctorRepair(error) => Some(error),
            #[cfg(unix)]
            Self::Guardian(error) => Some(error),
        }
    }
}

impl From<LaunchError> for ConstructionError {
    fn from(error: LaunchError) -> Self {
        Self::Launch(error)
    }
}

impl From<DoctorRepairError> for ConstructionError {
    fn from(error: DoctorRepairError) -> Self {
        Self::DoctorRepair(error)
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    use foundation::process::supervision::{SupervisorLease, SupervisorPhase};
    use openclaw::projection::workspace::WorkspaceProjectionFixture;
    use tokio_util::sync::CancellationToken;

    use super::*;

    static NEXT_TEST_ID: AtomicU64 = AtomicU64::new(1);

    struct TestStateRoot {
        state_dir: CanonicalStateDir,
        workspace: WorkspaceProjectionFixture,
    }

    impl TestStateRoot {
        fn new() -> Self {
            let sequence = NEXT_TEST_ID.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("test clock must follow the Unix epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "runtime-host-openclaw-state-{}-{nanos}-{sequence}",
                std::process::id()
            ));
            let state_dir = CanonicalStateDir::provision(path).unwrap();
            let workspace = WorkspaceProjectionFixture::install(state_dir.as_path());
            Self {
                state_dir,
                workspace,
            }
        }

        fn path(&self, name: &str) -> PathBuf {
            self.state_dir.as_path().join(name)
        }

        fn state_dir(&self) -> CanonicalStateDir {
            let sequence = NEXT_TEST_ID.fetch_add(1, Ordering::Relaxed);
            CanonicalStateDir::provision(self.path(&format!("openclaw-{sequence}"))).unwrap()
        }
    }

    impl Drop for TestStateRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(self.workspace.root());
        }
    }

    fn input(state_root: &TestStateRoot) -> OpenClawInput {
        OpenClawInput {
            electron_image: state_root.path("MatchaClaw"),
            working_directory: state_root.path("runtime"),
            openclaw_dir: state_root.workspace.openclaw_dir().to_owned(),
            managed_plugin_root: state_root.path("openclaw-plugins"),
            companion_skill_source_root: state_root
                .path("resources/skills/plugin-companion-skills"),
            subagent_template_dir: {
                let path = state_root.path("subagent-templates");
                fs::create_dir_all(&path).unwrap();
                path
            },
            entry: state_root.workspace.openclaw_dir().join("openclaw.mjs"),
            state_dir: state_root.state_dir(),
            port: 18_789,
            client_metadata: GatewayClientMetadata::try_new(
                "1.0.0".into(),
                std::env::consts::OS.into(),
            )
            .unwrap(),
            report_diagnostic: Arc::new(|_| {}),
            #[cfg(unix)]
            guardian_executable: state_root.path("bin/runtime-host-guardian"),
        }
    }

    fn secret() -> GatewaySecret {
        let entropy = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("test clock must follow the Unix epoch")
            .as_nanos()
            ^ u128::from(NEXT_TEST_ID.fetch_add(1, Ordering::Relaxed));
        GatewaySecret::new(entropy.to_string()).unwrap()
    }

    #[test]
    fn prepare_materializes_each_configured_maintenance_workspace_except_teambuddy() {
        let state_root = TestStateRoot::new();
        let input = input(&state_root);
        let state_dir = input.state_dir.clone();
        let reviewer_workspace = state_root.path("reviewer-workspace");
        let team_buddy_workspace = state_dir.as_path().join("teambuddy/team-a");
        fs::write(
            state_dir.as_path().join("openclaw.json"),
            serde_json::to_vec(&serde_json::json!({
                "gateway": { "auth": { "token": "construction-secret-canary" } },
                "models": { "providers": { "openai": { "apiKey": "construction-secret-canary" } } },
                "agents": {
                    "list": [
                        { "id": "reviewer", "workspace": reviewer_workspace },
                        { "id": "team-buddy", "workspace": team_buddy_workspace }
                    ]
                }
            }))
            .unwrap(),
        )
        .unwrap();

        let main_workspace = input.state_dir.as_path().join("workspace");
        OpenClawInstance::prepare(input, secret()).unwrap();

        assert!(reviewer_workspace.join("IDENTITY.md").is_file());
        assert!(main_workspace.join("IDENTITY.md").is_file());
        assert!(!team_buddy_workspace.exists());
        let config: Value =
            serde_json::from_slice(&fs::read(state_dir.as_path().join("openclaw.json")).unwrap())
                .unwrap();
        assert_eq!(
            config["gateway"]["controlUi"]["dangerouslyDisableDeviceAuth"],
            true,
        );
    }

    #[test]
    fn prepare_generates_fresh_identity_and_retains_shared_launch_resources() {
        let state_root = TestStateRoot::new();
        let first = OpenClawInstance::prepare(input(&state_root), secret()).unwrap();
        let second = OpenClawInstance::prepare(input(&state_root), secret()).unwrap();

        assert_ne!(
            first.listener_identity.fingerprint(),
            second.listener_identity.fingerprint()
        );
        assert_eq!(Arc::strong_count(&first.listener_identity), 1);
        assert_eq!(Arc::strong_count(&first.secret), 2);
    }

    #[tokio::test]
    async fn preparation_then_construction_is_idle_and_retains_shared_gateway_handles() {
        let state_root = TestStateRoot::new();
        let (events, _received) = mpsc::channel(1);
        let (canonical_events, _received_canonical) = mpsc::channel(1);
        let instance = OpenClawInstance::prepare(input(&state_root), secret())
            .unwrap()
            .into_instance(events, canonical_events)
            .unwrap();

        assert_eq!(instance.owner().snapshot().phase(), SupervisorPhase::Idle);
        assert!(
            instance
                .control_ui_url()
                .starts_with("http://127.0.0.1:18789/#token=")
        );
        assert!(!instance.control_ui_url().contains(['?', '@']));
    }

    #[tokio::test]
    async fn cancelled_control_lease_is_unavailable_without_a_gateway_probe() {
        let cancellation = CancellationToken::new();
        let lease = SupervisorLease::test_lease(cancellation.clone());
        let identity = platform::listener_identity::ListenerIdentity::generate_loopback().unwrap();
        let (events, _) = mpsc::channel(1);
        let (canonical_events, _) = mpsc::channel(1);
        let gateway = Arc::new(Mutex::new(OpenClawGateway::new(
            GatewayEndpoint::try_new("127.0.0.1:18789".parse().unwrap()).unwrap(),
            identity.fingerprint(),
            Arc::new(GatewaySecret::new("control-lease-secret".into()).unwrap()),
            GatewayClientMetadata::try_new("1.0.0".into(), "windows".into()).unwrap(),
            events,
            canonical_events,
        )));
        cancellation.cancel();

        assert_eq!(
            ControlLease::probe(gateway, lease).observe_control().await,
            OpenClawControlReadiness::Unavailable
        );
    }

    #[test]
    fn listener_identity_failure_is_fixed_and_redacted() {
        let error = ConstructionError::ListenerIdentity;

        assert_eq!(error.to_string(), "listener identity generation failed");
        assert_eq!(format!("{error:?}"), "ListenerIdentity");
        assert!(std::error::Error::source(&error).is_none());
    }

    #[tokio::test]
    async fn invalid_endpoint_failure_is_typed_and_fixed() {
        let state_root = TestStateRoot::new();
        let mut input = input(&state_root);
        input.port = 0;

        let error = match OpenClawInstance::prepare(input, secret()) {
            Ok(_) => panic!("invalid gateway endpoint was accepted"),
            Err(error) => error,
        };

        assert_eq!(
            error,
            ConstructionError::Endpoint(GatewayClientError::InvalidEndpoint)
        );
        assert_eq!(error.to_string(), "gateway endpoint is invalid");
    }

    #[tokio::test]
    async fn invalid_launch_failure_is_typed_and_redacted() {
        let state_root = TestStateRoot::new();
        let mut input = input(&state_root);
        input.electron_image = PathBuf::from("relative-sensitive-artifact");

        let error = match OpenClawInstance::prepare(input, secret()) {
            Ok(_) => panic!("invalid OpenClaw launch input was accepted"),
            Err(error) => error,
        };

        assert_eq!(error, ConstructionError::Launch(LaunchError::InvalidInput));
        assert_eq!(error.to_string(), "OpenClaw launch input is invalid");
        assert!(!format!("{error:?} {error}").contains("sensitive"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn relative_guardian_failure_stays_typed() {
        let state_root = TestStateRoot::new();
        let mut input = input(&state_root);
        input.guardian_executable = PathBuf::from("relative-guardian");

        let error = match OpenClawInstance::prepare(input, secret()) {
            Ok(_) => panic!("relative guardian executable was accepted"),
            Err(error) => error,
        };

        assert_eq!(
            error,
            ConstructionError::Guardian(InvalidGuardianExecutable)
        );
        assert_eq!(error.to_string(), "guardian executable is not absolute");
    }
}
