use std::sync::Arc;

use super::{Error, Invocation, budget_failure, records, wire_failure};
use crate::{
    authorization::{Admission, EvaluationAuthority},
    content::ContentOwner,
    extensions::{
        bindings::BindingGraph,
        invocation::{
            CallBudget, CompositionFailure, CompositionOutcome, merge_inspected_composition,
            retained_composition_settled,
        },
        process::ProcessInspection,
    },
    owner::{self, ExecutionContext, StepRecord},
    store::{RetentionRoots, WorldTransaction},
};
use serde::{Deserialize, Serialize};
use world_protocol::{
    evaluation::EvaluationFailure,
    failure::FailureStage,
    ids::*,
    materials::BlobRef,
    operation::OperationPhase,
    process::HostFailure,
    slots::{OracleFailure, OracleResult, SlotFailure, SlotResponse},
};

const KIND: &str = "world.evaluation.online_oracle";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Custody {
    invocation: Invocation,
    retained: BlobRef,
    roots: RetentionRoots,
    pub(super) settled: bool,
    pub(super) result: Result<OracleResult, HostFailure>,
}

pub(super) struct Existing {
    pub(super) invocation: Invocation,
    step: StepRecord,
    custody: Option<Custody>,
    inspections: Vec<ProcessInspection>,
    observation: Option<serde_json::Value>,
}

pub(super) async fn read(
    ctx: &ExecutionContext,
    plan: &super::OnlineOraclePlan,
    observed: &Digest,
    queries: &Digest,
) -> Result<Option<Existing>, owner::Error> {
    let caller = ctx.admission.clone();
    let binding = plan.binding.clone();
    let oracle = plan.test.oracle.clone();
    let observed = observed.clone();
    let queries = queries.clone();
    let id = identity(&binding, &observed)?;
    ctx.store
        .snapshot(binding.task.world.clone(), move |snapshot| {
            Box::pin(async move {
                let now = snapshot.now().await?;
                crate::authorization::recheck_read(snapshot, &caller, &now).await?;
                let operation =
                    owner::read_record_snapshot(snapshot, &binding.operation_id).await?;
                operation.identity.require_resume(caller.verified())?;
                if operation.receipt.progress.run_id.as_ref() != Some(&binding.run_id) {
                    return Err(super::changed().into());
                }
                let Some(step) = owner::read_step_snapshot(snapshot, &binding.run_id, &id).await?
                else {
                    return Ok(None);
                };
                let invocation: Invocation = records::decode(step.checkpoint.clone())?;
                if step.kind != KIND
                    || step.input_digest != records::digest(&invocation)?
                    || invocation.binding != binding
                    || invocation.oracle != oracle
                    || invocation.observed != observed
                    || invocation.queries != queries
                {
                    return Err(super::changed().into());
                }
                if step.phase == OperationPhase::Running {
                    if step.result.is_some() || step.failure.is_some() {
                        return Err(super::changed().into());
                    }
                    return Ok(Some(Existing {
                        invocation,
                        step,
                        custody: None,
                        inspections: Vec::new(),
                        observation: None,
                    }));
                }
                let custody: Custody =
                    records::decode(step.result.clone().ok_or_else(super::changed)?)?;
                if custody.invocation != invocation {
                    return Err(super::changed().into());
                }
                if step.phase == OperationPhase::Retained {
                    if custody.settled {
                        return Err(super::changed().into());
                    }
                } else {
                    if !custody.settled {
                        return Err(super::changed().into());
                    }
                    if step.phase == OperationPhase::Failed {
                        return Err(step.failure.ok_or_else(super::changed)?.into());
                    }
                    if step.phase != OperationPhase::Completed
                        || step.failure.is_some()
                        || custody.result.is_err()
                    {
                        return Err(super::changed().into());
                    }
                }
                Ok(Some(Existing {
                    invocation,
                    step,
                    custody: Some(custody),
                    inspections: Vec::new(),
                    observation: None,
                }))
            })
        })
        .await
}

pub(super) async fn inspect(
    ctx: &ExecutionContext,
    plan: &super::OnlineOraclePlan,
    page: &world_protocol::query::QueryPage,
    queries: &[world_protocol::slots::OracleQueryObservation],
    graph: &BindingGraph,
    mut existing: Existing,
) -> Result<Option<Existing>, owner::Error> {
    if existing.step.phase == OperationPhase::Completed {
        return Ok(Some(existing));
    }
    let invocation = &existing.invocation;
    let selected = graph
        .node(&invocation.root)
        .map_err(|failure| Error::Binding(failure.into()))?;
    let order = graph
        .composition_order(&selected.binding_id)
        .map_err(|failure| Error::Binding(failure.into()))?;
    let inspections: Vec<ProcessInspection> = order
        .iter()
        .filter_map(|node| {
            ctx.resources.live.inspect_process(
                &invocation.binding.task.world,
                &invocation.invocation_id,
                node,
            )
        })
        .collect();
    let observed =
        world_protocol::wire::encode(page, super::maximum(&plan.task)).map_err(wire_failure)?;
    for inspection in &inspections {
        let context = inspection.context();
        let world_protocol::slots::SlotRequest::Evaluation(request) = inspection.request() else {
            return Err(super::changed().into());
        };
        if context.lease().graph().lock() != &invocation.graph
            || context.lease().closure() != &invocation.closure
            || context.lease().invocation() != &invocation.invocation_id
            || context.admission().invocation().world != invocation.binding.task.world
            || request.world != plan.task.world
            || request.test_case_id != plan.test.id
            || request.fixture != plan.fixture
            || request.expected != plan.expected
            || request.observed != observed
            || request.queries != queries
        {
            return Err(super::changed().into());
        }
    }
    if existing.step.phase == OperationPhase::Running && inspections.len() != order.len() {
        return Ok(None);
    }
    let deadline = ctx.deadline.min(ctx.budget.deadline());
    for inspection in &inspections {
        tokio::select! {
            _ = ctx.cancellation.cancelled() => return Ok(None),
            _ = inspection.wait(deadline) => {},
        }
    }
    if inspections
        .iter()
        .any(|inspection| !inspection.snapshot().settled || !inspection.closure_settled())
    {
        return Ok(None);
    }
    if existing.step.phase == OperationPhase::Retained {
        let custody = existing.custody.as_ref().ok_or_else(super::changed)?;
        let bytes = super::super::content::read_run_blob(ctx, plan, &custody.retained).await?;
        let observation: serde_json::Value =
            world_protocol::wire::decode(&bytes, super::maximum(&plan.task))
                .map_err(wire_failure)?;
        if observation.get("nodes").is_none() {
            let failure: HostFailure = records::decode(observation)?;
            if custody.result != Err(failure) || existing.step.failure.is_none() {
                return Err(super::changed().into());
            }
            // A top-level failure has no per-member cleanup proof to recover.
            return Ok(None);
        }
        let result: Result<SlotResponse, HostFailure> = records::decode(
            observation
                .get("result")
                .cloned()
                .ok_or_else(super::changed)?,
        )?;
        let result = match result {
            Ok(SlotResponse::Evaluation(result)) => Ok(result),
            Ok(_) => Err(HostFailure::Slot(SlotFailure::Evaluation(
                OracleFailure::SchemaMismatch,
            ))),
            Err(failure) => Err(failure),
        };
        if result != custody.result || custody.result.is_err() && existing.step.failure.is_none() {
            return Err(super::changed().into());
        }
        if let Some(failure) = &existing.step.failure {
            let Err(result) = &custody.result else {
                return Ok(None);
            };
            let projected = owner::Error::from_host_failure(result.clone(), FailureStage::Verify)
                .operation_failure()
                .ok_or_else(super::changed)?;
            if projected.details != failure.details {
                // A retained roots failure cannot be cleared by cleanup alone.
                return Ok(None);
            }
        }
        if !retained_composition_settled(
            &ctx.resources.live,
            graph,
            &invocation.closure,
            &invocation.invocation_id,
            &observation,
            &inspections,
        )
        .map_err(Error::Composition)?
        {
            return Ok(None);
        }
        existing.observation = Some(observation);
    }
    existing.inspections = inspections;
    Ok(Some(existing))
}

pub(super) async fn restore(
    ctx: &ExecutionContext,
    graph: &BindingGraph,
    authority: &EvaluationAuthority,
    admission: &Admission,
    existing: Existing,
) -> Result<Option<(Invocation, Custody)>, owner::Error> {
    let Existing {
        invocation,
        step,
        custody,
        inspections,
        observation,
    } = existing;
    if step.phase == OperationPhase::Completed {
        return Ok(Some((invocation, custody.ok_or_else(super::changed)?)));
    }
    if step.phase == OperationPhase::Running {
        let inspection = inspections.first().ok_or_else(super::changed)?;
        let outcome = match merge_inspected_composition(
            graph,
            &invocation.closure,
            &invocation.invocation_id,
            inspection.request(),
            &inspections,
        )
        .await
        {
            Ok(Some(outcome)) => Ok(outcome),
            Ok(None) => return Ok(None),
            Err(error) => Err(error),
        };
        let retained = retain(
            ctx,
            authority,
            admission,
            &invocation,
            &step,
            &ctx.budget,
            &outcome,
            &format!("online.oracle.restore.{}", step.revision.0),
        )
        .await;
        if retained.as_ref().is_ok_and(|custody| !custody.settled) {
            return Ok(None);
        }
        let result = outcome.and_then(|outcome| outcome.result);
        let custody = match result {
            Ok(SlotResponse::Evaluation(_)) => retained?,
            Ok(_) => {
                return super::super::content::preserve(
                    Err(super::super::super::ConstraintFailure::OracleUnverified.into()),
                    retained.map(|_| ()),
                )
                .map_err(Into::into);
            }
            Err(error) => {
                return super::super::content::preserve(
                    Err(Error::Composition(error)),
                    retained.map(|_| ()),
                )
                .map_err(Into::into);
            }
        };
        return Ok(Some((invocation, custody)));
    }
    let mut custody = custody.ok_or_else(super::changed)?;
    let observation = observation.ok_or_else(super::changed)?;
    if !retained_composition_settled(
        &ctx.resources.live,
        graph,
        &invocation.closure,
        &invocation.invocation_id,
        &observation,
        &inspections,
    )
    .map_err(Error::Composition)?
    {
        return Ok(None);
    }
    custody.settled = true;
    let current = step.clone();
    let retained = custody.clone();
    let authority = authority.clone();
    let admission = admission.clone();
    ctx.transact(
        &format!("online.oracle.settle.{}", step.revision.0),
        records::digest(&(&step, &custody))?,
        &["authorization", "content"],
        move |tx, _, _, _| {
            Box::pin(async move {
                let now = tx.now().await?;
                authority
                    .recheck_online_oracle(
                        tx,
                        &admission,
                        &retained.invocation.binding,
                        implementation(&retained.invocation)?,
                        &retained.invocation.observed,
                        &now,
                    )
                    .await?;
                let step = owner::read_step(tx, &current.run_id, &current.id)
                    .await?
                    .ok_or_else(super::changed)?;
                if records::encode(&step)? != records::encode(&current)? {
                    return Err(super::changed().into());
                }
                let mut roots = RetentionRoots::default();
                online_oracle_retention_roots(tx, &step, &mut roots).await?;
                let mut next = step.clone();
                next.phase = if next.failure.is_some() {
                    OperationPhase::Failed
                } else {
                    OperationPhase::Completed
                };
                next.result = Some(records::encode(&retained)?);
                owner::checkpoint_step(tx, &step, next).await?;
                Ok(())
            })
        },
    )
    .await?;
    if let Some(failure) = step.failure {
        return Err(failure.into());
    }
    Ok(Some((invocation, custody)))
}

pub(super) async fn claim(
    ctx: &ExecutionContext,
    authority: &EvaluationAuthority,
    admission: &Admission,
    invocation: &Invocation,
    budget: &CallBudget,
) -> Result<StepRecord, Error> {
    budget
        .charge(world_protocol::budget::BudgetDimension::Steps, 1)
        .map_err(budget_failure)?;
    let authority = authority.clone();
    let auth = admission.clone();
    let invocation = invocation.clone();
    let input = records::digest(&invocation)?;
    let id = step_id(&invocation)?;
    let claimed_input = input.clone();
    let request = ctx
        .commit_request("online.oracle.claim", input.clone(), &["authorization"])
        .await?;
    let committed =
        super::super::super::io::transact(&ctx.store, &request, "claim", &input, move |tx| {
            Box::pin(async move {
                let now = tx.now().await?;
                let implementation = implementation(&invocation)?;
                authority
                    .recheck_online_oracle(
                        tx,
                        &auth,
                        &invocation.binding,
                        implementation,
                        &invocation.observed,
                        &now,
                    )
                    .await?;
                let parent =
                    owner::read_step(tx, &invocation.binding.run_id, &invocation.binding.step_id)
                        .await?
                        .ok_or(EvaluationFailure::BasisChanged)?;
                let run = owner::read_run(tx, &invocation.binding.run_id).await?;
                let ordinal = parent
                    .ordinal
                    .checked_add(1)
                    .ok_or(EvaluationFailure::InternalFault)?;
                let step =
                    owner::claim_step(tx, &auth, &run, id, ordinal, KIND, claimed_input, &now)
                        .await?;
                let mut next = step.clone();
                next.checkpoint = records::encode(&invocation)?;
                Ok(owner::checkpoint_step(tx, &step, next).await?)
            })
        })
        .await?;
    if committed.replayed {
        return Err(EvaluationFailure::OracleUnavailable.into());
    }
    Ok(committed.value)
}

pub(super) async fn retain(
    ctx: &ExecutionContext,
    authority: &EvaluationAuthority,
    admission: &Admission,
    invocation: &Invocation,
    step: &StepRecord,
    budget: &CallBudget,
    outcome: &Result<CompositionOutcome, CompositionFailure>,
    stage: &str,
) -> Result<Custody, Error> {
    let live_settled = !ctx
        .resources
        .live
        .invocation_unsettled(&invocation.binding.task.world, &invocation.invocation_id);
    let settled = live_settled
        && outcome.as_ref().is_ok_and(|outcome| {
            outcome.nodes.iter().all(|node| {
                node.process.as_ref().is_none_or(|process| {
                    process.cleanup.is_none()
                        && (process.delivery == crate::extensions::process::Delivery::NotDispatched
                            || process.outcome.as_ref().is_some_and(|outcome| {
                                outcome.terminal != world_protocol::process::TerminalState::Retained
                            }))
                })
            })
        })
        || (outcome.is_err() && live_settled);
    let maximum = usize::try_from(
        budget
            .remaining(world_protocol::budget::BudgetDimension::Bytes)
            .map_err(budget_failure)?,
    )
    .unwrap_or(usize::MAX);
    let (bytes, roots, failure, roots_error) = match outcome {
        Ok(outcome) => {
            let (roots, roots_error) = match outcome.retained_roots(&invocation.binding.task.world)
            {
                Ok(roots) => (roots, None),
                Err(error) => (RetentionRoots::default(), Some(Error::Owner(error))),
            };
            let failure = roots_error.as_ref().map(Error::host_failure).or_else(|| {
                outcome
                    .result
                    .as_ref()
                    .err()
                    .map(CompositionFailure::host_failure)
            });
            (
                world_protocol::wire::encode(&outcome.retained(), maximum).map_err(wire_failure)?,
                roots,
                failure,
                roots_error,
            )
        }
        Err(error) => {
            let failure = error.host_failure();
            let mut roots = RetentionRoots::default();
            if let Some(error) =
                owner::Error::from_host_failure(failure.clone(), FailureStage::Execute)
                    .operation_failure()
            {
                owner::operation_failure_roots(
                    &invocation.binding.task.world,
                    &error.details,
                    &mut roots,
                )?;
            }
            (
                world_protocol::wire::encode(&failure, maximum).map_err(wire_failure)?,
                roots,
                Some(failure),
                None,
            )
        }
    };
    let settled = settled && roots_error.is_none();
    budget
        .charge(
            world_protocol::budget::BudgetDimension::Bytes,
            bytes.len() as u64,
        )
        .map_err(budget_failure)?;
    let request = ctx
        .commit_request(
            stage,
            records::digest(&(invocation, &step.id, &bytes))?,
            &["content", "authorization"],
        )
        .await?;
    request.clone().prepare()?;
    let prepared = Arc::new(ctx.resources.content.prepare_blob(
        &mut std::io::Cursor::new(&bytes),
        None,
        &ctx.cancellation,
    )?);
    let result = match outcome {
        Ok(outcome) => match &outcome.result {
            Ok(SlotResponse::Evaluation(result)) => Ok(result.clone()),
            Ok(_) => Err(HostFailure::Slot(SlotFailure::Evaluation(
                OracleFailure::SchemaMismatch,
            ))),
            Err(error) => Err(error.host_failure()),
        },
        Err(error) => Err(error.host_failure()),
    };
    let custody = Custody {
        invocation: invocation.clone(),
        retained: prepared.reference().clone(),
        roots,
        settled,
        result,
    };
    let retained = custody.clone();
    let content = ctx.resources.content.clone();
    let prepared_for_commit = prepared.clone();
    let current = step.clone();
    let authority = authority.clone();
    let admission = admission.clone();
    let caller = ctx.admission.clone();
    let committed = super::super::super::io::transact(
        &ctx.store,
        &request,
        "retain",
        &custody.retained,
        move |tx| {
            Box::pin(async move {
                let now = tx.now().await?;
                crate::authorization::recheck(tx, &caller, &now).await?;
                owner::require_run_invocation(tx, &caller, &retained.invocation.binding.run_id)
                    .await?;
                authority
                    .recheck_online_oracle(
                        tx,
                        &admission,
                        &retained.invocation.binding,
                        implementation(&retained.invocation)?,
                        &retained.invocation.observed,
                        &now,
                    )
                    .await?;
                let step = owner::read_step(tx, &current.run_id, &current.id)
                    .await?
                    .ok_or(EvaluationFailure::BasisChanged)?;
                if records::encode(&step)? != records::encode(&current)?
                    || step.checkpoint != records::encode(&retained.invocation)?
                    || step.result.is_some()
                    || step.failure.is_some()
                    || step.phase != OperationPhase::Running
                {
                    return Err(EvaluationFailure::BasisChanged.into());
                }
                content
                    .retain_prepared(
                        tx,
                        &prepared_for_commit,
                        ContentOwner::Run {
                            id: retained.invocation.binding.run_id.clone(),
                        },
                    )
                    .await?;
                let mut next = step.clone();
                next.phase = if !settled {
                    OperationPhase::Retained
                } else if failure.is_some() {
                    OperationPhase::Failed
                } else {
                    OperationPhase::Completed
                };
                next.failure = failure
                    .map(|failure| owner::Error::from_host_failure(failure, FailureStage::Verify))
                    .map(|error| {
                        error
                            .operation_failure()
                            .ok_or(EvaluationFailure::InternalFault)
                    })
                    .transpose()?;
                next.result = Some(records::encode(&retained)?);
                owner::checkpoint_step(tx, &step, next).await?;
                Ok(())
            })
        },
    )
    .await;
    let cleanup = ctx
        .resources
        .content
        .discard_prepared(&prepared)
        .map_err(Error::from);
    let retained = super::super::content::preserve(committed.map(|_| ()), cleanup);
    if let Some(error) = roots_error {
        return super::super::content::preserve(Err(error), retained);
    }
    retained?;
    Ok(custody)
}

pub(super) async fn recheck(
    tx: &WorldTransaction<'_>,
    invocation: &Invocation,
    custody: &Custody,
) -> Result<(), Error> {
    let step = owner::read_step(tx, &invocation.binding.run_id, &step_id(invocation)?)
        .await?
        .ok_or(EvaluationFailure::BasisChanged)?;
    if !custody.settled
        || custody.invocation != *invocation
        || step.phase != OperationPhase::Completed
        || step.failure.is_some()
        || step.checkpoint != records::encode(invocation)?
        || step.result != Some(records::encode(custody)?)
    {
        return Err(EvaluationFailure::BasisChanged.into());
    }
    require_content(tx, custody).await
}

pub(crate) async fn online_oracle_retention_roots(
    tx: &WorldTransaction<'_>,
    step: &StepRecord,
    roots: &mut RetentionRoots,
) -> Result<(), owner::Error> {
    if step.kind != KIND {
        return Err(Error::from(EvaluationFailure::BasisChanged).into());
    }
    let invocation: Invocation = records::decode(step.checkpoint.clone())?;
    if invocation.binding.task.world != *tx.world()
        || invocation.binding.run_id != step.run_id
        || step.id != step_id(&invocation)?
        || step.input_digest != records::digest(&invocation)?
    {
        return Err(Error::from(EvaluationFailure::BasisChanged).into());
    }
    roots.releases.push(invocation.binding.release_id.clone());
    roots.resources.extend([
        ResourceRef::Task {
            id: invocation.binding.task.id.clone(),
        },
        ResourceRef::TestCase {
            id: invocation.binding.test.id.clone(),
        },
    ]);
    if crate::evaluation::read_case(tx, &invocation.binding.case_id)
        .await?
        .is_some()
    {
        roots.resources.push(ResourceRef::Case {
            id: invocation.binding.case_id.clone(),
        });
    }
    roots.resources.extend(
        invocation
            .graph
            .nodes
            .iter()
            .map(|node| ResourceRef::Binding {
                id: node.binding_id.clone(),
            }),
    );
    if let Some(body) = &step.result {
        let custody: Custody = records::decode(body.clone())?;
        if custody.invocation != invocation {
            return Err(Error::from(EvaluationFailure::BasisChanged).into());
        }
        require_content(tx, &custody).await?;
        let retained = custody.roots;
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
    }
    if let Some(failure) = &step.failure {
        owner::operation_failure_roots(tx.world(), &failure.details, roots)?;
    }
    Ok(())
}

async fn require_content(tx: &WorldTransaction<'_>, custody: &Custody) -> Result<(), Error> {
    if !crate::content::owner_references(
        tx,
        &ContentOwner::Run {
            id: custody.invocation.binding.run_id.clone(),
        },
    )
    .await?
    .iter()
    .any(|reference| reference.blob == custody.retained)
    {
        return Err(EvaluationFailure::BasisChanged.into());
    }
    Ok(())
}

fn step_id(invocation: &Invocation) -> Result<StepId, Error> {
    identity(&invocation.binding, &invocation.observed)
}

fn identity(binding: &super::OnlineOracleBinding, observed: &Digest) -> Result<StepId, Error> {
    StepId::try_new(format!(
        "online-oracle-{}",
        &records::digest(&(binding, observed))?.as_str()[7..]
    ))
    .map_err(|_| EvaluationFailure::InternalFault.into())
}

pub(super) fn implementation(
    invocation: &Invocation,
) -> Result<&world_protocol::bindings::ImplementationRef, Error> {
    match &invocation.oracle {
        world_protocol::learning::OracleSpec::Program { implementation, .. } => Ok(implementation),
        _ => Err(super::super::changed()),
    }
}
