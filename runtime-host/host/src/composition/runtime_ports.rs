use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use matcha_agent::driver::MatchaRuntimeDriver;
use openclaw::driver::OpenClawDriver;
use platform::endpoint::runtime_address::RuntimeEndpoint;
use runtime_directory::{
    RuntimeDriverRegistry,
    control_loopback::{RuntimeControlLifecycleFuture, RuntimeControlLifecyclePort},
};

pub(crate) use runtime_directory::{
    LifecycleOps, RuntimeControlFailure, RuntimeControlLifecycle, RuntimeControlLifecycleError,
    RuntimeControlLifecycleFailure, RuntimeControlLifecycleStatus, RuntimeControlOps,
    RuntimeControlReadiness, RuntimeControlStartupDiagnostic, RuntimeDriverIdentity,
    RuntimeGatewayHealth, RuntimeGatewayStatus, RuntimeLifecycleFailure, RuntimeLogSnapshot,
    RuntimeStartFailure,
};

use ::diagnostics::RuntimeStartupDiagnostic;

use crate::{RuntimeFailure, RuntimeLifecycle, composition::PeerHandle};

pub(crate) trait RuntimeDriver:
    sessions_module::RuntimeDriver + organization::OrganizationNativeRuntime + Send + Sync
{
    fn channel_ops(&self) -> Option<&dyn channels::ports::ChannelOps> {
        None
    }

    fn task_ops(&self) -> Option<&dyn task_manager::TaskOps> {
        None
    }

    fn subagent_ops(&self) -> Option<&dyn subagents::SubagentOps> {
        None
    }

    fn cron_ops(&self) -> Option<&dyn ::cron::CronOps> {
        None
    }

    fn usage_ops(&self) -> Option<&dyn ::usage::UsageOps> {
        None
    }

    fn workspace_ops(&self) -> Option<&dyn workspace::WorkspaceOps> {
        None
    }

    fn platform_tools_ops(&self) -> Option<&dyn platform_tools::PlatformToolsOps> {
        None
    }

    fn skill_ops(&self) -> Option<&dyn skills_module::SkillRuntimeOps> {
        None
    }

    fn host_lifecycle_ops(&self) -> Option<&dyn LifecycleOps> {
        None
    }

    fn runtime_control_ops(&self) -> Option<&dyn RuntimeControlOps> {
        None
    }

    fn provider_module_config_ops(&self) -> Option<&dyn provider_module::ProviderConfigOps> {
        None
    }

    fn provider_module_model_discovery_ops(
        &self,
    ) -> Option<&dyn provider_module::ProviderModelDiscoveryOps> {
        None
    }

    fn provider_module_private_projection_ops(
        &self,
    ) -> Option<&dyn provider_module::ProviderPrivateProjectionOps> {
        None
    }

    fn connector_ops(&self) -> Option<&dyn ::connectors::ports::ConnectorOps> {
        None
    }

    fn security_ops(&self) -> Option<&dyn security::ports::SecurityOps> {
        None
    }

    fn settings_ops(&self) -> Option<&dyn ::settings::ports::SettingsOps> {
        None
    }
}

pub(crate) struct RuntimeDriverDirectory {
    drivers: RuntimeDriverRegistry<Arc<dyn RuntimeDriver>>,
    closed: AtomicBool,
}

impl sessions_module::SessionRuntimeDirectory for RuntimeDriverDirectory {
    fn lookup(
        &self,
        endpoint: &RuntimeEndpoint,
    ) -> Option<Arc<dyn sessions_module::RuntimeDriver>> {
        self.lookup(endpoint)
            .map(|driver| driver as Arc<dyn sessions_module::RuntimeDriver>)
    }
}

impl channels::ports::ChannelRuntimeDirectory for RuntimeDriverDirectory {
    fn channel_ops(&self, endpoint: &RuntimeEndpoint) -> Option<&dyn channels::ports::ChannelOps> {
        self.driver_ref(endpoint)?.channel_ops()
    }
}

impl security::ports::SecurityRuntimeDirectory for RuntimeDriverDirectory {
    fn security_ops(&self) -> Option<&dyn security::ports::SecurityOps> {
        self.openclaw_driver_ref()?.security_ops()
    }

    fn restart_security_runtime<'a>(&'a self) -> security::ports::SecurityFuture<'a, bool> {
        Box::pin(async move {
            let Some(driver) = self.security_driver() else {
                return false;
            };
            let Some(lifecycle) = driver.host_lifecycle_ops() else {
                return false;
            };
            lifecycle.restart().await.is_ok()
        })
    }
}

impl settings::ports::SettingsRuntimeDirectory for RuntimeDriverDirectory {
    fn settings_ops(&self) -> Option<&dyn settings::ports::SettingsOps> {
        self.openclaw_driver_ref()?.settings_ops()
    }
}

impl ::cron::CronRuntimeDirectory for RuntimeDriverDirectory {
    fn cron_ops(&self) -> Option<&dyn ::cron::CronOps> {
        self.openclaw_driver_ref()?.cron_ops()
    }
}

impl task_manager::TaskRuntimeDirectory for RuntimeDriverDirectory {
    fn task_ops(&self) -> Option<&dyn task_manager::TaskOps> {
        self.openclaw_driver_ref()?.task_ops()
    }
}

impl subagents::SubagentRuntimeDirectory for RuntimeDriverDirectory {
    fn subagent_ops(
        &self,
        endpoint: subagents::NativeEndpoint,
    ) -> Option<&dyn subagents::SubagentOps> {
        match endpoint {
            subagents::NativeEndpoint::OpenClawLocal => self.openclaw_driver_ref()?.subagent_ops(),
            subagents::NativeEndpoint::MatchaAgentLocal => {
                self.matcha_agent_driver_ref()?.subagent_ops()
            }
        }
    }
}

impl workspace::WorkspaceRuntimeDirectory for RuntimeDriverDirectory {
    fn workspace_ops(&self, endpoint: &RuntimeEndpoint) -> Option<&dyn workspace::WorkspaceOps> {
        self.driver_ref(endpoint)?.workspace_ops()
    }
}

impl usage::UsageRuntimeDirectory for RuntimeDriverDirectory {
    fn usage_ops(&self) -> Option<&dyn usage::UsageOps> {
        self.openclaw_driver_ref()?.usage_ops()
    }
}

impl connectors::ports::ConnectorRuntimeDirectory for RuntimeDriverDirectory {
    fn connector_ops(&self) -> Option<&dyn connectors::ports::ConnectorOps> {
        self.openclaw_driver_ref()?.connector_ops()
    }

    fn connector_ops_for_endpoint(
        &self,
        endpoint: &RuntimeEndpoint,
    ) -> Option<&dyn connectors::ports::ConnectorOps> {
        self.driver_ref(endpoint)?.connector_ops()
    }
}

impl provider_module::ProviderRuntimeDirectory for RuntimeDriverDirectory {
    fn provider_config_ops(&self) -> Vec<&dyn provider_module::ProviderConfigOps> {
        if self.is_closed() {
            return Vec::new();
        }
        self.drivers
            .all_drivers_ref()
            .filter_map(|driver| driver.provider_module_config_ops())
            .collect()
    }

    fn provider_model_discovery_ops(
        &self,
    ) -> Option<&dyn provider_module::ProviderModelDiscoveryOps> {
        self.openclaw_driver_ref()?
            .provider_module_model_discovery_ops()
    }

    fn provider_runtime_identity_ops(
        &self,
    ) -> Option<&dyn provider_module::ProviderRuntimeIdentityOps> {
        (!self.is_closed()).then_some(self)
    }

    fn provider_private_projection_ops(
        &self,
    ) -> Option<&dyn provider_module::ProviderPrivateProjectionOps> {
        self.openclaw_driver_ref()?
            .provider_module_private_projection_ops()
    }
}

impl provider_module::ProviderRuntimeIdentityOps for RuntimeDriverDirectory {
    fn runtime_identities(
        &self,
        accounts: &[provider_module::ProviderAccount],
    ) -> Result<Vec<provider_module::ProviderRuntimeIdentity>, ()> {
        openclaw::provider::public_provider_model_identities(accounts)
            .map(|identities| {
                identities
                    .into_iter()
                    .map(|(account_id, identity)| {
                        provider_module::ProviderRuntimeIdentity::new(
                            account_id,
                            identity.provider_key(),
                        )
                    })
                    .collect()
            })
            .map_err(|_| ())
    }

    fn runtime_identity(
        &self,
        account: &provider_module::ProviderAccount,
    ) -> Result<provider_module::ProviderRuntimeIdentity, ()> {
        openclaw::provider::public_provider_model_identity(account)
            .map(|identity| {
                provider_module::ProviderRuntimeIdentity::new(
                    account.id().as_str(),
                    identity.provider_key(),
                )
            })
            .map_err(|_| ())
    }

    fn runtime_model_ref(
        &self,
        identity: &provider_module::ProviderRuntimeIdentity,
        kind: provider_module::ProviderAccountKind,
        model_id: &str,
    ) -> String {
        openclaw::provider::public_provider_model_ref(identity.provider_key(), kind, model_id)
    }
}

impl organization::OrganizationRuntimeDirectory for RuntimeDriverDirectory {
    fn team_runtime_for_endpoint(
        &self,
        endpoint: &organization::RuntimeEndpointReference,
    ) -> Option<Arc<dyn organization::OrganizationNativeRuntime>> {
        let identity = RuntimeDriverIdentity::from_reference(endpoint.as_str())?;
        self.lookup(&identity.endpoint())
            .map(|driver| driver as Arc<dyn organization::OrganizationNativeRuntime>)
    }

    fn open_claw_runtime(&self) -> Option<Arc<dyn organization::OrganizationNativeRuntime>> {
        self.lookup(&RuntimeDriverIdentity::open_claw().endpoint())
            .map(|driver| driver as Arc<dyn organization::OrganizationNativeRuntime>)
    }
}

impl organization::RoleSessionIdentityResolver for RuntimeDriverDirectory {
    fn session_key(&self, session: &organization::RoleSessionReceipt) -> Option<String> {
        let identity = RuntimeDriverIdentity::from_reference(session.endpoint().as_str())?;
        let driver = self.lookup(&identity.endpoint())?;
        let session_ops = driver.session_ops()?;
        session_ops.agent_scoped_session_key(
            session.agent().as_str(),
            session.endpoint_session_id().as_str(),
        )
    }
}

impl RuntimeDriverDirectory {
    #[cfg(test)]
    pub(crate) fn new() -> Self {
        Self {
            drivers: RuntimeDriverRegistry::new(),
            closed: AtomicBool::new(false),
        }
    }

    pub(crate) fn fixed_peers(
        open_claw: Arc<dyn RuntimeDriver>,
        matcha_agent: Arc<dyn RuntimeDriver>,
    ) -> Self {
        Self {
            drivers: RuntimeDriverRegistry::fixed_peers(open_claw, matcha_agent),
            closed: AtomicBool::new(false),
        }
    }

    #[cfg(test)]
    pub(crate) fn register(&mut self, driver: Arc<dyn RuntimeDriver>) {
        self.set_fixed_peer(driver);
    }

    pub(crate) fn close_runtime_endpoint(&self) {
        self.closed.store(true, Ordering::Release);
    }

    pub(crate) fn lookup(&self, endpoint: &RuntimeEndpoint) -> Option<Arc<dyn RuntimeDriver>> {
        if self.is_closed() {
            return None;
        }
        self.drivers.lookup(endpoint)
    }

    pub(crate) fn security_driver(&self) -> Option<Arc<dyn RuntimeDriver>> {
        self.openclaw_driver_with(|driver| driver.security_ops().is_some())
    }

    fn driver_ref(&self, endpoint: &RuntimeEndpoint) -> Option<&dyn RuntimeDriver> {
        if self.is_closed() {
            return None;
        }
        self.drivers.lookup_ref(endpoint).map(Arc::as_ref)
    }

    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    fn openclaw_driver_ref(&self) -> Option<&dyn RuntimeDriver> {
        self.driver_ref(&RuntimeDriverIdentity::open_claw().endpoint())
    }

    fn matcha_agent_driver_ref(&self) -> Option<&dyn RuntimeDriver> {
        self.driver_ref(&RuntimeDriverIdentity::matcha_agent().endpoint())
    }

    fn openclaw_driver_with(
        &self,
        supports: impl FnOnce(&dyn RuntimeDriver) -> bool,
    ) -> Option<Arc<dyn RuntimeDriver>> {
        let driver = self.lookup(&RuntimeDriverIdentity::open_claw().endpoint())?;
        supports(driver.as_ref()).then_some(driver)
    }

    #[cfg(test)]
    fn set_fixed_peer(&mut self, driver: Arc<dyn RuntimeDriver>) {
        self.drivers.set_fixed_peer(driver.identity(), driver);
    }
}

impl openclaw::gateway::loopback::OpenClawGatewayCapabilityPort for PeerHandle {
    fn browser_request(
        &self,
        request: openclaw::gateway::request::OpenClawBrowserGatewayRequest,
        call: Option<openclaw::gateway::loopback::GatewayCallContext>,
    ) -> openclaw::gateway::loopback::OpenClawGatewayCapabilityFuture<
        Result<openclaw::port::OpenClawGatewayRequestOutcome, ()>,
    > {
        let peer = self.clone();
        Box::pin(async move {
            peer.open_claw_browser_request(request, call)
                .await
                .map_err(|_| ())
        })
    }

    fn mcp_app_request(
        &self,
        request: openclaw::gateway::request::OpenClawMcpAppGatewayRequest,
        call: Option<openclaw::gateway::loopback::GatewayCallContext>,
    ) -> openclaw::gateway::loopback::OpenClawGatewayCapabilityFuture<
        Result<openclaw::port::OpenClawGatewayRequestOutcome, ()>,
    > {
        let peer = self.clone();
        Box::pin(async move {
            peer.open_claw_mcp_app_request(request, call)
                .await
                .map_err(|_| ())
        })
    }

    fn question_resolve(
        &self,
        request: openclaw::gateway::request::OpenClawQuestionResolveGatewayRequest,
        call: Option<openclaw::gateway::loopback::GatewayCallContext>,
    ) -> openclaw::gateway::loopback::OpenClawGatewayCapabilityFuture<
        Result<openclaw::port::OpenClawGatewayRequestOutcome, ()>,
    > {
        let peer = self.clone();
        Box::pin(async move {
            peer.open_claw_question_resolve(request, call)
                .await
                .map_err(|_| ())
        })
    }
}

impl RuntimeControlLifecyclePort for PeerHandle {
    fn lifecycle_status<'a>(
        &'a self,
        endpoint: platform::endpoint::runtime_address::RuntimeEndpoint,
    ) -> RuntimeControlLifecycleFuture<
        'a,
        Result<RuntimeControlLifecycleStatus, RuntimeControlLifecycleError>,
    > {
        Box::pin(async move {
            let state = self
                .state()
                .await
                .map_err(|_| RuntimeControlLifecycleError::Unavailable)?;
            if endpoint == runtime_directory::RuntimeDriverIdentity::open_claw().endpoint() {
                return Ok(runtime_control_status(state.open_claw()));
            }
            if endpoint == runtime_directory::RuntimeDriverIdentity::matcha_agent().endpoint() {
                return Ok(runtime_control_status(state.matcha()));
            }
            Err(RuntimeControlLifecycleError::Unsupported)
        })
    }

    fn admit_lifecycle_start<'a>(
        &'a self,
        endpoint: platform::endpoint::runtime_address::RuntimeEndpoint,
        call: runtime_directory::call::RuntimeControlCallContext,
    ) -> RuntimeControlLifecycleFuture<
        'a,
        Result<platform::call::CallReceipt, RuntimeControlLifecycleError>,
    > {
        Box::pin(self.admit_runtime_start(endpoint, call))
    }

    fn admit_lifecycle_stop<'a>(
        &'a self,
        endpoint: platform::endpoint::runtime_address::RuntimeEndpoint,
        call: runtime_directory::call::RuntimeControlCallContext,
    ) -> RuntimeControlLifecycleFuture<
        'a,
        Result<platform::call::CallReceipt, RuntimeControlLifecycleError>,
    > {
        Box::pin(self.admit_runtime_stop(endpoint, call))
    }

    fn admit_lifecycle_restart<'a>(
        &'a self,
        endpoint: platform::endpoint::runtime_address::RuntimeEndpoint,
        call: runtime_directory::call::RuntimeControlCallContext,
    ) -> RuntimeControlLifecycleFuture<
        'a,
        Result<platform::call::CallReceipt, RuntimeControlLifecycleError>,
    > {
        Box::pin(self.admit_runtime_restart(endpoint, call))
    }
}

pub(super) fn runtime_control_status(state: &crate::RuntimeState) -> RuntimeControlLifecycleStatus {
    RuntimeControlLifecycleStatus {
        lifecycle: runtime_control_lifecycle(state.lifecycle()),
        failure: state.failure().map(runtime_control_failure),
        startup_diagnostic: state
            .startup_diagnostic()
            .map(runtime_control_startup_diagnostic),
    }
}

const fn runtime_control_lifecycle(lifecycle: RuntimeLifecycle) -> RuntimeControlLifecycle {
    match lifecycle {
        RuntimeLifecycle::Unavailable => RuntimeControlLifecycle::Unavailable,
        RuntimeLifecycle::Idle => RuntimeControlLifecycle::Idle,
        RuntimeLifecycle::Starting => RuntimeControlLifecycle::Starting,
        RuntimeLifecycle::Running => RuntimeControlLifecycle::Running,
        RuntimeLifecycle::Stopping => RuntimeControlLifecycle::Stopping,
        RuntimeLifecycle::WaitingToRestart => RuntimeControlLifecycle::WaitingToRestart,
        RuntimeLifecycle::Failed => RuntimeControlLifecycle::Failed,
        RuntimeLifecycle::ShutDown => RuntimeControlLifecycle::ShutDown,
    }
}

const fn runtime_control_failure(failure: RuntimeFailure) -> RuntimeControlLifecycleFailure {
    match failure {
        RuntimeFailure::ArtifactUnavailable => RuntimeControlLifecycleFailure::ArtifactUnavailable,
        RuntimeFailure::PermissionDenied => RuntimeControlLifecycleFailure::PermissionDenied,
        RuntimeFailure::ResourceUnavailable => RuntimeControlLifecycleFailure::ResourceUnavailable,
        RuntimeFailure::PlatformRejected => RuntimeControlLifecycleFailure::PlatformRejected,
        RuntimeFailure::Stdio => RuntimeControlLifecycleFailure::Stdio,
        RuntimeFailure::Readiness => RuntimeControlLifecycleFailure::Readiness,
        RuntimeFailure::UnexpectedExit => RuntimeControlLifecycleFailure::UnexpectedExit,
        RuntimeFailure::AuthorityLost => RuntimeControlLifecycleFailure::AuthorityLost,
        RuntimeFailure::CleanupUnconfirmed => RuntimeControlLifecycleFailure::CleanupUnconfirmed,
        RuntimeFailure::MaterialCleanupFailed => {
            RuntimeControlLifecycleFailure::MaterialCleanupFailed
        }
    }
}

const fn runtime_control_startup_diagnostic(
    diagnostic: RuntimeStartupDiagnostic,
) -> RuntimeControlStartupDiagnostic {
    match diagnostic {
        RuntimeStartupDiagnostic::PortConflict => RuntimeControlStartupDiagnostic::PortConflict,
        RuntimeStartupDiagnostic::ConfigurationRejected => {
            RuntimeControlStartupDiagnostic::ConfigurationRejected
        }
        RuntimeStartupDiagnostic::AppServerReportedError => {
            RuntimeControlStartupDiagnostic::AppServerReportedError
        }
        RuntimeStartupDiagnostic::UnclassifiedStderr => {
            RuntimeControlStartupDiagnostic::UnclassifiedStderr
        }
        RuntimeStartupDiagnostic::InvalidUtf8 => RuntimeControlStartupDiagnostic::InvalidUtf8,
        RuntimeStartupDiagnostic::LineTooLong => RuntimeControlStartupDiagnostic::LineTooLong,
        RuntimeStartupDiagnostic::ListenerReported => {
            RuntimeControlStartupDiagnostic::ListenerReported
        }
        RuntimeStartupDiagnostic::BindRejected => RuntimeControlStartupDiagnostic::BindRejected,
        RuntimeStartupDiagnostic::StartupFailed => RuntimeControlStartupDiagnostic::StartupFailed,
        RuntimeStartupDiagnostic::InvalidEncoding => {
            RuntimeControlStartupDiagnostic::InvalidEncoding
        }
        RuntimeStartupDiagnostic::DiagnosticLimitReached => {
            RuntimeControlStartupDiagnostic::DiagnosticLimitReached
        }
    }
}

impl RuntimeDriver for MatchaRuntimeDriver {
    fn host_lifecycle_ops(&self) -> Option<&dyn LifecycleOps> {
        Some(self)
    }
}

impl RuntimeDriver for OpenClawDriver {
    fn channel_ops(&self) -> Option<&dyn channels::ports::ChannelOps> {
        Some(self)
    }

    fn task_ops(&self) -> Option<&dyn task_manager::TaskOps> {
        Some(self)
    }

    fn subagent_ops(&self) -> Option<&dyn subagents::SubagentOps> {
        Some(self)
    }

    fn cron_ops(&self) -> Option<&dyn ::cron::CronOps> {
        Some(self)
    }

    fn usage_ops(&self) -> Option<&dyn ::usage::UsageOps> {
        Some(self)
    }

    fn workspace_ops(&self) -> Option<&dyn ::workspace::WorkspaceOps> {
        Some(self)
    }

    fn platform_tools_ops(&self) -> Option<&dyn ::platform_tools::PlatformToolsOps> {
        Some(self)
    }

    fn skill_ops(&self) -> Option<&dyn skills_module::SkillRuntimeOps> {
        Some(self)
    }

    fn host_lifecycle_ops(&self) -> Option<&dyn LifecycleOps> {
        Some(self)
    }

    fn runtime_control_ops(&self) -> Option<&dyn RuntimeControlOps> {
        Some(self)
    }

    fn provider_module_config_ops(&self) -> Option<&dyn provider_module::ProviderConfigOps> {
        Some(self)
    }

    fn provider_module_model_discovery_ops(
        &self,
    ) -> Option<&dyn provider_module::ProviderModelDiscoveryOps> {
        Some(self)
    }

    fn provider_module_private_projection_ops(
        &self,
    ) -> Option<&dyn provider_module::ProviderPrivateProjectionOps> {
        Some(self)
    }

    fn connector_ops(&self) -> Option<&dyn ::connectors::ports::ConnectorOps> {
        Some(self)
    }

    fn security_ops(&self) -> Option<&dyn security::ports::SecurityOps> {
        Some(self)
    }

    fn settings_ops(&self) -> Option<&dyn ::settings::ports::SettingsOps> {
        Some(self)
    }
}
