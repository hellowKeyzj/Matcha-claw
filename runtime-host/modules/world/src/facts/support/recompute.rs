use super::{
    basis, decode, encode,
    maintenance::{self, alternatives, refresh_explanation},
    number, reject,
};
use crate::{
    authorization::{Admission, VerifiedInvocation},
    extensions::invocation::CallBudget,
    store::{RetentionRoots, StoreError, WorldTransaction},
};
use serde::{Deserialize, Serialize};
use world_protocol::{
    commit::CommitFailure,
    failure::FailureStage,
    ids::*,
    provenance::*,
    time::{DurationMs, Timestamp},
    value::DirtyState,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct RecomputeBasis {
    pub work: DirtyRecompute,
    pub scope: ScopeId,
    pub cause: String,
}

pub(crate) async fn world_deletion_roots(
    tx: &WorldTransaction<'_>,
) -> Result<RetentionRoots, StoreError> {
    let mut roots = RetentionRoots::default();
    let mut after = String::new();
    loop {
        let rows = tx.query(
            "SELECT target_id,actual_basis FROM world_dirty_recompute WHERE tenant_id=$1 AND world_id=$2 AND target_kind='support' AND target_id>$3 ORDER BY target_id LIMIT 256",
            &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &after],
        ).await?;
        if rows.is_empty() {
            break;
        }
        for row in rows {
            after = row.get("target_id");
            let basis: RecomputeBasis = decode(row.get("actual_basis"))?;
            if super::key(&(
                &basis.work.conclusion,
                &basis.scope,
                &basis.work.release_id,
                &basis.work.branch_id,
            ))? != after
            {
                return Err(reject(ProvenanceFailure::InternalFault));
            }
            roots.scopes.push(basis.scope);
            retain_work(tx, &mut roots, basis.work)?;
        }
    }
    let (mut target, mut generation, mut attempt) = (String::new(), 0_i64, 0_i32);
    loop {
        let rows = tx.query(
            "SELECT target_id,dirty_generation,attempt,actual_basis,state,result FROM world_recompute_attempt WHERE tenant_id=$1 AND world_id=$2 AND target_kind='support' AND (target_id,dirty_generation,attempt)>($3,$4,$5) ORDER BY target_id,dirty_generation,attempt LIMIT 256",
            &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &target, &generation, &attempt],
        ).await?;
        if rows.is_empty() {
            break;
        }
        for row in rows {
            target = row.get("target_id");
            generation = row.get("dirty_generation");
            attempt = row.get("attempt");
            let work: DirtyRecompute = decode(row.get("actual_basis"))?;
            if number(work.generation.0)? != generation {
                return Err(reject(ProvenanceFailure::InternalFault));
            }
            retain_work(tx, &mut roots, work)?;
            if row.get::<_, String>("state") == "completed" {
                let result = row
                    .get::<_, Option<serde_json::Value>>("result")
                    .ok_or_else(|| reject(ProvenanceFailure::InternalFault))?;
                roots
                    .dependencies
                    .extend(decode::<Vec<ReadDependency>>(result)?);
            }
        }
    }
    Ok(roots)
}

fn retain_work(
    tx: &WorldTransaction<'_>,
    roots: &mut RetentionRoots,
    work: DirtyRecompute,
) -> Result<(), StoreError> {
    if work.conclusion.world != *tx.world() || work.fence.world != *tx.world() {
        return Err(reject(ProvenanceFailure::CrossScope));
    }
    roots.dependencies.push(ReadDependency::Assertion {
        reference: work.conclusion,
    });
    roots.dependencies.extend(work.dependencies);
    roots.releases.push(work.release_id);
    if let Some(id) = work.branch_id {
        roots.resources.push(ResourceRef::Branch { id });
    }
    Ok(())
}

/// The durable generation and claim token, not a process-local task identity, fence a worker.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct RecomputeClaim {
    pub work: DirtyRecompute,
    scope: ScopeId,
    target_id: String,
    token: String,
    attempt: i32,
    run_id: RunId,
    reason_code: String,
    cause: String,
}

impl RecomputeClaim {
    pub(crate) fn run_id(&self) -> &RunId { &self.run_id }
    pub(crate) fn scope(&self) -> &ScopeId { &self.scope }
    pub(crate) fn reason(&self) -> &str { &self.reason_code }
    pub(crate) fn cause(&self) -> &str { &self.cause }
}

pub(crate) async fn claim(
    tx: &WorldTransaction<'_>,
    worker: &str,
    token: &str,
    run_id: &RunId,
    lease: DurationMs,
    _at: &Timestamp,
) -> Result<Option<RecomputeClaim>, StoreError> {
    if worker.is_empty()
        || worker.len() > 256
        || token.is_empty()
        || token.len() > 256
        || lease.0 == 0
        || lease.0 > 300_000
    {
        return Err(reject(ProvenanceFailure::MissingPremise));
    }
    tx.require_domain(&WriterDomain::try_new("facts").expect("fixed writer domain"))?;
    let at = &tx.now().await?;
    let row = tx.query_opt(
        "SELECT d.target_id,d.actual_basis,d.attempt,d.claim_token,d.dirty_generation,d.reason_code FROM world_dirty_recompute d WHERE d.tenant_id=$1 AND d.world_id=$2 AND d.target_kind='support' AND (d.actual_basis->'work'->>'branchId') IS NULL AND (d.status='pending' OR (d.status='claimed' AND d.lease_until<=$3::text::timestamptz)) AND d.due_at<=$3::text::timestamptz AND EXISTS(SELECT 1 FROM world_writer_gate g WHERE g.tenant_id=d.tenant_id AND g.world_id=d.world_id AND g.domain=d.writer_domain AND g.writer_epoch=d.writer_epoch AND g.mode='active') ORDER BY d.due_at,d.target_id LIMIT 1 FOR UPDATE OF d SKIP LOCKED",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &at.as_str()],
    ).await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let basis: RecomputeBasis = decode(row.get("actual_basis"))?;
    let work = basis.work;
    if work.generation.0 != row.get::<_, i64>("dirty_generation") as u64
        || super::key(&(
            &work.conclusion,
            &basis.scope,
            &work.release_id,
            &work.branch_id,
        ))? != row.get::<_, String>("target_id")
    {
        return Err(reject(ProvenanceFailure::InternalFault));
    }
    if work.fence.domain.as_str() != "facts" || !tx.fences().contains(&work.fence) {
        return Err(StoreError::new(
            CommitFailure::Fenced {
                expected: work.fence.epoch,
                actual: tx.primary_fence().epoch,
            },
            FailureStage::Admission,
        ));
    }
    let target_id: String = row.get("target_id");
    let attempt = row
        .get::<_, i32>("attempt")
        .checked_add(1)
        .ok_or_else(|| reject(ProvenanceFailure::InternalFault))?;
    let old_token: Option<String> = row.get("claim_token");
    if let Some(old) = old_token {
        if old == token {
            return Err(reject(ProvenanceFailure::MissingPremise));
        }
        tx.execute("UPDATE world_recompute_attempt SET state='expired',terminal_at=$5::text::timestamptz WHERE tenant_id=$1 AND world_id=$2 AND target_kind='support' AND target_id=$3 AND claim_token=$4 AND terminal_at IS NULL", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &target_id, &old, &at.as_str()]).await?;
    }
    tx.execute("UPDATE world_dirty_recompute SET status='claimed',claim_token=$4,claimed_by=$5,attempt=$6,lease_until=$7::text::timestamptz+($8::bigint*interval '1 millisecond'),updated_at=clock_timestamp() WHERE tenant_id=$1 AND world_id=$2 AND target_kind='support' AND target_id=$3", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &target_id, &token, &worker, &attempt, &at.as_str(), &number(lease.0)?]).await?;
    tx.execute("INSERT INTO world_recompute_attempt(tenant_id,world_id,target_kind,target_id,dirty_generation,attempt,claim_token,run_id,writer_epoch,actual_basis,state) VALUES($1,$2,'support',$3,$4,$5,$6,$7,$8,$9,'running')", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &target_id, &number(work.generation.0)?, &attempt, &token, &run_id.as_str(), &number(work.fence.epoch.0)?, &encode(&work)?]).await?;
    Ok(Some(RecomputeClaim {
        work,
        scope: basis.scope,
        target_id,
        token: token.into(),
        attempt,
        run_id: run_id.clone(),
        reason_code: row.get("reason_code"),
        cause: basis.cause,
    }))
}

async fn verify(
    tx: &WorldTransaction<'_>,
    claim: &RecomputeClaim,
    lock: bool,
    require_lease: bool,
) -> Result<(), StoreError> {
    tx.require_domain(&WriterDomain::try_new("facts").expect("fixed writer domain"))?;
    if claim.work.conclusion.world != *tx.world()
        || claim.work.fence.domain.as_str() != "facts"
        || !tx.fences().contains(&claim.work.fence)
        || super::key(&(
            &claim.work.conclusion,
            &claim.scope,
            &claim.work.release_id,
            &claim.work.branch_id,
        ))? != claim.target_id
    {
        return Err(StoreError::new(
            CommitFailure::Fenced {
                expected: claim.work.fence.epoch,
                actual: tx.primary_fence().epoch,
            },
            FailureStage::Validate,
        ));
    }
    let at = tx.now().await?;
    let statement = if lock {
        "SELECT dirty_generation,claim_token,status,reason_code,actual_basis,lease_until>$4::text::timestamptz AS leased FROM world_dirty_recompute WHERE tenant_id=$1 AND world_id=$2 AND target_kind='support' AND target_id=$3 FOR UPDATE"
    } else {
        "SELECT dirty_generation,claim_token,status,reason_code,actual_basis,lease_until>$4::text::timestamptz AS leased FROM world_dirty_recompute WHERE tenant_id=$1 AND world_id=$2 AND target_kind='support' AND target_id=$3"
    };
    let row = tx
        .query_opt(
            statement,
            &[
                &tx.world().tenant_id.as_str(),
                &tx.world().world_id.as_str(),
                &claim.target_id,
                &at.as_str(),
            ],
        )
        .await?
        .ok_or_else(|| reject(ProvenanceFailure::MissingPremise))?;
    let actual: RecomputeBasis = decode(row.get("actual_basis"))?;
    if actual.work != claim.work || actual.scope != claim.scope
        || row.get::<_, i64>("dirty_generation") != number(claim.work.generation.0)?
        || row.get::<_, Option<String>>("claim_token").as_deref() != Some(claim.token.as_str())
        || row.get::<_, String>("status") != "claimed"
        || (require_lease && !row.get::<_, bool>("leased"))
        || row.get::<_, String>("reason_code") != claim.reason_code
        || actual.cause != claim.cause
    {
        return Err(StoreError::new(
            CommitFailure::ReadDependencyChanged {
                resource: ResourceRef::Assertion {
                    id: claim.work.conclusion.id.clone(),
                },
            },
            FailureStage::Validate,
        ));
    }
    Ok(())
}

pub(crate) async fn recompute_retention(
    tx: &WorldTransaction<'_>, claim: &RecomputeClaim,
) -> Result<RetentionRoots, StoreError> {
    let mut roots = RetentionRoots::default();
    if super::key(&(&claim.work.conclusion, &claim.scope, &claim.work.release_id, &claim.work.branch_id))? != claim.target_id { return Err(reject(ProvenanceFailure::CrossScope)); }
    roots.scopes.push(claim.scope.clone());
    retain_work(tx, &mut roots, claim.work.clone())?;
    for support in basis::stored_supports(basis::Reader::Transaction(tx), &claim.work.conclusion, &claim.scope, &claim.work.release_id, claim.work.branch_id.as_ref(), None, None).await? {
        basis::retain_support(&mut roots, &support);
    }
    Ok(roots)
}

pub(crate) async fn recompute_impact(
    tx: &WorldTransaction<'_>, claim: &RecomputeClaim, verified: &VerifiedInvocation,
    budget: &CallBudget, cancellation: &tokio_util::sync::CancellationToken,
) -> Result<(world_protocol::authorization::ActualImpact, Digest), StoreError> {
    let (_, impact, fingerprint) = plan(tx, claim, verified, budget, cancellation).await?;
    Ok((impact, fingerprint))
}

async fn plan(
    tx: &WorldTransaction<'_>, claim: &RecomputeClaim, verified: &VerifiedInvocation,
    budget: &CallBudget, cancellation: &tokio_util::sync::CancellationToken,
) -> Result<(Vec<SupportSet>, world_protocol::authorization::ActualImpact, Digest), StoreError> {
    verify(tx, claim, false, true).await?;
    if verified.invocation().world != *tx.world() || verified.invocation().branch_id.is_some() || claim.work.branch_id.is_some() {
        return Err(reject(ProvenanceFailure::CrossScope));
    }
    let now = tx.now().await?;
    let row = tx.query_opt("SELECT scope_id,body->'validTime' AS valid_time FROM world_assertion_revision WHERE tenant_id=$1 AND world_id=$2 AND assertion_id=$3 AND revision=$4", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &claim.work.conclusion.id.as_str(), &number(claim.work.conclusion.revision.0)?]).await?.ok_or_else(|| reject(ProvenanceFailure::MissingPremise))?;
    let scope = ScopeId::try_new(row.get::<_, String>("scope_id")).map_err(|_| reject(ProvenanceFailure::InternalFault))?;
    let interval: world_protocol::time::ValidTime = decode(row.get("valid_time"))?;
    if scope != claim.scope { return Err(reject(ProvenanceFailure::CrossScope)); }
    let seed = crate::authorization::actual_impact(vec![world_protocol::authorization::AccessScope {
        resources: vec![ResourceRef::Assertion { id: claim.work.conclusion.id.clone() }], fields: Vec::new(),
        modes: vec![world_protocol::authorization::AccessMode::Read], scope, valid_time: Some(interval.clone()),
    }], vec![world_protocol::expression::Effect::Pure], Vec::new(), Vec::new(), Vec::new()).map_err(super::watches::auth_error)?;
    crate::authorization::check_impact_read(tx, verified, &seed, &now).await.map_err(super::watches::auth_error)?;
    let conclusion = crate::facts::assertions::read_assertion(tx, &claim.work.conclusion).await
        .map_err(|error| StoreError::caused_by(CommitFailure::InvalidBatch, FailureStage::Read, error))?
        .ok_or_else(|| reject(ProvenanceFailure::MissingPremise))?;
    if conclusion.scope != claim.scope || conclusion.valid_time != interval
        || !matches!(conclusion.origin, world_protocol::facts::AssertionOrigin::Derived {}) {
        return Err(reject(ProvenanceFailure::CrossScope));
    }
    let basis = super::interval::interval_basis(tx, verified, std::slice::from_ref(&claim.work.conclusion),
        &claim.scope, &claim.work.release_id, budget, cancellation, &conclusion.valid_time).await?;
    let stored = basis.stored(&claim.work.conclusion)?;
    if stored.is_empty() { return Err(reject(ProvenanceFailure::MissingPremise)); }
    let mut impact = basis.impact().clone();
    merge(&mut impact, seed);
    let mut supports = std::collections::BTreeMap::new();
    let mut groups = std::collections::BTreeMap::new();
    for support in stored {
        super::checkpoint(budget, cancellation)?;
        let mut next = support.clone();
        next.reference.revision = Revision(next.reference.revision.0.checked_add(1).ok_or_else(|| reject(ProvenanceFailure::InternalFault))?);
        supports.insert(next.reference.id.clone(), next);
        let mut arguments = support.arguments.clone();
        arguments.sort_by(|left, right| left.parameter_id.cmp(&right.parameter_id));
        let key = super::key(&(&support.rule, arguments, &support.scope, &support.release_id, &support.branch_id))?;
        groups.entry(key).or_insert(support);
    }
    let mut plans = Vec::new();
    for support in groups.into_values() {
        super::checkpoint(budget, cancellation)?;
        let query = crate::query::preflight_support_rule(tx, verified, support, &conclusion.valid_time,
            budget, cancellation).await.map_err(super::query_error)?;
        let actual = query.derivation();
        let mut read_plans = Vec::new();
        for segment in actual.segments() {
            super::checkpoint(budget, cancellation)?;
            let prepared = maintenance::prepare_derivation(tx, verified, &claim.work.conclusion, actual.rule(), actual.arguments(),
                actual.scope(), segment.valid_time(), actual.release_id(), segment.dependencies(), budget, cancellation).await?;
            let mut read = prepared.clone();
            read.premises = segment.read_dependencies().iter().map(|dependency| match dependency {
                ReadDependency::Assertion { reference } => PremiseRef::Assertion(reference.clone()),
                ReadDependency::Evidence { reference } => PremiseRef::Evidence(reference.clone()),
                other => PremiseRef::Read(other.clone()),
            }).collect();
            read_plans.push(read);
            supports.insert(prepared.reference.id.clone(), prepared);
        }
        // An old edge remains independently evaluated even if the current cut set changed.
        for old in stored.iter().filter(|old| old.rule == support.rule) {
            let mut arguments = old.arguments.clone();
            arguments.sort_by(|left, right| left.parameter_id.cmp(&right.parameter_id));
            let mut expected = support.arguments.clone();
            expected.sort_by(|left, right| left.parameter_id.cmp(&right.parameter_id));
            if arguments != expected { continue; }
            if !read_plans.iter().any(|read| read.reference.id == old.reference.id) {
                read_plans.push(supports[&old.reference.id].clone());
            }
        }
        let (closure, fingerprint) = maintenance::derivation_impact(tx, verified, &read_plans, None,
            actual.watch_basis(), budget, cancellation).await?;
        merge(&mut impact, actual.read_impact().clone());
        merge(&mut impact, closure);
        plans.push((query.fingerprint(), fingerprint));
    }
    let supports = supports.into_values().collect::<Vec<_>>();
    if supports.len() > super::BATCH_LIMIT { return Err(super::limit(ProvenanceLimit::ProposalItems)); }
    let mut access = std::collections::BTreeMap::new();
    for scope in impact.access {
        access.insert(crate::definitions::canonical_digest(&scope).map_err(digest_error)?, scope);
    }
    let impact = crate::authorization::actual_impact(access.into_values().collect(), impact.effects, impact.labels, impact.state, impact.source_ids)
        .map_err(super::watches::auth_error)?;
    let fingerprint = crate::definitions::canonical_digest(&(
        "world.support-recompute-plan.v1", &claim.work, &conclusion, stored, basis.fingerprint(), plans, &supports, &impact,
    )).map_err(digest_error)?;
    Ok((supports, impact, fingerprint))
}

fn merge(into: &mut world_protocol::authorization::ActualImpact, other: world_protocol::authorization::ActualImpact) {
    into.access.extend(other.access); into.effects.extend(other.effects); into.labels.extend(other.labels);
    into.state.extend(other.state); into.source_ids.extend(other.source_ids);
}
fn digest_error(error: world_protocol::definitions::DefinitionFailure) -> StoreError {
    StoreError::caused_by(CommitFailure::InvalidBatch, FailureStage::Prepare, crate::definitions::DefinitionError::from(error))
}

/// Call inside the same transaction as any newly derived fact outputs. No fact mutation is exposed to a guest.
pub(crate) async fn complete(
    tx: &mut WorldTransaction<'_>,
    claim: &RecomputeClaim,
    admission: &Admission,
    expected: &Digest,
    budget: &CallBudget,
    cancellation: &tokio_util::sync::CancellationToken,
    _at: &Timestamp,
) -> Result<Vec<AssertionRef>, StoreError> {
    super::checkpoint(budget, cancellation)?;
    let (supports, impact, fingerprint) = plan(tx, claim, admission.verified(), budget, cancellation).await?;
    if &fingerprint != expected {
        return Err(StoreError::new(CommitFailure::ReadDependencyChanged {
            resource: ResourceRef::Assertion { id: claim.work.conclusion.id.clone() },
        }, FailureStage::Validate));
    }
    admission.require_access(&impact).map_err(super::watches::auth_error)?;
    crate::query::lock_rule_ranges(tx, &supports).await.map_err(super::query_error)?;
    // accept obtains a same-transaction RuleEvaluationProof for every original rule/argument group.
    // A false result is Invalid/Clean; old premises or a guest withdrawal cannot settle it.
    let proposal = SupportDeltaProposal { upserts: supports, invalidate: Vec::new(), affected_watches: Vec::new(), observed_dependencies: Vec::new() };
    let at = &tx.now().await?;
    let changed = maintenance::accept(tx, &proposal, admission, budget, cancellation, at).await?;
    let at = &tx.now().await?;
    let representative = &proposal.upserts[0];
    let all = alternatives(tx, representative, budget, cancellation).await?;
    if all.iter().any(|support| {
        support.status == SupportStatus::Pending || support.dirty != DirtyState::Clean
    }) {
        return Err(reject(ProvenanceFailure::Dirty {
            watches: Vec::new(),
        }));
    }
    let mut observed = Vec::new();
    for support in &all {
        for dependency in super::dependencies(support) {
            if !observed.contains(&dependency) { observed.push(dependency); }
        }
    }
    let boundaries: Vec<_> = all.iter().filter(|support| support.status == SupportStatus::Valid)
        .flat_map(super::dependencies)
        .filter(|dependency| matches!(dependency, ReadDependency::Watch { .. } | ReadDependency::TimeBoundary { .. })).collect();
    basis::require_current(tx, &boundaries, at).await?;
    let model = crate::query::support_model(tx, &claim.work.release_id, claim.work.branch_id.as_ref()).await.map_err(super::query_error)?;
    let live = basis::support_snapshot(basis::Reader::Transaction(tx), &claim.work.conclusion, &model, &claim.scope, Some(budget), Some(cancellation), at).await?;
    if all.iter().filter(|support| support.status == SupportStatus::Valid).any(|support| !live.supports.iter().any(|current| current.reference == support.reference && current.status == SupportStatus::Valid && current.dirty == DirtyState::Clean)) {
        return Err(reject(ProvenanceFailure::Dirty { watches: Vec::new() }));
    }
    refresh_explanation(tx, representative, &all).await?;
    verify(tx, claim, true, true).await?;
    let mut settled = claim.work.clone();
    settled.dependencies = observed.clone();
    let basis = RecomputeBasis {
        work: settled,
        scope: claim.scope.clone(),
        cause: super::key(&observed)?,
    };
    tx.execute("UPDATE world_dirty_recompute SET status='completed',claim_token=NULL,claimed_by=NULL,lease_until=NULL,actual_basis=$4,updated_at=clock_timestamp() WHERE tenant_id=$1 AND world_id=$2 AND target_kind='support' AND target_id=$3", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &claim.target_id, &encode(&basis)?]).await?;
    tx.execute("UPDATE world_recompute_attempt SET state='completed',result=$6,terminal_at=$7::text::timestamptz WHERE tenant_id=$1 AND world_id=$2 AND target_kind='support' AND target_id=$3 AND dirty_generation=$4 AND attempt=$5 AND claim_token=$8", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &claim.target_id, &number(claim.work.generation.0)?, &claim.attempt, &encode(&observed)?, &at.as_str(), &claim.token]).await?;
    Ok(changed)
}

/// Cancellation/failure relinquishes the lease but never removes the dirty barrier.
pub(crate) async fn release_claim(
    tx: &WorldTransaction<'_>,
    claim: &RecomputeClaim,
    failure: &ProvenanceFailure,
    retry_at: &Timestamp,
    _at: &Timestamp,
) -> Result<(), StoreError> {
    let at = &tx.now().await?;
    verify(tx, claim, true, false).await?;
    let state = if matches!(failure, ProvenanceFailure::Cancelled) {
        "cancelled"
    } else {
        "failed"
    };
    tx.execute("UPDATE world_recompute_attempt SET state=$6,result=$7,terminal_at=$8::text::timestamptz WHERE tenant_id=$1 AND world_id=$2 AND target_kind='support' AND target_id=$3 AND dirty_generation=$4 AND attempt=$5 AND claim_token=$9", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &claim.target_id, &number(claim.work.generation.0)?, &claim.attempt, &state, &encode(failure)?, &at.as_str(), &claim.token]).await?;
    tx.execute("UPDATE world_dirty_recompute SET status='pending',claim_token=NULL,claimed_by=NULL,lease_until=NULL,due_at=$4::text::timestamptz,failure=$5,updated_at=clock_timestamp() WHERE tenant_id=$1 AND world_id=$2 AND target_kind='support' AND target_id=$3", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &claim.target_id, &retry_at.as_str(), &encode(failure)?]).await?;
    Ok(())
}
