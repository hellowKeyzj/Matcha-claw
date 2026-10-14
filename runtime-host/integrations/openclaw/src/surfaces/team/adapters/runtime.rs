use std::{sync::Arc, time::Instant};

use platform::trace::session_trace;
use serde_json::json;

use crate::{
    port::{OpenClawGateway, OpenClawSessionError},
    session::protocol::{
        AgentId, AgentScopedSessionKey, EndpointSessionId, ModelRef, SessionCreateParams,
        SessionsListParams,
    },
};
use organization::{
    NativeEffectFailure, RoleSessionReadbackOutcome, RoleSessionReceipt, RunRuntimeReceipt,
    RuntimeReceiptOutcome, TeamCreationFailure, TeamCreationFailureReason as FailureReason,
    TeamCreationStage, TeamNativeEffectsPort,
};
use platform::exchange::InvocationOutcome;

use crate::{
    agents::AgentsReadFailure, driver::OpenClawDriver,
    surfaces::team::native_effects::session_read_failure_reason,
};
use runtime_directory::OwnedRuntimeFuture;

async fn confirm_runtime_receipt_native(
    gateway: &OpenClawGateway,
    receipt: RunRuntimeReceipt,
    cancellation: &tokio_util::sync::CancellationToken,
) -> (RuntimeReceiptOutcome, Option<TeamCreationFailure>) {
    if cancellation.is_cancelled() {
        return receipt_failure(RuntimeReceiptOutcome::OutcomeUnknown, FailureReason::ObservationInterrupted);
    }
    for binding in receipt.bindings() {
        let agent = match AgentId::try_new(binding.agent().as_str().to_owned()) {
            Ok(agent) => agent,
            Err(_) => return receipt_failure(RuntimeReceiptOutcome::Rejected, FailureReason::InvalidConfig),
        };
        let endpoint_session_id =
            match EndpointSessionId::try_new(binding.endpoint_session_id().as_str().to_owned()) {
                Ok(session) => session,
                Err(_) => return receipt_failure(RuntimeReceiptOutcome::Unavailable, FailureReason::InvalidConfig),
            };
        let session_key =
            match AgentScopedSessionKey::try_new(agent.clone(), endpoint_session_id.clone()) {
                Ok(key) => key,
                Err(_) => return receipt_failure(RuntimeReceiptOutcome::Rejected, FailureReason::InvalidConfig),
            };

        let Some(_binding) = gateway.client().role_session_transactions(
            vec![session_key.as_str().to_owned()], cancellation,
        ).await else {
            return receipt_failure(RuntimeReceiptOutcome::OutcomeUnknown, FailureReason::ObservationInterrupted);
        };
        let exists = match native_session_exists(gateway, &agent, &session_key, cancellation).await {
            Ok(exists) => exists,
            Err(outcome) => return outcome,
        };
        if !exists {
            let listed = tokio::select! {
                biased;
                listed = gateway.list_agents() => listed,
                _ = cancellation.cancelled() => return receipt_failure(RuntimeReceiptOutcome::OutcomeUnknown, FailureReason::ObservationInterrupted),
            };
            let agents = match listed {
                Ok(agents) => agents,
                Err(error) => return receipt_failure(RuntimeReceiptOutcome::Unavailable, match error {
                    AgentsReadFailure::Unavailable => FailureReason::RpcUnavailable,
                    AgentsReadFailure::Rejected => FailureReason::RpcRejected,
                    AgentsReadFailure::Protocol => FailureReason::RpcProtocol,
                    AgentsReadFailure::Deadline => FailureReason::RpcDeadline,
                    AgentsReadFailure::Authentication => FailureReason::RpcAuthentication,
                }),
            };
            let Some(candidate) = agents.agents.into_iter().find(|candidate| candidate.id == agent.as_str()) else {
                return receipt_failure(RuntimeReceiptOutcome::Unavailable, FailureReason::AgentMissing);
            };
            let Some(model) = candidate.model else {
                return receipt_failure(RuntimeReceiptOutcome::Unavailable, FailureReason::InvalidConfig);
            };
            let model = match ModelRef::try_new(model) {
                Ok(model) => model,
                Err(_) => return receipt_failure(RuntimeReceiptOutcome::Rejected, FailureReason::InvalidConfig),
            };
            let params =
                match SessionCreateParams::try_new(agent.clone(), endpoint_session_id, model) {
                    Ok(params) => params,
                    Err(_) => return receipt_failure(RuntimeReceiptOutcome::Rejected, FailureReason::InvalidConfig),
                };
            match gateway.create_session_cancellable(params, cancellation).await {
                Ok(InvocationOutcome::Succeeded(_)) => {}
                Ok(InvocationOutcome::TargetRejected(_)) => {
                    return receipt_failure(RuntimeReceiptOutcome::Rejected, FailureReason::RpcRejected);
                }
                Ok(InvocationOutcome::Cancelled) => {
                    return receipt_failure(RuntimeReceiptOutcome::OutcomeUnknown, FailureReason::ObservationInterrupted);
                }
                Ok(InvocationOutcome::Unknown) => {
                    return receipt_failure(RuntimeReceiptOutcome::OutcomeUnknown, FailureReason::OutcomeUnknown);
                }
                Err(error) => return map_runtime_receipt_error(error),
            }
            match native_session_exists(gateway, &agent, &session_key, cancellation).await {
                Ok(true) => {}
                Ok(false) => return receipt_failure(RuntimeReceiptOutcome::OutcomeUnknown, FailureReason::NativeReadbackMismatch),
                Err(outcome) => return outcome,
            }
        }

        match readback_native_session(gateway, binding, cancellation).await {
            (RuntimeReceiptOutcome::Installed, _) => {}
            outcome => return outcome,
        }
    }
    (RuntimeReceiptOutcome::Installed, None)
}

fn receipt_failure(
    outcome: RuntimeReceiptOutcome,
    reason: FailureReason,
) -> (RuntimeReceiptOutcome, Option<TeamCreationFailure>) {
    (outcome, Some(TeamCreationFailure::new(TeamCreationStage::InitializingSessions, reason)))
}

async fn readback_native_session(
    gateway: &OpenClawGateway,
    binding: &RoleSessionReceipt,
    cancellation: &tokio_util::sync::CancellationToken,
) -> (RuntimeReceiptOutcome, Option<TeamCreationFailure>) {
    let (readback, reason) = crate::surfaces::team::OpenClawTeamNativeEffects::new(gateway)
        .with_cancellation(cancellation.clone())
        .readback_diagnostic(binding)
        .await;
    let outcome = match readback {
        RoleSessionReadbackOutcome::Confirmed { .. } => RuntimeReceiptOutcome::Installed,
        RoleSessionReadbackOutcome::Failed { failure } => map_native_effect_failure(failure),
        RoleSessionReadbackOutcome::OutcomeUnknown => RuntimeReceiptOutcome::OutcomeUnknown,
    };
    (outcome, reason.map(|reason| TeamCreationFailure::new(TeamCreationStage::InitializingSessions, reason)))
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
    gateway: &OpenClawGateway,
    agent: &AgentId,
    key: &AgentScopedSessionKey,
    cancellation: &tokio_util::sync::CancellationToken,
) -> Result<bool, (RuntimeReceiptOutcome, Option<TeamCreationFailure>)> {
    let params = SessionsListParams::default()
        .try_for_agent(agent.as_str())
        .map_err(|_| receipt_failure(RuntimeReceiptOutcome::Rejected, FailureReason::InvalidConfig))?;
    let sessions = gateway
        .list_sessions_cancellable(params, cancellation)
        .await
        .map_err(map_runtime_receipt_error)?;
    Ok(sessions
        .sessions
        .iter()
        .any(|session| session.key.as_str() == key.as_str()))
}

fn map_runtime_receipt_error(error: OpenClawSessionError) -> (RuntimeReceiptOutcome, Option<TeamCreationFailure>) {
    let outcome = match error {
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
    };
    receipt_failure(outcome, session_read_failure_reason(error))
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
    fn read_team_member_profiles(
        &self,
        agents: Vec<organization::ManagedAgentReference>,
    ) -> OwnedRuntimeFuture<
        Result<Vec<organization::MemberProfile>, organization::TeamCreationFailure>,
    > {
        self.read_team_member_profiles_cancellable(agents, tokio_util::sync::CancellationToken::new())
    }

    fn read_team_member_profiles_cancellable(
        &self,
        agents: Vec<organization::ManagedAgentReference>,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> OwnedRuntimeFuture<
        Result<Vec<organization::MemberProfile>, organization::TeamCreationFailure>,
    > {
        let gateway = Arc::clone(&self.gateway);
        Box::pin(async move {
            let started = platform::trace::enabled().then(Instant::now);
            session_trace("runtime.team.profile.gateway-lock.request", || json!({}));
            if cancellation.is_cancelled() {
                return Err(organization::TeamCreationFailure::new(
                    organization::TeamCreationStage::ReadingProfiles,
                    organization::TeamCreationFailureReason::Cancelled,
                ));
            }
            let client = gateway.client();
            session_trace(
                "runtime.team.profile.gateway-lock.end",
                || json!({"elapsedMs":started.map(|started| started.elapsed().as_millis()).unwrap_or_default()}),
            );
            let result = crate::surfaces::team::member_profiles::read(client, agents, cancellation).await;
            session_trace(
                "runtime.team.profile.runtime.end",
                || json!({"outcome":if result.is_ok() {"Succeeded"} else {"Unavailable"},"elapsedMs":started.map(|started| started.elapsed().as_millis()).unwrap_or_default()}),
            );
            result
        })
    }

    fn materialize_team(
        &self,
        request: organization::TeamMaterializationRequest,
    ) -> OwnedRuntimeFuture<organization::MaterializationOperationOutcome> {
        self.materialize_team_observed(request, None)
    }

    fn materialize_team_observed(
        &self,
        request: organization::TeamMaterializationRequest,
        observer: Option<organization::TeamProvisionObserver>,
    ) -> OwnedRuntimeFuture<organization::MaterializationOperationOutcome> {
        self.materialize_team_cancellable(request, observer, tokio_util::sync::CancellationToken::new())
    }

    fn materialize_team_cancellable(
        &self,
        request: organization::TeamMaterializationRequest,
        observer: Option<organization::TeamProvisionObserver>,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> OwnedRuntimeFuture<organization::MaterializationOperationOutcome> {
        let gateway = Arc::clone(&self.gateway);
        Box::pin(async move {
            let started = platform::trace::enabled().then(Instant::now);
            session_trace("runtime.team.materialize.gateway-lock.request", || json!({}));
            if cancellation.is_cancelled() {
                if let Some(observer) = &observer {
                    observer.report(organization::TeamProvisionUpdate::Failure(TeamCreationFailure::new(
                        TeamCreationStage::ConfiguringTeam, FailureReason::Cancelled,
                    ))).await;
                }
                return organization::MaterializationOperationOutcome::OutcomeUnknown;
            }
            session_trace(
                "runtime.team.materialize.gateway-lock.end",
                || json!({"elapsedMs":started.map(|started| started.elapsed().as_millis()).unwrap_or_default()}),
            );
            let Some(state_dir) = gateway.team_state_dir() else {
                if let Some(observer) = &observer {
                    observer.report(organization::TeamProvisionUpdate::Failure(TeamCreationFailure::new(
                        TeamCreationStage::ConfiguringTeam, FailureReason::Unavailable,
                    ))).await;
                }
                return organization::MaterializationOperationOutcome::OutcomeUnknown;
            };
            let provider = super::super::provider::TeamProvider::new(&gateway.client(), state_dir)
                .with_cancellation(cancellation);
            let outcome = provider.materialize_observed(request, observer).await;
            session_trace(
                "runtime.team.materialize.runtime.end",
                || json!({"outcome":match &outcome { organization::MaterializationOperationOutcome::Confirmed { .. } => "Confirmed", organization::MaterializationOperationOutcome::Rejected { .. } => "Rejected", _ => "OutcomeUnknown" },"elapsedMs":started.map(|started| started.elapsed().as_millis()).unwrap_or_default()}),
            );
            outcome
        })
    }

    fn remove_team(
        &self,
        removal: organization::TeamMaterializationRemoval,
    ) -> OwnedRuntimeFuture<organization::MaterializationOperationOutcome> {
        self.remove_team_cancellable(removal, tokio_util::sync::CancellationToken::new())
    }

    fn remove_team_cancellable(
        &self,
        removal: organization::TeamMaterializationRemoval,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> OwnedRuntimeFuture<organization::MaterializationOperationOutcome> {
        let gateway = Arc::clone(&self.gateway);
        Box::pin(async move {
            if cancellation.is_cancelled() {
                return organization::MaterializationOperationOutcome::OutcomeUnknown;
            }
            let Some(state_dir) = gateway.team_state_dir() else {
                return organization::MaterializationOperationOutcome::OutcomeUnknown;
            };
            let provider = super::super::provider::TeamProvider::new(&gateway.client(), state_dir)
                .with_cancellation(cancellation);
            provider.remove(removal).await
        })
    }

    fn remove_unconfirmed_team(
        &self,
        request: organization::TeamMaterializationRequest,
    ) -> OwnedRuntimeFuture<organization::MaterializationOperationOutcome> {
        self.remove_unconfirmed_team_cancellable(request, tokio_util::sync::CancellationToken::new())
    }

    fn remove_unconfirmed_team_cancellable(
        &self,
        request: organization::TeamMaterializationRequest,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> OwnedRuntimeFuture<organization::MaterializationOperationOutcome> {
        let gateway = Arc::clone(&self.gateway);
        Box::pin(async move {
            let started = platform::trace::enabled().then(Instant::now);
            session_trace(
                "runtime.team.unconfirmed-remove.gateway-lock.request",
                || json!({}),
            );
            if cancellation.is_cancelled() {
                return organization::MaterializationOperationOutcome::OutcomeUnknown;
            }
            let Some(state_dir) = gateway.team_state_dir() else {
                return organization::MaterializationOperationOutcome::OutcomeUnknown;
            };
            let provider = super::super::provider::TeamProvider::new(&gateway.client(), state_dir)
                .with_cancellation(cancellation);
            let outcome = provider.remove_unconfirmed(request).await;
            session_trace(
                "runtime.team.unconfirmed-remove.runtime.end",
                || json!({"outcome":match &outcome { organization::MaterializationOperationOutcome::Confirmed { .. } => "Confirmed", _ => "OutcomeUnknown" },"reason":"native-result","elapsedMs":started.map(|started| started.elapsed().as_millis()).unwrap_or_default()}),
            );
            outcome
        })
    }

    fn recover_team_removal(
        &self,
        removal: organization::TeamMaterializationRemoval,
    ) -> OwnedRuntimeFuture<organization::MaterializationOperationOutcome> {
        let gateway = Arc::clone(&self.gateway);
        Box::pin(async move {
            let Some(state_dir) = gateway.team_state_dir() else {
                return organization::MaterializationOperationOutcome::OutcomeUnknown;
            };
            let provider = super::super::provider::TeamProvider::new(&gateway.client(), state_dir);
            provider.recover_removal(removal).await
        })
    }

    fn recover_team_materialization(
        &self,
        request: organization::TeamMaterializationRequest,
    ) -> OwnedRuntimeFuture<organization::MaterializationOperationOutcome> {
        let gateway = Arc::clone(&self.gateway);
        Box::pin(async move {
            let started = platform::trace::enabled().then(Instant::now);
            session_trace("runtime.team.recovery.gateway-lock.request", || json!({}));
            session_trace(
                "runtime.team.recovery.gateway-lock.end",
                || json!({"elapsedMs":started.map(|started| started.elapsed().as_millis()).unwrap_or_default()}),
            );
            let outcome = crate::surfaces::team::OpenClawTeamNativeEffects::new(&gateway)
                .recover_materialization(request)
                .await;
            session_trace(
                "runtime.team.recovery.runtime.end",
                || json!({"outcome":match &outcome { organization::MaterializationOperationOutcome::Confirmed { .. } => "Confirmed", organization::MaterializationOperationOutcome::Rejected { .. } => "Rejected", _ => "OutcomeUnknown" },"elapsedMs":started.map(|started| started.elapsed().as_millis()).unwrap_or_default()}),
            );
            outcome
        })
    }

    fn confirm_team_run_receipt(
        &self,
        receipt: organization::RunRuntimeReceipt,
    ) -> OwnedRuntimeFuture<organization::RuntimeReceiptOutcome> {
        let confirmation = self.confirm_team_run_receipt_cancellable(receipt, tokio_util::sync::CancellationToken::new());
        Box::pin(async move { confirmation.await.0 })
    }

    fn confirm_team_run_receipt_cancellable(
        &self,
        receipt: organization::RunRuntimeReceipt,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> OwnedRuntimeFuture<(RuntimeReceiptOutcome, Option<TeamCreationFailure>)> {
        let gateway = Arc::clone(&self.gateway);
        Box::pin(async move { confirm_runtime_receipt_native(&gateway, receipt, &cancellation).await })
    }

    fn abort_role_sessions(
        &self,
        bindings: Vec<organization::RoleSessionReceipt>,
    ) -> OwnedRuntimeFuture<organization::RoleAbortOutcome> {
        self.abort_role_sessions_cancellable(bindings, tokio_util::sync::CancellationToken::new())
    }

    fn abort_role_sessions_cancellable(
        &self,
        bindings: Vec<organization::RoleSessionReceipt>,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> OwnedRuntimeFuture<organization::RoleAbortOutcome> {
        let gateway = Arc::clone(&self.gateway);
        Box::pin(async move {
            let keys = bindings.iter().map(|binding| {
                super::super::native_effects::agent_scoped_session_key(binding)
                    .map(|key| key.as_str().to_owned())
            }).collect::<Result<Vec<_>, _>>();
            let Ok(keys) = keys else {
                return organization::RoleAbortOutcome::OutcomeUnknown;
            };
            let Some(_bindings) = gateway.client().role_session_transactions(keys, &cancellation).await else {
                return organization::RoleAbortOutcome::OutcomeUnknown;
            };
            let mut effects = crate::surfaces::team::OpenClawTeamNativeEffects::new(&gateway)
                .with_cancellation(cancellation);
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
        self.delete_role_sessions_cancellable(run_id, bindings, abort_first, tokio_util::sync::CancellationToken::new())
    }

    fn delete_role_sessions_cancellable(
        &self,
        run_id: organization::GraphRunId,
        bindings: Vec<organization::RoleSessionReceipt>,
        abort_first: bool,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> OwnedRuntimeFuture<organization::NativeDeletionEvidence> {
        let gateway = Arc::clone(&self.gateway);
        Box::pin(async move {
            let keys = bindings.iter().map(|binding| {
                super::super::native_effects::agent_scoped_session_key(binding)
                    .map(|key| key.as_str().to_owned())
            }).collect::<Result<Vec<_>, _>>();
            let Ok(keys) = keys else {
                return organization::NativeDeletionEvidence::Rejected;
            };
            let Some(_bindings) = gateway.client().role_session_transactions(keys, &cancellation).await else {
                return organization::NativeDeletionEvidence::OutcomeUnknown;
            };
            let mut effects = crate::surfaces::team::OpenClawTeamNativeEffects::new(&gateway)
                .with_cancellation(cancellation);
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
        let provider = crate::surfaces::skills::OpenClawSkillProvider::new(
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
