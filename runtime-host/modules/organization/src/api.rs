use foundation::{
    execution::OwnedTask,
    lifecycle::{EffectRegistration, ModuleScope, ScopedEffectKind},
};

use crate::owner::{
    coordinator::{TeamRunCoordinator, TeamRunCoordinatorHandle, TeamRunCoordinatorInput},
    handle::OrganizationHandle,
};

pub use crate::application::start_gate_control::{
    StartGatePromptPlan, StartGateRuntimeBindingLookup,
};
pub use crate::application::team_message::{
    TeamMessageRepairDispatch, TeamMessageTerminalContext, TeamMessageTerminalObservation,
    TeamMessageTerminalPlan, plan_team_message_terminal,
};
pub use crate::owner::actor::OrganizationOwnerInput;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OrganizationShutdownError {
    Join,
    PendingSettlements,
}

impl std::fmt::Display for OrganizationShutdownError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Join => "organization coordinator join failed",
            Self::PendingSettlements => "organization has pending durable settlements",
        })
    }
}

impl std::error::Error for OrganizationShutdownError {}

pub struct OrganizationRuntime {
    scope: ModuleScope,
    coordinator: Option<TeamRunCoordinator>,
}

impl OrganizationRuntime {
    pub fn new(
        mut owner_task: OwnedTask<()>,
        on_join_failure: impl FnOnce() + Send + 'static,
    ) -> Self {
        let mut scope = ModuleScope::new("organization");
        scope.register_effect_disposer(
            ScopedEffectKind::OwnerTask,
            "owner-task",
            move || async move {
                if owner_task.drain_and_join().await.is_err() {
                    on_join_failure();
                }
            },
        );
        Self { scope, coordinator: None }
    }

    pub fn scope_mut(&mut self) -> &mut ModuleScope {
        &mut self.scope
    }

    pub fn effect_registrations(&self) -> &[EffectRegistration] {
        self.scope.effect_registrations()
    }

    pub fn start_coordinator<T: Send + Sync + 'static>(
        &mut self,
        input: TeamRunCoordinatorInput,
        admission_changes: tokio::sync::watch::Receiver<T>,
    ) -> TeamRunCoordinatorHandle {
        let (coordinator, handle) = TeamRunCoordinator::spawn(input, admission_changes);
        self.coordinator = Some(coordinator);
        handle
    }

    pub async fn quiesce(&mut self) {
        let _ = self.quiesce_checked().await;
    }

    pub async fn quiesce_checked(&mut self) -> Result<(), OrganizationShutdownError> {
        if let Some(coordinator) = &mut self.coordinator {
            coordinator.cancel();
            coordinator.join().await?;
            if coordinator.has_pending_settlements() {
                return Err(OrganizationShutdownError::PendingSettlements);
            }
        }
        Ok(())
    }

    pub async fn drain_and_join(&mut self) {
        self.scope.dispose_all_lifo().await;
    }
}

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
