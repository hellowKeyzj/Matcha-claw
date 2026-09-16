use super::*;

pub struct OpenClawInput {
    pub team_run_mcp_executable: PathBuf,
    pub team_run_mcp_state_dir: PathBuf,
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

pub(crate) struct OpenClawInstance {
    pub(super) owner: StdMutex<Option<SupervisorOwner>>,
    pub(super) diagnostic_reporter: Arc<dyn Fn(LifecycleDiagnostic) + Send + Sync>,
    pub(super) gateway: Arc<Mutex<OpenClawGateway>>,
    pub(super) session_gateway: OpenClawSessionGateway,
    pub(super) control_readiness: watch::Receiver<u64>,
    pub(super) lifecycle_logs: LifecycleLogBuffer,
    pub(super) parent_callback: ParentCallbackHandle,
    pub(super) workspace: openclaw::workspace::OpenClawWorkspaceAccess,
    pub(super) matcha_workspace_templates:
        openclaw::projection::workspace::MatchaWorkspaceTemplateDirectory,
    pub(super) workspace_context:
        Option<openclaw::projection::workspace::WorkspaceContextDirectory>,
    pub(super) usage: openclaw::usage::UsageProjection,
    pub(super) electron_image: PathBuf,
    pub(super) working_directory: PathBuf,
    pub(super) state_dir: CanonicalStateDir,
    pub(super) gateway_port: u16,
    pub(super) control_ui_url: PublicControlUiUrl,
    pub(super) openclaw_dir: PathBuf,
    pub(super) managed_plugin_root: PathBuf,
    pub(super) companion_skill_source_root: PathBuf,
    pub(super) subagent_templates:
        openclaw::projection::subagent_templates::SubagentTemplateDirectory,
    pub(super) weixin_login: openclaw::operations::weixin_login::WeixinLogin,
}

pub(crate) struct PreparedOpenClaw {
    launch: LaunchFactory,
    doctor_repair: OpenClawDoctorRepair,
    pub(super) working_directory: PathBuf,
    pub(super) electron_image: PathBuf,
    entry: PathBuf,
    pub(super) openclaw_dir: PathBuf,
    pub(super) managed_plugin_root: PathBuf,
    pub(super) companion_skill_source_root: PathBuf,
    pub(super) subagent_templates:
        openclaw::projection::subagent_templates::SubagentTemplateDirectory,
    pub(super) matcha_workspace_templates:
        openclaw::projection::workspace::MatchaWorkspaceTemplateDirectory,
    pub(super) workspace_context:
        Option<openclaw::projection::workspace::WorkspaceContextDirectory>,
    endpoint: GatewayEndpoint,
    pub(super) state_dir: CanonicalStateDir,
    pub(super) secret: Arc<GatewaySecret>,
    pub(super) listener_identity: Arc<ListenerIdentity>,
    client_metadata: GatewayClientMetadata,
    pub(super) control_ui_url: PublicControlUiUrl,
    report_diagnostic: Arc<dyn Fn(LifecycleDiagnostic) + Send + Sync>,
    #[cfg(unix)]
    guardian_executable: PathBuf,
}

impl OpenClawInstance {
    pub(crate) fn installation_status(&self) -> Option<openclaw::projection::installation::Status> {
        openclaw::projection::installation::Status::inspect(&self.openclaw_dir)
    }

    pub(crate) fn runtime_paths(
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

    pub(crate) fn cli_command(
        &self,
    ) -> Result<
        openclaw::projection::runtime_paths::CliCommand,
        openclaw::projection::runtime_paths::CliCommandError,
    > {
        openclaw::projection::runtime_paths::CliCommand::inspect(&self.openclaw_dir)
    }

    pub(crate) fn tool_permission_mode(
        &self,
    ) -> Result<
        openclaw::projection::tool_permission::Mode,
        openclaw::projection::tool_permission::Error,
    > {
        openclaw::projection::tool_permission::Mode::read(self.state_dir.clone())
    }

    pub(crate) fn set_tool_permission_mode(
        &self,
        mode: openclaw::projection::tool_permission::Mode,
    ) -> Result<
        openclaw::projection::tool_permission::Effect,
        openclaw::projection::tool_permission::Error,
    > {
        mode.apply(self.state_dir.clone())
    }

    pub(crate) fn plugins(&self) -> openclaw::projection::plugins::PluginProjection {
        openclaw::projection::plugins::PluginProjection::new(
            self.state_dir.clone(),
            self.companion_skill_source_root.clone(),
            self.managed_plugin_root.clone(),
            self.working_directory.clone(),
        )
    }

    pub(crate) fn plugin_catalog(
        &self,
    ) -> Result<crate::plugins::Catalog, crate::plugins::PluginError> {
        crate::runtime::adapters::openclaw::adapters::plugin::OpenClawPluginProvider::new(
            self.plugins(),
        )
        .catalog()
    }

    pub(crate) fn plugin_runtime(
        &self,
        running: bool,
    ) -> Result<crate::plugins::Runtime, crate::plugins::PluginError> {
        crate::runtime::adapters::openclaw::adapters::plugin::OpenClawPluginProvider::new(
            self.plugins(),
        )
        .runtime(running)
    }

    pub(crate) fn plugin_set_enabled(
        &self,
        plugin_id: &str,
        enabled: bool,
    ) -> crate::plugins::ConfigurationOutcome {
        crate::runtime::adapters::openclaw::adapters::plugin::OpenClawPluginProvider::new(
            self.plugins(),
        )
        .set_enabled(plugin_id, enabled)
    }

    pub(crate) fn plugin_operation(
        &self,
        operation: crate::plugins::Operation,
        plugin_id: &str,
    ) -> crate::plugins::OperationOutcome {
        crate::runtime::adapters::openclaw::adapters::plugin::OpenClawPluginProvider::new(
            self.plugins(),
        )
        .operation(operation, plugin_id)
    }

    pub(crate) fn plugin_finalize_uninstall(
        &self,
        plugin_id: &str,
    ) -> crate::plugins::OperationOutcome {
        crate::runtime::adapters::openclaw::adapters::plugin::OpenClawPluginProvider::new(
            self.plugins(),
        )
        .finalize_uninstall(plugin_id)
    }

    pub(crate) fn state_dir(&self) -> &CanonicalStateDir {
        &self.state_dir
    }
}

impl OpenClawInstance {
    pub(crate) fn subagent_template_catalog(
        &self,
    ) -> Result<
        openclaw::projection::subagent_templates::Catalog,
        openclaw::projection::subagent_templates::SubagentTemplateError,
    > {
        openclaw::projection::subagent_templates::SubagentTemplateCatalog::list(
            &self.subagent_templates,
        )
    }

    pub(crate) fn subagent_template(
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

    pub(crate) fn prepare(
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
        let team_run_mcp_executable = input.team_run_mcp_executable.clone();
        let team_run_mcp_state_dir = input.team_run_mcp_state_dir.clone();
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
        let matcha_workspace_templates =
            openclaw::projection::workspace::MatchaWorkspaceTemplateDirectory::from_runtime_layout(
                &input.working_directory,
                &input.openclaw_dir,
            )
            .map_err(ConstructionError::WorkspaceProjection)?;
        let workspace_context =
            openclaw::projection::workspace::WorkspaceContextDirectory::from_runtime_layout(
                &input.working_directory,
                &input.openclaw_dir,
            )
            .map_err(ConstructionError::WorkspaceProjection)?;
        openclaw::projection::settings::ensure_default_session_idle(state_dir.clone())
            .map_err(ConstructionError::Projection)?;
        openclaw::projection::control_ui::ensure_matcha_operator_device_auth_policy(
            state_dir.clone(),
        )
        .map_err(ConstructionError::ControlUiPolicy)?;
        if !matches!(
            openclaw::projection::connector::preset::project_preset_team_run_mcp_server(
                state_dir.clone(),
                &team_run_mcp_executable,
                &team_run_mcp_state_dir,
            ),
            openclaw::projection::connector::external::ConnectorProjectionEffect::Written { .. }
        ) {
            return Err(ConstructionError::PresetMcpProjection);
        }
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

    pub(crate) fn owner(&self) -> SupervisorLifecycleHandle {
        self.owner
            .lock()
            .expect("OpenClaw supervisor owner lock must not be poisoned")
            .as_ref()
            .expect("OpenClaw supervisor owner must be present")
            .lifecycle_handle()
    }

    pub(crate) fn owner_if_present(&self) -> Option<SupervisorLifecycleHandle> {
        self.owner
            .lock()
            .expect("OpenClaw supervisor owner lock must not be poisoned")
            .as_ref()
            .map(SupervisorOwner::lifecycle_handle)
    }

    pub(crate) fn take_owner(&self) -> SupervisorOwner {
        self.owner
            .lock()
            .expect("OpenClaw supervisor owner lock must not be poisoned")
            .take()
            .expect("OpenClaw supervisor owner must be present")
    }

    pub(crate) async fn usage_recent(
        &self,
        limit: usize,
    ) -> Result<Vec<openclaw::usage::UsageEntry>, openclaw::usage::UsageReadError> {
        self.usage.recent(limit).await
    }

    pub(crate) async fn session_usage_timeseries(
        &self,
        agent_id: &str,
        session_id: &str,
    ) -> Result<Vec<openclaw::usage::UsageEntry>, openclaw::usage::UsageReadError> {
        self.usage.session_timeseries(agent_id, session_id).await
    }
}

impl PreparedOpenClaw {
    pub(crate) fn into_instance(
        self,
        events: mpsc::Sender<openclaw::port::SessionEvent>,
        canonical_events: mpsc::Sender<openclaw::port::CanonicalIngressResult>,
        parent_callback: ParentCallbackHandle,
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
        .with_openclaw_dir(self.openclaw_dir.clone())
        .with_channel_schema_source(
            self.electron_image.clone(),
            self.managed_plugin_root.clone(),
        )
        .with_channel_pairing_operation(pairing)
        .with_channel_credentials_operation(credentials)
        .with_team_state_dir(self.state_dir.clone());
        let control_readiness = gateway.control_readiness();
        let readiness = gateway.readiness_policy();
        let graceful_stop = gateway.graceful_stop_policy();
        let session_gateway = gateway.session_gateway();
        let usage = gateway.usage_projection();
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
            OpenClawStartRecovery::with_diagnostics_and_invalid_config_repair(
                diagnostic_state,
                Arc::new(self.doctor_repair),
            ),
            OpenClawRestartPolicy,
        );

        let workspace = openclaw::workspace::OpenClawWorkspaceAccess::new(self.state_dir.clone());
        let weixin_login =
            openclaw::operations::weixin_login::WeixinLogin::new(self.state_dir.clone());
        let control_ui_url = self.control_ui_url;
        Ok(OpenClawInstance {
            owner: StdMutex::new(Some(SupervisorOwner::new(supervisor))),
            diagnostic_reporter,
            gateway,
            session_gateway,
            control_readiness,
            lifecycle_logs,
            parent_callback,
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
    ControlUiPolicy(openclaw::projection::control_ui::Error),
    WorkspaceProjection(openclaw::projection::workspace::WorkspaceProjectionError),
    Projection(openclaw::projection::settings::SettingsProjectionError),
    PresetMcpProjection,
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
            Self::PresetMcpProjection => formatter.write_str("preset MCP projection failed"),
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
            Self::PresetMcpProjection => None,
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
