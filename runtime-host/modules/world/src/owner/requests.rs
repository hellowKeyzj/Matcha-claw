use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;
use world_protocol::{
    api::{ApiFailure, CommandEnvelope, CommandResult, PeerOperation, PeerRequest, PeerResponse, QueryEnvelope, QueryResult, WorldCommand, WorldQuery, WorldStatus},
    authorization::{AccessMode, AccessScope, ActualImpact, AuthorizationFailure, PolicyRef},
    budget::Budget,
    failure::{FailureStage, Recovery},
    ids::*,
    operation::{CancelOperation, CancelReceipt, OperationAccepted, OperationRequest, OperationResponse},
    time::Timestamp,
};

use crate::{
    authorization::{self, Admission, AdmissionCommit, NativeProof, RequestBinding, VerifiedInvocation},
    definitions::canonical_digest,
    extensions::invocation::CallBudget,
    store::{CommitRequest, StoreFuture, WorldStore, WorldTransaction},
};
use super::{Shared, WorldHandle, readable_for, ready_for, ready_for_maintenance, ready_for_operation, resources};
use super::super::{Error, ExecutionContext, RunRecord, RunSpec, head, ledger, operation::{self, SignedRequest}, queries, resources::Resources, run, uploads, workflows};

enum Authentication {
    Service(SignedRequest),
    Native { proof: NativeProof, binding: RequestBinding },
}

#[derive(Serialize, Deserialize)]
struct Accepted {
    operation: OperationAccepted,
    run: RunRecord,
    input: CommandEnvelope,
    now: Timestamp,
    execute: bool,
}

pub(super) use super::super::ledger::operation_id;

pub(super) async fn command(shared: Arc<Shared>, signed: SignedRequest, input: CommandEnvelope, target: WorldHandle) -> Result<CommandResult, Error> {
    if signed.binding.world() != &input.world { return Err(AuthorizationFailure::RequestDigestMismatch.into()); }
    let (store, maintenance) = command_store(&shared, &input.world, &input.command).await?;
    let resources = resources(&shared, &store, &input.world)?;
    if matches!(&input.command, WorldCommand::BeginUpload(_) | WorldCommand::UploadChunk(_) | WorldCommand::SealUpload(_) | WorldCommand::AbortUpload(_)) {
        return uploads::run(store, resources, shared.ingress.clone(), signed, input, maintenance).await;
    }
    submit(shared, store, resources, Authentication::Service(signed), input, target).await.map(|(result, _)| result)
}

fn package_maintenance(command: &WorldCommand) -> bool {
    matches!(command, WorldCommand::UpgradePackage(_) | WorldCommand::GrantPackage(_)
        | WorldCommand::ConfigurePackage(_) | WorldCommand::EnablePackage(_)
        | WorldCommand::ReplacePackageTrustPolicy(_) | WorldCommand::Activate(_)
        | WorldCommand::BeginUpload(_) | WorldCommand::UploadChunk(_)
        | WorldCommand::SealUpload(_) | WorldCommand::AbortUpload(_))
}

async fn command_store(shared: &Shared, world: &WorldRef, command: &WorldCommand) -> Result<(WorldStore, bool), Error> {
    if package_maintenance(command) { ready_for_maintenance(shared, world).await }
    else { ready_for(shared, world).await.map(|store| (store, false)) }
}

fn package_metadata(query: &WorldQuery) -> bool {
    matches!(query, WorldQuery::Discover(_) | WorldQuery::Packages(_) | WorldQuery::PackageTrustPolicy(_)
        | WorldQuery::PackageConfig(_) | WorldQuery::Contributions(_) | WorldQuery::Bindings(_)
        | WorldQuery::BindingHead(_) | WorldQuery::ActivationPlan(_) | WorldQuery::UploadStatus(_))
}

async fn authenticate(shared: &Shared, tx: &WorldTransaction<'_>, authentication: Authentication, impact: &ActualImpact, now: &Timestamp) -> Result<VerifiedInvocation, Error> {
    Ok(match authentication {
        Authentication::Service(signed) => shared.ingress.authenticate(tx, &signed.token, signed.binding, now).await?,
        Authentication::Native { proof, binding } => {
            let investigation = investigation_binding(shared, &proof, binding.world())?;
            shared.native.authenticate(tx, &proof, binding, impact, investigation, now).await?
        },
    })
}

fn investigation_binding(shared: &Shared, proof: &NativeProof, world: &WorldRef) -> Result<Option<Arc<authorization::InvestigationBinding>>, Error> {
    proof.facts().world_investigation.as_ref().map(|facts| {
        shared.tasks.investigation_for_binding(world, &facts.binding_id)
            .ok_or_else(|| AuthorizationFailure::InvalidDelegation.into())
    }).transpose()
}

async fn submit(shared: Arc<Shared>, store: WorldStore, resources: Arc<Resources>, authentication: Authentication, input: CommandEnvelope, target: WorldHandle) -> Result<(CommandResult, OperationAccepted), Error> {
    let binding = match &authentication { Authentication::Service(signed) => &signed.binding, Authentication::Native { binding, .. } => binding };
    let batch = admission_batch(&store, binding).await?;
    let id = operation_id(&input.world, &input.request_id, input.command.operation_name());
    let current = shared.clone();
    let owned_resources = resources.clone();
    let accepted = authorization::commit_admission(&store, batch, move |tx| Box::pin(async move {
        let now = tx.now().await?;
        // Service authentication precedes resource lookup; native mapping needs the exact impact.
        let (verified, authentication) = match authentication {
            Authentication::Service(signed) => (Some(current.ingress.authenticate(tx, &signed.token, signed.binding, &now).await?), None),
            native => (None, Some(native)),
        };
        let PreparedCommand { verified, mut spec, impact, preflight_budget, recovering } =
            prepare_command(tx, &current, &owned_resources, &input, &id, verified, authentication, &now).await?;
        let verified = if let Some(branch) = &spec.branch_id { verified.bind_branch(tx, branch).await? } else { verified };
        if spec.branch_id.is_none() { spec.branch_id = verified.invocation().branch_id.clone(); }
        let policies = command_policies(tx, &input.command).await?;
        let admission = if recovering {
            authorization::read_recovery_admit(tx, &verified, &impact, &policies, &now).await?
        } else {
            let approval = workflows::actions::approval(tx, &input.command).await?;
            authorization::admit(tx, &verified, &impact, &policies, approval.as_ref(), &now).await?
        };
        let head = head::read(tx).await?;
        if head.status != WorldStatus::Ready { return Err(conflict()); }
        let operation = ledger::accept(tx, &admission, &ledger::OperationInput::Command(input.clone()), id, head.generation, &now).await?;
        operation.identity.require_resume(&verified)?;
        if let Some(run_id) = &operation.receipt.progress.run_id {
            let run = run::read_run(tx, run_id).await?;
            operation::authorize_receipt(tx, &verified, &operation, &now).await?;
            return Ok((Accepted { operation: operation.receipt.accepted, run, input: operation.input.command_envelope()?.clone(), now, execute: false }, admission));
        }
        let mut run = run::start(tx, &admission, &operation.receipt.accepted, spec, &now).await?;
        let now = if let Some(budget) = preflight_budget {
            budget.check().map_err(|failure| budget_error(failure.dimension))?;
            run = run::checkpoint_usage(tx, &run, budget.checkpoint_usage()).await?;
            tx.now().await?
        } else { now };
        Ok::<_, Error>((Accepted { operation: run.operation.clone(), run, input, now, execute: true }, admission))
    })).await?;
    let (accepted, admission) = match accepted {
        AdmissionCommit::Committed { outcome, admission } => (outcome.value, admission),
        AdmissionCommit::Replayed(_) => return Err(AuthorizationFailure::Replay.into()),
    };
    let receipt = accepted.operation.clone();
    if !accepted.execute { return Ok((CommandResult::Accepted(receipt.clone()), receipt)); }
    launch(shared, store, resources, admission, accepted, target, false).await.map(|result| (result, receipt))
}

struct PreparedCommand {
    verified: VerifiedInvocation,
    spec: RunSpec,
    impact: ActualImpact,
    preflight_budget: Option<CallBudget>,
    recovering: bool,
}

fn prepare_command<'a>(
    tx: &'a WorldTransaction<'_>, shared: &'a Shared, resources: &'a Resources, input: &'a CommandEnvelope,
    id: &'a OperationId, verified: Option<VerifiedInvocation>, authentication: Option<Authentication>, now: &'a Timestamp,
) -> StoreFuture<'a, PreparedCommand, Error> {
    match &input.command {
        WorldCommand::ActionSubmit(request) => Box::pin(async move {
            let actor = match (&verified, &authentication) {
                (Some(verified), _) => verified.invocation().actor.clone(),
                (_, Some(Authentication::Native { proof, binding })) => shared.native.current_actor(tx, proof, binding, now).await?,
                _ => return Err(Error::internal(FailureStage::Admission)),
            };
            if let Some((intent, impact)) = crate::actions::lookup_intent_recovery(tx, &actor, request).await? {
                let verified = match verified { Some(verified) => verified, None => authenticate(shared, tx, authentication.expect("native authentication"), &impact, now).await? };
                let command = WorldCommand::ActionReconcile(world_protocol::operation::OperationKey { world: input.world.clone(), operation_id: intent.operation_id });
                let spec = run_spec(tx, resources, &command, id, &verified.invocation().deadline).await?;
                Ok(PreparedCommand { verified, spec, impact, preflight_budget: None, recovering: true })
            } else {
                prepare_regular_command(tx, shared, resources, input, id, verified, authentication, now).await
            }
        }),
        WorldCommand::EvaluateRule(request) => Box::pin(async move {
            let verified = verified.ok_or_else(|| Error::new("world.rule_service_only", FailureStage::Admission,
                "规则求值仅支持已认证的服务命令入口。", ApiFailure::UnsupportedOperation, Recovery::None))?;
            let verified = if let Some(branch) = &request.branch {
                if branch.world != *tx.world() || request.rule.world != *tx.world() { return Err(AuthorizationFailure::InvalidDelegation.into()); }
                let current = crate::releases::read_branch(tx, &branch.id).await?;
                if current.as_ref().map(|current| current.revision) != Some(branch.revision) {
                    return Err(crate::query::QueryError::from(world_protocol::query::QueryFailure::BasisChanged).into());
                }
                verified.bind_branch(tx, &branch.id).await?
            } else { verified };
            let mut spec = run_spec(tx, resources, &input.command, id, &verified.invocation().deadline).await?;
            let budget = CallBudget::new(spec.budget.clone(), now).map_err(|failure| budget_error(failure.dimension))?;
            let (impact, plan, lock) = workflows::facts::preflight_rule(tx, &verified, request, &budget, &shared.cancellation).await?;
            spec.activation_lock_id = Some(lock);
            spec.branch_id = plan.branch.as_ref().map(|branch| branch.id.clone());
            spec.basis = serde_json::to_value(workflows::facts::RuleRunBasis { command: input.command.clone(), rule_plan: plan })
                .map_err(|cause| Error::internal(FailureStage::Prepare).caused(cause))?;
            Ok(PreparedCommand { verified, spec, impact, preflight_budget: Some(budget), recovering: false })
        }),
        _ => prepare_regular_command(tx, shared, resources, input, id, verified, authentication, now),
    }
}

fn prepare_regular_command<'a>(
    tx: &'a WorldTransaction<'_>, shared: &'a Shared, resources: &'a Resources, input: &'a CommandEnvelope,
    id: &'a OperationId, verified: Option<VerifiedInvocation>, authentication: Option<Authentication>, now: &'a Timestamp,
) -> StoreFuture<'a, PreparedCommand, Error> {
    Box::pin(async move {
        let impact = command_impact(tx, &input.command, id).await?;
        let verified = match verified { Some(verified) => verified, None => authenticate(shared, tx, authentication.expect("native authentication"), &impact, now).await? };
        let spec = run_spec(tx, resources, &input.command, id, &verified.invocation().deadline).await?;
        Ok(PreparedCommand { verified, spec, impact, preflight_budget: None, recovering: false })
    })
}

async fn launch(shared: Arc<Shared>, store: WorldStore, resources: Arc<Resources>, admission: Admission, accepted: Accepted, target: WorldHandle, resuming: bool) -> Result<CommandResult, Error> {
    let key = (accepted.operation.world.clone(), accepted.operation.operation_id.clone());
    let retained = resources.tasks.investigation_binding(&accepted.operation.world, &accepted.run.id);
    let cancel = retained.as_ref().map(|binding| binding.cancellation().clone())
        .or_else(|| admission.investigation_cancellation().map(CancellationToken::child_token))
        .unwrap_or_else(|| shared.cancellation.child_token());
    {
        let mut executing = shared.executing.lock().expect("world executions poisoned");
        if executing.contains_key(&key) { return Ok(CommandResult::Accepted(accepted.operation)); }
        executing.insert(key.clone(), cancel.clone());
    }
    let budget = async {
        match retained {
            Some(binding) => Ok(binding.budget().clone()),
            None => match admission.investigation_budget() {
                Some(parent) => {
                    super::super::execution::execution_commit_id(&accepted.operation.world, &accepted.operation.operation_id, &accepted.run.id, "native.child.budget")
                        .and_then(|commit| parent.run_scoped(&commit, &accepted.run.budget, &accepted.run.usage, &accepted.now).map_err(reservation_error))
                },
                None => match CallBudget::resume(accepted.run.budget.clone(), accepted.run.usage.clone(), &accepted.now) {
                    Ok(budget) => Ok(budget),
                    Err(failure) => {
                        if resuming && matches!(failure.dimension, world_protocol::budget::BudgetDimension::WallTime | world_protocol::budget::BudgetDimension::Deadline) {
                            if let WorldCommand::ResolveTask(request) = &accepted.input.command {
                                if crate::learning::investigation::has_unsettled_execution(&store, &accepted.operation.world, &accepted.run.id, request).await? {
                                    return CallBudget::resume_for_settlement(accepted.run.budget.clone(), accepted.run.usage.clone(), &accepted.now)
                                        .map_err(|failure| budget_error(failure.dimension));
                                }
                            }
                        }
                        Err(budget_error(failure.dimension))
                    },
                },
            },
        }
    }.await;
    let budget = match budget {
        Ok(budget) => budget,
        Err(error) => {
            let error = if resuming {
                match super::super::settlement::FailedWorkSettlement::resume_rejected(
                    &store, &resources, &shared.authority, &admission, &accepted.operation, &accepted.run, &error,
                ).await {
                    Ok(receipt) => receipt.failure.map(Error::from).unwrap_or(error),
                    Err(settlement) => settlement.with_related(error),
                }
            } else { error };
            shared.executing.lock().expect("world executions poisoned").remove(&key);
            return Err(error);
        }
    };
    let pipeline = foundation::pipeline::PipelineContext::silent_in_memory(accepted.run.id.as_str());
    let ctx = ExecutionContext {
        store, resources: resources.clone(), admission, authority: shared.authority.clone(), operation: accepted.operation.clone(), run: accepted.run,
        cancellation: cancel, deadline: budget.deadline(), pipeline, budget,
        source_access: shared.source_access.clone(), locator: shared.locator.as_ref().map_err(Clone::clone)?.clone(), owner: target.clone(), target: Arc::new(target),
    };
    let short = matches!(&accepted.input.command, WorldCommand::ActionPropose(_) | WorldCommand::ActionApprove(_) | WorldCommand::ProposeChange(_) | WorldCommand::ProposeAbstraction(_) | WorldCommand::ValidateChange(_) | WorldCommand::RebaseChange(_) | WorldCommand::RecordTask(_) | WorldCommand::RecordTestCase(_) | WorldCommand::FreezeSuite(_) | WorldCommand::ConfigurePolicy(_) | WorldCommand::ConfigureRetention(_));
    let result = accepted.operation;
    let worker = resources.tasks.spawn_run(&ctx, {
        let ctx = ctx.clone();
        let shared = shared.clone();
        let key = key.clone();
        async move {
        let outcome = dispatch(ctx.clone(), accepted.input.command).await;
        if let Err(error) = &outcome {
            if let Err(settlement) = ctx.fail(error).await {
                shared.initialization_diagnostics.lock().expect("world diagnostics poisoned").push(error.clone().with_related(settlement));
            }
        }
        if let Err(cleanup) = super::super::recovery::cleanup_committed(&ctx.store, &ctx.resources, &ctx.authority,
            &ctx.operation.world, &ctx.operation.operation_id).await {
            shared.initialization_diagnostics.lock().expect("world diagnostics poisoned").push(cleanup);
        }
        shared.executing.lock().expect("world executions poisoned").remove(&key);
        outcome
        }
    });
    let worker = match worker {
        Ok(worker) => worker,
        Err(error) => {
            shared.executing.lock().expect("world executions poisoned").remove(&key);
            return Err(error);
        },
    };
    if short { worker.await.map_err(|cause| Error::internal(FailureStage::Execute).caused(cause))? }
    else { drop(worker); Ok(CommandResult::Accepted(result)) }
}

fn dispatch(ctx: ExecutionContext, command: WorldCommand) -> StoreFuture<'static, CommandResult, Error> {
    match command {
        command @ (WorldCommand::ImportMaterials(_) | WorldCommand::ProposeMaterialDraft(_)) => workflows::materials::command(ctx, command),
        command @ (WorldCommand::ConfigureConnection(_) | WorldCommand::DiscoverSchema(_) | WorldCommand::SetMapping(_) | WorldCommand::SetBranchMapping(_) | WorldCommand::ApproveBranchSourceAuthority(_) | WorldCommand::StartSync(_) | WorldCommand::StopSync(_)) => workflows::sources::run(ctx, command),
        command @ (WorldCommand::Observe(_) | WorldCommand::EvaluateRule(_) | WorldCommand::Reconcile(_)) => workflows::facts::run(ctx, command),
        command @ (WorldCommand::RecordTask(_) | WorldCommand::ResolveTask(_) | WorldCommand::ProposeChange(_) | WorldCommand::ProposeAbstraction(_) | WorldCommand::ValidateChange(_) | WorldCommand::RebaseChange(_)) => workflows::learning::run(ctx, command),
        command @ (WorldCommand::TestBranch(_) | WorldCommand::RecordTestCase(_) | WorldCommand::FreezeSuite(_)) => workflows::evaluation::run(ctx, command),
        command @ (WorldCommand::Publish(_) | WorldCommand::Rollback(_)) => workflows::releases::run(ctx, command),
        command @ (WorldCommand::ActionPropose(_) | WorldCommand::ActionApprove(_) | WorldCommand::ActionSubmit(_) | WorldCommand::ActionReconcile(_) | WorldCommand::ActionCompensate(_)) => workflows::actions::run(ctx, command),
        command @ (WorldCommand::InstallPackage(_) | WorldCommand::GrantPackage(_) | WorldCommand::ReplacePackageTrustPolicy(_) | WorldCommand::ConfigurePackage(_) | WorldCommand::EnablePackage(_) | WorldCommand::DisablePackage(_) | WorldCommand::UpgradePackage(_) | WorldCommand::UninstallPackage(_)) => workflows::packages::run(ctx, command),
        WorldCommand::Activate(request) => workflows::activation::run(ctx, request),
        WorldCommand::MigratePackage(request) => workflows::activation::migrate(ctx, request),
        command @ (WorldCommand::Backup(_) | WorldCommand::Restore(_) | WorldCommand::DeleteWorld(_)) => ctx.resources.archive.clone().run(ctx, command),
        command @ (WorldCommand::ConfigurePolicy(_) | WorldCommand::ConfigureRetention(_)) => Box::pin(async move {
            let input = canonical_digest(&command)?;
            let committed = ctx.transact("authorization.configure", input, &["authorization"], move |tx, admission, operation, _| Box::pin(async move {
                let now = tx.now().await?;
                let result = match command {
                    WorldCommand::ConfigurePolicy(request) => {
                        authorization::configure_policy(tx, &admission, &request, &now).await?;
                        world_protocol::operation::OperationResult::Policy { scope: request.scope, policy_id: request.rule.reference.policy_id, revision: request.rule.reference.revision }
                    },
                    WorldCommand::ConfigureRetention(request) => {
                        authorization::configure_retention(tx, &admission, &request, &now).await?;
                        world_protocol::operation::OperationResult::Retention { scope: request.scope, policy_id: request.policy.policy_id, revision: request.policy.revision }
                    },
                    _ => unreachable!(),
                };
                authorization::check_admitted_output(tx, &admission, admission.impact(), 1, &now).await?;
                ledger::complete(tx, &operation.receipt.accepted, result, &now).await?;
                Ok::<_, Error>(())
            })).await?;
            Ok(CommandResult::Commit(committed.receipt))
        }),
        _ => Box::pin(async move { Err(Error::internal(FailureStage::Decode)) }),
    }
}

fn command_impact<'a>(tx: &'a WorldTransaction<'_>, command: &'a WorldCommand, id: &'a OperationId) -> StoreFuture<'a, ActualImpact, Error> {
    match command {
        WorldCommand::ImportMaterials(request) => Box::pin(async move { workflows::materials::impact(tx, request).await }),
        WorldCommand::ProposeMaterialDraft(request) => Box::pin(async move { workflows::materials::propose_impact(tx, request).await }),
        WorldCommand::ConfigureConnection(_) | WorldCommand::DiscoverSchema(_) | WorldCommand::SetMapping(_) | WorldCommand::SetBranchMapping(_) | WorldCommand::ApproveBranchSourceAuthority(_) | WorldCommand::StartSync(_) | WorldCommand::StopSync(_) => Box::pin(async move { workflows::sources::impact(tx, command).await }),
        WorldCommand::Observe(_) | WorldCommand::Reconcile(_) => Box::pin(async move { workflows::facts::impact(tx, command).await }),
        WorldCommand::RecordTask(_) | WorldCommand::ResolveTask(_) | WorldCommand::ProposeChange(_) | WorldCommand::ProposeAbstraction(_) | WorldCommand::ValidateChange(_) | WorldCommand::RebaseChange(_) => workflows::learning::impact(tx, command),
        WorldCommand::TestBranch(_) | WorldCommand::RecordTestCase(_) | WorldCommand::FreezeSuite(_) => Box::pin(async move { workflows::evaluation::impact(tx, command, id).await }),
        WorldCommand::Publish(_) | WorldCommand::Rollback(_) => Box::pin(async move { workflows::releases::impact(tx, command).await }),
        WorldCommand::ActionPropose(_) | WorldCommand::ActionApprove(_) | WorldCommand::ActionSubmit(_) | WorldCommand::ActionReconcile(_) | WorldCommand::ActionCompensate(_) => Box::pin(async move { workflows::actions::impact(tx, command).await }),
        WorldCommand::InstallPackage(_) | WorldCommand::GrantPackage(_) | WorldCommand::ReplacePackageTrustPolicy(_) | WorldCommand::ConfigurePackage(_) | WorldCommand::EnablePackage(_) | WorldCommand::DisablePackage(_) | WorldCommand::UpgradePackage(_) | WorldCommand::UninstallPackage(_) => Box::pin(async move { workflows::packages::impact(tx, command).await }),
        WorldCommand::Activate(request) => Box::pin(async move { workflows::activation::impact(tx, request).await }),
        WorldCommand::MigratePackage(request) => Box::pin(async move { workflows::activation::migration_impact(tx, request).await }),
        WorldCommand::Backup(_) | WorldCommand::Restore(_) | WorldCommand::DeleteWorld(_) => Box::pin(async move { workflows::archive::impact(tx, command).await }),
        WorldCommand::ConfigurePolicy(request) => Box::pin(async move { manage_impact(&request.scope) }),
        WorldCommand::ConfigureRetention(request) => Box::pin(async move { manage_impact(&request.scope) }),
        _ => Box::pin(async move { Err(Error::internal(FailureStage::Decode)) }),
    }
}

fn manage_impact(scope: &ScopeId) -> Result<ActualImpact, Error> {
    Ok(authorization::actual_impact(vec![AccessScope { resources: Vec::new(), fields: Vec::new(), modes: vec![AccessMode::Manage], scope: scope.clone(), valid_time: None }], Vec::new(), Vec::new(), Vec::new(), Vec::new())?)
}

async fn command_policies(tx: &WorldTransaction<'_>, command: &WorldCommand) -> Result<Vec<PolicyRef>, Error> {
    match command {
        WorldCommand::ActionPropose(_) | WorldCommand::ActionApprove(_) | WorldCommand::ActionSubmit(_) | WorldCommand::ActionReconcile(_) | WorldCommand::ActionCompensate(_) => workflows::actions::policies(tx, command).await,
        _ => Ok(Vec::new()),
    }
}

async fn run_spec(tx: &WorldTransaction<'_>, resources: &Resources, command: &WorldCommand, operation: &OperationId, deadline: &Timestamp) -> Result<RunSpec, Error> {
    let mut budget = queries::objects::query_budget(deadline.clone());
    budget.max_wall_time.0 = u64::try_from(resources.preparation.execution_policy().host_io_timeout.as_millis()).unwrap_or(u64::MAX);
    let (release_id, activation_lock_id, branch_id, mut budget) = command_run_basis(tx, command, budget).await?;
    budget.deadline = Some(budget.deadline.as_ref().map_or_else(|| deadline.clone(), |old| old.min(deadline).clone()));
    CallBudget::new(budget.clone(), &tx.now().await?).map_err(|failure| Error::from_host_failure(world_protocol::process::HostFailure::BudgetExceeded { dimension: failure.dimension }, FailureStage::Admission))?;
    let digest = canonical_digest(&("world.run.v1", tx.world(), operation))?;
    Ok(RunSpec { id: RunId::try_new(format!("run-{}", &digest.as_str()[7..])).expect("digest identifier"), release_id, activation_lock_id, branch_id, budget, basis: serde_json::to_value(command).map_err(|cause| Error::internal(FailureStage::Prepare).caused(cause))? })
}

type RunBasis = (Option<ReleaseId>, Option<ActivationLockId>, Option<BranchId>, Budget);

fn command_run_basis<'a>(tx: &'a WorldTransaction<'_>, command: &'a WorldCommand, budget: Budget) -> StoreFuture<'a, RunBasis, Error> {
    match command {
        WorldCommand::ImportMaterials(request) => Box::pin(async move {
            let budget = request.budget.clone();
            let release = crate::releases::read_active_head(tx).await?.ok_or_else(conflict)?.release_id;
            let basis = crate::releases::read_compile_context(tx, &release).await?;
            let lock = request.compile.as_ref().map_or(basis.activation_lock.id, |selection| selection.activation_lock_id.clone());
            Ok((Some(release), Some(lock), None, budget))
        }),
        WorldCommand::ProposeMaterialDraft(request) => Box::pin(async move {
            let (release, limits) = workflows::materials::read_draft_basis(tx, &request.draft).await?;
            Ok((Some(release), Some(request.compile.activation_lock_id.clone()), None, limits))
        }),
        WorldCommand::DiscoverSchema(request) if request.branch.is_some() => Box::pin(async move {
            let (release, lock, branch) = workflows::sources::branch_run_basis(tx, request.branch.as_ref().expect("branch discovery")).await?;
            Ok((Some(release), Some(lock), Some(branch), budget))
        }),
        WorldCommand::SetBranchMapping(request) => Box::pin(async move {
            let (release, lock, branch) = workflows::sources::branch_run_basis(tx, &request.branch).await?;
            Ok((Some(release), Some(lock), Some(branch), budget))
        }),
        WorldCommand::ApproveBranchSourceAuthority(request) => Box::pin(async move {
            let (release, lock, branch) = workflows::sources::branch_run_basis(tx, &request.branch).await?;
            Ok((Some(release), Some(lock), Some(branch), budget))
        }),
        WorldCommand::DiscoverSchema(_) | WorldCommand::StartSync(_) => Box::pin(async move {
            let (release, lock) = workflows::sources::run_basis(tx, command).await?;
            Ok((Some(release), Some(lock), None, budget))
        }),
        WorldCommand::StopSync(request) => Box::pin(async move {
            let (release, lock) = workflows::sources::stop_run_basis(tx, request).await?;
            Ok((release, lock, None, budget))
        }),
        WorldCommand::Reconcile(request) => Box::pin(async move {
            let reference = request.bindings.first().ok_or_else(conflict)?.clone();
            let command = WorldCommand::StartSync(world_protocol::api::BindingCommand { expected_revision: reference.revision, binding: reference });
            let (release, lock) = workflows::sources::run_basis(tx, &command).await?;
            Ok((Some(release), Some(lock), None, budget))
        }),
        WorldCommand::EvaluateRule(request) => Box::pin(async move { Ok((Some(request.release_id.clone()), None, None, budget)) }),
        WorldCommand::RecordTask(_) | WorldCommand::ResolveTask(_) | WorldCommand::ProposeChange(_) | WorldCommand::ProposeAbstraction(_) | WorldCommand::ValidateChange(_) | WorldCommand::RebaseChange(_) => workflows::learning::run_basis(tx, command),
        WorldCommand::TestBranch(_) | WorldCommand::RecordTestCase(_) | WorldCommand::FreezeSuite(_) => Box::pin(async move {
            workflows::evaluation::run_basis(tx, command).await
        }),
        WorldCommand::Publish(_) | WorldCommand::Rollback(_) => Box::pin(async move {
            let (release, lock, branch, limits) = workflows::releases::run_basis(tx, command).await?;
            Ok((Some(release), Some(lock), branch, limits.unwrap_or(budget)))
        }),
        WorldCommand::ActionPropose(_) | WorldCommand::ActionApprove(_) | WorldCommand::ActionSubmit(_) | WorldCommand::ActionReconcile(_) | WorldCommand::ActionCompensate(_) => Box::pin(async move {
            let (release, lock, limits) = workflows::actions::run_basis(tx, command).await?;
            Ok((Some(release), Some(lock), workflows::actions::run_branch(tx, command).await?, limits))
        }),
        _ => Box::pin(async move { Ok((None, None, None, budget)) }),
    }
}

async fn admission_batch(store: &WorldStore, binding: &RequestBinding) -> Result<crate::store::PreparedBatch, Error> {
    let (storage_epoch, fences) = store.snapshot(binding.world().clone(), |snapshot| Box::pin(head::writer_fences(snapshot, &["authorization", "operation", "packages"]))).await?;
    Ok(CommitRequest { world: binding.world().clone(), commit_id: CommitId::try_new(uuid::Uuid::new_v4().to_string()).expect("UUID identifier"), input_digest: binding.request_digest().clone(), storage_epoch, fences, watch_basis: Vec::new() }.prepare()?)
}

pub(super) fn query(shared: Arc<Shared>, signed: SignedRequest, input: QueryEnvelope) -> StoreFuture<'static, QueryResult, Error> {
    Box::pin(async move {
        if signed.binding.world() != &input.world { return Err(AuthorizationFailure::RequestDigestMismatch.into()); }
        if let WorldQuery::Objects(request) | WorldQuery::Relations(request) = &input.query { crate::api::query::validate_query_request(request).map_err(query_input_error)?; }
        if let WorldQuery::DrainStatus(key) | WorldQuery::BackupStatus(key) | WorldQuery::RestoreStatus(key) | WorldQuery::DeleteStatus(key) = &input.query {
            let (store, _) = readable_for(&shared, &input.world).await?;
            return operation::status(&store, shared.ingress.clone(), signed, key.clone()).await.map(QueryResult::Operation);
        }
        let store = if package_metadata(&input.query) { readable_for(&shared, &input.world).await?.0 }
            else { ready_for(&shared, &input.world).await? };
        let resources = resources(&shared, &store, &input.world)?;
        let cancel = shared.cancellation.child_token();
        match &input.query {
            WorldQuery::Objects(_) | WorldQuery::Relations(_) => return queries::objects::run(store, resources, shared.ingress.clone(), signed, input, shared.source_access.clone(), cancel).await,
            WorldQuery::WorldView(_) => return queries::context::run(store, resources, shared.ingress.clone(), signed, input, shared.source_access.clone(), cancel).await,
            WorldQuery::UploadStatus(key) => return uploads::status(store, resources, shared.ingress.clone(), signed, key.clone()).await.map(QueryResult::Upload),
            WorldQuery::ActivationPlan(selection) => {
                let selection = selection.clone();
                let batch = operation::batch(&store, &signed.binding).await?;
                let admitted = authorization::commit_admission(&store, batch, move |tx| Box::pin(async move {
                    let now = tx.now().await?;
                    let verified = shared.ingress.authenticate(tx, &signed.token, signed.binding, &now).await?;
                    let impact = crate::extensions::bindings::activation_plan_impact(tx, &selection).await?;
                    let admission = authorization::admit(tx, &verified, &impact, &[], None, &now).await?;
                    Ok::<_, Error>(((selection, now), admission))
                })).await?;
                let (selection, now, admission) = match admitted {
                    AdmissionCommit::Committed { outcome, admission } => (outcome.value.0, outcome.value.1, admission),
                    AdmissionCommit::Replayed(_) => return Err(AuthorizationFailure::Replay.into()),
                };
                let budget = CallBudget::new(queries::objects::query_budget(admission.invocation().deadline.clone()), &now)
                    .map_err(|failure| Error::from_host_failure(world_protocol::process::HostFailure::BudgetExceeded { dimension: failure.dimension }, FailureStage::Read))?;
                let plan = tokio::select! {
                    _ = cancel.cancelled() => return Err(super::closed()),
                    result = tokio::time::timeout_at(budget.deadline(), resources.bindings.build_activation(&input.world, &selection, &resources.inventory)) => {
                        result.map_err(|_| Error::new("world.activation_plan_deadline", FailureStage::Prepare, "激活计划查询已超时。",
                            ApiFailure::Transport(world_protocol::api::TransportFailure::DeadlineExpired), Recovery::Refresh))??
                    }
                };
                return store.snapshot(input.world, move |snapshot| Box::pin(async move {
                    if cancel.is_cancelled() { return Err(super::closed()); }
                    let now = snapshot.now().await?;
                    authorization::recheck_read(snapshot, &admission, &now).await?;
                    admission.require_access(plan.impact())?;
                    let request = plan.recheck(snapshot).await?;
                    authorization::check_admitted_output_read(snapshot, &admission, plan.impact(), 1, &now).await?;
                    Ok::<_, Error>(QueryResult::ActivationPlan(request))
                })).await;
            }
            WorldQuery::ParseArtifact(request) => {
                let request = request.clone();
                let batch = operation::batch(&store, &signed.binding).await?;
                let admitted = authorization::commit_admission(&store, batch, move |tx| Box::pin(async move {
                    let now = tx.now().await?;
                    let verified = shared.ingress.authenticate(tx, &signed.token, signed.binding, &now).await?;
                    let impact = workflows::archive::query_impact(tx, &WorldQuery::ParseArtifact(request.clone())).await?;
                    let admission = authorization::admit(tx, &verified, &impact, &[], None, &now).await?;
                    Ok::<_, Error>((request, admission))
                })).await?;
                return match admitted { AdmissionCommit::Committed { outcome, admission } => workflows::archive::parse(store, resources.content.clone(), admission.verified().clone(), outcome.value).await, AdmissionCommit::Replayed(_) => Err(AuthorizationFailure::Replay.into()) };
            }
            _ => {}
        }
        let batch = operation::batch(&store, &signed.binding).await?;
        Ok(store.transact(batch, move |tx| Box::pin(async move {
            let now = tx.now().await?;
            let verified = shared.ingress.authenticate(tx, &signed.token, signed.binding, &now).await?;
            let budget = CallBudget::new(queries::objects::query_budget(verified.invocation().deadline.clone()), &now).map_err(|failure| Error::from_host_failure(world_protocol::process::HostFailure::BudgetExceeded { dimension: failure.dimension }, FailureStage::Read))?;
            queries::query(&resources, tx, &verified, &input.query, &now, &budget, &cancel).await
        })).await?.value)
    })
}

pub(super) async fn cancel(shared: &Shared, signed: SignedRequest, request: CancelOperation) -> Result<CancelReceipt, Error> {
    let store = ready_for_operation(shared, &request.key.world).await?;
    let key = (request.key.world.clone(), request.key.operation_id.clone());
    let receipt = operation::cancel(&store, shared.ingress.clone(), signed, request).await?;
    if !receipt.settled { if let Some(cancel) = shared.executing.lock().expect("world executions poisoned").get(&key) { cancel.cancel(); } }
    Ok(receipt)
}

pub(super) async fn operation(shared: Arc<Shared>, signed: SignedRequest, input: OperationRequest, target: WorldHandle) -> Result<OperationResponse, Error> {
    match input {
        OperationRequest::Status(key) => { let (store, _) = readable_for(&shared, &key.world).await?; operation::status(&store, shared.ingress.clone(), signed, key).await.map(OperationResponse::Status) }
        OperationRequest::Result(key) => { let (store, _) = readable_for(&shared, &key.world).await?; operation::status(&store, shared.ingress.clone(), signed, key).await.map(OperationResponse::Result) }
        OperationRequest::Cancel(request) => cancel(&shared, signed, request).await.map(OperationResponse::Cancel),
        OperationRequest::Resume(request) => {
            if signed.binding.world() != &request.key.world { return Err(AuthorizationFailure::RequestDigestMismatch.into()); }
            let (store, _) = readable_for(&shared, &request.key.world).await?;
            let binding = signed.binding.clone();
            let batch = operation::batch(&store, &binding).await?.receipt_access()?;
            let current = shared.clone();
            let original = request.clone();
            let inspected = authorization::commit_admission(&store, batch, move |tx| Box::pin(async move {
                let now = tx.now().await?;
                let mut verified = current.ingress.authenticate(tx, &signed.token, signed.binding, &now).await?;
                let record = ledger::read(tx, &original.key.operation_id).await?;
                operation::authorize_receipt(tx, &verified, &record, &now).await?;
                if record.receipt.accepted.revision != original.expected_revision { return Err(conflict()); }
                let run = run::read_run(tx, record.receipt.progress.run_id.as_ref().ok_or_else(conflict)?).await?;
                if let Some(branch) = &run.branch_id { verified = verified.bind_branch(tx, branch).await?; }
                record.identity.require_resume(&verified)?;
                if record.strategy_parent.is_some() {
                    return Err(Error::new("world.strategy_action_requires_parent", FailureStage::Recover,
                        "策略动作必须通过原父操作恢复。", ApiFailure::UnsupportedOperation, Recovery::None));
                }
                let impact = authorization::actual_impact(vec![AccessScope {
                    resources: vec![ResourceRef::Operation { id: original.key.operation_id }], fields: Vec::new(),
                    modes: vec![AccessMode::Execute], scope: head::management_scope(tx).await?, valid_time: None,
                }], Vec::new(), Vec::new(), Vec::new(), Vec::new())?;
                let admission = authorization::admit(tx, &verified, &impact, &[], None, &now).await?;
                let input = record.input.command_envelope()?.clone();
                Ok::<_, Error>((Accepted { execute: !ledger::terminal(record.receipt.phase), operation: record.receipt.accepted, run, input, now }, admission))
            })).await?;
            let (inspected, receipt_admission) = match inspected {
                AdmissionCommit::Committed { outcome, admission } => (outcome.value, admission),
                AdmissionCommit::Replayed(_) => return Err(AuthorizationFailure::Replay.into()),
            };
            if !inspected.execute { return Ok(OperationResponse::Resume(inspected.operation)); }
            if !package_maintenance(&inspected.input.command) {
                ready_for_operation(&shared, &request.key.world).await?;
            }
            let proof = workflows::archive::resume_intent(&store, &shared.authority, &request.key.world,
                &inspected.operation.operation_id, &inspected.run.id, &inspected.input.command).await?;
            let batch = if let Some(proof) = proof {
                operation::batch(&store, &binding).await?.resume_world_mutation(&proof)?
            } else {
                command_store(&shared, &request.key.world, &inspected.input.command).await?;
                admission_batch(&store, &binding).await?
            };
            let resources = resources(&shared, &store, &request.key.world)?;
            let verified = receipt_admission.verified().clone();
            let tx_shared_cancel = shared.cancellation.clone();
            let admitted = authorization::commit_admission(&store, batch, move |tx| Box::pin(async move {
                tx.require_world_mutation_operation(&request.key.operation_id)?;
                let now = tx.now().await?;
                let record = ledger::read(tx, &request.key.operation_id).await?;
                if record.receipt.accepted.revision != request.expected_revision { return Err(conflict()); }
                record.identity.require_resume(&verified)?;
                operation::authorize_receipt(tx, &verified, &record, &now).await?;
                let mut run = run::read_run(tx, record.receipt.progress.run_id.as_ref().ok_or_else(conflict)?).await?;
                if run.id != inspected.run.id || canonical_digest(&record.input)? != canonical_digest(&ledger::OperationInput::Command(inspected.input.clone()))? {
                    return Err(conflict());
                }
                let input = record.input.command_envelope()?.clone();
                let recovery = if let WorldCommand::ActionSubmit(request) = &input.command {
                    crate::actions::lookup_intent_recovery(tx, &verified.invocation().actor, request).await?
                } else { None };
                let recovering = recovery.is_some();
                let (impact, preflight_budget) = if let Some((_, impact)) = recovery {
                    (impact, None)
                } else if let WorldCommand::EvaluateRule(request) = &input.command {
                    let expected = workflows::facts::rule_plan(tx, &run, request).await?;
                    match CallBudget::resume(run.budget.clone(), run.usage.clone(), &now) {
                        Ok(budget) => {
                            let (impact, actual, lock) = workflows::facts::preflight_rule_in_branch(tx, &verified, request, expected.branch.as_ref(), &budget, &tx_shared_cancel).await?;
                            if actual.query != expected.query || actual.facts != expected.facts || actual.branch != expected.branch
                                || run.activation_lock_id.as_ref() != Some(&lock) { return Err(conflict()); }
                            (impact, Some(budget))
                        }
                        // No plan or business dispatch is renewed; launch settles the original rejected resume.
                        Err(_) => (record.impact.clone(), None),
                    }
                } else {
                    (command_impact(tx, &input.command, &record.receipt.accepted.operation_id).await?, None)
                };
                let policies = command_policies(tx, &input.command).await?;
                let admission = if recovering {
                    authorization::read_recovery_admit(tx, &verified, &impact, &policies, &now).await?
                } else {
                    let approval = workflows::actions::approval(tx, &input.command).await?;
                    authorization::admit(tx, &verified, &impact, &policies, approval.as_ref(), &now).await?
                };
                let now = if let Some(budget) = preflight_budget {
                    budget.check().map_err(|failure| budget_error(failure.dimension))?;
                    run = run::checkpoint_usage(tx, &run, run::confirmed_usage(&run.usage, budget.checkpoint_usage())?).await?;
                    tx.now().await?
                } else { now };
                Ok::<_, Error>((Accepted { execute: !ledger::terminal(record.receipt.phase), operation: record.receipt.accepted, run, input, now }, admission))
            })).await?;
            let (accepted, admission) = match admitted { AdmissionCommit::Committed { outcome, admission } => (outcome.value, admission), AdmissionCommit::Replayed(_) => return Err(AuthorizationFailure::Replay.into()) };
            let receipt = accepted.operation.clone();
            if accepted.execute {
                resources.tasks.resume_run(&accepted.operation.world, &accepted.run.id)?;
                launch(shared, store, resources, admission, accepted, target, true).await?;
            }
            Ok(OperationResponse::Resume(receipt))
        }
    }
}

pub(super) async fn peer(shared: Arc<Shared>, raw_proof: Vec<u8>, bytes: Vec<u8>, input: PeerRequest, target: WorldHandle) -> Result<PeerResponse, Error> {
    let store = ready_for(&shared, &input.world).await?;
    let resources = resources(&shared, &store, &input.world)?;
    let binding = RequestBinding::new(input.world.clone(), world_protocol::api::PEER_ENDPOINT, input.operation.operation_name(), &bytes)?;
    let now = store.snapshot(input.world.clone(), |snapshot| Box::pin(async move { snapshot.now().await })).await?;
    let proof = shared.native.verify(&raw_proof, &bytes, world_protocol::api::PEER_ENDPOINT, &now).map_err(|error| Error::from(error.reason().clone()).caused(error))?;
    let peer_input = input.clone();
    let command = match input.operation {
        PeerOperation::ActionPropose(request) => WorldCommand::ActionPropose(request),
        PeerOperation::ActionSubmit(request) => WorldCommand::ActionSubmit(request),
        PeerOperation::Observe(request) => WorldCommand::Observe(request),
        PeerOperation::ChangePropose(request) => WorldCommand::ProposeChange(request),
        PeerOperation::BranchTest(request) => WorldCommand::TestBranch(request),
        _ => return peer_query(shared, store, resources, proof, binding, peer_input).await,
    };
    let (result, accepted) = submit(shared, store, resources, Authentication::Native { proof, binding }, CommandEnvelope { world: input.world, request_id: input.request_id, command }, target).await?;
    match result {
        CommandResult::Proposal(proposal) => Ok(PeerResponse::ActionPropose(proposal)),
        CommandResult::Accepted(accepted) => Ok(PeerResponse::Accepted(accepted)),
        CommandResult::Change(change) => Ok(PeerResponse::Change(change)),
        CommandResult::Candidate(_) => Ok(PeerResponse::Accepted(accepted)),
        _ => Err(Error::internal(FailureStage::Disclose)),
    }
}

async fn peer_query(shared: Arc<Shared>, store: WorldStore, resources: Arc<Resources>, proof: NativeProof, binding: RequestBinding, peer: PeerRequest) -> Result<PeerResponse, Error> {
    let query = match peer.operation.clone() {
        PeerOperation::Discover(request) => WorldQuery::Discover(request),
        PeerOperation::Query(request) => { crate::api::query::validate_query_request(&request).map_err(query_input_error)?; WorldQuery::Objects(request) }
        PeerOperation::Explain(request) => WorldQuery::Explain(request),
        PeerOperation::ActionStatus(key) => WorldQuery::ActionStatus(key),
        _ => return Err(Error::internal(FailureStage::Decode)),
    };
    let batch = operation::batch(&store, &binding).await?;
    let query_copy = query.clone(); let native = shared.native.clone();
    let native_run = proof.facts().native_run_id.clone();
    let investigation = investigation_binding(&shared, &proof, binding.world())?;
    let admitted = authorization::commit_admission(&store, batch, move |tx| Box::pin(async move {
        let now = tx.now().await?;
        let mut bridge = None;
        let impact = match &query_copy {
            WorldQuery::Discover(_) => {
                let ceiling = native.discovery_impact(tx, &proof, investigation.clone(), &now).await?;
                let metadata = queries::discovery_impact(tx).await?;
                merge_impact(ceiling, metadata)?
            }
            WorldQuery::Objects(request) => {
                let (impact, selection) = queries::agent_bridge::preflight(tx, request, &head::management_scope(tx).await?).await?;
                bridge = Some(selection);
                impact
            },
            WorldQuery::Explain(_) => workflows::facts::query_impact(tx, proof.facts().branch_id.as_ref(), &query_copy).await?,
            WorldQuery::ActionStatus(_) => workflows::actions::query_impact(tx, &query_copy).await?,
            _ => return Err(Error::internal(FailureStage::Decode)),
        };
        let verified = native.authenticate(tx, &proof, binding, &impact, investigation, &now).await?;
        let admitted_impact = if matches!(query_copy, WorldQuery::Discover(_)) { queries::discovery_impact(tx).await? } else { impact };
        let admission = authorization::admit(tx, &verified, &admitted_impact, &[], None, &now).await?;
        Ok::<_, Error>(((query_copy, bridge), admission))
    })).await?;
    let (query, bridge, admission) = match admitted { AdmissionCommit::Committed { outcome, admission } => (outcome.value.0, outcome.value.1, admission), AdmissionCommit::Replayed(_) => return Err(AuthorizationFailure::Replay.into()) };
    let owner = admission.clone();
    let tasks = resources.tasks.clone();
    let worker = tasks.spawn_investigation(&owner, async move {
        peer_query_admitted(shared, store, resources, admission, query, peer, native_run, bridge).await
    })?;
    worker.await.map_err(|cause| Error::internal(FailureStage::Read).caused(cause))?
}

async fn peer_query_admitted(
    shared: Arc<Shared>, store: WorldStore, resources: Arc<Resources>, admission: Admission, query: WorldQuery,
    peer: PeerRequest, native_run: NativeRunId, bridge: Option<(NodeId, ActivationLockId)>,
) -> Result<PeerResponse, Error> {
    let cancel = admission.investigation_cancellation().map(CancellationToken::child_token)
        .unwrap_or_else(|| shared.cancellation.child_token());
    if matches!(query, WorldQuery::Objects(_)) {
        return queries::agent_bridge::run(store, resources, admission, peer, native_run, bridge.ok_or_else(|| Error::internal(FailureStage::Prepare))?, shared.source_access.clone(), cancel).await;
    }
    let now = store.snapshot(admission.invocation().world.clone(), |snapshot| Box::pin(async move { snapshot.now().await })).await?;
    let limit = queries::objects::query_budget(admission.invocation().deadline.clone());
    let budget = match admission.investigation_budget() {
        Some(parent) => parent.scoped(&limit, &now),
        None => CallBudget::new(limit, &now),
    }.map_err(|failure| Error::from_host_failure(world_protocol::process::HostFailure::BudgetExceeded { dimension: failure.dimension }, FailureStage::Read))?;
    let request = admission.invocation();
    let binding = RequestBinding::new(request.world.clone(), world_protocol::api::PEER_ENDPOINT, query.operation_name(), b"")?;
    let batch = operation::batch(&store, &binding).await?;
    let result = store.transact(batch, move |tx| Box::pin(async move {
        let now = tx.now().await?;
        authorization::recheck(tx, &admission, &now).await?;
        queries::query(&resources, tx, admission.verified(), &query, &now, &budget, &cancel).await
    })).await?.value;
    match result { QueryResult::Discover(result) => Ok(PeerResponse::Discover(result)), QueryResult::Explain(result) => Ok(PeerResponse::Explain(result)), QueryResult::ActionStatus(result) => Ok(PeerResponse::ActionStatus(result)), _ => Err(Error::internal(FailureStage::Disclose)) }
}

fn merge_impact(mut left: ActualImpact, right: ActualImpact) -> Result<ActualImpact, Error> {
    left.access.extend(right.access); left.effects.extend(right.effects); left.labels.extend(right.labels); left.state.extend(right.state); left.source_ids.extend(right.source_ids);
    Ok(authorization::actual_impact(left.access, left.effects, left.labels, left.state, left.source_ids)?)
}

fn query_input_error(error: crate::api::query::QueryInputError) -> Error {
    use crate::api::query::QueryInputError;
    match error {
        QueryInputError::Input(failure) => Error::new("world.invalid_query", FailureStage::Decode, "查询输入无效。", ApiFailure::Input(failure), Recovery::None),
        QueryInputError::Definition { failure, .. } => failure.into(),
        QueryInputError::Decode(_) => Error::internal(FailureStage::Decode),
    }
}

fn reservation_error(error: crate::extensions::invocation::ReservationFailure) -> Error {
    match error {
        crate::extensions::invocation::ReservationFailure::Budget(failure) => budget_error(failure.dimension),
        crate::extensions::invocation::ReservationFailure::IdentityConflict(_) => AuthorizationFailure::InvalidDelegation.into(),
    }
}

fn budget_error(dimension: world_protocol::budget::BudgetDimension) -> Error {
    Error::from_host_failure(world_protocol::process::HostFailure::BudgetExceeded { dimension }, FailureStage::Admission)
}

fn conflict() -> Error { Error::new("world.operation_revision_conflict", FailureStage::Admission, "操作或执行依据已变化，请读取当前状态。", ApiFailure::RevisionConflict, Recovery::Refresh) }
