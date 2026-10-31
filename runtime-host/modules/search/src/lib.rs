mod api;
mod loopback;
mod model;
mod owner;
pub mod ports;
mod store;

use std::sync::Arc;

use foundation::execution::{LaneRetention, OwnedTask, OwnerRuntimeConfig, OwnerRuntimeSystem};
use platform::{
    capability::CapabilityDecisionVerifier,
    module::{CapabilityKey, EffectKind, ModuleDescriptor, ModuleId},
};
use tokio::sync::Mutex;

pub use api::SearchModule;
pub use model::*;
pub use owner::SearchOwnerInput;
pub use ports::{
    RuntimeSearchFuture, RuntimeSearchPort, RuntimeSearchProjection, SearchLifecycleFuture,
    SearchLifecycleSource,
};

const PROVIDES: &[CapabilityKey] = &[CapabilityKey::new("search")];
const REQUIRES: &[CapabilityKey] = &[CapabilityKey::new("runtime.directory")];

impl SearchModule {
    pub fn descriptor(&self, verifier: Arc<Mutex<CapabilityDecisionVerifier>>) -> ModuleDescriptor {
        ModuleDescriptor::new(
            ModuleId::new("search"),
            PROVIDES,
            REQUIRES,
            &[
                EffectKind::OwnerTask,
                EffectKind::Route,
                EffectKind::EventSubscription,
            ],
            &["search.loopback"],
            &["search-runtime-lifecycle"],
            Some(loopback::descriptor(self.clone(), verifier)),
        )
    }
}

pub fn spawn_owner(
    system: &OwnerRuntimeSystem,
    input: SearchOwnerInput,
) -> (SearchModule, OwnedTask<()>) {
    let path = input.state_dir.clone();
    let owner = owner::SearchOwner::new(input);
    let shared = owner.shared.clone();
    let (handle, task) = system.spawn_owner(
        owner,
        OwnerRuntimeConfig::new(16, LaneRetention::LowFrequency),
    );
    handle
        .try_send_command(owner::Command::Initialize(path))
        .expect("new search owner accepts initialization");
    (SearchModule::new(handle, shared), task)
}
