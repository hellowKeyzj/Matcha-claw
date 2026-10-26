use std::collections::BTreeSet;

use crate::{
    authorization::{self, VerifiedInvocation},
    definitions::canonical_digest,
    extensions::invocation::CallBudget,
    facts::{assertions, support},
    owner::{self, Error, ExecutionContext},
    sources::sync,
    store::{StoreFuture, WorldTransaction},
};
use tokio_util::sync::CancellationToken;
use world_protocol::{
    api::{ApiFailure, BindingCommand, CommandResult, QueryResult, WorldCommand, WorldQuery},
    authorization::{AccessMode, AccessScope, ActualImpact},
    expression::Effect,
    facts::{AssertionOrigin, FactFailure},
    failure::{FailureStage, FieldPath, InputFailure, Recovery},
    ids::*,
    operation::{OperationPhase, OperationResult},
    query::{QueryFailure, ReadMode},
    time::Timestamp,
};

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RuleRunBasis {
    pub(crate) command: WorldCommand,
    pub(crate) rule_plan: RulePlan,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RulePlan {
    pub(crate) query: Digest,
    pub(crate) facts: Digest,
    pub(crate) branch: Option<world_protocol::releases::BranchRef>,
}

pub(crate) fn run_command_basis(value: serde_json::Value) -> Result<WorldCommand, Error> {
    if value.get("rulePlan").is_some() {
        let basis: RuleRunBasis = serde_json::from_value(value).map_err(|cause| invalid("rulePlan").caused(cause))?;
        if !matches!(basis.command, WorldCommand::EvaluateRule(_)) { return Err(invalid("rulePlan")); }
        Ok(basis.command)
    } else {
        let command = serde_json::from_value(value).map_err(|cause| invalid("basis").caused(cause))?;
        if matches!(command, WorldCommand::EvaluateRule(_)) { return Err(invalid("rulePlan")); }
        Ok(command)
    }
}

pub(crate) async fn rule_plan(tx: &WorldTransaction<'_>, run: &owner::RunRecord, request: &world_protocol::api::EvaluateRuleRequest) -> Result<RulePlan, Error> {
    let row = tx.query_opt("SELECT basis FROM world_run WHERE tenant_id=$1 AND world_id=$2 AND run_id=$3",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &run.id.as_str()]).await?.ok_or_else(|| invalid("run"))?;
    let basis: RuleRunBasis = serde_json::from_value(row.get("basis")).map_err(|cause| invalid("rulePlan").caused(cause))?;
    if basis.command != WorldCommand::EvaluateRule(request.clone()) || run.release_id.as_ref() != Some(&request.release_id)
        || request.branch != basis.rule_plan.branch
        || run.branch_id.as_ref() != basis.rule_plan.branch.as_ref().map(|branch| &branch.id)
        || run.branch_revision != basis.rule_plan.branch.as_ref().map(|branch| branch.revision)
        || basis.rule_plan.branch.as_ref().is_some_and(|branch| branch.world != *tx.world())
        || run.operation.world != *tx.world() { return Err(invalid("rulePlan")); }
    Ok(basis.rule_plan)
}

pub(crate) async fn preflight_rule(
    tx: &WorldTransaction<'_>, verified: &VerifiedInvocation, request: &world_protocol::api::EvaluateRuleRequest,
    budget: &CallBudget, cancel: &CancellationToken,
) -> Result<(ActualImpact, RulePlan, ActivationLockId), Error> {
    preflight_rule_in_branch(tx, verified, request, request.branch.as_ref(), budget, cancel).await
}

pub(crate) async fn preflight_rule_in_branch(
    tx: &WorldTransaction<'_>, verified: &VerifiedInvocation, request: &world_protocol::api::EvaluateRuleRequest,
    branch: Option<&world_protocol::releases::BranchRef>, budget: &CallBudget, cancel: &CancellationToken,
) -> Result<(ActualImpact, RulePlan, ActivationLockId), Error> {
    let query = crate::query::preflight_rule(tx, verified, request, branch, budget, cancel).await?;
    let facts = assertions::preflight_derivation(tx, verified, query.derivation(), budget, cancel).await?;
    Ok((facts.impact().clone(), RulePlan { query: query.fingerprint(), facts: facts.fingerprint(), branch: branch.cloned() }, query.derivation().activation_lock_id().clone()))
}

pub(crate) async fn impact(
    tx: &WorldTransaction<'_>,
    command: &WorldCommand,
) -> Result<ActualImpact, Error> {
    match command {
        WorldCommand::Observe(request) => {
            if request.observations.is_empty() {
                return Err(invalid("observations"));
            }
            let mut access = Vec::new();
            let mut labels = Vec::new();
            let mut sources = Vec::new();
            for draft in &request.observations {
                let impact =
                    assertions::admission_impact(tx, &assertions::observation_id(tx.world(), draft)?, draft)
                        .await?;
                access.extend(impact.access);
                labels.extend(impact.labels);
                sources.extend(impact.source_ids);
            }
            Ok(authorization::actual_impact(
                access,
                vec![Effect::Pure],
                labels,
                Vec::new(),
                sources,
            )?)
        }
        WorldCommand::Reconcile(request) => {
            if request.bindings.is_empty() {
                return Err(invalid("bindings"));
            }
            let mut access = Vec::new();
            let mut effects = Vec::new();
            let mut labels = Vec::new();
            let mut sources = Vec::new();
            let mut unique = BTreeSet::new();
            for reference in &request.bindings {
                if !unique.insert(reference) {
                    return Err(invalid("bindings"));
                }
                let command = BindingCommand {
                    binding: reference.clone(),
                    expected_revision: reference.revision,
                };
                let impact = sync::command_impact(tx, &command, true, &tx.now().await?).await?;
                access.extend(impact.access);
                effects.extend(impact.effects);
                labels.extend(impact.labels);
                sources.extend(impact.source_ids);
            }
            let scope = owner::head::management_scope(tx).await?;
            for subject in &request.subjects {
                access.push(AccessScope {
                    resources: vec![resource(subject)],
                    fields: Vec::new(),
                    modes: vec![AccessMode::Read],
                    scope: scope.clone(),
                    valid_time: None,
                });
            }
            Ok(authorization::actual_impact(
                access,
                effects,
                labels,
                Vec::new(),
                sources,
            )?)
        }
        _ => Err(invalid("command")),
    }
}

fn provenance<'a>(
    ctx: &'a ExecutionContext,
    request: &'a world_protocol::api::EvaluateRuleRequest,
) -> StoreFuture<'a, world_protocol::provenance::SupportDeltaProposal, Error> {
    Box::pin(async move {
        use crate::extensions::bindings;
        use world_protocol::{bindings::SlotKind, slots::{SlotRequest, SlotResponse}};
        let input = canonical_digest(request)?;
        let request = request.clone();
        let budget = ctx.budget.clone();
        let cancel = ctx.cancellation.clone();
        let (snapshot, node) = ctx.transact(
            &format!("facts.provenance.input.{}", uuid::Uuid::new_v4()), canonical_digest(&request)?,
            &["facts", "query", "authorization"], move |tx, admission, _, run| Box::pin(async move {
                let expected = rule_plan(tx, &run, &request).await?;
                let query = crate::query::preflight_rule(tx, admission.verified(), &request, expected.branch.as_ref(), &budget, &cancel).await?;
                let facts = assertions::preflight_derivation(tx, admission.verified(), query.derivation(), &budget, &cancel).await?;
                if query.fingerprint() != expected.query || facts.fingerprint() != expected.facts { return Err(query_failure(QueryFailure::BasisChanged)); }
                admission.require_impact(facts.impact())?;
                let lock = run.activation_lock_id.as_ref().ok_or_else(|| invalid("activationLockId"))?;
                let graph = bindings::read_graph_in_transaction(tx, lock).await?;
                let node = super::actions::slots::select(&graph, SlotKind::Provenance)?;
                Ok((facts.support_snapshot(), node))
            }),
        ).await?.value;
        let response = super::actions::slots::invoke(ctx, "facts.evaluate_rule", input, node, SlotRequest::Provenance(snapshot.clone())).await?;
        let SlotResponse::Provenance(proposal) = response else { return Err(invalid("provenance")); };
        support::check_proposal(&snapshot, &proposal).map_err(|failure| Error::from(assertions::Error::from(FactFailure::Provenance { failure })))?;
        Ok(proposal)
    })
}

pub(crate) fn run(
    ctx: ExecutionContext,
    command: WorldCommand,
) -> StoreFuture<'static, CommandResult, Error> {
    match command {
        WorldCommand::Observe(request) => Box::pin(async move {
            let input = canonical_digest(&request)?;
            let budget = ctx.budget.clone();
            let cancel = ctx.cancellation.clone();
            ctx.transact(
                "facts.observe",
                input.clone(),
                &["facts", "support", "identity", "authorization"],
                move |tx, admission, operation, run| {
                    Box::pin(async move {
                        let step = claim(tx, &admission, &run, "facts.observe", input).await?;
                        let mut drafts = request
                            .observations
                            .into_iter()
                            .map(|draft| Ok((assertions::observation_id(tx.world(), &draft)?, draft)))
                            .collect::<Result<Vec<_>, Error>>()?;
                        drafts.sort_by(|left, right| left.0.cmp(&right.0));
                        if drafts.windows(2).any(|pair| pair[0].0 == pair[1].0) {
                            return Err(invalid("observations"));
                        }
                        assertions::lock_observation_batch(tx, &drafts).await?;
                        let mut references = Vec::with_capacity(drafts.len());
                        for (id, draft) in drafts {
                            checkpoint(&budget, &cancel)?;
                            // Source acceptance needs an opaque mapped witness; derived acceptance needs a canonical support proof.
                            if matches!(
                                draft.origin,
                                AssertionOrigin::Source { .. } | AssertionOrigin::Derived { .. }
                            ) {
                                return Err(
                                    assertions::Error::from(FactFailure::AccessDenied).into()
                                );
                            }
                            let assertion = assertions::admit_observation(
                                tx,
                                &admission,
                                id,
                                draft,
                                None,
                                &[],
                                &[],
                                &budget,
                                &cancel,
                            )
                            .await?;
                            references.push(assertion.reference);
                        }
                        authorization::check_admitted_output(
                            tx,
                            &admission,
                            admission.impact(),
                            references.len() as u64,
                            &tx.now().await?,
                        )
                        .await?;
                        finish(tx, step, &references).await?;
                        owner::complete_operation(
                            tx,
                            &operation.receipt.accepted,
                            OperationResult::Facts {
                                assertions: references,
                            },
                            &tx.now().await?,
                        )
                        .await?;
                        Ok(())
                    })
                },
            )
            .await?;
            Ok(CommandResult::Accepted(ctx.operation))
        }),
        WorldCommand::EvaluateRule(request) => Box::pin(async move {
            let input = canonical_digest(&request)?;
            let proposal = provenance(&ctx, &request).await?;
            let budget = ctx.budget.clone();
            let cancel = ctx.cancellation.clone();
            ctx.transact("facts.evaluate_rule", input.clone(), &["facts", "support", "identity", "query", "authorization"],
                move |tx, admission, operation, run| Box::pin(async move {
                    checkpoint(&budget, &cancel)?;
                    let expected = rule_plan(tx, &run, &request).await?;
                    let id = StepId::try_new(format!("step-{}", &canonical_digest(&(&run.id, "facts.evaluate_rule"))?.as_str()[7..]))
                        .map_err(|cause| invalid("step").caused(cause))?;
                    let step = owner::read_step(tx, &run.id, &id).await?.ok_or_else(|| invalid("step"))?;
                    if step.kind != "facts.evaluate_rule" || step.input_digest != input { return Err(invalid("step")); }
                    let proof = crate::query::derive_rule(tx, &admission, &request, expected.branch.as_ref(), &expected.query, &budget, &cancel).await?;
                    let (status, assertion) = assertions::admit_derived(tx, &admission, proof, &expected.facts, &proposal, &run, &step, &budget, &cancel).await?;
                    let result = OperationResult::RuleEvaluated { status, assertion };
                    checkpoint(&budget, &cancel)?;
                    authorization::check_admitted_output(tx, &admission, admission.impact(), 1, &tx.now().await?).await?;
                    owner::checkpoint_usage(tx, &run, owner::confirmed_usage(&run.usage, budget.checkpoint_usage())?).await?;
                    finish(tx, step, &result).await?;
                    owner::complete_operation(tx, &operation.receipt.accepted, result, &tx.now().await?).await?;
                    Ok(())
                })).await?;
            Ok(CommandResult::Accepted(ctx.operation))
        }),
        WorldCommand::Reconcile(request) => Box::pin(async move {
            let input = canonical_digest(&request)?;
            let check = request.clone();
            let budget = ctx.budget.clone();
            let cancel = ctx.cancellation.clone();
            ctx.transact(
                "facts.reconcile.admit",
                input.clone(),
                &["sources", "identity", "authorization"],
                move |tx, admission, _, _| {
                    Box::pin(async move {
                        admission.require_access(
                            &impact(tx, &WorldCommand::Reconcile(check.clone())).await?,
                        )?;
                        sync::reconcile_subject_coverage(
                            tx,
                            &check.bindings,
                            &check.subjects,
                            &tx.now().await?,
                            &budget,
                            &cancel,
                        )
                        .await?;
                        Ok(())
                    })
                },
            )
            .await?;
            let mut outcomes = Vec::new();
            for reference in &request.bindings {
                checkpoint(&ctx.budget, &ctx.cancellation)?;
                let command = BindingCommand {
                    binding: reference.clone(),
                    expected_revision: reference.revision,
                };
                let (broker, lease) = super::sources::broker(&ctx, &command).await?;
                // SyncOwner retains the lease until the actual snapshot reader has joined.
                let outcome = ctx
                    .resources
                    .sync
                    .reconcile(&ctx, &command, broker, lease)
                    .await?;
                if !outcome.reconciled
                    || !outcome.failures.is_empty()
                    || outcome.checkpoint.source.gap.is_some()
                {
                    return Err(query_failure(QueryFailure::GuaranteeUnsatisfied {
                        mode: request.read_mode.clone(),
                        source_id: None,
                    }));
                }
                outcomes.push(outcome);
            }
            let budget = ctx.budget.clone();
            let cancel = ctx.cancellation.clone();
            ctx.transact(
                "facts.reconcile.complete",
                input.clone(),
                &["facts", "sources", "identity", "authorization"],
                move |tx, admission, operation, run| {
                    Box::pin(async move {
                        checkpoint(&budget, &cancel)?;
                        sync::reconcile_subject_coverage(
                            tx,
                            &request.bindings,
                            &request.subjects,
                            &tx.now().await?,
                            &budget,
                            &cancel,
                        )
                        .await?;
                        for (binding, outcome) in request.bindings.iter().zip(&outcomes) {
                            sync::validate_snapshot_outcome(
                                tx,
                                &admission,
                                binding,
                                outcome,
                                &tx.now().await?,
                            )
                            .await?;
                        }
                        if request.read_mode != ReadMode::Authoritative {
                            require_mode(
                                tx,
                                &admission,
                                &request.read_mode,
                                &request.bindings,
                                &tx.now().await?,
                            )
                            .await?;
                        }
                        let step = claim(tx, &admission, &run, "facts.reconcile", input).await?;
                        let checkpoints: Vec<_> = outcomes
                            .into_iter()
                            .map(|outcome| outcome.checkpoint.source)
                            .collect();
                        finish(tx, step, &checkpoints).await?;
                        authorization::check_admitted_output(
                            tx,
                            &admission,
                            admission.impact(),
                            checkpoints.len() as u64,
                            &tx.now().await?,
                        )
                        .await?;
                        owner::complete_operation(
                            tx,
                            &operation.receipt.accepted,
                            OperationResult::Reconciled { checkpoints },
                            &tx.now().await?,
                        )
                        .await?;
                        Ok(())
                    })
                },
            )
            .await?;
            Ok(CommandResult::Accepted(ctx.operation))
        }),
        _ => Box::pin(async { Err(invalid("command")) }),
    }
}

pub(crate) async fn query_impact(
    tx: &WorldTransaction<'_>,
    branch: Option<&BranchId>,
    request: &WorldQuery,
) -> Result<ActualImpact, Error> {
    let WorldQuery::Explain(request) = request else {
        return Err(invalid("query"));
    };
    let assertion = assertions::read_assertion(tx, &request.assertion)
        .await?
        .ok_or(world_protocol::authorization::AuthorizationFailure::InsufficientScope)?;
    let release = explain_release(tx, branch).await?;
    Ok(support::explain_impact(tx, &request.assertion, &assertion.scope, &release, branch).await?)
}

async fn explain_release(
    tx: &WorldTransaction<'_>,
    branch: Option<&BranchId>,
) -> Result<ReleaseId, Error> {
    match branch {
        Some(id) => Ok(crate::releases::read_branch(tx, id)
            .await?
            .ok_or_else(|| invalid("branchId"))?
            .basis
            .release_id),
        None => crate::releases::read_active_release(tx)
            .await?
            .ok_or_else(|| invalid("releaseId")),
    }
}

pub(crate) async fn query(
    tx: &WorldTransaction<'_>,
    verified: &VerifiedInvocation,
    request: &WorldQuery,
    now: &Timestamp,
    budget: &CallBudget,
    cancel: &CancellationToken,
) -> Result<QueryResult, Error> {
    checkpoint(budget, cancel)?;
    let WorldQuery::Explain(request) = request else {
        return Err(invalid("query"));
    };
    let impact = query_impact(
        tx,
        verified.invocation().branch_id.as_ref(),
        &WorldQuery::Explain(request.clone()),
    )
    .await?;
    let admission = authorization::admit(tx, verified, &impact, &[], None, now).await?;
    let plan = explain_plan(tx, &admission, request, now, budget, cancel).await?;
    require_mode(tx, &admission, &request.read_mode, &plan.bindings, now).await?;
    authorization::check_admitted_output(tx, &admission, &impact, 1, &tx.now().await?).await?;
    Ok(QueryResult::Explain(plan.graph))
}

async fn require_mode(
    tx: &WorldTransaction<'_>,
    admission: &authorization::Admission,
    mode: &ReadMode,
    bindings: &[DefinitionRef],
    now: &Timestamp,
) -> Result<(), Error> {
    match mode {
        ReadMode::After { receipt_id } => {
            let read = crate::query::require_action_basis(tx, admission, receipt_id, now).await?;
            for binding in bindings {
                let bases: Vec<_> = read
                    .basis
                    .iter()
                    .filter(|basis| &basis.binding == binding)
                    .collect();
                if bases.is_empty() {
                    return Err(query_failure(QueryFailure::GuaranteeUnsatisfied {
                        mode: mode.clone(),
                        source_id: None,
                    }));
                }
                for basis in bases {
                    let position = basis.position.as_ref().ok_or_else(|| {
                        query_failure(QueryFailure::GuaranteeUnsatisfied {
                            mode: mode.clone(),
                            source_id: Some(basis.source_id.clone()),
                        })
                    })?;
                    sync::require_after_transaction(tx, binding, position).await?;
                }
            }
        }
        ReadMode::Projected { max_lag } => {
            for reference in bindings {
                sync::require_projected_transaction(tx, reference, max_lag, now).await?;
            }
        }
        ReadMode::Authoritative => {
            if !bindings.is_empty() {
                return Err(query_failure(QueryFailure::GuaranteeUnsatisfied {
                    mode: mode.clone(),
                    source_id: None,
                }));
            }
        }
    }
    Ok(())
}
#[derive(Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ExplainPlan {
    pub graph: world_protocol::provenance::ExplanationGraph,
    pub scope: ScopeId,
    pub release: ReleaseId,
    pub bindings: Vec<DefinitionRef>,
    pub source_assertions: Vec<world_protocol::facts::Assertion>,
}

/// Dependencies come only from the root and the already-authorized visible graph.
pub(crate) async fn explain_plan(
    tx: &WorldTransaction<'_>,
    admission: &authorization::Admission,
    request: &world_protocol::api::ExplainQuery,
    now: &Timestamp,
    budget: &CallBudget,
    cancel: &CancellationToken,
) -> Result<ExplainPlan, Error> {
    use world_protocol::provenance::{PremiseRef, ReadDependency};
    checkpoint(budget, cancel)?;
    let root = assertions::read_assertion(tx, &request.assertion)
        .await?
        .ok_or(world_protocol::authorization::AuthorizationFailure::InsufficientScope)?;
    let release = explain_release(tx, admission.invocation().branch_id.as_ref()).await?;
    let graph = support::explain(
        tx,
        &request.assertion,
        &root.scope,
        &release,
        admission.invocation().branch_id.as_ref(),
        admission,
        budget,
        cancel,
        now,
    )
    .await?;
    let mut references = BTreeSet::from([root.reference.clone()]);
    let mut bindings = BTreeSet::new();
    for support in &graph.supports {
        for premise in &support.premises {
            checkpoint(budget, cancel)?;
            match premise {
                PremiseRef::Assertion(reference)
                | PremiseRef::Read(ReadDependency::Assertion { reference }) => {
                    references.insert(reference.clone());
                }
                PremiseRef::Read(
                    ReadDependency::Source { binding, .. }
                    | ReadDependency::SourceMapping { binding, .. },
                ) => {
                    bindings.insert(binding.clone());
                }
                _ => {}
            }
        }
    }
    let mut source_assertions = Vec::new();
    for reference in references {
        checkpoint(budget, cancel)?;
        let assertion = assertions::read_assertion(tx, &reference)
            .await?
            .ok_or(world_protocol::authorization::AuthorizationFailure::InsufficientScope)?;
        if let AssertionOrigin::Source { binding, .. } = &assertion.origin {
            bindings.insert(binding.clone());
            source_assertions.push(assertion);
        }
    }
    Ok(ExplainPlan {
        graph,
        scope: root.scope,
        release,
        bindings: bindings.into_iter().collect(),
        source_assertions,
    })
}
pub(crate) fn step_retention_roots(
    step: &owner::StepRecord,
    roots: &mut crate::store::RetentionRoots,
) -> Result<(), Error> {
    if step.kind == "facts.evaluate_rule" { super::actions::slots::retention(step, roots)?; }
    let Some(result) = &step.result else {
        return Ok(());
    };
    match step.kind.as_str() {
        "facts.observe" => {
            let assertions: Vec<AssertionRef> = serde_json::from_value(result.clone())
                .map_err(|cause| Error::internal(FailureStage::Decode).caused(cause))?;
            roots
                .dependencies
                .extend(assertions.into_iter().map(|reference| {
                    world_protocol::provenance::ReadDependency::Assertion { reference }
                }));
        }
        "facts.evaluate_rule" => {
            let result: OperationResult = serde_json::from_value(result.clone())
                .map_err(|cause| Error::internal(FailureStage::Decode).caused(cause))?;
            let OperationResult::RuleEvaluated { assertion, .. } = result else { return Err(invalid("step.result")); };
            roots.dependencies.extend(assertion.into_iter().map(|reference| world_protocol::provenance::ReadDependency::Assertion { reference }));
        }
        "facts.reconcile" => {
            let checkpoints: Vec<world_protocol::sources::SourceCheckpoint> =
                serde_json::from_value(result.clone())
                    .map_err(|cause| Error::internal(FailureStage::Decode).caused(cause))?;
            for checkpoint in checkpoints {
                roots.definitions.push(checkpoint.binding.clone());
                roots.dependencies.extend(
                    [
                        checkpoint.captured,
                        checkpoint.applied,
                        checkpoint.acknowledged,
                        checkpoint.projected,
                    ]
                    .into_iter()
                    .flatten()
                    .map(|position| {
                        world_protocol::provenance::ReadDependency::Source {
                            position,
                            binding: checkpoint.binding.clone(),
                        }
                    }),
                );
            }
        }
        _ => {}
    }
    Ok(())
}

async fn claim(
    tx: &mut WorldTransaction<'_>,
    admission: &authorization::Admission,
    run: &owner::RunRecord,
    kind: &str,
    input: Digest,
) -> Result<owner::StepRecord, Error> {
    let digest = canonical_digest(&(&run.id, kind))?;
    let id = StepId::try_new(format!("step-{}", &digest.as_str()[7..]))
        .map_err(|cause| Error::internal(FailureStage::Prepare).caused(cause))?;
    owner::claim_step(tx, admission, run, id, 0, kind, input, &tx.now().await?).await
}
async fn finish(
    tx: &mut WorldTransaction<'_>,
    step: owner::StepRecord,
    result: &impl serde::Serialize,
) -> Result<(), Error> {
    let mut next = step.clone();
    next.phase = OperationPhase::Completed;
    next.result = Some(
        serde_json::to_value(result)
            .map_err(|cause| Error::internal(FailureStage::Commit).caused(cause))?,
    );
    owner::checkpoint_step(tx, &step, next).await?;
    Ok(())
}
fn resource(subject: &world_protocol::identity::SubjectRef) -> ResourceRef {
    match subject {
        world_protocol::identity::SubjectRef::Object { id } => {
            ResourceRef::Object { id: id.clone() }
        }
        world_protocol::identity::SubjectRef::Relation { id } => {
            ResourceRef::Relation { id: id.clone() }
        }
    }
}
fn checkpoint(budget: &CallBudget, cancel: &CancellationToken) -> Result<(), Error> {
    if cancel.is_cancelled() {
        return Err(query_failure(QueryFailure::Cancelled));
    }
    budget
        .charge(world_protocol::budget::BudgetDimension::Steps, 1)
        .map_err(|reason| {
            Error::from_host_failure(
                world_protocol::process::HostFailure::BudgetExceeded {
                    dimension: reason.dimension,
                },
                FailureStage::Validate,
            )
        })
}
fn query_failure(reason: QueryFailure) -> Error {
    crate::query::QueryError::from(reason).into()
}
fn invalid(field: &str) -> Error {
    Error::new(
        "world.fact_input",
        FailureStage::Validate,
        "事实请求或保留依据无效。",
        ApiFailure::Input(InputFailure::InvalidValue {
            field: FieldPath(field.split('.').map(str::to_owned).collect()),
        }),
        Recovery::Refresh,
    )
}
