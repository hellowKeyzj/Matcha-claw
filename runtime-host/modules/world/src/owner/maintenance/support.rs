use std::sync::Arc;

use serde::{Deserialize, Serialize};
use world_protocol::{
    api::WorldStatus,
    budget::Budget,
    failure::FailureStage,
    ids::*,
    operation::OperationPhase,
    time::{DurationMs, Timestamp},
};

use crate::{
    authorization::{self, AdmissionCommit, AuthError},
    definitions::canonical_digest,
    extensions::invocation::CallBudget,
    facts::support,
    owner::{RunSpec, ledger, resources::Resources, run},
    store::{CommitRequest, TransactionError, WorldStore},
};
use super::{Error, MaintenanceCheckpoint, MaintenanceResult, WorldHandle, maintenance_retained};

pub(super) struct Attempt {
    request_id: RequestId,
    run_id: RunId,
    watches: bool,
    budget: Budget,
    request: CommitRequest,
    not_committed: bool,
    cancellation: tokio_util::sync::CancellationToken,
}

#[derive(Serialize, Deserialize)]
struct Completed {
    input: ledger::MaintenanceInput,
    run: run::RunRecord,
}

enum SelectionError {
    Empty,
    Owner(Error),
}
impl From<crate::store::StoreError> for SelectionError {
    fn from(error: crate::store::StoreError) -> Self { Self::Owner(error.into()) }
}
impl From<AuthError> for SelectionError {
    fn from(error: AuthError) -> Self { Self::Owner(error.into()) }
}
impl From<Error> for SelectionError {
    fn from(error: Error) -> Self { Self::Owner(error) }
}

pub(super) async fn maintain(
    owner: &WorldHandle, store: &WorldStore, resources: &Arc<Resources>, world: &WorldRef,
    slot: &mut Option<Attempt>, watches: bool,
) {
    if slot.is_none() {
        match new(owner, store, resources, world, watches).await {
            Ok(attempt) => *slot = attempt,
            Err(error) => { super::diagnostic(&owner.shared, error); return; }
        }
    }
    let Some(attempt) = slot.as_mut() else { return; };
    match execute(owner, store, resources, world, attempt).await {
        Ok(()) => *slot = None,
        Err(error) => {
            let release = attempt.not_committed;
            super::diagnostic(&owner.shared, error);
            if release { *slot = None; }
        }
    }
}

async fn new(
    owner: &WorldHandle, store: &WorldStore, resources: &Arc<Resources>, world: &WorldRef, watches: bool,
) -> Result<Option<Attempt>, Error> {
    if owner.shared.cancellation.is_cancelled() { return Ok(None); }
    resources.live.require_world_open(world)?;
    let now = store.snapshot(world.clone(), |snapshot| Box::pin(async move { snapshot.now().await })).await?;
    let wall = resources.preparation.execution_policy().host_io_timeout
        .checked_add(resources.preparation.execution_policy().cleanup_timeout).ok_or_else(maintenance_retained)?;
    let deadline = chrono::DateTime::parse_from_rfc3339(now.as_str())
        .map_err(|cause| Error::internal(FailureStage::Prepare).caused(cause))?
        .checked_add_signed(chrono::Duration::from_std(wall)
            .map_err(|cause| Error::internal(FailureStage::Prepare).caused(cause))?).ok_or_else(maintenance_retained)?;
    let mut budget = crate::owner::queries::objects::query_budget(Timestamp::try_new(deadline.to_rfc3339())
        .map_err(|cause| Error::internal(FailureStage::Prepare).caused(cause))?);
    budget.max_wall_time = DurationMs(u64::try_from(wall.as_millis()).map_err(|_| maintenance_retained())?);
    let request_id = RequestId::try_new(format!("maintenance-{}", uuid::Uuid::new_v4())).expect("UUID identifier");
    let run_id = RunId::try_new(format!("maintenance-run-{}", uuid::Uuid::new_v4())).expect("UUID identifier");
    let request = crate::owner::execution::prepare_request(store, world,
        CommitId::try_new(format!("maintenance-admit-{request_id}")).expect("bounded maintenance identifier"),
        canonical_digest(&(world, &request_id, &run_id, watches, &budget))?, &["operation", "authorization", "facts"]).await?;
    Ok(Some(Attempt { request_id, run_id, watches, budget, request, not_committed: false,
        cancellation: owner.shared.cancellation.child_token() }))
}

async fn execute(
    owner: &WorldHandle, store: &WorldStore, resources: &Arc<Resources>, world: &WorldRef, attempt: &mut Attempt,
) -> Result<(), Error> {
    let authority = resources.authorities.maintenance.get().cloned().ok_or_else(maintenance_retained)?;
    if authority.world() != world || !authority.same_root(&owner.shared.authority) {
        return Err(world_protocol::authorization::AuthorizationFailure::InvalidPrincipal.into());
    }
    resources.live.require_world_open(world)?;
    let request_id = attempt.request_id.clone();
    let run_id = attempt.run_id.clone();
    let watches = attempt.watches;
    let budget = attempt.budget.clone();
    let cancel = attempt.cancellation.clone();
    attempt.not_committed = false;
    let outcome = authorization::commit_admission(store, attempt.request.clone().prepare()?, move |tx| Box::pin(async move {
        let now = tx.now().await?;
        let call = CallBudget::new(budget.clone(), &now).map_err(|failure| Error::from_host_failure(
            world_protocol::process::HostFailure::BudgetExceeded { dimension: failure.dimension }, FailureStage::Admission))?;
        let basis = if watches {
            let batch = support::select_due(tx, &call, &cancel, &now, 32).await?.ok_or(SelectionError::Empty)?;
            ledger::MaintenanceBasis::SupportWatches { batch }
        } else {
            let claim = support::claim(tx, "world.maintenance", request_id.as_str(), &run_id,
                DurationMs(budget.max_wall_time.0.min(300_000)), &now).await?.ok_or(SelectionError::Empty)?;
            ledger::MaintenanceBasis::Support { claim }
        };
        let verification = authority.verify(tx, budget.deadline.as_ref().ok_or_else(maintenance_retained)?, &now).await?;
        let (impact, recompute_plan) = match &basis {
            ledger::MaintenanceBasis::Support { claim } => {
                let (impact, plan) = support::recompute_impact(tx, claim, verification.verified(), &call, &cancel).await?;
                (impact, Some(plan))
            }
            ledger::MaintenanceBasis::SupportWatches { batch } => (support::due_impact(tx, batch, &call, &cancel).await?, None),
            _ => return Err(maintenance_retained().into()),
        };
        let now = tx.now().await?;
        let admission = authority.admit_verified(tx, verification, &impact, &now).await?;
        let head = super::head::read(tx).await?;
        if head.status != WorldStatus::Ready { return Err(maintenance_retained().into()); }
        let input = ledger::MaintenanceInput { world: tx.world().clone(), request_id, basis };
        let operation_input = ledger::OperationInput::Maintenance(input.clone());
        let operation = ledger::accept(tx, &admission, &operation_input,
            super::super::requests::operation_id(tx.world(), &input.request_id, operation_input.operation_name()), head.generation, &now).await?;
        let run = run::start(tx, &admission, &operation.receipt.accepted, RunSpec {
            id: run_id, activation_lock_id: None, release_id: None, branch_id: None,
            basis: serde_json::to_value(&input.basis).map_err(|cause| Error::internal(FailureStage::Prepare).caused(cause))?, budget,
        }, &now).await?;
        let step = run::claim_step(tx, &admission, &run, super::maintenance_step(&run.id), 0,
            super::maintenance_name(&input.basis), super::maintenance_digest(&input.basis)?, &now).await?;
        let mut next = step.clone();
        next.checkpoint = serde_json::to_value(MaintenanceCheckpoint { basis: input.basis.clone(), content_cleanup: None, package_cleanup: None, admission: None })
            .map_err(|cause| Error::internal(FailureStage::Prepare).caused(cause))?;
        let step = run::checkpoint_step(tx, &step, next).await?;
        let result = match &input.basis {
            ledger::MaintenanceBasis::Support { claim } => {
                if claim.run_id() != &run.id || claim.work.branch_id.is_some() { return Err(maintenance_retained().into()); }
                let expected = recompute_plan.as_ref().ok_or_else(maintenance_retained)?;
                MaintenanceResult::Support { changed: support::complete(tx, claim, &admission, expected, &call, &cancel, &now).await? }
            }
            ledger::MaintenanceBasis::SupportWatches { batch } => MaintenanceResult::SupportWatches {
                changed: support::expire_due(tx, batch, &admission, &call, &cancel, &now).await?,
            },
            _ => return Err(maintenance_retained().into()),
        };
        let mut next = step.clone();
        next.phase = OperationPhase::Completed;
        next.result = Some(serde_json::to_value(result).map_err(|cause| Error::internal(FailureStage::Commit).caused(cause))?);
        run::checkpoint_step(tx, &step, next).await?;
        run::checkpoint_usage(tx, &run, run::confirmed_usage(&run.usage, call.checkpoint_usage())?).await?;
        let now = tx.now().await?;
        authorization::check_admitted_output(tx, &admission, admission.impact(), 1, &now).await?;
        ledger::complete_maintenance(tx, &run.operation, &now).await?;
        Ok::<_, SelectionError>((Completed { input, run }, admission))
    })).await;
    attempt.not_committed = matches!(&outcome, Err(TransactionError::NotCommitted { .. }));
    match outcome {
        Ok(AdmissionCommit::Committed { .. } | AdmissionCommit::Replayed(_))
            | Err(TransactionError::NotCommitted { error: SelectionError::Empty, cleanup: None }) => Ok(()),
        Err(TransactionError::NotCommitted { error: SelectionError::Empty, cleanup: Some(error) }) => Err(error.into()),
        Err(TransactionError::NotCommitted { error: SelectionError::Owner(error), cleanup }) =>
            Err(match cleanup { Some(cleanup) => error.with_cleanup(cleanup), None => error }),
        Err(TransactionError::Indeterminate(error)) => Err(error.into()),
    }
}
