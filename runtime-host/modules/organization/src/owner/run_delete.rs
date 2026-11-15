use organization::{BeginCancellationOutcome, GraphRunId, NativeDeletionEvidence, OrganizationStore, RoleAbortOutcome, StoreFault};

use super::{actor::OrganizationShared, team_run::TeamRunOwner};

pub(super) fn group_role_sessions(
    bindings: Vec<crate::RoleSessionReceipt>,
) -> std::collections::BTreeMap<crate::RuntimeEndpointReference, Vec<crate::RoleSessionReceipt>> {
    let mut groups = std::collections::BTreeMap::new();
    for binding in bindings {
        groups.entry(binding.endpoint().clone()).or_insert_with(Vec::new).push(binding);
    }
    groups
}

pub(super) enum DeletePreparation {
    Native { bindings: Vec<crate::RoleSessionReceipt>, abort_first: bool },
    Complete(crate::GraphRunPurgeOutcome),
}

pub(super) fn prepare(
    store: &mut OrganizationStore,
    team_run: &TeamRunOwner,
    run_id: GraphRunId,
    idempotency_key: &str,
    observed_at: u64,
) -> Result<DeletePreparation, StoreFault> {
    let (bindings, abort_first) = match team_run.begin_cancellation(
        store,
        &run_id,
        &idempotency_key,
        observed_at,
    ) {
        Ok(BeginCancellationOutcome::Started(plan))
        | Ok(BeginCancellationOutcome::Replayed(plan)) => (plan.bindings().to_vec(), true),
        Ok(BeginCancellationOutcome::OutcomeUnknown) => (
            store.facts().run(&run_id).ok_or(StoreFault::InvalidFacts)?.confirmed_role_sessions(), true,
        ),
        Ok(BeginCancellationOutcome::AlreadyCancelled)
        | Ok(BeginCancellationOutcome::Tombstoned) => (store.facts().run(&run_id).map(|run| run.confirmed_role_sessions()).unwrap_or_default(), false),
        Err(error) => return Err(error),
    };
    if let Some(run) = store.facts().run(&run_id) {
        let proof = crate::NativeDeletionProof::try_new(run_id.clone(), run.deletion_confirmations().to_vec())
            .map_err(|_| StoreFault::InvalidFacts)?;
        if proof.covers(&bindings) {
            return complete_team_run_delete_native_evidence(store, team_run, run_id, idempotency_key,
                NativeDeletionEvidence::Confirmed(proof), observed_at).map(DeletePreparation::Complete);
        }
    }
    Ok(DeletePreparation::Native { bindings, abort_first })
}

pub(super) fn delete_run_sessions(
    store: &OrganizationStore,
    shared: &OrganizationShared,
    run_id: GraphRunId,
    bindings: Vec<organization::RoleSessionReceipt>,
    abort_first: bool,
    cancellation: tokio_util::sync::CancellationToken,
) -> runtime_directory::OwnedRuntimeFuture<NativeDeletionEvidence> {
    let confirmations = store.facts().run(&run_id).map(|run| run.deletion_confirmations()).unwrap_or_default();
    let bindings = bindings.into_iter().filter(|binding| !confirmations.iter()
        .any(|confirmation| confirmation.binding() == binding)).collect();
    let cleanup_cancellation = cancellation.child_token();
    let pending = store.facts().run(&run_id).map(|run| run.role_session_intents().values()
        .filter(|intent| intent.phase != crate::store::RoleSessionPhase::Confirmed)
        .map(|intent| intent.binding.clone()).collect::<Vec<_>>()).unwrap_or_default();
    let shared = shared.clone();
    Box::pin(async move {
        let _cleanup_guard = cleanup_cancellation.clone().drop_guard();
        let cleanup_run = run_id.clone();
        let cleanup_shared = shared.clone();
        let cleanup = async move {
            for binding in pending {
                let _ = cleanup_shared.team_delete_role_sessions(
                    cleanup_run.clone(), vec![binding], false, cleanup_cancellation.clone(),
                ).await;
            }
        };
        let mut native = shared.team_delete_role_sessions(run_id, bindings, abort_first, cancellation);
        // Unconfirmed additions get only the time spent deleting confirmed sessions.
        tokio::select! {
            biased;
            outcome = &mut native => outcome,
            _ = cleanup => native.await,
        }
    })
}

pub(super) fn complete_team_run_delete_native_evidence(
    store: &mut OrganizationStore,
    team_run: &TeamRunOwner,
    run_id: GraphRunId,
    idempotency_key: &str,
    native: NativeDeletionEvidence,
    observed_at: u64,
) -> Result<organization::GraphRunPurgeOutcome, StoreFault> {
    let native = store.record_run_deletion_evidence(&run_id, native)?;
    let confirmed = matches!(native, NativeDeletionEvidence::Confirmed(_));
    let state = store.facts().run(&run_id).ok_or(StoreFault::InvalidFacts)?.lifecycle().state().clone();
    match state {
        organization::GraphRunLifecycleState::Cancelling { idempotency_key: key, .. }
        | organization::GraphRunLifecycleState::OutcomeUnknown { idempotency_key: key, .. } => {
            let outcome = if confirmed { RoleAbortOutcome::Confirmed } else { RoleAbortOutcome::OutcomeUnknown };
            if team_run.settle_cancellation(store, &run_id, &key, outcome, observed_at)?
                == organization::SettleCancellationOutcome::OutcomeUnknown
            {
                return Ok(match native.failure() {
                    Some(crate::NativeDeletionFailure::Rejected) => organization::GraphRunPurgeOutcome::Rejected(
                        organization::GraphRunPurgeRejection::NativeDeletionRejected),
                    _ => organization::GraphRunPurgeOutcome::OutcomeUnknown(
                        organization::GraphRunPurgeUnknown::NativeDeletionOutcomeUnknown),
                });
            }
        }
        organization::GraphRunLifecycleState::Cancelled { .. }
        | organization::GraphRunLifecycleState::Tombstoned { .. } => {}
        organization::GraphRunLifecycleState::Active => return Err(StoreFault::InvalidFacts),
    }
    if confirmed && !matches!(store.facts().run(&run_id).map(|run| run.lifecycle().state()),
        Some(organization::GraphRunLifecycleState::Tombstoned { .. }))
    {
        match team_run.tombstone(store, &run_id, idempotency_key, observed_at)? {
            organization::TombstoneOutcome::Tombstoned | organization::TombstoneOutcome::Replayed => {}
            _ => return Ok(organization::GraphRunPurgeOutcome::OutcomeUnknown(
                organization::GraphRunPurgeUnknown::NativeDeletionOutcomeUnknown)),
        }
    }
    team_run.purge(store, organization::TeamRunPurgeRequest::new(run_id, idempotency_key.to_owned(), native))
}

