mod adapters;
mod api;
mod application;
mod domain;
mod owner;
pub mod ports;
mod projection;

use std::sync::Arc;

use foundation::execution::{OwnedTask, OwnerRuntimeConfig, OwnerRuntimeSystem};
use platform::{
    call::CallRecorder,
    capability::CapabilityDecisionVerifier,
    module::{CapabilityKey, EffectKind, ModuleDescriptor, ModuleId},
};
use tokio::sync::Mutex;

use api::SettingsHandle;
use owner::SettingsOwner;

const MODULE_ID: ModuleId = ModuleId::new("settings");
const PROVIDES: &[CapabilityKey] = &[CapabilityKey::new("settings")];
const REQUIRES: &[CapabilityKey] = &[CapabilityKey::new("runtime.settings")];
const ROUTES: &[&str] = &["settings.loopback"];
const EVENTS: &[&str] = &[];
const EFFECTS: &[EffectKind] = &[EffectKind::OwnerTask, EffectKind::Route];

pub use adapters::store::{DesiredSnapshot, DesiredState, PendingDesired, SettingsSnapshot};
pub use application::receipts::Outcome as DesiredOutcome;
pub use domain::{BrowserMode, Desired, InvalidDesired, ProxyDesired};
pub use owner::SettingsOwnerInput;

#[derive(Clone)]
pub struct SettingsModule {
    handle: SettingsHandle,
    call_recorder: Option<CallRecorder>,
}

impl SettingsModule {
    fn new(handle: SettingsHandle) -> Self {
        Self {
            handle,
            call_recorder: None,
        }
    }

    pub fn with_call_recorder(mut self, recorder: CallRecorder) -> Self {
        self.call_recorder = Some(recorder);
        self
    }

    pub async fn recover_pending(&self) {
        self.handle.recover_pending().await
    }

    pub async fn apply_saved_projection(&self) -> DesiredOutcome {
        self.handle.apply_saved_projection().await
    }

    pub async fn gateway_auto_start(&self) -> bool {
        self.handle.gateway_auto_start().await
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
            self.call_recorder.clone(),
        ))
    }
}

pub fn spawn_owner(
    system: &OwnerRuntimeSystem,
    input: SettingsOwnerInput,
) -> Result<(SettingsModule, OwnedTask<()>), ()> {
    let owner = SettingsOwner::new(input)?;
    let (handle, task) = system.spawn_owner(
        owner,
        OwnerRuntimeConfig::new(64, SettingsOwner::lane_retention()),
    );
    Ok((SettingsModule::new(SettingsHandle::new(handle)), task))
}
