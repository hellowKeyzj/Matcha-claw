use crate::owner::handle::OrganizationHandle;

pub use crate::application::start_gate_control::{
    StartGatePromptPlan, StartGateRuntimeBindingLookup,
};
pub use crate::application::team_message::{
    TeamMessageRepairDispatch, TeamMessageTerminalContext, TeamMessageTerminalObservation,
    TeamMessageTerminalPlan, plan_team_message_terminal,
};
pub use crate::owner::actor::OrganizationOwnerInput;

#[derive(Clone)]
pub struct OrganizationModule {
    handle: OrganizationHandle,
}

impl OrganizationModule {
    pub(crate) fn new(handle: OrganizationHandle) -> Self {
        Self { handle }
    }

    pub fn handle(&self) -> &OrganizationHandle {
        &self.handle
    }
}
