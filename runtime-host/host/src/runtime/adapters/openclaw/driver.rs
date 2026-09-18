use super::*;

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

    fn team_terminal_ops(&self) -> Option<&dyn TeamTerminalOps> {
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

    fn connector_ops(&self) -> Option<&dyn ConnectorOps> {
        Some(self)
    }

    fn security_ops(&self) -> Option<&dyn SecurityOps> {
        Some(self)
    }

    fn settings_ops(&self) -> Option<&dyn SettingsOps> {
        Some(self)
    }
}
