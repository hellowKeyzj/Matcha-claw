use std::time::Instant;

use organization::{CreateGraphRunOutcome, IdempotencyKey, MaterializationRecordOutcome, OrganizationStore, RuntimeEndpointReference, TeamId};
use platform::trace::session_trace;
use serde_json::json;

use crate::{TeamCreationFailure, TeamCreationFailureReason, TeamCreationStage, ports::RuntimeReceiptOutcome};

use super::{
    actor::{OrganizationShared, materialization_outcome_label, manual_materialization_outcome, manual_runtime_receipt_outcome, runtime_receipt_failure_reason, runtime_receipt_label, trace_store_result},
    team_run::{ManualTeamCreateOutcome, ManualTeamMaterializationInput, TeamMaterializationCommandOutcome, TeamRunOwner, creation_store_failure, install_prepared_runtime_receipt, prepare_runtime_receipt},
};

pub(super) async fn begin_team_materialization<T>(
    store: &mut OrganizationStore,
    materialization: organization::TeamMaterialization,
    call: Option<&crate::call::CallReply<T>>,
) -> Result<(TeamId, organization::TeamMaterializationRequest), TeamMaterializationCommandOutcome>
{
    let team = materialization.definition().team_id().clone();
    let request = materialization.request().clone();
    let started = platform::trace::enabled().then(Instant::now);
    session_trace("runtime.team.materialization.begin.start", || json!({}));
    let committed = store.create_team_materialization(materialization);
    trace_store_result(
        "runtime.team.materialization.begin.commit",
        started,
        &committed,
    );
    session_trace(
        "runtime.team.materialization.begin.end",
        || json!({"reason": match &committed {
        Ok(MaterializationRecordOutcome::Recorded) => "recorded",
        Ok(MaterializationRecordOutcome::Replayed) => "replayed",
        Err(_) => "store_fault",
    }, "elapsedMs": started.map(|started| started.elapsed().as_millis())}),
    );
    if let (Some(call), Err(error)) = (call, &committed) {
        call.creation_failure(creation_store_failure(TeamCreationStage::Submitting, error)).await;
        call.materialization(None, Err(error)).await;
    }
    match committed {
        Ok(MaterializationRecordOutcome::Recorded) => Ok((team, request)),
        Ok(MaterializationRecordOutcome::Replayed) => {
            Err(TeamMaterializationCommandOutcome::OutcomeUnknown)
        }
        Err(_) => Err(TeamMaterializationCommandOutcome::Unavailable),
    }
}

pub(super) async fn settle_team_materialization_outcome(
    store: &mut OrganizationStore,
    team: &TeamId,
    managed_agent_count: usize,
    outcome: organization::MaterializationOperationOutcome,
    call: Option<&crate::call::CallReply<TeamMaterializationCommandOutcome>>,
) -> TeamMaterializationCommandOutcome {
    let started = platform::trace::enabled().then(Instant::now);
    session_trace(
        "runtime.team.materialization.settle.start",
        || json!({"nativeOutcome": materialization_outcome_label(&outcome)}),
    );
    let committed = store.record_team_materialization_outcome(team, outcome.clone());
    trace_store_result(
        "runtime.team.materialization.settle.commit",
        started,
        &committed,
    );
    if let Some(call) = call {
        if let Err(error) = &committed {
            call.creation_failure(creation_store_failure(TeamCreationStage::SavingTeam, error)).await;
        }
        let installed = match &outcome {
            organization::MaterializationOperationOutcome::Confirmed { .. } => Some(true),
            organization::MaterializationOperationOutcome::Rejected { .. } => Some(false),
            organization::MaterializationOperationOutcome::Accepted { .. }
            | organization::MaterializationOperationOutcome::OutcomeUnknown => None,
        };
        call.materialization(installed, committed.as_ref().map(|_| ()))
            .await;
    }
    committed.map_or(
        TeamMaterializationCommandOutcome::Unavailable,
        |_| match outcome {
            organization::MaterializationOperationOutcome::Confirmed { .. } => {
                TeamMaterializationCommandOutcome::Materialized {
                    team_id: team.clone(),
                    managed_agent_count,
                }
            }
            organization::MaterializationOperationOutcome::Rejected { .. } => {
                TeamMaterializationCommandOutcome::Rejected
            }
            organization::MaterializationOperationOutcome::Accepted { .. }
            | organization::MaterializationOperationOutcome::OutcomeUnknown => {
                TeamMaterializationCommandOutcome::OutcomeUnknown
            }
        },
    )
}

pub(super) async fn manual_team_materialize(
    store: &mut OrganizationStore,
    shared: &OrganizationShared,
    team_id: TeamId,
    team_name: String,
    endpoint: RuntimeEndpointReference,
    roles: Vec<organization::ManualTeamRoleBinding>,
    idempotency_key: IdempotencyKey,
    call: Option<&crate::call::CallReply<TeamMaterializationCommandOutcome>>,
) -> TeamMaterializationCommandOutcome {
    let started = platform::trace::enabled().then(Instant::now);
    session_trace(
        "runtime.team.compile.start",
        || json!({"roleCount": roles.len()}),
    );
    let compiled = organization::compile_manual_team_materialization(
        team_id,
        team_name,
        endpoint,
        roles,
        idempotency_key,
    );
    session_trace(
        "runtime.team.compile.end",
        || json!({"reason": match &compiled {
        Ok(_) => "compiled", Err(organization::TeamMaterializationError::Invalid) => "invalid",
    }, "elapsedMs": started.map(|started| started.elapsed().as_millis())}),
    );
    let materialization = match compiled {
        Ok(materialization) => materialization,
        Err(_) => {
            if let Some(call) = call {
                call.creation_failure(TeamCreationFailure::new(
                    TeamCreationStage::Submitting, TeamCreationFailureReason::InvalidInput,
                )).await;
            }
            return TeamMaterializationCommandOutcome::Rejected;
        }
    };
    let observer = call.and_then(crate::call::CallReply::provision_observer);
    let cancellation = call.map_or_else(
        tokio_util::sync::CancellationToken::new,
        crate::call::CallReply::cancellation,
    );
    let materialization = match super::member_introduction::prepare_manual_team(
        materialization,
        store.facts(),
        shared.runtime_directory.as_ref(),
        shared.member_introductions.as_ref(),
        observer.as_ref(),
        cancellation.clone(),
    )
    .await
    {
        Ok(materialization) => materialization,
        Err(super::member_introduction::PreparationError::Rejected(failure)) => {
            if let Some(call) = call { call.creation_failure(failure).await; }
            return TeamMaterializationCommandOutcome::Rejected;
        }
        Err(super::member_introduction::PreparationError::Unavailable(failure)) => {
            if let Some(call) = call { call.creation_failure(failure).await; }
            return TeamMaterializationCommandOutcome::Unavailable;
        }
    };
    let team_id = materialization.definition().team_id().clone();
    let managed_agent_count = materialization.request().intent().agents().len();
    let request = match begin_team_materialization(store, materialization, call).await {
        Ok((_, request)) => request,
        Err(outcome) => return outcome,
    };
    let outcome = shared
        .team_materialize(
            request,
            observer.clone(),
            cancellation,
        )
        .await;
    if matches!(outcome, organization::MaterializationOperationOutcome::Confirmed { .. }) {
        if let Some(observer) = &observer {
            observer.report(crate::TeamProvisionUpdate::Stage(
                crate::TeamProvisionStage::SavingTeam,
            )).await;
        }
    }
    settle_team_materialization_outcome(store, &team_id, managed_agent_count, outcome, call)
        .await
}

pub(super) async fn manual_team_create(
    store: &mut OrganizationStore,
    team_run: &TeamRunOwner,
    shared: &OrganizationShared,
    input: ManualTeamMaterializationInput,
    call: &crate::call::CallReply<ManualTeamCreateOutcome>,
) -> ManualTeamCreateOutcome {
    let ManualTeamMaterializationInput {
        team_id,
        team_name,
        endpoint,
        roles,
        materialization_idempotency_key,
        run,
        run_idempotency_key,
    } = input;
    let started = platform::trace::enabled().then(Instant::now);
    session_trace(
        "runtime.team.compile.start",
        || json!({"roleCount": roles.len()}),
    );
    let compiled = organization::compile_manual_team_materialization(
        team_id,
        team_name,
        endpoint,
        roles,
        materialization_idempotency_key,
    );
    session_trace(
        "runtime.team.compile.end",
        || json!({"reason": match &compiled {
        Ok(_) => "compiled", Err(organization::TeamMaterializationError::Invalid) => "invalid",
    }, "elapsedMs": started.map(|started| started.elapsed().as_millis())}),
    );
    let materialization = match compiled {
        Ok(materialization) => materialization,
        Err(_) => {
            call.creation_failure(TeamCreationFailure::new(
                TeamCreationStage::Submitting, TeamCreationFailureReason::InvalidInput,
            )).await;
            return ManualTeamCreateOutcome::Rejected;
        }
    };
    let observer = call.provision_observer();
    let materialization = match super::member_introduction::prepare_manual_team(
        materialization,
        store.facts(),
        shared.runtime_directory.as_ref(),
        shared.member_introductions.as_ref(),
        None,
        call.cancellation(),
    )
    .await
    {
        Ok(materialization) => materialization,
        Err(super::member_introduction::PreparationError::Rejected(failure)) => {
            call.creation_failure(failure).await;
            return ManualTeamCreateOutcome::Rejected;
        }
        Err(super::member_introduction::PreparationError::Unavailable(failure)) => {
            call.creation_failure(failure).await;
            return ManualTeamCreateOutcome::Unavailable;
        }
    };
    let team_id = materialization.definition().team_id().clone();
    let request = match begin_team_materialization(store, materialization, Some(call))
        .await
    {
        Ok((_, request)) => request,
        Err(TeamMaterializationCommandOutcome::Rejected) => {
            return ManualTeamCreateOutcome::Rejected;
        }
        Err(TeamMaterializationCommandOutcome::OutcomeUnknown) => {
            return ManualTeamCreateOutcome::OutcomeUnknown;
        }
        Err(TeamMaterializationCommandOutcome::Unavailable) => {
            return ManualTeamCreateOutcome::Unavailable;
        }
        Err(TeamMaterializationCommandOutcome::Materialized { .. }) => {
            return ManualTeamCreateOutcome::OutcomeUnknown;
        }
    };
    let outcome = shared
        .team_materialize(request, observer, call.cancellation())
        .await;
    let started = platform::trace::enabled().then(Instant::now);
    session_trace(
        "runtime.team.materialization.settle.start",
        || json!({"nativeOutcome": materialization_outcome_label(&outcome)}),
    );
    let committed = store.record_team_materialization_outcome(&team_id, outcome.clone());
    trace_store_result(
        "runtime.team.materialization.settle.commit",
        started,
        &committed,
    );
    let native = match &outcome {
        organization::MaterializationOperationOutcome::Confirmed { .. } => Some(true),
        organization::MaterializationOperationOutcome::Rejected { .. } => Some(false),
        _ => None,
    };
    call.materialization(native, committed.as_ref().map(|_| ()))
        .await;
    if let Err(error) = &committed {
        call.creation_failure(creation_store_failure(TeamCreationStage::SavingTeam, error)).await;
        return ManualTeamCreateOutcome::Unavailable;
    }
    if !matches!(
        outcome,
        organization::MaterializationOperationOutcome::Confirmed { .. }
    ) {
        return manual_materialization_outcome(outcome);
    }
    let run_id = run.run_id().clone();
    let started = platform::trace::enabled().then(Instant::now);
    session_trace("runtime.team.run_create.start", || json!({}));
    let committed = team_run.create(store, run, &run_idempotency_key);
    trace_store_result("runtime.team.run_create.commit", started, &committed);
    session_trace(
        "runtime.team.run_create.end",
        || json!({"reason": match &committed {
        Ok(CreateGraphRunOutcome::Created(_)) => "created",
        Ok(CreateGraphRunOutcome::Replayed(_)) => "replayed",
        Ok(CreateGraphRunOutcome::ConflictingIdempotency) => "conflicting_idempotency",
        Ok(CreateGraphRunOutcome::ExistingRun) => "existing_run",
        Err(_) => "store_fault",
    }, "elapsedMs": started.map(|started| started.elapsed().as_millis())}),
    );
    if let Err(error) = &committed {
        call.creation_failure(creation_store_failure(TeamCreationStage::InitializingSessions, error)).await;
        call.creation(None, Err(error)).await;
    }
    let created = match committed {
        Ok(created) => created,
        Err(_) => return ManualTeamCreateOutcome::Unavailable,
    };
    if matches!(created, CreateGraphRunOutcome::ConflictingIdempotency) {
        call.creation_failure(TeamCreationFailure::new(
            TeamCreationStage::InitializingSessions, TeamCreationFailureReason::StoreConflict,
        )).await;
        return ManualTeamCreateOutcome::Unavailable;
    }
    call.creation(None, Ok(())).await;
    let started = platform::trace::enabled().then(Instant::now);
    session_trace("runtime.team.install.prepare.start", || json!({}));
    let prepared = prepare_runtime_receipt(store, &team_id, &run_id);
    session_trace(
        "runtime.team.install.prepare.end",
        || json!({"reason": prepared.as_ref().map_or_else(|(outcome, _)| runtime_receipt_label(outcome), |_| "prepared"), "elapsedMs": started.map(|started| started.elapsed().as_millis())}),
    );
    let receipt = match prepared {
        Ok(receipt) => receipt,
        Err((outcome, failure)) => {
            call.creation_failure(failure).await;
            call.creation(
                if matches!(outcome, RuntimeReceiptOutcome::Rejected) {
                    Some(false)
                } else {
                    None
                },
                Ok(()),
            )
            .await;
            return manual_runtime_receipt_outcome(outcome);
        }
    };
    let (outcome, creation_failure) = shared
        .team_confirm_receipt(receipt.clone(), call.cancellation())
        .await;
    match outcome {
        RuntimeReceiptOutcome::Installed => {
            let started = platform::trace::enabled().then(Instant::now);
            session_trace("runtime.team.install.commit.start", || json!({}));
            let committed = install_prepared_runtime_receipt(store, receipt);
            trace_store_result("runtime.team.install.commit.end", started, &committed);
            if let Err(error) = &committed {
                call.creation_failure(creation_store_failure(TeamCreationStage::InitializingSessions, error)).await;
            }
            call.creation(Some(true), committed.as_ref().map(|_| ()))
                .await;
            committed.map_or(ManualTeamCreateOutcome::Unavailable, |_| {
                ManualTeamCreateOutcome::Created(created)
            })
        }
        outcome => {
            call.creation_failure(creation_failure.unwrap_or_else(|| TeamCreationFailure::new(
                TeamCreationStage::InitializingSessions, runtime_receipt_failure_reason(&outcome),
            ))).await;
            call.creation(
                if matches!(outcome, RuntimeReceiptOutcome::Rejected) {
                    Some(false)
                } else {
                    None
                },
                Ok(()),
            )
            .await;
            manual_runtime_receipt_outcome(outcome)
        }
    }
}

