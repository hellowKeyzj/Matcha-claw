use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use world_protocol::{
    api::PublishRequest,
    budget::BudgetDimension,
    commit::CommitFailure,
    failure::{Failure, FailureStage},
    ids::{Digest, Revision, StepId},
    operation::{OperationFailure, OperationPhase},
    process::{HostFailure, ProcessFailure, TerminalState},
    releases::{BranchRef, WorldBranch},
};

use super::recovery::{Custody, Pending, recover_original};
use crate::{
    compiler::{CheckedCompilation, CompilationError},
    definitions::{KindPlan, KindRegistry, canonical_digest},
    extensions::{invocation::{CompositionOutcome, InvocationContext, InvocationServices}, process::Delivery},
    owner::{
        Error, ExecutionContext, StepRecord, checkpoint_step, checkpoint_usage, claim_step,
        confirmed_usage, read_step,
    },
    releases::{self, PreparedArtifact},
    store::{
        CommitRequest, Committed, RetentionRoots, StoreError, TransactionError, WorldTransaction,
    },
};

const KIND: &str = "release.compiler";
const CLAIM: &str = "release.compiler.claim";
const OBSERVE: &str = "release.compiler.observe";

type CompilationResult = Result<CheckedCompilation, Arc<CompilationError>>;

/// The original process result stays here until its original observation commit is known.
pub(super) struct Compilation {
    claim: CommitRequest,
    checkpoint: Mutex<CompilerCheckpoint>,
    returned: Mutex<Option<Arc<CompilationResult>>>,
    observed: Mutex<Option<CompilerObservation>>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompilerCheckpoint {
    branch: WorldBranch,
    observation: CommitRequest,
    kinds: Vec<KindPlan>,
}

impl Compilation {
    fn checkpoint(&self) -> CompilerCheckpoint {
        self.checkpoint.lock().expect("compiler custody poisoned").clone()
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompilerObservation {
    observation: Option<serde_json::Value>,
    roots: RetentionRoots,
    settled: bool,
    failure: Option<Failure<OperationFailure>>,
}

pub(super) async fn prepare(
    ctx: &ExecutionContext,
    request: &PublishRequest,
    branch: &WorldBranch,
    input: &Digest,
) -> Result<PreparedArtifact, Error> {
    let node = crate::compiler::schema_node(&branch.compile).map_err(compiler_error)?;
    let compiler = crate::compiler::compiler_pass_node(&branch.compile).map_err(compiler_error)?;
    if let Some(pending) = ctx
        .resources
        .releases
        .find(&ctx.operation.operation_id, input)
    {
        let Custody::Compilation(compilation) = &pending.custody else {
            return Err(invalid());
        };
        require_checkpoint(ctx, compilation, branch)?;
        let returned = compilation
            .returned
            .lock()
            .expect("compiler custody poisoned")
            .clone();
        if returned.is_none() {
            match recover_original::<StepRecord>(ctx, &compilation.claim).await {
                Ok(claimed) => {
                    restore_checkpoint(ctx, compilation, &claimed)?;
                    validate_claim(ctx, compilation, &claimed)?;
                }
                Err(error @ TransactionError::NotCommitted { .. }) => {
                    ctx.resources.releases.remove(&pending);
                    return Err(error.into());
                }
                Err(error) => return Err(error.into()),
            }
            let committed = ctx
                .store
                .read_commit(
                    &pending.request.world,
                    &pending.request.commit_id,
                    &pending.request.input_digest,
                )
                .await?;
            return artifact(ctx, request, &pending, compilation, committed).await;
        }
        let committed = match recover_original::<StepRecord>(ctx, &pending.request).await {
            Ok(committed) => committed,
            Err(TransactionError::NotCommitted { .. }) => {
                let commit = ctx
                    .commit_request(OBSERVE, pending.request.input_digest.clone(), &[])
                    .await?;
                if commit.world != pending.request.world
                    || commit.commit_id != pending.request.commit_id
                {
                    return Err(invalid());
                }
                observe(ctx, compilation, commit).await?
            }
            Err(error) => return Err(error.into()),
        };
        return artifact(ctx, request, &pending, compilation, committed).await;
    }
    let digest = canonical_digest(&(input, branch))?;
    let claim = ctx
        .commit_request(CLAIM, digest.clone(), &["packages"])
        .await?;
    let observation = ctx
        .commit_request(
            OBSERVE,
            canonical_digest(&(&claim.commit_id, &digest))?,
            &[],
        )
        .await?;
    let compilation = Arc::new(Compilation {
        claim: claim.clone(),
        checkpoint: Mutex::new(CompilerCheckpoint {
            branch: branch.clone(),
            observation: observation.clone(),
            kinds: Vec::new(),
        }),
        returned: Mutex::new(None),
        observed: Mutex::new(None),
    });
    let pending = ctx.resources.releases.retain(Pending {
        request: observation,
        operation: ctx.operation.operation_id.clone(),
        input: input.clone(),
        publication: Mutex::new(None),
        custody: Custody::Compilation(compilation.clone()),
    });
    let mut claim_checkpoint = compilation.checkpoint();
    let step_id = step_id(ctx)?;
    let claimed = ctx
        .transact_outcome(compilation.claim.clone(), move |tx, admission, _, run| {
            Box::pin(async move {
                let now = tx.now().await?;
                let step = claim_step(tx, &admission, &run, step_id, 0, KIND, digest, &now).await?;
                claim_checkpoint.kinds = KindRegistry::plan(tx, &admission, &claim_checkpoint.branch.compile).await?;
                let mut next = step.clone();
                next.checkpoint = serde_json::to_value(&claim_checkpoint).map_err(codec_error)?;
                checkpoint_step(tx, &step, next).await
            })
        })
        .await;
    let claimed = match claimed {
        Ok(claimed) => claimed,
        Err(error @ TransactionError::NotCommitted { .. }) => {
            ctx.resources.releases.remove(&pending);
            return Err(error.into());
        }
        Err(error) => return Err(error.into()),
    };
    if claimed.replayed {
        // Preserve the original checkpoint's observation request, including its original fences.
        let original = Arc::new(Compilation {
            claim: compilation.claim.clone(),
            checkpoint: Mutex::new(serde_json::from_value(claimed.value.checkpoint.clone())
                .map_err(codec_error)?),
            returned: Mutex::new(None),
            observed: Mutex::new(None),
        });
        require_checkpoint(ctx, &original, branch)?;
        validate_claim(ctx, &original, &claimed)?;
        let pending = ctx.resources.releases.retain(Pending {
            request: original.checkpoint().observation.clone(),
            operation: ctx.operation.operation_id.clone(),
            input: input.clone(),
            publication: Mutex::new(None),
            custody: Custody::Compilation(original.clone()),
        });
        ctx.recheck_replay(&claimed).await?;
        // A durable claim may already have invoked the process. Never dispatch it again.
        let committed = ctx
            .store
            .read_commit(
                &pending.request.world,
                &pending.request.commit_id,
                &pending.request.input_digest,
            )
            .await?;
        return artifact(ctx, request, &pending, &original, committed).await;
    }
    restore_checkpoint(ctx, &compilation, &claimed)?;
    validate_claim(ctx, &compilation, &claimed)?;
    let compile = branch.compile.clone();
    let kinds = compilation.checkpoint().kinds;
    let returned = Arc::new(
        ctx.with_invocation(
            node,
            None,
            Vec::new(),
            move |context, services| async move {
                if let Some(compiler) = compiler {
                    ctx.with_invocation(compiler, None, Vec::new(), move |pass, pass_services| async move {
                        compile_kinds(ctx, &compile, context, services, Some((pass, pass_services)), kinds).await
                    }).await
                } else {
                    compile_kinds(ctx, &compile, context, services, None, kinds).await
                }
            },
        )
        .await
        .map_err(Arc::new),
    );
    *compilation
        .returned
        .lock()
        .expect("compiler custody poisoned") = Some(returned);
    let commit = ctx
        .commit_request(OBSERVE, pending.request.input_digest.clone(), &[])
        .await?;
    if commit.world != pending.request.world || commit.commit_id != pending.request.commit_id {
        return Err(invalid());
    }
    let committed = observe(ctx, &compilation, commit).await?;
    artifact(ctx, request, &pending, &compilation, committed).await
}

struct KindLeases(Vec<Arc<crate::extensions::invocation::InvocationLease>>);
impl Drop for KindLeases {
    fn drop(&mut self) {
        for lease in &self.0 { lease.finish(); }
    }
}

async fn compile_kinds(
    ctx: &ExecutionContext,
    request: &world_protocol::compiler::CompileRequest,
    context: InvocationContext,
    services: InvocationServices,
    compiler: Option<(InvocationContext, InvocationServices)>,
    plans: Vec<KindPlan>,
) -> Result<CheckedCompilation, CompilationError> {
    use crate::extensions::invocation::{CompositionFailure, InvocationFailure};
    let current = |error| CompositionFailure::Invocation(InvocationFailure::Current(error));
    context.check_current().await.map_err(current)?;
    let lock = &request.activation_lock.id;
    let now = context.lease().acquired_at().clone();
    let mut leases = KindLeases(Vec::new());
    let mut kinds = Vec::new();
    for plan in plans {
        let lease = match leases.0.iter().find(|lease| &lease.closure().root == plan.node()) {
            Some(lease) => lease.clone(),
            None => {
                let lease = Arc::new(ctx.resources.live.acquire(&request.world, lock, plan.node(),
                    ctx.admission.invocation().id.clone(), now.clone())
                    .map_err(|error| CompositionFailure::Invocation(InvocationFailure::Lease(error)))?);
                leases.0.push(lease.clone());
                lease
            }
        };
        let kind_context = InvocationContext::new(context.store().clone(), context.admission().clone(),
            lease.clone(), plan.node().clone(), context.pipeline().clone(), context.budget().clone())
            .map_err(current)?;
        let kind_services = ctx.invocation_service_seed().for_lease(&lease, None, Vec::new())
            .map_err(CompositionFailure::Invocation)?;
        kinds.push((plan, kind_context, kind_services));
    }
    crate::compiler::compile_with_passes(request, context, services, compiler, kinds,
        &ctx.resources.releases.cache).await
}

fn restore_checkpoint(
    ctx: &ExecutionContext, compilation: &Compilation, claimed: &Committed<StepRecord>,
) -> Result<(), Error> {
    let original: CompilerCheckpoint = serde_json::from_value(claimed.value.checkpoint.clone())
        .map_err(codec_error)?;
    let mut checkpoint = compilation.checkpoint.lock().expect("compiler custody poisoned");
    if original.branch != checkpoint.branch
        || serde_json::to_value(&original.observation).map_err(codec_error)?
            != serde_json::to_value(&checkpoint.observation).map_err(codec_error)?
        || (!checkpoint.kinds.is_empty() && checkpoint.kinds != original.kinds) {
        return Err(invalid());
    }
    KindRegistry::validate_plans(&original.branch.compile, &original.kinds)?;
    *checkpoint = original;
    drop(checkpoint);
    require_checkpoint(ctx, compilation, &compilation.checkpoint().branch)
}

async fn observe(
    ctx: &ExecutionContext,
    compilation: &Compilation,
    commit: CommitRequest,
) -> Result<Committed<StepRecord>, Error> {
    let returned = compilation
        .returned
        .lock()
        .expect("compiler custody poisoned")
        .clone()
        .ok_or_else(invalid)?;
    let observed = compilation
        .observed
        .lock()
        .expect("compiler custody poisoned")
        .clone();
    let observed = match observed {
        Some(observed) => observed,
        None => {
            let observed =
                observations(ctx, &returned).map_err(|error| preserve_failure(&returned, error))?;
            *compilation
                .observed
                .lock()
                .expect("compiler custody poisoned") = Some(observed.clone());
            observed
        }
    };
    let checkpoint = compilation.checkpoint();
    let id = step_id(ctx)?;
    let digest = compilation.claim.input_digest.clone();
    let usage = ctx.budget.checkpoint_usage();
    let expected = ctx
        .store
        .read_commit::<StepRecord>(
            &compilation.claim.world,
            &compilation.claim.commit_id,
            &compilation.claim.input_digest,
        )
        .await?;
    validate_claim(ctx, compilation, &expected)?;
    let expected = expected.value;
    let observed_value = serde_json::to_value(&observed).map_err(codec_error)?;
    let outcome = ctx
        .transact_outcome(commit, move |tx, _, _, run| {
            Box::pin(async move {
                let step = read_step(tx, &run.id, &id).await?.ok_or_else(invalid)?;
                if step.kind != KIND
                    || step.input_digest != digest
                    || step.revision != expected.revision
                    || step.ordinal != expected.ordinal
                    || step.attempt != expected.attempt
                    || step.writer_epoch != expected.writer_epoch
                    || step.phase != expected.phase
                    || step.result.is_some()
                    || step.failure.is_some()
                    || step.checkpoint != serde_json::to_value(&checkpoint).map_err(codec_error)?
                {
                    return Err(invalid());
                }
                let mut next = step.clone();
                next.phase = if !observed.settled {
                    OperationPhase::Retained
                } else if observed.failure.is_some() {
                    OperationPhase::Failed
                } else {
                    OperationPhase::Completed
                };
                next.result = Some(observed_value);
                next.failure = observed.failure;
                let next = checkpoint_step(tx, &step, next).await?;
                checkpoint_usage(tx, &run, confirmed_usage(&run.usage, usage)?).await?;
                Ok(next)
            })
        })
        .await;
    outcome.map_err(|error| preserve_failure(&returned, error.into()))
}

fn observations(
    ctx: &ExecutionContext,
    returned: &CompilationResult,
) -> Result<CompilerObservation, Error> {
    let outcomes = match returned {
        Ok(compilation) => compilation.outcomes(),
        Err(error) => error.outcomes(),
    };
    let mut roots = RetentionRoots::default();
    for outcome in outcomes {
        let retained = outcome.retained_roots(&ctx.operation.world)?;
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
    let failure = returned
        .as_ref()
        .err()
        .map(|error| retained_failure(ctx, error));
    if let Some(failure) = &failure {
        crate::owner::operation_failure_roots(&ctx.operation.world, &failure.details, &mut roots)?;
    }
    let observation = match returned {
        Ok(compilation) => Some(compilation.observation().clone()),
        Err(error) => error.observation().map_err(codec_error)?,
    };
    let settled = !ctx
        .resources
        .live
        .invocation_unsettled(&ctx.operation.world, &ctx.admission.invocation().id)
        && outcomes.iter().all(processes_settled);
    let observed = CompilerObservation {
        observation,
        roots,
        settled,
        failure,
    };
    let maximum = usize::try_from(
        ctx.budget
            .remaining(BudgetDimension::Bytes)
            .map_err(budget_error)?,
    )
    .unwrap_or(usize::MAX);
    let bytes = world_protocol::wire::encode(&observed, maximum).map_err(|error| {
        if matches!(error, world_protocol::wire::CodecFailure::SizeLimit) {
            budget_error(crate::extensions::invocation::BudgetFailure {
                dimension: BudgetDimension::Bytes,
            })
            .caused(error)
        } else {
            Error::internal(FailureStage::Execute).caused(error)
        }
    })?;
    ctx.budget
        .charge(BudgetDimension::Bytes, bytes.len() as u64)
        .map_err(budget_error)?;
    Ok(observed)
}

async fn artifact(
    ctx: &ExecutionContext,
    request: &PublishRequest,
    pending: &Pending,
    compilation: &Compilation,
    committed: Committed<StepRecord>,
) -> Result<PreparedArtifact, Error> {
    let claimed = ctx
        .store
        .read_commit(
            &compilation.claim.world,
            &compilation.claim.commit_id,
            &compilation.claim.input_digest,
        )
        .await?;
    validate_claim(ctx, compilation, &claimed)?;
    let step = &committed.value;
    if committed.receipt.world != ctx.operation.world
        || committed.receipt.commit_id != compilation.checkpoint().observation.commit_id
        || step.id != claimed.value.id
        || step.run_id != claimed.value.run_id
        || step.kind != claimed.value.kind
        || step.input_digest != claimed.value.input_digest
        || step.ordinal != claimed.value.ordinal
        || step.writer_epoch != claimed.value.writer_epoch
        || step.attempt != claimed.value.attempt
        || step.checkpoint != claimed.value.checkpoint
        || step.revision.0
            != claimed
                .value
                .revision
                .0
                .checked_add(1)
                .ok_or_else(invalid)?
    {
        return Err(invalid());
    }
    let observed: CompilerObservation =
        serde_json::from_value(step.result.clone().ok_or_else(invalid)?).map_err(codec_error)?;
    if !observed.settled {
        return Err(Error::from_host_failure(
            HostFailure::Process(ProcessFailure::Retained),
            FailureStage::Recover,
        ));
    }
    if step.failure != observed.failure {
        return Err(invalid());
    }
    if let Some(failure) = observed.failure {
        if step.phase != OperationPhase::Failed {
            return Err(invalid());
        }
        let returned = compilation
            .returned
            .lock()
            .expect("compiler custody poisoned")
            .clone();
        ctx.resources.releases.remove(pending);
        return Err(match returned.as_deref() {
            Some(Err(error)) => compiler_error(error.clone()),
            _ => Error::from_host_failure(
                HostFailure::Operation(failure.details),
                FailureStage::Execute,
            ),
        });
    }
    if step.phase != OperationPhase::Completed {
        return Err(invalid());
    }
    ctx.recheck_replay(&committed).await?;
    let hot = compilation
        .returned
        .lock()
        .expect("compiler custody poisoned")
        .clone();
    let restored;
    let checked = match &hot {
        Some(hot) => match hot.as_ref() {
            Ok(checked) => {
                if observed.observation.as_ref() != Some(checked.observation()) {
                    return Err(invalid());
                }
                checked
            }
            Err(error) => return Err(compiler_error(error.clone())),
        },
        None => {
            restored = crate::compiler::restore_compilation(
                &compilation.checkpoint().branch.compile,
                observed
                    .observation
                    .as_ref()
                    .ok_or_else(|| indeterminate(&pending.request))?,
                &compilation.checkpoint().kinds,
                &ctx.resources.releases.cache,
            )
            .map_err(compiler_error)?;
            &restored
        }
    };
    let prepared = releases::prepare_artifact_from_compilation(
        &ctx.resources.content,
        &compilation.checkpoint().branch.compile,
        checked,
        request.artifact_id.clone(),
        request.head.next.clone(),
        &ctx.cancellation,
    );
    ctx.resources.releases.remove(pending);
    Ok(prepared?)
}

pub(super) async fn recover(
    ctx: &ExecutionContext,
    request: &PublishRequest,
    input: Digest,
) -> Result<(), Error> {
    let claimed: Option<Committed<StepRecord>> = ctx
        .store
        .read_commit_for_recovery_optional(
            &ctx.authority,
            &ctx.operation.world,
            &ctx.commit_id(CLAIM)?,
        )
        .await?;
    let Some(claimed) = claimed else {
        // Any later dispatch must still win the original unique claim transaction.
        return Ok(());
    };
    let checkpoint: CompilerCheckpoint =
        serde_json::from_value(claimed.value.checkpoint.clone()).map_err(codec_error)?;
    let digest = canonical_digest(&(&input, &checkpoint.branch))?;
    let claim = ctx.commit_request(CLAIM, digest, &["packages"]).await?;
    let compilation = Arc::new(Compilation {
        claim,
        checkpoint: Mutex::new(checkpoint),
        returned: Mutex::new(None),
        observed: Mutex::new(None),
    });
    require_checkpoint(ctx, &compilation, &compilation.checkpoint().branch)?;
    validate_claim(ctx, &compilation, &claimed)?;
    if compilation.checkpoint().branch.change_set_id != request.change_set_id {
        return Err(invalid());
    }
    ctx.resources.releases.retain(Pending {
        request: compilation.checkpoint().observation.clone(),
        operation: ctx.operation.operation_id.clone(),
        input,
        publication: Mutex::new(None),
        custody: Custody::Compilation(compilation),
    });
    Ok(())
}

fn require_checkpoint(
    ctx: &ExecutionContext,
    compilation: &Compilation,
    branch: &WorldBranch,
) -> Result<(), Error> {
    let checkpoint = compilation.checkpoint();
    if checkpoint.branch != *branch
        || branch.world != ctx.operation.world
        || ctx.run.branch_id.as_ref() != Some(&branch.id)
        || ctx.run.activation_lock_id.as_ref() != Some(&branch.compile.activation_lock.id)
        || compilation.claim.world != branch.world
        || compilation.claim.commit_id != ctx.commit_id(CLAIM)?
        || checkpoint.observation.world != branch.world
        || checkpoint.observation.commit_id != ctx.commit_id(OBSERVE)?
        || checkpoint.observation.input_digest
            != canonical_digest(&(
                &compilation.claim.commit_id,
                &compilation.claim.input_digest,
            ))?
    {
        return Err(invalid());
    }
    compilation.checkpoint().observation.prepare()?;
    Ok(())
}

fn validate_claim(
    ctx: &ExecutionContext,
    compilation: &Compilation,
    committed: &Committed<StepRecord>,
) -> Result<(), Error> {
    let checkpoint = compilation.checkpoint();
    KindRegistry::validate_plans(&checkpoint.branch.compile, &checkpoint.kinds)?;
    let step = &committed.value;
    if committed.receipt.world != ctx.operation.world
        || committed.receipt.commit_id != compilation.claim.commit_id
        || step.id != step_id(ctx)?
        || step.run_id != ctx.run.id
        || step.kind != KIND
        || step.input_digest != compilation.claim.input_digest
        || step.ordinal != 0
        || step.attempt != 0
        || step.revision != Revision(2)
        || step.phase != OperationPhase::Running
        || step.result.is_some()
        || step.failure.is_some()
        || step.checkpoint != serde_json::to_value(compilation.checkpoint()).map_err(codec_error)?
    {
        return Err(invalid());
    }
    Ok(())
}

pub(crate) async fn step_retention_roots(
    tx: &WorldTransaction<'_>,
    step: &StepRecord,
    roots: &mut RetentionRoots,
) -> Result<(), Error> {
    if step.kind != KIND || step.ordinal != 0 || step.attempt != 0 {
        return Err(invalid());
    }
    let checkpoint: CompilerCheckpoint =
        serde_json::from_value(step.checkpoint.clone()).map_err(codec_error)?;
    let run = crate::owner::read_run(tx, &step.run_id).await?;
    let operation = crate::owner::read_operation_record(tx, &run.operation.operation_id).await?;
    let input = canonical_digest(operation.input.command()?)?;
    if checkpoint.branch.world != *tx.world()
        || checkpoint.observation.world != *tx.world()
        || step.input_digest != canonical_digest(&(&input, &checkpoint.branch))?
    {
        return Err(invalid());
    }
    let reference = BranchRef {
        world: checkpoint.branch.world.clone(),
        id: checkpoint.branch.id.clone(),
        revision: checkpoint.branch.revision,
    };
    if releases::read_branch_revision(tx, &reference)
        .await?
        .as_ref()
        != Some(&checkpoint.branch)
    {
        return Err(invalid());
    }
    KindRegistry::validate_plans(&checkpoint.branch.compile, &checkpoint.kinds)?;
    for plan in &checkpoint.kinds {
        if let Some(previous) = plan.previous() {
            roots.definitions.push(previous.reference.clone());
        }
    }
    roots.branches.push(reference);
    // The immutable branch carrier owns its complete model/basis, not a fabricated global archive.
    if let Some(value) = &step.result {
        let observed: CompilerObservation =
            serde_json::from_value(value.clone()).map_err(codec_error)?;
        let retained = observed.roots;
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
    Ok(())
}

fn processes_settled(outcome: &CompositionOutcome) -> bool {
    outcome.nodes.iter().all(|node| {
        node.process.as_ref().is_none_or(|process| {
            process.cleanup.is_none()
                && (process.delivery == Delivery::NotDispatched
                    || process
                        .outcome
                        .as_ref()
                        .is_some_and(|outcome| outcome.terminal != TerminalState::Retained))
        })
    })
}
fn retained_failure(ctx: &ExecutionContext, error: &CompilationError) -> Failure<OperationFailure> {
    let mut failure = Error::from_host_failure(error.host_failure(), FailureStage::Execute)
        .operation_failure()
        .expect("compiler operation failure");
    failure.operation_id = Some(ctx.operation.operation_id.clone());
    failure.run_id = Some(ctx.run.id.clone());
    failure.step_id = step_id(ctx).ok();
    failure
}
fn preserve_failure(returned: &CompilationResult, error: Error) -> Error {
    match returned {
        Ok(_) => error,
        Err(failure) => compiler_error(failure.clone()).with_related(error),
    }
}
fn compiler_error(error: impl Into<Arc<CompilationError>>) -> Error {
    let error = error.into();
    Error::from_host_failure(error.host_failure(), FailureStage::Execute).caused(error)
}
fn budget_error(error: crate::extensions::invocation::BudgetFailure) -> Error {
    Error::from_host_failure(
        HostFailure::BudgetExceeded {
            dimension: error.dimension,
        },
        FailureStage::Execute,
    )
}
fn codec_error(error: serde_json::Error) -> Error {
    Error::internal(FailureStage::Recover).caused(error)
}
fn step_id(ctx: &ExecutionContext) -> Result<StepId, Error> {
    StepId::try_new(format!("compiler-{}", &ctx.commit_id(CLAIM)?.as_str()[6..]))
        .map_err(|error| invalid().caused(error))
}
fn indeterminate(request: &CommitRequest) -> Error {
    StoreError::new(
        CommitFailure::CommitIndeterminate {
            commit_id: request.commit_id.clone(),
        },
        FailureStage::Recover,
    )
    .into()
}
fn invalid() -> Error {
    Error::internal(FailureStage::Recover)
}
