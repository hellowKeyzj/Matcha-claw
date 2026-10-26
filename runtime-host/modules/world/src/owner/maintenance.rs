#[path = "maintenance/support.rs"]
mod support;
#[path = "maintenance/packages.rs"]
mod packages;

use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tokio::time::Instant;
use world_protocol::{
    api::{ApiFailure, CommandEnvelope, WorldCommand, WorldStatus},
    failure::{FailureStage, Recovery},
    ids::*,
    operation::{OperationPhase, OperationResult},
    time::{DurationMs, Timestamp},
};

use crate::{
    authorization::{self, AdmissionCommit},
    definitions::canonical_digest,
    extensions::invocation::CallBudget,
    owner::{ExecutionContext, RunRecord, RunSpec, StepRecord, head, ledger, queries, run, workflows},
    sources::sync::{self, SourceParent, SourceSegment},
    store::WorldStore,
};
use super::{Error, Shared, WorldHandle, ready_for, resources};

#[derive(Default)]
pub(crate) struct State {
    retirement: Option<MaintenanceAttempt>,
    cleanup: Option<MaintenanceAttempt>,
    packages: Option<MaintenanceAttempt>,
    support: Option<support::Attempt>,
    watches: Option<support::Attempt>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MaintenanceCheckpoint {
    basis: ledger::MaintenanceBasis,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    content_cleanup: Option<crate::content::CleanupCheckpoint>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    package_cleanup: Option<crate::extensions::package::PackageCleanupCheckpoint>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    admission: Option<crate::store::CommitRequest>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MaintenanceAccepted {
    run: RunRecord,
    step: StepRecord,
}

struct MaintenanceAttempt {
    input: ledger::MaintenanceInput,
    budget: world_protocol::budget::Budget,
    request: crate::store::CommitRequest,
    execution: Arc<Mutex<Option<(crate::authorization::Admission, CallBudget, Option<Error>)>>>,
    accepted: Option<MaintenanceAccepted>,
    not_committed: bool,
    checkpoint: MaintenanceCheckpoint,
    cancellation: tokio_util::sync::CancellationToken,
    retirement: Arc<tokio::sync::Mutex<RetirementWork>>,
    completion: Option<MaintenanceCompletion>,
    failure: Option<Error>,
    recovery_admission: Option<crate::store::CommitRequest>,
}

#[derive(Clone, Copy, PartialEq)]
enum MaintenanceKind { Retirement, Content, Packages }

struct RetirementWork {
    candidates: Vec<crate::extensions::bindings::RetirementCandidate>,
    previous: workflows::activation::MaintenanceResult,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum MaintenanceResult {
    Retirement { released: Vec<ActivationLockId>, retained: Vec<ActivationLockId> },
    ContentCleanup,
    PackageCleanup,
    Support { changed: Vec<AssertionRef> },
    SupportWatches { changed: Vec<AssertionRef> },
}

#[derive(Serialize, Deserialize)]
struct Accepted {
    input: SourceSegment,
    run: RunRecord,
    step: StepRecord,
    now: Timestamp,
}

struct Prepared {
    ctx: ExecutionContext,
    input: SourceSegment,
    step: StepRecord,
    work_deadline: Instant,
}

#[derive(Clone)]
pub(super) struct PendingSegment {
    input: SourceSegment,
    execution: Arc<std::sync::Mutex<Option<(crate::authorization::Admission, CallBudget, Instant)>>>,
}

struct MaintenanceCompletion {
    request: crate::store::CommitRequest,
    result: serde_json::Value,
    usage: world_protocol::budget::Usage,
}

pub(super) async fn step_retention_roots(tx: &crate::store::WorldTransaction<'_>, step: &StepRecord, roots: &mut crate::store::RetentionRoots) -> Result<(), Error> {
    let checkpoint = validate_checkpoint(step)?;
    let retained = match &checkpoint.basis {
        ledger::MaintenanceBasis::Support { claim } => crate::facts::support::recompute_retention(tx, claim).await?,
        ledger::MaintenanceBasis::SupportWatches { batch } => crate::facts::support::due_retention(tx, batch).await?,
        ledger::MaintenanceBasis::PackageCleanup { batch } => { batch.retention_roots(roots)?; return Ok(()); }
        _ => return Ok(()),
    };
    roots.scopes.extend(retained.scopes);
    roots.resources.extend(retained.resources);
    roots.definitions.extend(retained.definitions);
    roots.evidence.extend(retained.evidence);
    roots.dependencies.extend(retained.dependencies);
    roots.sources.extend(retained.sources);
    roots.releases.extend(retained.releases);
    roots.branches.extend(retained.branches);
    roots.source_versions.extend(retained.source_versions);
    roots.parse_artifacts.extend(retained.parse_artifacts);
    roots.schemas.extend(retained.schemas);
    roots.mappings.extend(retained.mappings);
    Ok(())
}

fn validate_checkpoint(step: &StepRecord) -> Result<MaintenanceCheckpoint, Error> {
    let checkpoint: MaintenanceCheckpoint = serde_json::from_value(step.checkpoint.clone())
        .map_err(|cause| Error::internal(FailureStage::Recover).caused(cause))?;
    let kind = maintenance_name(&checkpoint.basis);
    if step.kind != kind || step.ordinal != 0 || step.id != maintenance_step(&step.run_id)
        || step.input_digest != maintenance_digest(&checkpoint.basis)?
        || (kind != "maintenance.content_cleanup" && checkpoint.content_cleanup.is_some())
        || (kind != "maintenance.package_cleanup" && checkpoint.package_cleanup.is_some()) {
        return Err(maintenance_retained());
    }
    if let (ledger::MaintenanceBasis::ContentCleanup { batch }, Some(cleanup)) = (&checkpoint.basis, &checkpoint.content_cleanup) {
        cleanup.validate(batch)?;
    }
    if let ledger::MaintenanceBasis::PackageCleanup { batch } = &checkpoint.basis {
        if let Some(cleanup) = &checkpoint.package_cleanup { cleanup.validate(batch)?; }
        let request = checkpoint.admission.as_ref().ok_or_else(maintenance_retained)?;
        request.clone().prepare()?;
        if request.world != *batch.world()
            || !["operation", "authorization", "packages"].iter().all(|domain| request.fences.iter().any(|fence| fence.domain.as_str() == *domain)) {
            return Err(maintenance_retained());
        }
    }
    if let Some(result) = &step.result {
        let result: MaintenanceResult = serde_json::from_value(result.clone())
            .map_err(|cause| Error::internal(FailureStage::Recover).caused(cause))?;
        if !matches!((&checkpoint.basis, result),
            (ledger::MaintenanceBasis::Retirement { .. }, MaintenanceResult::Retirement { .. })
            | (ledger::MaintenanceBasis::ContentCleanup { .. }, MaintenanceResult::ContentCleanup)
            | (ledger::MaintenanceBasis::PackageCleanup { .. }, MaintenanceResult::PackageCleanup)
            | (ledger::MaintenanceBasis::Support { .. }, MaintenanceResult::Support { .. })
            | (ledger::MaintenanceBasis::SupportWatches { .. }, MaintenanceResult::SupportWatches { .. })) {
            return Err(maintenance_retained());
        }
    }
    Ok(checkpoint)
}

pub(super) fn schedule(
    owner: WorldHandle, store: WorldStore, resources: Arc<crate::owner::resources::Resources>, world: WorldRef,
) -> Result<(), Error> {
    if owner.shared.closing.load(std::sync::atomic::Ordering::Acquire) { return Err(super::closed()); }
    if resources.authorities.maintenance.get().is_none() { return Ok(()); }
    let Ok(state) = resources.maintenance.clone().try_lock_owned() else { return Ok(()); };
    let tasks = resources.tasks.clone();
    drop(tasks.spawn(maintain_state(owner, store, resources, world, state)));
    Ok(())
}

pub(super) async fn tick(owner: WorldHandle, store: WorldStore, resources: Arc<crate::owner::resources::Resources>, world: WorldRef) {
    if owner.shared.closing.load(std::sync::atomic::Ordering::Acquire)
        || resources.authorities.maintenance.get().is_none() { return; }
    let Ok(state) = resources.maintenance.clone().try_lock_owned() else { return; };
    maintain_state(owner, store, resources, world, state).await;
}

async fn maintain_state(owner: WorldHandle, store: WorldStore, resources: Arc<crate::owner::resources::Resources>, world: WorldRef,
    mut state: tokio::sync::OwnedMutexGuard<State>,
) {
        support::maintain(&owner, &store, &resources, &world, &mut state.watches, true).await;
        support::maintain(&owner, &store, &resources, &world, &mut state.support, false).await;
        for kind in [MaintenanceKind::Retirement, MaintenanceKind::Content, MaintenanceKind::Packages] {
            let slot = match kind {
                MaintenanceKind::Retirement => &mut state.retirement,
                MaintenanceKind::Content => &mut state.cleanup,
                MaintenanceKind::Packages => &mut state.packages,
            };
            if slot.is_none() {
                match maintenance_attempt(&owner, &store, &resources, &world, kind).await {
                    Ok(attempt) => *slot = attempt,
                    Err(error) => { diagnostic(&owner.shared, error); continue; }
                }
            }
            let Some(attempt) = slot.as_mut() else { continue; };
            match maintain_attempt(&owner, &store, &resources, attempt).await {
                Ok(true) => *slot = None,
                Ok(false) => {},
                Err(error) => {
                    let release = attempt.not_committed && attempt.accepted.is_none();
                    diagnostic(&owner.shared, error);
                    if release { *slot = None; }
                }
            }
        }
}

async fn maintenance_attempt(
    owner: &WorldHandle, store: &WorldStore, resources: &Arc<crate::owner::resources::Resources>, world: &WorldRef,
    kind: MaintenanceKind,
) -> Result<Option<MaintenanceAttempt>, Error> {
    if owner.shared.cancellation.is_cancelled() { return Ok(None); }
    resources.live.require_world_open(world)?;
    if kind == MaintenanceKind::Packages {
        if let Some(attempt) = packages::recover(owner, store, resources, world).await? { return Ok(Some(attempt)); }
    }
    let now = store.snapshot(world.clone(), |snapshot| Box::pin(async move { snapshot.now().await })).await?;
    let wall = resources.preparation.execution_policy().host_io_timeout
        .checked_add(resources.preparation.execution_policy().cleanup_timeout).ok_or_else(maintenance_retained)?;
    let deadline = chrono::DateTime::parse_from_rfc3339(now.as_str())
        .map_err(|cause| Error::internal(FailureStage::Prepare).caused(cause))?
        .checked_add_signed(chrono::Duration::from_std(wall)
            .map_err(|cause| Error::internal(FailureStage::Prepare).caused(cause))?).ok_or_else(maintenance_retained)?;
    let mut budget = queries::objects::query_budget(Timestamp::try_new(deadline.to_rfc3339())
        .map_err(|cause| Error::internal(FailureStage::Prepare).caused(cause))?);
    budget.max_wall_time = DurationMs(u64::try_from(wall.as_millis())
        .map_err(|cause| Error::internal(FailureStage::Prepare).caused(cause))?);
    let mut candidates = Vec::new();
    let mut cleanup_checkpoint = None;
    let basis = if kind == MaintenanceKind::Retirement {
        let proofs = owner.shared.startup_reports.lock().expect("world startup reports poisoned").get(world)
            .map(|report| report.retiring.iter().map(|proof| proof.lock().clone())
                .chain(report.drained_retirements.iter().map(|proof| proof.lock().clone()))
                .take(32).collect::<std::collections::BTreeSet<_>>()).unwrap_or_default();
        let maximum = u32::try_from(budget.max_rows.min(32)).map_err(|_| maintenance_retained())?;
        let (selected, mut identities) = store.snapshot(world.clone(), move |snapshot| Box::pin(async move {
            let selected = crate::extensions::bindings::retirement_candidates_snapshot(snapshot, maximum).await?;
            let mut identities = Vec::new();
            for id in proofs {
                let graph = crate::extensions::bindings::read_graph(snapshot, &id).await?;
                identities.push(ledger::RetirementIdentity { id, revision: Revision(0), digest: graph.lock().digest.clone() });
            }
            Ok::<_, Error>((selected, identities))
        })).await?;
        for identity in &mut identities {
            identity.revision = resources.bindings.retirement_revision(world, &identity.id)?;
        }
        for candidate in selected {
            if identities.len() >= 32 { break; }
            if !identities.iter().any(|identity| identity.id == candidate.graph.lock().id) {
                identities.push(ledger::RetirementIdentity { id: candidate.graph.lock().id.clone(),
                    revision: candidate.revision, digest: candidate.graph.lock().digest.clone() });
                candidates.push(candidate);
            }
        }
        if identities.is_empty() { return Ok(None); }
        ledger::MaintenanceBasis::Retirement { candidates: identities }
    } else if kind == MaintenanceKind::Packages {
        let batch = store.snapshot(world.clone(), |snapshot| Box::pin(async move {
            crate::extensions::package::cleanup_candidates(snapshot, 32).await
        })).await?;
        if batch.is_empty() { return Ok(None); }
        ledger::MaintenanceBasis::PackageCleanup { batch }
    } else {
        let inventory = crate::owner::recovery::load(store, world.clone()).await?;
        let mut recovered = None;
        for step in inventory.unsettled_steps.iter().filter(|step| step.kind == "maintenance.content_cleanup") {
            validate_checkpoint(step)?;
            let checkpoint: MaintenanceCheckpoint = serde_json::from_value(step.checkpoint.clone())
                .map_err(|cause| Error::internal(FailureStage::Recover).caused(cause))?;
            let ledger::MaintenanceBasis::ContentCleanup { batch } = &checkpoint.basis else { return Err(maintenance_retained()); };
            let batch = batch.clone();
            if !store.snapshot(world.clone(), move |snapshot| Box::pin(async move {
                crate::content::cleanup_batch_finished(snapshot, &batch).await.map_err(Error::from)
            })).await? {
                recovered = Some(checkpoint);
                break;
            }
        }
        if let Some(checkpoint) = recovered {
            cleanup_checkpoint = checkpoint.content_cleanup;
            checkpoint.basis
        } else {
            let batch = store.snapshot(world.clone(), |snapshot| Box::pin(async move {
                crate::content::cleanup_candidates(snapshot, 32).await.map_err(Error::from)
            })).await?;
            if batch.is_empty() { return Ok(None); }
            ledger::MaintenanceBasis::ContentCleanup { batch }
        }
    };
    let mut checkpoint = MaintenanceCheckpoint { basis: basis.clone(), content_cleanup: cleanup_checkpoint, package_cleanup: None, admission: None };
    maintenance_digest(&basis)?;
    let input = ledger::MaintenanceInput { world: world.clone(),
        request_id: RequestId::try_new(format!("maintenance-{}", uuid::Uuid::new_v4())).expect("UUID identifier"), basis };
    let request = crate::owner::execution::prepare_request(store, world,
        CommitId::try_new(format!("maintenance-admit-{}", input.request_id)).expect("bounded maintenance identifier"),
        canonical_digest(&(&input, &budget, &checkpoint))?, &["authorization", "operation", "packages", "bindings", "content"]).await?;
    checkpoint.admission = Some(request.clone());
    Ok(Some(MaintenanceAttempt { input, budget, request, execution: Arc::default(), accepted: None, not_committed: false, checkpoint,
        cancellation: owner.shared.cancellation.child_token(),
        retirement: Arc::new(tokio::sync::Mutex::new(RetirementWork { candidates,
            previous: workflows::activation::MaintenanceResult::default() })), completion: None, failure: None, recovery_admission: None }))
}

async fn maintain_attempt(
    owner: &WorldHandle, store: &WorldStore, resources: &Arc<crate::owner::resources::Resources>,
    attempt: &mut MaintenanceAttempt,
) -> Result<bool, Error> {
    if attempt.accepted.is_none() { admit_maintenance(owner, store, resources, attempt).await?; }
    if matches!(&attempt.input.basis, ledger::MaintenanceBasis::PackageCleanup { .. }) {
        packages::admit_recovery(owner, store, resources, attempt).await?;
    }
    let accepted = attempt.accepted.as_ref().ok_or_else(maintenance_retained)?;
    let (admission, budget, stopped) = attempt.execution.lock().expect("maintenance execution handoff poisoned")
        .as_ref().cloned().ok_or_else(maintenance_retained)?;
    let cleanup_only = stopped.is_some();
    if attempt.failure.is_none() && attempt.completion.is_none() { attempt.failure = stopped; }
    let ctx = ExecutionContext {
        owner: owner.clone(), store: store.clone(), resources: resources.clone(), admission,
        authority: owner.shared.authority.clone(), operation: accepted.run.operation.clone(), run: accepted.run.clone(),
        cancellation: attempt.cancellation.clone(), deadline: budget.deadline(), budget,
        pipeline: foundation::pipeline::PipelineContext::silent_in_memory(accepted.run.id.as_str()),
        source_access: owner.shared.source_access.clone(),
        locator: owner.shared.locator.as_ref().map_err(Clone::clone)?.clone(), target: Arc::new(owner.clone()),
    };
    let key = (ctx.operation.world.clone(), ctx.operation.operation_id.clone());
    owner.shared.executing.lock().expect("world executions poisoned").insert(key.clone(), ctx.cancellation.clone());
    let result = async {
        if matches!(&attempt.input.basis, ledger::MaintenanceBasis::PackageCleanup { .. })
            && (cleanup_only || attempt.failure.is_some() || ctx.cancellation.is_cancelled() || ctx.budget.check().is_err()) {
            return packages::settle_stopped(&ctx, attempt).await;
        }
        if attempt.completion.is_some() {
        finish_maintenance(&ctx, attempt).await
    } else {
        let input = attempt.input.basis.clone();
        let retirement = attempt.retirement.clone();
        let worker = ctx.resources.tasks.spawn_run(&ctx, {
            let ctx = ctx.clone();
            async move {
                match input {
                    ledger::MaintenanceBasis::Retirement { .. } => {
                        let mut work = retirement.lock().await;
                        let candidates = std::mem::take(&mut work.candidates);
                        let previous = std::mem::take(&mut work.previous);
                        work.previous = workflows::activation::maintenance(&ctx.maintenance_context(), candidates, previous).await;
                        (true, Ok(()))
                    }
                    ledger::MaintenanceBasis::ContentCleanup { batch } => {
                        (false, ctx.resources.content.cleanup_batch(&ctx, batch).await)
                    }
                    ledger::MaintenanceBasis::PackageCleanup { batch } => {
                        (false, ctx.resources.inventory.cleanup_batch(&ctx, batch).await)
                    }
                    ledger::MaintenanceBasis::Support { .. } | ledger::MaintenanceBasis::SupportWatches { .. } => (false, Err(maintenance_retained())),
                }
            }
        });
        let (retirement, outcome) = match worker {
            Ok(worker) => worker.await.map_err(|cause| Error::internal(FailureStage::Execute).caused(cause))?,
            Err(error) => {
                owner.shared.executing.lock().expect("world executions poisoned").remove(&key);
                return Err(error);
            }
        };
        let result = if retirement {
            let (held, failure) = {
                let mut work = attempt.retirement.lock().await;
                let result = &mut work.previous;
                let held = !result.retiring.is_empty() || !result.drained.is_empty()
                    || !result.retry_finish.is_empty() || !result.unknown.is_empty();
                (held, std::mem::take(&mut result.failures).into_iter().reduce(Error::with_related))
            };
            if held {
                let error = failure.unwrap_or_else(maintenance_retained);
                diagnostic(&owner.shared, error);
                Ok(false)
            } else {
                attempt.failure = failure;
                prepare_completion(&ctx, attempt).await?;
                finish_maintenance(&ctx, attempt).await
            }
        } else if (matches!(&attempt.input.basis, ledger::MaintenanceBasis::PackageCleanup { .. })
            && resources.inventory.has_cleanup_pending().await)
            || (matches!(&attempt.input.basis, ledger::MaintenanceBasis::ContentCleanup { .. })
                && resources.content.has_cleanup_pending().await)
            || outcome.as_ref().err().is_some_and(|error| error.unresolved_phase().is_some()) {
            if let Err(error) = outcome { diagnostic(&owner.shared, error); }
            Ok(false)
        } else {
            attempt.failure = outcome.err();
            prepare_completion(&ctx, attempt).await?;
            finish_maintenance(&ctx, attempt).await
        };
        result
        }
    }.await;
    owner.shared.executing.lock().expect("world executions poisoned").remove(&key);
    result
}

async fn admit_maintenance(
    owner: &WorldHandle, store: &WorldStore, resources: &Arc<crate::owner::resources::Resources>, attempt: &mut MaintenanceAttempt,
) -> Result<(), Error> {
    owner.shared.locator.as_ref().map_err(Clone::clone)?;
    let authority = resources.authorities.maintenance.get().cloned()
        .ok_or_else(|| Error::new("world.maintenance_not_configured", FailureStage::Admission,
            "当前世界未配置维护执行身份。", ApiFailure::NotConfigured, Recovery::None))?;
    if authority.world() != &attempt.input.world || !authority.same_root(&owner.shared.authority) {
        return Err(world_protocol::authorization::AuthorizationFailure::InvalidPrincipal.into());
    }
    resources.live.require_world_open(&attempt.input.world)?;
    let input = attempt.input.clone();
    let budget = attempt.budget.clone();
    let checkpoint = attempt.checkpoint.clone();
    let candidate_ids = attempt.retirement.lock().await.candidates.iter().map(|candidate| candidate.graph.lock().id.clone())
        .collect::<std::collections::BTreeSet<_>>();
    let handoff = attempt.execution.clone();
    attempt.not_committed = false;
    let accepted = authorization::commit_admission(store, attempt.request.clone().prepare()?, move |tx| Box::pin(async move {
        let now = tx.now().await?;
        let impact = match &input.basis {
            ledger::MaintenanceBasis::Retirement { candidates } => {
                let mut scopes = Vec::new();
                for identity in candidates {
                    let graph = if candidate_ids.contains(&identity.id) {
                        crate::extensions::bindings::read_graph_in_transaction(tx, &identity.id).await?
                    } else {
                        crate::extensions::bindings::read_graph_history_in_transaction(tx, &identity.id).await?
                    };
                    if graph.lock().digest != identity.digest { return Err(maintenance_retained()); }
                    scopes.extend(crate::extensions::bindings::retirement_impact(tx, &graph).await?.access);
                }
                authorization::actual_impact(scopes, Vec::new(), Vec::new(), Vec::new(), Vec::new())?
            }
            ledger::MaintenanceBasis::ContentCleanup { batch } => {
                if batch.world() != tx.world() { return Err(maintenance_retained()); }
                crate::content::cleanup_impact(tx).await?
            }
            ledger::MaintenanceBasis::PackageCleanup { batch } => crate::extensions::package::cleanup_impact(tx, batch).await?,
            ledger::MaintenanceBasis::Support { .. } | ledger::MaintenanceBasis::SupportWatches { .. } => return Err(maintenance_retained()),
        };
        let deadline = budget.deadline.as_ref().ok_or_else(maintenance_retained)?;
        let admission = authority.admit(tx, &impact, deadline, &now).await?;
        let head = head::read(tx).await?;
        if head.status != WorldStatus::Ready { return Err(maintenance_retained()); }
        let operation_input = ledger::OperationInput::Maintenance(input.clone());
        let operation = ledger::accept(tx, &admission, &operation_input,
            super::requests::operation_id(&input.world, &input.request_id, operation_input.operation_name()), head.generation, &now).await?;
        let deadline = deadline.min(&admission.invocation().deadline).clone();
        let mut budget = budget;
        budget.deadline = Some(deadline);
        let run = run::start(tx, &admission, &operation.receipt.accepted, RunSpec {
            id: maintenance_run(&input), activation_lock_id: None, release_id: None, branch_id: None,
            basis: serde_json::to_value(&input.basis).map_err(|cause| Error::internal(FailureStage::Prepare).caused(cause))?, budget,
        }, &now).await?;
        let step = run::claim_step(tx, &admission, &run, maintenance_step(&run.id), 0,
            maintenance_name(&input.basis), maintenance_digest(&input.basis)?, &now).await?;
        let mut next = step.clone();
        next.checkpoint = serde_json::to_value(checkpoint).map_err(|cause| Error::internal(FailureStage::Prepare).caused(cause))?;
        let step = run::checkpoint_step(tx, &step, next).await?;
        let budget = CallBudget::resume(run.budget.clone(), run.usage.clone(), &now).map_err(|failure| {
            Error::from_host_failure(world_protocol::process::HostFailure::BudgetExceeded { dimension: failure.dimension }, FailureStage::Admission)
        })?;
        *handoff.lock().expect("maintenance execution handoff poisoned") = Some((admission.clone(), budget, None));
        Ok::<_, Error>((MaintenanceAccepted { run, step }, admission))
    })).await;
    attempt.not_committed = matches!(&accepted, Err(crate::store::TransactionError::NotCommitted { .. }));
    let accepted = match accepted? {
        AdmissionCommit::Committed { outcome, .. } | AdmissionCommit::Replayed(outcome) => outcome.value,
    };
    if attempt.execution.lock().expect("maintenance execution handoff poisoned").is_none() { return Err(maintenance_retained()); }
    if let ledger::MaintenanceBasis::Retirement { candidates } = &attempt.input.basis {
        let locks = candidates.iter().map(|candidate| &candidate.id).collect::<std::collections::BTreeSet<_>>();
        let mut work = attempt.retirement.lock().await;
        let mut reports = owner.shared.startup_reports.lock().expect("world startup reports poisoned");
        if let Some(report) = reports.get_mut(&attempt.input.world) {
            let mut remaining = Vec::new();
            for proof in std::mem::take(&mut report.retiring) {
                if locks.contains(proof.lock()) { work.previous.retiring.push(proof); } else { remaining.push(proof); }
            }
            report.retiring = remaining;
            let mut remaining = Vec::new();
            for proof in std::mem::take(&mut report.drained_retirements) {
                if locks.contains(proof.lock()) { work.previous.drained.push(proof); } else { remaining.push(proof); }
            }
            report.drained_retirements = remaining;
        }
    }
    attempt.accepted = Some(accepted);
    Ok(())
}

async fn prepare_completion(ctx: &ExecutionContext, attempt: &mut MaintenanceAttempt) -> Result<(), Error> {
    let result = match &attempt.input.basis {
        ledger::MaintenanceBasis::Retirement { .. } => {
            let work = attempt.retirement.lock().await;
            MaintenanceResult::Retirement { released: work.previous.released.clone(), retained: work.previous.retained.clone() }
        },
        ledger::MaintenanceBasis::ContentCleanup { .. } => MaintenanceResult::ContentCleanup,
        ledger::MaintenanceBasis::PackageCleanup { .. } => MaintenanceResult::PackageCleanup,
        ledger::MaintenanceBasis::Support { .. } | ledger::MaintenanceBasis::SupportWatches { .. } => return Err(maintenance_retained()),
    };
    let result = serde_json::to_value(result).map_err(|cause| Error::internal(FailureStage::Commit).caused(cause))?;
    let usage = ctx.budget.checkpoint_usage();
    let digest = if matches!(&attempt.input.basis, ledger::MaintenanceBasis::PackageCleanup { .. }) {
        canonical_digest(&(&attempt.input, &result))?
    } else {
        canonical_digest(&(&result, &usage, attempt.failure.as_ref().map(Error::safe_failure)))?
    };
    let request = ctx.commit_request("maintenance.complete", digest, &["authorization", "packages"]).await?;
    attempt.completion = Some(MaintenanceCompletion { request, result, usage });
    Ok(())
}

async fn finish_maintenance(ctx: &ExecutionContext, attempt: &MaintenanceAttempt) -> Result<bool, Error> {
    let completion = attempt.completion.as_ref().ok_or_else(maintenance_retained)?;
    let step = attempt.accepted.as_ref().ok_or_else(maintenance_retained)?.step.clone();
    let result = completion.result.clone();
    let usage = completion.usage.clone();
    let failure = attempt.failure.clone();
    ctx.transact_outcome(completion.request.clone(), move |tx, admission, operation, run| Box::pin(async move {
        let current = run::read_step(tx, &run.id, &step.id).await?.ok_or_else(maintenance_retained)?;
        if current.kind != step.kind || current.input_digest != step.input_digest { return Err(maintenance_retained()); }
        step_retention_roots(tx, &current, &mut crate::store::RetentionRoots::default()).await?;
        let mut next = current.clone();
        next.phase = if failure.is_some() { OperationPhase::Failed } else { OperationPhase::Completed };
        next.result = Some(result);
        next.failure = failure.as_ref().and_then(Error::operation_failure);
        run::checkpoint_step(tx, &current, next).await?;
        run::checkpoint_usage(tx, &run, run::confirmed_usage(&run.usage, usage)?).await?;
        let now = tx.now().await?;
        authorization::check_admitted_output(tx, &admission, admission.impact(), 1, &now).await?;
        if let Some(error) = failure {
            let failure = error.operation_failure().ok_or(error)?;
            ledger::fail(tx, &operation.receipt.accepted, failure, false, &now).await?;
        } else {
            ledger::complete_maintenance(tx, &operation.receipt.accepted, &now).await?;
        }
        Ok::<_, Error>(())
    })).await.map_err(Error::from)?;
    Ok(true)
}

fn maintenance_name(basis: &ledger::MaintenanceBasis) -> &'static str {
    match basis {
        ledger::MaintenanceBasis::Retirement { .. } => "maintenance.retirement",
        ledger::MaintenanceBasis::ContentCleanup { .. } => "maintenance.content_cleanup",
        ledger::MaintenanceBasis::PackageCleanup { .. } => "maintenance.package_cleanup",
        ledger::MaintenanceBasis::Support { .. } => "maintenance.support",
        ledger::MaintenanceBasis::SupportWatches { .. } => "maintenance.support_watches",
    }
}

fn maintenance_digest(basis: &ledger::MaintenanceBasis) -> Result<Digest, Error> {
    match basis {
        ledger::MaintenanceBasis::Retirement { candidates } => {
            if candidates.is_empty() || candidates.len() > 32
                || candidates.iter().any(|candidate| candidate.revision.0 == 0)
                || candidates.iter().enumerate().any(|(index, candidate)| candidates[..index].iter().any(|previous| previous.id == candidate.id)) {
                return Err(maintenance_retained());
            }
            canonical_digest(basis).map_err(Into::into)
        }
        ledger::MaintenanceBasis::ContentCleanup { batch } => {
            if batch.is_empty() { return Err(maintenance_retained()); }
            batch.input_digest().map_err(Into::into)
        }
        ledger::MaintenanceBasis::PackageCleanup { batch } => {
            if batch.is_empty() { return Err(maintenance_retained()); }
            batch.input_digest()
        }
        ledger::MaintenanceBasis::Support { .. } | ledger::MaintenanceBasis::SupportWatches { .. } => canonical_digest(basis).map_err(Into::into),
    }
}

fn maintenance_run(input: &ledger::MaintenanceInput) -> RunId {
    let digest = canonical_digest(&("world.maintenance.run.v1", input)).expect("maintenance identity serializes");
    RunId::try_new(format!("maintenance-run-{}", &digest.as_str()[7..])).expect("digest identifier")
}

fn maintenance_step(run: &RunId) -> StepId {
    let digest = canonical_digest(&("world.maintenance.step.v1", run)).expect("maintenance step identity serializes");
    StepId::try_new(format!("maintenance-step-{}", &digest.as_str()[7..])).expect("digest identifier")
}

fn maintenance_retained() -> Error {
    Error::new("world.maintenance_retained", FailureStage::Recover,
        "维护仍持有原执行身份、提交或清理事实。", ApiFailure::Operation(world_protocol::operation::OperationFailure::CleanupFailed), Recovery::ManualReview)
}

pub(super) async fn start(owner: WorldHandle, parent: SourceParent) -> Result<(), Error> {
    let world = parent.assignment.world.clone();
    let store = ready_for(&owner.shared, &world).await?;
    let resources = resources(&owner.shared, &store, &world)?;
    start_at(owner, store, resources, parent).await
}

pub(super) async fn start_at(
    owner: WorldHandle, store: WorldStore, resources: Arc<crate::owner::resources::Resources>, parent: SourceParent,
) -> Result<(), Error> {
    let cancellation = owner.shared.cancellation.child_token();
    let Some(mut prepared) = prepare(&owner, &store, &resources, parent, cancellation.clone()).await? else { return Ok(()); };
    let tasks = resources.tasks.clone();
    drop(tasks.spawn(async move {
        loop {
            let key = (prepared.ctx.operation.world.clone(), prepared.ctx.operation.operation_id.clone());
            let outcome = execute(prepared).await;
            owner.shared.executing.lock().expect("world executions poisoned").remove(&key);
            match outcome {
                Ok(Some(parent)) if !owner.shared.closing.load(std::sync::atomic::Ordering::Acquire) && !cancellation.is_cancelled() => {
                    match prepare(&owner, &store, &resources, parent, cancellation.clone()).await {
                        Ok(Some(next)) => prepared = next,
                        Ok(None) => break,
                        Err(error) => { diagnostic(&owner.shared, error); break; }
                    }
                }
                Ok(_) => break,
                Err(error) => { diagnostic(&owner.shared, error); break; }
            }
        }
    }));
    Ok(())
}

async fn prepare(
    owner: &WorldHandle, store: &WorldStore, resources: &Arc<crate::owner::resources::Resources>,
    parent: SourceParent, cancellation: tokio_util::sync::CancellationToken,
) -> Result<Option<Prepared>, Error> {
    if cancellation.is_cancelled() { return Ok(None); }
    let pending = segment(&owner.shared, store, resources, parent).await?;
    let input = pending.input.clone();
    let key = (input.parent.assignment.world.clone(), operation_id(&input));
    {
        let mut executing = owner.shared.executing.lock().expect("world executions poisoned");
        if executing.contains_key(&key) { return Ok(None); }
        executing.insert(key.clone(), cancellation.clone());
    }
    let prepared = admit(owner, store, resources, pending, cancellation).await;
    if !matches!(&prepared, Ok(Some(_))) { owner.shared.executing.lock().expect("world executions poisoned").remove(&key); }
    if prepared.is_ok() || (prepared.as_ref().err().is_some_and(|error| error.unresolved_phase().is_none())
        && !store.pending_commits().iter().any(|pending| pending.world == key.0 && pending.commit_id == input.commit_id)) {
        owner.shared.pending_source_segments.lock().expect("world source segment custody poisoned")
            .remove(&(input.parent.assignment.world.clone(), input.run_id));
    }
    prepared
}

async fn segment(shared: &Shared, store: &WorldStore, resources: &crate::owner::resources::Resources, parent: SourceParent) -> Result<PendingSegment, Error> {
    let digest = canonical_digest(&("world.source.service.v1", &parent))?;
    let suffix = &digest.as_str()[7..];
    let run_id = RunId::try_new(format!("source-run-{suffix}")).expect("digest identifier");
    let world = parent.assignment.world.clone();
    if let Some(input) = shared.pending_source_segments.lock().expect("world source segment custody poisoned").get(&(world.clone(), run_id.clone())).cloned() {
        return Ok(input);
    }
    let id = run_id.clone();
    let existing = store.snapshot(world.clone(), move |snapshot| Box::pin(async move {
        let world = snapshot.world();
        let row = snapshot.query_opt("SELECT body FROM world_step WHERE tenant_id=$1 AND world_id=$2 AND run_id=$3 AND kind='sources.service' AND ordinal=0",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str()]).await?;
        row.map(|row| {
            let step: StepRecord = serde_json::from_value(row.get("body"))
                .map_err(|cause| Error::internal(FailureStage::Recover).caused(cause))?;
            serde_json::from_value::<SourceSegment>(step.checkpoint)
                .map_err(|cause| Error::internal(FailureStage::Recover).caused(cause))
        }).transpose()
    })).await?;
    if let Some(input) = existing {
        if canonical_digest(&input.parent)? != canonical_digest(&parent)? { return Err(retained()); }
        return Ok(PendingSegment { input, execution: Arc::default() });
    }
    let now = store.snapshot(world, |snapshot| Box::pin(async move { snapshot.now().await })).await?;
    let policy = resources.preparation.execution_policy();
    let wall = policy.host_io_timeout.checked_add(policy.cleanup_timeout)
        .ok_or_else(|| Error::internal(FailureStage::Prepare))?;
    let deadline = chrono::DateTime::parse_from_rfc3339(now.as_str())
        .map_err(|cause| Error::internal(FailureStage::Prepare).caused(cause))?
        .checked_add_signed(chrono::Duration::from_std(wall)
            .map_err(|cause| Error::internal(FailureStage::Prepare).caused(cause))?)
        .ok_or_else(|| Error::internal(FailureStage::Prepare))?;
    let mut budget = queries::objects::query_budget(Timestamp::try_new(deadline.to_rfc3339())
        .map_err(|cause| Error::internal(FailureStage::Prepare).caused(cause))?);
    budget.max_wall_time = DurationMs(u64::try_from(wall.as_millis()).map_err(|cause| Error::internal(FailureStage::Prepare).caused(cause))?);
    let input = SourceSegment { parent, request_id: RequestId::try_new(format!("source-request-{suffix}")).expect("digest identifier"),
        run_id, commit_id: CommitId::try_new(format!("source-admit-{suffix}")).expect("digest identifier"), budget };
    let mut pending = shared.pending_source_segments.lock().expect("world source segment custody poisoned");
    Ok(pending.entry((input.parent.assignment.world.clone(), input.run_id.clone()))
        .or_insert_with(|| PendingSegment { input, execution: Arc::default() }).clone())
}

async fn admit(
    owner: &WorldHandle, store: &WorldStore, resources: &Arc<crate::owner::resources::Resources>,
    pending: PendingSegment, cancellation: tokio_util::sync::CancellationToken,
) -> Result<Option<Prepared>, Error> {
    let input = pending.input;
    resources.live.require_world_open(&input.parent.assignment.world)?;
    let authority = resources.authorities.maintenance.get().cloned()
        .ok_or_else(|| Error::new("world.maintenance_not_configured", FailureStage::Admission,
            "当前世界未配置维护执行身份。", ApiFailure::NotConfigured, Recovery::None))?;
    if authority.world() != &input.parent.assignment.world || !authority.same_root(&owner.shared.authority) {
        return Err(world_protocol::authorization::AuthorizationFailure::InvalidPrincipal.into());
    }
    let locator = owner.shared.locator.as_ref().map_err(Clone::clone)?.clone();
    let cleanup_timeout = resources.preparation.execution_policy().cleanup_timeout;
    let execution = pending.execution;
    let prepared = execution.clone();
    let admission_request = crate::owner::execution::prepare_request(store, &input.parent.assignment.world,
        input.commit_id.clone(), canonical_digest(&input)?, &["authorization", "operation", "packages", "sources"]).await?;
    let request = input.clone();
    let accepted = authorization::commit_admission(store, admission_request.prepare()?, move |tx| Box::pin(async move {
        let now = tx.now().await?;
        let command = WorldCommand::StartSync(request.parent.request.clone());
        let impact = workflows::sources::impact(tx, &command).await?;
        let deadline = request.budget.deadline.as_ref().ok_or_else(retained)?;
        let admission = authority.admit(tx, &impact, deadline, &now).await?;
        sync::require_segment_parent(tx, &admission, &request).await?;
        let (release, lock) = workflows::sources::run_basis(tx, &command).await?;
        let head = head::read(tx).await?;
        if head.status != WorldStatus::Ready { return Err(retained()); }
        let basis = serde_json::to_value(&command).map_err(|cause| Error::internal(FailureStage::Prepare).caused(cause))?;
        let envelope = CommandEnvelope { world: tx.world().clone(), request_id: request.request_id.clone(), command };
        let operation = ledger::accept(tx, &admission, &ledger::OperationInput::Command(envelope), operation_id(&request), head.generation, &now).await?;
        if operation.receipt.progress.run_id.is_some() || ledger::terminal(operation.receipt.phase) { return Err(retained()); }
        let mut budget = request.budget.clone();
        budget.deadline = Some(deadline.min(&admission.invocation().deadline).clone());
        let run = run::start(tx, &admission, &operation.receipt.accepted, RunSpec {
            id: request.run_id.clone(), activation_lock_id: Some(lock), release_id: Some(release), branch_id: None,
            basis, budget,
        }, &now).await?;
        let step = run::claim_step(tx, &admission, &run, step_id(&request), 0, "sources.service", canonical_digest(&request)?, &now).await?;
        let mut checkpoint = step.clone();
        checkpoint.checkpoint = serde_json::to_value(&request).map_err(|cause| Error::internal(FailureStage::Prepare).caused(cause))?;
        let step = run::checkpoint_step(tx, &step, checkpoint).await?;
        let budget = CallBudget::resume(run.budget.clone(), run.usage.clone(), &now)
            .map_err(|failure| Error::from_host_failure(world_protocol::process::HostFailure::BudgetExceeded { dimension: failure.dimension }, FailureStage::Admission))?;
        let work_deadline = budget.deadline().checked_sub(cleanup_timeout).ok_or_else(retained)?;
        *prepared.lock().expect("source segment execution handoff poisoned") = Some((admission.clone(), budget, work_deadline));
        Ok::<_, Error>((Accepted { input: request, run, step, now }, admission))
    })).await?;
    let accepted = match accepted {
        AdmissionCommit::Committed { outcome, .. } => outcome.value,
        AdmissionCommit::Replayed(outcome) => return recover_segment(owner, store, resources, outcome.value.input, cancellation).await,
    };
    let (admission, budget, work_deadline) = execution.lock().expect("source segment execution handoff poisoned")
        .take().ok_or_else(retained)?;
    let ctx = ExecutionContext {
        owner: owner.clone(), store: store.clone(), resources: resources.clone(), admission,
        authority: owner.shared.authority.clone(), operation: accepted.run.operation.clone(),
        pipeline: foundation::pipeline::PipelineContext::silent_in_memory(accepted.run.id.as_str()),
        run: accepted.run, cancellation, deadline: budget.deadline(), budget,
        source_access: owner.shared.source_access.clone(), locator,
        target: Arc::new(owner.clone()),
    };
    Ok(Some(Prepared { ctx, input: accepted.input, step: accepted.step, work_deadline }))
}

pub(super) async fn recover_sources(
    owner: WorldHandle, store: WorldStore, resources: Arc<crate::owner::resources::Resources>, world: WorldRef,
) -> Result<(), Error> {
    let inputs = store.snapshot(world, |snapshot| Box::pin(async move {
        let rows = snapshot.query("SELECT s.body FROM world_step s JOIN world_run r USING(tenant_id,world_id,run_id) WHERE s.tenant_id=$1 AND s.world_id=$2 AND s.kind='sources.service' AND r.phase NOT IN ('completed','failed','cancelled_before_commit','cancelled_after_commit') ORDER BY s.run_id",
            &[&snapshot.world().tenant_id.as_str(), &snapshot.world().world_id.as_str()]).await?;
        let mut inputs = Vec::with_capacity(rows.len());
        for row in rows {
            let step: StepRecord = serde_json::from_value(row.get("body")).map_err(|cause| retained().caused(cause))?;
            let input: SourceSegment = serde_json::from_value(step.checkpoint.clone()).map_err(|cause| retained().caused(cause))?;
            if step.run_id != input.run_id || step.id != step_id(&input) || step.ordinal != 0
                || step.input_digest != canonical_digest(&input)? { return Err(retained()); }
            inputs.push(input);
        }
        Ok::<_, Error>(inputs)
    })).await?;
    for input in inputs { start_at(owner.clone(), store.clone(), resources.clone(), input.parent).await?; }
    Ok(())
}

async fn recover_segment(
    owner: &WorldHandle, store: &WorldStore, resources: &Arc<crate::owner::resources::Resources>,
    input: SourceSegment, cancellation: tokio_util::sync::CancellationToken,
) -> Result<Option<Prepared>, Error> {
    let authority = resources.authorities.maintenance.get().cloned()
        .ok_or_else(|| Error::new("world.maintenance_not_configured", FailureStage::Admission,
            "当前世界未配置维护执行身份。", ApiFailure::NotConfigured, Recovery::None))?;
    if authority.world() != &input.parent.assignment.world || !authority.same_root(&owner.shared.authority) { return Err(retained()); }
    let handoff = Arc::new(Mutex::new(None));
    let prepared = handoff.clone();
    let request = input.clone();
    let cleanup = resources.preparation.execution_policy().cleanup_timeout;
    let commit = CommitId::try_new(uuid::Uuid::new_v4().to_string()).expect("UUID identifier");
    let batch = crate::owner::execution::prepare_request(store, &input.parent.assignment.world, commit,
        canonical_digest(&("world.source.segment.recover.v1", &input))?, &["authorization", "operation", "packages", "sources"]).await?.prepare()?;
    let accepted = authorization::commit_admission(store, batch, move |tx| Box::pin(async move {
        let now = tx.now().await?;
        let run = run::read_run(tx, &request.run_id).await?;
        let operation = ledger::read(tx, &run.operation.operation_id).await?;
        let command = WorldCommand::StartSync(request.parent.request.clone());
        if ledger::terminal(run.phase) || ledger::terminal(operation.receipt.phase)
            || operation.receipt.accepted.operation_id != operation_id(&request)
            || operation.input.command()? != &command { return Err(retained()); }
        let step = run::read_step(tx, &run.id, &step_id(&request)).await?.ok_or_else(retained)?;
        if step.kind != "sources.service" || step.ordinal != 0 || step.input_digest != canonical_digest(&request)?
            || canonical_digest(&step.checkpoint)? != canonical_digest(&serde_json::to_value(&request).map_err(|cause| retained().caused(cause))?)? { return Err(retained()); }
        let impact = workflows::sources::impact(tx, &command).await?;
        let recovery_deadline = chrono::DateTime::parse_from_rfc3339(now.as_str()).map_err(|cause| retained().caused(cause))?
            .checked_add_signed(chrono::Duration::from_std(cleanup).map_err(|cause| retained().caused(cause))?).ok_or_else(retained)?;
        let recovery_deadline = Timestamp::try_new(recovery_deadline.to_rfc3339()).map_err(|cause| retained().caused(cause))?;
        let deadline = run.budget.deadline.as_ref().ok_or_else(retained)?.max(&recovery_deadline);
        let admission = authority.admit(tx, &impact, deadline, &now).await?;
        run::require_run_invocation(tx, &admission, &run.id).await?;
        sync::require_segment_recovery(tx, &admission, &request).await?;
        let budget = CallBudget::resume(run.budget.clone(), run.usage.clone(), &now)
            .map_err(|failure| Error::from_host_failure(world_protocol::process::HostFailure::BudgetExceeded { dimension: failure.dimension }, FailureStage::Recover));
        *prepared.lock().expect("source recovery handoff poisoned") = Some((admission.clone(), budget));
        Ok::<_, Error>((Accepted { input: request, run, step, now }, admission))
    })).await?;
    let accepted = match accepted {
        AdmissionCommit::Committed { outcome, .. } => outcome.value,
        AdmissionCommit::Replayed(_) => return Err(retained()),
    };
    let (admission, budget) = handoff.lock().expect("source recovery handoff poisoned").take().ok_or_else(retained)?;
    let budget = match budget {
        Ok(budget) => budget,
        Err(error) => {
            let fenced = workflows::sources::fence_rejected_segment(store, resources, &admission, &accepted.input,
                owner.shared.source_access.clone(), Instant::now() + cleanup, cancellation.clone()).await
                .map_err(|fence| fence.with_related(error.clone()))?;
            let receipt = crate::owner::FailedWorkSettlement::resume_rejected_source(store, resources, &owner.shared.authority,
                &admission, &accepted.run.operation, &accepted.run, &error, fenced).await?;
            if ledger::terminal(receipt.phase) { return Ok(None); }
            return Err(error);
        }
    };
    let work_deadline = budget.deadline().checked_sub(cleanup).ok_or_else(retained)?;
    let ctx = ExecutionContext {
        owner: owner.clone(), store: store.clone(), resources: resources.clone(), admission,
        authority: owner.shared.authority.clone(), operation: accepted.run.operation.clone(),
        pipeline: foundation::pipeline::PipelineContext::silent_in_memory(accepted.run.id.as_str()),
        run: accepted.run, cancellation, deadline: budget.deadline(), budget,
        source_access: owner.shared.source_access.clone(), locator: owner.shared.locator.as_ref().map_err(Clone::clone)?.clone(),
        target: Arc::new(owner.clone()),
    };
    Ok(Some(Prepared { ctx, input: accepted.input, step: accepted.step, work_deadline }))
}

async fn execute(prepared: Prepared) -> Result<Option<SourceParent>, Error> {
    let Prepared { ctx, input, step, work_deadline } = prepared;
    let worker = ctx.resources.tasks.spawn_run(&ctx, {
        let ctx = ctx.clone();
        async move { work(&ctx, input, step, work_deadline).await }
    });
    let outcome = match worker {
        Ok(worker) => match worker.await {
            Ok(outcome) => outcome,
            Err(cause) => Err(Error::internal(FailureStage::Execute).caused(cause)),
        },
        Err(error) => Err(error),
    };
    if let Err(error) = &outcome {
        if let Err(settlement) = ctx.fail(error).await { return Err(error.clone().with_related(settlement)); }
    }
    outcome
}

async fn work(ctx: &ExecutionContext, input: SourceSegment, step: StepRecord, work_deadline: Instant) -> Result<Option<SourceParent>, Error> {
    let (broker, lease) = workflows::sources::broker(ctx, &input.parent.request).await?;
    let checkpoint = ctx.resources.sync.run_segment(ctx.clone(), input.clone(), broker, lease, work_deadline).await?;
    let usage = ctx.budget.checkpoint_usage();
    let request = input.parent.request;
    let id = ctx.run.id.clone();
    let committed = ctx.transact("source.segment.complete", canonical_digest(&checkpoint)?, &["sources", "authorization", "packages"],
        move |tx, admission, operation, run| Box::pin(async move {
            let current = run::read_step(tx, &run.id, &step.id).await?.ok_or_else(retained)?;
            if current.input_digest != step.input_digest || current.kind != "sources.service" { return Err(retained()); }
            let mut next = current.clone();
            next.phase = OperationPhase::Completed;
            next.result = Some(serde_json::to_value(&checkpoint).map_err(|cause| Error::internal(FailureStage::Commit).caused(cause))?);
            run::checkpoint_step(tx, &current, next).await?;
            run::checkpoint_usage(tx, &run, run::confirmed_usage(&run.usage, usage)?).await?;
            authorization::check_admitted_output(tx, &admission, admission.impact(), 1, &tx.now().await?).await?;
            ledger::complete(tx, &operation.receipt.accepted, OperationResult::Sync {
                binding: request.binding.clone(), checkpoint: checkpoint.source,
            }, &tx.now().await?).await?;
            Ok::<_, Error>(sync::segment_parent(tx, &request, &id).await?)
        })).await?;
    Ok(committed.value)
}

fn operation_id(input: &SourceSegment) -> OperationId {
    super::requests::operation_id(&input.parent.assignment.world, &input.request_id, WorldCommand::StartSync(input.parent.request.clone()).operation_name())
}
fn step_id(input: &SourceSegment) -> StepId {
    let digest = canonical_digest(&("world.source.service.step.v1", &input.run_id)).expect("step identity serializes");
    StepId::try_new(format!("source-step-{}", &digest.as_str()[7..])).expect("digest identifier")
}
fn retained() -> Error {
    Error::new("world.source_segment_retained", FailureStage::Recover,
        "原源同步执行段尚未确认完成，保留原执行身份与预算。",
        ApiFailure::Operation(world_protocol::operation::OperationFailure::CleanupFailed), Recovery::ManualReview)
}
fn diagnostic(shared: &Shared, error: Error) {
    shared.initialization_diagnostics.lock().expect("world diagnostics poisoned").push(error);
}
