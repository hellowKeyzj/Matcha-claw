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
    pub(crate) call_workflows: Option<std::sync::Arc<crate::call::CallWorkflows>>,
}

impl OrganizationModule {
    pub(crate) fn new(handle: OrganizationHandle) -> Self {
        Self { handle, call_workflows: None }
    }

    pub fn with_call_recorder(mut self, recorder: platform::call::CallRecorder) -> Self {
        self.call_workflows = Some(crate::call::CallWorkflows::start(recorder));
        self
    }

    pub async fn shutdown_call_workflows(&self) {
        if let Some(workflows) = &self.call_workflows {
            workflows.shutdown().await;
        }
        let _ = self.handle.drain_team_delete_tasks().await;
    }

    pub fn handle(&self) -> &OrganizationHandle {
        &self.handle
    }
}
