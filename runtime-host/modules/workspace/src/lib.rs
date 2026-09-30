mod adapters;
mod api;
mod application;
mod call;
pub mod capability;
mod domain;
mod owner;
pub mod ports;

use std::sync::Arc;

use foundation::execution::{OwnedTask, OwnerRuntimeConfig, OwnerRuntimeSystem};
use platform::{
    call::CallRecorder,
    capability::CapabilityDecisionVerifier,
    module::{CapabilityDescriptorProvider, CapabilityKey, EffectKind, ModuleDescriptor, ModuleId},
};
use tokio::sync::Mutex;

use api::WorkspaceHandle;
use owner::actor::WorkspaceOwner;

const MODULE_ID: ModuleId = ModuleId::new("workspace");
const PROVIDES: &[CapabilityKey] = &[
    CapabilityKey::new("workspace.file"),
    CapabilityKey::new("workspace.media"),
];
const REQUIRES: &[CapabilityKey] = &[CapabilityKey::new("runtime.workspace")];
const ROUTES: &[&str] = &["workspace.loopback"];
const EVENTS: &[&str] = &[];
const EFFECTS: &[EffectKind] = &[EffectKind::OwnerTask, EffectKind::Route];

pub use domain::model::{
    ResolvedWorkspaceMedia, WorkspaceBinaryFailure, WorkspaceBinaryReceipt,
    WorkspaceDirectoryEntry, WorkspaceDirectoryFailure, WorkspaceDirectoryReceipt,
    WorkspaceDirectoryRoot, WorkspaceListFailure, WorkspaceMediaFailure, WorkspaceMediaPath,
    WorkspaceMediaReceipt, WorkspaceMediaThumbnail, WorkspaceMediaThumbnailEntry,
    WorkspaceReadFailure, WorkspaceStatFailure, WorkspaceStatReceipt, WorkspaceTextReceipt,
    WorkspaceWriteFailure, WorkspaceWriteReceipt,
};
pub use owner::actor::WorkspaceOwnerInput;
pub use ports::{
    WorkspaceOps, WorkspaceRequestAdmission, WorkspaceRequestAdmissionClosed,
    WorkspaceRuntimeDirectory,
};

#[derive(Clone)]
pub struct WorkspaceModule {
    handle: WorkspaceHandle,
}

impl WorkspaceModule {
    fn new(handle: WorkspaceHandle) -> Self {
        Self { handle }
    }

    pub fn with_call_recorder(mut self, recorder: CallRecorder) -> Self {
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
        ))
    }
}

pub fn spawn_owner(
    system: &OwnerRuntimeSystem,
    input: WorkspaceOwnerInput,
) -> (WorkspaceModule, OwnedTask<()>) {
    let owner = WorkspaceOwner::new(input);
    let (handle, task) = system.spawn_owner(
        owner,
        OwnerRuntimeConfig::new(16, WorkspaceOwner::lane_retention()),
    );
    (WorkspaceModule::new(WorkspaceHandle::new(handle)), task)
}
