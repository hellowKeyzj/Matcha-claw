mod adapters;
mod api;
mod application;
mod call;
pub mod capability;
mod domain;
mod owner;
pub mod ports;
mod projection;

use std::sync::Arc;

use foundation::execution::{OwnedTask, OwnerRuntimeConfig, OwnerRuntimeSystem};
use platform::{
    capability::CapabilityDecisionVerifier,
    module::{CapabilityDescriptorProvider, CapabilityKey, EffectKind, ModuleDescriptor, ModuleId},
};
use tokio::sync::Mutex;

use api::CronHandle;
use owner::actor::CronOwner;

const MODULE_ID: ModuleId = ModuleId::new("cron");
const PROVIDES: &[CapabilityKey] = &[CapabilityKey::new("scheduler.cron")];
const REQUIRES: &[CapabilityKey] = &[CapabilityKey::new("runtime.cron")];
const ROUTES: &[&str] = &["cron.loopback"];
const EVENTS: &[&str] = &[];
const EFFECTS: &[EffectKind] = &[EffectKind::OwnerTask, EffectKind::Route];

pub use domain::model::{self, *};
pub use owner::actor::CronOwnerInput;
pub use ports::{
    CronOps, CronRequestAdmission, CronRequestAdmissionClosed, CronRuntimeDirectory,
    CronSessionHistoryFailure, CronSessionHistoryPort,
};

#[derive(Clone)]
pub struct CronModule {
    handle: CronHandle,
}

impl CronModule {
    fn new(handle: CronHandle) -> Self {
        Self { handle }
    }

    pub fn with_call_recorder(mut self, recorder: platform::call::CallRecorder) -> Self {
        self.handle = self.handle.with_call_recorder(recorder);
        self
    }

    pub async fn cancel_operations(&self) {
        let _ = self.handle.cancel_operations().await;
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
        ))
    }
}

pub fn spawn_owner(
    system: &OwnerRuntimeSystem,
    input: CronOwnerInput,
) -> (CronModule, OwnedTask<()>) {
    let results = application::results::MutationResults::default();
    let owner = CronOwner::new(input, results.clone());
    let (handle, task) = system.spawn_owner(
        owner,
        OwnerRuntimeConfig::new(64, CronOwner::lane_retention()),
    );
    (CronModule::new(CronHandle::new(handle, results)), task)
}
