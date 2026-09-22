mod adapters;
mod api;
mod application;
mod domain;
mod owner;
pub mod ports;

use std::sync::Arc;

use platform::{
    capability::CapabilityDecisionVerifier,
    module::{CapabilityKey, EffectKind, ModuleDescriptor, ModuleId},
};
use tokio::sync::Mutex;

const MODULE_ID: ModuleId = ModuleId::new("security");
const PROVIDES: &[CapabilityKey] = &[CapabilityKey::new("security.policy")];
const REQUIRES: &[CapabilityKey] = &[CapabilityKey::new("runtime.security")];
const ROUTES: &[&str] = &["security.loopback"];
const EVENTS: &[&str] = &[];
const EFFECTS: &[EffectKind] = &[EffectKind::OwnerTask, EffectKind::Route];

pub use api::{SecurityModule, spawn_owner};
pub use application::commands::SecurityOwnerUnavailable;
pub use domain::model::{audit, delivery, emergency, operation};
pub use owner::SecurityOwnerInput;

impl SecurityModule {
    pub fn descriptor(&self, verifier: Arc<Mutex<CapabilityDecisionVerifier>>) -> ModuleDescriptor {
        ModuleDescriptor::new(
            MODULE_ID,
            PROVIDES,
            REQUIRES,
            EFFECTS,
            ROUTES,
            EVENTS,
            Some(self.loopback_descriptor(verifier)),
        )
    }

    fn loopback_descriptor(
        &self,
        verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    ) -> platform::loopback::ModuleDescriptor {
        adapters::loopback::descriptor(adapters::loopback::Dependencies::new(
            verifier,
            self.handle.clone(),
        ))
    }
}
