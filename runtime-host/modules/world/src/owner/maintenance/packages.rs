use std::sync::Arc;

use world_protocol::{api::ApiFailure, failure::FailureStage, ids::*, operation::{CancellationState, OperationFailure, OperationPhase}, time::Timestamp};

use crate::{
    authorization::{self, AdmissionCommit},
    definitions::canonical_digest,
    extensions::{invocation::CallBudget, package::{self, PackageCleanupObservation}},
    owner::{ExecutionContext, ledger, resources::Resources, run},
    store::WorldStore,
};
use super::{Error, MaintenanceAccepted, MaintenanceAttempt, RetirementWork, WorldHandle, maintenance_retained};

pub(super) async fn recover(
    owner: &WorldHandle, store: &WorldStore, resources: &Arc<Resources>, world: &WorldRef,
) -> Result<Option<MaintenanceAttempt>, Error> {
    let inventory = crate::owner::recovery::load(store, world.clone()).await?;
    for step in inventory.unsettled_steps.iter().filter(|step| step.kind == "maintenance.package_cleanup") {
        let checkpoint = super::validate_checkpoint(step)?;
        let run = inventory.runs.iter().find(|run| run.id == step.run_id).ok_or_else(maintenance_retained)?.clone();
        if resources.tasks.contains_run(world, &run.id) { return Err(maintenance_retained()); }
        let id = run.operation.operation_id.clone();
        let record = store.snapshot(world.clone(), move |snapshot| Box::pin(async move { ledger::read_record_snapshot(snapshot, &id).await })).await?;
        let ledger::OperationInput::Maintenance(input) = record.input else { return Err(maintenance_retained()); };
        if record.receipt.progress.run_id.as_ref() != Some(&run.id)
            || super::maintenance_run(&input) != run.id
            || canonical_digest(&input.basis)? != canonical_digest(&checkpoint.basis)? {
            return Err(maintenance_retained());
        }
        let request = checkpoint.admission.as_ref().ok_or_else(maintenance_retained)?.clone();
        let admitted = store.read_commit::<MaintenanceAccepted>(world, &request.commit_id, &request.input_digest).await?;
        let mut original = checkpoint.clone();
        original.package_cleanup = None;
        if request.commit_id.as_str() != format!("maintenance-admit-{}", input.request_id)
            || !request.fences.contains(&admitted.receipt.fence)
            || admitted.value.run.id != run.id
            || admitted.value.run.operation.operation_id != run.operation.operation_id
            || canonical_digest(&admitted.value.run.budget)? != canonical_digest(&run.budget)?
            || admitted.value.step.id != step.id
            || canonical_digest(&admitted.value.step.checkpoint)? != canonical_digest(&original)? {
            return Err(maintenance_retained());
        }
        let mut run = run;
        run.operation = record.receipt.accepted;
        return Ok(Some(MaintenanceAttempt { input, budget: run.budget.clone(), request, execution: Arc::default(),
            accepted: Some(MaintenanceAccepted { run, step: step.clone() }), not_committed: false, checkpoint,
            cancellation: owner.shared.cancellation.child_token(),
            retirement: Arc::new(tokio::sync::Mutex::new(RetirementWork { candidates: Vec::new(), previous: Default::default() })),
            completion: None, failure: None, recovery_admission: None }));
    }
    Ok(None)
}

pub(super) async fn admit_recovery(
    owner: &WorldHandle, store: &WorldStore, resources: &Arc<Resources>, attempt: &mut MaintenanceAttempt,
) -> Result<(), Error> {
    if attempt.execution.lock().expect("maintenance execution handoff poisoned").is_some() { return Ok(()); }
    let authority = resources.authorities.maintenance.get().cloned().ok_or_else(maintenance_retained)?;
    if authority.world() != &attempt.input.world || !authority.same_root(&owner.shared.authority) { return Err(maintenance_retained()); }
    let accepted = attempt.accepted.as_ref().ok_or_else(maintenance_retained)?;
    let input = attempt.input.clone();
    let run_id = accepted.run.id.clone();
    if attempt.recovery_admission.is_none() {
        attempt.recovery_admission = Some(crate::owner::execution::prepare_request(store, &input.world,
            CommitId::try_new(format!("maintenance-recover-{}", uuid::Uuid::new_v4())).expect("UUID identifier"),
            canonical_digest(&(&input, &run_id))?, &["operation", "authorization", "packages"]).await?);
    }
    let handoff = attempt.execution.clone();
    let timeout = resources.preparation.execution_policy().cleanup_timeout;
    let admitted = authorization::commit_admission(store, attempt.recovery_admission.as_ref().ok_or_else(maintenance_retained)?.clone().prepare()?, move |tx| Box::pin(async move {
        let now = tx.now().await?;
        let run = run::read_run(tx, &run_id).await?;
        let record = ledger::read(tx, &run.operation.operation_id).await?;
        if canonical_digest(&record.input)? != canonical_digest(&ledger::OperationInput::Maintenance(input.clone()))?
            || record.receipt.progress.run_id.as_ref() != Some(&run.id) { return Err(maintenance_retained()); }
        let ledger::MaintenanceBasis::PackageCleanup { batch } = &input.basis else { return Err(maintenance_retained()); };
        let resumed = CallBudget::resume(run.budget.clone(), run.usage.clone(), &now);
        let (call, deadline, stopped) = match resumed {
            Ok(call) => (call, run.budget.deadline.clone().ok_or_else(maintenance_retained)?, None),
            Err(failure) => {
                let stopped = Error::from_host_failure(
                    world_protocol::process::HostFailure::BudgetExceeded { dimension: failure.dimension }, FailureStage::Recover);
                let deadline = cleanup_deadline(&now, timeout)?;
                let call = CallBudget::new(crate::owner::queries::objects::query_budget(deadline.clone()), &now).map_err(|_| maintenance_retained())?;
                (call, deadline, Some(stopped))
            }
        };
        let admission = authority.admit(tx, &package::cleanup_impact(tx, batch).await?, &deadline, &now).await?;
        record.identity.require_resume(admission.verified())?;
        *handoff.lock().expect("maintenance execution handoff poisoned") = Some((admission.clone(), call, stopped));
        Ok::<_, Error>(((), admission))
    })).await?;
    if matches!(admitted, AdmissionCommit::Replayed(_)) && attempt.execution.lock().expect("maintenance execution handoff poisoned").is_none() {
        return Err(maintenance_retained());
    }
    Ok(())
}

pub(super) async fn settle_stopped(ctx: &ExecutionContext, attempt: &mut MaintenanceAttempt) -> Result<bool, Error> {
    let ledger::MaintenanceBasis::PackageCleanup { batch } = &attempt.input.basis else { return Err(maintenance_retained()); };
    let batch = batch.clone();
    ctx.resources.inventory.finish_cleanup(ctx, &batch).await?;
    let run_id = ctx.run.id.clone();
    let (step, observed) = ctx.store.snapshot(ctx.operation.world.clone(), move |snapshot| Box::pin(async move {
        let row = snapshot.query_opt("SELECT body FROM world_step WHERE tenant_id=$1 AND world_id=$2 AND run_id=$3 AND ordinal=0 AND kind='maintenance.package_cleanup'",
            &[&snapshot.world().tenant_id.as_str(), &snapshot.world().world_id.as_str(), &run_id.as_str()]).await?.ok_or_else(maintenance_retained)?;
        let step: run::StepRecord = serde_json::from_value(row.get("body")).map_err(|cause| Error::internal(FailureStage::Recover).caused(cause))?;
        let checkpoint = super::validate_checkpoint(&step)?;
        let cleanup = checkpoint.package_cleanup.unwrap_or_default();
        let observed = package::observe_cleanup(snapshot, &batch, &cleanup).await?;
        Ok::<_, Error>((step, observed))
    })).await?;
    let failure = match observed {
        PackageCleanupObservation::Pending => return Err(maintenance_retained()),
        PackageCleanupObservation::Completed => None,
        PackageCleanupObservation::Failed(reason) => Some(Error::new("world.package.cleanup_failed", FailureStage::Drain,
            "插件包清理失败，原结果已确认。", ApiFailure::Operation(OperationFailure::Package(reason)), world_protocol::failure::Recovery::ManualReview)),
        PackageCleanupObservation::Incomplete => Some(attempt.failure.clone().unwrap_or_else(|| Error::from_host_failure(
            if ctx.cancellation.is_cancelled() { world_protocol::process::HostFailure::Cancelled }
            else { world_protocol::process::HostFailure::BudgetExceeded { dimension: world_protocol::budget::BudgetDimension::WallTime } }, FailureStage::Drain))),
    };
    if attempt.completion.is_none() {
        attempt.failure = failure;
        super::prepare_completion(ctx, attempt).await?;
    }
    let completion = attempt.completion.as_ref().ok_or_else(maintenance_retained)?;
    let request = completion.request.clone();
    let result = completion.result.clone();
    let usage = if attempt.recovery_admission.is_some() { ctx.run.usage.clone() } else { completion.usage.clone() };
    let failure = attempt.failure.clone();
    let authority = ctx.resources.authorities.maintenance.get().cloned().ok_or_else(maintenance_retained)?;
    if authority.world() != &ctx.operation.world || !authority.same_root(&ctx.authority) { return Err(maintenance_retained()); }
    let timeout = ctx.resources.preparation.execution_policy().cleanup_timeout;
    let input = attempt.input.clone();
    let id = ctx.operation.operation_id.clone();
    let run_id = ctx.run.id.clone();
    ctx.store.transact(request.prepare()?, move |tx| Box::pin(async move {
        let now = tx.now().await?;
        let ledger::MaintenanceBasis::PackageCleanup { batch } = &input.basis else { return Err(maintenance_retained()); };
        let admission = authority.admit(tx, &package::cleanup_impact(tx, batch).await?, &cleanup_deadline(&now, timeout)?, &now).await?;
        let operation = ledger::read(tx, &id).await?;
        operation.identity.require_resume(admission.verified())?;
        let run = run::read_run(tx, &run_id).await?;
        if run.operation.operation_id != id || operation.receipt.accepted.incarnation != run.operation.incarnation
            || ledger::terminal(operation.receipt.phase) || ledger::terminal(run.phase)
            || operation.receipt.progress.run_id.as_ref() != Some(&run.id) || canonical_digest(&operation.input)? != canonical_digest(&ledger::OperationInput::Maintenance(input))? {
            return Err(maintenance_retained());
        }
        let current = run::read_step(tx, &run.id, &step.id).await?.ok_or_else(maintenance_retained)?;
        if current.revision != step.revision { return Err(maintenance_retained()); }
        let mut next = current.clone();
        next.phase = if failure.is_some() { OperationPhase::Failed } else { OperationPhase::Completed };
        next.result = Some(result);
        next.failure = failure.as_ref().and_then(Error::operation_failure);
        run::checkpoint_step(tx, &current, next).await?;
        run::checkpoint_usage(tx, &run, run::confirmed_usage(&run.usage, usage)?).await?;
        authorization::check_admitted_output(tx, &admission, admission.impact(), 1, &now).await?;
        if let Some(failure) = failure {
            ledger::fail(tx, &operation.receipt.accepted, failure.operation_failure().ok_or(failure)?,
                operation.receipt.cancellation != CancellationState::NotRequested, &now).await?;
        } else { ledger::complete_maintenance(tx, &operation.receipt.accepted, &now).await?; }
        Ok::<_, Error>(())
    })).await.map_err(Error::from)?;
    Ok(true)
}

fn cleanup_deadline(now: &Timestamp, timeout: std::time::Duration) -> Result<Timestamp, Error> {
    let deadline = chrono::DateTime::parse_from_rfc3339(now.as_str()).map_err(|cause| Error::internal(FailureStage::Drain).caused(cause))?
        .checked_add_signed(chrono::Duration::from_std(timeout).map_err(|cause| Error::internal(FailureStage::Drain).caused(cause))?).ok_or_else(maintenance_retained)?;
    Timestamp::try_new(deadline.to_rfc3339()).map_err(|cause| Error::internal(FailureStage::Drain).caused(cause))
}
