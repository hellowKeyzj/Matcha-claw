pub(crate) mod actor;

use foundation::execution::{OwnedTask, OwnerRuntimeConfig, OwnerRuntimeSystem};

use crate::PlatformToolsModule;

pub use actor::PlatformToolsOwnerInput;

pub fn spawn_owner(
    system: &OwnerRuntimeSystem,
    input: PlatformToolsOwnerInput,
) -> (PlatformToolsModule, OwnedTask<()>) {
    let owner = actor::PlatformToolsOwner::new(input);
    let (handle, task) = system.spawn_owner(
        owner,
        OwnerRuntimeConfig::new(16, actor::PlatformToolsOwner::lane_retention()),
    );
    (PlatformToolsModule::new(handle), task)
}
