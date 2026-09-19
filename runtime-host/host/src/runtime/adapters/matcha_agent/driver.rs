use super::*;

impl RuntimeDriver for MatchaAgentInstance {
    fn identity(&self) -> RuntimeDriverIdentity {
        RuntimeDriverIdentity::matcha_agent()
    }

    fn capability_surface(&self) -> RuntimeCapabilitySurface {
        RuntimeCapabilitySurface::matcha_agent()
    }

    fn session_ops(&self) -> Option<&dyn SessionOps> {
        Some(&self.team)
    }

    fn team_ops(&self) -> Option<&dyn TeamOps> {
        Some(self)
    }

    fn lifecycle_ops(&self) -> Option<&dyn LifecycleOps> {
        Some(self)
    }
}

impl RuntimeDriver for MatchaRuntimeDriver {
    fn identity(&self) -> RuntimeDriverIdentity {
        RuntimeDriverIdentity::matcha_agent()
    }

    fn capability_surface(&self) -> RuntimeCapabilitySurface {
        RuntimeCapabilitySurface::matcha_agent()
    }

    fn session_ops(&self) -> Option<&dyn SessionOps> {
        Some(self)
    }

    fn team_ops(&self) -> Option<&dyn TeamOps> {
        Some(self)
    }

    fn lifecycle_ops(&self) -> Option<&dyn LifecycleOps> {
        Some(self)
    }
}
