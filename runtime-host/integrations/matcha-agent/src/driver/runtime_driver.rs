use super::*;

impl sessions_module::RuntimeDriver for MatchaRuntimeDriver {
    fn identity(&self) -> RuntimeDriverIdentity {
        RuntimeDriverIdentity::matcha_agent()
    }

    fn session_ops(&self) -> Option<&dyn sessions_module::SessionOps> {
        Some(self)
    }

    fn lifecycle_ops(&self) -> Option<&dyn sessions_module::LifecycleOps> {
        Some(self)
    }
}

impl runtime_directory::RuntimeDriver for MatchaRuntimeDriver {
    fn identity(&self) -> RuntimeDriverIdentity {
        RuntimeDriverIdentity::matcha_agent()
    }

    fn capability_surface(&self) -> RuntimeCapabilitySurface {
        RuntimeCapabilitySurface::matcha_agent()
    }

    fn lifecycle_ops(&self) -> Option<&dyn LifecycleOps> {
        Some(self)
    }
}
