use std::{fmt, sync::Arc};

use serde_json::Value;
use zeroize::Zeroizing;

use platform::{exchange::InvocationOutcome, listener_identity::CertificateFingerprint};
use tokio::sync::{mpsc, watch};

pub use crate::session::{
    CanonicalIngressResult,
    events::{
        LifecycleEvent, SessionEvent, SessionEventProvenance, SessionUpdate, SessionUpdateKind,
        TerminalOutcome,
    },
};
pub use crate::skill::{
    SkillDetail, SkillDetailRequest, SkillInstallRequest, SkillMutationOutcome, SkillReadError,
    SkillSearchRequest, SkillSearchResult, SkillUpdateRequest, SkillUploadBegin, SkillUploadChunk,
    SkillUploadCommit,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SkillUploadOutcome {
    Progress {
        upload_id: String,
        received_bytes: u64,
        expires_at: u64,
    },
    Commit {
        upload_id: String,
        received_bytes: u64,
        sha256: String,
        expires_at: u64,
    },
    Rejected,
    Unknown,
}

pub(crate) use crate::cron::CronProvider;
pub use crate::cron::{
    CronExecutionAdmission, CronExecutionStatus, CronRunDisposition, CronTriggerOutcome,
};
pub use crate::cron::{CronHistoryReadFailure, CronMutationOutcome, CronReadFailure};
pub use crate::operations::channel_config::{
    ChannelCatalogEffect, ChannelConfigMutationOutcome, ChannelConfigReadEffect,
    ChannelConfigReadProjection, ChannelConfigSchemaEffect, ChannelConfigureField,
    ChannelConfigureFieldKind, ChannelConfigureForm, DeleteConfigOutcome,
};
pub use crate::operations::channel_login::{
    ChannelRuntimeAction, ChannelRuntimeEffect, LoginProgress, LoginProgressStatus, WebLoginStart,
    WebLoginStartEffect, WebLoginWait, WebLoginWaitEffect,
};
pub use crate::operations::provider_native_config::{
    AppliedStatus, ObservedStatus, ProviderNativeConfigurationDiagnostic,
    ProviderNativeConfigurationEvidence, ProviderNativeConfigurationOperation,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderNativeConfigurationEffect {
    Evidence(ProviderNativeConfigurationEvidence),
    Unavailable,
}

impl ProviderNativeConfigurationEffect {
    pub fn evidence(self) -> Option<ProviderNativeConfigurationEvidence> {
        match self {
            Self::Evidence(evidence) => Some(evidence),
            Self::Unavailable => None,
        }
    }
}

pub async fn await_cron_execution(
    admission: CronExecutionAdmission,
    cancellation: tokio_util::sync::CancellationToken,
) -> CronExecutionStatus {
    crate::cron::await_terminal(admission, cancellation).await
}

fn project_control_readiness(readiness: GatewayControlReadiness) -> OpenClawControlReadiness {
    match readiness {
        GatewayControlReadiness::Ready => OpenClawControlReadiness::Ready,
        GatewayControlReadiness::Starting => OpenClawControlReadiness::Starting,
        GatewayControlReadiness::Unavailable => OpenClawControlReadiness::Unavailable,
    }
}

use crate::{
    agents::{
        AgentCreate, AgentCreated, AgentDelete, AgentDeleted, AgentFile, AgentFileName, AgentFiles,
        AgentUpdate, AgentUpdated, AgentWait, AgentsList, AgentsMutationOutcome, AgentsReadFailure,
        AgentsWaitOutcome, OpenClawAgents,
    },
    gateway::{
        auth::GatewaySecret,
        client::{GatewayClient, GatewayClientMetadata, GatewayControlReadiness, GatewayEndpoint},
    },
    lifecycle::state_dir::CanonicalStateDir,
    lifecycle::{readiness::OpenClawReadiness, stop::OpenClawGracefulStop},
    operations::{
        SecurityActionEffect, SecurityActionsOperation, SecurityEmergencyEffect,
        SecurityEmergencyOperation, SecurityMonitorEffect, SecurityMonitorOperation,
        SecurityPolicyEffect, SecurityPolicyOperation,
        channel_config::ChannelConfigOperation,
        channel_control::{ChannelControlEffect, ChannelControlOperation},
        channel_credentials::{ChannelCredentialsEffect, ChannelCredentialsOperation},
        channel_pairing::{
            ChannelPairingApprovalEffect, ChannelPairingEffect, ChannelPairingOperation,
        },
        channel_status::{ChannelSnapshotEffect, ChannelStatusEffect, ChannelStatusOperation},
        security_audit::{SecurityAuditEffect, SecurityAuditOperation, SecurityAuditQuery},
    },
    projection::agent_configuration::{
        AgentConfiguration, Display as AgentConfigurationDisplay, Model as AgentConfigurationModel,
        MutationOutcome as AgentConfigurationMutationOutcome,
        ReadFailure as AgentConfigurationReadFailure, SkillConfigurationOutcome, SkillSelection,
        ToolCatalog, ToolConfigurationOutcome, ToolSelection,
    },
    session::{
        ingest::SessionEventIngest,
        operation::{OperationError, SessionOperation},
        protocol::{
            ChatAbortParams, ChatAbortResult, ChatHistoryParams, ChatHistoryResult, ChatSendParams,
            ChatSendResult, SessionCreateParams, SessionCreateResult, SessionDeleteParams,
            SessionDeleteResult, SessionLabelPatchParams, SessionLabelPatchResult,
            SessionModelPatchParams, SessionModelPatchResult, SessionsListParams,
            SessionsListResult,
        },
    },
    session_window::{self, PageRequest, SessionWindow},
    skill::{
        ClawHubSkillInstall, ClawHubSkillInstallOutcome, ClawHubSkillInstaller,
        InstalledSkillCatalog, OpenClawSkillOperations, OpenClawSkillStatusCatalog,
        SkillStatusCatalog, SkillStatusCatalogError,
    },
    task_manager::{
        Task, TaskCreate, TaskCreateReceipt, TaskManagerOperation, TaskMutationOutcome, TaskOutput,
        TaskReadFailure, TaskScope, TaskSnapshot, TaskStopResult, TaskUpdate, Todo, TodoSnapshot,
    },
    team::{PromptDelivery, PromptDeliveryOutcome, TeamProvider},
};
use organization::{
    MaterializationOperationOutcome, TeamMaterializationRemoval, TeamMaterializationRequest,
};

pub struct OpenClawGateway {
    client: Arc<GatewayClient>,
    team_state_dir: Option<CanonicalStateDir>,
    pairing: Option<ChannelPairingOperation>,
    credentials: Option<ChannelCredentialsOperation>,
}

impl OpenClawGateway {
    pub fn new(
        endpoint: GatewayEndpoint,
        certificate_fingerprint: CertificateFingerprint,
        secret: Arc<GatewaySecret>,
        metadata: GatewayClientMetadata,
        events: mpsc::Sender<SessionEvent>,
        canonical_events: mpsc::Sender<CanonicalIngressResult>,
    ) -> Self {
        let ingest = Arc::new(SessionEventIngest::new(events, canonical_events));
        let client = GatewayClient::new(endpoint, certificate_fingerprint, secret, metadata)
            .with_event_ingest(ingest);
        Self::with_client(Arc::new(client))
    }

    pub fn new_with_state_dir(
        endpoint: GatewayEndpoint,
        certificate_fingerprint: CertificateFingerprint,
        secret: Arc<GatewaySecret>,
        metadata: GatewayClientMetadata,
        state_dir: CanonicalStateDir,
        events: mpsc::Sender<SessionEvent>,
        canonical_events: mpsc::Sender<CanonicalIngressResult>,
    ) -> Self {
        let ingest = Arc::new(SessionEventIngest::new(events, canonical_events));
        let client = GatewayClient::new_with_state_dir(
            endpoint,
            certificate_fingerprint,
            secret,
            metadata,
            state_dir,
        )
        .with_event_ingest(ingest);
        Self::with_client(Arc::new(client))
    }

    fn with_client(client: Arc<GatewayClient>) -> Self {
        Self {
            client,
            team_state_dir: None,
            pairing: None,
            credentials: None,
        }
    }

    pub fn with_team_state_dir(mut self, state_dir: CanonicalStateDir) -> Self {
        self.team_state_dir = Some(state_dir);
        self
    }

    pub fn with_channel_pairing_operation(mut self, operation: ChannelPairingOperation) -> Self {
        self.pairing = Some(operation);
        self
    }

    pub fn with_channel_credentials_operation(
        mut self,
        operation: ChannelCredentialsOperation,
    ) -> Self {
        self.credentials = Some(operation);
        self
    }

    pub async fn validate_channel_credentials(
        &self,
        channel: String,
        account: Option<String>,
        config: Zeroizing<Vec<u8>>,
    ) -> ChannelCredentialsEffect {
        match &self.credentials {
            Some(credentials) => credentials.validate(channel, account, config).await,
            None => ChannelCredentialsEffect::OutcomeUnknown,
        }
    }

    pub async fn list_channel_pairing(
        &self,
        channel: String,
        account: Option<String>,
    ) -> ChannelPairingEffect {
        match &self.pairing {
            Some(pairing) => pairing.list(channel, account).await,
            None => ChannelPairingEffect::OutcomeUnknown,
        }
    }

    pub async fn approve_channel_pairing(
        &self,
        channel: String,
        account: Option<String>,
        code: Zeroizing<Vec<u8>>,
    ) -> ChannelPairingApprovalEffect {
        match &self.pairing {
            Some(pairing) => pairing.approve(channel, account, code).await,
            None => ChannelPairingApprovalEffect::OutcomeUnknown,
        }
    }

    pub fn readiness_policy(&self) -> OpenClawReadiness {
        OpenClawReadiness::new(Arc::clone(&self.client))
    }

    pub fn graceful_stop_policy(&self) -> OpenClawGracefulStop {
        OpenClawGracefulStop::new(Arc::clone(&self.client))
    }

    pub async fn observe_control(&self) -> OpenClawControlReadiness {
        project_control_readiness(self.client.observe_control().await)
    }

    pub async fn control_readiness_snapshot(&self) -> OpenClawControlReadiness {
        project_control_readiness(self.client.control_readiness_snapshot().await)
    }

    pub async fn observe_health(
        &self,
        probe: bool,
    ) -> Result<
        crate::gateway::wire::GatewayHealthSnapshot,
        crate::gateway::client::GatewayClientError,
    > {
        self.client.observe_health(probe).await
    }

    pub async fn observe_status(
        &self,
        include_channel_summary: bool,
    ) -> Result<
        crate::gateway::wire::GatewayStatusSnapshot,
        crate::gateway::client::GatewayClientError,
    > {
        self.client.observe_status(include_channel_summary).await
    }

    pub async fn observe_mcp_server_status(
        &self,
        session_key: String,
        endpoint_session_id: Option<String>,
    ) -> Result<crate::gateway::wire::McpServerStatusList, crate::gateway::client::GatewayClientError>
    {
        self.client
            .observe_mcp_server_status(session_key, endpoint_session_id)
            .await
    }

    pub async fn tail_logs(
        &self,
        cursor: Option<u64>,
        limit: usize,
        max_bytes: usize,
    ) -> Result<crate::gateway::wire::GatewayLogsTail, crate::gateway::client::GatewayClientError>
    {
        self.client.tail_logs(cursor, limit, max_bytes).await
    }

    pub fn control_ui_url(&self) -> String {
        self.client.control_ui_url()
    }

    pub fn control_readiness(&self) -> watch::Receiver<u64> {
        self.client.control_readiness()
    }

    pub async fn admit_cron_execution(
        &self,
        job_id: String,
    ) -> Result<
        Result<CronExecutionAdmission, CronTriggerOutcome>,
        crate::gateway::client::GatewayClientError,
    > {
        crate::cron::admit(Arc::clone(&self.client), job_id).await
    }

    pub async fn await_cron_execution(
        admission: CronExecutionAdmission,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> CronExecutionStatus {
        crate::cron::await_terminal(admission, cancellation).await
    }

    pub async fn list_cron_jobs(&self) -> Result<crate::gateway::wire::CronJobs, CronReadFailure> {
        CronProvider::new(Arc::clone(&self.client)).list().await
    }

    pub async fn cron_run_history(
        &self,
        job_id: String,
        limit: u64,
    ) -> Result<Vec<crate::gateway::wire::CronRunHistoryEntry>, CronHistoryReadFailure> {
        CronProvider::new(Arc::clone(&self.client))
            .run_history(job_id, limit)
            .await
    }

    pub async fn add_cron_job(
        &self,
        job: crate::gateway::wire::CronJobCreate,
    ) -> CronMutationOutcome<crate::gateway::wire::CronJob> {
        CronProvider::new(Arc::clone(&self.client)).add(job).await
    }

    pub async fn update_cron_job(
        &self,
        job_id: String,
        patch: crate::gateway::wire::CronJobPatch,
    ) -> CronMutationOutcome<crate::gateway::wire::CronJob> {
        CronProvider::new(Arc::clone(&self.client))
            .update(job_id, patch)
            .await
    }

    pub async fn remove_cron_job(
        &self,
        job_id: String,
    ) -> CronMutationOutcome<crate::gateway::wire::CronRemoved> {
        CronProvider::new(Arc::clone(&self.client))
            .remove(job_id)
            .await
    }

    pub async fn run_security_emergency(&self) -> SecurityEmergencyEffect {
        SecurityEmergencyOperation::new(Arc::clone(&self.client))
            .run()
            .await
    }

    pub async fn query_security_audit(&self, query: SecurityAuditQuery) -> SecurityAuditEffect {
        SecurityAuditOperation::new(Arc::clone(&self.client))
            .query(query)
            .await
    }

    pub async fn sync_security_policy(&self, policy: Value) -> SecurityPolicyEffect {
        SecurityPolicyOperation::new(Arc::clone(&self.client))
            .sync(policy)
            .await
    }

    pub async fn security_operation(
        &self,
        operation_id: &str,
        input: Value,
    ) -> SecurityActionEffect {
        SecurityActionsOperation::new(Arc::clone(&self.client))
            .run(operation_id, input)
            .await
    }

    pub async fn observe_security_monitor_status(&self) -> SecurityMonitorEffect {
        SecurityMonitorOperation::new(Arc::clone(&self.client))
            .observe()
            .await
    }

    pub async fn channel_catalog(&self) -> ChannelCatalogEffect {
        ChannelConfigOperation::new(Arc::clone(&self.client))
            .catalog()
            .await
    }

    pub async fn channel_configure_form(&self, channel: String) -> ChannelConfigSchemaEffect {
        ChannelConfigOperation::new(Arc::clone(&self.client))
            .form(channel)
            .await
    }

    pub async fn read_channel_config(
        &self,
        channel: String,
        account_id: Option<String>,
    ) -> ChannelConfigReadEffect {
        ChannelConfigOperation::new(Arc::clone(&self.client))
            .read(channel, account_id)
            .await
    }

    pub async fn configure_channel(
        &self,
        channel: String,
        account_id: String,
        patch: serde_json::Map<String, serde_json::Value>,
    ) -> ChannelConfigMutationOutcome {
        ChannelConfigOperation::new(Arc::clone(&self.client))
            .configure(channel, account_id, patch)
            .await
    }

    pub async fn reconcile_provider_native_configuration(
        &self,
        accounts: &[environment::ProviderAccount],
        models: &environment::ProviderModelCatalog,
        routing: Option<&environment::ProviderRouting>,
        retired: &[environment::ProviderAccount],
        required_auth_accounts: &std::collections::BTreeSet<environment::ProviderAccountId>,
        now_millis: u64,
    ) -> ProviderNativeConfigurationEvidence {
        ProviderNativeConfigurationOperation::new(
            Arc::clone(&self.client),
            self.team_state_dir
                .clone()
                .expect("OpenClaw provider native config requires a state directory"),
        )
        .reconcile(
            accounts,
            models,
            routing,
            retired,
            required_auth_accounts,
            now_millis,
        )
        .await
    }

    pub async fn delete_channel_config(
        &self,
        channel: String,
        account_id: String,
    ) -> DeleteConfigOutcome {
        ChannelConfigOperation::new(Arc::clone(&self.client))
            .delete_config(channel, account_id)
            .await
    }

    pub fn channel_login_operation(
        &self,
    ) -> crate::operations::channel_login::ChannelLoginOperation {
        crate::operations::channel_login::ChannelLoginOperation::new(Arc::clone(&self.client))
    }

    pub async fn channel_runtime(
        &self,
        action: ChannelRuntimeAction,
        channel: String,
        account: Option<String>,
    ) -> ChannelRuntimeEffect {
        self.channel_login_operation()
            .runtime(action, channel, account)
            .await
    }

    pub async fn web_login_start(
        &self,
        channel: String,
        input: WebLoginStart,
    ) -> WebLoginStartEffect {
        self.channel_login_operation()
            .login_start(channel, input)
            .await
    }

    pub async fn web_login_wait_with_cancellation(
        &self,
        channel: String,
        input: WebLoginWait,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> WebLoginWaitEffect {
        self.channel_login_operation()
            .login_wait_with_cancellation(channel, input, cancellation)
            .await
    }

    pub async fn connect_channel_account(
        &self,
        channel: String,
        account: String,
    ) -> ChannelControlEffect {
        ChannelControlOperation::new(Arc::clone(&self.client))
            .connect(channel, account)
            .await
    }

    pub async fn disconnect_channel_account(
        &self,
        channel: String,
        account: String,
    ) -> ChannelControlEffect {
        ChannelControlOperation::new(Arc::clone(&self.client))
            .disconnect(channel, account)
            .await
    }

    pub async fn observe_channel_accounts(&self) -> ChannelStatusEffect {
        ChannelStatusOperation::new(Arc::clone(&self.client))
            .observe()
            .await
    }

    pub async fn observe_channel_snapshot(&self) -> ChannelSnapshotEffect {
        ChannelStatusOperation::new(Arc::clone(&self.client))
            .observe_snapshot()
            .await
    }

    pub async fn list_agents(&self) -> Result<AgentsList, AgentsReadFailure> {
        OpenClawAgents::new(Arc::clone(&self.client)).list().await
    }

    pub async fn wait_agent(&self, input: AgentWait) -> AgentsWaitOutcome {
        OpenClawAgents::new(Arc::clone(&self.client))
            .wait(input)
            .await
    }

    pub async fn list_agent_files(
        &self,
        agent_id: String,
    ) -> Result<AgentFiles, AgentsReadFailure> {
        OpenClawAgents::new(Arc::clone(&self.client))
            .files_list(agent_id)
            .await
    }

    pub async fn get_agent_file(
        &self,
        agent_id: String,
        name: AgentFileName,
    ) -> Result<AgentFile, AgentsReadFailure> {
        OpenClawAgents::new(Arc::clone(&self.client))
            .files_get(agent_id, name)
            .await
    }

    pub async fn create_agent(&self, input: AgentCreate) -> AgentsMutationOutcome<AgentCreated> {
        OpenClawAgents::new(Arc::clone(&self.client))
            .create(input)
            .await
    }

    pub async fn update_agent(&self, input: AgentUpdate) -> AgentsMutationOutcome<AgentUpdated> {
        OpenClawAgents::new(Arc::clone(&self.client))
            .update(input)
            .await
    }

    pub async fn delete_agent(&self, input: AgentDelete) -> AgentsMutationOutcome<AgentDeleted> {
        OpenClawAgents::new(Arc::clone(&self.client))
            .delete(input)
            .await
    }

    pub async fn agent_configuration_display(
        &self,
    ) -> Result<AgentConfigurationDisplay, AgentConfigurationReadFailure> {
        AgentConfiguration::new(Arc::clone(&self.client))
            .display()
            .await
    }

    pub async fn set_agent_description(
        &self,
        agent_id: String,
        description: Option<String>,
    ) -> AgentConfigurationMutationOutcome {
        AgentConfiguration::new(Arc::clone(&self.client))
            .set_description(agent_id, description)
            .await
    }

    pub async fn set_agent_configuration_model(
        &self,
        agent_id: String,
        model: Option<AgentConfigurationModel>,
    ) -> AgentConfigurationMutationOutcome {
        AgentConfiguration::new(Arc::clone(&self.client))
            .set_model(agent_id, model)
            .await
    }

    pub async fn set_agent_skills(
        &self,
        agent_id: String,
        skills: Vec<String>,
    ) -> AgentConfigurationMutationOutcome {
        AgentConfiguration::new(Arc::clone(&self.client))
            .set_skills(agent_id, skills)
            .await
    }

    pub async fn agent_skill_configuration(&self, agent_id: String) -> SkillConfigurationOutcome {
        AgentConfiguration::new(Arc::clone(&self.client))
            .skill_configuration(agent_id)
            .await
    }

    pub async fn set_agent_skill_configuration(
        &self,
        agent_id: String,
        revision: String,
        selection: SkillSelection,
    ) -> SkillConfigurationOutcome {
        AgentConfiguration::new(Arc::clone(&self.client))
            .set_skill_configuration(agent_id, revision, selection)
            .await
    }

    pub async fn agent_tool_configuration(&self, agent_id: String) -> ToolConfigurationOutcome {
        AgentConfiguration::new(Arc::clone(&self.client))
            .tool_configuration(agent_id)
            .await
    }

    pub async fn platform_tools_catalog(
        &self,
    ) -> Result<ToolCatalog, AgentConfigurationReadFailure> {
        AgentConfiguration::new(Arc::clone(&self.client))
            .platform_tools_catalog()
            .await
    }

    pub async fn set_agent_tool_configuration(
        &self,
        agent_id: String,
        revision: String,
        selection: ToolSelection,
    ) -> ToolConfigurationOutcome {
        AgentConfiguration::new(Arc::clone(&self.client))
            .set_tool_configuration(agent_id, revision, selection)
            .await
    }

    pub async fn set_agent_file(
        &self,
        agent_id: String,
        name: AgentFileName,
        content: String,
    ) -> AgentsMutationOutcome<AgentFile> {
        OpenClawAgents::new(Arc::clone(&self.client))
            .files_set(agent_id, name, content)
            .await
    }

    /// Performs the native ClawHub installation effect through the pinned
    /// OpenClaw Gateway. The returned outcome never treats the Gateway write
    /// acknowledgement, config state, or workspace discovery as final proof.
    pub async fn install_clawhub_skill(
        &self,
        request: ClawHubSkillInstall,
    ) -> ClawHubSkillInstallOutcome {
        ClawHubSkillInstaller::new(Arc::clone(&self.client))
            .install(request)
            .await
    }

    pub async fn installed_skill_catalog(&self) -> Option<InstalledSkillCatalog> {
        ClawHubSkillInstaller::new(Arc::clone(&self.client))
            .installed_catalog()
            .await
    }

    pub async fn skill_status_catalog(
        &self,
    ) -> Result<SkillStatusCatalog, SkillStatusCatalogError> {
        OpenClawSkillStatusCatalog::new(Arc::clone(&self.client))
            .read()
            .await
    }

    pub async fn search_skills(
        &self,
        request: SkillSearchRequest,
    ) -> Result<Vec<SkillSearchResult>, SkillReadError> {
        OpenClawSkillOperations::new(Arc::clone(&self.client))
            .search(request)
            .await
    }

    pub async fn detail_skill(
        &self,
        request: SkillDetailRequest,
    ) -> Result<SkillDetail, SkillReadError> {
        OpenClawSkillOperations::new(Arc::clone(&self.client))
            .detail(request)
            .await
    }

    pub async fn install_skill(&self, request: SkillInstallRequest) -> SkillMutationOutcome {
        OpenClawSkillOperations::new(Arc::clone(&self.client))
            .install(request)
            .await
    }

    pub async fn update_skill(&self, request: SkillUpdateRequest) -> SkillMutationOutcome {
        OpenClawSkillOperations::new(Arc::clone(&self.client))
            .update(request)
            .await
    }

    pub async fn begin_skill_upload(&self, request: SkillUploadBegin) -> SkillUploadOutcome {
        OpenClawSkillOperations::new(Arc::clone(&self.client))
            .upload_begin(request)
            .await
    }

    pub async fn chunk_skill_upload(&self, request: SkillUploadChunk) -> SkillUploadOutcome {
        OpenClawSkillOperations::new(Arc::clone(&self.client))
            .upload_chunk(request)
            .await
    }

    pub async fn commit_skill_upload(&self, request: SkillUploadCommit) -> SkillUploadOutcome {
        OpenClawSkillOperations::new(Arc::clone(&self.client))
            .upload_commit(request)
            .await
    }

    /// Lists the task-manager snapshot through the Gateway control exchange.
    pub async fn list_tasks(&mut self, scope: TaskScope) -> Result<TaskSnapshot, TaskReadFailure> {
        self.task_manager(scope)?.list().await
    }

    /// Reads one task through the Gateway control exchange.
    pub async fn get_task(
        &mut self,
        scope: TaskScope,
        task_id: String,
    ) -> Result<Task, TaskReadFailure> {
        self.task_manager(scope)?.get(task_id).await
    }

    /// Creates one task without retrying an ambiguous native mutation.
    pub async fn create_task(
        &mut self,
        scope: TaskScope,
        input: TaskCreate,
    ) -> TaskMutationOutcome<TaskCreateReceipt> {
        match self.task_manager(scope) {
            Ok(operation) => operation.create(input).await,
            Err(_) => TaskMutationOutcome::OutcomeUnknown,
        }
    }

    /// Updates one task without retrying an ambiguous native mutation.
    pub async fn update_task(
        &mut self,
        scope: TaskScope,
        input: TaskUpdate,
    ) -> TaskMutationOutcome<TaskSnapshot> {
        match self.task_manager(scope) {
            Ok(operation) => operation.update(input).await,
            Err(_) => TaskMutationOutcome::OutcomeUnknown,
        }
    }

    /// Replaces the native todo projection without retrying ambiguous delivery.
    pub async fn write_todos(
        &mut self,
        scope: TaskScope,
        old_todos: Vec<Todo>,
        new_todos: Vec<Todo>,
    ) -> TaskMutationOutcome<TodoSnapshot> {
        match self.task_manager(scope) {
            Ok(operation) => operation.todo_write(old_todos, new_todos).await,
            Err(_) => TaskMutationOutcome::OutcomeUnknown,
        }
    }

    /// Reads the native todo projection through the Gateway control exchange.
    pub async fn get_todos(&mut self, scope: TaskScope) -> Result<TodoSnapshot, TaskReadFailure> {
        self.task_manager(scope)?.todo_get().await
    }

    /// Reads the native task output status through the Gateway control exchange.
    pub async fn task_output(
        &mut self,
        scope: TaskScope,
        task_id: String,
    ) -> Result<TaskOutput, TaskReadFailure> {
        self.task_manager(scope)?.output(task_id).await
    }

    /// Stops one native task without retrying an ambiguous mutation.
    pub async fn stop_task(
        &mut self,
        scope: TaskScope,
        task_id: String,
    ) -> TaskMutationOutcome<TaskStopResult> {
        match self.task_manager(scope) {
            Ok(operation) => operation.stop(task_id).await,
            Err(_) => TaskMutationOutcome::OutcomeUnknown,
        }
    }

    pub async fn list_sessions(
        &mut self,
        params: SessionsListParams,
    ) -> Result<SessionsListResult, OpenClawSessionError> {
        SessionOperation::new(Arc::clone(&self.client))
            .list_sessions(params)
            .await
            .map_err(Into::into)
    }

    pub async fn history(
        &mut self,
        params: ChatHistoryParams,
    ) -> Result<ChatHistoryResult, OpenClawSessionError> {
        SessionOperation::new(Arc::clone(&self.client))
            .history(params)
            .await
            .map_err(Into::into)
    }

    pub async fn history_window(
        &mut self,
        params: ChatHistoryParams,
        request: PageRequest,
    ) -> Result<SessionWindow, OpenClawSessionError> {
        let payload = SessionOperation::new(Arc::clone(&self.client))
            .history_payload(params)
            .await
            .map_err(OpenClawSessionError::from)?;
        session_window::decode_window(payload, request).map_err(|_| OpenClawSessionError::Protocol)
    }

    pub async fn enqueue_chat(
        &mut self,
        params: ChatSendParams,
        route_key: String,
    ) -> Result<ChatSendResult, OpenClawSessionError> {
        let session_key = params.session_key().clone();
        self.client.register_session_route(&session_key, route_key);
        match self.send_chat(params).await {
            Ok(InvocationOutcome::Succeeded(result)) => Ok(result),
            Ok(InvocationOutcome::TargetRejected(error)) => {
                self.client.unregister_session_route(&session_key);
                Err(error)
            }
            Ok(InvocationOutcome::Cancelled | InvocationOutcome::Unknown) => {
                self.client.unregister_session_route(&session_key);
                Err(OpenClawSessionError::UnknownResponse)
            }
            Err(error) => {
                self.client.unregister_session_route(&session_key);
                Err(error)
            }
        }
    }

    pub async fn send_chat(
        &mut self,
        params: ChatSendParams,
    ) -> Result<InvocationOutcome<ChatSendResult, OpenClawSessionError>, OpenClawSessionError> {
        SessionOperation::new(Arc::clone(&self.client))
            .send_chat(params)
            .await
            .map(port_outcome)
            .map_err(Into::into)
    }

    pub async fn deliver_team_prompt(&mut self, delivery: PromptDelivery) -> PromptDeliveryOutcome {
        let params = match delivery.into_params() {
            Ok(params) => params,
            Err(_) => {
                return PromptDeliveryOutcome::Rejected {
                    failure: crate::team::PromptDeliveryFailure::PolicyRejected,
                };
            }
        };
        match SessionOperation::new(Arc::clone(&self.client))
            .send_chat(params)
            .await
        {
            Ok(outcome) => crate::team::map_send_outcome(outcome),
            Err(error) => crate::team::map_send_outcome(InvocationOutcome::TargetRejected(error)),
        }
    }

    /// Materializes a durable TeamSkill intent through native OpenClaw agent and
    /// config effects. Workspace paths, canonical configuration, and Gateway
    /// transport stay inside this integration.
    pub async fn materialize_team(
        &self,
        request: TeamMaterializationRequest,
    ) -> MaterializationOperationOutcome {
        let Some(state_dir) = self.team_state_dir.clone() else {
            return MaterializationOperationOutcome::OutcomeUnknown;
        };
        TeamProvider::new(&self.client, state_dir)
            .materialize(request)
            .await
    }

    /// Reads native Team facts to settle an ambiguous durable request. This never
    /// replays a materialization mutation and returns a receipt only after all
    /// agent, workspace, and marker facts align with the original intent.
    pub async fn recover_team_materialization(
        &self,
        request: TeamMaterializationRequest,
    ) -> MaterializationOperationOutcome {
        let Some(state_dir) = self.team_state_dir.clone() else {
            return MaterializationOperationOutcome::OutcomeUnknown;
        };
        TeamProvider::new(&self.client, state_dir)
            .recover_materialization(request)
            .await
    }

    /// Removes only facts recorded in a confirmed Team materialization receipt.
    /// Ambiguous Gateway writes are deliberately not retried or replayed.
    pub async fn remove_team_materialization(
        &self,
        removal: TeamMaterializationRemoval,
    ) -> MaterializationOperationOutcome {
        let Some(state_dir) = self.team_state_dir.clone() else {
            return MaterializationOperationOutcome::OutcomeUnknown;
        };
        TeamProvider::new(&self.client, state_dir)
            .remove(removal)
            .await
    }

    pub async fn abort_chat(
        &mut self,
        params: ChatAbortParams,
    ) -> Result<InvocationOutcome<ChatAbortResult, OpenClawSessionError>, OpenClawSessionError>
    {
        SessionOperation::new(Arc::clone(&self.client))
            .abort_chat(params)
            .await
            .map(port_outcome)
            .map_err(Into::into)
    }

    pub async fn patch_session_model(
        &mut self,
        params: SessionModelPatchParams,
    ) -> Result<
        InvocationOutcome<SessionModelPatchResult, OpenClawSessionError>,
        OpenClawSessionError,
    > {
        match self.patch_session_model_diagnostic(params).await? {
            InvocationOutcome::Succeeded(result) => Ok(InvocationOutcome::Succeeded(result)),
            InvocationOutcome::TargetRejected(_) => Ok(InvocationOutcome::TargetRejected(
                OpenClawSessionError::TargetRejected,
            )),
            InvocationOutcome::Cancelled => Ok(InvocationOutcome::Cancelled),
            InvocationOutcome::Unknown => Ok(InvocationOutcome::Unknown),
        }
    }

    pub async fn patch_session_model_diagnostic(
        &mut self,
        params: SessionModelPatchParams,
    ) -> Result<
        InvocationOutcome<SessionModelPatchResult, SessionModelPatchFailure>,
        OpenClawSessionError,
    > {
        let outcome = SessionOperation::new(Arc::clone(&self.client))
            .patch_session_model(params)
            .await
            .map_err(OpenClawSessionError::from)?;
        Ok(session_model_patch_outcome(outcome))
    }

    pub async fn patch_session_label(
        &mut self,
        params: SessionLabelPatchParams,
    ) -> Result<
        InvocationOutcome<SessionLabelPatchResult, OpenClawSessionError>,
        OpenClawSessionError,
    > {
        SessionOperation::new(Arc::clone(&self.client))
            .patch_session_label(params)
            .await
            .map(port_outcome)
            .map_err(Into::into)
    }

    pub async fn create_session(
        &mut self,
        params: SessionCreateParams,
    ) -> Result<InvocationOutcome<SessionCreateResult, OpenClawSessionError>, OpenClawSessionError>
    {
        SessionOperation::new(Arc::clone(&self.client))
            .create_session(params)
            .await
            .map(port_outcome)
            .map_err(Into::into)
    }

    pub async fn delete_session(
        &mut self,
        params: SessionDeleteParams,
    ) -> Result<InvocationOutcome<SessionDeleteResult, OpenClawSessionError>, OpenClawSessionError>
    {
        SessionOperation::new(Arc::clone(&self.client))
            .delete_session(params)
            .await
            .map(port_outcome)
            .map_err(Into::into)
    }

    pub async fn invalidate_control(&self) {
        self.client.close_control_connection().await;
    }

    fn task_manager(&mut self, scope: TaskScope) -> Result<TaskManagerOperation, TaskReadFailure> {
        Ok(TaskManagerOperation::new(Arc::clone(&self.client), scope))
    }
}

impl fmt::Debug for OpenClawGateway {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OpenClawGateway")
            .finish_non_exhaustive()
    }
}

fn port_outcome<T>(
    outcome: InvocationOutcome<T, OperationError>,
) -> InvocationOutcome<T, OpenClawSessionError> {
    match outcome {
        InvocationOutcome::Succeeded(result) => InvocationOutcome::Succeeded(result),
        InvocationOutcome::TargetRejected(error) => InvocationOutcome::TargetRejected(error.into()),
        InvocationOutcome::Cancelled => InvocationOutcome::Cancelled,
        InvocationOutcome::Unknown => InvocationOutcome::Unknown,
    }
}

fn session_model_patch_outcome(
    outcome: InvocationOutcome<SessionModelPatchResult, OperationError>,
) -> InvocationOutcome<SessionModelPatchResult, SessionModelPatchFailure> {
    match outcome {
        InvocationOutcome::Succeeded(result) => InvocationOutcome::Succeeded(result),
        InvocationOutcome::TargetRejected(error) => InvocationOutcome::TargetRejected(
            SessionModelPatchFailure::TargetRejected(OpenClawPeerRejection::from_operation(&error)),
        ),
        InvocationOutcome::Cancelled => InvocationOutcome::Cancelled,
        InvocationOutcome::Unknown => InvocationOutcome::Unknown,
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct OpenClawPeerRejection {
    code: String,
    message: String,
}

impl OpenClawPeerRejection {
    fn from_operation(error: &OperationError) -> Option<Self> {
        let (code, message) = error.gateway_rejection()?;
        Some(Self {
            code: code.to_owned(),
            message: message.to_owned(),
        })
    }

    pub fn code(&self) -> &str {
        &self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Debug for OpenClawPeerRejection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OpenClawPeerRejection")
            .field("code", &self.code)
            .field("message", &"[REDACTED]")
            .finish()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SessionModelPatchFailure {
    TargetRejected(Option<OpenClawPeerRejection>),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OpenClawControlReadiness {
    Ready,
    Starting,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OpenClawSessionError {
    SessionConnection,
    RequestIdExhausted,
    RequestDeadline,
    ConnectionClosed,
    UnknownResponse,
    Transport,
    Protocol,
    TargetRejected,
    EventBackpressure,
}

impl From<OperationError> for OpenClawSessionError {
    fn from(value: OperationError) -> Self {
        match value {
            OperationError::RequestIdExhausted => Self::RequestIdExhausted,
            OperationError::RequestDeadline => Self::RequestDeadline,
            OperationError::ConnectionClosed => Self::ConnectionClosed,
            OperationError::UnknownResponse => Self::UnknownResponse,
            OperationError::Transport => Self::Transport,
            OperationError::Protocol => Self::Protocol,
            OperationError::Rejected | OperationError::GatewayRejected { .. } => {
                Self::TargetRejected
            }
        }
    }
}

impl fmt::Display for OpenClawSessionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::SessionConnection => "OpenClaw session connection failed",
            Self::RequestIdExhausted => "OpenClaw session request IDs are exhausted",
            Self::RequestDeadline => "OpenClaw session request deadline elapsed",
            Self::ConnectionClosed => "OpenClaw session connection closed",
            Self::UnknownResponse => "OpenClaw session response was not correlated",
            Self::Transport => "OpenClaw session transport failed",
            Self::Protocol => "OpenClaw session protocol failed",
            Self::TargetRejected => "OpenClaw session request was rejected",
            Self::EventBackpressure => "OpenClaw session event capacity was exhausted",
        })
    }
}

impl std::error::Error for OpenClawSessionError {}

#[cfg(test)]
mod tests {
    use std::{sync::Arc, time::Duration};

    use futures_util::{SinkExt, StreamExt};
    use platform::listener_identity::ListenerIdentity;
    use serde_json::{Value, json};
    use tokio::{net::TcpListener, sync::mpsc, time::timeout};
    use tokio_tungstenite::tungstenite::Message;

    use crate::{
        gateway::{
            client::test_support::{TestSocket, TestTlsIdentity, accept_websocket},
            wire,
        },
        session::protocol::{
            AgentId, AgentScopedSessionKey, EndpointSessionId, ModelRef, RunId, SessionKey,
        },
    };

    use super::*;

    const TEST_TIMEOUT: Duration = Duration::from_secs(2);

    #[test]
    fn gateway_port_debug_excludes_endpoint_and_secret() {
        let identity = ListenerIdentity::generate_loopback().unwrap();
        let (events, _) = mpsc::channel(1);
        let (canonical_events, _) = mpsc::channel(32);
        let gateway = OpenClawGateway::new(
            GatewayEndpoint::try_new("127.0.0.1:18789".parse().unwrap()).unwrap(),
            identity.fingerprint(),
            Arc::new(GatewaySecret::new("gateway-port-secret-canary".into()).unwrap()),
            GatewayClientMetadata::try_new("1.0.0".into(), "windows".into()).unwrap(),
            events,
            canonical_events,
        );

        let debug = format!("{gateway:?}");
        assert!(!debug.contains("gateway-port-secret-canary"));
        assert!(!debug.contains("127.0.0.1"));
        assert!(!debug.contains("18789"));
    }

    #[test]
    fn lifecycle_event_sink_uses_only_safe_value_facts() {
        let (events, mut received) = mpsc::channel::<LifecycleEvent>(1);
        events
            .try_send(LifecycleEvent::new(Some(7), true, false, true))
            .unwrap();

        let event = received.try_recv().unwrap();
        assert_eq!(event.sequence(), Some(7));
        assert!(event.has_run());
        assert!(!event.has_message());
        assert!(event.has_session_activity());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn task_operations_reuse_gateway_control_exchange() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let identity = TestTlsIdentity::generate();
        let endpoint = GatewayEndpoint::try_new(listener.local_addr().unwrap()).unwrap();
        let acceptor = identity.acceptor();
        let peer = tokio::spawn(async move {
            let mut socket = accept_websocket(&listener, &acceptor).await;
            send_json(
                &mut socket,
                json!({
                    "type":"event",
                    "event":"connect.challenge",
                    "payload":{"nonce":"port-task-nonce","ts":42}
                }),
            )
            .await;
            let connect = read_json(&mut socket).await;
            assert_eq!(connect["method"], "connect");
            send_json(&mut socket, hello(connect["id"].as_str().unwrap())).await;

            let list = read_json(&mut socket).await;
            assert_task_request(&list, "TaskList");
            send_json(&mut socket, task_response(&list, task_list_payload())).await;

            let get = read_json(&mut socket).await;
            assert_task_request(&get, "TaskGet");
            send_json(
                &mut socket,
                task_response(&get, json!({"scope":task_scope(),"task":task()})),
            )
            .await;

            let create = read_json(&mut socket).await;
            assert_task_request(&create, "TaskCreate");
            send_json(
                &mut socket,
                task_response(&create, json!({"scope":task_scope(),"task":task()})),
            )
            .await;

            let create_snapshot = read_json(&mut socket).await;
            assert_task_request(&create_snapshot, "TaskList");
            send_json(
                &mut socket,
                task_response(&create_snapshot, task_list_payload()),
            )
            .await;

            let update = read_json(&mut socket).await;
            assert_task_request(&update, "TaskUpdate");
            send_json(
                &mut socket,
                task_response(&update, json!({"scope":task_scope(),"task":updated_task()})),
            )
            .await;

            let update_snapshot = read_json(&mut socket).await;
            assert_task_request(&update_snapshot, "TaskList");
            send_json(
                &mut socket,
                task_response(&update_snapshot, updated_task_list_payload()),
            )
            .await;

            let todo_write = read_json(&mut socket).await;
            assert_task_request(&todo_write, "TodoWrite");
            send_json(
                &mut socket,
                task_response(&todo_write, todo_snapshot_payload()),
            )
            .await;

            let todo_get = read_json(&mut socket).await;
            assert_task_request(&todo_get, "TodoGet");
            send_json(
                &mut socket,
                task_response(&todo_get, todo_snapshot_payload()),
            )
            .await;

            let output = read_json(&mut socket).await;
            assert_task_request(&output, "TaskOutput");
            send_json(
                &mut socket,
                task_response(
                    &output,
                    json!({"success":false,"taskId":"task-1","status":"not_found","message":"not found"}),
                ),
            )
            .await;

            let stop = read_json(&mut socket).await;
            assert_task_request(&stop, "TaskStop");
            send_json(
                &mut socket,
                task_response(
                    &stop,
                    json!({"success":false,"taskId":"task-1","found":false,"cancelled":false,"message":"not found"}),
                ),
            )
            .await;

            match timeout(Duration::from_millis(100), socket.next()).await {
                Err(_) | Ok(None) | Ok(Some(Ok(Message::Close(_)))) => {}
                Ok(Some(Ok(frame))) => panic!("unexpected extra Gateway frame: {frame:?}"),
                Ok(Some(Err(error))) => panic!("unexpected Gateway peer error: {error}"),
            }
        });
        let (events, _) = mpsc::channel(1);
        let (canonical_events, _) = mpsc::channel(32);
        let mut gateway = OpenClawGateway::new(
            endpoint,
            identity.fingerprint(),
            Arc::new(GatewaySecret::new("port-task-secret".into()).unwrap()),
            GatewayClientMetadata::try_new("1.0.0".into(), "test".into()).unwrap(),
            events,
            canonical_events,
        );

        assert!(gateway.list_tasks(task_scope_input()).await.is_ok());
        assert!(
            gateway
                .get_task(task_scope_input(), "task-1".into())
                .await
                .is_ok()
        );
        assert!(matches!(
            gateway
                .create_task(
                    task_scope_input(),
                    TaskCreate::try_new("subject".into(), "description".into(), None, None, None)
                        .unwrap(),
                )
                .await,
            TaskMutationOutcome::Applied(_)
        ));
        assert!(matches!(
            gateway
                .update_task(
                    task_scope_input(),
                    TaskUpdate::try_new(
                        "task-1".into(),
                        None,
                        Some("updated subject".into()),
                        None,
                        None,
                        None,
                        None,
                        None,
                        None,
                    )
                    .unwrap(),
                )
                .await,
            TaskMutationOutcome::Applied(_)
        ));
        assert!(matches!(
            gateway
                .write_todos(task_scope_input(), vec![], vec![])
                .await,
            TaskMutationOutcome::Applied(_)
        ));
        assert!(gateway.get_todos(task_scope_input()).await.is_ok());
        assert_eq!(
            gateway
                .task_output(task_scope_input(), "task-1".into())
                .await,
            Ok(TaskOutput::NotFound)
        );
        assert!(matches!(
            gateway.stop_task(task_scope_input(), "task-1".into()).await,
            TaskMutationOutcome::Applied(_)
        ));
        timeout(TEST_TIMEOUT, peer).await.unwrap().unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn session_operations_use_gateway_control_without_subscribe() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let identity = TestTlsIdentity::generate();
        let endpoint = GatewayEndpoint::try_new(listener.local_addr().unwrap()).unwrap();
        let acceptor = identity.acceptor();
        let peer = tokio::spawn(async move {
            let mut socket = accept_websocket(&listener, &acceptor).await;
            send_json(
                &mut socket,
                json!({
                    "type":"event",
                    "event":"connect.challenge",
                    "payload":{"nonce":"port-session-nonce","ts":42}
                }),
            )
            .await;
            let connect = read_json(&mut socket).await;
            assert_eq!(connect["method"], "connect");
            send_json(&mut socket, hello(connect["id"].as_str().unwrap())).await;

            let list = read_json(&mut socket).await;
            assert_session_request(&list, "sessions.list");
            send_json(
                &mut socket,
                session_response(&list, sessions_list_payload()),
            )
            .await;

            let history = read_json(&mut socket).await;
            assert_session_request(&history, "chat.history");
            send_json(&mut socket, session_response(&history, history_payload())).await;

            let send = read_json(&mut socket).await;
            assert_session_request(&send, "chat.send");
            send_json(&mut socket, session_response(&send, chat_send_payload())).await;

            let abort = read_json(&mut socket).await;
            assert_session_request(&abort, "chat.abort");
            send_json(&mut socket, session_response(&abort, chat_abort_payload())).await;

            let patch_model = read_json(&mut socket).await;
            assert_session_request(&patch_model, "sessions.patch");
            send_json(
                &mut socket,
                session_response(&patch_model, session_model_patch_payload()),
            )
            .await;

            let patch_label = read_json(&mut socket).await;
            assert_session_request(&patch_label, "sessions.patch");
            send_json(
                &mut socket,
                session_response(&patch_label, session_label_patch_payload()),
            )
            .await;

            let create = read_json(&mut socket).await;
            assert_session_request(&create, "sessions.create");
            send_json(
                &mut socket,
                session_response(&create, session_create_payload()),
            )
            .await;

            let delete = read_json(&mut socket).await;
            assert_session_request(&delete, "sessions.delete");
            send_json(
                &mut socket,
                session_response(&delete, session_delete_payload()),
            )
            .await;

            match timeout(Duration::from_millis(100), socket.next()).await {
                Err(_) | Ok(None) | Ok(Some(Ok(Message::Close(_)))) => {}
                Ok(Some(Ok(frame))) => panic!("unexpected extra Gateway frame: {frame:?}"),
                Ok(Some(Err(error))) => panic!("unexpected Gateway peer error: {error}"),
            }
        });
        let (events, _) = mpsc::channel(1);
        let (canonical_events, _) = mpsc::channel(32);
        let mut gateway = OpenClawGateway::new(
            endpoint,
            identity.fingerprint(),
            Arc::new(GatewaySecret::new("port-session-secret".into()).unwrap()),
            GatewayClientMetadata::try_new("1.0.0".into(), "test".into()).unwrap(),
            events,
            canonical_events,
        );

        assert!(
            gateway
                .list_sessions(SessionsListParams::default())
                .await
                .is_ok()
        );
        assert!(gateway.history(history_params()).await.is_ok());
        let send_result = gateway
            .enqueue_chat(chat_send_params(), "renderer-route:test".into())
            .await
            .unwrap();
        assert_eq!(send_result.run_id.as_str(), "native-run-1");
        assert!(matches!(
            gateway.abort_chat(chat_abort_params()).await.unwrap(),
            InvocationOutcome::Succeeded(_)
        ));
        assert!(matches!(
            gateway
                .patch_session_model(session_model_patch_params())
                .await
                .unwrap(),
            InvocationOutcome::Succeeded(_)
        ));
        assert!(matches!(
            gateway
                .patch_session_label(session_label_patch_params())
                .await
                .unwrap(),
            InvocationOutcome::Succeeded(_)
        ));
        assert!(matches!(
            gateway
                .create_session(session_create_params())
                .await
                .unwrap(),
            InvocationOutcome::Succeeded(_)
        ));
        assert!(matches!(
            gateway
                .delete_session(session_delete_params())
                .await
                .unwrap(),
            InvocationOutcome::Succeeded(_)
        ));
        timeout(TEST_TIMEOUT, peer).await.unwrap().unwrap();
    }

    #[test]
    fn mutation_outcomes_project_only_typed_rejections() {
        assert_eq!(
            port_outcome::<()>(InvocationOutcome::TargetRejected(OperationError::Protocol)),
            InvocationOutcome::TargetRejected(OpenClawSessionError::Protocol)
        );
        assert_eq!(
            port_outcome::<()>(InvocationOutcome::Unknown),
            InvocationOutcome::Unknown
        );
    }

    #[test]
    fn operation_errors_are_projected_to_openclaw_session_errors() {
        assert_eq!(
            OpenClawSessionError::from(OperationError::Rejected),
            OpenClawSessionError::TargetRejected
        );
        assert_eq!(
            OpenClawSessionError::from(OperationError::ConnectionClosed),
            OpenClawSessionError::ConnectionClosed
        );
    }

    fn task_scope_input() -> TaskScope {
        TaskScope::try_new(
            "session-canary".into(),
            Some("team-canary".into()),
            "workspace-canary".into(),
        )
        .unwrap()
    }

    fn task_scope() -> Value {
        json!({"type":"team","key":"team:team-canary","label":"Team · team-canary","teamKey":"team-canary"})
    }

    fn task() -> Value {
        json!({
            "id":"task-1", "subject":"subject", "description":"description",
            "activeForm":"working", "status":"pending", "owner":"owner",
            "blockedBy":[], "blocks":[], "createdAt":1, "updatedAt":2
        })
    }

    fn updated_task() -> Value {
        json!({
            "id":"task-1", "subject":"updated subject", "description":"description",
            "activeForm":"working", "status":"pending", "owner":"owner",
            "blockedBy":[], "blocks":[], "createdAt":1, "updatedAt":3
        })
    }

    fn task_list_payload() -> Value {
        json!({"scope":task_scope(),"tasks":[task()],"todos":[]})
    }

    fn updated_task_list_payload() -> Value {
        json!({"scope":task_scope(),"tasks":[updated_task()],"todos":[]})
    }

    fn todo_snapshot_payload() -> Value {
        json!({
            "todos":[{"id":"todo-1","content":"content","status":"pending"}],
            "updatedAt":2
        })
    }

    fn assert_task_request(request: &Value, method: &str) {
        assert_eq!(request["type"], "req");
        assert_eq!(request["method"], method);
        assert_ne!(request["method"], "sessions.subscribe");
        assert_eq!(request["params"]["sessionKey"], "session-canary");
        assert_eq!(request["params"]["workspaceDir"], "workspace-canary");
    }

    fn task_response(request: &Value, payload: Value) -> Value {
        json!({"type":"res","id":request["id"],"ok":true,"payload":payload})
    }

    fn session_key() -> SessionKey {
        SessionKey::try_new("agent:port-agent:session-1").unwrap()
    }

    fn run_id() -> RunId {
        RunId::try_new("run-1").unwrap()
    }

    fn agent_id() -> AgentId {
        AgentId::try_new("port-agent").unwrap()
    }

    fn endpoint_session_id() -> EndpointSessionId {
        EndpointSessionId::try_new("session-1").unwrap()
    }

    fn scoped_session_key() -> AgentScopedSessionKey {
        AgentScopedSessionKey::try_new(agent_id(), endpoint_session_id()).unwrap()
    }

    fn history_params() -> ChatHistoryParams {
        ChatHistoryParams::new(session_key())
    }

    fn chat_send_params() -> ChatSendParams {
        ChatSendParams::try_new(session_key(), "hello", run_id()).unwrap()
    }

    fn chat_abort_params() -> ChatAbortParams {
        ChatAbortParams::new(session_key()).for_run(run_id())
    }

    fn session_model_patch_params() -> SessionModelPatchParams {
        SessionModelPatchParams::new(
            session_key(),
            Some(ModelRef::try_new("claude-sonnet").unwrap()),
        )
    }

    fn session_label_patch_params() -> SessionLabelPatchParams {
        SessionLabelPatchParams::try_new(session_key(), "Port Session").unwrap()
    }

    fn session_create_params() -> SessionCreateParams {
        SessionCreateParams::try_new(agent_id(), endpoint_session_id()).unwrap()
    }

    fn session_delete_params() -> SessionDeleteParams {
        SessionDeleteParams::new(scoped_session_key())
    }

    fn assert_session_request(request: &Value, method: &str) {
        assert_eq!(request["type"], "req");
        assert_eq!(request["method"], method);
        assert_ne!(request["method"], "sessions.subscribe");
    }

    fn session_response(request: &Value, payload: Value) -> Value {
        json!({"type":"res","id":request["id"],"ok":true,"payload":payload})
    }

    fn sessions_list_payload() -> Value {
        json!({
            "ts": 42,
            "count": 1,
            "totalCount": 1,
            "hasMore": false,
            "sessions": [{
                "key": "agent:port-agent:session-1",
                "kind": "direct",
                "agentId": "port-agent",
                "label": "Port Session",
                "displayName": "Port Agent",
                "derivedTitle": "Hello",
                "updatedAt": 42,
                "status": "idle",
                "hasActiveRun": false,
                "model": "claude-sonnet"
            }]
        })
    }

    fn history_payload() -> Value {
        json!({"messages":[{"role":"user","content":"hello"}]})
    }

    fn chat_send_payload() -> Value {
        json!({"runId":"native-run-1","status":"started"})
    }

    fn chat_abort_payload() -> Value {
        json!({"ok":true,"aborted":true,"runIds":["run-1"]})
    }

    fn session_model_patch_payload() -> Value {
        json!({
            "ok": true,
            "key": "agent:port-agent:session-1",
            "resolved": {
                "modelProvider": "anthropic",
                "model": "claude-sonnet",
                "agentRuntime": {"id":"runtime-1","source":"agent"}
            }
        })
    }

    fn session_label_patch_payload() -> Value {
        json!({"ok":true,"key":"agent:port-agent:session-1"})
    }

    fn session_create_payload() -> Value {
        json!({"ok":true,"key":"agent:port-agent:session-1","sessionId":"session-1"})
    }

    fn session_delete_payload() -> Value {
        json!({"ok":true,"key":"agent:port-agent:session-1","deleted":true})
    }

    async fn read_json(socket: &mut TestSocket) -> Value {
        let Message::Text(text) = socket.next().await.unwrap().unwrap() else {
            panic!("expected text Gateway frame");
        };
        serde_json::from_str(text.as_str()).unwrap()
    }

    async fn send_json(socket: &mut TestSocket, value: Value) {
        socket
            .send(Message::Text(value.to_string().into()))
            .await
            .unwrap();
    }

    fn hello(id: &str) -> Value {
        json!({
            "type":"res",
            "id":id,
            "ok":true,
            "payload":{
                "type":"hello-ok",
                "protocol":4,
                "server":{"version":"2026.5.20","connId":"port-task-connection"},
                "features":{"methods":[
                    "status",
                    "config.get",
                    "config.patch",
                    "config.apply",
                    "agents.list",
                    "skills.status",
                    wire::SYSTEM_PRESENCE_METHOD,
                    "chat.send",
                    "chat.abort",
                    "chat.history",
                    "sessions.list",
                    "sessions.patch",
                    "sessions.create",
                    "sessions.delete",
                    "TaskCreate",
                    "TaskUpdate",
                    "TaskList",
                    "TaskGet",
                    "TodoWrite",
                    "TodoGet",
                    "TaskOutput",
                    "TaskStop"
                ],"events":["tick", "chat", "session.message", "session.operation", "session.tool", "sessions.changed"]},
                "snapshot":{
                    "presence":[],
                    "health":{"ok":true},
                    "stateVersion":{"presence":1,"health":1},
                    "uptimeMs":100
                },
                "auth":{"role":"operator","scopes":["operator.read", "operator.write", "operator.admin", "operator.approvals"]},
                "policy":{
                    "maxPayload":26214400,
                    "maxBufferedBytes":52428800,
                    "tickIntervalMs":15000
                }
            }
        })
    }
}
