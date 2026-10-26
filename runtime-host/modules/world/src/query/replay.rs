use std::collections::BTreeSet;
use tokio_util::sync::CancellationToken;
use world_protocol::{
    authorization::{AccessMode, AccessScope, ActualImpact}, evaluation::EvaluationArm,
    ids::*, query::{QueryFailure, ReadReceipt}, releases::{BranchRef, WorldBranch},
};
use crate::{authorization::{self, Admission}, content::Content, extensions::invocation::CallBudget,
    sources::sync::BranchCapture, store::{WorldStore, WorldTransaction}};
use super::{QueryError, PreparedQuery, branch, execution, metadata,
    receipt::{self, CaptureSelection, ReadContext, ReadInput, ReadOrigin, StoredRead}};

/// Minted only by replaying a durable native read against this exact target and its real captures.
pub(crate) struct TargetRead {
    original: ReadReceipt, target: WorldBranch, captures: Vec<(DefinitionRef, Digest)>,
    result: TargetResult, budget: CallBudget, cancel: CancellationToken,
}
enum TargetResult { Query(PreparedQuery), Expression(StoredRead) }
impl TargetRead {
    pub(crate) fn original_id(&self) -> &ReadReceiptId { &self.original.id }
}

pub(crate) async fn replay_impact(tx: &WorldTransaction<'_>, branch: &WorldBranch) -> Result<Option<ActualImpact>, QueryError> {
    if branch.basis.read_receipts.is_empty() { return Ok(None); }
    let base = crate::releases::read_release(tx, &branch.basis.release_id).await?.ok_or(QueryFailure::BasisChanged)?;
    let (mut access, mut effects, mut labels, mut state, mut sources) = (Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for original in &branch.basis.read_receipts {
        let read = receipt::read_transaction(tx, &original.id).await?;
        if read.receipt != *original { return Err(QueryFailure::BasisChanged.into()); }
        let mut impact = read.impact.clone();
        let model = branch::selected_model(branch, base.clone(), &EvaluationArm::Candidate)?;
        let plan = branch::input_plan(&read.input, &model)?;
        merge(&mut impact, metadata::impact_for_transaction(tx, &plan, &model, &read.context.scope).await?);
        let old_model = if let (Some((reference, arm)), Some(seal)) = (&read.context.branch_model, &read.context.frozen_model) {
            let model = super::frozen::reload_plan(tx, reference, arm, seal).await?; require_model(&read, &model)?; model
        } else {
            let mut base = crate::releases::read_release(tx, &read.receipt.release_id).await?.ok_or(QueryFailure::BasisChanged)?;
            if let Some((reference, arm)) = &read.context.branch_model { let old = crate::releases::read_branch_revision(tx, reference).await?.ok_or(QueryFailure::BasisChanged)?; base = branch::selected_model(&old, base, arm)?; }
            else { base.source_branch = None; }
            require_model(&read, &base)?; base
        };
        let old_plan = branch::input_plan(&read.input, &old_model)?;
        merge(&mut impact, metadata::impact_for_transaction(tx, &old_plan, &old_model, &read.context.scope).await?);
        if read.context.branch_model.is_some() { merge(&mut impact, branch::stored_dependency_impact(tx, &read, &old_model).await?); }
        else if let Some(material) = crate::facts::support::dependency_impact(tx, &read.receipt.actual_dependencies, &old_model, &read.context.scope, &read.context.valid_time).await? { merge(&mut impact, material); }
        if let Some(input) = input_impact(&read)? { merge(&mut impact, input); }
        access.extend(impact.access); effects.extend(impact.effects); labels.extend(impact.labels); state.extend(impact.state); sources.extend(impact.source_ids);
    }
    Ok(Some(authorization::actual_impact(access, effects, labels, state, sources)?))
}

pub(crate) async fn replay_branch_reads(
    store: &WorldStore, content: &Content, admission: &Admission, target: &WorldBranch,
    captures: &[BranchCapture], budget: &CallBudget, cancel: &CancellationToken,
) -> Result<Vec<TargetRead>, QueryError> {
    for capture in captures {
        crate::sources::sync::verify_branch_capture(store, content, admission, capture, budget, cancel).await?;
    }
    let target_copy = target.clone(); let captures_copy = captures.to_vec(); let admission_copy = admission.clone();
    let budget_copy = budget.clone(); let cancel_copy = cancel.clone();
    let inputs = store.snapshot(target.world.clone(), move |snapshot| Box::pin(async move {
        let now = snapshot.now().await?;
        authorization::recheck_read(snapshot, &admission_copy, &now).await?;
        let mut inputs = Vec::new(); let mut seen = BTreeSet::new();
        for original in &target_copy.basis.read_receipts {
            check(&budget_copy, &cancel_copy)?;
            if !seen.insert(&original.id) { return Err(QueryFailure::BasisChanged.into()); }
            let read = receipt::read_snapshot(snapshot, &original.id).await?;
            if read.receipt != *original { return Err(QueryFailure::BasisChanged.into()); }
            admission_copy.require_access(&read.impact)?;
            if let Some(input) = input_impact(&read)? { admission_copy.require_access(&input)?; }
            let old = old_model_snapshot(snapshot, &admission_copy, &read).await?;
            let old_plan = branch::input_plan(&read.input, &old)?;
            admission_copy.require_access(&metadata::impact_for(snapshot, &old_plan, &old, &read.context.scope).await?)?;
            let (dependencies, captured) = receipt::dependency_inputs_snapshot(snapshot, &admission_copy, &read, &old, &now).await?;
            if let Some(captured) = captured { admission_copy.require_access(&captured)?; }
            if let Some(material) = crate::facts::support::dependency_impact_snapshot(snapshot, &dependencies, &old, &read.context.scope, &read.context.valid_time).await? { admission_copy.require_access(&material)?; }
            let evidence = dependencies.iter().filter_map(|dependency| match dependency { world_protocol::provenance::ReadDependency::Evidence { reference } => Some(reference.clone()), _ => None }).collect::<BTreeSet<_>>().into_iter().collect::<Vec<_>>();
            crate::facts::assertions::require_evidence_snapshot(snapshot, &admission_copy, &evidence, &read.context.scope, Some(&read.context.valid_time), &now).await?;
            let prepared = branch::target_inputs(snapshot, &admission_copy, &target_copy, &captures_copy, &read.input, &read.context, &budget_copy, &cancel_copy).await?;
            inputs.push((read, prepared));
        }
        Ok::<_, QueryError>(inputs)
    })).await?;
    let reference = BranchRef { world: target.world.clone(), id: target.id.clone(), revision: target.revision };
    let mut results = Vec::with_capacity(inputs.len());
    // The snapshot has ended before either native VM is run.
    for (read, inputs) in inputs {
        check(budget, cancel)?;
        let arm = EvaluationArm::Candidate;
        let at = read.context.valid_time.from.clone();
        let mut context = ReadContext::branch(&read.context.scope, read.context.valid_time.clone(), &reference, &arm, &inputs.captures, read.context.known_at.as_ref());
        context.capture_selection = CaptureSelection::Target;
        context.derivations = branch::derivation_basis(&inputs.derivations)?;
        let origin = ReadOrigin { receipt: read.receipt.clone(), input: read.input.clone(), context: read.context.clone() };
        let result = match &read.input {
            ReadInput::Query { request } => {
                let mut request = request.clone(); request.branch_id = Some(target.id.clone());
                request.release_id = Some(target.basis.release_id.clone()); request.valid_at = Some(at.clone()); request.page.cursor = None;
                let mut projection = branch::project(&inputs.release, &inputs.plan, &inputs.captures, &at, budget, cancel)?;
                branch::merge_derivations(&mut projection, &inputs.release, &inputs.plan, &inputs.derivations, &inputs.identities, &read.context.valid_time, &inputs.now, budget, cancel)?;
                let basis = inputs.captures.iter().map(|capture| capture.capture().basis.clone()).collect();
                let mut prepared = execution::assemble(admission, request, context, inputs.release, inputs.plan, projection, inputs.impact, Vec::new(), basis, inputs.freshness, inputs.now, at, budget, cancel)?;
                prepared.branch_captures = inputs.captures;
                prepared.branch_model = Some((reference.clone(), arm));
                prepared.read.origin = Some(origin);
                TargetResult::Query(prepared)
            },
            ReadInput::Expression { declarations, parameters, expressions, at, read_mode, known_at } => {
                let refs = expressions.iter().collect::<Vec<_>>();
                let (evaluation, stored) = branch::prepare_expression(admission, &reference, &arm, inputs.release, inputs.plan, &inputs.captures, &inputs.derivations, &inputs.identities, inputs.impact, declarations, parameters, &refs, &read.context.scope, budget, cancel, at, read_mode, known_at.as_ref(), inputs.freshness, inputs.now, CaptureSelection::Target, None)?;
                for (index, expression) in expressions.iter().enumerate() { evaluation.value(expression, &["expressions".into(), index.to_string()], at)?; }
                let mut stored = stored.ok_or(QueryFailure::BasisChanged)?;
                stored.origin = Some(origin);
                TargetResult::Expression(stored)
            },
        };
        results.push(TargetRead { original: read.receipt, target: target.clone(), captures: capture_keys(captures), result, budget: budget.clone(), cancel: cancel.clone() });
    }
    Ok(results)
}

pub(crate) async fn commit_target_read(
    tx: &mut WorldTransaction<'_>, admission: &Admission, target: &WorldBranch,
    captures: &[BranchCapture], read: TargetRead,
) -> Result<ReadReceipt, QueryError> {
    check(&read.budget, &read.cancel)?;
    let now = tx.now().await?; authorization::recheck(tx, admission, &now).await?;
    let reference = BranchRef { world: target.world.clone(), id: target.id.clone(), revision: target.revision };
    if read.target != *target || read.captures != capture_keys(captures)
        || crate::releases::read_branch_revision(tx, &reference).await?.as_ref() != Some(target)
        || !target.basis.read_receipts.contains(&read.original)
        || receipt::read_transaction(tx, &read.original.id).await?.receipt != read.original { return Err(QueryFailure::BasisChanged.into()); }
    let original = receipt::read_transaction(tx, &read.original.id).await?;
    admission.require_access(&original.impact)?;
    if let Some(input) = input_impact(&original)? { admission.require_access(&input)?; }
    let old_model = old_model_transaction(tx, admission, &original).await?;
    let old_plan = branch::input_plan(&original.input, &old_model)?;
    admission.require_access(&metadata::impact_for_transaction(tx, &old_plan, &old_model, &original.context.scope).await?)?;
    let (dependencies, captured) = receipt::dependency_inputs(tx, admission, &original, &old_model, &now).await?;
    if let Some(captured) = captured { admission.require_access(&captured)?; }
    if let Some(material) = crate::facts::support::dependency_impact(tx, &dependencies, &old_model, &original.context.scope, &original.context.valid_time).await? { admission.require_access(&material)?; }
    let evidence = dependencies.iter().filter_map(|dependency| match dependency { world_protocol::provenance::ReadDependency::Evidence { reference } => Some(reference.clone()), _ => None }).collect::<BTreeSet<_>>().into_iter().collect::<Vec<_>>();
    crate::facts::assertions::require_evidence_custody_transaction(tx, admission, &evidence, &original.context.scope, Some(&original.context.valid_time), &now).await?;
    for capture in captures {
        if capture.capture().branch != reference { return Err(QueryFailure::BasisChanged.into()); }
        capture.recheck(tx, admission, &now).await?;
    }
    let result = match read.result {
        TargetResult::Query(prepared) => execution::commit_read(tx, admission, prepared).await?.receipt,
        TargetResult::Expression(stored) => {
            tx.require_domain(&WriterDomain::try_new("query").map_err(|_| QueryFailure::InternalFault)?)?;
            receipt::require_current(&stored, admission, &now)?;
            let model = old_model_transaction(tx, admission, &stored).await?;
            receipt::recheck_dependencies(tx, admission, &stored, &model, &now).await?;
            receipt::recheck_output(tx, admission, &stored, &now).await?;
            receipt::persist(tx, admission, &stored).await?;
            stored.receipt
        },
    };
    if result.id == read.original.id || result.activation_lock_id != target.compile.activation_lock.id { return Err(QueryFailure::BasisChanged.into()); }
    Ok(result)
}

async fn old_model_transaction(tx: &WorldTransaction<'_>, admission: &Admission, read: &StoredRead) -> Result<world_protocol::releases::Release, QueryError> {
    let model = if read.context.branch_model.is_some() { branch::stored_model_transaction(tx, admission, read).await? }
        else { let mut base = crate::releases::read_release(tx, &read.receipt.release_id).await?.ok_or(QueryFailure::BasisChanged)?; base.source_branch = None; base };
    require_model(read, &model)?; Ok(model)
}
async fn old_model_snapshot(snapshot: &crate::store::WorldSnapshot<'_>, admission: &Admission, read: &StoredRead) -> Result<world_protocol::releases::Release, QueryError> {
    let model = if read.context.branch_model.is_some() { branch::stored_model_snapshot(snapshot, admission, read).await? }
        else { let mut base = crate::releases::read_release_snapshot(snapshot, &read.receipt.release_id).await?.ok_or(QueryFailure::BasisChanged)?; base.source_branch = None; base };
    require_model(read, &model)?; Ok(model)
}
fn require_model(read: &StoredRead, model: &world_protocol::releases::Release) -> Result<(), QueryError> {
    if model.artifact.activation_lock_id != read.receipt.activation_lock_id || execution::evaluated_scope_digest(&read.context, model, &read.impact)? != read.receipt.evaluated_scope_digest { return Err(QueryFailure::BasisChanged.into()); }
    Ok(())
}
fn input_impact(read: &StoredRead) -> Result<Option<ActualImpact>, QueryError> {
    let mut roots = crate::store::RetentionRoots::default(); read.input.retain(&mut roots);
    if roots.resources.is_empty() && roots.definitions.is_empty() { return Ok(None); }
    let access = vec![AccessScope { resources: roots.resources, fields: roots.definitions, modes: vec![AccessMode::Read], scope: read.context.scope.clone(), valid_time: Some(read.context.valid_time.clone()) }];
    Ok(Some(authorization::actual_impact(access, vec![world_protocol::expression::Effect::Pure], Vec::new(), Vec::new(), Vec::new())?))
}
fn merge(target: &mut ActualImpact, source: ActualImpact) {
    target.access.extend(source.access); target.effects.extend(source.effects); target.labels.extend(source.labels); target.state.extend(source.state); target.source_ids.extend(source.source_ids);
}
fn capture_keys(captures: &[BranchCapture]) -> Vec<(DefinitionRef, Digest)> { captures.iter().map(|capture| (capture.capture().binding.clone(), capture.capture().digest.clone())).collect() }
fn check(budget: &CallBudget, cancel: &CancellationToken) -> Result<(), QueryError> {
    if cancel.is_cancelled() { return Err(QueryFailure::Cancelled.into()); }
    budget.charge(world_protocol::budget::BudgetDimension::Steps, 1).map_err(execution::budget_error)
}
