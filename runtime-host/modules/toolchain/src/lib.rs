mod adapters;
mod api;
mod application;
pub mod control;
mod domain;
mod owner;
pub mod ports;

use std::sync::Arc;

use foundation::execution::{OwnedTask, OwnerRuntimeConfig, OwnerRuntimeSystem};
use platform::{
    capability::CapabilityDecisionVerifier,
    module::{CapabilityKey, EffectKind, ModuleDescriptor, ModuleId},
};
use tokio::sync::Mutex;

const MODULE_ID: ModuleId = ModuleId::new("toolchain");
const PROVIDES: &[CapabilityKey] = &[CapabilityKey::new("toolchain")];
const REQUIRES: &[CapabilityKey] = &[CapabilityKey::new("external.toolchain.native")];
const ROUTES: &[&str] = &["toolchain.loopback"];
const EVENTS: &[&str] = &[];
const EFFECTS: &[EffectKind] = &[EffectKind::OwnerTask, EffectKind::Route];

pub use adapters::native::{
    FoundationToolchainCommandPort, NativeToolchain, PrivateEnvVar, ToolchainCommandFuture,
    ToolchainCommandOutcome, ToolchainCommandPort, ToolchainCommandRequest, ToolchainEnvProjection,
    ToolchainEnvProjectionStatus, ToolchainPlatform, ToolchainPythonResolution,
    UnsupportedToolchainCommandPort,
};
pub use api::ToolchainModule;
pub use domain::model::{
    PrepareOutcome, PythonReadiness, ToolAvailability, ToolchainError, ToolchainStatus,
};
pub use owner::actor::ToolchainOwnerInput;
pub use ports::{ToolchainRequestAdmission, ToolchainRequestAdmissionClosed};

impl ToolchainModule {
    pub fn descriptor(&self, verifier: Arc<Mutex<CapabilityDecisionVerifier>>) -> ModuleDescriptor {
        ModuleDescriptor::new(
            MODULE_ID,
            PROVIDES,
            REQUIRES,
            EFFECTS,
            ROUTES,
            EVENTS,
            Some(adapters::loopback::descriptor(
                adapters::loopback::Dependencies::new(verifier, self.clone()),
            )),
        )
    }
}

pub fn spawn_owner(
    system: &OwnerRuntimeSystem,
    input: ToolchainOwnerInput,
) -> (ToolchainModule, OwnedTask<()>) {
    let owner = owner::actor::ToolchainOwner::new(input);
    let (handle, task) = system.spawn_owner(
        owner,
        OwnerRuntimeConfig::new(16, owner::actor::ToolchainOwner::lane_retention()),
    );
    (ToolchainModule::new(handle), task)
}
