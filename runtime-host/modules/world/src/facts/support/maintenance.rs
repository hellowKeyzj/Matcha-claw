use super::{
    BATCH_LIMIT,
    basis::{self, Validity},
    decode, dependencies, dependency_key, encode, graph, key, number, reject, watches,
};
use crate::{
    authorization::{self, Admission, VerifiedInvocation},
    extensions::invocation::CallBudget,
    store::{StoreError, WorldSnapshot, WorldTransaction},
};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use world_protocol::{
    authorization::{AccessMode, AccessScope},
    commit::{CommitFailure, CommittedRevision},
    expression::Effect,
    facts::{Assertion, AssertionStatus, Claim, Evidence, EvidenceStatus},
    failure::FailureStage,
    ids::*,
    provenance::*,
    time::Timestamp,
    value::DirtyState,
};

pub(crate) fn resolve(
    snapshot: &SupportSnapshot,
    conclusion: &AssertionRef,
    scope: &ScopeId,
    release: &ReleaseId,
    branch: Option<&BranchId>,
    valid_at: &Timestamp,
) -> ConclusionSupport {
    let mut valid = Vec::new();
    let mut pending = Vec::new();
    let mut generation = Generation(0);
    for support in snapshot.supports.iter().filter(|support| {
        &support.conclusion == conclusion
            && &support.scope == scope
            && &support.release_id == release
            && support.branch_id.as_ref() == branch
            && support.valid_time.contains(valid_at)
    }) {
        if support.status == SupportStatus::Invalid && support.dirty == DirtyState::Clean {
            continue;
        }
        match &support.dirty {
            DirtyState::Clean if support.status == SupportStatus::Valid => {
                valid.push(support.reference.clone())
            }
            DirtyState::Dirty {
                generation: current,
                ..
            } => {
                generation = generation.max(*current);
                pending.push(support.reference.clone());
            }
            _ => pending.push(support.reference.clone()),
        }
    }
    if !valid.is_empty() {
        ConclusionSupport::Supported { supports: valid }
    } else if !pending.is_empty() {
        ConclusionSupport::Dirty {
            supports: pending,
            generation,
        }
    } else {
        ConclusionSupport::Unsupported
    }
}

pub(crate) fn resolve_interval(
    snapshot: &SupportSnapshot,
    conclusion: &AssertionRef,
    scope: &ScopeId,
    release: &ReleaseId,
    branch: Option<&BranchId>,
    interval: &world_protocol::time::ValidTime,
) -> ConclusionSupport {
    let mut intervals = Vec::new();
    let mut valid = Vec::new();
    let mut pending = Vec::new();
    let mut generation = Generation(0);
    for support in snapshot.supports.iter().filter(|support| {
        &support.conclusion == conclusion
            && &support.scope == scope
            && &support.release_id == release
            && support.branch_id.as_ref() == branch
            && support
                .valid_time
                .to
                .as_ref()
                .is_none_or(|to| &interval.from < to)
            && interval
                .to
                .as_ref()
                .is_none_or(|to| &support.valid_time.from < to)
    }) {
        if support.status == SupportStatus::Invalid && support.dirty == DirtyState::Clean {
            continue;
        }
        if support.status == SupportStatus::Valid && support.dirty == DirtyState::Clean {
            intervals.push(&support.valid_time);
            valid.push(support.reference.clone());
        } else {
            if let DirtyState::Dirty {
                generation: current,
                ..
            } = support.dirty
            {
                generation = generation.max(current);
            }
            pending.push(support.reference.clone());
        }
    }
    intervals.sort_by(|left, right| left.from.cmp(&right.from));
    let mut covered = interval.from.clone();
    for current in intervals {
        if current.from > covered {
            break;
        }
        match &current.to {
            None => return ConclusionSupport::Supported { supports: valid },
            Some(to) if to > &covered => covered = to.clone(),
            _ => {}
        }
        if interval.to.as_ref().is_some_and(|to| to <= &covered) {
            return ConclusionSupport::Supported { supports: valid };
        }
    }
    if pending.is_empty() {
        ConclusionSupport::Unsupported
    } else {
        ConclusionSupport::Dirty {
            supports: pending,
            generation,
        }
    }
}

pub(crate) async fn resolve_transaction(
    tx: &WorldTransaction<'_>,
    conclusion: &AssertionRef,
    scope: &ScopeId,
    release: &ReleaseId,
    branch: Option<&BranchId>,
    budget: &CallBudget,
    cancellation: &tokio_util::sync::CancellationToken,
    valid_at: &Timestamp,
) -> Result<ConclusionSupport, StoreError> {
    let snapshot =
        transaction_snapshot(tx, conclusion, scope, release, branch, budget, cancellation).await?;
    Ok(resolve(
        &snapshot, conclusion, scope, release, branch, valid_at,
    ))
}

pub(crate) async fn resolve_transaction_interval(
    tx: &WorldTransaction<'_>,
    conclusion: &AssertionRef,
    scope: &ScopeId,
    release: &ReleaseId,
    branch: Option<&BranchId>,
    budget: &CallBudget,
    cancellation: &tokio_util::sync::CancellationToken,
    interval: &world_protocol::time::ValidTime,
) -> Result<ConclusionSupport, StoreError> {
    let snapshot =
        transaction_snapshot(tx, conclusion, scope, release, branch, budget, cancellation).await?;
    Ok(resolve_interval(
        &snapshot, conclusion, scope, release, branch, interval,
    ))
}

pub(super) async fn transaction_snapshot(
    tx: &WorldTransaction<'_>,
    conclusion: &AssertionRef,
    scope: &ScopeId,
    release: &ReleaseId,
    branch: Option<&BranchId>,
    budget: &CallBudget,
    cancellation: &tokio_util::sync::CancellationToken,
) -> Result<SupportSnapshot, StoreError> {
    let model = crate::query::support_model(tx, release, branch).await.map_err(super::query_error)?;
    basis::support_snapshot(basis::Reader::Transaction(tx), conclusion, &model, scope, Some(budget), Some(cancellation), &tx.now().await?).await
}

pub(crate) async fn snapshot(
    read: &WorldSnapshot<'_>,
    conclusion: &AssertionRef,
    scope: &ScopeId,
    release: &ReleaseId,
    branch: Option<&BranchId>,
    budget: &CallBudget,
    cancellation: &tokio_util::sync::CancellationToken,
) -> Result<SupportSnapshot, StoreError> {
    let model = crate::query::support_model_snapshot(read, release, branch).await.map_err(super::query_error)?;
    basis::support_snapshot(basis::Reader::Snapshot(read), conclusion, &model, scope, Some(budget), Some(cancellation), &read.now().await?).await
}

pub(crate) async fn accept(
    tx: &mut WorldTransaction<'_>,
    proposal: &SupportDeltaProposal,
    admission: &Admission,
    budget: &CallBudget,
    cancellation: &tokio_util::sync::CancellationToken,
    at: &Timestamp,
) -> Result<Vec<AssertionRef>, StoreError> {
    if proposal.upserts.len() + proposal.invalidate.len() > BATCH_LIMIT {
        return Err(super::limit(ProvenanceLimit::ProposalItems));
    }
    super::checkpoint(budget, cancellation)?;
    crate::query::lock_rule_ranges(tx, &proposal.upserts)
        .await
        .map_err(super::query_error)?;
    authorization::recheck(tx, admission, at)
        .await
        .map_err(watches::auth_error)?;
    let mut ids = BTreeSet::new();
    for support in &proposal.upserts {
        if !ids.insert(support.reference.id.clone()) {
            return Err(reject(ProvenanceFailure::MissingPremise));
        }
        authorize(tx, support, admission).await?;
    }
    let mut verified = proposal.clone();
    verified.invalidate.clear();
    let proofs = crate::query::evaluate_rules(tx, admission, &proposal.upserts, budget, cancellation, at)
        .await.map_err(super::query_error)?;
    if proofs.len() != verified.upserts.len() { return Err(reject(ProvenanceFailure::MissingPremise)); }
    for (support, proof) in verified.upserts.iter_mut().zip(proofs) {
        super::checkpoint(budget, cancellation)?;
        *support = proof.consume(tx, support).await.map_err(super::query_error)?;
        authorize(tx, support, admission).await?;
        let validity = match basis::validate_support(tx, support, budget, cancellation, at).await {
            Ok(validity) => validity,
            Err(error) if matches!(super::provenance_failure(&error), ProvenanceFailure::BasisChanged { .. } | ProvenanceFailure::UnclosedRange { .. }) => Validity::Pending,
            Err(error) => return Err(error),
        };
        match validity {
            Validity::Invalid => support.status = SupportStatus::Invalid,
            Validity::Pending if support.status != SupportStatus::Invalid => support.status = SupportStatus::Pending,
            _ => {}
        }
    }
    // A guest withdrawal is not proof that this edge disappeared. Lock and check it as present.
    for reference in &proposal.invalidate {
        if reference.world != *tx.world() || !ids.insert(reference.id.clone()) {
            return Err(reject(ProvenanceFailure::MissingPremise));
        }
        let row = tx.query_opt("SELECT r.body FROM world_support_revision r JOIN world_support_head h USING(tenant_id,world_id,support_id,revision) WHERE r.tenant_id=$1 AND r.world_id=$2 AND r.support_id=$3", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &reference.id.as_str()]).await?.ok_or_else(|| reject(ProvenanceFailure::MissingPremise))?;
        let support: SupportSet = decode(row.get("body"))?;
        if support.reference != *reference {
            return Err(reject(ProvenanceFailure::MissingPremise));
        }
        authorize(tx, &support, admission).await?;
        verified.upserts.push(support);
    }
    basis::require_observed(
        tx,
        &proposal.observed_dependencies,
        &verified.upserts,
        budget,
        cancellation,
        at,
    )
    .await?;
    graph::validate(tx, &verified, budget, cancellation).await?;
    verified.upserts.truncate(proposal.upserts.len());
    let mut changed = BTreeMap::new();
    for reference in &proposal.invalidate {
        let mut support = current(tx, &reference.id)
            .await?
            .ok_or_else(|| reject(ProvenanceFailure::MissingPremise))?;
        if support.reference != *reference {
            return Err(reject(ProvenanceFailure::MissingPremise));
        }
        if support.status == SupportStatus::Invalid {
            continue;
        }
        let validity = match basis::validate_support(tx, &support, budget, cancellation, at).await {
            Ok(validity) => validity,
            Err(error)
                if matches!(
                    super::provenance_failure(&error),
                    ProvenanceFailure::BasisChanged { .. }
                        | ProvenanceFailure::UnclosedRange { .. }
                ) =>
            {
                Validity::Pending
            }
            Err(error) => return Err(error),
        };
        if validity == Validity::Invalid {
            support.status = SupportStatus::Invalid;
            support.dirty = DirtyState::Clean;
        } else {
            let generation = mark_work(
                tx,
                &support,
                at,
                "proposed_withdrawal",
                &key(&(dependencies(&support), &support.valid_time))?,
                budget,
                cancellation,
            )
            .await?;
            if matches!(support.dirty, DirtyState::Dirty { generation: old, .. } if old == generation)
            {
                continue;
            }
            support.dirty = DirtyState::Dirty {
                generation,
                invalidated_at: at.clone(),
                watches: Vec::new(),
            };
        }
        append(tx, &mut support, false).await?;
        changed.insert(context(&support)?, support);
    }
    for proposed in &verified.upserts {
        let mut support = proposed.clone();
        if support.status == SupportStatus::Pending {
            let generation = mark_work(
                tx,
                &support,
                at,
                "pending_premise",
                &key(&(dependencies(&support), &support.valid_time))?,
                budget,
                cancellation,
            )
            .await?;
            support.dirty = DirtyState::Dirty {
                generation,
                invalidated_at: at.clone(),
                watches: Vec::new(),
            };
        }
        append(tx, &mut support, true).await?;
        changed.insert(context(&support)?, support);
    }
    // Guest affected_watches is only a hint; actual dependencies select affected consumers.
    propagate(
        tx,
        changed.into_values().collect(),
        budget,
        cancellation,
        at,
    )
    .await
}

pub(super) async fn authorize(
    tx: &WorldTransaction<'_>,
    support: &SupportSet,
    admission: &Admission,
) -> Result<(), StoreError> {
    let impact = support_impact(tx, support).await?;
    admission.require_access(&impact).map_err(watches::auth_error)?;
    if admission.invocation().world != *tx.world()
        || admission.invocation().branch_id != support.branch_id
    {
        return Err(reject(ProvenanceFailure::CrossScope));
    }
    Ok(())
}

/// Prepares an edge identity and expected revision, not evidence that the rule is true.
pub(crate) async fn prepare_derivation(
    tx: &WorldTransaction<'_>, verified: &VerifiedInvocation,
    conclusion: &AssertionRef, rule: &DefinitionRef,
    arguments: &[world_protocol::query::QueryArgument], scope: &ScopeId,
    valid_time: &world_protocol::time::ValidTime, release: &ReleaseId,
    dependencies: &[ReadDependency], budget: &CallBudget,
    cancellation: &tokio_util::sync::CancellationToken,
) -> Result<SupportSet, StoreError> {
    super::checkpoint(budget, cancellation)?;
    if verified.invocation().world != *tx.world() || verified.invocation().branch_id.is_some()
        || conclusion.world != *tx.world() || rule.world != *tx.world()
        || conclusion.revision.0 == 0 || rule.revision.0 == 0 {
        return Err(reject(ProvenanceFailure::CrossScope));
    }
    if arguments.len() > BATCH_LIMIT || dependencies.len() > BATCH_LIMIT {
        return Err(super::limit(ProvenanceLimit::ProposalItems));
    }
    let digest = crate::definitions::canonical_digest(&(
        "world.derived-support.v1", tx.world(), release, conclusion, rule, arguments,
        scope, valid_time,
    )).map_err(|error| StoreError::caused_by(CommitFailure::InvalidBatch, FailureStage::Prepare, crate::definitions::DefinitionError::from(error)))?;
    let id = SupportId::try_new(format!("derived-{}", &digest.as_str()[7..]))
        .map_err(|error| StoreError::caused_by(CommitFailure::InvalidBatch, FailureStage::Prepare, error))?;
    let mut premises = Vec::new();
    for dependency in dependencies {
        super::checkpoint(budget, cancellation)?;
        let premise = match dependency {
            ReadDependency::Assertion { reference } => PremiseRef::Assertion(reference.clone()),
            ReadDependency::Evidence { reference } => PremiseRef::Evidence(reference.clone()),
            other => PremiseRef::Read(other.clone()),
        };
        if !premises.contains(&premise) { premises.push(premise); }
    }
    let mut support = SupportSet {
        reference: SupportRef { world: tx.world().clone(), id, revision: Revision(1) },
        conclusion: conclusion.clone(), rule: rule.clone(), arguments: arguments.to_vec(),
        scope: scope.clone(), valid_time: valid_time.clone(), release_id: release.clone(),
        branch_id: None, premises, status: SupportStatus::Pending, dirty: DirtyState::Clean,
    };
    derivation_read(tx, verified, &support,
        vec![ResourceRef::Support { id: support.reference.id.clone() }], Vec::new(), Vec::new()).await?;
    let previous = tx.query_opt(
        "SELECT revision FROM world_support_head WHERE tenant_id=$1 AND world_id=$2 AND support_id=$3 FOR SHARE",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &support.reference.id.as_str()],
    ).await?;
    let revision = previous.map_or(Ok(1), |row| {
        row.get::<_, i64>("revision").checked_add(1)
            .ok_or_else(|| reject(ProvenanceFailure::InternalFault))
    })?;
    support.reference.revision = Revision(u64::try_from(revision)
        .map_err(|_| reject(ProvenanceFailure::InternalFault))?);
    Ok(support)
}

pub(crate) async fn derivation_impact(
    tx: &WorldTransaction<'_>, verified: &VerifiedInvocation, supports: &[SupportSet],
    new_assertion: Option<&Assertion>, watch_basis: Option<(&WatchId, Option<&QueryWatch>)>,
    budget: &CallBudget, cancellation: &tokio_util::sync::CancellationToken,
) -> Result<(world_protocol::authorization::ActualImpact, Digest), StoreError> {
    super::checkpoint(budget, cancellation)?;
    let support = supports.first().ok_or_else(|| reject(ProvenanceFailure::MissingPremise))?;
    if supports.len() > BATCH_LIMIT { return Err(super::limit(ProvenanceLimit::ProposalItems)); }
    if verified.invocation().world != *tx.world() || verified.invocation().branch_id.is_some()
        || support.conclusion.world != *tx.world()
        || supports.iter().any(|item| item.reference.world != *tx.world() || item.conclusion != support.conclusion
            || item.rule.world != *tx.world() || item.branch_id.is_some() || item.scope != support.scope
            || item.release_id != support.release_id || item.valid_time.to.as_ref().is_some_and(|to| to <= &item.valid_time.from)) {
        return Err(reject(ProvenanceFailure::CrossScope));
    }
    let assertion = if let Some(assertion) = new_assertion {
        assertion.clone()
    } else {
        let row = tx.query_opt("SELECT body->'validTime' AS valid_time FROM world_assertion_revision WHERE tenant_id=$1 AND world_id=$2 AND assertion_id=$3 AND revision=$4", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &support.conclusion.id.as_str(), &number(support.conclusion.revision.0)?]).await?.ok_or_else(|| reject(ProvenanceFailure::MissingPremise))?;
        let mut context = support.clone();
        context.valid_time = decode(row.get("valid_time"))?;
        derivation_read(tx, verified, &context, vec![ResourceRef::Assertion { id: support.conclusion.id.clone() }], Vec::new(), Vec::new()).await?;
        crate::facts::assertions::read_assertion(tx, &support.conclusion).await
            .map_err(|error| StoreError::caused_by(CommitFailure::InvalidBatch, FailureStage::Read, error))?
            .ok_or_else(|| reject(ProvenanceFailure::MissingPremise))?
    };
    if assertion.reference != support.conclusion || assertion.scope != support.scope
        || !matches!(assertion.origin, world_protocol::facts::AssertionOrigin::Derived {})
        || supports.iter().any(|item| !super::contains(&assertion.valid_time, &item.valid_time)) {
        return Err(reject(ProvenanceFailure::CrossScope));
    }
    let mut whole = support.clone();
    whole.valid_time = assertion.valid_time.clone();
    let mut seeds = supports.to_vec();
    let mut range_access = Vec::new();
    let mut heads = BTreeMap::new();
    for item in supports {
        super::checkpoint(budget, cancellation)?;
        range_access.extend(derivation_read(tx, verified, item,
            vec![ResourceRef::Support { id: item.reference.id.clone() }], Vec::new(), Vec::new()).await?.access);
        let row = tx.query_opt("SELECT r.body FROM world_support_head h JOIN world_support_revision r USING(tenant_id,world_id,support_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 AND h.support_id=$3 FOR SHARE OF h", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &item.reference.id.as_str()]).await?;
        let previous = row.map(|row| decode::<SupportSet>(row.get("body"))).transpose()?;
        if let Some(previous) = &previous {
            if previous.reference.world != *tx.world() || previous.reference.id != item.reference.id
                || previous.conclusion != item.conclusion || previous.scope != item.scope
                || previous.valid_time != item.valid_time || previous.release_id != item.release_id
                || previous.branch_id != item.branch_id || previous.rule != item.rule || previous.arguments != item.arguments {
                return Err(reject(ProvenanceFailure::CrossScope));
            }
        }
        let next = previous.as_ref().map_or(Some(1), |old| old.reference.revision.0.checked_add(1))
            .ok_or_else(|| reject(ProvenanceFailure::InternalFault))?;
        if item.reference.revision != Revision(next) {
            return Err(StoreError::new(CommitFailure::RevisionConflict {
                resource: ResourceRef::Support { id: item.reference.id.clone() },
                expected: item.reference.revision, actual: Revision(next),
            }, FailureStage::Prepare));
        }
        heads.insert(item.reference.id.clone(), previous);
    }
    let (datasets, partitions) = if new_assertion.is_some() {
        let mut resources = Vec::new();
        for subject in crate::facts::assertions::claim_subjects(&assertion.claim) {
            resources.push(match subject {
                world_protocol::identity::SubjectRef::Object { id } => ResourceRef::Object { id },
                world_protocol::identity::SubjectRef::Relation { id } => ResourceRef::Relation { id },
            });
        }
        resources.push(ResourceRef::Definition { id: match &assertion.claim {
            Claim::Attribute(claim) => claim.property.id.clone(),
            Claim::Relation(claim) => claim.relation_type.id.clone(),
        } });
        range_access.extend(derivation_read(tx, verified, &whole, resources, Vec::new(), Vec::new()).await?.access);
        let (datasets, partitions) = assertion_ranges(tx, &[(&assertion.claim, &assertion.origin)]).await?;
        range_access.extend(derivation_read(tx, verified, &whole,
            datasets.iter().cloned().map(|id| ResourceRef::Definition { id }).collect(), Vec::new(), Vec::new()).await?.access);
        (datasets, partitions)
    } else { (Vec::new(), Vec::new()) };
    let (watch_consumers, access, ranges) = watches::derivation_ranges(
        tx, verified, &whole, &datasets, &partitions, watch_basis, budget, cancellation,
    ).await?;
    seeds.extend(watch_consumers);
    range_access.extend(access);
    let (mut impact, consumers) = consumer_impact_read(tx, seeds, budget, cancellation, Some(verified)).await?;
    impact.access.extend(range_access);
    let mut access = BTreeMap::new();
    for scope in impact.access {
        let key = crate::definitions::canonical_digest(&scope)
            .map_err(|error| StoreError::caused_by(CommitFailure::InvalidBatch, FailureStage::Prepare, crate::definitions::DefinitionError::from(error)))?;
        access.insert(key, scope);
    }
    impact = authorization::actual_impact(access.into_values().collect(), impact.effects, impact.labels, impact.state, impact.source_ids)
        .map_err(watches::auth_error)?;
    let fingerprint = crate::definitions::canonical_digest(&(
        "world.derived-support-ranges.v1", heads, ranges, consumers, &impact,
    )).map_err(|error| StoreError::caused_by(CommitFailure::InvalidBatch, FailureStage::Prepare, crate::definitions::DefinitionError::from(error)))?;
    Ok((impact, fingerprint))
}

pub(super) async fn derivation_read(
    tx: &WorldTransaction<'_>, verified: &VerifiedInvocation, support: &SupportSet,
    resources: Vec<ResourceRef>, labels: Vec<String>, sources: Vec<SourceId>,
) -> Result<world_protocol::authorization::ActualImpact, StoreError> {
    let impact = authorization::actual_impact(vec![AccessScope {
        resources, fields: Vec::new(), modes: vec![AccessMode::Read],
        scope: support.scope.clone(), valid_time: Some(support.valid_time.clone()),
    }], vec![Effect::Pure], labels, Vec::new(), sources).map_err(watches::auth_error)?;
    authorization::check_impact_read(tx, verified, &impact, &tx.now().await?)
        .await.map_err(watches::auth_error)?;
    Ok(impact)
}

pub(super) async fn consumer_impact(
    tx: &WorldTransaction<'_>, seeds: Vec<SupportSet>, budget: &CallBudget,
    cancellation: &tokio_util::sync::CancellationToken,
) -> Result<world_protocol::authorization::ActualImpact, StoreError> {
    Ok(consumer_impact_read(tx, seeds, budget, cancellation, None).await?.0)
}

async fn consumer_impact_read(
    tx: &WorldTransaction<'_>, seeds: Vec<SupportSet>, budget: &CallBudget,
    cancellation: &tokio_util::sync::CancellationToken, verified: Option<&VerifiedInvocation>,
) -> Result<(world_protocol::authorization::ActualImpact, Digest), StoreError> {
    let mut pending: VecDeque<_> = seeds.into();
    let mut seen = BTreeSet::new();
    let mut heads = BTreeMap::new();
    let (mut access, mut effects, mut labels, mut state, mut sources) = (Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new());
    while let Some(support) = pending.pop_front() {
        super::checkpoint(budget, cancellation)?;
        if !seen.insert(support.reference.id.clone()) { continue; }
        if seen.len() > BATCH_LIMIT { return Err(super::limit(ProvenanceLimit::ComponentNodes)); }
        heads.insert(support.reference.clone(), support.clone());
        if let Some(verified) = verified {
            let read = derivation_read(tx, verified, &support,
                vec![ResourceRef::Support { id: support.reference.id.clone() },
                    ResourceRef::Assertion { id: support.conclusion.id.clone() }], Vec::new(), Vec::new()).await?;
            access.extend(read.access);
        }
        let impact = support_impact_read(tx, &support, verified).await?;
        access.extend(impact.access); effects.extend(impact.effects); labels.extend(impact.labels); state.extend(impact.state); sources.extend(impact.source_ids);
        let mut after = String::new();
        loop {
            super::checkpoint(budget, cancellation)?;
            let sql = if verified.is_some() {
                "SELECT r.support_id,r.scope_id,r.body->'validTime' AS valid_time FROM world_support_head h JOIN world_support_revision r USING(tenant_id,world_id,support_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 AND r.release_id=$5 AND r.branch_id IS NOT DISTINCT FROM $6 AND h.support_id>$7 AND EXISTS(SELECT 1 FROM world_support_premise p WHERE p.tenant_id=h.tenant_id AND p.world_id=h.world_id AND p.support_id=h.support_id AND p.support_revision=h.revision AND p.premise_kind='assertion' AND p.premise_id=$3 AND p.premise_revision=$4) ORDER BY r.support_id LIMIT 256 FOR SHARE OF h"
            } else {
                "SELECT DISTINCT r.support_id,r.body FROM world_support_premise p JOIN world_support_head h ON h.tenant_id=p.tenant_id AND h.world_id=p.world_id AND h.support_id=p.support_id AND h.revision=p.support_revision JOIN world_support_revision r ON r.tenant_id=h.tenant_id AND r.world_id=h.world_id AND r.support_id=h.support_id AND r.revision=h.revision WHERE p.tenant_id=$1 AND p.world_id=$2 AND p.premise_kind='assertion' AND p.premise_id=$3 AND p.premise_revision=$4 AND r.release_id=$5 AND r.branch_id IS NOT DISTINCT FROM $6 AND p.support_id>$7 ORDER BY r.support_id LIMIT 256"
            };
            let rows = tx.query(sql, &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &support.conclusion.id.as_str(), &number(support.conclusion.revision.0)?, &support.release_id.as_str(), &support.branch_id.as_ref().map(BranchId::as_str), &after]).await?;
            if rows.is_empty() { break; }
            for row in rows {
                after = row.get("support_id");
                let body = if let Some(verified) = verified {
                    let id = SupportId::try_new(after.clone())
                        .map_err(|_| reject(ProvenanceFailure::InternalFault))?;
                    let scope = ScopeId::try_new(row.get::<_, String>("scope_id"))
                        .map_err(|_| reject(ProvenanceFailure::InternalFault))?;
                    let valid_time = decode(row.get("valid_time"))?;
                    let mut context = support.clone();
                    context.scope = scope; context.valid_time = valid_time;
                    let read = derivation_read(tx, verified, &context,
                        vec![ResourceRef::Support { id }], Vec::new(), Vec::new()).await?;
                    access.extend(read.access);
                    tx.query_opt("SELECT r.body FROM world_support_head h JOIN world_support_revision r USING(tenant_id,world_id,support_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 AND h.support_id=$3", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &after]).await?
                        .ok_or_else(|| reject(ProvenanceFailure::MissingPremise))?.get("body")
                } else {
                    row.get("body")
                };
                pending.push_back(decode(body)?);
            }
        }
    }
    let impact = authorization::actual_impact(access, effects, labels, state, sources).map_err(watches::auth_error)?;
    let fingerprint = crate::definitions::canonical_digest(&(
        "world.derived-support-consumers.v1", heads.into_values().collect::<Vec<_>>(), &impact,
    )).map_err(|error| StoreError::caused_by(CommitFailure::InvalidBatch, FailureStage::Prepare, crate::definitions::DefinitionError::from(error)))?;
    Ok((impact, fingerprint))
}

pub(super) async fn support_impact(
    tx: &WorldTransaction<'_>, support: &SupportSet,
) -> Result<world_protocol::authorization::ActualImpact, StoreError> {
    support_impact_read(tx, support, None).await
}

async fn support_impact_read(
    tx: &WorldTransaction<'_>, support: &SupportSet, verified: Option<&VerifiedInvocation>,
) -> Result<world_protocol::authorization::ActualImpact, StoreError> {
    let mut access = vec![AccessScope {
        resources: vec![
            ResourceRef::Assertion {
                id: support.conclusion.id.clone(),
            },
            ResourceRef::Support {
                id: support.reference.id.clone(),
            },
        ],
        fields: Vec::new(),
        modes: vec![AccessMode::Write],
        scope: support.scope.clone(),
        valid_time: Some(support.valid_time.clone()),
    }];
    let mut sources = Vec::new();
    let mut labels = Vec::new();
    for dependency in dependencies(support) {
        if let ReadDependency::Evidence { reference } = &dependency {
            if let Some(verified) = verified {
                let read = derivation_read(tx, verified, support,
                    vec![ResourceRef::Evidence { id: reference.id.clone() }], Vec::new(), Vec::new()).await?;
                access.extend(read.access);
            }
            let row = tx.query_opt("SELECT r.body FROM world_evidence_head h JOIN world_evidence_revision r USING(tenant_id,world_id,evidence_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 AND h.evidence_id=$3 FOR SHARE OF h", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &reference.id.as_str()]).await?.ok_or_else(|| reject(ProvenanceFailure::MissingPremise))?;
            let evidence: Evidence = decode(row.get("body"))?;
            if let Some(verified) = verified {
                let read = derivation_read(tx, verified, support,
                    vec![ResourceRef::Evidence { id: reference.id.clone() },
                        ResourceRef::Source { id: evidence.locator.source_version.source_id.clone() }],
                    evidence.access.labels.clone(), vec![evidence.locator.source_version.source_id.clone()]).await?;
                access.extend(read.access); sources.extend(read.source_ids);
            }
            labels.extend(evidence.access.labels);
        }
        let resource = match dependency {
            ReadDependency::Assertion { reference } => ResourceRef::Assertion { id: reference.id },
            ReadDependency::Evidence { reference } => ResourceRef::Evidence { id: reference.id },
            ReadDependency::Definition { reference } => {
                ResourceRef::Definition { id: reference.id }
            }
            ReadDependency::SourceMapping { binding, .. } => {
                ResourceRef::Definition { id: binding.id }
            }
            ReadDependency::SourceField { schema, .. } => {
                let row = tx.query_opt("SELECT source_id FROM world_source_schema_revision WHERE tenant_id=$1 AND world_id=$2 AND schema_id=$3 AND revision=$4", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &schema.id.as_str(), &number(schema.revision.0)?]).await?.ok_or_else(|| reject(ProvenanceFailure::MissingPremise))?;
                let id = SourceId::try_new(row.get::<_, String>("source_id")).map_err(|error| {
                    StoreError::caused_by(CommitFailure::InternalFault, FailureStage::Read, error)
                })?;
                sources.push(id.clone());
                ResourceRef::Source { id }
            }
            ReadDependency::Watch { id, .. } => ResourceRef::Watch { id },
            ReadDependency::Source { position, .. } => {
                sources.push(position.source_id.clone());
                ResourceRef::Source {
                    id: position.source_id,
                }
            }
            ReadDependency::Identity {
                subject: world_protocol::identity::SubjectRef::Object { id },
                ..
            } => ResourceRef::Object { id },
            ReadDependency::Identity {
                subject: world_protocol::identity::SubjectRef::Relation { id },
                ..
            } => ResourceRef::Relation { id },
            ReadDependency::AliasRange { .. } | ReadDependency::TimeBoundary { .. } => continue,
        };
        if let Some(verified) = verified {
            derivation_read(tx, verified, support, vec![resource.clone()], labels.clone(), sources.clone()).await?;
        }
        access.push(AccessScope {
            resources: vec![resource],
            fields: Vec::new(),
            modes: vec![AccessMode::Read],
            scope: support.scope.clone(),
            valid_time: Some(support.valid_time.clone()),
        });
    }
    if let Some(verified) = verified {
        let read = authorization::actual_impact(access.iter().filter(|access| access.modes == [AccessMode::Read]).cloned().collect(),
            vec![Effect::Pure], labels.clone(), Vec::new(), sources.clone()).map_err(watches::auth_error)?;
        authorization::check_impact_read(tx, verified, &read, &tx.now().await?).await.map_err(watches::auth_error)?;
    }
    authorization::actual_impact(access, vec![Effect::Pure], labels, Vec::new(), sources)
        .map_err(watches::auth_error)
}

pub(crate) async fn invalidate(
    tx: &mut WorldTransaction<'_>,
    before_assertions: &[Assertion],
    after_assertions: &[Assertion],
    before_evidence: &[Evidence],
    after_evidence: &[Evidence],
    budget: &CallBudget,
    cancellation: &tokio_util::sync::CancellationToken,
    at: &Timestamp,
) -> Result<Vec<AssertionRef>, StoreError> {
    let mut certain = Vec::new();
    let mut uncertain = Vec::new();
    if before_assertions
        .iter()
        .chain(after_assertions)
        .any(|assertion| assertion.reference.world != *tx.world())
    {
        return Err(reject(ProvenanceFailure::CrossScope));
    }
    let claims: Vec<_> = before_assertions
        .iter()
        .chain(after_assertions)
        .map(|assertion| (&assertion.claim, &assertion.origin))
        .collect();
    let (datasets, partitions) = assertion_ranges(tx, &claims).await?;
    for before in before_assertions {
        if after_assertions
            .iter()
            .any(|after| after.reference.id == before.reference.id && after != before)
        {
            certain.push(ReadDependency::Assertion {
                reference: before.reference.clone(),
            });
        }
    }
    for after in after_assertions {
        if matches!(
            after.status,
            AssertionStatus::Rejected | AssertionStatus::Withdrawn
        ) {
            certain.push(ReadDependency::Assertion {
                reference: after.reference.clone(),
            });
        }
        if let Some(reference) = &after.supersedes {
            certain.push(ReadDependency::Assertion {
                reference: reference.clone(),
            });
        }
    }
    for before in before_evidence {
        if before.reference.world != *tx.world() {
            return Err(reject(ProvenanceFailure::CrossScope));
        }
        if let Some(after) = after_evidence
            .iter()
            .find(|after| after.reference.id == before.reference.id)
        {
            match after.status {
                EvidenceStatus::Withdrawn | EvidenceStatus::ContentDeleted => {
                    certain.push(ReadDependency::Evidence {
                        reference: before.reference.clone(),
                    })
                }
                EvidenceStatus::Active
                    if before.origin_family != after.origin_family
                        || before.digest != after.digest
                        || before.derived_from != after.derived_from
                        || before.authority != after.authority =>
                {
                    uncertain.push(ReadDependency::Evidence {
                        reference: before.reference.clone(),
                    })
                }
                _ => {}
            }
        }
    }
    let mut affected =
        watches::invalidate_ranges(tx, &datasets, &partitions, budget, cancellation, at).await?;
    affected.extend(invalidate_dependencies(tx, &certain, true, budget, cancellation, at).await?);
    affected
        .extend(invalidate_dependencies(tx, &uncertain, false, budget, cancellation, at).await?);
    affected.sort();
    affected.dedup();
    Ok(affected)
}

pub(crate) async fn lock_assertion_ranges(
    tx: &WorldTransaction<'_>,
    claims: &[(&Claim, &world_protocol::facts::AssertionOrigin)],
) -> Result<watches::LockedRanges, StoreError> {
    let (datasets, partitions) = assertion_ranges(tx, claims).await?;
    watches::lock_ranges(tx, &datasets, &partitions).await
}

pub(crate) async fn assertion_ranges(
    tx: &WorldTransaction<'_>,
    claims: &[(&Claim, &world_protocol::facts::AssertionOrigin)],
) -> Result<(Vec<DefinitionId>, Vec<String>), StoreError> {
    let mut datasets = BTreeSet::new();
    let mut partitions = BTreeSet::new();
    for (claim, origin) in claims {
        match claim {
            Claim::Attribute(claim) => {
                datasets.insert(claim.property.id.clone());
                let (sql, id) = match &claim.subject {
                    world_protocol::identity::SubjectRef::Object { id } => (
                        "SELECT type_id FROM world_object_identity WHERE tenant_id=$1 AND world_id=$2 AND object_id=$3",
                        id.as_str(),
                    ),
                    world_protocol::identity::SubjectRef::Relation { id } => (
                        "SELECT type_id FROM world_relation_identity WHERE tenant_id=$1 AND world_id=$2 AND relation_id=$3",
                        id.as_str(),
                    ),
                };
                if let Some(row) = tx
                    .query_opt(
                        sql,
                        &[
                            &tx.world().tenant_id.as_str(),
                            &tx.world().world_id.as_str(),
                            &id,
                        ],
                    )
                    .await?
                {
                    datasets.insert(
                        DefinitionId::try_new(row.get::<_, String>("type_id")).map_err(
                            |error| {
                                StoreError::caused_by(
                                    CommitFailure::InternalFault,
                                    FailureStage::Read,
                                    error,
                                )
                            },
                        )?,
                    );
                }
            }
            Claim::Relation(claim) => {
                datasets.insert(claim.relation_type.id.clone());
            }
        }
        if let world_protocol::facts::AssertionOrigin::Source {
            binding, position, ..
        } = origin
        {
            datasets.insert(binding.id.clone());
            if let Some(position) = position {
                partitions.insert(position.partition.clone());
            }
        }
    }
    Ok((
        datasets.into_iter().collect(),
        partitions.into_iter().collect(),
    ))
}

pub(crate) async fn invalidate_dependencies(
    tx: &mut WorldTransaction<'_>,
    dependencies: &[ReadDependency],
    certain: bool,
    budget: &CallBudget,
    cancellation: &tokio_util::sync::CancellationToken,
    at: &Timestamp,
) -> Result<Vec<AssertionRef>, StoreError> {
    let mut changed = BTreeMap::new();
    let mut selected = BTreeMap::new();
    for dependency in dependencies {
        if let ReadDependency::Watch { id, generation } = dependency {
            let (supports, _) = watch_consumers_read(tx, id, Some(*generation), None, budget, cancellation).await?;
            for support in supports { selected.insert(support.reference.id.clone(), support); }
            continue;
        }
        let (kind, id, revision, generation) = dependency_key(dependency)?;
        let mut after = String::new();
        loop {
            super::checkpoint(budget, cancellation)?;
            let rows = tx.query("SELECT r.body FROM world_support_premise p JOIN world_support_head h ON h.tenant_id=p.tenant_id AND h.world_id=p.world_id AND h.support_id=p.support_id AND h.revision=p.support_revision JOIN world_support_revision r ON r.tenant_id=h.tenant_id AND r.world_id=h.world_id AND r.support_id=h.support_id AND r.revision=h.revision WHERE p.tenant_id=$1 AND p.world_id=$2 AND p.premise_kind=$3 AND p.premise_id=$4 AND ($5::bigint IS NULL OR p.premise_revision=$5 OR ($3='evidence' AND p.premise_revision<$5)) AND ($6::bigint IS NULL OR p.watch_generation<=$6) AND p.support_id>$7 ORDER BY p.support_id LIMIT 256", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &kind, &id, &revision, &generation, &after]).await?;
            if rows.is_empty() {
                break;
            }
            for row in rows {
                let support: SupportSet = decode(row.get("body"))?;
                after = support.reference.id.to_string();
                selected.insert(support.reference.id.clone(), support);
            }
        }
    }
    if !selected.is_empty() {
        graph::validate(
            tx,
            &SupportDeltaProposal {
                upserts: selected.values().cloned().collect(),
                invalidate: Vec::new(),
                affected_watches: Vec::new(),
                observed_dependencies: Vec::new(),
            },
            budget,
            cancellation,
        )
        .await?;
    }
    for support in selected.into_values() {
        super::checkpoint(budget, cancellation)?;
        let mut support = current(tx, &support.reference.id)
            .await?
            .ok_or_else(|| reject(ProvenanceFailure::MissingPremise))?;
        if certain && support.status == SupportStatus::Invalid && support.dirty == DirtyState::Clean
        {
            continue;
        }
        let mut matches = false;
        for actual in super::dependencies(&support) {
            let (actual_kind, actual_id, actual_revision, actual_generation) =
                dependency_key(&actual)?;
            for changed in dependencies {
                let (kind, id, revision, generation) = dependency_key(changed)?;
                if kind == actual_kind
                    && id == actual_id
                    && (revision.is_none()
                        || revision == actual_revision
                        || (kind == "evidence" && actual_revision < revision))
                    && (generation.is_none() || actual_generation <= generation)
                {
                    matches = true;
                    break;
                }
            }
        }
        if !matches {
            continue;
        }
        if certain {
            support.status = SupportStatus::Invalid;
            support.dirty = DirtyState::Clean;
        } else {
            let generation = mark_work(
                tx,
                &support,
                at,
                "dependency_changed",
                &key(dependencies)?,
                budget,
                cancellation,
            )
            .await?;
            if matches!(support.dirty, DirtyState::Dirty { generation: old, .. } if old == generation)
            {
                continue;
            }
            support.dirty = DirtyState::Dirty {
                generation,
                invalidated_at: at.clone(),
                watches: dependencies
                    .iter()
                    .filter_map(|dependency| match dependency {
                        ReadDependency::Watch { id, .. } => Some(id.clone()),
                        _ => None,
                    })
                    .collect(),
            };
        }
        append(tx, &mut support, false).await?;
        changed.insert(context(&support)?, support);
    }
    propagate(
        tx,
        changed.into_values().collect(),
        budget,
        cancellation,
        at,
    )
    .await
}

pub(super) async fn watch_consumers_read(
    tx: &WorldTransaction<'_>, id: &WatchId, generation: Option<Generation>,
    verified: Option<&VerifiedInvocation>, budget: &CallBudget,
    cancellation: &tokio_util::sync::CancellationToken,
) -> Result<(Vec<SupportSet>, Vec<AccessScope>), StoreError> {
    let generation = generation.map(|generation| number(generation.0)).transpose()?;
    let mut supports = Vec::new();
    let mut access = Vec::new();
    let mut after = String::new();
    loop {
        super::checkpoint(budget, cancellation)?;
        let sql = if verified.is_some() {
            "SELECT r.support_id,r.scope_id,r.body->'validTime' AS valid_time FROM world_support_head h JOIN world_support_revision r USING(tenant_id,world_id,support_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 AND h.support_id>$5 AND EXISTS(SELECT 1 FROM world_support_premise p WHERE p.tenant_id=h.tenant_id AND p.world_id=h.world_id AND p.support_id=h.support_id AND p.support_revision=h.revision AND p.premise_kind='watch' AND p.premise_id=$3 AND ($4::bigint IS NULL OR p.watch_generation<=$4)) ORDER BY r.support_id LIMIT 256 FOR SHARE OF h"
        } else {
            "SELECT r.support_id,r.body FROM world_support_head h JOIN world_support_revision r USING(tenant_id,world_id,support_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 AND h.support_id>$5 AND EXISTS(SELECT 1 FROM world_support_premise p WHERE p.tenant_id=h.tenant_id AND p.world_id=h.world_id AND p.support_id=h.support_id AND p.support_revision=h.revision AND p.premise_kind='watch' AND p.premise_id=$3 AND ($4::bigint IS NULL OR p.watch_generation<=$4)) ORDER BY r.support_id LIMIT 256"
        };
        let rows = tx.query(sql, &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &id.as_str(), &generation, &after]).await?;
        if rows.is_empty() { break; }
        for row in rows {
            super::checkpoint(budget, cancellation)?;
            after = row.get("support_id");
            if supports.len() == BATCH_LIMIT { return Err(super::limit(ProvenanceLimit::AlternativeSupports)); }
            let support = if let Some(verified) = verified {
                let id = SupportId::try_new(after.clone()).map_err(|_| reject(ProvenanceFailure::InternalFault))?;
                let scope = ScopeId::try_new(row.get::<_, String>("scope_id")).map_err(|_| reject(ProvenanceFailure::InternalFault))?;
                let valid_time: world_protocol::time::ValidTime = decode(row.get("valid_time"))?;
                let read = authorization::actual_impact(vec![AccessScope {
                    resources: vec![ResourceRef::Support { id: id.clone() }], fields: Vec::new(),
                    modes: vec![AccessMode::Read], scope: scope.clone(), valid_time: Some(valid_time.clone()),
                }], vec![Effect::Pure], Vec::new(), Vec::new(), Vec::new()).map_err(watches::auth_error)?;
                authorization::check_impact_read(tx, verified, &read, &tx.now().await?).await.map_err(watches::auth_error)?;
                access.extend(read.access);
                let body = tx.query_opt("SELECT r.body FROM world_support_head h JOIN world_support_revision r USING(tenant_id,world_id,support_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 AND h.support_id=$3", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &after]).await?.ok_or_else(|| reject(ProvenanceFailure::MissingPremise))?;
                let support: SupportSet = decode(body.get("body"))?;
                if support.reference.world != *tx.world() || support.reference.id != id
                    || support.scope != scope || support.valid_time != valid_time {
                    return Err(reject(ProvenanceFailure::CrossScope));
                }
                support
            } else { decode(row.get("body"))? };
            supports.push(support);
        }
    }
    Ok((supports, access))
}

pub(super) async fn current(
    tx: &WorldTransaction<'_>,
    id: &SupportId,
) -> Result<Option<SupportSet>, StoreError> {
    tx.query_opt("SELECT r.body FROM world_support_head h JOIN world_support_revision r USING(tenant_id,world_id,support_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 AND h.support_id=$3 FOR UPDATE OF h", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &id.as_str()]).await?.map(|row| decode(row.get("body"))).transpose()
}

pub(super) async fn append(
    tx: &mut WorldTransaction<'_>,
    support: &mut SupportSet,
    proposed: bool,
) -> Result<(), StoreError> {
    let previous = current(tx, &support.reference.id).await?;
    let next = previous.as_ref().map_or(Ok(1), |old| {
        old.reference
            .revision
            .0
            .checked_add(1)
            .ok_or_else(|| reject(ProvenanceFailure::InternalFault))
    })?;
    if proposed && support.reference.revision != Revision(next) {
        return Err(StoreError::new(
            CommitFailure::RevisionConflict {
                resource: ResourceRef::Support {
                    id: support.reference.id.clone(),
                },
                expected: support.reference.revision,
                actual: Revision(next),
            },
            FailureStage::Validate,
        ));
    }
    if previous.as_ref().is_some_and(|old| {
        old.rule != support.rule
            || old.arguments != support.arguments
            || old.conclusion != support.conclusion
            || old.scope != support.scope
            || old.release_id != support.release_id
            || old.branch_id != support.branch_id
            || old.valid_time != support.valid_time
    }) {
        return Err(reject(ProvenanceFailure::CrossScope));
    }
    support.reference.revision = Revision(next);
    let status = match support.status {
        SupportStatus::Valid => "valid",
        SupportStatus::Invalid => "invalid",
        SupportStatus::Pending => "pending",
    };
    tx.execute("INSERT INTO world_support_revision(tenant_id,world_id,support_id,revision,conclusion_id,conclusion_revision,rule_id,rule_revision,scope_id,release_id,branch_id,valid_from,valid_to,status,dirty,body,valid_from_ns,valid_to_ns) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::text::timestamptz,$13::text::timestamptz,$14,$15,$16,$17::text::numeric,$18::text::numeric)", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &support.reference.id.as_str(), &number(next)?, &support.conclusion.id.as_str(), &number(support.conclusion.revision.0)?, &support.rule.id.as_str(), &number(support.rule.revision.0)?, &support.scope.as_str(), &support.release_id.as_str(), &support.branch_id.as_ref().map(BranchId::as_str), &support.valid_time.from.as_str(), &support.valid_time.to.as_ref().map(Timestamp::as_str), &status, &matches!(support.dirty, DirtyState::Dirty { .. }), &encode(support)?, &support.valid_time.from.unix_nanos().to_string(), &support.valid_time.to.as_ref().map(|at| at.unix_nanos().to_string())]).await?;
    for (ordinal, dependency) in dependencies(support).iter().enumerate() {
        let (kind, id, revision, generation) = dependency_key(dependency)?;
        tx.execute("INSERT INTO world_support_premise(tenant_id,world_id,support_id,support_revision,ordinal,premise_kind,premise_id,premise_revision,watch_generation,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &support.reference.id.as_str(), &number(next)?, &(ordinal as i32), &kind, &id, &revision, &generation, &encode(dependency)?]).await?;
    }
    tx.execute("INSERT INTO world_support_head(tenant_id,world_id,support_id,revision) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,world_id,support_id) DO UPDATE SET revision=EXCLUDED.revision", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &support.reference.id.as_str(), &number(next)?]).await?;
    // A batch can revise one support more than once while closing its impact graph.
    // The last head is the receipt revision; intermediate revisions remain durable.
    tx.record_revision(CommittedRevision {
        resource: ResourceRef::Support {
            id: support.reference.id.clone(),
        },
        revision: support.reference.revision,
    })?;
    Ok(())
}

pub(super) fn context(support: &SupportSet) -> Result<String, StoreError> {
    key(&(
        &support.conclusion,
        &support.scope,
        &support.release_id,
        &support.branch_id,
    ))
}

pub(super) async fn alternatives(
    tx: &WorldTransaction<'_>,
    support: &SupportSet,
    budget: &CallBudget,
    cancellation: &tokio_util::sync::CancellationToken,
) -> Result<Vec<SupportSet>, StoreError> {
    basis::stored_supports(
        basis::Reader::Transaction(tx), &support.conclusion, &support.scope,
        &support.release_id, support.branch_id.as_ref(), Some(budget), Some(cancellation),
    ).await
}

async fn propagate(
    tx: &mut WorldTransaction<'_>,
    seeds: Vec<SupportSet>,
    budget: &CallBudget,
    cancellation: &tokio_util::sync::CancellationToken,
    at: &Timestamp,
) -> Result<Vec<AssertionRef>, StoreError> {
    let mut marked = BTreeMap::new();
    for support in &seeds {
        if let DirtyState::Dirty { generation, .. } = support.dirty {
            marked.insert(context(support)?, generation);
        }
    }
    let mut pending: VecDeque<SupportSet> = seeds.into();
    let mut seen = BTreeMap::new();
    let mut affected = BTreeSet::new();
    while let Some(support) = pending.pop_front() {
        super::checkpoint(budget, cancellation)?;
        let all = alternatives(tx, &support, budget, cancellation).await?;
        let signature = key(&all)?;
        // Maintenance revisions alone must not reactivate a cycle of old false groups.
        let state = key(&all
            .iter()
            .map(|support| {
                (
                    &support.reference.id,
                    &support.premises,
                    support.status,
                    support.dirty != DirtyState::Clean,
                    &support.valid_time,
                )
            })
            .collect::<Vec<_>>())?;
        affected.insert(support.conclusion.clone());
        refresh_explanation(tx, &support, &all).await?;
        if seen.insert(context(&support)?, state.clone()).as_ref() == Some(&state) {
            continue;
        }
        let snapshot = transaction_snapshot(tx, &support.conclusion, &support.scope, &support.release_id, support.branch_id.as_ref(), budget, cancellation).await?;
        let mut after = String::new();
        loop {
            super::checkpoint(budget, cancellation)?;
            let rows = tx.query("SELECT r.body FROM world_support_premise p JOIN world_support_head h ON h.tenant_id=p.tenant_id AND h.world_id=p.world_id AND h.support_id=p.support_id AND h.revision=p.support_revision JOIN world_support_revision r ON r.tenant_id=h.tenant_id AND r.world_id=h.world_id AND r.support_id=h.support_id AND r.revision=h.revision WHERE p.tenant_id=$1 AND p.world_id=$2 AND p.premise_kind='assertion' AND p.premise_id=$3 AND p.premise_revision=$4 AND r.release_id=$5 AND r.branch_id IS NOT DISTINCT FROM $6 AND p.support_id>$7 ORDER BY p.support_id LIMIT 256", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &support.conclusion.id.as_str(), &number(support.conclusion.revision.0)?, &support.release_id.as_str(), &support.branch_id.as_ref().map(BranchId::as_str), &after]).await?;
            if rows.is_empty() {
                break;
            }
            for row in rows {
                super::checkpoint(budget, cancellation)?;
                let consumer: SupportSet = decode(row.get("body"))?;
                after = consumer.reference.id.to_string();
                let mut consumer = current(tx, &consumer.reference.id)
                    .await?
                    .ok_or_else(|| reject(ProvenanceFailure::MissingPremise))?;
                let state = resolve_interval(
                    &snapshot,
                    &support.conclusion,
                    &support.scope,
                    &support.release_id,
                    support.branch_id.as_ref(),
                    &consumer.valid_time,
                );
                if matches!(state, ConclusionSupport::Unsupported) {
                    if consumer.status != SupportStatus::Invalid
                        || consumer.dirty != DirtyState::Clean
                    {
                        consumer.status = SupportStatus::Invalid;
                        consumer.dirty = DirtyState::Clean;
                        append(tx, &mut consumer, false).await?;
                    }
                } else if matches!(state, ConclusionSupport::Dirty { .. })
                    || consumer.status != SupportStatus::Valid
                    || consumer.dirty != DirtyState::Clean
                {
                    let target = context(&consumer)?;
                    let generation = if let Some(generation) = marked.get(&target) {
                        *generation
                    } else {
                        let generation = mark_work(
                            tx,
                            &consumer,
                            at,
                            "upstream_changed",
                            &signature,
                            budget,
                            cancellation,
                        )
                        .await?;
                        marked.insert(target, generation);
                        generation
                    };
                    if !matches!(consumer.dirty, DirtyState::Dirty { generation: old, .. } if old == generation)
                    {
                        consumer.dirty = DirtyState::Dirty {
                            generation,
                            invalidated_at: at.clone(),
                            watches: Vec::new(),
                        };
                        append(tx, &mut consumer, false).await?;
                    }
                }
                pending.push_back(consumer);
            }
        }
    }
    Ok(affected.into_iter().collect())
}

pub(super) async fn mark_work(
    tx: &WorldTransaction<'_>,
    support: &SupportSet,
    at: &Timestamp,
    reason: &str,
    cause: &str,
    budget: &CallBudget,
    cancellation: &tokio_util::sync::CancellationToken,
) -> Result<Generation, StoreError> {
    let id = context(support)?;
    let row = tx.query_opt("SELECT writer_epoch,mode FROM world_writer_gate WHERE tenant_id=$1 AND world_id=$2 AND domain='facts' FOR SHARE", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str()]).await?.ok_or_else(|| reject(ProvenanceFailure::MissingPremise))?;
    if row.get::<_, String>("mode") != "active" {
        let epoch = WriterEpoch(row.get::<_, i64>("writer_epoch") as u64);
        return Err(StoreError::new(
            CommitFailure::Fenced {
                expected: epoch,
                actual: epoch,
            },
            FailureStage::Admission,
        ));
    }
    let fence = world_protocol::commit::WriteFence {
        world: tx.world().clone(),
        domain: WriterDomain::try_new("facts").expect("fixed writer domain"),
        epoch: WriterEpoch(row.get::<_, i64>("writer_epoch") as u64),
    };
    let old = tx.query_opt("SELECT dirty_generation,actual_basis,status,reason_code FROM world_dirty_recompute WHERE tenant_id=$1 AND world_id=$2 AND target_kind='support' AND target_id=$3 FOR UPDATE", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &id]).await?;
    if let Some(row) = &old {
        let previous: super::recompute::RecomputeBasis = decode(row.get("actual_basis"))?;
        if matches!(
            row.get::<_, String>("status").as_str(),
            "pending" | "claimed"
        ) && row.get::<_, String>("reason_code") == reason
            && previous.cause == cause
            && previous.work.fence == fence
        {
            return Ok(previous.work.generation);
        }
    }
    let generation = Generation(
        old.as_ref()
            .map_or(0, |row| row.get::<_, i64>("dirty_generation") as u64)
            .checked_add(1)
            .ok_or_else(|| reject(ProvenanceFailure::InternalFault))?,
    );
    let mut actual = dependencies(support);
    for alternative in alternatives(tx, support, budget, cancellation).await? {
        for dependency in dependencies(&alternative) {
            if !actual.contains(&dependency) {
                actual.push(dependency);
            }
        }
    }
    let work = DirtyRecompute {
        conclusion: support.conclusion.clone(),
        generation,
        dependencies: actual,
        fence: fence.clone(),
        release_id: support.release_id.clone(),
        branch_id: support.branch_id.clone(),
    };
    let basis = super::recompute::RecomputeBasis {
        work,
        scope: support.scope.clone(),
        cause: cause.into(),
    };
    tx.execute("INSERT INTO world_dirty_recompute(tenant_id,world_id,target_kind,target_id,dirty_generation,actual_basis,writer_domain,writer_epoch,status,reason_code,due_at) VALUES($1,$2,'support',$3,$4,$5,$6,$7,'pending',$8,$9::text::timestamptz) ON CONFLICT(tenant_id,world_id,target_kind,target_id) DO UPDATE SET dirty_generation=EXCLUDED.dirty_generation,actual_basis=EXCLUDED.actual_basis,writer_domain=EXCLUDED.writer_domain,writer_epoch=EXCLUDED.writer_epoch,status='pending',claim_token=NULL,claimed_by=NULL,lease_until=NULL,due_at=EXCLUDED.due_at,reason_code=EXCLUDED.reason_code,failure=NULL,updated_at=clock_timestamp()", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &id, &number(generation.0)?, &encode(&basis)?, &fence.domain.as_str(), &number(fence.epoch.0)?, &reason, &at.as_str()]).await?;
    Ok(generation)
}

pub(super) async fn refresh_explanation(
    tx: &WorldTransaction<'_>,
    support: &SupportSet,
    supports: &[SupportSet],
) -> Result<(), StoreError> {
    // All release/branch projections share this revision sequence, not a world-wide lock.
    tx.execute("INSERT INTO world_support_graph_guard(tenant_id,world_id,scope_id,component_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &support.scope.as_str(), &support.conclusion.id.as_str()]).await?;
    tx.query_opt("SELECT generation FROM world_support_graph_guard WHERE tenant_id=$1 AND world_id=$2 AND scope_id=$3 AND component_id=$4 FOR UPDATE", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &support.scope.as_str(), &support.conclusion.id.as_str()]).await?;
    let previous = tx.query_opt("SELECT revision,body FROM world_explanation_revision WHERE tenant_id=$1 AND world_id=$2 AND conclusion_id=$3 AND conclusion_revision=$4 ORDER BY revision DESC LIMIT 1", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &support.conclusion.id.as_str(), &number(support.conclusion.revision.0)?]).await?;
    if let Some(row) = &previous {
        if decode::<ExplanationGraph>(row.get("body"))?.supports == supports {
            return Ok(());
        }
    }
    let revision = previous
        .as_ref()
        .map_or(0, |row| row.get::<_, i64>("revision"))
        .checked_add(1)
        .ok_or_else(|| reject(ProvenanceFailure::InternalFault))?;
    let graph = ExplanationGraph {
        conclusion: support.conclusion.clone(),
        revision: Revision(revision as u64),
        supports: supports.to_vec(),
        visible_evidence: Vec::new(),
    };
    let dirty_generation = supports
        .iter()
        .filter_map(|support| match support.dirty {
            DirtyState::Dirty { generation, .. } => Some(generation.0),
            DirtyState::Clean => None,
        })
        .max()
        .unwrap_or(0);
    tx.execute("INSERT INTO world_explanation_revision(tenant_id,world_id,conclusion_id,conclusion_revision,revision,dirty_generation,body) VALUES($1,$2,$3,$4,$5,$6,$7)", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &support.conclusion.id.as_str(), &number(support.conclusion.revision.0)?, &revision, &number(dirty_generation)?, &encode(&graph)?]).await?;
    Ok(())
}
