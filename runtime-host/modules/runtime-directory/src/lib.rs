mod adapters;
pub mod control_loopback;
mod directory;
pub mod domain;
pub mod ports;
pub mod projection;
mod registry;

use std::sync::Arc;

use platform::{
    capability::CapabilityDecisionVerifier,
    module::{CapabilityKey, EffectKind, ModuleDescriptor, ModuleId},
};
use tokio::sync::Mutex;

pub use directory::{
    Agent, Capabilities, CapabilityFamily, ControlState, Directory, Endpoint, HostRuntimeDirectory,
    Lifecycle, Location, NativeEndpointRef, Readiness, RuntimeEndpointReadiness, RuntimeLifecycle,
    Source,
};
pub use domain::{
    control::{
        RuntimeControlFailure, RuntimeControlLifecycle, RuntimeControlLifecycleError,
        RuntimeControlLifecycleFailure, RuntimeControlLifecycleStatus, RuntimeControlOps,
        RuntimeControlReadiness, RuntimeControlStartupDiagnostic, RuntimeGatewayHealth,
        RuntimeGatewayStatus, RuntimeLogEntry, RuntimeLogSnapshot,
    },
    driver::RuntimeDriver,
    identity::RuntimeDriverIdentity,
    lifecycle::{LifecycleOps, OwnedRuntimeFuture, RuntimeLifecycleFailure, RuntimeStartFailure},
    surface::{RuntimeCapabilityFamily, RuntimeCapabilitySurface, RuntimeFamilyAvailability},
};
pub use ports::{RuntimeEndpointDirectoryFuture, RuntimeEndpointDirectorySource};
pub use registry::RuntimeDriverDirectory as RuntimeDriverRegistry;

const MODULE_ID: ModuleId = ModuleId::new("runtime-directory");
const PROVIDES: &[CapabilityKey] = &[CapabilityKey::new("runtime.directory")];
const REQUIRES: &[CapabilityKey] = &[];
const ROUTES: &[&str] = &["runtime-directory.loopback"];
const EVENTS: &[&str] = &[];
const EFFECTS: &[EffectKind] = &[EffectKind::Route, EffectKind::RuntimeEndpoint];

#[derive(Clone)]
pub struct RuntimeDirectoryModule {
    directory: Arc<dyn RuntimeEndpointDirectorySource>,
}

impl RuntimeDirectoryModule {
    pub fn new(directory: Arc<dyn RuntimeEndpointDirectorySource>) -> Self {
        Self { directory }
    }

    pub fn descriptor(&self, verifier: Arc<Mutex<CapabilityDecisionVerifier>>) -> ModuleDescriptor {
        ModuleDescriptor::new(
            MODULE_ID,
            PROVIDES,
            REQUIRES,
            EFFECTS,
            ROUTES,
            EVENTS,
            Some(adapters::loopback::descriptor(
                adapters::loopback::Dependencies::new(verifier, Arc::clone(&self.directory)),
            )),
        )
    }
}
