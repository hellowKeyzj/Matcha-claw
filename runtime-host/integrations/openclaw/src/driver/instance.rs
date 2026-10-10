use std::{
    fmt,
    net::{Ipv4Addr, SocketAddr},
    path::PathBuf,
    sync::{Arc, Mutex as StdMutex},
};

#[cfg(unix)]
use foundation::process::InvalidGuardianExecutable;
use foundation::process::{ProcessContainment, supervise};
use platform::{listener_identity::ListenerIdentity, parent_callback::ParentShellOpenPath};
use tokio::sync::{Mutex, mpsc, watch};

use platform::state_dir::CanonicalStateDir;

use crate::{
    gateway::{
        auth::GatewaySecret,
        client::{GatewayClientError, GatewayClientMetadata, GatewayEndpoint},
        control_ui::{ControlUiUrlError, PublicControlUiUrl},
    },
    lifecycle::{
        doctor::{DoctorRepairError, OpenClawDoctorRepair},
        launch::{LaunchError, LaunchFactory, OpenClawLaunchInput, SealedRuntimeHost},
        logs::{LifecycleDiagnostic, LifecycleDiagnosticState, LifecycleLogBuffer},
        recovery::OpenClawStartRecovery,
        restart::OpenClawRestartPolicy,
        stdio::OpenClawStdioActivation,
    },
    port::{
        OpenClawDriverParentCallbackHandle, OpenClawGateway, OpenClawGatewayControl,
        OpenClawSessionGateway, SessionEvent,
    },
};

use super::owner::{SupervisorLifecycleHandle, SupervisorOwner};

pub struct OpenClawInput {
    pub runtime_host_mcp_executable: PathBuf,
    pub runtime_host_mcp_state_dir: PathBuf,
    pub electron_image: PathBuf,
    pub working_directory: PathBuf,
    pub openclaw_dir: PathBuf,
    pub managed_plugin_root: PathBuf,
    pub companion_skill_source_root: PathBuf,
    pub subagent_template_dir: PathBuf,
    pub entry: PathBuf,
    pub state_dir: CanonicalStateDir,
    pub port: u16,
    pub sealed_endpoint: Option<String>,
    pub sealed_token: Option<String>,
    pub client_metadata: GatewayClientMetadata,
    pub report_diagnostic: Arc<dyn Fn(LifecycleDiagnostic) + Send + Sync>,
    #[cfg(unix)]
    pub guardian_executable: PathBuf,
}

pub struct OpenClawDriver {
    pub owner: StdMutex<Option<SupervisorOwner>>,
    pub(crate) lifecycle_gate: Arc<Mutex<()>>,
    pub(crate) repair_state: StdMutex<runtime_directory::RuntimeRepairSnapshot>,
    pub(crate) doctor_repair: OpenClawDoctorRepair,
    pub(crate) diagnostic_state: LifecycleDiagnosticState,
    pub(crate) runtime_host_mcp_executable: PathBuf,
    pub(crate) runtime_host_mcp_state_dir: PathBuf,
    pub diagnostic_reporter: Arc<dyn Fn(LifecycleDiagnostic) + Send + Sync>,
    pub gateway: Arc<Mutex<OpenClawGateway>>,
    pub gateway_control: OpenClawGatewayControl,
    pub session_gateway: OpenClawSessionGateway,
    pub control_readiness: watch::Receiver<u64>,
    pub lifecycle_logs: LifecycleLogBuffer,
    pub parent_callback: OpenClawDriverParentCallbackHandle,
    pub workspace: crate::surfaces::workspace::OpenClawWorkspaceAccess,
    pub matcha_workspace_templates:
        crate::native_config::workspace::MatchaWorkspaceTemplateDirectory,
    pub workspace_context: Option<crate::native_config::workspace::WorkspaceContextDirectory>,
    pub usage: crate::surfaces::usage::UsageProjection,
    pub electron_image: PathBuf,
    pub working_directory: PathBuf,
    pub state_dir: CanonicalStateDir,
    pub gateway_port: u16,
    pub control_ui_url: PublicControlUiUrl,
    pub openclaw_dir: PathBuf,
    pub managed_plugin_root: PathBuf,
    pub companion_skill_source_root: PathBuf,
    pub subagent_templates: crate::native_config::subagent_templates::SubagentTemplateDirectory,
    pub weixin_login: crate::surfaces::channels::gateway::weixin_login::WeixinLogin,
}

pub struct PreparedOpenClaw {
    launch: LaunchFactory,
    doctor_repair: OpenClawDoctorRepair,
    runtime_host_mcp_executable: PathBuf,
    runtime_host_mcp_state_dir: PathBuf,
    pub working_directory: PathBuf,
    pub electron_image: PathBuf,
    entry: PathBuf,
    pub openclaw_dir: PathBuf,
    pub managed_plugin_root: PathBuf,
    pub companion_skill_source_root: PathBuf,
    pub subagent_templates: crate::native_config::subagent_templates::SubagentTemplateDirectory,
    pub matcha_workspace_templates:
        crate::native_config::workspace::MatchaWorkspaceTemplateDirectory,
    pub workspace_context: Option<crate::native_config::workspace::WorkspaceContextDirectory>,
    endpoint: GatewayEndpoint,
    pub state_dir: CanonicalStateDir,
    pub secret: Arc<GatewaySecret>,
    pub listener_identity: Arc<ListenerIdentity>,
    client_metadata: GatewayClientMetadata,
    pub control_ui_url: PublicControlUiUrl,
    report_diagnostic: Arc<dyn Fn(LifecycleDiagnostic) + Send + Sync>,
    #[cfg(unix)]
    guardian_executable: PathBuf,
}

impl OpenClawDriver {
    pub fn installation_status(&self) -> Option<crate::native_config::installation::Status> {
        crate::native_config::installation::Status::inspect(&self.openclaw_dir)
    }

    pub fn runtime_paths(
        &self,
    ) -> Result<
        crate::native_config::runtime_paths::RuntimePaths,
        crate::native_config::runtime_paths::RuntimePathsError,
    > {
        crate::native_config::runtime_paths::RuntimePaths::inspect(
            &self.openclaw_dir,
            &self.state_dir,
            &self.workspace,
        )
    }

    pub fn cli_command(
        &self,
    ) -> Result<
        crate::native_config::runtime_paths::CliCommand,
        crate::native_config::runtime_paths::CliCommandError,
    > {
        crate::native_config::runtime_paths::CliCommand::inspect(&self.openclaw_dir)
    }

    pub fn tool_permission_mode(
        &self,
    ) -> Result<
        crate::native_config::tool_permission::Mode,
        crate::native_config::tool_permission::Error,
    > {
        crate::native_config::tool_permission::Mode::read(self.state_dir.clone())
    }

    pub fn set_tool_permission_mode(
        &self,
        mode: crate::native_config::tool_permission::Mode,
    ) -> Result<
        crate::native_config::tool_permission::Effect,
        crate::native_config::tool_permission::Error,
    > {
        mode.apply(self.state_dir.clone())
    }

    pub fn plugins(&self) -> crate::native_config::plugins::PluginProjection {
        crate::native_config::plugins::PluginProjection::new(
            self.state_dir.clone(),
            self.companion_skill_source_root.clone(),
            self.managed_plugin_root.clone(),
            self.working_directory.clone(),
        )
    }

    pub fn plugin_provider(&self) -> crate::plugins::OpenClawPluginProvider {
        crate::plugins::OpenClawPluginProvider::new(self.plugins())
    }

    pub fn state_dir(&self) -> &CanonicalStateDir {
        &self.state_dir
    }

    pub fn start_control_supervision(&self) {
        self.gateway_control.start_supervision();
    }

    pub fn take_control_supervisor(
        &self,
    ) -> Option<crate::gateway::client::GatewayControlSupervisor> {
        self.gateway_control.take_supervisor()
    }

    pub fn subagent_template_catalog(
        &self,
    ) -> Result<
        crate::native_config::subagent_templates::Catalog,
        crate::native_config::subagent_templates::SubagentTemplateError,
    > {
        crate::native_config::subagent_templates::SubagentTemplateCatalog::list(
            &self.subagent_templates,
        )
    }

    pub fn subagent_template(
        &self,
        id: &str,
    ) -> Result<
        crate::native_config::subagent_templates::Detail,
        crate::native_config::subagent_templates::SubagentTemplateError,
    > {
        crate::native_config::subagent_templates::SubagentTemplateCatalog::detail(
            &self.subagent_templates,
            id,
        )
    }

    pub fn prepare(
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
        let runtime_host_mcp_executable = input.runtime_host_mcp_executable.clone();
        let runtime_host_mcp_state_dir = input.runtime_host_mcp_state_dir.clone();
        let state_dir = input.state_dir.clone();
        let subagent_templates =
            crate::native_config::subagent_templates::SubagentTemplateDirectory::try_new(
                input.subagent_template_dir.clone(),
            )
            .map_err(|_| {
                ConstructionError::WorkspaceProjection(
                    crate::native_config::workspace::WorkspaceProjectionError::TemplateUnavailable,
                )
            })?;
        let matcha_workspace_templates =
            crate::native_config::workspace::MatchaWorkspaceTemplateDirectory::from_runtime_layout(
                &input.working_directory,
                &input.openclaw_dir,
            )
            .map_err(ConstructionError::WorkspaceProjection)?;
        let workspace_context =
            crate::native_config::workspace::WorkspaceContextDirectory::from_runtime_layout(
                &input.working_directory,
                &input.openclaw_dir,
            )
            .map_err(ConstructionError::WorkspaceProjection)?;
        let sealed_runtime_host = match (input.sealed_endpoint, input.sealed_token) {
            (Some(endpoint), Some(token)) => Some(SealedRuntimeHost { endpoint, token }),
            (None, None) => None,
            _ => return Err(ConstructionError::Launch(LaunchError::InvalidInput)),
        };
        let launch_input = OpenClawLaunchInput {
            electron_image: input.electron_image,
            working_directory: working_directory.clone(),
            openclaw_dir: input.openclaw_dir,
            entry: input.entry,
            state_dir: state_dir.clone(),
            port: input.port,
            secret: Arc::clone(&secret),
        };
        let launch = launch_input
            .clone()
            .try_into_launch_factory_with_sealed_runtime_host(sealed_runtime_host)?;
        let doctor_repair = OpenClawDoctorRepair::new(launch_input)?;
        #[cfg(unix)]
        if !input.guardian_executable.is_absolute() {
            return Err(ConstructionError::Guardian(InvalidGuardianExecutable));
        }

        Ok(PreparedOpenClaw {
            launch,
            doctor_repair,
            runtime_host_mcp_executable,
            runtime_host_mcp_state_dir,
            working_directory,
            electron_image,
            entry,
            openclaw_dir,
            managed_plugin_root,
            companion_skill_source_root,
            subagent_templates,
            matcha_workspace_templates,
            workspace_context,
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

    pub fn owner(&self) -> SupervisorLifecycleHandle {
        self.owner
            .lock()
            .expect("OpenClaw supervisor owner lock must not be poisoned")
            .as_ref()
            .expect("OpenClaw supervisor owner must be present")
            .lifecycle_handle()
    }

    pub fn owner_if_present(&self) -> Option<SupervisorLifecycleHandle> {
        self.owner
            .lock()
            .expect("OpenClaw supervisor owner lock must not be poisoned")
            .as_ref()
            .map(SupervisorOwner::lifecycle_handle)
    }

    pub fn take_owner(&self) -> SupervisorOwner {
        self.owner
            .lock()
            .expect("OpenClaw supervisor owner lock must not be poisoned")
            .take()
            .expect("OpenClaw supervisor owner must be present")
    }
}

impl PreparedOpenClaw {
    pub fn into_instance(
        self,
        events: mpsc::Sender<SessionEvent>,
        session_events: mpsc::Sender<sessions_module::command::SessionIngressEvent>,
        parent_callback: Arc<dyn ParentShellOpenPath>,
    ) -> Result<OpenClawDriver, ConstructionError> {
        let pairing =
            crate::surfaces::channels::gateway::pairing::ChannelPairingOperation::try_new(
                self.electron_image.clone(),
                self.entry.clone(),
                self.openclaw_dir.clone(),
                self.state_dir.as_path().to_owned(),
            )
            .expect("prepared OpenClaw pairing command inputs must be absolute");
        let credentials =
            crate::surfaces::channels::gateway::credentials::ChannelCredentialsOperation::try_new(
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
            session_events,
        )
        .with_openclaw_dir(self.openclaw_dir.clone())
        .with_channel_schema_source(
            self.electron_image.clone(),
            self.managed_plugin_root.clone(),
        )
        .with_channel_pairing_operation(pairing)
        .with_channel_credentials_operation(credentials)
        .with_team_state_dir(self.state_dir.clone());
        let control_readiness = gateway.control_readiness();
        let gateway_control = gateway.control();
        let readiness = gateway.readiness_policy();
        let graceful_stop = gateway.graceful_stop_policy();
        let session_gateway = gateway.session_gateway();
        let usage = gateway.usage_projection();
        let gateway = Arc::new(Mutex::new(gateway));
        let lifecycle_logs = LifecycleLogBuffer::new();
        let diagnostic_state = LifecycleDiagnosticState::new();
        let report_diagnostic = self.report_diagnostic;
        let diagnostic_reporter = {
            let diagnostic_state = diagnostic_state.clone();
            Arc::new(move |diagnostic| {
                diagnostic_state.record(diagnostic);
                report_diagnostic(diagnostic);
            })
        };
        let stdio_activation = OpenClawStdioActivation::with_log_buffer(
            diagnostic_reporter.clone(),
            lifecycle_logs.clone(),
        );

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
            OpenClawStartRecovery::with_diagnostics(diagnostic_state.clone()),
            OpenClawRestartPolicy,
        );

        let workspace =
            crate::surfaces::workspace::OpenClawWorkspaceAccess::new(self.state_dir.clone());
        let weixin_login = crate::surfaces::channels::gateway::weixin_login::WeixinLogin::new(
            self.state_dir.clone(),
        );
        let control_ui_url = self.control_ui_url;
        Ok(OpenClawDriver {
            owner: StdMutex::new(Some(SupervisorOwner::new(supervisor))),
            lifecycle_gate: Arc::new(Mutex::new(())),
            repair_state: StdMutex::new(runtime_directory::RuntimeRepairSnapshot {
                phase: runtime_directory::RuntimeRepairPhase::Idle,
                trigger: None,
                failure: None,
            }),
            doctor_repair: self.doctor_repair,
            diagnostic_state,
            runtime_host_mcp_executable: self.runtime_host_mcp_executable,
            runtime_host_mcp_state_dir: self.runtime_host_mcp_state_dir,
            diagnostic_reporter,
            gateway,
            gateway_control,
            session_gateway,
            control_readiness,
            lifecycle_logs,
            parent_callback: OpenClawDriverParentCallbackHandle::new(parent_callback),
            workspace,
            matcha_workspace_templates: self.matcha_workspace_templates,
            workspace_context: self.workspace_context,
            usage,
            electron_image: self.electron_image,
            working_directory: self.working_directory,
            state_dir: self.state_dir,
            gateway_port: self.endpoint.address().port(),
            control_ui_url,
            openclaw_dir: self.openclaw_dir,
            managed_plugin_root: self.managed_plugin_root,
            companion_skill_source_root: self.companion_skill_source_root,
            subagent_templates: self.subagent_templates,
            weixin_login,
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConstructionError {
    Endpoint(GatewayClientError),
    ListenerIdentity,
    ControlUiUrl(ControlUiUrlError),
    WorkspaceProjection(crate::native_config::workspace::WorkspaceProjectionError),
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
            Self::WorkspaceProjection(error) => error.fmt(formatter),
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
            Self::WorkspaceProjection(error) => Some(error),
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
