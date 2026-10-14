use organization::{BeginCancellationOutcome, GraphRunId, NativeDeletionEvidence, OrganizationStore, RoleAbortOutcome, StoreFault};

use super::{actor::OrganizationShared, team_run::TeamRunOwner};

pub(super) async fn run_delete_and_purge(
    store: &mut OrganizationStore,
    team_run: &TeamRunOwner,
    shared: &OrganizationShared,
    run_id: GraphRunId,
    idempotency_key: String,
    observed_at: u64,
    cancellation: tokio_util::sync::CancellationToken,
) -> Result<organization::GraphRunPurgeOutcome, StoreFault> {
    let (bindings, abort_first) = match team_run.begin_cancellation(
        store,
        &run_id,
        &idempotency_key,
        observed_at,
    ) {
        Ok(BeginCancellationOutcome::Started(plan)) => (plan.bindings().to_vec(), true),
        Ok(BeginCancellationOutcome::Replayed(_))
        | Ok(BeginCancellationOutcome::OutcomeUnknown) => {
            return complete_team_run_delete_native_evidence(store, team_run,
                run_id,
                &idempotency_key,
                NativeDeletionEvidence::OutcomeUnknown,
                observed_at,
            );
        }
        Ok(BeginCancellationOutcome::AlreadyCancelled)
        | Ok(BeginCancellationOutcome::Tombstoned) => (store.facts().run(&run_id).and_then(|run| run.runtime()).map(|runtime| runtime.bindings().to_vec()).unwrap_or_default(), false),
        Err(error) => return Err(error),
    };
    let outcome = shared
        .team_delete_role_sessions(run_id.clone(), bindings, abort_first, cancellation)
        .await;
    complete_team_run_delete_native_evidence(store, team_run,
        run_id,
        &idempotency_key,
        outcome,
        observed_at,
    )
}

pub(super) fn complete_team_run_delete_native_evidence(
    store: &mut OrganizationStore,
    team_run: &TeamRunOwner,
    run_id: GraphRunId,
    idempotency_key: &str,
    native: NativeDeletionEvidence,
    observed_at: u64,
) -> Result<organization::GraphRunPurgeOutcome, StoreFault> {
    if matches!(native, NativeDeletionEvidence::Confirmed(_)) {
        match team_run.settle_cancellation(
            store,
            &run_id,
            idempotency_key,
            RoleAbortOutcome::Confirmed,
            observed_at,
        )? {
            organization::SettleCancellationOutcome::Cancelled
            | organization::SettleCancellationOutcome::Replayed
            | organization::SettleCancellationOutcome::Tombstoned => {}
            organization::SettleCancellationOutcome::OutcomeUnknown => {
                return Ok(organization::GraphRunPurgeOutcome::OutcomeUnknown(
                    organization::GraphRunPurgeUnknown::NativeDeletionOutcomeUnknown,
                ));
            }
        }
        return purge_cancelled_team_run_delete_native_evidence(store, team_run,
            run_id,
            idempotency_key,
            native,
            observed_at,
        );
    }
    let _ = team_run.settle_cancellation(
        store,
        &run_id,
        idempotency_key,
        RoleAbortOutcome::OutcomeUnknown,
        observed_at,
    )?;
    team_run.purge(
        store,
        organization::TeamRunPurgeRequest::new(run_id, idempotency_key.to_owned(), native),
    )
}

pub(super) fn complete_cancelled_team_run_delete_native_evidence(
    store: &mut OrganizationStore,
    team_run: &TeamRunOwner,
    run_id: GraphRunId,
    idempotency_key: &str,
    native: NativeDeletionEvidence,
    observed_at: u64,
) -> Result<organization::GraphRunPurgeOutcome, StoreFault> {
    if matches!(native, NativeDeletionEvidence::Confirmed(_)) {
        return purge_cancelled_team_run_delete_native_evidence(store, team_run,
            run_id,
            idempotency_key,
            native,
            observed_at,
        );
    }
    team_run.purge(
        store,
        organization::TeamRunPurgeRequest::new(run_id, idempotency_key.to_owned(), native),
    )
}

pub(super) fn purge_cancelled_team_run_delete_native_evidence(
    store: &mut OrganizationStore,
    team_run: &TeamRunOwner,
    run_id: GraphRunId,
    idempotency_key: &str,
    native: NativeDeletionEvidence,
    observed_at: u64,
) -> Result<organization::GraphRunPurgeOutcome, StoreFault> {
    match team_run.tombstone(store, &run_id, idempotency_key, observed_at)?
    {
        organization::TombstoneOutcome::Tombstoned
        | organization::TombstoneOutcome::Replayed => {}
        organization::TombstoneOutcome::CancellationRequired(_)
        | organization::TombstoneOutcome::OutcomeUnknown => {
            return Ok(organization::GraphRunPurgeOutcome::OutcomeUnknown(
                organization::GraphRunPurgeUnknown::NativeDeletionOutcomeUnknown,
            ));
        }
    }
    purge_tombstoned_team_run_delete_native_evidence(store, team_run,run_id, idempotency_key, native)
}

pub(super) fn purge_tombstoned_team_run_delete_native_evidence(
    store: &mut OrganizationStore,
    team_run: &TeamRunOwner,
    run_id: GraphRunId,
    idempotency_key: &str,
    native: NativeDeletionEvidence,
) -> Result<organization::GraphRunPurgeOutcome, StoreFault> {
    team_run.purge(
        store,
        organization::TeamRunPurgeRequest::new(run_id, idempotency_key.to_owned(), native),
    )
}

