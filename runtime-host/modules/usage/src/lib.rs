mod adapters;
mod api;
mod application;
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

use api::UsageHandle;
use owner::UsageOwner;

const MODULE_ID: ModuleId = ModuleId::new("usage");
const PROVIDES: &[CapabilityKey] = &[CapabilityKey::new("usage")];
const REQUIRES: &[CapabilityKey] = &[CapabilityKey::new("runtime.usage")];
const ROUTES: &[&str] = &["usage.loopback"];
const EVENTS: &[&str] = &[];
const EFFECTS: &[EffectKind] = &[EffectKind::OwnerTask, EffectKind::Route];

pub use domain::model::{UsageEntry, UsageReadError};
pub use owner::UsageOwnerInput;
pub use ports::{
    UsageOps, UsageRequestAdmission, UsageRequestAdmissionClosed, UsageRuntimeDirectory,
};

#[derive(Clone)]
pub struct UsageModule {
    handle: UsageHandle,
}

impl UsageModule {
    fn new(handle: UsageHandle) -> Self {
        Self { handle }
    }

    pub fn with_call_recorder(mut self, recorder: platform::call::CallRecorder) -> Self {
        self.handle = self.handle.with_call_recorder(recorder);
        self
    }

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

pub fn spawn_owner(
    system: &OwnerRuntimeSystem,
    input: UsageOwnerInput,
) -> (UsageModule, OwnedTask<()>) {
    let owner = UsageOwner::new(input);
    let (handle, task) = system.spawn_owner(
        owner,
        OwnerRuntimeConfig::new(64, UsageOwner::lane_retention()),
    );
    (UsageModule::new(UsageHandle::new(handle)), task)
}
