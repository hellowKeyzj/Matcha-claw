use std::sync::Arc;

use platform::state_dir::CanonicalStateDir;

use super::OpenClawGateway;
use crate::{
    agents::{AgentWait, OpenClawAgents},
    gateway::client::GatewayClient,
    team::{NativeRunSettledOutcome, TeamProvider},
};
use organization::{
    MaterializationOperationOutcome, TeamMaterializationRemoval, TeamMaterializationRequest,
    TeamProvisionObserver,
};

#[derive(Clone)]
pub struct TeamNativeRunWaiter {
    client: Arc<GatewayClient>,
}

impl TeamNativeRunWaiter {
    pub async fn wait(&self, input: AgentWait) -> NativeRunSettledOutcome {
        OpenClawAgents::new(Arc::clone(&self.client))
            .wait(input)
            .await
            .into()
    }
}

impl OpenClawGateway {
    pub fn with_team_state_dir(mut self, state_dir: CanonicalStateDir) -> Self {
        self.team_state_dir = Some(state_dir);
        self
    }

    pub fn team_native_run_waiter(&self) -> TeamNativeRunWaiter {
        TeamNativeRunWaiter {
            client: Arc::clone(&self.client),
        }
    }

    pub async fn wait_team_native_run(&self, input: AgentWait) -> NativeRunSettledOutcome {
        self.wait_agent(input).await.into()
    }

    /// Materializes a durable TeamSkill intent through native OpenClaw agent and
    /// config effects. Workspace paths, canonical configuration, and Gateway
    /// transport stay inside this integration.
    pub async fn materialize_team(
        &self,
        request: TeamMaterializationRequest,
    ) -> MaterializationOperationOutcome {
        self.materialize_team_observed(request, None).await
    }

    pub async fn materialize_team_observed(
        &self,
        request: TeamMaterializationRequest,
        observer: Option<TeamProvisionObserver>,
    ) -> MaterializationOperationOutcome {
        let Some(state_dir) = self.team_state_dir.clone() else {
            return MaterializationOperationOutcome::OutcomeUnknown;
        };
        TeamProvider::new(&self.client, state_dir)
            .materialize_observed(request, observer)
            .await
    }

    /// Reads native Team facts to settle an ambiguous durable request. This never
    /// replays a materialization mutation and returns a receipt only after all
    /// agent, workspace, and marker facts align with the original intent.
    pub async fn recover_team_materialization(
        &self,
        request: TeamMaterializationRequest,
    ) -> MaterializationOperationOutcome {
        let Some(state_dir) = self.team_state_dir.clone() else {
            return MaterializationOperationOutcome::OutcomeUnknown;
        };
        TeamProvider::new(&self.client, state_dir)
            .recover_materialization(request)
            .await
    }

    /// Confirms cleanup only from matching private recovery evidence, without
    /// promoting an unconfirmed materialization to installed native facts.
    pub async fn remove_unconfirmed_team_materialization(
        &self,
        request: TeamMaterializationRequest,
    ) -> MaterializationOperationOutcome {
        let Some(state_dir) = self.team_state_dir.clone() else {
            platform::trace::session_trace(
                "runtime.team.unconfirmed-remove.end",
                serde_json::json!({"outcome":"OutcomeUnknown","reason":"state-dir-missing"}),
            );
            return MaterializationOperationOutcome::OutcomeUnknown;
        };
        TeamProvider::new(&self.client, state_dir)
            .remove_unconfirmed(request)
            .await
    }

    /// Removes only facts recorded in a confirmed Team materialization receipt.
    /// Ambiguous Gateway writes are deliberately not retried or replayed.
    pub async fn remove_team_materialization(
        &self,
        removal: TeamMaterializationRemoval,
    ) -> MaterializationOperationOutcome {
        let Some(state_dir) = self.team_state_dir.clone() else {
            return MaterializationOperationOutcome::OutcomeUnknown;
        };
        TeamProvider::new(&self.client, state_dir)
            .remove(removal)
            .await
    }
}
