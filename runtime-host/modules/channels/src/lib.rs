mod adapters;
mod api;
mod application;
pub mod capability;
mod domain;
mod owner;
pub mod ports;
mod projection;

use std::sync::Arc;

use foundation::execution::{OwnedTask, OwnerRuntimeConfig, OwnerRuntimeSystem};
use platform::{
    capability::CapabilityDecisionVerifier,
    endpoint::runtime_address::RuntimeEndpoint,
    module::{CapabilityDescriptorProvider, CapabilityKey, EffectKind, ModuleDescriptor, ModuleId},
};
use tokio::sync::Mutex;

use api::ChannelHandle;
use owner::actor::ChannelOwner;

const MODULE_ID: ModuleId = ModuleId::new("channel");
const PROVIDES: &[CapabilityKey] = &[CapabilityKey::new("channels")];
const REQUIRES: &[CapabilityKey] = &[CapabilityKey::new("runtime.channels")];
const ROUTES: &[&str] = &["channel.loopback"];
const EVENTS: &[&str] = &[];
const EFFECTS: &[EffectKind] = &[EffectKind::OwnerTask, EffectKind::Route];

pub use owner::actor::ChannelOwnerInput;

pub use application::{call, trace};
pub use domain::{catalog, control, credentials, delete, login, status};
pub use projection::config_read;

#[derive(Clone)]
pub struct ChannelModule {
    handle: ChannelHandle,
    endpoint: RuntimeEndpoint,
}

impl ChannelModule {
    fn new(handle: ChannelHandle, endpoint: RuntimeEndpoint) -> Self {
        Self { handle, endpoint }
    }

    pub fn with_call_recorder(mut self, recorder: platform::call::CallRecorder) -> Self {
        self.handle = self.handle.with_call_recorder(recorder);
        self
    }

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
            self.handle.clone(),
            self.endpoint.clone(),
        ))
    }
}

pub fn spawn_owner(
    system: &OwnerRuntimeSystem,
    input: ChannelOwnerInput,
) -> (ChannelModule, OwnedTask<()>) {
    let endpoint = input.default_endpoint.clone();
    let owner = ChannelOwner::new(input);
    let (handle, task) = system.spawn_owner(
        owner,
        OwnerRuntimeConfig::new(64, ChannelOwner::lane_retention()),
    );
    (
        ChannelModule::new(ChannelHandle::new(handle), endpoint),
        task,
    )
}
