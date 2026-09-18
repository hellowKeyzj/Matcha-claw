use std::sync::Arc;

use openclaw::{
    port::{OpenClawGateway, OpenClawSessionError},
    session::protocol::{
        AgentId, AgentScopedSessionKey, EndpointSessionId, RunId, SessionCreateParams,
        SessionsListParams,
    },
};
use organization::{
    NativeEffectFailure, RoleSessionReadbackOutcome, RoleSessionReceipt, RunRuntimeReceipt,
    TeamNativeEffectsPort,
};
use platform::exchange::InvocationOutcome;

use super::super::OpenClawInstance;
use crate::{
    organization::RuntimeReceiptOutcome,
    runtime::driver::{NativeRunSettled, OwnedRuntimeFuture, TeamOps, TeamTerminalOps},
};

pub(super) const TEAM_TERMINAL_WAIT_SLICE_MS: u64 = 30_000;
pub(super) const TEAM_TERMINAL_RPC_TIMEOUT_BUFFER_MS: u64 = 10_000;

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
            let params = match SessionCreateParams::try_new(agent.clone(), endpoint_session_id) {
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
    match openclaw::team::OpenClawTeamNativeEffects::new(gateway)
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
fn agent_scoped_session_key(
    binding: &organization::RoleSessionReceipt,
) -> Option<AgentScopedSessionKey> {
    let agent = AgentId::try_new(binding.agent().as_str().to_owned()).ok()?;
    let session =
        EndpointSessionId::try_new(binding.endpoint_session_id().as_str().to_owned()).ok()?;
    AgentScopedSessionKey::try_new(agent, session).ok()
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

        assert_eq!(
            agent_scoped_session_key(&binding).unwrap().as_str(),
            "agent:selected-agent:endpoint-session"
        );
    }
}

impl TeamTerminalOps for OpenClawInstance {
    fn watch_terminal(
        &self,
        target: organization::NativeTerminalReceiptTarget,
    ) -> OwnedRuntimeFuture<Option<NativeRunSettled>> {
        let gateway = Arc::clone(&self.gateway);
        let native_run_id = target
            .correlation()
            .native_run_receipt()
            .as_str()
            .to_owned();
        Box::pin(async move { wait_openclaw_native_run(&gateway, native_run_id).await })
    }
}

pub(super) async fn wait_openclaw_native_run(
    gateway: &tokio::sync::Mutex<OpenClawGateway>,
    native_run_id: String,
) -> Option<NativeRunSettled> {
    let run_id = RunId::try_new(native_run_id).ok()?;
    let waiter = gateway.lock().await.team_native_run_waiter();
    loop {
        let input = openclaw::agents::AgentWait::try_new(
            run_id.as_str().to_owned(),
            TEAM_TERMINAL_WAIT_SLICE_MS,
            TEAM_TERMINAL_RPC_TIMEOUT_BUFFER_MS,
        )
        .ok()?;
        match waiter.wait(input).await {
            openclaw::team::NativeRunSettledOutcome::Observed(settled) => {
                let Some(status) = match_openclaw_terminal_status(&settled) else {
                    continue;
                };
                return Some(NativeRunSettled {
                    status,
                    final_assistant_text: settled.final_assistant_text().map(ToOwned::to_owned),
                });
            }
            openclaw::team::NativeRunSettledOutcome::Rejected
            | openclaw::team::NativeRunSettledOutcome::OutcomeUnknown => return None,
        }
    }
}

pub(super) fn match_openclaw_terminal_status(
    settled: &openclaw::team::NativeRunSettled,
) -> Option<organization::NativeTerminalStatus> {
    match settled.status() {
        openclaw::team::NativeRunStatus::Completed => {
            Some(organization::NativeTerminalStatus::Completed)
        }
        openclaw::team::NativeRunStatus::Failed => Some(organization::NativeTerminalStatus::Failed),
        openclaw::team::NativeRunStatus::Timeout if settled.is_hard_timeout() => {
            Some(organization::NativeTerminalStatus::Interrupted)
        }
        openclaw::team::NativeRunStatus::Timeout | openclaw::team::NativeRunStatus::Pending => None,
    }
}

impl TeamOps for OpenClawInstance {
    fn materialize_team(
        &self,
        request: organization::TeamMaterializationRequest,
    ) -> OwnedRuntimeFuture<organization::MaterializationOperationOutcome> {
        let gateway = Arc::clone(&self.gateway);
        Box::pin(async move {
            let mut gateway = gateway.lock().await;
            openclaw::team::OpenClawTeamNativeEffects::new(&mut gateway)
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
            openclaw::team::OpenClawTeamNativeEffects::new(&mut gateway)
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
            openclaw::team::OpenClawTeamNativeEffects::new(&mut gateway)
                .recover_materialization(request)
                .await
        })
    }

    fn confirm_team_run_receipt(
        &self,
        receipt: organization::RunRuntimeReceipt,
    ) -> OwnedRuntimeFuture<crate::organization::RuntimeReceiptOutcome> {
        let gateway = Arc::clone(&self.gateway);
        Box::pin(async move { confirm_runtime_receipt_native(&gateway, receipt).await })
    }

    fn deliver_prompt(
        &self,
        request: organization::PromptDeliveryRequest,
    ) -> OwnedRuntimeFuture<organization::PromptDeliveryOutcome> {
        let gateway = Arc::clone(&self.gateway);
        Box::pin(async move {
            let mut gateway = gateway.lock().await;
            openclaw::team::OpenClawTeamNativeEffects::new(&mut gateway)
                .deliver(request)
                .await
        })
    }

    fn abort_role_sessions(
        &self,
        bindings: Vec<organization::RoleSessionReceipt>,
    ) -> OwnedRuntimeFuture<organization::RoleAbortOutcome> {
        let gateway = Arc::clone(&self.gateway);
        Box::pin(async move {
            let mut gateway = gateway.lock().await;
            let mut effects = openclaw::team::OpenClawTeamNativeEffects::new(&mut gateway);
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
            let mut effects = openclaw::team::OpenClawTeamNativeEffects::new(&mut gateway);
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
}
