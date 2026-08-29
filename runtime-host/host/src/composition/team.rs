use openclaw::{
    port::{OpenClawGateway, OpenClawSessionError},
    session::protocol::{
        AgentId, AgentScopedSessionKey, EndpointSessionId, SessionCreateParams, SessionsListParams,
    },
    team::OpenClawTeamNativeEffects,
};
use organization::{
    BeginCancellationOutcome, CreateGraphRunOutcome, ExternalSessionReference, GraphRunFacts,
    IdempotencyKey, LocalSessionReference, ManualTeamRoleBinding, MaterializationOperationOutcome,
    NativeEffectFailure, OrganizationStore, RoleAbortOutcome, RoleSessionReadbackOutcome,
    RoleSessionReceipt, RunRuntimeReceipt, RuntimeEndpointReference, SettleCancellationOutcome,
    StoreFault, TeamId, TeamNativeEffectsPort,
};
use platform::exchange::InvocationOutcome;

use super::team_run::TeamRunOwner;

pub(crate) struct ManualTeamMaterializationInput {
    pub(crate) team_id: TeamId,
    pub(crate) team_name: String,
    pub(crate) endpoint: RuntimeEndpointReference,
    pub(crate) roles: Vec<ManualTeamRoleBinding>,
    pub(crate) materialization_idempotency_key: IdempotencyKey,
    pub(crate) run: GraphRunFacts,
    pub(crate) run_idempotency_key: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ManualTeamCreateOutcome {
    Created(CreateGraphRunOutcome),
    Rejected,
    OutcomeUnknown,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RuntimeReceiptOutcome {
    Installed,
    Rejected,
    OutcomeUnknown,
    Unavailable,
}

pub(crate) fn prepare_runtime_receipt(
    store: &OrganizationStore,
    team: &TeamId,
    run_id: &organization::GraphRunId,
) -> Result<RunRuntimeReceipt, RuntimeReceiptOutcome> {
    let Some(materialization) = store.facts().materialization(team) else {
        return Err(RuntimeReceiptOutcome::Unavailable);
    };
    if store.facts().run(run_id).is_none() {
        return Err(RuntimeReceiptOutcome::Unavailable);
    }
    let mut bindings = Vec::with_capacity(materialization.roles().len());
    for role in materialization.roles() {
        let local_session = LocalSessionReference::try_new(format!(
            "team-role-session-{}-{}",
            run_id.as_str(),
            role.role().as_str()
        ))
        .map_err(|_| RuntimeReceiptOutcome::Unavailable)?;
        let endpoint_session_id = EndpointSessionId::try_new(format!(
            "team-endpoint-session-{}-{}",
            run_id.as_str(),
            role.role().as_str()
        ))
        .map_err(|_| RuntimeReceiptOutcome::Unavailable)?;
        let external_session =
            ExternalSessionReference::try_new(endpoint_session_id.as_str().to_owned())
                .map_err(|_| RuntimeReceiptOutcome::Unavailable)?;
        bindings.push(RoleSessionReceipt::new(
            team.clone(),
            run_id.clone(),
            role.role().clone(),
            local_session,
            external_session,
            role.agent().clone(),
            role.endpoint().clone(),
        ));
    }
    RunRuntimeReceipt::try_new(run_id.clone(), bindings)
        .map_err(|_| RuntimeReceiptOutcome::Unavailable)
}

pub(crate) async fn confirm_runtime_receipt_native(
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
            match EndpointSessionId::try_new(binding.external_session().as_str().to_owned()) {
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

pub(crate) fn install_prepared_runtime_receipt(
    store: &mut OrganizationStore,
    receipt: RunRuntimeReceipt,
) -> Result<(), StoreFault> {
    store.install_runtime_receipt(receipt)
}

async fn readback_native_session(
    gateway: &mut OpenClawGateway,
    binding: &RoleSessionReceipt,
) -> RuntimeReceiptOutcome {
    match OpenClawTeamNativeEffects::new(gateway)
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TeamDeleteOutcome {
    Deleted,
    OutcomeUnknown,
}

pub(crate) fn settle_public_cancellation(
    store: &mut OrganizationStore,
    team_run: &TeamRunOwner,
    run_id: &organization::GraphRunId,
    idempotency_key: &str,
    outcome: RoleAbortOutcome,
    observed_at: u64,
) -> Result<BeginCancellationOutcome, StoreFault> {
    Ok(
        match team_run.settle_cancellation(store, run_id, idempotency_key, outcome, observed_at)? {
            SettleCancellationOutcome::Cancelled | SettleCancellationOutcome::Replayed => {
                BeginCancellationOutcome::AlreadyCancelled
            }
            SettleCancellationOutcome::OutcomeUnknown | SettleCancellationOutcome::Tombstoned => {
                BeginCancellationOutcome::OutcomeUnknown
            }
        },
    )
}

fn materialization_command_outcome(
    outcome: MaterializationOperationOutcome,
) -> ManualTeamCreateOutcome {
    match outcome {
        MaterializationOperationOutcome::Rejected { .. } => ManualTeamCreateOutcome::Rejected,
        MaterializationOperationOutcome::Accepted { .. }
        | MaterializationOperationOutcome::OutcomeUnknown => {
            ManualTeamCreateOutcome::OutcomeUnknown
        }
        MaterializationOperationOutcome::Confirmed { .. } => {
            unreachable!("confirmed materialization is handled before this mapping")
        }
    }
}

fn agent_scoped_session_key(
    binding: &organization::RoleSessionReceipt,
) -> Option<AgentScopedSessionKey> {
    let agent = AgentId::try_new(binding.agent().as_str().to_owned()).ok()?;
    let session =
        EndpointSessionId::try_new(binding.external_session().as_str().to_owned()).ok()?;
    AgentScopedSessionKey::try_new(agent, session).ok()
}

#[cfg(test)]
mod tests {
    use organization::{
        ExternalSessionReference, GraphRunId, LocalSessionReference, ManagedAgentReference, RoleId,
        RuntimeEndpointReference, TeamId,
    };

    use super::*;

    #[test]
    fn role_abort_and_session_cleanup_use_an_agent_scoped_native_key() {
        let binding = organization::RoleSessionReceipt::new(
            TeamId::try_new("team:one").unwrap(),
            GraphRunId::new("run:one"),
            RoleId::try_new("leader").unwrap(),
            LocalSessionReference::try_new("local-session").unwrap(),
            ExternalSessionReference::try_new("endpoint-session").unwrap(),
            ManagedAgentReference::try_new("selected-agent").unwrap(),
            RuntimeEndpointReference::try_new("endpoint:openclaw").unwrap(),
        );

        assert_eq!(
            agent_scoped_session_key(&binding).unwrap().as_str(),
            "agent:selected-agent:endpoint-session"
        );
    }

    #[test]
    fn materialization_only_allows_run_creation_after_a_confirmed_receipt() {
        let source = include_str!("team.rs");
        let confirmed = source
            .find("if !matches!(outcome, MaterializationOperationOutcome::Confirmed")
            .unwrap();
        let create = source
            .rfind(".create(store, run, run_idempotency_key)")
            .unwrap();

        assert!(confirmed < create);
        assert!(source.contains("compile_manual_team_materialization"));
        assert!(source.contains("create_team_materialization(materialization)"));
        assert!(source.contains("remove_team_materialization(removal)"));
    }

    #[test]
    fn replayed_requested_materialization_never_replays_native_effect_or_creates_a_run() {
        let source = include_str!("team.rs");
        let replayed = source
            .find("Ok(MaterializationRecordOutcome::Replayed)")
            .unwrap();
        let native_effect = source[replayed..]
            .find("materialize_team(request)")
            .map(|offset| replayed + offset)
            .unwrap();

        assert!(
            source[replayed..native_effect].contains("ManualTeamCreateOutcome::OutcomeUnknown")
        );
    }
}
