use std::{future::Future, pin::Pin};

use foundation::process::supervision::{
    RestartOutcome, StartOutcome, SupervisorRejection, SupervisorSnapshot, TerminationCompletion,
};
use platform::{endpoint::runtime_address::RuntimeEndpoint, exchange::InvocationOutcome};
use tokio::sync::watch;

use matcha_agent::session::{
    client::AppServerClientError as MatchaAppServerClientError,
    model::{SessionId as MatchaSessionId, SessionRecord as MatchaSessionRecord},
};

use crate::{
    RuntimeSessionError,
    channel::{
        catalog::{ChannelCatalogOutcome, ChannelConfigureFormOutcome, ChannelConfigureOutcome},
        config_read as channel_config_read,
        control::{ChannelControlAction, ChannelControlOutcome},
        credentials as channel_credentials, delete as channel_delete,
        login::Outcome as ChannelLoginOutcome,
        status::{
            ChannelPairingApprovalOutcome, ChannelPairingOutcome, ChannelSnapshotOutcome,
            ChannelStatusFailure, ChannelStatusOutcome,
        },
    },
    cron::{
        CronCreateCommand, CronDeleteCommand, CronDeleteOutcome, CronExecutionAdmission,
        CronJobMutationOutcome, CronListOutcome, CronRunHistoryFailure, CronRunHistoryReceipt,
        CronTriggerResult, CronUpdateCommand,
    },
    sessions::abort::{SessionAbortCommand, SessionAbortOutcome},
    sessions::approval::{
        PendingApprovalsCommand, PendingApprovalsOutcome, SessionApprovalCommand,
        SessionApprovalOutcome,
    },
    sessions::create::{SessionAdmission, SessionCreateCommand, SessionCreateOutcome},
    sessions::delete::{SessionDeleteCommand, SessionDeleteOutcome},
    sessions::model_selection::{ResolvedSessionModelSelection, SessionModelSelectionOutcome},
    sessions::openclaw_direct::SessionCatalog,
    sessions::rename::{SessionRenameCommand, SessionRenameOutcome},
    sessions::send::{SessionSendCommand, SessionSendOutcome},
    sessions::session_permission::{SessionPermissionCommand, SessionPermissionOutcome},
    sessions::timeline::{self, ContentCommand, ContentOutcome},
    skills::install::{Command as SkillInstallCommand, Outcome as SkillInstallOutcome},
    skills::management::{Command as SkillManagementCommand, Outcome as SkillManagementOutcome},
    tasks::manager::{Command as TaskManagerCommand, Outcome as TaskManagerOutcome},
};

use openclaw::{
    port::{OpenClawSessionError, ProviderNativeConfigurationEffect},
    session::protocol::{
        ChatAbortParams, ChatAbortResult, ChatHistoryParams, ChatHistoryResult, ChatSendParams,
        ChatSendResult,
    },
};
use organization::{
    MaterializationOperationOutcome, NativeDeletionEvidence, RoleAbortOutcome, RunRuntimeReceipt,
    TeamMaterializationRemoval, TeamMaterializationRequest,
};

const OPENCLAW_PROTOCOL_ID: &str = "openclaw-v4";
const OPENCLAW_RUNTIME_ADAPTER_ID: &str = "openclaw";
const MATCHA_PROTOCOL_ID: &str = "matcha-agent-app-server";
const MATCHA_RUNTIME_ADAPTER_ID: &str = "matcha-agent";
const LOCAL_RUNTIME_INSTANCE_ID: &str = "local";
const OPENCLAW_AGENT_ID: &str = "main";
const MATCHA_AGENT_ID: &str = "matcha";

pub(crate) trait RuntimeDriver: Send + Sync {
    fn identity(&self) -> RuntimeDriverIdentity;

    fn endpoint(&self) -> RuntimeEndpoint {
        self.identity().endpoint()
    }

    fn capability_surface(&self) -> RuntimeCapabilitySurface;

    fn session_ops(&self) -> Option<&dyn SessionOps> {
        None
    }

    fn task_ops(&self) -> Option<&dyn TaskOps> {
        None
    }

    fn subagent_ops(&self) -> Option<&dyn SubagentOps> {
        None
    }

    fn team_ops(&self) -> Option<&dyn TeamOps> {
        None
    }

    fn team_terminal_ops(&self) -> Option<&dyn TeamTerminalOps> {
        None
    }

    fn cron_ops(&self) -> Option<&dyn CronOps> {
        None
    }

    fn workspace_ops(&self) -> Option<&dyn WorkspaceOps> {
        None
    }

    fn skill_ops(&self) -> Option<&dyn SkillOps> {
        None
    }

    fn channel_ops(&self) -> Option<&dyn ChannelOps> {
        None
    }

    fn lifecycle_ops(&self) -> Option<&dyn LifecycleOps> {
        None
    }

    fn provider_config_ops(&self) -> Option<&dyn ProviderConfigOps> {
        None
    }

    fn connector_ops(&self) -> Option<&dyn ConnectorOps> {
        None
    }

    fn security_ops(&self) -> Option<&dyn SecurityOps> {
        None
    }

    fn settings_ops(&self) -> Option<&dyn SettingsOps> {
        None
    }
}

pub(crate) type SessionFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
pub(crate) type OwnedRuntimeFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ActivityExecutionRequest {
    activity: RuntimeActivity,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum RuntimeActivity {
    AgentTask(AgentTaskActivity),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AgentTaskActivity {
    delivery: organization::DeliveryRequest,
    binding: organization::RoleSessionReceipt,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ActivityExecutionRequestError {
    InvalidDeliveryReference,
    InvalidIdempotencyKey,
    InvalidPromptPayload,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ActivityExecutionOutcome {
    Accepted {
        receipt: organization::DeliveryReceiptReference,
        correlation: organization::NativeDeliveryCorrelation,
    },
    Rejected {
        rejection: organization::DeliveryRejection,
    },
    Unknown,
}

impl ActivityExecutionRequest {
    pub(crate) fn agent_task(activity: AgentTaskActivity) -> Self {
        Self {
            activity: RuntimeActivity::AgentTask(activity),
        }
    }

    pub(crate) fn binding(&self) -> &organization::RoleSessionReceipt {
        match &self.activity {
            RuntimeActivity::AgentTask(activity) => activity.binding(),
        }
    }

    pub(crate) fn delivery_request(&self) -> &organization::DeliveryRequest {
        match &self.activity {
            RuntimeActivity::AgentTask(activity) => activity.delivery_request(),
        }
    }

    pub(crate) fn into_prompt_delivery(
        self,
    ) -> Result<organization::PromptDeliveryRequest, ActivityExecutionRequestError> {
        match self.activity {
            RuntimeActivity::AgentTask(activity) => activity.into_prompt_delivery(),
        }
    }
}

impl AgentTaskActivity {
    pub(crate) fn from_activity_request(
        team_id: &organization::TeamId,
        activity: &organization::ActivityRequest,
        binding: organization::RoleSessionReceipt,
    ) -> Result<Self, ActivityExecutionRequestError> {
        let organization::ActivityKind::AgentTask {
            task_id,
            role_id,
            prompt,
            ..
        } = &activity.activity_kind
        else {
            return Err(ActivityExecutionRequestError::InvalidPromptPayload);
        };
        let delivery = organization::DeliveryRequest {
            delivery_id: organization::DeliveryId::new(activity.activity_id.as_str().to_owned())
                .map_err(|_| ActivityExecutionRequestError::InvalidDeliveryReference)?,
            team_id: team_id.as_str().to_owned(),
            run_id: activity.run_id.as_str().to_owned(),
            node_id: activity.node_id.as_str().to_owned(),
            node_execution_id: activity.node_execution_id.as_str().to_owned(),
            task_id: task_id.clone(),
            role_id: role_id.clone(),
            session_ref: binding.session_ref().as_str().to_owned(),
            idempotency_key: activity.idempotency_key.clone(),
            message: prompt.clone(),
            requested_at: activity.created_at,
            max_attempts: activity.max_attempts,
        };
        delivery
            .validate()
            .map_err(|_| ActivityExecutionRequestError::InvalidPromptPayload)?;
        Ok(Self { delivery, binding })
    }

    pub(crate) fn from_delivery_request(
        delivery: organization::DeliveryRequest,
        binding: organization::RoleSessionReceipt,
    ) -> Self {
        Self { delivery, binding }
    }

    pub(crate) fn binding(&self) -> &organization::RoleSessionReceipt {
        &self.binding
    }

    pub(crate) fn delivery_request(&self) -> &organization::DeliveryRequest {
        &self.delivery
    }

    pub(crate) fn into_prompt_delivery(
        self,
    ) -> Result<organization::PromptDeliveryRequest, ActivityExecutionRequestError> {
        Ok(organization::PromptDeliveryRequest::new(
            organization::DeliveryReference::try_new(self.delivery.delivery_id.as_str().to_owned())
                .map_err(|_| ActivityExecutionRequestError::InvalidDeliveryReference)?,
            self.binding,
            organization::IdempotencyKey::try_new(self.delivery.idempotency_key)
                .map_err(|_| ActivityExecutionRequestError::InvalidIdempotencyKey)?,
            organization::PromptDispatchPayload::try_new(self.delivery.message)
                .map_err(|_| ActivityExecutionRequestError::InvalidPromptPayload)?,
        ))
    }
}

fn activity_delivery_outcome(
    binding: &organization::RoleSessionReceipt,
    outcome: organization::PromptDeliveryOutcome,
) -> ActivityExecutionOutcome {
    match outcome {
        organization::PromptDeliveryOutcome::Delivered { receipt } => {
            let Ok(native_run_receipt) =
                organization::NativeRunReceiptReference::try_new(receipt.as_str().to_owned())
            else {
                return ActivityExecutionOutcome::Unknown;
            };
            ActivityExecutionOutcome::Accepted {
                receipt,
                correlation: organization::NativeDeliveryCorrelation::new(
                    binding.endpoint_session_id().clone(),
                    native_run_receipt,
                ),
            }
        }
        organization::PromptDeliveryOutcome::Rejected { rejection } => {
            ActivityExecutionOutcome::Rejected { rejection }
        }
        organization::PromptDeliveryOutcome::OutcomeUnknown => ActivityExecutionOutcome::Unknown,
    }
}

impl From<ActivityExecutionOutcome> for organization::PromptDeliveryOutcome {
    fn from(outcome: ActivityExecutionOutcome) -> Self {
        match outcome {
            ActivityExecutionOutcome::Accepted { receipt, .. } => Self::Delivered { receipt },
            ActivityExecutionOutcome::Rejected { rejection } => Self::Rejected { rejection },
            ActivityExecutionOutcome::Unknown => Self::OutcomeUnknown,
        }
    }
}

pub(crate) trait SessionOps: Send + Sync {
    fn admission(&self) -> SessionAdmission;

    fn abort_session<'a>(
        &'a self,
        command: SessionAbortCommand,
    ) -> SessionFuture<'a, SessionAbortOutcome>;

    fn create_session<'a>(
        &'a self,
        command: SessionCreateCommand,
        epoch: u64,
    ) -> SessionFuture<'a, SessionCreateOutcome>;

    fn openclaw_session_catalog<'a>(
        &'a self,
    ) -> SessionFuture<'a, Result<SessionCatalog, RuntimeSessionError<OpenClawSessionError>>> {
        Box::pin(async { Err(RuntimeSessionError::RuntimeUnavailable) })
    }

    fn history<'a>(
        &'a self,
        _params: ChatHistoryParams,
    ) -> SessionFuture<'a, Result<ChatHistoryResult, RuntimeSessionError<OpenClawSessionError>>>
    {
        Box::pin(async { Err(RuntimeSessionError::RuntimeUnavailable) })
    }

    fn load_openclaw_session_replay<'a>(
        &'a self,
        _request: timeline::OpenClawReplayRequest,
    ) -> SessionFuture<
        'a,
        Result<timeline::OpenClawReplayWindow, RuntimeSessionError<OpenClawSessionError>>,
    > {
        Box::pin(async { Err(RuntimeSessionError::RuntimeUnavailable) })
    }

    fn rename_session<'a>(
        &'a self,
        _command: SessionRenameCommand,
    ) -> SessionFuture<'a, SessionRenameOutcome> {
        Box::pin(async { SessionRenameOutcome::Unknown })
    }

    fn delete_session<'a>(
        &'a self,
        _command: SessionDeleteCommand,
    ) -> SessionFuture<'a, SessionDeleteOutcome> {
        Box::pin(async { SessionDeleteOutcome::Unknown })
    }

    fn list_matcha_sessions<'a>(
        &'a self,
    ) -> SessionFuture<'a, crate::sessions::matcha_session_catalog::Outcome> {
        Box::pin(async { crate::sessions::matcha_session_catalog::Outcome::Unavailable })
    }

    fn load_matcha_session<'a>(
        &'a self,
        _session_id: MatchaSessionId,
    ) -> SessionFuture<'a, Result<MatchaSessionRecord, MatchaAppServerClientError>> {
        Box::pin(async { Err(MatchaAppServerClientError::ConnectionClosed) })
    }

    fn load_matcha_history<'a>(
        &'a self,
        _command: crate::sessions::matcha_history::Command,
    ) -> SessionFuture<'a, crate::sessions::matcha_history::Outcome> {
        Box::pin(async { crate::sessions::matcha_history::Outcome::Unavailable })
    }

    fn load_session_timeline<'a>(
        &'a self,
        _command: timeline::Command,
        _epoch: u64,
    ) -> SessionFuture<'a, timeline::Outcome> {
        Box::pin(async {
            timeline::Outcome::unavailable(timeline::UnavailableReason::RuntimeUnavailable)
        })
    }

    fn load_session_content<'a>(
        &'a self,
        _command: ContentCommand,
    ) -> SessionFuture<'a, ContentOutcome> {
        Box::pin(async {
            ContentOutcome::unavailable(timeline::UnavailableReason::RuntimeUnavailable)
        })
    }

    fn pending_approvals<'a>(
        &'a self,
        _command: PendingApprovalsCommand,
    ) -> SessionFuture<'a, PendingApprovalsOutcome> {
        Box::pin(async { PendingApprovalsOutcome::Unsupported })
    }

    fn respond_to_approval<'a>(
        &'a self,
        _command: SessionApprovalCommand,
    ) -> SessionFuture<'a, SessionApprovalOutcome> {
        Box::pin(async { SessionApprovalOutcome::Unsupported })
    }

    fn send_open_claw_chat<'a>(
        &'a self,
        _params: ChatSendParams,
    ) -> SessionFuture<
        'a,
        Result<
            InvocationOutcome<ChatSendResult, OpenClawSessionError>,
            RuntimeSessionError<OpenClawSessionError>,
        >,
    > {
        Box::pin(async { Err(RuntimeSessionError::RuntimeUnavailable) })
    }

    fn send_session<'a>(
        &'a self,
        command: SessionSendCommand,
    ) -> SessionFuture<'a, SessionSendOutcome>;

    fn wait_session_native_run<'a>(
        &'a self,
        _endpoint_session_id: Option<String>,
        _native_run_id: String,
    ) -> SessionFuture<'a, Option<NativeRunSettled>> {
        Box::pin(async { None })
    }

    fn abort_open_claw_chat<'a>(
        &'a self,
        _params: ChatAbortParams,
    ) -> SessionFuture<
        'a,
        Result<
            InvocationOutcome<ChatAbortResult, OpenClawSessionError>,
            RuntimeSessionError<OpenClawSessionError>,
        >,
    > {
        Box::pin(async { Err(RuntimeSessionError::RuntimeUnavailable) })
    }

    fn select_session_model<'a>(
        &'a self,
        command: ResolvedSessionModelSelection,
    ) -> SessionFuture<'a, SessionModelSelectionOutcome>;

    fn session_permission<'a>(
        &'a self,
        _command: SessionPermissionCommand,
    ) -> SessionFuture<'a, SessionPermissionOutcome> {
        Box::pin(async { SessionPermissionOutcome::unsupported() })
    }
}

pub(crate) trait TaskOps: Send + Sync {
    fn task_manager<'a>(
        &'a self,
        command: TaskManagerCommand,
    ) -> SessionFuture<'a, TaskManagerOutcome>;
}
pub(crate) trait SubagentOps: Send + Sync {
    fn agents<'a>(
        &'a self,
        command: crate::agents::Command,
    ) -> SessionFuture<'a, crate::agents::Outcome>;
}
pub(crate) trait TeamOps: Send + Sync {
    fn materialize_team(
        &self,
        request: TeamMaterializationRequest,
    ) -> OwnedRuntimeFuture<MaterializationOperationOutcome>;

    fn remove_team(
        &self,
        removal: TeamMaterializationRemoval,
    ) -> OwnedRuntimeFuture<MaterializationOperationOutcome>;

    fn recover_team_materialization(
        &self,
        request: TeamMaterializationRequest,
    ) -> OwnedRuntimeFuture<MaterializationOperationOutcome>;

    fn confirm_team_run_receipt(
        &self,
        receipt: RunRuntimeReceipt,
    ) -> OwnedRuntimeFuture<crate::organization::RuntimeReceiptOutcome>;

    fn execute_activity(
        &self,
        request: ActivityExecutionRequest,
    ) -> OwnedRuntimeFuture<ActivityExecutionOutcome> {
        let binding = request.binding().clone();
        match request.into_prompt_delivery() {
            Ok(delivery) => {
                let delivery = self.deliver_prompt(delivery);
                Box::pin(async move { activity_delivery_outcome(&binding, delivery.await) })
            }
            Err(_) => Box::pin(async {
                ActivityExecutionOutcome::Rejected {
                    rejection: organization::DeliveryRejection::Permanent,
                }
            }),
        }
    }

    fn deliver_prompt(
        &self,
        request: organization::PromptDeliveryRequest,
    ) -> OwnedRuntimeFuture<organization::PromptDeliveryOutcome>;

    fn abort_role_sessions(
        &self,
        bindings: Vec<organization::RoleSessionReceipt>,
    ) -> OwnedRuntimeFuture<RoleAbortOutcome>;

    fn delete_role_sessions(
        &self,
        run_id: organization::GraphRunId,
        bindings: Vec<organization::RoleSessionReceipt>,
        abort_first: bool,
    ) -> OwnedRuntimeFuture<NativeDeletionEvidence>;
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct NativeRunSettled {
    pub(crate) status: organization::NativeTerminalStatus,
    pub(crate) final_assistant_text: Option<String>,
}

pub(crate) trait TeamTerminalOps: Send + Sync {
    fn watch_terminal(
        &self,
        target: organization::NativeTerminalReceiptTarget,
    ) -> OwnedRuntimeFuture<Option<NativeRunSettled>>;
}
pub(crate) trait CronOps: Send + Sync {
    fn list_cron_jobs<'a>(&'a self) -> SessionFuture<'a, CronListOutcome>;

    fn cron_run_history<'a>(
        &'a self,
        job_id: String,
        limit: u64,
    ) -> SessionFuture<'a, Result<Vec<CronRunHistoryReceipt>, CronRunHistoryFailure>>;

    fn admit_cron_execution<'a>(
        &'a self,
        job_id: String,
    ) -> SessionFuture<'a, Result<Result<CronExecutionAdmission, CronTriggerResult>, ()>>;

    fn add_cron_job<'a>(
        &'a self,
        command: CronCreateCommand,
    ) -> SessionFuture<'a, CronJobMutationOutcome>;

    fn update_cron_job<'a>(
        &'a self,
        command: CronUpdateCommand,
    ) -> SessionFuture<'a, CronJobMutationOutcome>;

    fn delete_cron_job<'a>(
        &'a self,
        command: CronDeleteCommand,
    ) -> SessionFuture<'a, CronDeleteOutcome>;
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WorkspaceDirectoryRoot {
    path: String,
}

impl WorkspaceDirectoryRoot {
    pub(crate) fn new(path: String) -> Self {
        Self { path }
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.path
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WorkspaceTextReceipt {
    name: String,
    content: String,
    size: u64,
}

impl WorkspaceTextReceipt {
    pub(crate) fn new(name: String, content: String, size: u64) -> Self {
        Self {
            name,
            content,
            size,
        }
    }

    pub(crate) fn name(&self) -> &str {
        &self.name
    }

    pub(crate) fn content(&self) -> &str {
        &self.content
    }

    pub(crate) const fn size(&self) -> u64 {
        self.size
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WorkspaceWriteReceipt {
    name: String,
    size: u64,
}

impl WorkspaceWriteReceipt {
    pub(crate) fn new(name: String, size: u64) -> Self {
        Self { name, size }
    }

    pub(crate) fn name(&self) -> &str {
        &self.name
    }

    pub(crate) const fn size(&self) -> u64 {
        self.size
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WorkspaceBinaryReceipt {
    name: String,
    content: Vec<u8>,
    size: u64,
}

impl WorkspaceBinaryReceipt {
    pub(crate) fn new(name: String, content: Vec<u8>, size: u64) -> Self {
        Self {
            name,
            content,
            size,
        }
    }

    pub(crate) fn name(&self) -> &str {
        &self.name
    }

    pub(crate) fn content(&self) -> &[u8] {
        &self.content
    }

    pub(crate) const fn size(&self) -> u64 {
        self.size
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WorkspaceStatReceipt {
    name: String,
    is_directory: bool,
    size: u64,
    mtime_ms: u64,
}

impl WorkspaceStatReceipt {
    pub(crate) fn new(name: String, is_directory: bool, size: u64, mtime_ms: u64) -> Self {
        Self {
            name,
            is_directory,
            size,
            mtime_ms,
        }
    }

    pub(crate) fn name(&self) -> &str {
        &self.name
    }

    pub(crate) const fn is_directory(&self) -> bool {
        self.is_directory
    }

    pub(crate) const fn size(&self) -> u64 {
        self.size
    }

    pub(crate) const fn mtime_ms(&self) -> u64 {
        self.mtime_ms
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WorkspaceDirectoryReceipt {
    entries: Vec<WorkspaceDirectoryEntry>,
}

impl WorkspaceDirectoryReceipt {
    pub(crate) fn new(entries: Vec<WorkspaceDirectoryEntry>) -> Self {
        Self { entries }
    }

    pub(crate) fn entries(&self) -> &[WorkspaceDirectoryEntry] {
        &self.entries
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WorkspaceDirectoryEntry {
    relative_path: String,
    display: String,
    is_directory: bool,
    size: u64,
}

impl WorkspaceDirectoryEntry {
    pub(crate) fn new(
        relative_path: String,
        display: String,
        is_directory: bool,
        size: u64,
    ) -> Self {
        Self {
            relative_path,
            display,
            is_directory,
            size,
        }
    }

    pub(crate) fn relative_path(&self) -> &str {
        &self.relative_path
    }

    pub(crate) fn display(&self) -> &str {
        &self.display
    }

    pub(crate) const fn is_directory(&self) -> bool {
        self.is_directory
    }

    pub(crate) const fn size(&self) -> u64 {
        self.size
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum WorkspaceMediaPath {
    Relative {
        key: String,
        relative_path: String,
        mime_type: String,
    },
    Gateway {
        key: String,
        gateway_url: String,
        mime_type: String,
        agent_id: String,
    },
}

impl WorkspaceMediaPath {
    pub(crate) fn relative(key: String, relative_path: String, mime_type: String) -> Self {
        Self::Relative {
            key,
            relative_path,
            mime_type,
        }
    }

    pub(crate) fn gateway(
        key: String,
        gateway_url: String,
        mime_type: String,
        agent_id: String,
    ) -> Self {
        Self::Gateway {
            key,
            gateway_url,
            mime_type,
            agent_id,
        }
    }

    pub(crate) fn key(&self) -> &str {
        match self {
            Self::Relative { key, .. } | Self::Gateway { key, .. } => key,
        }
    }

    pub(crate) fn relative_path(&self) -> &str {
        match self {
            Self::Relative { relative_path, .. } => relative_path,
            Self::Gateway { .. } => "",
        }
    }

    pub(crate) fn gateway_url(&self) -> &str {
        match self {
            Self::Relative { .. } => "",
            Self::Gateway { gateway_url, .. } => gateway_url,
        }
    }

    pub(crate) fn mime_type(&self) -> &str {
        match self {
            Self::Relative { mime_type, .. } | Self::Gateway { mime_type, .. } => mime_type,
        }
    }

    pub(crate) fn agent_id(&self) -> &str {
        match self {
            Self::Relative { .. } => "",
            Self::Gateway { agent_id, .. } => agent_id,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WorkspaceMediaReceipt {
    reference: String,
    name: String,
    mime_type: String,
    size: u64,
    preview: Option<String>,
}

impl WorkspaceMediaReceipt {
    pub(crate) fn new(
        reference: String,
        name: String,
        mime_type: String,
        size: u64,
        preview: Option<String>,
    ) -> Self {
        Self {
            reference,
            name,
            mime_type,
            size,
            preview,
        }
    }

    pub(crate) fn reference(&self) -> &str {
        &self.reference
    }

    pub(crate) fn name(&self) -> &str {
        &self.name
    }

    pub(crate) fn mime_type(&self) -> &str {
        &self.mime_type
    }

    pub(crate) const fn size(&self) -> u64 {
        self.size
    }

    pub(crate) fn preview(&self) -> Option<&str> {
        self.preview.as_deref()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ResolvedWorkspaceMedia {
    content: Vec<u8>,
}

impl ResolvedWorkspaceMedia {
    pub(crate) fn new(content: Vec<u8>) -> Self {
        Self { content }
    }

    pub(crate) fn content(&self) -> &[u8] {
        &self.content
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WorkspaceMediaThumbnail {
    preview: Option<String>,
    file_size: u64,
}

impl WorkspaceMediaThumbnail {
    pub(crate) fn new(preview: Option<String>, file_size: u64) -> Self {
        Self { preview, file_size }
    }

    pub(crate) fn preview(&self) -> Option<&str> {
        self.preview.as_deref()
    }

    pub(crate) const fn file_size(&self) -> u64 {
        self.file_size
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WorkspaceMediaThumbnailEntry {
    key: String,
    thumbnail: WorkspaceMediaThumbnail,
}

impl WorkspaceMediaThumbnailEntry {
    pub(crate) fn new(key: String, thumbnail: WorkspaceMediaThumbnail) -> Self {
        Self { key, thumbnail }
    }

    pub(crate) fn key(&self) -> &str {
        &self.key
    }

    pub(crate) fn thumbnail(&self) -> &WorkspaceMediaThumbnail {
        &self.thumbnail
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum WorkspaceDirectoryFailure {
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum WorkspaceReadFailure {
    InvalidPath,
    Unavailable,
    NotFile,
    TooLarge,
    Binary,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum WorkspaceBinaryFailure {
    InvalidPath,
    Unavailable,
    NotFile,
    TooLarge,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum WorkspaceStatFailure {
    InvalidPath,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum WorkspaceListFailure {
    InvalidPath,
    Unavailable,
    NotDirectory,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum WorkspaceWriteFailure {
    InvalidPath,
    Unavailable,
    NotFile,
    TooLarge,
    OutcomeUnknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum WorkspaceMediaFailure {
    InvalidPath,
    InvalidReference,
    Unavailable,
    NotFile,
    TooLarge,
}

pub(crate) trait WorkspaceOps: Send + Sync {
    fn trusted_workspace_directory(
        &self,
        session_key: &str,
    ) -> Result<WorkspaceDirectoryRoot, WorkspaceDirectoryFailure>;

    fn read_text(
        &self,
        session_key: &str,
        relative_path: &str,
        limit: usize,
    ) -> Result<WorkspaceTextReceipt, WorkspaceReadFailure>;

    fn read_binary(
        &self,
        session_key: &str,
        relative_path: &str,
        limit: usize,
    ) -> Result<WorkspaceBinaryReceipt, WorkspaceBinaryFailure>;

    fn stat_file(
        &self,
        session_key: &str,
        relative_path: &str,
    ) -> Result<WorkspaceStatReceipt, WorkspaceStatFailure>;

    fn list_directory(
        &self,
        session_key: &str,
        relative_path: &str,
        include_hidden: bool,
    ) -> Result<WorkspaceDirectoryReceipt, WorkspaceListFailure>;

    fn write_text(
        &self,
        session_key: &str,
        relative_path: &str,
        content: &str,
    ) -> Result<WorkspaceWriteReceipt, WorkspaceWriteFailure>;

    fn prepare_media(
        &self,
        session_key: &str,
        relative_path: &str,
        mime_type: &str,
    ) -> Result<WorkspaceMediaReceipt, WorkspaceMediaFailure>;

    fn resolve_media(
        &self,
        session_key: &str,
        reference: &str,
    ) -> Result<ResolvedWorkspaceMedia, WorkspaceMediaFailure>;

    fn thumbnail_media(
        &self,
        session_key: &str,
        relative_path: &str,
        mime_type: &str,
    ) -> Result<WorkspaceMediaThumbnail, WorkspaceMediaFailure>;

    fn thumbnail_media_gateway(
        &self,
        session_key: &str,
        gateway_url: &str,
        mime_type: &str,
        agent_id: &str,
    ) -> Result<WorkspaceMediaThumbnail, WorkspaceMediaFailure>;

    fn thumbnails_media(
        &self,
        session_key: &str,
        paths: &[WorkspaceMediaPath],
    ) -> Result<Vec<WorkspaceMediaThumbnailEntry>, WorkspaceMediaFailure>;

    fn stage_paths_media(
        &self,
        session_key: &str,
        paths: &[WorkspaceMediaPath],
    ) -> Result<Vec<WorkspaceMediaReceipt>, WorkspaceMediaFailure>;

    fn stage_buffer_media(
        &self,
        session_key: &str,
        base64: &str,
        file_name: &str,
        mime_type: &str,
    ) -> Result<WorkspaceMediaReceipt, WorkspaceMediaFailure>;
}
pub(crate) trait SkillOps: Send + Sync {
    fn installed_skill_catalog(
        &self,
    ) -> OwnedRuntimeFuture<Option<openclaw::skill::InstalledSkillCatalog>>;

    fn install_clawhub_skill<'a>(
        &'a self,
        command: SkillInstallCommand,
    ) -> SessionFuture<'a, SkillInstallOutcome>;

    fn skill_status<'a>(&'a self) -> SessionFuture<'a, crate::skills::status::Outcome>;

    fn manage_skills<'a>(
        &'a self,
        command: SkillManagementCommand,
    ) -> SessionFuture<'a, SkillManagementOutcome>;

    fn skill_bundles<'a>(
        &'a self,
        command: crate::skills::bundle::Command,
    ) -> SessionFuture<'a, crate::skills::bundle::Outcome>;
}
pub(crate) trait ChannelOps: Send + Sync {
    fn control_channel_account<'a>(
        &'a self,
        action: ChannelControlAction,
        channel: String,
        account: String,
    ) -> SessionFuture<'a, ChannelControlOutcome>;

    fn start_channel_login<'a>(
        &'a self,
        channel: String,
        force: bool,
        timeout_ms: Option<u64>,
        account_id: Option<String>,
    ) -> SessionFuture<'a, ChannelLoginOutcome>;

    fn wait_channel_login_owned(
        &self,
        channel: String,
        timeout_ms: Option<u64>,
        account_id: Option<String>,
        session_key: Option<String>,
        current_qr_data_url: Option<String>,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> OwnedRuntimeFuture<ChannelLoginOutcome>;

    fn stop_channel_login<'a>(
        &'a self,
        channel: String,
        account_id: Option<String>,
    ) -> SessionFuture<'a, ChannelLoginOutcome>;

    fn logout_channel<'a>(
        &'a self,
        channel: String,
        account_id: Option<String>,
    ) -> SessionFuture<'a, ChannelLoginOutcome>;

    fn list_channel_pairing<'a>(
        &'a self,
        channel: String,
        account: Option<String>,
    ) -> SessionFuture<'a, ChannelPairingOutcome>;

    fn approve_channel_pairing<'a>(
        &'a self,
        channel: String,
        account: Option<String>,
        code: zeroize::Zeroizing<Vec<u8>>,
    ) -> SessionFuture<'a, ChannelPairingApprovalOutcome>;

    fn status<'a>(
        &'a self,
    ) -> SessionFuture<'a, Result<ChannelStatusOutcome, ChannelStatusFailure>> {
        Box::pin(async { Err(ChannelStatusFailure::Unavailable) })
    }

    fn snapshot<'a>(
        &'a self,
    ) -> SessionFuture<'a, Result<ChannelSnapshotOutcome, ChannelStatusFailure>> {
        Box::pin(async { Err(ChannelStatusFailure::Unavailable) })
    }

    fn observe_channel_accounts<'a>(
        &'a self,
    ) -> SessionFuture<'a, Result<ChannelStatusOutcome, ChannelStatusFailure>> {
        self.status()
    }

    fn observe_channel_snapshot<'a>(
        &'a self,
    ) -> SessionFuture<'a, Result<ChannelSnapshotOutcome, ChannelStatusFailure>> {
        self.snapshot()
    }

    fn config_read<'a>(
        &'a self,
        _channel: String,
        _account_id: Option<String>,
    ) -> SessionFuture<'a, channel_config_read::Outcome> {
        Box::pin(async { channel_config_read::Outcome::Unknown })
    }

    fn read_channel_config<'a>(
        &'a self,
        channel: String,
        account_id: Option<String>,
    ) -> SessionFuture<'a, channel_config_read::Outcome> {
        self.config_read(channel, account_id)
    }

    fn validate_credentials<'a>(
        &'a self,
        _channel: String,
        _config: zeroize::Zeroizing<Vec<u8>>,
    ) -> SessionFuture<'a, channel_credentials::Outcome> {
        Box::pin(async { channel_credentials::Outcome::Unknown })
    }

    fn validate_channel_credentials<'a>(
        &'a self,
        channel: String,
        config: zeroize::Zeroizing<Vec<u8>>,
    ) -> SessionFuture<'a, channel_credentials::Outcome> {
        self.validate_credentials(channel, config)
    }

    fn catalog<'a>(&'a self) -> SessionFuture<'a, ChannelCatalogOutcome> {
        Box::pin(async { ChannelCatalogOutcome::Unknown })
    }

    fn channel_catalog<'a>(&'a self) -> SessionFuture<'a, ChannelCatalogOutcome> {
        self.catalog()
    }

    fn configure_form<'a>(
        &'a self,
        _channel: String,
    ) -> SessionFuture<'a, ChannelConfigureFormOutcome> {
        Box::pin(async { ChannelConfigureFormOutcome::Unknown })
    }

    fn channel_configure_form<'a>(
        &'a self,
        channel: String,
    ) -> SessionFuture<'a, ChannelConfigureFormOutcome> {
        self.configure_form(channel)
    }

    fn configure<'a>(
        &'a self,
        _channel: String,
        _account_id: String,
        _agent_id: Option<String>,
        _values: zeroize::Zeroizing<Vec<u8>>,
    ) -> SessionFuture<'a, ChannelConfigureOutcome> {
        Box::pin(async { ChannelConfigureOutcome::Unknown })
    }

    fn channel_configure<'a>(
        &'a self,
        channel: String,
        account_id: String,
        agent_id: Option<String>,
        values: zeroize::Zeroizing<Vec<u8>>,
    ) -> SessionFuture<'a, ChannelConfigureOutcome> {
        self.configure(channel, account_id, agent_id, values)
    }

    fn delete_config<'a>(
        &'a self,
        _channel: String,
        _account_id: Option<String>,
    ) -> SessionFuture<'a, channel_delete::Outcome> {
        Box::pin(async { channel_delete::Outcome::Unknown })
    }

    fn finalize_channel_login<'a>(
        &'a self,
        _channel: String,
        _account_id: String,
        _agent_id: Option<String>,
        _values: zeroize::Zeroizing<Vec<u8>>,
    ) -> SessionFuture<'a, ChannelConfigureOutcome> {
        Box::pin(async { ChannelConfigureOutcome::Unknown })
    }

    fn channel_delete_config<'a>(
        &'a self,
        channel: String,
        account_id: Option<String>,
    ) -> SessionFuture<'a, channel_delete::Outcome> {
        self.delete_config(channel, account_id)
    }
}
pub(crate) trait ProviderConfigOps {
    fn reconcile_provider_native_configuration<'a>(
        &'a self,
        command: ProviderNativeConfigurationCommand<'a>,
    ) -> SessionFuture<'a, ProviderNativeConfigurationEffect>;
}

pub(crate) trait ConnectorOps: Send + Sync {
    fn apply_runtime_mcp_projection<'a>(
        &'a self,
        preset: Option<openclaw::projection::connector::preset::PresetMcpProjection<'a>>,
        catalog: environment::connectors::ConnectorCatalog,
        secrets: &'a dyn environment::ConnectorSecretResolverPort,
    ) -> SessionFuture<'a, openclaw::projection::connector::external::ConnectorProjectionEffect>;

    fn probe_external_connector<'a>(
        &'a self,
        connector: environment::connectors::Connector,
    ) -> SessionFuture<'a, openclaw::projection::connector::external::ConnectorObservation>;

    fn list_mcp_servers<'a>(
        &'a self,
    ) -> SessionFuture<
        'a,
        Result<
            Vec<openclaw::projection::connector::config::OpenClawMcpServerConfig>,
            RuntimeOperationFailure,
        >,
    >;

    fn observe_mcp_server_status<'a>(
        &'a self,
        session_key: String,
    ) -> SessionFuture<
        'a,
        Result<openclaw::gateway::wire::McpServerStatusList, RuntimeOperationFailure>,
    >;

    fn set_mcp_session_server_enabled<'a>(
        &'a self,
        session_key: String,
        server_name: String,
        enabled: bool,
    ) -> SessionFuture<'a, Result<(), RuntimeOperationFailure>>;
}

pub(crate) trait SecurityOps {
    fn apply_security_policy_projection<'a>(
        &'a self,
        policy: serde_json::Value,
    ) -> SessionFuture<'a, Result<(), RuntimeOperationFailure>>;

    fn sync_security_policy<'a>(
        &'a self,
        policy: serde_json::Value,
    ) -> SessionFuture<'a, openclaw::operations::SecurityPolicyEffect>;

    fn run_security_emergency<'a>(
        &'a self,
    ) -> SessionFuture<'a, openclaw::operations::SecurityEmergencyEffect>;

    fn query_security_audit<'a>(
        &'a self,
        query: openclaw::operations::security_audit::SecurityAuditQuery,
    ) -> SessionFuture<'a, openclaw::operations::security_audit::SecurityAuditEffect>;

    fn security_operation<'a>(
        &'a self,
        operation_id: String,
        input: serde_json::Value,
    ) -> SessionFuture<'a, openclaw::operations::SecurityActionEffect>;
}

pub(crate) trait SettingsOps: Send + Sync {
    fn apply_settings_projection(
        &self,
        browser_mode: openclaw::projection::settings::BrowserMode,
        proxy_endpoint: Option<String>,
    ) -> OwnedRuntimeFuture<Result<SettingsProjectionEffect, RuntimeOperationFailure>>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SettingsProjectionEffect {
    Changed,
    Unchanged,
}

pub(crate) struct ProviderNativeConfigurationCommand<'a> {
    pub(crate) accounts: &'a [environment::ProviderAccount],
    pub(crate) models: &'a environment::ProviderModelCatalog,
    pub(crate) routing: Option<&'a environment::ProviderRouting>,
    pub(crate) retired: &'a [environment::ProviderAccount],
    pub(crate) required_auth_accounts:
        &'a std::collections::BTreeSet<environment::ProviderAccountId>,
    pub(crate) auth_state_refresh_required: bool,
    pub(crate) now_millis: u64,
}

pub(crate) trait LifecycleOps: Send + Sync {
    fn snapshot(&self) -> SupervisorSnapshot;

    fn subscribe(&self) -> watch::Receiver<SupervisorSnapshot>;

    fn readiness(&self) -> bool {
        self.snapshot().phase() == foundation::process::supervision::SupervisorPhase::Running
    }

    fn start(&self) -> OwnedRuntimeFuture<Result<StartOutcome, RuntimeStartFailure>>;

    fn stop(&self) -> OwnedRuntimeFuture<Result<TerminationCompletion, RuntimeLifecycleFailure>>;

    fn restart(&self) -> OwnedRuntimeFuture<Result<RestartOutcome, RuntimeLifecycleFailure>>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RuntimeStartFailure {
    CompletionFailed,
    SupervisorStopped,
    Busy,
    Rejected(SupervisorRejection),
    ShuttingDown,
    Unsupported,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RuntimeLifecycleFailure {
    CompletionFailed,
    SupervisorStopped,
    AlreadySatisfied,
    Busy,
    Rejected(SupervisorRejection),
    ShuttingDown,
    Unsupported,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct RuntimeDriverIdentity {
    protocol_id: &'static str,
    runtime_adapter_id: &'static str,
    runtime_instance_id: &'static str,
    runtime_endpoint_reference: &'static str,
    default_agent_id: &'static str,
    display_name: &'static str,
}

impl RuntimeDriverIdentity {
    pub(crate) const fn open_claw() -> Self {
        Self {
            protocol_id: OPENCLAW_PROTOCOL_ID,
            runtime_adapter_id: OPENCLAW_RUNTIME_ADAPTER_ID,
            runtime_instance_id: LOCAL_RUNTIME_INSTANCE_ID,
            runtime_endpoint_reference: "endpoint:openclaw",
            default_agent_id: OPENCLAW_AGENT_ID,
            display_name: "OpenClaw",
        }
    }

    pub(crate) const fn matcha_agent() -> Self {
        Self {
            protocol_id: MATCHA_PROTOCOL_ID,
            runtime_adapter_id: MATCHA_RUNTIME_ADAPTER_ID,
            runtime_instance_id: LOCAL_RUNTIME_INSTANCE_ID,
            runtime_endpoint_reference: "endpoint:matcha",
            default_agent_id: MATCHA_AGENT_ID,
            display_name: "Matcha Agent",
        }
    }

    pub(crate) fn endpoint(self) -> RuntimeEndpoint {
        RuntimeEndpoint::try_new(self.runtime_adapter_id, self.runtime_instance_id)
            .expect("fixed runtime endpoint identity is valid")
    }

    pub(crate) fn endpoint_id(self) -> String {
        format!("{}-{}", self.runtime_adapter_id, self.runtime_instance_id)
    }

    pub(crate) const fn protocol_id(self) -> &'static str {
        self.protocol_id
    }

    pub(crate) const fn runtime_adapter_id(self) -> &'static str {
        self.runtime_adapter_id
    }

    pub(crate) const fn runtime_instance_id(self) -> &'static str {
        self.runtime_instance_id
    }

    pub(crate) const fn runtime_endpoint_reference(self) -> &'static str {
        self.runtime_endpoint_reference
    }

    pub(crate) const fn default_agent_id(self) -> &'static str {
        self.default_agent_id
    }

    pub(crate) const fn display_name(self) -> &'static str {
        self.display_name
    }

    pub(crate) fn capability_surface(self) -> RuntimeCapabilitySurface {
        if self == Self::open_claw() {
            RuntimeCapabilitySurface::open_claw()
        } else {
            RuntimeCapabilitySurface::matcha_agent()
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct RuntimeCapabilitySurface {
    session: RuntimeFamilyAvailability,
    task: RuntimeFamilyAvailability,
    subagent: RuntimeFamilyAvailability,
    team: RuntimeFamilyAvailability,
    cron: RuntimeFamilyAvailability,
    workspace: RuntimeFamilyAvailability,
    skill: RuntimeFamilyAvailability,
    channel: RuntimeFamilyAvailability,
    lifecycle: RuntimeFamilyAvailability,
}

impl RuntimeCapabilitySurface {
    pub(crate) const fn open_claw() -> Self {
        Self {
            session: RuntimeFamilyAvailability::Supported,
            task: RuntimeFamilyAvailability::Supported,
            subagent: RuntimeFamilyAvailability::Supported,
            team: RuntimeFamilyAvailability::Supported,
            cron: RuntimeFamilyAvailability::Supported,
            workspace: RuntimeFamilyAvailability::Supported,
            skill: RuntimeFamilyAvailability::Supported,
            channel: RuntimeFamilyAvailability::Supported,
            lifecycle: RuntimeFamilyAvailability::Supported,
        }
    }

    pub(crate) const fn matcha_agent() -> Self {
        Self {
            session: RuntimeFamilyAvailability::Supported,
            task: RuntimeFamilyAvailability::Unsupported,
            subagent: RuntimeFamilyAvailability::Unsupported,
            team: RuntimeFamilyAvailability::Supported,
            cron: RuntimeFamilyAvailability::Unsupported,
            workspace: RuntimeFamilyAvailability::Unsupported,
            skill: RuntimeFamilyAvailability::Unsupported,
            channel: RuntimeFamilyAvailability::Unsupported,
            lifecycle: RuntimeFamilyAvailability::Supported,
        }
    }

    pub(crate) const fn availability(
        self,
        family: RuntimeCapabilityFamily,
    ) -> RuntimeFamilyAvailability {
        match family {
            RuntimeCapabilityFamily::Session => self.session,
            RuntimeCapabilityFamily::Task => self.task,
            RuntimeCapabilityFamily::Subagent => self.subagent,
            RuntimeCapabilityFamily::Team => self.team,
            RuntimeCapabilityFamily::Cron => self.cron,
            RuntimeCapabilityFamily::Workspace => self.workspace,
            RuntimeCapabilityFamily::Skill => self.skill,
            RuntimeCapabilityFamily::Channel => self.channel,
            RuntimeCapabilityFamily::Lifecycle => self.lifecycle,
        }
    }

    pub(crate) const fn supports(self, family: RuntimeCapabilityFamily) -> bool {
        self.availability(family).is_supported()
    }

    pub(crate) fn availability_for_descriptor(
        self,
        descriptor_id: &str,
    ) -> Option<RuntimeFamilyAvailability> {
        RuntimeCapabilityFamily::for_descriptor(descriptor_id)
            .map(|family| self.availability(family))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RuntimeCapabilityFamily {
    Session,
    Task,
    Subagent,
    Team,
    Cron,
    Workspace,
    Skill,
    Channel,
    Lifecycle,
}

impl RuntimeCapabilityFamily {
    pub(crate) fn for_descriptor(descriptor_id: &str) -> Option<Self> {
        match descriptor_id {
            "session.prompt"
            | "session.management"
            | "session.approval"
            | "session.modelSelection"
            | "tool.invoke" => Some(Self::Session),
            "task.management" => Some(Self::Task),
            "subagent.management" | "subagent.skills" | "subagent.tools" => Some(Self::Subagent),
            "team.runtime" => Some(Self::Team),
            "scheduler.cron" => Some(Self::Cron),
            "workspace.file" | "workspace.media" => Some(Self::Workspace),
            "skill.management" => Some(Self::Skill),
            "integration.channel" => Some(Self::Channel),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RuntimeFamilyAvailability {
    Supported,
    Unsupported,
}

impl RuntimeFamilyAvailability {
    pub(crate) const fn is_supported(self) -> bool {
        matches!(self, Self::Supported)
    }

    pub(crate) const fn availability_label(self, ready: bool) -> &'static str {
        match (self, ready) {
            (Self::Supported, true) => "available",
            (Self::Supported, false) => "unavailable",
            (Self::Unsupported, _) => "unsupported",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RuntimeOperationFailure {
    Unsupported,
    Unavailable,
    TargetRejected,
    Unknown,
}
