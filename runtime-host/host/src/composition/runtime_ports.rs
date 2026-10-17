use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use matcha_agent::driver::MatchaRuntimeDriver;
use openclaw::driver::OpenClawDriver;
use platform::endpoint::runtime_address::{RuntimeEndpoint, SessionIdentity};
use runtime_directory::RuntimeDriverRegistry;

pub(crate) use runtime_directory::{
    LifecycleOps, RuntimeControlFailure, RuntimeControlOps, RuntimeControlReadiness,
    RuntimeDriverIdentity, RuntimeGatewayHealth, RuntimeGatewayStatus, RuntimeLifecycleFailure,
    RuntimeLogSnapshot, RuntimeStartFailure,
};

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

    fn provider_module_runtime_identity_ops(
        &self,
    ) -> Option<&dyn provider_module::ProviderRuntimeIdentityOps> {
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

    fn native_policy_ops(&self) -> Option<&dyn security::native_policy::NativePolicyOps> {
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

    fn native_policy_ops_for_endpoint(
        &self,
        endpoint: &RuntimeEndpoint,
    ) -> Option<&dyn security::native_policy::NativePolicyOps> {
        self.driver_ref(endpoint)?.native_policy_ops()
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
    fn cron_ops(&self, endpoint: &RuntimeEndpoint) -> Option<&dyn ::cron::CronOps> {
        self.driver_ref(endpoint)?.cron_ops()
    }
}

impl task_manager::TaskRuntimeDirectory for RuntimeDriverDirectory {
    fn task_ops(
        &self,
        scope: &platform::endpoint::runtime_address::RuntimeScope,
    ) -> Option<&dyn task_manager::TaskOps> {
        let platform::endpoint::runtime_address::RuntimeScope::Session(identity) = scope else {
            return None;
        };
        self.driver_ref(identity.endpoint())?.task_ops()
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

impl skills_module::SkillsRuntimeDirectory for RuntimeDriverDirectory {
    fn skill_ops(&self, endpoint: &RuntimeEndpoint) -> Option<&dyn skills_module::SkillRuntimeOps> {
        self.driver_ref(endpoint)?.skill_ops()
    }
}

impl workspace::WorkspaceRuntimeDirectory for RuntimeDriverDirectory {
    fn workspace_ops(&self, endpoint: &RuntimeEndpoint) -> Option<&dyn workspace::WorkspaceOps> {
        self.driver_ref(endpoint)?.workspace_ops()
    }
}

impl usage::UsageRuntimeDirectory for RuntimeDriverDirectory {
    fn usage_ops(&self, endpoint: &RuntimeEndpoint) -> Option<&dyn usage::UsageOps> {
        self.driver_ref(endpoint)?.usage_ops()
    }
}

impl connectors::ports::ConnectorRuntimeDirectory for RuntimeDriverDirectory {
    fn connector_endpoints(&self) -> Vec<RuntimeEndpoint> {
        if self.is_closed() {
            return Vec::new();
        }
        self.drivers.all_drivers_ref()
            .filter(|driver| driver.connector_ops().is_some())
            .map(|driver| driver.endpoint())
            .collect()
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
        endpoint: &RuntimeEndpoint,
    ) -> Option<&dyn provider_module::ProviderRuntimeIdentityOps> {
        self.driver_ref(endpoint)?.provider_module_runtime_identity_ops()
    }

    fn provider_private_projection_ops(
        &self,
        endpoint: &RuntimeEndpoint,
    ) -> Option<&dyn provider_module::ProviderPrivateProjectionOps> {
        self.driver_ref(endpoint)?.provider_module_private_projection_ops()
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

    fn ownership_receipt_key(
        &self,
        receipt: &organization::RoleSessionReceipt,
    ) -> Option<(RuntimeEndpoint, Option<String>, String)> {
        let runtime = RuntimeDriverIdentity::from_reference(receipt.endpoint().as_str())?;
        Some(if runtime == RuntimeDriverIdentity::matcha_agent() {
            matcha_agent::session::projection::session_ownership_key(
                runtime.endpoint(),
                receipt.agent().as_str(),
                "",
                receipt.endpoint_session_id().as_str(),
            )
        } else {
            let session_key = self.session_key(receipt)?;
            openclaw::session::session_ownership_key(
                runtime.endpoint(),
                receipt.agent().as_str(),
                &session_key,
                receipt.endpoint_session_id().as_str(),
            )
        })
    }

    fn ownership_query_key(
        &self,
        identity: &SessionIdentity,
        endpoint_session_id: &str,
    ) -> (RuntimeEndpoint, Option<String>, String) {
        if identity.endpoint() == &RuntimeDriverIdentity::matcha_agent().endpoint() {
            matcha_agent::session::projection::session_ownership_key(
                identity.endpoint().clone(),
                identity.agent_id(),
                identity.session_key(),
                endpoint_session_id,
            )
        } else {
            openclaw::session::session_ownership_key(
                identity.endpoint().clone(),
                identity.agent_id(),
                identity.session_key(),
                endpoint_session_id,
            )
        }
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

    pub(crate) fn supports_goal(&self, endpoint: &RuntimeEndpoint) -> bool {
        self.driver_ref(endpoint).and_then(|driver| driver.session_ops()).is_some_and(|ops| ops.supports_goal())
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

impl RuntimeDriver for MatchaRuntimeDriver {
    fn task_ops(&self) -> Option<&dyn task_manager::TaskOps> {
        Some(self)
    }

    fn channel_ops(&self) -> Option<&dyn channels::ports::ChannelOps> {
        Some(self.native_channels())
    }

    fn subagent_ops(&self) -> Option<&dyn subagents::SubagentOps> {
        Some(self)
    }

    fn skill_ops(&self) -> Option<&dyn skills_module::SkillRuntimeOps> {
        Some(self)
    }

    fn workspace_ops(&self) -> Option<&dyn workspace::WorkspaceOps> {
        Some(self)
    }

    fn connector_ops(&self) -> Option<&dyn ::connectors::ports::ConnectorOps> {
        Some(self)
    }

    fn native_policy_ops(&self) -> Option<&dyn security::native_policy::NativePolicyOps> {
        Some(self)
    }

    fn runtime_control_ops(&self) -> Option<&dyn RuntimeControlOps> {
        Some(self)
    }

    fn cron_ops(&self) -> Option<&dyn ::cron::CronOps> {
        Some(self)
    }

    fn usage_ops(&self) -> Option<&dyn ::usage::UsageOps> {
        Some(self)
    }

    fn host_lifecycle_ops(&self) -> Option<&dyn LifecycleOps> {
        Some(self)
    }

    fn provider_module_config_ops(&self) -> Option<&dyn provider_module::ProviderConfigOps> {
        Some(self)
    }

    fn provider_module_runtime_identity_ops(
        &self,
    ) -> Option<&dyn provider_module::ProviderRuntimeIdentityOps> {
        Some(self)
    }

    fn provider_module_private_projection_ops(
        &self,
    ) -> Option<&dyn provider_module::ProviderPrivateProjectionOps> {
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

    fn provider_module_runtime_identity_ops(
        &self,
    ) -> Option<&dyn provider_module::ProviderRuntimeIdentityOps> {
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
