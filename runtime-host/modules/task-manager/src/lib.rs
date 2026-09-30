mod adapters;
mod api;
mod application;
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

use api::TaskHandle;
use owner::actor::TaskOwner;

const MODULE_ID: ModuleId = ModuleId::new("task-manager");
const PROVIDES: &[CapabilityKey] = &[CapabilityKey::new("task.management")];
const REQUIRES: &[CapabilityKey] = &[CapabilityKey::new("runtime.task-manager")];
const ROUTES: &[&str] = &["task-manager.loopback"];
const EVENTS: &[&str] = &[];
const EFFECTS: &[EffectKind] = &[EffectKind::OwnerTask, EffectKind::Route];

pub use domain::model::{
    CreateOutcome, GetOutcome, ListOutcome, SessionTarget, Task, TaskCommand, TaskCreate,
    TaskCreateReceipt, TaskInputError, TaskMetadata, TaskMutationOutcome, TaskOutcome,
    TaskReadFailure, TaskReadOutcome, TaskRuntimeFailure, TaskSnapshot, TaskStatus, TaskTarget,
    TaskUpdate, Todo, TodoGetOutcome, TodoSnapshot, TodoStatus, TodoWriteOutcome, UpdateOutcome,
};
pub use owner::actor::TaskOwnerInput;
pub use ports::{
    TaskFuture, TaskOps, TaskRequestAdmission, TaskRequestAdmissionClosed, TaskRuntimeDirectory,
};

#[derive(Clone)]
pub struct TaskModule {
    handle: TaskHandle,
}

impl TaskModule {
    fn new(handle: TaskHandle) -> Self {
        Self { handle }
    }

    pub fn with_call_recorder(mut self, recorder: CallRecorder) -> Self {
        self.handle = self.handle.with_call_recorder(recorder);
        self
    }

    pub async fn task_manager(&self, command: TaskCommand) -> Result<TaskOutcome, ()> {
        self.handle.task_manager(command).await
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
    input: TaskOwnerInput,
) -> (TaskModule, OwnedTask<()>) {
    let owner = TaskOwner::new(input);
    let (handle, task) = system.spawn_owner(
        owner,
        OwnerRuntimeConfig::new(16, TaskOwner::lane_retention()),
    );
    (TaskModule::new(TaskHandle::new(handle)), task)
}
