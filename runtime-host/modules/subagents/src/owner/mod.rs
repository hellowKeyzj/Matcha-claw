pub(crate) mod actor;

use std::sync::Arc;

use foundation::execution::{OwnedTask, OwnerRuntimeConfig, OwnerRuntimeSystem};

use crate::{SubagentsModule, api::SubagentHandle};

use actor::SubagentOwner;
pub use actor::SubagentOwnerInput;

pub fn spawn_owner(
    system: &OwnerRuntimeSystem,
    input: SubagentOwnerInput,
) -> (SubagentsModule, OwnedTask<()>) {
    let sealed_agents = Arc::clone(&input.sealed_agents);
    let results = crate::application::results::MutationResults::default();
    let owner = SubagentOwner::new(input, results.clone());
    let (handle, task) = system.spawn_owner(
        owner,
        OwnerRuntimeConfig::new(16, SubagentOwner::lane_retention()),
    );
    (
        SubagentsModule::new(SubagentHandle::new(handle, results), sealed_agents),
        task,
    )
}
