use std::{future::Future, pin::Pin, sync::Arc, time::Instant};

use futures_util::{StreamExt, stream::FuturesUnordered};
use organization::{CreateGraphRunOutcome, IdempotencyKey, MaterializationRecordOutcome, OrganizationStore, TeamId};
use platform::trace::session_trace;
use serde_json::json;

use crate::{TeamCreationFailure, TeamCreationFailureReason, TeamCreationStage, TeamProvisionObserver, TeamProvisionReporter, TeamProvisionStage, TeamProvisionUpdate, ports::RuntimeReceiptOutcome};

use super::{
    actor::{OrganizationShared, materialization_outcome_label, manual_runtime_receipt_outcome, runtime_receipt_failure_reason, runtime_receipt_label, trace_store_result},
    team_run::{ManualTeamCreateOutcome, ManualTeamMaterializationInput, TeamMaterializationCommandOutcome, TeamRunOwner, creation_store_failure, install_prepared_runtime_receipt, prepare_runtime_receipt},
};

struct MaterializationObserver {
    observer: TeamProvisionObserver,
    stages: Arc<tokio::sync::Mutex<Vec<TeamProvisionStage>>>,
    group: usize,
}

impl TeamProvisionReporter for MaterializationObserver {
    fn report(&self, update: TeamProvisionUpdate) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            if let TeamProvisionUpdate::Stage(stage) = update {
                let mut stages = self.stages.lock().await;
                stages[self.group] = stage;
                let stage = stages.iter().copied().min_by_key(|stage| match stage {
                    TeamProvisionStage::RollingBack => 0,
                    TeamProvisionStage::ReadingProfiles => 1,
                    TeamProvisionStage::GeneratingIntroductions => 2,
                    TeamProvisionStage::ConfiguringTeam => 3,
                    TeamProvisionStage::VerifyingTeam => 4,
                    TeamProvisionStage::SavingTeam => 5,
                }).expect("materialization progress has a group");
                self.observer.report(TeamProvisionUpdate::Stage(stage)).await;
            } else {
                self.observer.report(update).await;
            }
        })
    }
}

async fn begin_team_materialization<T>(
    store: &mut OrganizationStore,
    materialization: organization::TeamMaterialization,
    call: Option<&crate::call::CallReply<T>>,
) -> Result<(Vec<organization::TeamMaterializationRequest>, MaterializationRecordOutcome), TeamMaterializationCommandOutcome>
{
    let requests = materialization.requests().to_vec();
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
    committed.map(|recorded| (requests, recorded))
        .map_err(|_| TeamMaterializationCommandOutcome::Unavailable)
}

pub(super) async fn materialize_team<T>(
    store: &mut OrganizationStore,
    shared: &OrganizationShared,
    materialization: organization::TeamMaterialization,
    observer: Option<crate::TeamProvisionObserver>,
    cancellation: tokio_util::sync::CancellationToken,
    call: Option<&crate::call::CallReply<T>>,
) -> TeamMaterializationCommandOutcome {
    let team = materialization.definition().team_id().clone();
    let managed_agent_count = materialization.requests().iter()
        .map(|request| request.intent().agents().len()).sum();
    let (requests, recorded) = match begin_team_materialization(store, materialization, call).await {
        Ok(prepared) => prepared,
        Err(outcome) => return outcome,
    };
    let readback = recorded == MaterializationRecordOutcome::Replayed;
    let mut unknown = false;
    let mut rejected = false;
    let mut requests = requests.into_iter().filter(|request| {
        if !readback { return true; }
        match store.facts().materialization_lifecycle(&team, request.intent().endpoint()) {
            Some(crate::TeamMaterializationLifecycle::Confirmed(_)) => false,
            Some(crate::TeamMaterializationLifecycle::Rejected { .. }) => { rejected = true; false }
            Some(crate::TeamMaterializationLifecycle::Requested(_) | crate::TeamMaterializationLifecycle::OutcomeUnknown(_)) => true,
            _ => { unknown = true; false }
        }
    }).collect::<Vec<_>>().into_iter().enumerate();
    let progress = observer.as_ref().map(|observer| (
        Arc::clone(observer),
        Arc::new(tokio::sync::Mutex::new(vec![TeamProvisionStage::ConfiguringTeam; requests.len()])),
    ));
    let mut active = FuturesUnordered::new();
    let mut commit_error = None;
    loop {
        while active.len() < 4 {
            let Some((group, request)) = requests.next() else { break; };
            let observer = progress.as_ref().map(|(observer, stages)| Arc::new(MaterializationObserver {
                observer: Arc::clone(observer), stages: Arc::clone(stages), group,
            }) as TeamProvisionObserver);
            let native = if readback {
                match shared.team_runtime_for_endpoint(request.intent().endpoint()) {
                    Some(runtime) if !cancellation.is_cancelled() => runtime.recover_team_materialization(request.clone()),
                    _ => Box::pin(async { crate::MaterializationOperationOutcome::OutcomeUnknown }),
                }
            } else {
                shared.team_materialize(request.clone(), observer.clone(), cancellation.clone())
            };
            active.push(async move { (request, native.await, observer) });
        }
        let Some((request, outcome, progress)) = active.next().await else { break; };
        match &outcome {
            crate::MaterializationOperationOutcome::Confirmed { .. } => {}
            crate::MaterializationOperationOutcome::Rejected { .. } => rejected = true,
            _ => unknown = true,
        }
        let confirmed = matches!(outcome, crate::MaterializationOperationOutcome::Confirmed { .. });
        let started = platform::trace::enabled().then(Instant::now);
        session_trace("runtime.team.materialization.settle.start", || json!({"nativeOutcome": materialization_outcome_label(&outcome)}));
        let committed = match outcome {
            crate::MaterializationOperationOutcome::Confirmed { receipt } if readback => {
                if receipt.team() == request.intent().team() && receipt.endpoint() == request.intent().endpoint() {
                    store.confirm_team_materialization(receipt)
                } else {
                    Err(crate::StoreFault::InvalidFacts)
                }
            }
            crate::MaterializationOperationOutcome::Accepted { .. } | crate::MaterializationOperationOutcome::OutcomeUnknown if readback => Ok(MaterializationRecordOutcome::Replayed),
            outcome => store.record_team_materialization_outcome(&team, request.intent().endpoint(), outcome),
        };
        trace_store_result("runtime.team.materialization.settle.commit", started, &committed);
        if let Err(error) = committed {
            if let Some(call) = call {
                call.creation_failure(creation_store_failure(TeamCreationStage::SavingTeam, &error)).await;
            }
            if commit_error.is_none() { commit_error = Some(error); }
        } else if confirmed {
            if let Some(progress) = progress {
                progress.report(TeamProvisionUpdate::Stage(TeamProvisionStage::SavingTeam)).await;
            }
        }
    }
    let native = if unknown { None } else { Some(!rejected) };
    if native == Some(true) {
        if let Some(observer) = &observer {
            observer.report(crate::TeamProvisionUpdate::Stage(crate::TeamProvisionStage::SavingTeam)).await;
        }
    }
    if let Some(call) = call {
        call.materialization(native, commit_error.as_ref().map_or(Ok(()), Err)).await;
    }
    if commit_error.is_some() {
        TeamMaterializationCommandOutcome::Unavailable
    } else if store.facts().materialization(&team).is_some() {
        TeamMaterializationCommandOutcome::Materialized { team_id: team, managed_agent_count }
    } else if unknown {
        TeamMaterializationCommandOutcome::OutcomeUnknown
    } else if rejected {
        TeamMaterializationCommandOutcome::Rejected
    } else {
        TeamMaterializationCommandOutcome::OutcomeUnknown
    }
}

pub(super) async fn manual_team_materialize(
    store: &mut OrganizationStore,
    shared: &OrganizationShared,
    team_id: TeamId,
    team_name: String,
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
        shared,
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
    materialize_team(store, shared, materialization, observer, cancellation, call).await
}

pub(super) async fn prepare_manual_team_run(
    store: &mut OrganizationStore,
    shared: &OrganizationShared,
    input: ManualTeamMaterializationInput,
    call: &crate::call::CallReply<ManualTeamCreateOutcome>,
) -> Result<(TeamId, organization::GraphRunFacts, String), ManualTeamCreateOutcome> {
    let ManualTeamMaterializationInput {
        team_id,
        team_name,
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
            return Err(ManualTeamCreateOutcome::Rejected);
        }
    };
    let observer = call.provision_observer();
    let materialization = match super::member_introduction::prepare_manual_team(
        materialization,
        store.facts(),
        shared,
        None,
        call.cancellation(),
    )
    .await
    {
        Ok(materialization) => materialization,
        Err(super::member_introduction::PreparationError::Rejected(failure)) => {
            call.creation_failure(failure).await;
            return Err(ManualTeamCreateOutcome::Rejected);
        }
        Err(super::member_introduction::PreparationError::Unavailable(failure)) => {
            call.creation_failure(failure).await;
            return Err(ManualTeamCreateOutcome::Unavailable);
        }
    };
    let team_id = materialization.definition().team_id().clone();
    match materialize_team(store, shared, materialization, observer, call.cancellation(), Some(call)).await {
        TeamMaterializationCommandOutcome::Materialized { .. } => Ok((team_id, run, run_idempotency_key)),
        TeamMaterializationCommandOutcome::Rejected => Err(ManualTeamCreateOutcome::Rejected),
        TeamMaterializationCommandOutcome::OutcomeUnknown => Err(ManualTeamCreateOutcome::OutcomeUnknown),
        TeamMaterializationCommandOutcome::Unavailable => Err(ManualTeamCreateOutcome::Unavailable),
    }
}

pub(super) async fn prepare_run(
    store: &mut OrganizationStore,
    team_run: &TeamRunOwner,
    team_id: TeamId,
    run: organization::GraphRunFacts,
    run_idempotency_key: String,
    call: &crate::call::CallReply<ManualTeamCreateOutcome>,
) -> Result<(CreateGraphRunOutcome, crate::RunRuntimeReceipt), ManualTeamCreateOutcome> {
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
        Err(_) => return Err(ManualTeamCreateOutcome::Unavailable),
    };
    if matches!(created, CreateGraphRunOutcome::ConflictingIdempotency) {
        call.creation_failure(TeamCreationFailure::new(
            TeamCreationStage::InitializingSessions, TeamCreationFailureReason::StoreConflict,
        )).await;
        return Err(ManualTeamCreateOutcome::Unavailable);
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
            return Err(manual_runtime_receipt_outcome(outcome));
        }
    };
    Ok((created, receipt))
}

pub(super) async fn settle_run(
    store: &mut OrganizationStore,
    created: CreateGraphRunOutcome,
    receipt: crate::RunRuntimeReceipt,
    outcome: RuntimeReceiptOutcome,
    creation_failure: Option<TeamCreationFailure>,
    call: &crate::call::CallReply<ManualTeamCreateOutcome>,
) -> ManualTeamCreateOutcome {
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
            committed.map_or(ManualTeamCreateOutcome::OutcomeUnknown, |_| {
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

