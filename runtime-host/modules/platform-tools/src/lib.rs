mod adapters;
mod api;
mod application;
pub mod capability;
mod domain;
mod owner;
pub mod ports;
mod projection;

use std::sync::Arc;

use platform::{
    capability::CapabilityDecisionVerifier,
    module::{CapabilityDescriptorProvider, CapabilityKey, EffectKind, ModuleDescriptor, ModuleId},
};
use tokio::sync::Mutex;

const MODULE_ID: ModuleId = ModuleId::new("platform-tools");
const PROVIDES: &[CapabilityKey] = &[
    CapabilityKey::new("platform.tools"),
    CapabilityKey::new("tool.invoke"),
];
const REQUIRES: &[CapabilityKey] = &[CapabilityKey::new("runtime.platform-tools")];
const ROUTES: &[&str] = &["platform-tools.loopback"];
const EVENTS: &[&str] = &[];
const EFFECTS: &[EffectKind] = &[EffectKind::OwnerTask, EffectKind::Route];

pub use api::PlatformToolsModule;
pub use domain::model::{
    PlatformTool, PlatformToolsCallDetail, PlatformToolsCallResult, PlatformToolsOutcome,
};
pub use owner::{PlatformToolsOwnerInput, spawn_owner};
pub use ports::{
    PlatformToolsFuture, PlatformToolsOps, PlatformToolsRequestAdmission,
    PlatformToolsRequestAdmissionClosed,
};
pub use projection::public as delivery;

impl PlatformToolsModule {
    pub fn descriptor(&self, verifier: Arc<Mutex<CapabilityDecisionVerifier>>) -> ModuleDescriptor {
        ModuleDescriptor::with_capabilities(
            MODULE_ID,
            PROVIDES,
            REQUIRES,
            EFFECTS,
            ROUTES,
            EVENTS,
            Some(self.loopback_descriptor(verifier)),
            Some(CapabilityDescriptorProvider::new(
                capability::listed,
                capability::describe,
            )),
        )
    }

    fn loopback_descriptor(
        &self,
        verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    ) -> platform::loopback::ModuleDescriptor {
        adapters::loopback::descriptor(adapters::loopback::Dependencies::new(
            verifier,
            self.clone(),
        ))
    }
}
