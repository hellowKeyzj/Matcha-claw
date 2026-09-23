use std::sync::Arc;

use platform::{exchange::InvocationOutcome, state_dir::CanonicalStateDir};

use super::OpenClawGateway;
use crate::{
    agents::{AgentWait, OpenClawAgents},
    gateway::client::GatewayClient,
    session::operation::SessionOperation,
    team::{NativeRunSettledOutcome, PromptDelivery, PromptDeliveryOutcome, TeamProvider},
};
use organization::{
    MaterializationOperationOutcome, TeamMaterializationRemoval, TeamMaterializationRequest,
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

    pub async fn deliver_team_prompt(&mut self, delivery: PromptDelivery) -> PromptDeliveryOutcome {
        let params = match delivery.into_params() {
            Ok(params) => params,
            Err(_) => {
                return PromptDeliveryOutcome::Rejected {
                    failure: crate::surfaces::team::PromptDeliveryFailure::PolicyRejected,
                };
            }
        };
        let session_key = params.session_key().clone();
        let operation = SessionOperation::new(Arc::clone(&self.client));
        if let Err(error) = operation.subscribe_session_messages(&session_key).await {
            return crate::surfaces::team::map_send_outcome(InvocationOutcome::TargetRejected(
                error,
            ));
        }
        match operation.send_chat(params).await {
            Ok(outcome) => crate::surfaces::team::map_send_outcome(outcome),
            Err(error) => {
                crate::surfaces::team::map_send_outcome(InvocationOutcome::TargetRejected(error))
            }
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
        let Some(state_dir) = self.team_state_dir.clone() else {
            return MaterializationOperationOutcome::OutcomeUnknown;
        };
        TeamProvider::new(&self.client, state_dir)
            .materialize(request)
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
