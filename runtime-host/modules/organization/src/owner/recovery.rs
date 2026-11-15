use crate::{GraphRunId, GraphRunLifecycleState, MaterializationOperationOutcome, OrganizationStore, TeamId, TeamMaterializationCleanup, TeamMaterializationRemoval, TeamMaterializationRequest};

use super::actor::OrganizationShared;

pub(crate) struct RecoveryPlan {
    pub(crate) teams: Vec<(TeamId, Option<TeamMaterializationRequest>, Option<TeamMaterializationRemoval>)>,
    pub(crate) runs: Vec<(TeamId, GraphRunId)>,
}

pub(crate) enum RecoverySettlement {
    Materialization(TeamMaterializationRequest, MaterializationOperationOutcome),
    Removal(TeamMaterializationRemoval, MaterializationOperationOutcome),
}

pub(super) fn plan(store: &OrganizationStore) -> RecoveryPlan {
    let teams = store.facts().materialization_lifecycles().filter_map(|lifecycle| {
        let team = lifecycle.team()?.clone();
        let request = lifecycle.receipt_recovery_request().cloned();
        let removal = match lifecycle.cleanup() {
            Some(TeamMaterializationCleanup::OutcomeUnknown(removal))
                if store.facts().runs().filter(|run| run.team() == &team).all(|run| {
                    run.runtime().is_none() && matches!(run.lifecycle().state(), GraphRunLifecycleState::Tombstoned { .. })
                }) => Some(removal.clone()),
            _ => None,
        };
        (request.is_some() || removal.is_some()).then_some((team, request, removal))
    }).collect();
    let runs = store.facts().runs().filter(|run| {
        matches!(run.lifecycle().state(), GraphRunLifecycleState::Active)
            && store.facts().team(run.team()).is_some_and(|team| !team.tombstoned())
            && run.role_session_intents().values().any(|intent| intent.phase != crate::store::RoleSessionPhase::Confirmed)
    }).map(|run| (run.team().clone(), run.run_id().clone())).collect();
    RecoveryPlan { teams, runs }
}

pub(super) async fn team(
    store: &mut OrganizationStore,
    shared: &OrganizationShared,
    request: Option<TeamMaterializationRequest>,
    removal: Option<TeamMaterializationRemoval>,
    cancellation: tokio_util::sync::CancellationToken,
) {
    if let Some(removal) = removal {
        let current = store.facts().materialization_lifecycle(removal.receipt().team(), removal.receipt().endpoint())
            .and_then(|lifecycle| lifecycle.cleanup());
        if matches!(current, Some(TeamMaterializationCleanup::OutcomeUnknown(current)) if current == &removal)
            && let Some(runtime) = shared.team_runtime_for_endpoint(removal.receipt().endpoint())
        {
            if cancellation.is_cancelled() { return; }
            let outcome = runtime.recover_team_removal(removal.clone()).await;
            commit(store, RecoverySettlement::Removal(removal, outcome));
        }
    }
    if let Some(request) = request {
        if store.refresh().is_err() { return; }
        if store.team_materialization_recovery_request(request.intent().team(), request.intent().endpoint()).as_ref() != Some(&request) { return; }
        if let Some(runtime) = shared.team_runtime_for_endpoint(request.intent().endpoint()) {
            if cancellation.is_cancelled() { return; }
            let outcome = runtime.recover_team_materialization(request.clone()).await;
            commit(store, RecoverySettlement::Materialization(request, outcome));
        }
    }
}

fn commit(store: &mut OrganizationStore, settlement: RecoverySettlement) {
    if store.refresh().is_err() { return; }
    match settlement {
        RecoverySettlement::Materialization(request, outcome) => {
            let team = request.intent().team();
            if store.team_materialization_recovery_request(team, request.intent().endpoint()).as_ref() != Some(&request) { return; }
            match outcome {
                MaterializationOperationOutcome::Confirmed { receipt }
                    if receipt.team() == team && receipt.endpoint() == request.intent().endpoint() => { let _ = store.confirm_team_materialization(receipt); }
                outcome @ MaterializationOperationOutcome::Rejected { .. } => { let _ = store.record_team_materialization_outcome(team, request.intent().endpoint(), outcome); }
                _ => {}
            }
        }
        RecoverySettlement::Removal(removal, outcome) => {
            let team = removal.receipt().team();
            if !matches!(store.facts().materialization_lifecycle(team, removal.receipt().endpoint()).and_then(|lifecycle| lifecycle.cleanup()),
                Some(TeamMaterializationCleanup::OutcomeUnknown(current)) if current == &removal)
                || !store.facts().runs().filter(|run| run.team() == team).all(|run| run.runtime().is_none()
                    && matches!(run.lifecycle().state(), GraphRunLifecycleState::Tombstoned { .. })) { return; }
            if matches!(&outcome, MaterializationOperationOutcome::Confirmed { receipt } if receipt == removal.receipt()) {
                let _ = store.record_team_materialization_cleanup_outcome(team, removal.receipt().endpoint(), outcome);
            }
        }
    }
}
