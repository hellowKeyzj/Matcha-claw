use std::sync::Arc;

use crate::{
    port::{OpenClawGateway, OpenClawSessionError},
    session::protocol::{
        AgentId, AgentScopedSessionKey, EndpointSessionId, ModelRef, SessionCreateParams,
        SessionsListParams,
    },
};
use organization::{
    NativeEffectFailure, RoleSessionReadbackOutcome, RoleSessionReceipt, RunRuntimeReceipt,
    TeamNativeEffectsPort,
};
use platform::exchange::InvocationOutcome;

use super::super::OpenClawDriver;
use organization::RuntimeReceiptOutcome;
use runtime_directory::OwnedRuntimeFuture;

async fn confirm_runtime_receipt_native(
    gateway: &tokio::sync::Mutex<OpenClawGateway>,
    receipt: RunRuntimeReceipt,
) -> RuntimeReceiptOutcome {
    let mut gateway = gateway.lock().await;
    for binding in receipt.bindings() {
        let agent = match AgentId::try_new(binding.agent().as_str().to_owned()) {
            Ok(agent) => agent,
            Err(_) => return RuntimeReceiptOutcome::Rejected,
        };
        let endpoint_session_id =
            match EndpointSessionId::try_new(binding.endpoint_session_id().as_str().to_owned()) {
                Ok(session) => session,
                Err(_) => return RuntimeReceiptOutcome::Unavailable,
            };
        let session_key =
            match AgentScopedSessionKey::try_new(agent.clone(), endpoint_session_id.clone()) {
                Ok(key) => key,
                Err(_) => return RuntimeReceiptOutcome::Rejected,
            };

        let exists = match native_session_exists(&mut gateway, &agent, &session_key).await {
            Ok(exists) => exists,
            Err(outcome) => return outcome,
        };
        if !exists {
            let model = match gateway.list_agents().await.ok().and_then(|agents| {
                agents
                    .agents
                    .into_iter()
                    .find(|candidate| candidate.id == agent.as_str())
                    .and_then(|candidate| candidate.model)
            }) {
                Some(model) => match ModelRef::try_new(model) {
                    Ok(model) => model,
                    Err(_) => return RuntimeReceiptOutcome::Rejected,
                },
                None => return RuntimeReceiptOutcome::Unavailable,
            };
            let params =
                match SessionCreateParams::try_new(agent.clone(), endpoint_session_id, model) {
                    Ok(params) => params,
                    Err(_) => return RuntimeReceiptOutcome::Rejected,
                };
            match gateway.create_session(params).await {
                Ok(InvocationOutcome::Succeeded(_)) => {}
                Ok(InvocationOutcome::TargetRejected(_)) => return RuntimeReceiptOutcome::Rejected,
                Ok(InvocationOutcome::Cancelled | InvocationOutcome::Unknown) => {
                    return RuntimeReceiptOutcome::OutcomeUnknown;
                }
                Err(error) => return map_runtime_receipt_error(error),
            }
            match native_session_exists(&mut gateway, &agent, &session_key).await {
                Ok(true) => {}
                Ok(false) => return RuntimeReceiptOutcome::OutcomeUnknown,
                Err(outcome) => return outcome,
            }
        }

        match readback_native_session(&mut gateway, binding).await {
            RuntimeReceiptOutcome::Installed => {}
            outcome => return outcome,
        }
    }
    RuntimeReceiptOutcome::Installed
}

async fn readback_native_session(
    gateway: &mut OpenClawGateway,
    binding: &RoleSessionReceipt,
) -> RuntimeReceiptOutcome {
    match crate::team::OpenClawTeamNativeEffects::new(gateway)
        .readback(binding)
        .await
    {
        RoleSessionReadbackOutcome::Confirmed { .. } => RuntimeReceiptOutcome::Installed,
        RoleSessionReadbackOutcome::Failed { failure } => map_native_effect_failure(failure),
        RoleSessionReadbackOutcome::OutcomeUnknown => RuntimeReceiptOutcome::OutcomeUnknown,
    }
}

fn map_native_effect_failure(failure: NativeEffectFailure) -> RuntimeReceiptOutcome {
    match failure {
        NativeEffectFailure::Rejected | NativeEffectFailure::InvalidInput => {
            RuntimeReceiptOutcome::Rejected
        }
        NativeEffectFailure::Unavailable | NativeEffectFailure::Unsupported => {
            RuntimeReceiptOutcome::Unavailable
        }
    }
}

async fn native_session_exists(
    gateway: &mut OpenClawGateway,
    agent: &AgentId,
    key: &AgentScopedSessionKey,
) -> Result<bool, RuntimeReceiptOutcome> {
    let params = SessionsListParams::default()
        .try_for_agent(agent.as_str())
        .map_err(|_| RuntimeReceiptOutcome::Rejected)?;
    let sessions = gateway
        .list_sessions(params)
        .await
        .map_err(map_runtime_receipt_error)?;
    Ok(sessions
        .sessions
        .iter()
        .any(|session| session.key.as_str() == key.as_str()))
}

fn map_runtime_receipt_error(error: OpenClawSessionError) -> RuntimeReceiptOutcome {
    match error {
        OpenClawSessionError::TargetRejected => RuntimeReceiptOutcome::Rejected,
        OpenClawSessionError::Protocol(_) | OpenClawSessionError::UnknownResponse => {
            RuntimeReceiptOutcome::OutcomeUnknown
        }
        OpenClawSessionError::SessionConnection
        | OpenClawSessionError::RequestIdExhausted
        | OpenClawSessionError::RequestDeadline
        | OpenClawSessionError::ConnectionClosed
        | OpenClawSessionError::Transport
        | OpenClawSessionError::EventBackpressure => RuntimeReceiptOutcome::Unavailable,
    }
}

#[cfg(test)]
mod native_receipt_tests {
    use organization::{
        EndpointSessionId, GraphRunId, ManagedAgentReference, RoleId, RoleSessionRef,
        RuntimeEndpointReference, TeamId,
    };

    use super::*;

    #[test]
    fn role_abort_and_session_cleanup_use_an_agent_scoped_native_key() {
        let binding = organization::RoleSessionReceipt::with_endpoint_session_id(
            TeamId::try_new("team:one").unwrap(),
            GraphRunId::new("run:one"),
            RoleId::try_new("leader").unwrap(),
            RoleSessionRef::try_new("rs0").unwrap(),
            EndpointSessionId::try_new("endpoint-session").unwrap(),
            ManagedAgentReference::try_new("selected-agent").unwrap(),
            RuntimeEndpointReference::try_new("endpoint:openclaw").unwrap(),
        );

        let agent = AgentId::try_new(binding.agent().as_str().to_owned()).unwrap();
        let session = crate::session::protocol::EndpointSessionId::try_new(
            binding.endpoint_session_id().as_str().to_owned(),
        )
        .unwrap();
        assert_eq!(
            AgentScopedSessionKey::try_new(agent, session)
                .unwrap()
                .as_str(),
            "agent:selected-agent:endpoint-session"
        );
    }
}

impl organization::OrganizationNativeRuntime for OpenClawDriver {
    fn materialize_team(
        &self,
        request: organization::TeamMaterializationRequest,
    ) -> OwnedRuntimeFuture<organization::MaterializationOperationOutcome> {
        let gateway = Arc::clone(&self.gateway);
        Box::pin(async move {
            let mut gateway = gateway.lock().await;
            crate::team::OpenClawTeamNativeEffects::new(&mut gateway)
                .materialize(request)
                .await
        })
    }

    fn remove_team(
        &self,
        removal: organization::TeamMaterializationRemoval,
    ) -> OwnedRuntimeFuture<organization::MaterializationOperationOutcome> {
        let gateway = Arc::clone(&self.gateway);
        Box::pin(async move {
            let mut gateway = gateway.lock().await;
            crate::team::OpenClawTeamNativeEffects::new(&mut gateway)
                .remove(removal)
                .await
        })
    }

    fn recover_team_materialization(
        &self,
        request: organization::TeamMaterializationRequest,
    ) -> OwnedRuntimeFuture<organization::MaterializationOperationOutcome> {
        let gateway = Arc::clone(&self.gateway);
        Box::pin(async move {
            let mut gateway = gateway.lock().await;
            crate::team::OpenClawTeamNativeEffects::new(&mut gateway)
                .recover_materialization(request)
                .await
        })
    }

    fn confirm_team_run_receipt(
        &self,
        receipt: organization::RunRuntimeReceipt,
    ) -> OwnedRuntimeFuture<organization::RuntimeReceiptOutcome> {
        let gateway = Arc::clone(&self.gateway);
        Box::pin(async move { confirm_runtime_receipt_native(&gateway, receipt).await })
    }

    fn abort_role_sessions(
        &self,
        bindings: Vec<organization::RoleSessionReceipt>,
    ) -> OwnedRuntimeFuture<organization::RoleAbortOutcome> {
        let gateway = Arc::clone(&self.gateway);
        Box::pin(async move {
            let mut gateway = gateway.lock().await;
            let mut effects = crate::team::OpenClawTeamNativeEffects::new(&mut gateway);
            for binding in &bindings {
                match effects.abort(binding).await {
                    organization::RoleSessionAbortOutcome::Confirmed { .. } => {}
                    organization::RoleSessionAbortOutcome::Failed { .. }
                    | organization::RoleSessionAbortOutcome::OutcomeUnknown => {
                        return organization::RoleAbortOutcome::OutcomeUnknown;
                    }
                }
            }
            organization::RoleAbortOutcome::Confirmed
        })
    }

    fn delete_role_sessions(
        &self,
        run_id: organization::GraphRunId,
        bindings: Vec<organization::RoleSessionReceipt>,
        abort_first: bool,
    ) -> OwnedRuntimeFuture<organization::NativeDeletionEvidence> {
        let gateway = Arc::clone(&self.gateway);
        Box::pin(async move {
            let mut gateway = gateway.lock().await;
            let mut effects = crate::team::OpenClawTeamNativeEffects::new(&mut gateway);
            if abort_first {
                for binding in &bindings {
                    match effects.abort(binding).await {
                        organization::RoleSessionAbortOutcome::Confirmed { .. } => {}
                        organization::RoleSessionAbortOutcome::Failed { .. } => {
                            return organization::NativeDeletionEvidence::Rejected;
                        }
                        organization::RoleSessionAbortOutcome::OutcomeUnknown => {
                            return organization::NativeDeletionEvidence::OutcomeUnknown;
                        }
                    }
                }
            }
            let mut confirmations = Vec::with_capacity(bindings.len());
            for binding in &bindings {
                match effects.delete(binding).await {
                    organization::RoleSessionDeleteOutcome::Confirmed { receipt } => {
                        let Ok(confirmation) =
                            organization::RoleSessionDeletionConfirmation::try_new(
                                binding.clone(),
                                receipt,
                            )
                        else {
                            return organization::NativeDeletionEvidence::Rejected;
                        };
                        confirmations.push(confirmation);
                    }
                    organization::RoleSessionDeleteOutcome::Failed { .. } => {
                        return organization::NativeDeletionEvidence::Rejected;
                    }
                    organization::RoleSessionDeleteOutcome::OutcomeUnknown => {
                        return organization::NativeDeletionEvidence::OutcomeUnknown;
                    }
                }
            }
            organization::NativeDeletionProof::try_new(run_id, confirmations).map_or(
                organization::NativeDeletionEvidence::Rejected,
                organization::NativeDeletionEvidence::Confirmed,
            )
        })
    }

    fn installed_skill_names(&self) -> OwnedRuntimeFuture<Option<Vec<String>>> {
        let provider = crate::skill::OpenClawSkillProvider::new(
            Arc::clone(&self.gateway),
            self.electron_image.clone(),
            self.working_directory.clone(),
            self.state_dir.clone(),
        );
        Box::pin(async move {
            provider
                .installed_skill_catalog()
                .await
                .map(|catalog| catalog.names().iter().cloned().collect())
        })
    }
}
