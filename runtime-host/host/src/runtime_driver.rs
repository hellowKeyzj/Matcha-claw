use std::{future::Future, pin::Pin};

use foundation::process::supervision::SupervisorSnapshot;
use platform::{endpoint::runtime_address::RuntimeEndpoint, exchange::InvocationOutcome};

use crate::{
    RuntimeSessionError,
    channel_catalog::{
        ChannelCatalogOutcome, ChannelConfigureFormOutcome, ChannelConfigureOutcome,
    },
    channel_config_read,
    channel_control::{ChannelControlAction, ChannelControlOutcome},
    channel_credentials, channel_delete,
    channel_login::Outcome as ChannelLoginOutcome,
    channel_status::{
        ChannelPairingApprovalOutcome, ChannelPairingOutcome, ChannelSnapshotOutcome,
        ChannelStatusFailure, ChannelStatusOutcome,
    },
    cron::{
        CronCreateCommand, CronDeleteCommand, CronDeleteOutcome, CronJobMutationOutcome,
        CronListOutcome, CronUpdateCommand,
    },
    session_abort::{SessionAbortCommand, SessionAbortOutcome},
    session_approval::{
        PendingApprovalsCommand, PendingApprovalsOutcome, SessionApprovalCommand,
        SessionApprovalOutcome,
    },
    session_create::{SessionCreateCommand, SessionCreateOutcome},
    session_delete::{SessionDeleteCommand, SessionDeleteOutcome},
    session_model_selection::{ResolvedSessionModelSelection, SessionModelSelectionOutcome},
    session_rename::{SessionRenameCommand, SessionRenameOutcome},
    session_send::{SessionSendCommand, SessionSendOutcome},
    skill_bundle,
    skill_install::{Command as SkillInstallCommand, Outcome as SkillInstallOutcome},
    skill_management::{Command as SkillManagementCommand, Outcome as SkillManagementOutcome},
    task_manager::{Command as TaskManagerCommand, Outcome as TaskManagerOutcome},
};

use openclaw::{
    port::{OpenClawSessionError, ProviderNativeConfigurationEffect},
    session::protocol::{
        ChatAbortParams, ChatAbortResult, ChatHistoryParams, ChatHistoryResult, ChatSendParams,
        ChatSendResult, SessionsListParams, SessionsListResult,
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

pub(crate) trait RuntimeDriver {
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
}

pub(crate) type SessionFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
pub(crate) type OwnedRuntimeFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

pub(crate) trait SessionOps {
    fn abort_session<'a>(
        &'a self,
        command: SessionAbortCommand,
    ) -> SessionFuture<'a, SessionAbortOutcome>;

    fn create_session<'a>(
        &'a self,
        command: SessionCreateCommand,
        epoch: u64,
    ) -> SessionFuture<'a, SessionCreateOutcome>;

    fn list_sessions<'a>(
        &'a self,
        _params: SessionsListParams,
    ) -> SessionFuture<'a, Result<SessionsListResult, RuntimeSessionError<OpenClawSessionError>>>
    {
        Box::pin(async { Err(RuntimeSessionError::RuntimeUnavailable) })
    }

    fn history<'a>(
        &'a self,
        _params: ChatHistoryParams,
    ) -> SessionFuture<'a, Result<ChatHistoryResult, RuntimeSessionError<OpenClawSessionError>>>
    {
        Box::pin(async { Err(RuntimeSessionError::RuntimeUnavailable) })
    }

    fn history_window<'a>(
        &'a self,
        _params: ChatHistoryParams,
        _request: openclaw::session_window::PageRequest,
    ) -> SessionFuture<
        'a,
        Result<openclaw::session_window::SessionWindow, RuntimeSessionError<OpenClawSessionError>>,
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
}

pub(crate) trait TaskOps {
    fn task_manager<'a>(
        &'a self,
        command: TaskManagerCommand,
    ) -> SessionFuture<'a, TaskManagerOutcome>;
}
pub(crate) trait SubagentOps {
    fn agents<'a>(
        &'a self,
        command: crate::agents::Command,
    ) -> SessionFuture<'a, crate::agents::Outcome>;
}
pub(crate) trait TeamOps {
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
    ) -> OwnedRuntimeFuture<crate::composition::RuntimeReceiptOutcome>;

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
pub(crate) trait CronOps {
    fn list_cron_jobs<'a>(&'a self) -> SessionFuture<'a, CronListOutcome>;

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
    >;

    fn admit_cron_execution<'a>(
        &'a self,
        job_id: String,
    ) -> SessionFuture<
        'a,
        Result<
            Result<openclaw::port::CronExecutionAdmission, openclaw::port::CronTriggerOutcome>,
            openclaw::gateway::client::GatewayClientError,
        >,
    >;

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
pub(crate) trait WorkspaceOps {
    fn trusted_workspace_directory(
        &self,
        session_key: &str,
    ) -> Result<
        openclaw::workspace::TrustedWorkspaceDirectory,
        openclaw::workspace::WorkspaceDirectoryFailure,
    >;

    fn read_text(
        &self,
        session_key: &str,
        relative_path: &str,
        limit: usize,
    ) -> Result<openclaw::workspace::WorkspaceTextReceipt, openclaw::workspace::WorkspaceReadFailure>;

    fn read_binary(
        &self,
        session_key: &str,
        relative_path: &str,
        limit: usize,
    ) -> Result<
        openclaw::workspace::WorkspaceBinaryReceipt,
        openclaw::workspace::WorkspaceBinaryFailure,
    >;

    fn stat_file(
        &self,
        session_key: &str,
        relative_path: &str,
    ) -> Result<openclaw::workspace::WorkspaceStatReceipt, openclaw::workspace::WorkspaceStatFailure>;

    fn list_directory(
        &self,
        session_key: &str,
        relative_path: &str,
        include_hidden: bool,
    ) -> Result<
        openclaw::workspace::WorkspaceDirectoryReceipt,
        openclaw::workspace::WorkspaceListFailure,
    >;

    fn write_text(
        &self,
        session_key: &str,
        relative_path: &str,
        content: &str,
    ) -> Result<openclaw::workspace::WorkspaceTextReceipt, openclaw::workspace::WorkspaceWriteFailure>;

    fn prepare_media(
        &self,
        session_key: &str,
        relative_path: &str,
        mime_type: &str,
    ) -> Result<
        openclaw::workspace::media::WorkspaceMediaReceipt,
        openclaw::workspace::media::WorkspaceMediaFailure,
    >;

    fn resolve_media(
        &self,
        session_key: &str,
        reference: &str,
    ) -> Result<
        openclaw::workspace::media::ResolvedWorkspaceMedia,
        openclaw::workspace::media::WorkspaceMediaFailure,
    >;

    fn thumbnail_media(
        &self,
        session_key: &str,
        relative_path: &str,
        mime_type: &str,
    ) -> Result<
        openclaw::workspace::media::WorkspaceMediaThumbnail,
        openclaw::workspace::media::WorkspaceMediaFailure,
    >;

    fn thumbnail_media_gateway(
        &self,
        session_key: &str,
        gateway_url: &str,
        mime_type: &str,
        agent_id: &str,
    ) -> Result<
        openclaw::workspace::media::WorkspaceMediaThumbnail,
        openclaw::workspace::media::WorkspaceMediaFailure,
    >;

    fn thumbnails_media(
        &self,
        session_key: &str,
        paths: &[openclaw::workspace::media::WorkspaceMediaPath],
    ) -> Result<
        Vec<openclaw::workspace::media::WorkspaceMediaThumbnailEntry>,
        openclaw::workspace::media::WorkspaceMediaFailure,
    >;

    fn stage_paths_media(
        &self,
        session_key: &str,
        paths: &[openclaw::workspace::media::WorkspaceMediaPath],
    ) -> Result<
        Vec<openclaw::workspace::media::WorkspaceMediaReceipt>,
        openclaw::workspace::media::WorkspaceMediaFailure,
    >;

    fn stage_buffer_media(
        &self,
        session_key: &str,
        base64: &str,
        file_name: &str,
        mime_type: &str,
    ) -> Result<
        openclaw::workspace::media::WorkspaceMediaReceipt,
        openclaw::workspace::media::WorkspaceMediaFailure,
    >;
}
pub(crate) trait SkillOps {
    fn installed_skill_catalog(
        &self,
    ) -> OwnedRuntimeFuture<Option<openclaw::skill::InstalledSkillCatalog>>;

    fn install_clawhub_skill<'a>(
        &'a self,
        command: SkillInstallCommand,
    ) -> SessionFuture<'a, SkillInstallOutcome>;

    fn skill_status<'a>(&'a self) -> SessionFuture<'a, crate::skill_status::Outcome>;

    fn manage_skills<'a>(
        &'a self,
        command: SkillManagementCommand,
    ) -> SessionFuture<'a, SkillManagementOutcome>;

    fn skill_bundles<'a>(
        &'a self,
        command: skill_bundle::Command,
    ) -> SessionFuture<'a, skill_bundle::Outcome>;
}
pub(crate) trait ChannelOps {
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

    fn observe_channel_accounts<'a>(
        &'a self,
    ) -> SessionFuture<'a, Result<ChannelStatusOutcome, ChannelStatusFailure>>;

    fn observe_channel_snapshot<'a>(
        &'a self,
    ) -> SessionFuture<'a, Result<ChannelSnapshotOutcome, ChannelStatusFailure>>;

    fn read_channel_config<'a>(
        &'a self,
        channel: String,
        account_id: Option<String>,
    ) -> SessionFuture<'a, channel_config_read::Outcome>;

    fn validate_channel_credentials<'a>(
        &'a self,
        channel: String,
        config: zeroize::Zeroizing<Vec<u8>>,
    ) -> SessionFuture<'a, channel_credentials::Outcome>;

    fn channel_catalog<'a>(&'a self) -> SessionFuture<'a, ChannelCatalogOutcome>;

    fn channel_configure_form<'a>(
        &'a self,
        channel: String,
    ) -> SessionFuture<'a, ChannelConfigureFormOutcome>;

    fn channel_configure<'a>(
        &'a self,
        channel: String,
        account_id: String,
        values: zeroize::Zeroizing<Vec<u8>>,
    ) -> SessionFuture<'a, ChannelConfigureOutcome>;

    fn channel_delete_config<'a>(
        &'a self,
        channel: String,
        account_id: String,
    ) -> SessionFuture<'a, channel_delete::Outcome>;
}
pub(crate) trait ProviderConfigOps {
    fn reconcile_provider_native_configuration<'a>(
        &'a self,
        command: ProviderNativeConfigurationCommand<'a>,
    ) -> SessionFuture<'a, ProviderNativeConfigurationEffect>;
}

pub(crate) struct ProviderNativeConfigurationCommand<'a> {
    pub(crate) accounts: &'a [environment::ProviderAccount],
    pub(crate) models: &'a environment::ProviderModelCatalog,
    pub(crate) routing: Option<&'a environment::ProviderRouting>,
    pub(crate) retired: &'a [environment::ProviderAccount],
    pub(crate) required_auth_accounts: &'a std::collections::BTreeSet<environment::ProviderAccountId>,
    pub(crate) now_millis: u64,
}

pub(crate) trait LifecycleOps {
    fn snapshot(&self) -> SupervisorSnapshot;

    fn readiness(&self) -> bool {
        self.snapshot().phase() == foundation::process::supervision::SupervisorPhase::Running
    }
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
            "task.management" | "task.control" => Some(Self::Task),
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
