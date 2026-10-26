use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;
use world_protocol::{
    budget::BudgetDimension,
    identity::{AliasResolution, IdentityCandidate, IdentityFailure, IdentityProposal, IdentityReceipt, IdentityResolveRequest, SourceAlias, SourceKey},
    ids::{Digest, Generation}, provenance::ReadDependency, time::Timestamp,
};
use crate::{authorization::Admission, extensions::invocation::CallBudget,
    sources::sync::{SourceIdentityDeletion, SourceIdentityPrefix, SourceIdentityRow}, store::WorldTransaction};
use super::{IdentityError, aliases, subject, type_id};

#[derive(Clone, PartialEq, Serialize, Deserialize)]
struct SourceRange {
    key: SourceKey,
    generation: Generation,
    aliases: Vec<SourceAlias>,
}

/// Durable observations only; a fresh source-owned prefix and current transaction must recheck them.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct PreparedSourceIdentities {
    prefix: Digest,
    input: Digest,
    ranges: Vec<SourceRange>,
    requests: Vec<IdentityResolveRequest>,
    receipts: Vec<IdentityReceipt>,
}
impl PreparedSourceIdentities {
    pub(crate) fn requests(&self) -> &[IdentityResolveRequest] { &self.requests }
    pub(crate) fn receipts(&self) -> &[IdentityReceipt] { &self.receipts }
}

pub(crate) async fn prepare_source_identities(
    tx: &WorldTransaction<'_>, admission: &Admission, prefix: &SourceIdentityPrefix,
    now: &Timestamp, budget: &CallBudget, cancel: &CancellationToken,
) -> Result<PreparedSourceIdentities, IdentityError> {
    let input = input_digest(prefix)?;
    let datasets: Vec<_> = prefix.rows().iter().map(|row| row.type_ref().id.clone()).collect();
    crate::facts::support::lock_ranges(tx, &datasets, &[]).await?;
    let mut keys: Vec<_> = prefix.rows().iter().map(|row| row.key())
        .chain(prefix.deletions().iter().map(|deletion| deletion.key())).collect();
    keys.sort_by(|a, b| natural(a).cmp(&natural(b)));
    keys.dedup_by(|a, b| natural(a) == natural(b));
    let mut ranges = Vec::with_capacity(keys.len());
    for key in keys {
        checkpoint(budget, cancel)?;
        let generation = aliases::lock_range(tx, key, None).await?;
        let aliases = aliases::source_aliases(tx, key).await?;
        for _ in &aliases { checkpoint(budget, cancel)?; }
        ranges.push(SourceRange { key: key.clone(), generation, aliases });
    }
    for deletion in prefix.deletions() { validate_deletion(tx, admission, deletion, now).await?; }
    let mut receipts = Vec::with_capacity(prefix.rows().len());
    let mut requests = Vec::with_capacity(prefix.rows().len());
    let mut subjects = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for row in prefix.rows() {
        checkpoint(budget, cancel)?;
        if !seen.insert(natural(row.key())) { return Err(IdentityFailure::CandidateScopeIncomplete.into()); }
        validate_row(tx, admission, row, now).await?;
        let range = ranges.iter().find(|range| natural(&range.key) == natural(row.key()))
            .ok_or(IdentityFailure::CandidateScopeIncomplete)?;
        let (receipt, aliases) = aliases::resolve_after_deletions(
            tx, row.key(), row.scope(), range.generation, range.aliases.clone(), prefix.deletions(),
        ).await?;
        if aliases.iter().any(|alias| alias.key.incarnation != row.key().incarnation
            && super::overlaps(&alias.key.valid_time, &row.key().valid_time)) {
            return Err(IdentityFailure::OverlappingIncarnation { source_id: row.key().source_id.clone() }.into());
        }
        let request = request(tx, admission, row, &receipt, &aliases, now, budget, cancel).await?;
        subjects.extend(receipt.dependencies.iter().filter_map(|dependency| match dependency {
            ReadDependency::Identity { subject, .. } => Some(subject.clone()), _ => None,
        }));
        requests.push(request);
        receipts.push(receipt);
    }
    subjects.extend(ranges.iter().flat_map(|range| range.aliases.iter().map(|alias| alias.target.clone())));
    super::records::lock_influence(tx, &subjects).await?;
    Ok(PreparedSourceIdentities { prefix: prefix.digest().clone(), input, ranges, requests, receipts })
}

pub(crate) async fn recheck_source_identities(
    tx: &WorldTransaction<'_>, admission: &Admission, prefix: &SourceIdentityPrefix,
    prepared: &PreparedSourceIdentities, now: &Timestamp, budget: &CallBudget, cancel: &CancellationToken,
) -> Result<(), IdentityError> {
    let actual = prepare_source_identities(tx, admission, prefix, now, budget, cancel).await?;
    if actual != *prepared { return Err(IdentityFailure::CandidateScopeIncomplete.into()); }
    Ok(())
}

/// Called after the original claim retractions and native tombstone alias closures, in the same transaction.
pub(crate) async fn accept_source_identities(
    tx: &mut WorldTransaction<'_>, admission: &Admission, prefix: &SourceIdentityPrefix,
    prepared: &PreparedSourceIdentities, proposals: &[IdentityProposal], now: &Timestamp,
    budget: &CallBudget, cancel: &CancellationToken,
) -> Result<Vec<IdentityReceipt>, IdentityError> {
    if prepared.prefix != *prefix.digest() || prepared.input != input_digest(prefix)?
        || prepared.requests.len() != prefix.rows().len() || prepared.receipts.len() != prefix.rows().len()
        || proposals.len() != prefix.rows().len() {
        return Err(IdentityFailure::CandidateScopeIncomplete.into());
    }
    // Compare the complete post-tombstone ranges before any proposal can change a generation.
    for range in &prepared.ranges {
        checkpoint(budget, cancel)?;
        let scope = prefix.rows().iter().find(|row| natural(row.key()) == natural(&range.key)).map(|row| row.scope())
            .or_else(|| prefix.deletions().iter().find(|deletion| natural(deletion.key()) == natural(&range.key)).map(|deletion| deletion.scope()))
            .ok_or(IdentityFailure::CandidateScopeIncomplete)?;
        let (expected, aliases) = aliases::resolve_after_deletions(
            tx, &range.key, scope, range.generation, range.aliases.clone(), prefix.deletions(),
        ).await?;
        aliases::lock_range(tx, &range.key, Some(expected.range_generation)).await?;
        if aliases::source_aliases(tx, &range.key).await? != aliases {
            return Err(IdentityFailure::CandidateScopeIncomplete.into());
        }
    }
    for ((row, expected), expected_request) in prefix.rows().iter().zip(&prepared.receipts).zip(&prepared.requests) {
        checkpoint(budget, cancel)?;
        validate_row(tx, admission, row, now).await?;
        let actual = aliases::resolve_transaction(tx, row.key(), row.scope()).await?;
        let aliases = aliases::source_aliases(tx, row.key()).await?;
        if actual != *expected || request(tx, admission, row, &actual, &aliases, now, budget, cancel).await? != *expected_request {
            return Err(IdentityFailure::CandidateScopeIncomplete.into());
        }
    }
    super::recheck_receipts(tx, &prepared.receipts, &[]).await?;
    let mut result = Vec::with_capacity(proposals.len());
    for ((request, receipt), proposal) in prepared.requests.iter().zip(&prepared.receipts).zip(proposals) {
        checkpoint(budget, cancel)?;
        let identity = super::accept_proposal(tx, request, receipt, proposal, admission, now, budget, cancel).await?;
        let bound = aliases::resolve_transaction(tx, &request.key, &request.scope).await?;
        if !matches!(&bound.resolution, AliasResolution::Existing { identity: actual, .. }
            if subject(&actual.record) == subject(&identity.record)) {
            return Err(IdentityFailure::ImpactSetChanged.into());
        }
        result.push(bound);
    }
    Ok(result)
}

async fn request(
    tx: &WorldTransaction<'_>, admission: &Admission, row: &SourceIdentityRow,
    receipt: &IdentityReceipt, aliases: &[SourceAlias], now: &Timestamp,
    budget: &CallBudget, cancel: &CancellationToken,
) -> Result<IdentityResolveRequest, IdentityError> {
    let targets = match &receipt.resolution {
        AliasResolution::Existing { identity, .. } => vec![subject(&identity.record)],
        AliasResolution::Ambiguous { candidates, .. } => candidates.clone(),
        AliasResolution::NotFound => Vec::new(),
    };
    let mut dependencies = receipt.dependencies.clone();
    for dependency in row.dependencies() { if !dependencies.contains(dependency) { dependencies.push(dependency.clone()); } }
    let mut candidates = Vec::with_capacity(targets.len());
    for target in targets {
        checkpoint(budget, cancel)?;
        let identity = super::get_in_transaction(tx, &target).await?
            .ok_or_else(|| IdentityFailure::UnresolvedIdentity { subject: target.clone() })?;
        if type_id(&identity.record) != &row.type_ref().id { return Err(IdentityFailure::AliasConflict { key: row.key().clone() }.into()); }
        super::authorize(tx, admission, row.scope(), &row.key().valid_time,
            &[super::resource(&target)], std::slice::from_ref(&row.key().source_id), now).await?;
        let evidence = aliases.iter().filter(|alias| alias.key.incarnation == row.key().incarnation
            && super::overlaps(&alias.key.valid_time, &row.key().valid_time))
            .flat_map(|alias| alias.evidence.iter().cloned()).collect::<std::collections::BTreeSet<_>>().into_iter().collect::<Vec<_>>();
        crate::facts::assertions::require_evidence(tx, admission, &evidence, row.scope(), Some(&row.key().valid_time), now)
            .await.map_err(IdentityError::Fact)?;
        let dependency = ReadDependency::Identity { subject: target, revision: identity.revision };
        if !dependencies.contains(&dependency) { dependencies.push(dependency); }
        candidates.push(IdentityCandidate { identity, evidence });
    }
    Ok(IdentityResolveRequest { key: row.key().clone(), type_ref: row.type_ref().clone(), candidates,
        scope: row.scope().clone(), candidates_complete: true, dependencies })
}

fn natural(key: &SourceKey) -> (&world_protocol::ids::SourceId, &str, &str) {
    (&key.source_id, &key.namespace, &key.native_key)
}

fn input_digest(prefix: &SourceIdentityPrefix) -> Result<Digest, IdentityError> {
    let rows: Vec<_> = prefix.rows().iter().map(|row| (row.key(), row.type_ref(), row.scope(), row.evidence(),
        row.dependencies(), row.rule(), row.binding())).collect();
    let deletions: Vec<_> = prefix.deletions().iter().map(|deletion| (deletion.key(), deletion.scope(),
        deletion.dependencies(), deletion.rule(), deletion.binding())).collect();
    crate::definitions::canonical_digest(&(prefix.digest(), rows, deletions)).map_err(|_| IdentityFailure::InternalFault.into())
}

async fn validate_row(tx: &WorldTransaction<'_>, admission: &Admission, row: &SourceIdentityRow, now: &Timestamp) -> Result<(), IdentityError> {
    if &row.key().world != tx.world() || &row.type_ref().world != tx.world()
        || &row.binding().world != tx.world() || &row.rule().world != tx.world() { return Err(IdentityFailure::CrossWorld.into()); }
    validate_dependencies(row.key(), row.rule(), row.binding(), row.dependencies())?;
    super::authorize(tx, admission, row.scope(), &row.key().valid_time, &[], std::slice::from_ref(&row.key().source_id), now).await?;
    super::records::resolve_type(tx, row.type_ref(), row.scope(), &row.key().valid_time).await?;
    crate::facts::assertions::require_evidence(tx, admission, row.evidence(), row.scope(), Some(&row.key().valid_time), now)
        .await.map_err(IdentityError::Fact)?;
    Ok(())
}

async fn validate_deletion(tx: &WorldTransaction<'_>, admission: &Admission, deletion: &SourceIdentityDeletion, now: &Timestamp) -> Result<(), IdentityError> {
    if &deletion.key().world != tx.world() || &deletion.binding().world != tx.world() || &deletion.rule().world != tx.world() { return Err(IdentityFailure::CrossWorld.into()); }
    validate_dependencies(deletion.key(), deletion.rule(), deletion.binding(), deletion.dependencies())?;
    super::authorize(tx, admission, deletion.scope(), &deletion.key().valid_time, &[], std::slice::from_ref(&deletion.key().source_id), now).await?;
    Ok(())
}

fn validate_dependencies(key: &SourceKey, rule: &world_protocol::ids::IdentityRuleRef, binding: &world_protocol::ids::DefinitionRef, dependencies: &[ReadDependency]) -> Result<(), IdentityError> {
    if !dependencies.iter().any(|dependency| matches!(dependency, ReadDependency::SourceMapping { identity_rule, binding: actual, .. } if identity_rule == rule && actual == binding))
        || !dependencies.iter().any(|dependency| matches!(dependency, ReadDependency::Source { position, binding: actual } if position.source_id == key.source_id && actual == binding)) {
        return Err(IdentityFailure::CandidateScopeIncomplete.into());
    }
    Ok(())
}

fn checkpoint(budget: &CallBudget, cancel: &CancellationToken) -> Result<(), IdentityError> {
    if cancel.is_cancelled() { return Err(IdentityFailure::Cancelled.into()); }
    budget.charge(BudgetDimension::Steps, 1).map_err(|failure| IdentityError::Fact(
        crate::query::QueryError::from(world_protocol::expression::ExpressionFailure::BudgetExceeded {
            dimension: failure.dimension,
        }).into()))
}

/// Only a verified native tombstone closes an incarnation; snapshot absence never does.
pub(crate) async fn close_source_aliases(
    tx: &mut WorldTransaction<'_>, admission: &Admission, deletions: &[SourceIdentityDeletion], now: &Timestamp,
    budget: &CallBudget, cancellation: &CancellationToken,
) -> Result<(), IdentityError> {
    for deletion in deletions {
        checkpoint(budget, cancellation)?;
        validate_deletion(tx, admission, deletion, now).await?;
        let key = deletion.key();
        aliases::lock_range(tx, key, None).await?;
        let rows = tx.query(
            "SELECT r.body FROM world_source_alias_current c JOIN world_source_alias_revision r USING(tenant_id,world_id,source_id,namespace,native_key,incarnation,valid_from_ns,revision) WHERE c.tenant_id=$1 AND c.world_id=$2 AND c.source_id=$3 AND c.namespace=$4 AND c.native_key=$5 AND c.incarnation=$6 AND c.valid_from_ns<=$7::text::numeric AND (c.valid_to_ns IS NULL OR $7::text::numeric<c.valid_to_ns) ORDER BY c.valid_from_ns",
            &[&key.world.tenant_id.as_str(), &key.world.world_id.as_str(), &key.source_id.as_str(), &key.namespace, &key.native_key, &key.incarnation, &aliases::nanoseconds(&key.valid_time.from)?],
        ).await?;
        for row in rows {
            checkpoint(budget, cancellation)?;
            let alias: SourceAlias = super::decode(row.get("body"))?;
            aliases::close_alias(tx, &alias, &key.valid_time.from, deletion.scope(), admission, now, budget, cancellation).await?;
        }
    }
    Ok(())
}
