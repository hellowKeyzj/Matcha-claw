use runtime_directory::{
    LifecycleOps, RuntimeCapabilitySurface, RuntimeControlOps, RuntimeDriver, RuntimeDriverIdentity,
};
use sessions_module::SessionOps;

use crate::driver::OpenClawDriver;

impl sessions_module::RuntimeDriver for OpenClawDriver {
    fn identity(&self) -> RuntimeDriverIdentity {
        RuntimeDriverIdentity::open_claw()
    }

    fn session_ops(&self) -> Option<&dyn SessionOps> {
        Some(self)
    }

    fn lifecycle_ops(&self) -> Option<&dyn LifecycleOps> {
        Some(self)
    }
}

impl RuntimeDriver for OpenClawDriver {
    fn identity(&self) -> RuntimeDriverIdentity {
        RuntimeDriverIdentity::open_claw()
    }

    fn capability_surface(&self) -> RuntimeCapabilitySurface {
        RuntimeCapabilitySurface::open_claw()
    }

    fn lifecycle_ops(&self) -> Option<&dyn LifecycleOps> {
        Some(self)
    }

    fn runtime_control_ops(&self) -> Option<&dyn RuntimeControlOps> {
        Some(self)
    }
}
