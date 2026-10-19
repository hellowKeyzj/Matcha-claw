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
pub use ports::{RuntimeSearchFuture, RuntimeSearchPort, RuntimeSearchProjection};

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
) -> Result<(SearchModule, OwnedTask<()>), SearchError> {
    let owner = owner::SearchOwner::open(input)?;
    let (handle, task) = system.spawn_owner(
        owner,
        OwnerRuntimeConfig::new(16, LaneRetention::LowFrequency),
    );
    Ok((SearchModule::new(handle), task))
}
