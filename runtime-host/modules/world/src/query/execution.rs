use std::collections::BTreeSet;
use foundation::pipeline::PipelineContext;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use world_protocol::{authorization::ActualImpact, budget::BudgetDimension, identity::IdentityRecord, ids::*, provenance::ReadDependency, query::*, releases::Release, sources::{SourceBasis, SourceGuarantee}, time::{DurationMs, Timestamp}, value::DirtyState};
use crate::{authorization::{self, Admission}, content::Content, extensions::invocation::{BudgetFailure, CallBudget}, store::{StoreFuture, WorldStore, WorldTransaction}};
use super::{QueryError, engine, error::invalid, live, metadata, plan, projection, receipt::{self, StoredRead}};

/// Constructed only after real authorized reads; neither a guest DTO nor a cached receipt is authority.
pub(crate) struct PreparedQuery {
    pub(super) read: StoredRead, pub(super) release: Release, pub(super) request: QueryRequest, pub(super) scope: ScopeId,
    pub(super) ranges: Vec<(DefinitionId, Generation)>, offset: usize, pub(super) budget: CallBudget, pub(super) resumed: bool,
    pub(super) evaluation: Option<(plan::CheckedPlan, engine::EngineOutput, CancellationToken)>, pub(super) verifier: Option<DefinitionRef>,
    projection_proofs: Vec<super::ProjectionProof>, source_reads: Vec<crate::sources::connectors::ReadSourcePage>, after: Vec<SourceBasis>,
    source_projection: std::collections::BTreeMap<DefinitionRef, std::collections::BTreeMap<world_protocol::identity::SubjectRef, projection::ProjectedSubject>>,
    pub(super) branch_captures: Vec<crate::sources::sync::BranchCapture>, pub(super) branch_model: Option<(world_protocol::releases::BranchRef, world_protocol::evaluation::EvaluationArm)>,
    algorithm: Option<super::algorithm::AlgorithmRead>,
}
impl PreparedQuery {
    pub(crate) fn impact(&self) -> &ActualImpact { &self.read.impact }
    pub(crate) fn release(&self) -> &Release { &self.release }
    pub(crate) fn receipt(&self) -> &ReadReceipt { &self.read.receipt }
    pub(crate) fn branch_captures(&self) -> &[crate::sources::sync::BranchCapture] { &self.branch_captures }
    pub(crate) fn require_assertion_basis(&self, assertion: &world_protocol::facts::Assertion) -> Result<(), QueryError> {
        use world_protocol::{facts::{AssertionOrigin, Claim, Polarity}, identity::SubjectRef, value::Cell};
        let failure = || QueryError::from(QueryFailure::GuaranteeUnsatisfied { mode: ReadMode::Authoritative, source_id: None });
        if assertion.reference.world != self.request.world
            || !assertion.valid_time.contains(self.request.valid_at.as_ref().unwrap_or(&self.read.receipt.observed_at)) { return Err(failure()); }
        let AssertionOrigin::Source { binding, authority, .. } = &assertion.origin else { return Err(failure()); };
        let basis = self.read.receipt.basis.iter().find(|basis| basis.binding == *binding).ok_or_else(failure)?;
        let definition = self.release.definitions.iter().find(|definition| definition.reference == *binding).ok_or_else(failure)?;
        if !matches!(&definition.body, world_protocol::definitions::DefinitionBody::SourceBinding(body) if body.authority == *authority)
            || basis.authority_revision != authority.revision || basis.gap.is_some() || basis.guarantee != SourceGuarantee::Authoritative { return Err(failure()); }
        let actual = self.source_projection.get(binding).ok_or_else(failure)?;
        let matches = match &assertion.claim {
            Claim::Attribute(claim) => {
                let Some(Cell::Known { value }) = actual.get(&claim.subject).and_then(|subject| subject.fields.get(&claim.property)).map(|field| &field.cell) else { return Err(failure()); };
                let same = super::values::equal(value, &claim.value, &world_protocol::failure::FieldPath(vec!["explain".into(), "claim".into()]))?;
                match assertion.polarity {
                    Polarity::Positive => same,
                    Polarity::Negative => self.release.definitions.iter().any(|definition| definition.reference == claim.property && matches!(&definition.body, world_protocol::definitions::DefinitionBody::Property(body) if body.cardinality.maximum == Some(1))) && !same,
                }
            },
            Claim::Relation(claim) => {
                let Some(relation) = actual.get(&SubjectRef::Relation { id: claim.relation_id.clone() }).and_then(|subject| subject.relation.as_ref()) else { return Err(failure()); };
                if relation.type_ref != claim.relation_type || relation.cells.values().any(|cell| !matches!(cell, Cell::Known { .. })) { return Err(failure()); }
                let expected: BTreeSet<_> = claim.roles.iter().map(|role| (&role.role, &role.object_id)).collect();
                let same = relation.roles.iter().map(|role| (&role.role, &role.object_id)).collect::<BTreeSet<_>>() == expected;
                same == (assertion.polarity == Polarity::Positive)
            },
        };
        if !matches { return Err(failure()); }
        Ok(())
    }
}

pub(crate) fn capture_requests(release: &Release, bindings: &[DefinitionRef]) -> Result<Vec<QueryRequest>, QueryError> {
    use world_protocol::{definitions::DefinitionBody, expression::ExpressionIr, value::Value};
    let mut datasets = BTreeSet::new();
    for reference in bindings {
        let definition = release.definitions.iter().find(|definition| definition.reference == *reference).ok_or(QueryFailure::BasisChanged)?;
        let DefinitionBody::SourceBinding(binding) = &definition.body else { return Err(invalid("explain.binding")); };
        datasets.insert(binding.identity_mapping.type_id.clone());
    }
    let mut requests = Vec::new();
    for type_id in datasets {
        let definition = release.definitions.iter().find(|definition| definition.reference.id == type_id).ok_or(QueryFailure::BasisChanged)?;
        let symbol = SymbolId::try_new("source").map_err(|_| QueryFailure::InternalFault)?;
        let root = match &definition.body {
            DefinitionBody::ObjectType(_) => QueryNode::Objects { type_ref: definition.reference.clone(), symbol: symbol.clone() },
            DefinitionBody::RelationType(_) => QueryNode::Relations { type_ref: definition.reference.clone(), symbol: symbol.clone() },
            _ => return Err(invalid("explain.type")),
        };
        let fields: BTreeSet<_> = release.definitions.iter().filter_map(|definition| match &definition.body { DefinitionBody::SourceBinding(binding) if binding.identity_mapping.type_id == type_id => Some(binding.field_mapping.iter().map(|field| field.property.clone())), _ => None }).flatten().collect();
        let mut output: Vec<_> = fields.into_iter().enumerate().map(|(index, property)| QueryColumn { name: format!("field_{index}"), expression: ExpressionIr::Field { subject: symbol.clone(), property } }).collect();
        if output.is_empty() { output.push(QueryColumn { name: "present".into(), expression: ExpressionIr::Literal { value: Value::Boolean { value: true } } }); }
        requests.push(QueryRequest { world: definition.reference.world.clone(), branch_id: None, release_id: Some(release.id.clone()), query: QueryIr { root, parameters: Vec::new(), output, limit: world_protocol::api::MAX_PAGE_ITEMS }, arguments: Vec::new(), read_mode: ReadMode::Authoritative, valid_at: None, known_at: None, page: PageRequest { limit: world_protocol::api::MAX_PAGE_ITEMS, cursor: None } });
    }
    Ok(requests)
}

pub(crate) async fn capture_bindings(
    store: &WorldStore, brokers: Option<&super::SourceBrokers>, admission: &Admission, release_id: &ReleaseId,
    bindings: &[DefinitionRef], scope: &ScopeId, pipeline: &PipelineContext, budget: &CallBudget, cancel: &CancellationToken, deadline: Instant,
) -> Result<Vec<PreparedQuery>, QueryError> {
    let id = release_id.clone();
    let release = store.snapshot(admission.invocation().world.clone(), move |snapshot| Box::pin(async move {
        crate::releases::read_release_snapshot(snapshot, &id).await?.ok_or_else(|| QueryError::from(QueryFailure::BasisChanged))
    })).await?;
    let mut prepared = Vec::new();
    for request in capture_requests(&release, bindings)? {
        let read = execute_inner(store, brokers, admission, None, None, &request, scope, pipeline, budget, cancel, deadline, None, None).await?;
        if !read.receipt().coverage.complete || read.receipt().truncation.is_some() { return Err(QueryFailure::GuaranteeUnsatisfied { mode: ReadMode::Authoritative, source_id: None }.into()); }
        prepared.push(read);
    }
    Ok(prepared)
}

pub(crate) async fn execute(
    store: &WorldStore, content: &Content, brokers: Option<&super::SourceBrokers>, admission: &Admission, request: &QueryRequest,
    scope: &ScopeId, pipeline: &PipelineContext, budget: &CallBudget,
    cancel: &CancellationToken, deadline: Instant,
) -> Result<PreparedQuery, QueryError> {
    let verified = verify_branch_basis(store, content, admission, request, scope, budget, cancel).await?;
    execute_inner(store, brokers, admission, None, verified.as_ref(), request, scope, pipeline, budget, cancel, deadline, None, None).await
}
pub(crate) async fn execute_projected(
    store: &WorldStore, brokers: Option<&super::SourceBrokers>, admission: &Admission, request: &QueryRequest,
    scope: &ScopeId, pipeline: &PipelineContext, budget: &CallBudget, cancel: &CancellationToken,
    deadline: Instant, calls: super::ProjectionCalls,
) -> Result<PreparedQuery, QueryError> {
    if request.branch_id.is_some() || request.page.cursor.is_some() { return Err(invalid("query.projection")); }
    execute_inner(store, brokers, admission, None, None, request, scope, pipeline, budget, cancel, deadline, Some(calls), None).await
}
pub(super) async fn verify_branch_basis(store: &WorldStore, content: &Content, admission: &Admission, request: &QueryRequest, scope: &ScopeId, budget: &CallBudget, cancel: &CancellationToken) -> Result<Option<super::branch::VerifiedBasis>, QueryError> {
    budget.check().map_err(budget_error)?;
    if cancel.is_cancelled() { return Err(QueryFailure::Cancelled.into()); }
    if request.world != admission.invocation().world { return Err(invalid("world")); }
    if request.branch_id.is_some() {
        let saved_request = request.clone(); let saved_admission = admission.clone(); let saved_scope = scope.clone();
        let basis = store.snapshot(request.world.clone(), move |snapshot| Box::pin(async move {
            super::branch::query_basis_snapshot(snapshot, &saved_admission, &saved_request, &saved_scope).await
        })).await?;
        for capture in &basis.captures { crate::sources::sync::verify_branch_capture(store, content, admission, capture, budget, cancel).await?; }
        Ok(Some(basis))
    } else { Ok(None) }
}

pub(crate) async fn execute_verifier(
    store: &WorldStore, brokers: Option<&super::SourceBrokers>, admission: &Admission, contract: &DefinitionRef, request: &QueryRequest,
    scope: &ScopeId, pipeline: &PipelineContext, budget: &CallBudget, cancel: &CancellationToken, deadline: Instant,
) -> Result<PreparedQuery, QueryError> {
    if request.page.cursor.is_some() || request.branch_id.is_some() || request.known_at.is_some() { return Err(invalid("verifier.basis")); }
    execute_inner(store, brokers, admission, Some(contract), None, request, scope, pipeline, budget, cancel, deadline, None, None).await
}

pub(crate) async fn execute_resolved(
    store: &WorldStore, content: &Content, brokers: Option<&super::SourceBrokers>, admission: &Admission,
    request: &world_protocol::slots::ResolveQueryRequest, lock: &ActivationLockId, scope: &ScopeId, pipeline: &PipelineContext,
    budget: &CallBudget, cancel: &CancellationToken, deadline: Instant, calls: Option<super::ProjectionCalls>,
) -> Result<PreparedQuery, QueryError> {
    if request.budget != budget.limit() { return Err(QueryFailure::BasisChanged.into()); }
    let verified = verify_branch_basis(store, content, admission, &request.query, scope, budget, cancel).await?;
    execute_inner(store, brokers, admission, None, verified.as_ref(), &request.query, scope, pipeline, budget, cancel, deadline, calls, Some((lock.clone(), request.source_plans.clone()))).await
}
fn require_resolver_basis(release: &Release, plans: &[live::LiveRead], resolver: Option<&(ActivationLockId, Vec<world_protocol::sources::SourceReadPlan>)>) -> Result<(), QueryError> {
    if let Some((lock, expected)) = resolver {
        if &release.artifact.activation_lock_id != lock || plans.iter().map(|source| &source.plan).ne(expected.iter()) { return Err(QueryFailure::BasisChanged.into()); }
    }
    Ok(())
}
fn execute_inner<'a>(
    store: &'a WorldStore,
    brokers: Option<&'a super::SourceBrokers>,
    admission: &'a Admission,
    verifier: Option<&'a DefinitionRef>,
    verified: Option<&'a super::branch::VerifiedBasis>,
    request: &'a QueryRequest,
    scope: &'a ScopeId,
    pipeline: &'a PipelineContext,
    budget: &'a CallBudget,
    cancel: &'a CancellationToken,
    deadline: Instant,
    calls: Option<super::ProjectionCalls>,
    resolver: Option<(ActivationLockId, Vec<world_protocol::sources::SourceReadPlan>)>,
) -> StoreFuture<'a, PreparedQuery, QueryError> {
    Box::pin(async move {
        if request.world != admission.invocation().world || request.page.limit == 0 || request.page.limit > world_protocol::api::MAX_PAGE_ITEMS { return Err(invalid("world")); }
        budget.check().map_err(budget_error)?;
        let query_digest = query_digest(request)?;
        let request = request.clone(); let admission = admission.clone(); let scope = scope.clone();
        if let Some(cursor) = &request.page.cursor {
            let (id, offset) = receipt::cursor(cursor)?;
            let saved_request = request.clone(); let saved_admission = admission.clone(); let saved_scope = scope.clone(); let verified = verified.cloned();
            let (read, release) = store.snapshot(request.world.clone(), move |snapshot| Box::pin(async move {
                let now = snapshot.now().await?;
                authorization::recheck_read(snapshot, &saved_admission, &now).await?;
                if saved_request.branch_id.is_some() { verified.as_ref().ok_or(QueryFailure::BasisChanged)?.recheck_snapshot(snapshot, &saved_admission, &saved_request, &saved_scope).await?; }
                let read = receipt::read_snapshot(snapshot, &id).await?;
                receipt::require_current(&read, &saved_admission, &now)?;
                if read.receipt.query_digest != query_digest { return Err(QueryFailure::CursorInvalid.into()); }
                let (release, current) = if saved_request.branch_id.is_some() {
                    super::branch::retained_snapshot(snapshot, &saved_admission, &saved_request, &saved_scope, &read).await?
                } else {
                    let release = metadata::release(snapshot, &saved_request).await?;
                    let plan = plan::check(&saved_request.query, &release)?;
                    let current = metadata::impact_for(snapshot, &plan, &release, &saved_scope).await?;
                    (release, current)
                };
                require_resolver_basis(&release, &[], resolver.as_ref())?;
                saved_admission.require_access(&current)?;
                if read.context.scope != saved_scope || evaluated_scope_digest(&read.context, &release, &read.impact)? != read.receipt.evaluated_scope_digest { return Err(QueryFailure::CursorInvalid.into()); }
                if read.receipt.release_id != release.id || read.receipt.activation_lock_id != release.artifact.activation_lock_id { return Err(QueryFailure::CursorInvalid.into()); }
                authorization::check_admitted_output_read(snapshot, &saved_admission, &read.impact, read.rows.len() as u64, &now).await?;
                Ok::<_, QueryError>((read, release))
            })).await?;
            return Ok(PreparedQuery { read, release, request, scope, ranges: Vec::new(), offset, budget: budget.clone(), resumed: true, evaluation: None, verifier: None, projection_proofs: Vec::new(), source_reads: Vec::new(), after: Vec::new(), source_projection: std::collections::BTreeMap::new(), branch_captures: Vec::new(), branch_model: None, algorithm: None });
        }
        if let Some(id) = &request.branch_id {
            let id = id.clone(); let request = request.clone(); let admission = admission.clone(); let scope = scope.clone(); let budget = budget.clone(); let cancel = cancel.clone(); let verified = verified.cloned().ok_or(QueryFailure::BasisChanged)?;
            return store.snapshot(request.world.clone(), move |snapshot| Box::pin(async move {
                let branch = crate::releases::read_branch_snapshot(snapshot, &id).await?.ok_or(QueryFailure::BasisChanged)?;
                let branch = world_protocol::releases::BranchRef { world: branch.world, id: branch.id, revision: branch.revision };
                let prepared = super::branch::execute_snapshot(snapshot, &admission, &branch, &request, &scope, &budget, &cancel, &verified).await?;
                require_resolver_basis(prepared.release(), &[], resolver.as_ref())?;
                Ok(prepared)
            })).await;
        }
        let saved_request = request.clone(); let saved_admission = admission.clone(); let saved_scope = scope.clone(); let saved_cancel = cancel.clone();
        let maximum = budget.limit().max_rows;
        let saved_verifier = verifier.cloned();
        let saved_budget = budget.clone();
        let algorithm = calls.is_some();
        let (release, checked, mut projection, candidates, plans, mut basis, mut freshness, ranges, observed_at, valid_at, mut impact, use_live, mut projection_proofs, after) = store.snapshot(request.world.clone(), move |snapshot| Box::pin(async move {
            let now = snapshot.now().await?;
            authorization::recheck_read(snapshot, &saved_admission, &now).await?;
            let valid_at = saved_request.valid_at.clone().unwrap_or_else(|| now.clone());
            let release = metadata::release(snapshot, &saved_request).await?;
            let plan = match &saved_verifier { Some(contract) => plan::verifier(&saved_request.query, &release, contract)?, None => plan::check(&saved_request.query, &release)? };
            let impact = metadata::impact_for(snapshot, &plan, &release, &saved_scope).await?;
            saved_admission.require_access(&impact)?;
            let (mut projection, candidates) = projection::read(snapshot, &plan, &release, &saved_scope, &valid_at, saved_request.known_at.as_ref(), &saved_admission, maximum, &saved_budget, &saved_cancel, algorithm).await?;
            let mut ranges = Vec::new();
            for dataset in &plan.datasets {
                let row = snapshot.query_opt("SELECT generation FROM world_watch_partition WHERE tenant_id=$1 AND world_id=$2 AND dataset_id=$3 AND partition_key=''", &[&snapshot.world().tenant_id.as_str(), &snapshot.world().world_id.as_str(), &dataset.id.as_str()]).await?;
                ranges.push((dataset.id.clone(), Generation(row.map_or(0, |row| row.get::<_, i64>("generation") as u64))));
            }
            let mut projection_proofs = Vec::new(); let mut after = Vec::new();
            let plans = live::plans(snapshot, &plan, &release, saved_request.known_at.as_ref(), maximum).await?;
            require_resolver_basis(&release, &plans, resolver.as_ref())?;
            let mut basis = Vec::new(); let mut freshness = Vec::new();
            let mut use_live = matches!(saved_request.read_mode, ReadMode::Authoritative);
            for source in &plans {
                let frontiers = crate::sources::sync::frontier(snapshot, &source.binding.reference).await?;
                if frontiers.is_empty() { use_live = true; }
                for frontier in frontiers {
                    let source_body = &source.binding.body;
                    let lag = frontier.last_reconciled_at.as_ref().map(|at| DurationMs(((now.unix_nanos() - at.unix_nanos()).max(0) / 1_000_000).min(u64::MAX as i128) as u64));
                    let satisfied = frontier.checkpoint.source.gap.is_none() && match &saved_request.read_mode {
                        ReadMode::Projected { max_lag } => lag.is_some_and(|lag| lag <= *max_lag),
                        _ => true,
                    };
                    let generation = ranges.iter().find(|(id, _)| id == &source.mapping.type_ref.id).map_or(Generation(0), |(_, generation)| *generation);
                    let proof = super::frontier::prepare(snapshot, &mut projection, &plan, &saved_scope, source, &frontier, generation, &saved_admission, &valid_at, algorithm.then_some(candidates.as_slice())).await?;
                    let satisfied = satisfied && proof.is_some() && saved_request.known_at.is_none();
                    use_live |= !satisfied;
                    if let Some(proof) = proof { basis.push(proof.basis().clone()); projection_proofs.push(proof); }
                    freshness.push(SourceFreshness { source_id: source_body.source_id.clone(), lag, last_reconciled_at: frontier.last_reconciled_at, satisfied });
                }
            }
            if let ReadMode::After { receipt_id } = &saved_request.read_mode {
                let previous = receipt::read_snapshot(snapshot, receipt_id).await?;
                receipt::require_current(&previous, &saved_admission, &now)?;
                for source in &previous.receipt.basis {
                    if source.position.is_none() { return Err(QueryFailure::GuaranteeUnsatisfied { mode: saved_request.read_mode.clone(), source_id: Some(source.source_id.clone()) }.into()); }
                    after.push(source.clone());
                }
            }
            Ok::<_, QueryError>((release, plan, projection, candidates, plans, basis, freshness, ranges, now, valid_at, impact, use_live, projection_proofs, after))
        })).await?;
        let mut source_reads = Vec::new();
        let mut source_projection = std::collections::BTreeMap::new();
        // No database transaction or snapshot survives across this source I/O boundary.
        if use_live && !plans.is_empty() {
            projection_proofs.clear();
            let mut pages = Vec::new();
            for source in &plans {
                let broker = brokers.and_then(|brokers| brokers.get(&source.binding.body.connector))
                    .ok_or_else(|| QueryFailure::GuaranteeUnsatisfied { mode: request.read_mode.clone(), source_id: Some(source.binding.body.source_id.clone()) })?;
                pages.push(live::capture(broker, source, &admission, pipeline, cancel, deadline, budget).await?);
            }
            let saved_admission = admission.clone(); let saved_scope = scope.clone(); let saved_at = valid_at.clone(); let saved_release = release.clone();
            let saved_plans = plans; let saved_basis: Vec<_> = pages.iter().map(|page| page.page().basis.clone()).collect();
            let saved_budget = budget.clone(); let saved_cancel = cancel.clone();
            let algorithm_fields = algorithm.then(|| checked.fields.clone());
            (projection, source_reads, source_projection) = store.snapshot(request.world.clone(), move |snapshot| Box::pin(async move {
                let now = snapshot.now().await?; authorization::recheck_read(snapshot, &saved_admission, &now).await?;
                let mut captured = std::collections::BTreeMap::new();
                for (source, read) in saved_plans.iter().zip(&pages) {
                    captured.insert(source.binding.reference.clone(), live::overlay(snapshot, &mut projection, source, read, &saved_scope, &saved_at, &saved_release, &saved_admission, &saved_budget, &saved_cancel, algorithm_fields.as_ref()).await?);
                }
                Ok::<_, QueryError>((projection, pages, captured))
            })).await?;
            basis = saved_basis;
            freshness = basis.iter().map(|source| SourceFreshness { source_id: source.source_id.clone(), lag: Some(DurationMs(0)), last_reconciled_at: source.last_reconciled_at.clone(), satisfied: true }).collect();
        }
        let algorithm = if let Some(calls) = calls {
            Some(super::algorithm::project(store, &admission, calls, &release, &checked, &scope, projection::point(&valid_at)?, request.known_at.clone(), &mut projection, candidates, &source_projection, &basis, &mut impact, cancel).await?)
        } else { None };
        let assembled = (|| {
            for proof in &projection_proofs { proof.require_ready(&projection, &request.read_mode)?; }
            let context = receipt::ReadContext { scope, valid_time: projection::point(&valid_at)?, known_at: request.known_at.clone(), branch_model: None, frozen_model: None, captures: Vec::new(), capture_selection: receipt::CaptureSelection::Selected, derivations: Vec::new() };
            assemble(&admission, request, context, release, checked, projection, impact, ranges, basis, freshness, observed_at, valid_at, budget, cancel)
        })();
        let mut result = match assembled { Ok(result) => result, Err(error) => return Err(match algorithm { Some(algorithm) => algorithm.retain_failure(error), None => error }) };
        result.projection_proofs = projection_proofs; result.source_reads = source_reads; result.source_projection = source_projection; result.after = after; result.verifier = verifier.cloned(); result.algorithm = algorithm;
        Ok(result)
    })
}

pub(super) fn assemble(
    admission: &Admission, request: QueryRequest, context: receipt::ReadContext, release: Release, checked: plan::CheckedPlan,
    mut projection: projection::Projection, impact: ActualImpact, ranges: Vec<(DefinitionId, Generation)>,
    basis: Vec<SourceBasis>, freshness: Vec<SourceFreshness>, observed_at: Timestamp, valid_at: Timestamp,
    budget: &CallBudget, cancel: &CancellationToken,
) -> Result<PreparedQuery, QueryError> {
    if cancel.is_cancelled() { return Err(QueryFailure::Cancelled.into()); }
    let query_digest = query_digest(&request)?;
    for reference in checked.datasets.iter().chain(&checked.fields).chain(checked.functions.keys()) {
        let definition = release.definitions.iter().find(|definition| definition.reference == *reference).ok_or(QueryFailure::BasisChanged)?;
        crate::definitions::validate_applicability(definition, &context.scope, &context.valid_time, &release.scopes).map_err(crate::definitions::DefinitionError::from)?;
        let dependency = ReadDependency::Definition { reference: reference.clone() };
        if !projection.dependencies.contains(&dependency) { projection.dependencies.push(dependency); }
    }
    if let Some(at) = super::watch::time_boundary(&checked, &projection, &valid_at)? { projection.dependencies.push(ReadDependency::TimeBoundary { at }); }
    let output = engine::run(&checked, &release, &projection, &request.arguments, &valid_at, budget, cancel)?;
    let mut actual_impact = impact;
    actual_impact.labels.extend(projection.labels.clone()); actual_impact.source_ids.extend(projection.sources.iter().cloned());
    actual_impact = authorization::actual_impact(actual_impact.access, actual_impact.effects, actual_impact.labels, actual_impact.state, actual_impact.source_ids)?;
    admission.require_access(&actual_impact)?;
    let scope = context.scope.clone();
    let scope_digest = evaluated_scope_digest(&context, &release, &actual_impact)?;
    let id = ReadReceiptId::try_new(uuid::Uuid::new_v4().to_string()).map_err(|_| QueryFailure::InternalFault)?;
    let (objects, relations, dirty) = views(&projection, &output.subjects, &id)?;
    let receipt = ReadReceipt { world: request.world.clone(), id, branch_id: request.branch_id.clone(), release_id: release.id.clone(), activation_lock_id: release.artifact.activation_lock_id.clone(), query_digest, evaluated_scope_digest: scope_digest.clone(), decision_id: admission.decision().id.clone(), policy_epoch: admission.decision().policy_epoch, grant_epoch: admission.decision().grant_epoch,
        observed_at, expires_at: admission.decision().expires_at.clone(), requested_mode: request.read_mode.clone(), basis, projection_generation: None, actual_dependencies: projection.dependencies,
        coverage: QueryCoverage { scope_digest, complete: !output.incomplete && dirty.is_empty(), missing_sources: Vec::new(), missing_fields: Vec::new(), gap_sources: Vec::new() }, freshness, dirty: dirty.into_iter().collect(), truncation: output.truncated.then(|| Truncation { reason: TruncationReason::Rows, delivered: output.rows.len() as u64, limit: request.query.limit as u64 }),
        consistency: if request.branch_id.is_some() { ConsistencyBasis::BranchAssumptions } else if request.known_at.is_some() { ConsistencyBasis::RecordedReplay } else { ConsistencyBasis::PerSource } };
    let actor = match &admission.invocation().actor { world_protocol::authorization::Actor::Human { id } | world_protocol::authorization::Actor::Service { id } => id.clone() };
    let input = receipt::ReadInput::Query { request: request.clone() };
    let rows = output.rows.clone();
    let row_subjects = output.row_subjects.clone();
    Ok(PreparedQuery { read: StoredRead { receipt, rows, row_subjects, objects, relations, impact: actual_impact, actor, context, input, origin: None }, release, request, scope, ranges, offset: 0, budget: budget.clone(), resumed: false, evaluation: Some((checked, output, cancel.clone())), verifier: None, projection_proofs: Vec::new(), source_reads: Vec::new(), after: Vec::new(), source_projection: std::collections::BTreeMap::new(), branch_captures: Vec::new(), branch_model: None, algorithm: None })
}

pub(super) fn views(projection: &projection::Projection, subjects: &BTreeSet<world_protocol::identity::SubjectRef>, id: &ReadReceiptId) -> Result<(Vec<ObjectView>, Vec<RelationView>, BTreeSet<WatchId>), QueryError> {
    let mut objects = Vec::new(); let mut relations = Vec::new(); let mut dirty = BTreeSet::new();
    for subject in subjects {
        let projected = projection.subjects.get(subject).ok_or(QueryFailure::BasisChanged)?;
        let fields: Vec<_> = projected.fields.values().cloned().collect();
        for field in &fields { if let DirtyState::Dirty { watches, .. } = &field.dirty { dirty.extend(watches.iter().cloned()); } }
        match &projected.identity.record {
            IdentityRecord::Object(object) => objects.push(ObjectView { object: object.clone(), fields, receipt_id: id.clone() }),
            IdentityRecord::Relation(relation) => {
                let roles = projected.relation.as_ref().map(|relation| relation.roles.clone()).unwrap_or_default();
                relations.push(RelationView { relation: relation.clone(), claim: projected.relation.as_ref().and_then(|relation| relation.claim.clone()), roles, fields, receipt_id: id.clone() });
            },
        }
    }
    Ok((objects, relations, dirty))
}
pub(crate) async fn commit_read(tx: &mut WorldTransaction<'_>, admission: &Admission, prepared: PreparedQuery) -> Result<QueryPage, QueryError> {
    match commit_read_inner(tx, admission, &prepared).await {
        Ok(page) => Ok(page),
        Err(error) => Err(match prepared.algorithm { Some(algorithm) => algorithm.retain_failure(error), None => error }),
    }
}
fn commit_read_inner<'a>(
    tx: &'a mut WorldTransaction<'_>,
    admission: &'a Admission,
    prepared: &'a PreparedQuery
) -> StoreFuture<'a, QueryPage, QueryError> {
    Box::pin(async move {
        tx.require_domain(&WriterDomain::try_new("query").map_err(|_| QueryFailure::InternalFault)?)?;
        prepared.budget.check().map_err(budget_error)?;
        let now = tx.now().await?;
        authorization::recheck(tx, admission, &now).await?;
        receipt::require_current(&prepared.read, admission, &now)?;
        if tx.world() != &prepared.request.world { return Err(invalid("world")); }
        let mut read = prepared.read.clone();
        if !prepared.resumed {
            if let Some(algorithm) = &prepared.algorithm { algorithm.recheck(tx, admission).await?; }
            receipt::recheck_dependencies(tx, admission, &read, &prepared.release, &now).await?;
            if prepared.branch_model.is_some() {
                let current = super::branch::recheck_receipt(tx, admission, &prepared.read, &now).await?;
                if current != prepared.release { return Err(QueryFailure::BasisChanged.into()); }
                for capture in &prepared.branch_captures { capture.recheck(tx, admission, &now).await?; }
                super::branch::recheck_guarantees(tx, admission, &prepared.request, &prepared.branch_captures, &now).await?;
            }
            for read in &prepared.source_reads { read.recheck(tx, admission, &now).await?; }
            for proof in &prepared.projection_proofs { crate::sources::sync::publish_projection(tx, admission, proof, &now).await?; }
            for previous in &prepared.after {
                let current = read.receipt.basis.iter().find(|basis| basis.binding == previous.binding && basis.position.as_ref().map(|position| &position.partition) == previous.position.as_ref().map(|position| &position.partition))
                    .ok_or_else(|| QueryFailure::GuaranteeUnsatisfied { mode: prepared.request.read_mode.clone(), source_id: Some(previous.source_id.clone()) })?;
                crate::sources::sync::require_basis_after(current, previous)?;
                crate::sources::sync::require_after_transaction(tx, &previous.binding, previous.position.as_ref().ok_or(QueryFailure::BasisChanged)?).await?;
            }
        }
        if prepared.resumed { receipt::recheck_dependencies(tx, admission, &read, &prepared.release, &now).await?; }
        if prepared.resumed && prepared.request.branch_id.is_some() {
            let current = super::branch::retained_transaction(tx, admission, &prepared.request, &prepared.scope, &prepared.read).await?;
            admission.require_access(&current)?;
            authorization::check_admitted_output(tx, admission, &current, prepared.read.rows.len() as u64, &now).await?;
        }
        receipt::recheck_output(tx, admission, &read, &now).await?;
        if !prepared.resumed {
            super::watch::register_query(tx, admission, prepared, &mut read, &now).await?;
            receipt::persist(tx, admission, &read).await?;
        }
        let page = receipt::page(&read, prepared.offset, prepared.request.page.limit)?;
        let mut bytes = Counter(0);
        serde_json::to_writer(&mut bytes, &page).map_err(|_| QueryFailure::InternalFault)?;
        prepared.budget.charge(BudgetDimension::Bytes, bytes.0).map_err(budget_error)?;
        Ok(page)
    })
}

pub(super) fn query_digest(request: &QueryRequest) -> Result<Digest, QueryError> {
    Ok(crate::definitions::canonical_digest(&("world.query.v1", &request.world, &request.branch_id, &request.release_id, &request.query, &request.arguments, &request.read_mode, &request.valid_at, &request.known_at))?)
}
pub(super) fn evaluated_scope_digest(context: &receipt::ReadContext, release: &Release, impact: &ActualImpact) -> Result<Digest, QueryError> {
    Ok(crate::definitions::canonical_digest(&("world.query.scope.v2", context, &release.id, &release.artifact.activation_lock_id, &release.definitions, &release.scopes, impact))?)
}

pub(super) fn budget_error(error: BudgetFailure) -> QueryError {
    QueryFailure::BudgetExceeded { limit: match error.dimension { BudgetDimension::Rows => TruncationReason::Rows, BudgetDimension::Bytes => TruncationReason::Bytes, BudgetDimension::InputTokens | BudgetDimension::OutputTokens => TruncationReason::Tokens, _ => TruncationReason::Deadline } }.into()
}
struct Counter(u64);
impl std::io::Write for Counter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> { self.0 = self.0.checked_add(bytes.len() as u64).ok_or_else(|| std::io::Error::other("query byte count overflow"))?; Ok(bytes.len()) }
    fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
}
