use crate::{
    GraphRunId, GraphRunLifecycleState, IdempotencyKey, OrganizationStore, RoleId,
    RoleSessionReceipt, RoleSessionSubmission, RuntimeReceiptOutcome,
    StoreFault, TeamId, application::team_runtime::{RoleSessionCreateError, RoleSessionCreateScope, TeamRuntimeStatus},
};
use tokio_util::sync::CancellationToken;

use super::actor::OrganizationShared;

pub(super) async fn create(
    store: &mut OrganizationStore,
    shared: &OrganizationShared,
    team: TeamId,
    run: GraphRunId,
    role: RoleId,
    key: IdempotencyKey,
    scope: RoleSessionCreateScope,
    cancellation: CancellationToken,
    reply: &crate::call::CallReply<Result<RoleSessionReceipt, RoleSessionCreateError>>,
) -> Result<RoleSessionReceipt, RoleSessionCreateError> {
    use RoleSessionCreateError::{Runtime, Store};
    let intent = store.reserve_role_session(&team, &run, &role, &key, &scope).map_err(Store)?;
    let binding = intent.binding;
    if store.facts().run(&run).is_some_and(|run| run.session_installed(&binding)) {
        return Ok(binding);
    }
    let runtime = shared.team_runtime_for_endpoint(binding.endpoint()).ok_or(Runtime(TeamRuntimeStatus::Unavailable))?;
    let outcome = if intent.submission_uncertain {
        let (outcome, failure) = runtime.readback_team_role_session_cancellable(binding.clone(), cancellation).await;
        if let Some(failure) = failure { reply.creation_failure(failure).await; }
        if !matches!(outcome, RuntimeReceiptOutcome::Installed) {
            return Err(Runtime(TeamRuntimeStatus::OutcomeUnknown));
        }
        outcome
    } else {
        if cancellation.is_cancelled() { return Err(Runtime(TeamRuntimeStatus::Unavailable)); }
        store.mark_role_session_submission(key.as_str(), &binding, true).map_err(Store)?;
        let result = runtime.create_team_role_session_cancellable(binding.clone(), cancellation).await;
        if let Some(failure) = result.failure { reply.creation_failure(failure).await; }
        if !matches!(result.submission, RoleSessionSubmission::Settled) {
            return Err(Runtime(TeamRuntimeStatus::OutcomeUnknown));
        }
        if !matches!(result.outcome, RuntimeReceiptOutcome::Installed)
            && store.mark_role_session_submission(key.as_str(), &binding, false).is_err()
        {
            return Err(Runtime(TeamRuntimeStatus::OutcomeUnknown));
        }
        result.outcome
    };
    match outcome {
        RuntimeReceiptOutcome::Installed => {}
        RuntimeReceiptOutcome::Rejected => return Err(Runtime(TeamRuntimeStatus::Rejected)),
        RuntimeReceiptOutcome::Unavailable => return Err(Runtime(TeamRuntimeStatus::Unavailable)),
        RuntimeReceiptOutcome::OutcomeUnknown => return Err(Runtime(TeamRuntimeStatus::OutcomeUnknown)),
    }
    if store.confirm_role_session(key.as_str(), &binding).is_err() {
        // The native identity is already confirmed. A local commit failure is never a rejection.
        return Err(Runtime(TeamRuntimeStatus::OutcomeUnknown));
    }
    Ok(binding)
}

pub(super) async fn recover(store: &mut OrganizationStore, shared: &OrganizationShared) {
    let pending = store.facts().runs()
        .filter(|run| matches!(run.lifecycle().state(), GraphRunLifecycleState::Active)
            && store.facts().team(run.team()).is_some_and(|team| !team.tombstoned()))
        .flat_map(|run| run.role_session_intents().iter()
            .filter(|(_, intent)| !run.session_installed(&intent.binding))
            .map(|(key, intent)| (key.clone(), intent.binding.clone())))
        .collect::<Vec<_>>();
    for (key, binding) in pending {
        let Some(runtime) = shared.team_runtime_for_endpoint(binding.endpoint()) else { continue; };
        if matches!(runtime.readback_team_role_session_cancellable(binding.clone(), CancellationToken::new()).await.0,
            RuntimeReceiptOutcome::Installed)
        {
            let _ = store.confirm_role_session(&key, &binding);
        }
    }
}

pub(super) fn store_status(error: StoreFault) -> TeamRuntimeStatus {
    match error {
        StoreFault::InvalidFacts | StoreFault::RuntimeReceipt(_) => TeamRuntimeStatus::Rejected,
        StoreFault::CommitOutcomeUnknown(_) | StoreFault::RecoveryRequired => TeamRuntimeStatus::OutcomeUnknown,
        _ => TeamRuntimeStatus::Unavailable,
    }
}
