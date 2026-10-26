use tokio_util::sync::CancellationToken;
use world_protocol::{
    api::EvaluateRuleRequest, authorization::ActualImpact, facts::{Claim, Polarity}, ids::*,
    provenance::{QueryWatch, ReadDependency, SupportStatus}, query::{QueryArgument, QueryFailure},
    releases::{BranchRef, Release, ReleaseHead}, time::ValidTime,
};
use crate::{authorization::{self, Admission, VerifiedInvocation}, extensions::invocation::CallBudget, store::WorldTransaction};
use super::{QueryError, error::invalid};

/// Retained observations only; deserialization cannot recover a derivation proof.
#[derive(Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RuleDerivationBasis {
    pub(crate) world: WorldRef, pub(crate) release_id: ReleaseId, pub(crate) rule: DefinitionRef,
    pub(crate) arguments: Vec<QueryArgument>, pub(crate) scope: ScopeId, pub(crate) valid_time: ValidTime,
    pub(crate) status: SupportStatus, pub(crate) conclusion: Option<(Claim, Polarity)>,
    pub(crate) dependencies: Vec<ReadDependency>, pub(crate) read_impact: ActualImpact,
    pub(crate) active_head: Option<ReleaseHead>, pub(crate) activation_lock_id: ActivationLockId,
    pub(crate) model_digest: Digest, pub(crate) capture_witness: Vec<(DefinitionRef, Digest)>,
    pub(crate) branch_inputs: Vec<(AssertionRef, Digest)>,
    pub(crate) watch_fingerprint: Digest, pub(crate) read_basis: Digest,
}

/// A plan contains observations, never authority to write a conclusion.
pub(crate) struct RulePreflight { derivation: RuleDerivation, fingerprint: Digest }
impl RulePreflight {
    pub(crate) fn derivation(&self) -> &RuleDerivation { &self.derivation }
    pub(crate) fn fingerprint(&self) -> Digest { self.fingerprint.clone() }
}

pub(crate) struct RuleDerivationSegment {
    valid_time: ValidTime, read_dependencies: Vec<ReadDependency>, dependencies: Vec<ReadDependency>,
}
impl RuleDerivationSegment {
    pub(crate) fn valid_time(&self) -> &ValidTime { &self.valid_time }
    pub(crate) fn read_dependencies(&self) -> &[ReadDependency] { &self.read_dependencies }
    pub(crate) fn dependencies(&self) -> &[ReadDependency] { &self.dependencies }
}

pub(crate) struct RuleDerivation {
    world: WorldRef, release_id: ReleaseId, rule: DefinitionRef, arguments: Vec<QueryArgument>,
    scope: ScopeId, valid_time: ValidTime, status: SupportStatus, conclusion: Option<(Claim, Polarity)>,
    segments: Vec<RuleDerivationSegment>, dependencies: Vec<ReadDependency>, read_dependencies: Vec<ReadDependency>, read_impact: ActualImpact, active_head: Option<ReleaseHead>, model: Release,
    activation_lock_id: ActivationLockId, model_digest: Digest, capture_witness: Vec<(DefinitionRef, Digest)>, branch_inputs: Vec<(AssertionRef, Digest)>, watch_fingerprint: Digest, watch_basis: Option<(WatchId, Option<QueryWatch>)>, read_basis: Digest,
}
impl RuleDerivation {
    pub(crate) fn world(&self) -> &WorldRef { &self.world }
    pub(crate) fn release_id(&self) -> &ReleaseId { &self.release_id }
    pub(crate) fn branch_id(&self) -> Option<&BranchId> { self.model.source_branch.as_ref().map(|branch| &branch.id) }
    pub(crate) fn branch_model(&self) -> Option<&Release> { self.model.source_branch.as_ref().map(|_| &self.model) }
    pub(crate) fn model_digest(&self) -> &Digest { &self.model_digest }
    pub(crate) fn capture_witness(&self) -> &[(DefinitionRef, Digest)] { &self.capture_witness }
    pub(crate) fn rule(&self) -> &DefinitionRef { &self.rule }
    pub(crate) fn arguments(&self) -> &[QueryArgument] { &self.arguments }
    pub(crate) fn scope(&self) -> &ScopeId { &self.scope }
    pub(crate) fn valid_time(&self) -> &ValidTime { &self.valid_time }
    pub(crate) fn status(&self) -> SupportStatus { self.status }
    pub(crate) fn conclusion(&self) -> Option<&(Claim, Polarity)> { self.conclusion.as_ref() }
    pub(crate) fn segments(&self) -> &[RuleDerivationSegment] { &self.segments }
    pub(crate) fn dependencies(&self) -> &[ReadDependency] { &self.dependencies }
    pub(crate) fn read_dependencies(&self) -> &[ReadDependency] { &self.read_dependencies }
    pub(crate) fn read_impact(&self) -> &ActualImpact { &self.read_impact }
    pub(crate) fn active_head(&self) -> Option<&ReleaseHead> { self.active_head.as_ref() }
    pub(crate) fn activation_lock_id(&self) -> &ActivationLockId { &self.activation_lock_id }
    pub(crate) fn watch_fingerprint(&self) -> &Digest { &self.watch_fingerprint }
    pub(crate) fn watch_basis(&self) -> Option<(&WatchId, Option<&QueryWatch>)> { self.watch_basis.as_ref().map(|(id, watch)| (id, watch.as_ref())) }
    pub(crate) fn retained_fingerprint_basis(&self) -> Result<RuleDerivationBasis, QueryError> {
        Ok(RuleDerivationBasis { world: self.world.clone(), release_id: self.release_id.clone(), rule: self.rule.clone(),
            arguments: self.arguments.clone(), scope: self.scope.clone(), valid_time: self.valid_time.clone(), status: self.status,
            conclusion: self.conclusion.clone(), dependencies: self.dependencies.clone(), read_impact: self.read_impact.clone(),
            active_head: self.active_head.clone(), activation_lock_id: self.activation_lock_id.clone(), model_digest: self.model_digest.clone(),
            capture_witness: self.capture_witness.clone(), branch_inputs: self.branch_inputs.clone(), watch_fingerprint: self.watch_fingerprint.clone(), read_basis: self.read_basis.clone() })
    }
    pub(crate) fn fingerprint(&self) -> Result<Digest, QueryError> {
        Ok(crate::definitions::canonical_digest(&self.retained_fingerprint_basis()?)?)
    }
}

/// Only this transaction and its final decision may consume the real evaluation.
pub(crate) struct RuleDerivationProof {
    transaction: String, decision: DecisionId, derivation: RuleDerivation, request: EvaluateRuleRequest,
    expected: Digest, budget: CallBudget, cancel: CancellationToken,
}
impl RuleDerivationProof {
    pub(crate) async fn consume(self, tx: &WorldTransaction<'_>, admission: &Admission) -> Result<RuleDerivation, QueryError> {
        if self.derivation.world != *tx.world() || self.transaction != super::rule::transaction_id(tx).await?
            || self.decision != admission.decision().id { return Err(QueryFailure::BasisChanged.into()); }
        let now = tx.now().await?;
        authorization::recheck(tx, admission, &now).await?;
        admission.require_access(&self.derivation.read_impact)?;
        let branch = self.derivation.model.source_branch.as_ref();
        let (model, head) = read_model(tx, branch, &self.request).await?;
        if head != self.derivation.active_head || model.artifact.activation_lock_id != self.derivation.activation_lock_id
            || crate::definitions::canonical_digest(&model)? != self.derivation.model_digest { return Err(QueryFailure::BasisChanged.into()); }
        let (current, _) = evaluate(tx, super::current::ReadAuthority::Admitted(admission), &self.request, branch, &self.budget, &self.cancel).await?;
        if current.fingerprint()? != self.expected { return Err(QueryFailure::BasisChanged.into()); }
        Ok(self.derivation)
    }
}

pub(crate) async fn preflight_rule(
    tx: &WorldTransaction<'_>, verified: &VerifiedInvocation, request: &EvaluateRuleRequest, branch: Option<&BranchRef>,
    budget: &CallBudget, cancel: &CancellationToken,
) -> Result<RulePreflight, QueryError> {
    let (derivation, _) = evaluate(tx, super::current::ReadAuthority::Verified(verified), request, branch, budget, cancel).await?;
    let fingerprint = derivation.fingerprint()?;
    Ok(RulePreflight { derivation, fingerprint })
}

pub(crate) async fn preflight_support_rule(
    tx: &WorldTransaction<'_>, verified: &VerifiedInvocation, support: &world_protocol::provenance::SupportSet,
    whole: &ValidTime, budget: &CallBudget, cancel: &CancellationToken,
) -> Result<RulePreflight, QueryError> {
    budget.check().map_err(super::execution::budget_error)?;
    if cancel.is_cancelled() { return Err(QueryFailure::Cancelled.into()); }
    if verified.invocation().world != *tx.world() || verified.invocation().branch_id.is_some() || support.branch_id.is_some()
        || support.reference.world != *tx.world() || support.conclusion.world != *tx.world() || support.rule.world != *tx.world()
        || whole.to.as_ref().is_some_and(|to| to <= &whole.from) { return Err(world_protocol::provenance::ProvenanceFailure::CrossScope.into()); }
    let now = tx.now().await?;
    let authority = super::current::ReadAuthority::Verified(verified);
    let seed = authorization::actual_impact(vec![world_protocol::authorization::AccessScope {
        resources: vec![ResourceRef::Assertion { id: support.conclusion.id.clone() }, ResourceRef::Support { id: support.reference.id.clone() }, ResourceRef::Definition { id: support.rule.id.clone() }],
        fields: Vec::new(), modes: vec![world_protocol::authorization::AccessMode::Read], scope: support.scope.clone(), valid_time: Some(whole.clone()),
    }], vec![world_protocol::expression::Effect::Pure], Vec::new(), Vec::new(), Vec::new())?;
    authority.check(tx, &seed, &now).await?;
    let stored = tx.query_opt("SELECT r.body FROM world_support_head h JOIN world_support_revision r USING(tenant_id,world_id,support_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 AND h.support_id=$3 FOR SHARE OF h", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &support.reference.id.as_str()]).await?.ok_or(world_protocol::provenance::ProvenanceFailure::MissingPremise)?;
    let stored: world_protocol::provenance::SupportSet = super::error::decode(stored.get("body"))?;
    let conclusion = crate::facts::assertions::read_assertion(tx, &support.conclusion).await?.ok_or(world_protocol::provenance::ProvenanceFailure::MissingPremise)?;
    if stored != *support || conclusion.scope != support.scope || conclusion.valid_time != *whole
        || !matches!(conclusion.origin, world_protocol::facts::AssertionOrigin::Derived {})
        || !crate::definitions::valid_time_contains(whole, &support.valid_time) { return Err(QueryFailure::BasisChanged.into()); }
    let head = crate::releases::read_active_head(tx).await?.ok_or(QueryFailure::BasisChanged)?;
    let release = super::current::release(tx, &support.release_id, None).await?;
    let definition = release.definitions.iter().find(|item| item.reference == support.rule).ok_or_else(|| invalid("support.rule"))?;
    let world_protocol::definitions::DefinitionBody::Rule(rule) = &definition.body else { return Err(invalid("support.rule")); };
    let request = EvaluateRuleRequest { release_id: support.release_id.clone(), rule: support.rule.clone(), arguments: support.arguments.clone(), scope: support.scope.clone(), valid_time: whole.clone(), branch: None };
    let (derivation, _) = evaluate_model(tx, authority, &request, &release, Some(&head), definition, rule, budget, cancel).await?;
    let fingerprint = derivation.fingerprint()?;
    Ok(RulePreflight { derivation, fingerprint })
}

pub(crate) async fn derive_rule(
    tx: &WorldTransaction<'_>, admission: &Admission, request: &EvaluateRuleRequest, branch: Option<&BranchRef>, expected: &Digest,
    budget: &CallBudget, cancel: &CancellationToken,
) -> Result<RuleDerivationProof, QueryError> {
    let (release, _) = read_model(tx, branch, request).await?;
    let definition = release.definitions.iter().find(|item| item.reference == request.rule).ok_or_else(|| invalid("rule"))?;
    let world_protocol::definitions::DefinitionBody::Rule(rule) = &definition.body else { return Err(invalid("rule")); };
    let ranges = super::current::evaluation_ranges(definition, &rule.parameters, &super::rule::expressions(rule), &release)?.into_keys().collect::<Vec<_>>();
    crate::facts::support::lock_ranges(tx, &ranges, &[]).await?;
    if let Some(branch) = branch { crate::facts::assertions::lock_branch_derivations(tx, branch, &request.scope).await?; }
    let (derivation, _) = evaluate(tx, super::current::ReadAuthority::Admitted(admission), request, branch, budget, cancel).await?;
    if &derivation.fingerprint()? != expected { return Err(QueryFailure::BasisChanged.into()); }
    Ok(RuleDerivationProof { transaction: super::rule::transaction_id(tx).await?, decision: admission.decision().id.clone(), derivation,
        request: request.clone(), expected: expected.clone(), budget: budget.clone(), cancel: cancel.clone() })
}

async fn read_model(tx: &WorldTransaction<'_>, branch: Option<&BranchRef>, request: &EvaluateRuleRequest) -> Result<(Release, Option<ReleaseHead>), QueryError> {
    if request.branch.as_ref() != branch { return Err(QueryFailure::BasisChanged.into()); }
    if let Some(branch) = branch {
        if branch.world != *tx.world() { return Err(invalid("branch.world")); }
        let current = crate::releases::read_branch(tx, &branch.id).await?;
        if current.as_ref().map(|current| current.revision) != Some(branch.revision) { return Err(QueryFailure::BasisChanged.into()); }
        let release = super::branch::model(tx, branch, &world_protocol::evaluation::EvaluationArm::Candidate).await?.1;
        if release.id != request.release_id || release.source_branch.as_ref() != Some(branch) { return Err(QueryFailure::BasisChanged.into()); }
        Ok((release, None))
    } else {
        let head = crate::releases::read_active_head(tx).await?.ok_or(QueryFailure::BasisChanged)?;
        if head.release_id != request.release_id { return Err(QueryFailure::BasisChanged.into()); }
        Ok((super::current::release(tx, &request.release_id, None).await?, Some(head)))
    }
}

fn row_basis(row: &super::EvalRow) -> impl serde::Serialize + '_ {
    (&row.subjects, row.fields.iter().collect::<Vec<_>>(), row.roles.iter().collect::<Vec<_>>(), &row.valid_time)
}

async fn evaluate(
    tx: &WorldTransaction<'_>, authority: super::current::ReadAuthority<'_>, request: &EvaluateRuleRequest, branch: Option<&BranchRef>,
    budget: &CallBudget, cancel: &CancellationToken,
) -> Result<(RuleDerivation, Vec<(ValidTime, super::current::CurrentEvaluation)>), QueryError> {
    budget.check().map_err(super::execution::budget_error)?;
    if cancel.is_cancelled() { return Err(QueryFailure::Cancelled.into()); }
    if request.rule.world != *tx.world() || request.valid_time.to.as_ref().is_some_and(|to| to <= &request.valid_time.from) { return Err(invalid("rule")); }
    let now = tx.now().await?;
    let seed = authorization::actual_impact(vec![world_protocol::authorization::AccessScope {
        resources: vec![ResourceRef::Definition { id: request.rule.id.clone() }], fields: Vec::new(),
        modes: vec![world_protocol::authorization::AccessMode::Read], scope: request.scope.clone(), valid_time: Some(request.valid_time.clone()),
    }], vec![world_protocol::expression::Effect::Pure], Vec::new(), Vec::new(), Vec::new())?;
    authority.check(tx, &seed, &now).await?;
    if authority.verified().invocation().branch_id.as_ref() != branch.map(|branch| &branch.id) { return Err(QueryFailure::BasisChanged.into()); }
    let (release, head) = read_model(tx, branch, request).await?;
    let definition = release.definitions.iter().find(|item| item.reference == request.rule).ok_or_else(|| invalid("rule"))?;
    let world_protocol::definitions::DefinitionBody::Rule(rule) = &definition.body else { return Err(invalid("rule")); };
    evaluate_model(tx, authority, request, &release, head.as_ref(), definition, rule, budget, cancel).await
}

async fn evaluate_model(
    tx: &WorldTransaction<'_>, authority: super::current::ReadAuthority<'_>, request: &EvaluateRuleRequest,
    release: &Release, head: Option<&ReleaseHead>,
    definition: &world_protocol::definitions::Definition<world_protocol::definitions::DefinitionBody>, rule: &world_protocol::definitions::Rule,
    budget: &CallBudget, cancel: &CancellationToken,
) -> Result<(RuleDerivation, Vec<(ValidTime, super::current::CurrentEvaluation)>), QueryError> {
    let now = tx.now().await?;
    let ir = crate::compiler::check_rule(definition, &release.definitions, &release.scopes)?;
    let expressions = super::rule::expressions(rule);
    let (mut evaluations, mut read_impact, support_basis, branch_inputs) = super::rule::prepare_evaluations(tx, authority, definition, &release, rule,
        &request.arguments, &expressions, ir.annotations, &request.scope, &request.valid_time, budget, cancel).await?;
    let mut whole = super::rule::whole_evaluation(&evaluations, &request.valid_time)?;
    let arguments = rule.parameters.iter().map(|parameter| match whole.parameters.get(&parameter.id) {
        Some(world_protocol::value::Cell::Known { value }) => Ok(QueryArgument { parameter_id: parameter.id.clone(), value: value.clone() }),
        _ => Err(invalid("arguments")),
    }).collect::<Result<Vec<_>, _>>()?;
    let (watch_fingerprint, watch_impact, watch_basis) = super::watch::observe_rule(tx, authority, definition, &release, &rule.parameters, &rule.condition,
        &mut whole, &request.scope, &request.valid_time, &now).await?;
    if let Some(impact) = watch_impact { read_impact.access.extend(impact.access); read_impact.effects.extend(impact.effects); read_impact.labels.extend(impact.labels); read_impact.state.extend(impact.state); read_impact.source_ids.extend(impact.source_ids); }
    read_impact = authorization::actual_impact(read_impact.access, read_impact.effects, read_impact.labels, read_impact.state, read_impact.source_ids)?;
    let mut segments = Vec::new(); let mut bases = Vec::new(); let mut dependencies = Vec::new();
    let mut outcome = None; let mut uniform = true;
    for (interval, evaluation) in &mut evaluations {
        let actual = super::rule::evaluate_interval(evaluation, rule, interval)?;
        if outcome.as_ref().is_some_and(|previous| previous != &actual) { uniform = false; }
        outcome = Some(actual);
        if let Some(at) = &request.valid_time.to {
            let boundary = ReadDependency::TimeBoundary { at: at.clone() };
            if !evaluation.dependencies.contains(&boundary) { evaluation.dependencies.push(boundary); }
        }
        let mut reads = Vec::new();
        for dependency in std::mem::take(&mut evaluation.dependencies) {
            if !reads.contains(&dependency) { reads.push(dependency.clone()); }
            if !dependencies.contains(&dependency) { dependencies.push(dependency); }
        }
        evaluation.dependencies = reads.clone();
        let collection_basis = evaluation.collections.iter().map(|(symbol, collection)| (symbol, collection.rows.iter().map(row_basis).collect::<Vec<_>>(), &collection.incomplete)).collect::<Vec<_>>();
        let range_basis = evaluation.ranges.iter().map(|(id, (symbol, collection))| (id, symbol, collection.rows.iter().map(row_basis).collect::<Vec<_>>(), &collection.incomplete)).collect::<Vec<_>>();
        bases.push(crate::definitions::canonical_digest(&(&*interval, &evaluation.parameters, row_basis(&evaluation.row), collection_basis, range_basis,
            evaluation.incomplete, evaluation.range_incomplete, &reads))?);
        segments.push(RuleDerivationSegment { valid_time: interval.clone(), read_dependencies: reads.clone(), dependencies: reads });
    }
    let (status, conclusion) = if uniform { outcome.unwrap_or((SupportStatus::Pending, None)) } else { (SupportStatus::Pending, None) };
    let read_basis = crate::definitions::canonical_digest(&(support_basis, bases))?;
    let capture_witness = super::branch::rule_capture_witness(tx, release, &dependencies, budget, cancel).await?;
    let derivation = RuleDerivation { world: tx.world().clone(), release_id: release.id.clone(), rule: request.rule.clone(), arguments,
        scope: request.scope.clone(), valid_time: request.valid_time.clone(), status, conclusion, segments, read_dependencies: dependencies.clone(), dependencies, read_impact,
        active_head: head.cloned(), model: release.clone(), activation_lock_id: release.artifact.activation_lock_id.clone(), model_digest: crate::definitions::canonical_digest(&release)?, capture_witness, branch_inputs, watch_fingerprint, watch_basis, read_basis };
    Ok((derivation, evaluations))
}
