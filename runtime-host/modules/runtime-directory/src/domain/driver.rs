use platform::endpoint::runtime_address::RuntimeEndpoint;

use super::{
    control::RuntimeControlOps, identity::RuntimeDriverIdentity, lifecycle::LifecycleOps,
    surface::RuntimeCapabilitySurface,
};

pub trait RuntimeDriver: Send + Sync {
    fn identity(&self) -> RuntimeDriverIdentity;

    fn endpoint(&self) -> RuntimeEndpoint {
        self.identity().endpoint()
    }

    fn capability_surface(&self) -> RuntimeCapabilitySurface;

    fn lifecycle_ops(&self) -> Option<&dyn LifecycleOps> {
        None
    }

    fn runtime_control_ops(&self) -> Option<&dyn RuntimeControlOps> {
        None
    }
}
