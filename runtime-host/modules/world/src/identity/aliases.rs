use std::collections::BTreeSet;

use sha2::{Digest as _, Sha256};
use world_protocol::{
    identity::{AliasResolution, IdentityChangeProposal, IdentityFailure, IdentityReceipt, IdentitySnapshot, SourceAlias, SourceKey, SubjectRef},
    ids::{Digest, EvidenceRef, Generation, Revision, ScopeId, SourceId, WorldRef},
    provenance::ReadDependency,
    time::{Timestamp, ValidTime},
};

use crate::{authorization::Admission, store::{WorldSnapshot, WorldTransaction}};
use super::{IdentityError, contains, decode, encode, get, get_in_transaction, parts, revision, subject, validate_interval};

const ALIASES: &str = "SELECT r.body FROM world_source_alias_current c JOIN world_source_alias_revision r USING(tenant_id,world_id,source_id,namespace,native_key,incarnation,valid_from_ns,revision) WHERE c.tenant_id=$1 AND c.world_id=$2 AND c.source_id=$3 AND c.namespace=$4 AND c.native_key=$5 AND c.incarnation=$6 AND numrange(c.valid_from_ns,c.valid_to_ns,'[)') && numrange($7::text::numeric,$8::text::numeric,'[)') ORDER BY c.valid_from_ns";
const GENERATION: &str = "SELECT generation,range_digest FROM world_alias_range WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 AND namespace=$4 AND native_key=$5";
const NATIVE_INCARNATIONS: &str = "SELECT DISTINCT incarnation FROM world_source_alias_current WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 AND namespace=$4 AND native_key=$5 AND numrange(valid_from_ns,valid_to_ns,'[)') && numrange($6::text::numeric,$7::text::numeric,'[)') ORDER BY incarnation";
const RESOLUTIONS: &str = "SELECT body,admission FROM world_identity_resolution WHERE tenant_id=$1 AND world_id=$2 AND numrange(valid_from_ns,valid_to_ns,'[)') && numrange($3::text::numeric,$4::text::numeric,'[)') ORDER BY recorded_at,operation_id,revision";

pub(crate) fn range_digest(key: &SourceKey) -> Result<Digest, IdentityError> {
    natural_range_digest(&key.world, &key.source_id, &key.namespace, &key.native_key)
}

fn natural_range_digest(world: &WorldRef, source: &SourceId, namespace: &str, native_key: &str) -> Result<Digest, IdentityError> {
    let bytes = serde_json::to_vec(&(world, source, namespace, native_key))
        .map_err(|_| IdentityFailure::InternalFault)?;
    Digest::try_new(format!("sha256:{:x}", Sha256::digest(bytes))).map_err(|_| IdentityFailure::InternalFault.into())
}

pub(super) fn nanoseconds(at: &Timestamp) -> Result<String, IdentityError> {
    Ok(at.unix_nanos().to_string())
}

fn interval_ns(interval: &ValidTime) -> Result<(String, Option<String>), IdentityError> {
    Ok((nanoseconds(&interval.from)?, interval.to.as_ref().map(nanoseconds).transpose()?))
}

fn validate_key(key: &SourceKey) -> Result<(), IdentityError> {
    validate_interval(&key.valid_time)?;
    if key.namespace.is_empty() || key.native_key.is_empty() || key.incarnation.is_empty() {
        return Err(IdentityFailure::AliasConflict { key: key.clone() }.into());
    }
    // Exact bytes are identity. No trimming, lowercasing or display-name normalization.
    Ok(())
}

pub(crate) async fn register_alias_range(transaction: &WorldTransaction<'_>, key: &SourceKey) -> Result<Generation, IdentityError> {
    lock_range(transaction, key, None).await
}

pub(super) async fn lock_range(
    transaction: &WorldTransaction<'_>, key: &SourceKey, expected: Option<Generation>,
) -> Result<Generation, IdentityError> {
    validate_key(key)?;
    if &key.world != transaction.world() { return Err(IdentityFailure::CrossWorld.into()); }
    lock_natural_range(transaction, &key.source_id, &key.namespace, &key.native_key, expected).await
}

pub(crate) async fn lock_source_alias_range(
    transaction: &WorldTransaction<'_>, source: &SourceId, namespace: &str, native_key: &str,
) -> Result<Generation, IdentityError> {
    lock_natural_range(transaction, source, namespace, native_key, None).await
}

async fn lock_natural_range(
    transaction: &WorldTransaction<'_>, source: &SourceId, namespace: &str, native_key: &str, expected: Option<Generation>,
) -> Result<Generation, IdentityError> {
    if namespace.is_empty() || native_key.is_empty() { return Err(IdentityFailure::CandidateScopeIncomplete.into()); }
    let world = transaction.world();
    let digest = natural_range_digest(world, source, namespace, native_key)?;
    let inserted = transaction.execute(
        "INSERT INTO world_alias_range(tenant_id,world_id,source_id,namespace,native_key,range_digest) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,world_id,source_id,namespace,native_key) DO NOTHING",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &source.as_str(), &namespace, &native_key, &digest.as_str()],
    ).await?;
    let row = transaction.query_opt(
        "SELECT generation,range_digest FROM world_alias_range WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 AND namespace=$4 AND native_key=$5 FOR UPDATE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &source.as_str(), &namespace, &native_key],
    ).await?.ok_or(IdentityFailure::InternalFault)?;
    if row.get::<_, String>("range_digest") != digest.as_str() { return Err(IdentityFailure::InternalFault.into()); }
    let actual = Generation(row.get::<_, i64>("generation") as u64);
    if let Some(expected) = expected {
        if !(expected == actual || expected.0 == 0 && inserted == 1) {
            return Err(IdentityFailure::RevisionConflict { expected: Revision(expected.0), actual: Revision(actual.0) }.into());
        }
    }
    Ok(actual)
}

pub(super) async fn bump_range(transaction: &WorldTransaction<'_>, key: &SourceKey) -> Result<(), IdentityError> {
    transaction.execute(
        "UPDATE world_alias_range SET generation=generation+1 WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 AND namespace=$4 AND native_key=$5",
        &[&key.world.tenant_id.as_str(), &key.world.world_id.as_str(), &key.source_id.as_str(), &key.namespace, &key.native_key],
    ).await?;
    Ok(())
}

/// Internal authoritative read; the owner admits the scope before calling and filters output.
pub(crate) async fn resolve(snapshot: &WorldSnapshot<'_>, key: &SourceKey, scope: &ScopeId) -> Result<IdentityReceipt, IdentityError> {
    validate_key(key)?;
    if &key.world != snapshot.world() { return Err(IdentityFailure::CrossWorld.into()); }
    let digest = range_digest(key)?;
    let row = snapshot.query_opt(GENERATION,
        &[&key.world.tenant_id.as_str(), &key.world.world_id.as_str(), &key.source_id.as_str(), &key.namespace, &key.native_key]).await?;
    let generation = match row {
        None => Generation(0),
        Some(row) => {
            if row.get::<_, String>("range_digest") != digest.as_str() { return Err(IdentityFailure::InternalFault.into()); }
            Generation(row.get::<_, i64>("generation") as u64)
        }
    };
    let rows = snapshot.query(ALIASES,
        &[&key.world.tenant_id.as_str(), &key.world.world_id.as_str(), &key.source_id.as_str(), &key.namespace, &key.native_key, &key.incarnation,
          &interval_ns(&key.valid_time)?.0, &interval_ns(&key.valid_time)?.1]).await?;
    let aliases: Vec<SourceAlias> = rows.into_iter().map(|row| decode(row.get("body"))).collect::<Result<_, _>>()?;
    let rows = snapshot.query(RESOLUTIONS,
        &[&key.world.tenant_id.as_str(), &key.world.world_id.as_str(), &interval_ns(&key.valid_time)?.0, &interval_ns(&key.valid_time)?.1]).await?;
    let mut changes = Vec::with_capacity(rows.len());
    for row in rows {
        changes.push((decode::<IdentityChangeProposal>(row.get("body"))?, decode::<world_protocol::authorization::Decision>(row.get("admission"))?.id));
    }
    let (targets, complete, decisions, visited) = mapped_targets(key, scope, &aliases, &changes);
    let mut identities = Vec::with_capacity(targets.len());
    let mut dependencies = vec![ReadDependency::AliasRange { digest, generation }];
    // Preserve the original ID revision too: a later resolution must invalidate this receipt.
    let all_targets: BTreeSet<_> = targets.iter().cloned().chain(visited).chain(aliases.iter().map(|alias| alias.target.clone())).collect();
    for target in all_targets {
        let identity = get(snapshot, &target).await?.ok_or_else(|| IdentityFailure::UnresolvedIdentity { subject: target.clone() })?;
        dependencies.push(ReadDependency::Identity { subject: target.clone(), revision: identity.revision });
        if targets.contains(&target) { identities.push(identity); }
    }
    let resolution = if aliases.is_empty() { AliasResolution::NotFound }
        else if complete && identities.len() == 1 {
            AliasResolution::Existing { identity: identities.remove(0), alias_revision: aliases.iter().map(|alias| alias.revision).max().ok_or(IdentityFailure::InternalFault)?, decisions }
        } else { AliasResolution::Ambiguous { candidates: targets.into_iter().collect(), decisions } };
    Ok(IdentityReceipt { key: key.clone(), resolution, scope: scope.clone(), range_generation: generation, dependencies })
}

pub(crate) async fn resolve_transaction(transaction: &WorldTransaction<'_>, key: &SourceKey, scope: &ScopeId) -> Result<IdentityReceipt, IdentityError> {
    validate_key(key)?;
    if &key.world != transaction.world() { return Err(IdentityFailure::CrossWorld.into()); }
    let digest = range_digest(key)?;
    let row = transaction.query_opt(GENERATION, &[&key.world.tenant_id.as_str(), &key.world.world_id.as_str(), &key.source_id.as_str(), &key.namespace, &key.native_key]).await?;
    let generation = match row {
        None => Generation(0),
        Some(row) => {
            if row.get::<_, String>("range_digest") != digest.as_str() { return Err(IdentityFailure::InternalFault.into()); }
            Generation(row.get::<_, i64>("generation") as u64)
        }
    };
    resolve_in_transaction(transaction, key, scope, generation).await
}

/// The incarnation is read from actual overlapping aliases, never supplied or guessed by a caller.
pub(crate) async fn resolve_native_key_transaction(
    transaction: &WorldTransaction<'_>, source: &SourceId, namespace: &str, native_key: &str, scope: &ScopeId, valid_time: &ValidTime,
) -> Result<Option<IdentityReceipt>, IdentityError> {
    validate_interval(valid_time)?;
    if namespace.is_empty() || native_key.is_empty() { return Err(IdentityFailure::CandidateScopeIncomplete.into()); }
    let rows = transaction.query(
        NATIVE_INCARNATIONS,
        &[&transaction.world().tenant_id.as_str(), &transaction.world().world_id.as_str(), &source.as_str(), &namespace, &native_key, &interval_ns(valid_time)?.0, &interval_ns(valid_time)?.1],
    ).await?;
    let Some(key) = native_source_key(transaction.world(), source, namespace, native_key, valid_time, rows)? else { return Ok(None); };
    resolve_transaction(transaction, &key, scope).await.map(Some)
}

pub(crate) async fn resolve_native_key_snapshot(
    snapshot: &WorldSnapshot<'_>, source: &SourceId, namespace: &str, native_key: &str, scope: &ScopeId, valid_time: &ValidTime,
) -> Result<Option<IdentityReceipt>, IdentityError> {
    validate_interval(valid_time)?;
    if namespace.is_empty() || native_key.is_empty() { return Err(IdentityFailure::CandidateScopeIncomplete.into()); }
    let rows = snapshot.query(NATIVE_INCARNATIONS,
        &[&snapshot.world().tenant_id.as_str(), &snapshot.world().world_id.as_str(), &source.as_str(), &namespace, &native_key, &interval_ns(valid_time)?.0, &interval_ns(valid_time)?.1]).await?;
    let Some(key) = native_source_key(snapshot.world(), source, namespace, native_key, valid_time, rows)? else { return Ok(None); };
    resolve(snapshot, &key, scope).await.map(Some)
}

fn native_source_key(world: &WorldRef, source: &SourceId, namespace: &str, native_key: &str, valid_time: &ValidTime, rows: Vec<tokio_postgres::Row>) -> Result<Option<SourceKey>, IdentityError> {
    if rows.len() > 1 { return Err(IdentityFailure::OverlappingIncarnation { source_id: source.clone() }.into()); }
    Ok(rows.into_iter().next().map(|row| SourceKey { world: world.clone(), source_id: source.clone(), namespace: namespace.to_owned(), native_key: native_key.to_owned(), incarnation: row.get("incarnation"), valid_time: valid_time.clone() }))
}

pub(super) async fn resolve_in_transaction(
    transaction: &WorldTransaction<'_>, key: &SourceKey, scope: &ScopeId, generation: Generation,
) -> Result<IdentityReceipt, IdentityError> {
    let rows = transaction.query(ALIASES,
        &[&key.world.tenant_id.as_str(), &key.world.world_id.as_str(), &key.source_id.as_str(), &key.namespace, &key.native_key, &key.incarnation,
          &interval_ns(&key.valid_time)?.0, &interval_ns(&key.valid_time)?.1]).await?;
    let aliases: Vec<SourceAlias> = rows.into_iter().map(|row| decode(row.get("body"))).collect::<Result<_, _>>()?;
    resolve_aliases(transaction, key, scope, generation, aliases).await
}

pub(super) async fn source_aliases(transaction: &WorldTransaction<'_>, key: &SourceKey) -> Result<Vec<SourceAlias>, IdentityError> {
    transaction.query("SELECT r.body FROM world_source_alias_current c JOIN world_source_alias_revision r USING(tenant_id,world_id,source_id,namespace,native_key,incarnation,valid_from_ns,revision) WHERE c.tenant_id=$1 AND c.world_id=$2 AND c.source_id=$3 AND c.namespace=$4 AND c.native_key=$5 ORDER BY c.incarnation,c.valid_from_ns",
        &[&key.world.tenant_id.as_str(), &key.world.world_id.as_str(), &key.source_id.as_str(), &key.namespace, &key.native_key]).await?
        .into_iter().map(|row| decode(row.get("body"))).collect()
}

pub(super) async fn resolve_after_deletions(
    transaction: &WorldTransaction<'_>, key: &SourceKey, scope: &ScopeId, generation: Generation,
    mut aliases: Vec<SourceAlias>, deletions: &[crate::sources::sync::SourceIdentityDeletion],
) -> Result<(IdentityReceipt, Vec<SourceAlias>), IdentityError> {
    let mut changes = 0u64;
    for deletion in deletions.iter().filter(|deletion| deletion.key().source_id == key.source_id
        && deletion.key().namespace == key.namespace && deletion.key().native_key == key.native_key) {
        for alias in aliases.iter_mut().filter(|alias| alias.key.incarnation == deletion.key().incarnation
            && alias.key.valid_time.contains(&deletion.key().valid_time.from)) {
            if alias.key.valid_time.from >= deletion.key().valid_time.from { return Err(IdentityFailure::InvalidInterval.into()); }
            alias.key.valid_time.to = Some(deletion.key().valid_time.from.clone());
            alias.revision = Revision(alias.revision.0.checked_add(1).ok_or(IdentityFailure::InternalFault)?);
            changes = changes.checked_add(1).ok_or(IdentityFailure::InternalFault)?;
        }
    }
    let selected = aliases.iter().filter(|alias| alias.key.incarnation == key.incarnation
        && super::overlaps(&alias.key.valid_time, &key.valid_time)).cloned().collect();
    let receipt = resolve_aliases(transaction, key, scope,
        Generation(generation.0.checked_add(changes).ok_or(IdentityFailure::InternalFault)?), selected).await?;
    Ok((receipt, aliases))
}

async fn resolve_aliases(
    transaction: &WorldTransaction<'_>, key: &SourceKey, scope: &ScopeId, generation: Generation, aliases: Vec<SourceAlias>,
) -> Result<IdentityReceipt, IdentityError> {
    let rows = transaction.query(RESOLUTIONS,
        &[&key.world.tenant_id.as_str(), &key.world.world_id.as_str(), &interval_ns(&key.valid_time)?.0, &interval_ns(&key.valid_time)?.1]).await?;
    let mut changes = Vec::with_capacity(rows.len());
    for row in rows {
        changes.push((decode::<IdentityChangeProposal>(row.get("body"))?, decode::<world_protocol::authorization::Decision>(row.get("admission"))?.id));
    }
    let (targets, complete, decisions, visited) = mapped_targets(key, scope, &aliases, &changes);
    let mut identities = Vec::new();
    let mut dependencies = vec![ReadDependency::AliasRange { digest: range_digest(key)?, generation }];
    for target in targets.iter().cloned().chain(visited).chain(aliases.iter().map(|alias| alias.target.clone())).collect::<BTreeSet<_>>() {
        let identity = get_in_transaction(transaction, &target).await?.ok_or_else(|| IdentityFailure::UnresolvedIdentity { subject: target.clone() })?;
        dependencies.push(ReadDependency::Identity { subject: target.clone(), revision: identity.revision });
        if targets.contains(&target) { identities.push(identity); }
    }
    let resolution = if aliases.is_empty() { AliasResolution::NotFound }
        else if complete && identities.len() == 1 {
            AliasResolution::Existing { identity: identities.remove(0), alias_revision: aliases.iter().map(|alias| alias.revision).max().ok_or(IdentityFailure::InternalFault)?, decisions }
        } else { AliasResolution::Ambiguous { candidates: targets.into_iter().collect(), decisions } };
    Ok(IdentityReceipt { key: key.clone(), resolution, scope: scope.clone(), range_generation: generation, dependencies })
}

fn mapped_targets(
    key: &SourceKey, scope: &ScopeId, aliases: &[SourceAlias],
    changes: &[(IdentityChangeProposal, world_protocol::ids::DecisionId)],
) -> (BTreeSet<SubjectRef>, bool, Vec<world_protocol::ids::DecisionId>, BTreeSet<SubjectRef>) {
    let mut targets: BTreeSet<_> = aliases.iter().map(|alias| alias.target.clone()).collect();
    let mut cursor = key.valid_time.from.clone();
    let mut covered_to_infinity = false;
    for alias in aliases {
        if alias.key.valid_time.from > cursor { break; }
        match &alias.key.valid_time.to {
            None => { covered_to_infinity = true; break; }
            Some(to) if to > &cursor => cursor = to.clone(),
            _ => {}
        }
    }
    let mut complete = covered_to_infinity || key.valid_time.to.as_ref().is_some_and(|to| &cursor >= to);
    let mut decisions = BTreeSet::new();
    let mut pending: Vec<_> = targets.into_iter().map(|target| (target, BTreeSet::new())).collect();
    targets = BTreeSet::new();
    let mut visited = BTreeSet::new();
    while let Some((current, mut path)) = pending.pop() {
        visited.insert(current.clone());
        if !path.insert(current.clone()) {
            complete = false;
            targets.insert(current);
            continue;
        }
        let mappings: Vec<_> = changes.iter().flat_map(|(change, decision)| {
            change.remapping.iter().filter(|mapping| mapping.original == current)
                .map(move |mapping| (change, decision, mapping))
        }).collect();
        if mappings.is_empty() { targets.insert(current); continue; }
        // Parallel or overlapping decisions are alternatives, never insertion-order winners.
        if mappings.iter().any(|(change, _, _)| &change.scope != scope || !contains(&change.valid_time, &key.valid_time)) {
            complete = false;
            targets.insert(current.clone());
        }
        for (_, decision, mapping) in mappings {
            decisions.insert(decision.clone());
            pending.extend(mapping.replacements.iter().cloned().map(|target| (target, path.clone())));
        }
    }
    (targets, complete, decisions.into_iter().collect(), visited)
}

pub(crate) async fn recheck_receipt(transaction: &WorldTransaction<'_>, receipt: &IdentityReceipt) -> Result<(), IdentityError> {
    recheck_receipts(transaction, std::slice::from_ref(receipt), &[]).await
}

/// Batch order is range natural keys, then the complete union of identity references.
pub(crate) async fn recheck_receipts(
    transaction: &WorldTransaction<'_>, receipts: &[IdentityReceipt], extra: &[SubjectRef],
) -> Result<(), IdentityError> {
    let mut ordered: Vec<_> = receipts.iter().collect();
    ordered.sort_unstable_by(|left, right| (&left.key.source_id, &left.key.namespace, &left.key.native_key)
        .cmp(&(&right.key.source_id, &right.key.namespace, &right.key.native_key)));
    let mut previous: Option<&IdentityReceipt> = None;
    for receipt in &ordered {
        validate_key(&receipt.key)?;
        if &receipt.key.world != transaction.world() { return Err(IdentityFailure::CrossWorld.into()); }
        if let Some(previous) = previous {
            if previous.key.source_id == receipt.key.source_id && previous.key.namespace == receipt.key.namespace && previous.key.native_key == receipt.key.native_key {
                if previous.range_generation != receipt.range_generation { return Err(IdentityFailure::CandidateScopeIncomplete.into()); }
                continue;
            }
        }
        lock_range(transaction, &receipt.key, Some(receipt.range_generation)).await?;
        previous = Some(receipt);
    }
    let mut references = Vec::new();
    for receipt in receipts {
        let digest = range_digest(&receipt.key)?;
        if !receipt.dependencies.contains(&ReadDependency::AliasRange { digest, generation: receipt.range_generation }) {
            return Err(IdentityFailure::CandidateScopeIncomplete.into());
        }
        for dependency in &receipt.dependencies {
            if let ReadDependency::Identity { subject, revision } = dependency { references.push((subject.clone(), *revision)); }
        }
    }
    let subjects: Vec<_> = references.iter().map(|(subject, _)| subject.clone()).chain(extra.iter().cloned()).collect();
    super::records::lock_influence(transaction, &subjects).await?;
    for (subject, expected) in references {
        let actual = get_in_transaction(transaction, &subject).await?.ok_or_else(|| IdentityFailure::UnresolvedIdentity { subject: subject.clone() })?;
        if expected != actual.revision { return Err(IdentityFailure::RevisionConflict { expected, actual: actual.revision }.into()); }
    }
    for receipt in receipts {
        let actual = resolve_in_transaction(transaction, &receipt.key, &receipt.scope, receipt.range_generation).await?;
        if actual != *receipt { return Err(IdentityFailure::CandidateScopeIncomplete.into()); }
    }
    Ok(())
}

pub(crate) async fn bind_alias(
    transaction: &mut WorldTransaction<'_>, receipt: &IdentityReceipt, target: &IdentitySnapshot,
    evidence: &[EvidenceRef], admission: &Admission, now: &Timestamp, budget: &crate::extensions::invocation::CallBudget, cancellation: &tokio_util::sync::CancellationToken,
) -> Result<SourceAlias, IdentityError> {
    super::authorize(transaction, admission, &receipt.scope, &receipt.key.valid_time,
        &[super::resource(&subject(&target.record))], &[receipt.key.source_id.clone()], now).await?;
    if super::world(&target.record) != transaction.world() { return Err(IdentityFailure::CrossWorld.into()); }
    if evidence.iter().any(|reference| &reference.world != transaction.world()) { return Err(IdentityFailure::CrossWorld.into()); }
    recheck_receipts(transaction, std::slice::from_ref(receipt), &[subject(&target.record)]).await?;
    super::records::recheck_identity(transaction, target).await?;
    crate::facts::assertions::require_evidence(transaction, admission, evidence,
        &receipt.scope, Some(&receipt.key.valid_time), now).await.map_err(IdentityError::Fact)?;
    match &receipt.resolution {
        AliasResolution::Existing { identity, .. } if identity == target => {
            let rows = transaction.query(ALIASES,
                &[&receipt.key.world.tenant_id.as_str(), &receipt.key.world.world_id.as_str(), &receipt.key.source_id.as_str(),
                  &receipt.key.namespace, &receipt.key.native_key, &receipt.key.incarnation, &interval_ns(&receipt.key.valid_time)?.0,
                  &interval_ns(&receipt.key.valid_time)?.1]).await?;
            // Return an actual recorded alias, never forge its natural key or revision.
            let aliases: Vec<SourceAlias> = rows.into_iter().map(|row| decode(row.get("body"))).collect::<Result<_, _>>()?;
            return aliases.into_iter().find(|alias| contains(&alias.key.valid_time, &receipt.key.valid_time))
                .ok_or_else(|| IdentityFailure::AliasConflict { key: receipt.key.clone() }.into());
        }
        AliasResolution::NotFound => {}
        _ => return Err(IdentityFailure::AliasConflict { key: receipt.key.clone() }.into()),
    }
    let overlap = transaction.query_opt(
        "SELECT incarnation FROM world_source_alias_current WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 AND namespace=$4 AND native_key=$5 AND numrange(valid_from_ns,valid_to_ns,'[)') && numrange($6::text::numeric,$7::text::numeric,'[)') LIMIT 1",
        &[&receipt.key.world.tenant_id.as_str(), &receipt.key.world.world_id.as_str(), &receipt.key.source_id.as_str(), &receipt.key.namespace, &receipt.key.native_key,
          &interval_ns(&receipt.key.valid_time)?.0, &interval_ns(&receipt.key.valid_time)?.1],
    ).await?;
    if let Some(row) = overlap {
        return Err(if row.get::<_, String>("incarnation") != receipt.key.incarnation {
            IdentityFailure::OverlappingIncarnation { source_id: receipt.key.source_id.clone() }
        } else { IdentityFailure::AliasConflict { key: receipt.key.clone() } }.into());
    }
    let alias = SourceAlias { key: receipt.key.clone(), target: subject(&target.record), revision: Revision(1), evidence: evidence.to_vec() };
    persist_alias(transaction, &alias, None).await?;
    let (kind, id) = parts(&alias.target);
    transaction.execute(
        "INSERT INTO world_source_alias_current(tenant_id,world_id,source_id,namespace,native_key,incarnation,valid_from,valid_to,revision,target_kind,target_id,valid_from_ns,valid_to_ns) VALUES($1,$2,$3,$4,$5,$6,$7::text::timestamptz,$8::text::timestamptz,$9,$10,$11,$12::text::numeric,$13::text::numeric)",
        &[&alias.key.world.tenant_id.as_str(), &alias.key.world.world_id.as_str(), &alias.key.source_id.as_str(), &alias.key.namespace, &alias.key.native_key,
          &alias.key.incarnation, &alias.key.valid_time.from.as_str(), &alias.key.valid_time.to.as_ref().map(Timestamp::as_str), &revision(alias.revision.0)?, &kind, &id,
          &interval_ns(&alias.key.valid_time)?.0, &interval_ns(&alias.key.valid_time)?.1],
    ).await?;
    bump_range(transaction, &alias.key).await?;
    super::records::touch_influence(transaction, &[alias.target.clone()]).await?;
    invalidate_range(transaction, &alias.key, receipt.range_generation, now, budget, cancellation).await?;
    emit_alias(transaction, &alias, "identity.alias_bound").await?;
    Ok(alias)
}

/// Closing an incarnation appends a revision. The original interval and evidence remain queryable.
pub(crate) async fn close_alias(
    transaction: &mut WorldTransaction<'_>, expected: &SourceAlias, to: &Timestamp, scope: &ScopeId,
    admission: &Admission, now: &Timestamp, budget: &crate::extensions::invocation::CallBudget, cancellation: &tokio_util::sync::CancellationToken,
) -> Result<SourceAlias, IdentityError> {
    let interval = ValidTime::try_new(expected.key.valid_time.from.clone(), Some(to.clone())).map_err(|_| IdentityFailure::InvalidInterval)?;
    if !contains(&expected.key.valid_time, &interval) { return Err(IdentityFailure::InvalidInterval.into()); }
    super::authorize(transaction, admission, scope, &expected.key.valid_time,
        &[super::resource(&expected.target)], &[expected.key.source_id.clone()], now).await?;
    let old_generation = lock_range(transaction, &expected.key, None).await?;
    super::records::lock_influence(transaction, std::slice::from_ref(&expected.target)).await?;
    let row = transaction.query_opt(
        "SELECT r.body FROM world_source_alias_current c JOIN world_source_alias_revision r USING(tenant_id,world_id,source_id,namespace,native_key,incarnation,valid_from_ns,revision) WHERE c.tenant_id=$1 AND c.world_id=$2 AND c.source_id=$3 AND c.namespace=$4 AND c.native_key=$5 AND c.incarnation=$6 AND c.valid_from_ns=$7::text::numeric",
        &[&expected.key.world.tenant_id.as_str(), &expected.key.world.world_id.as_str(), &expected.key.source_id.as_str(), &expected.key.namespace,
          &expected.key.native_key, &expected.key.incarnation, &nanoseconds(&expected.key.valid_time.from)?],
    ).await?.ok_or_else(|| IdentityFailure::AliasConflict { key: expected.key.clone() })?;
    let actual: SourceAlias = decode(row.get("body"))?;
    if actual.revision != expected.revision { return Err(IdentityFailure::RevisionConflict { expected: expected.revision, actual: actual.revision }.into()); }
    if actual != *expected { return Err(IdentityFailure::AliasConflict { key: expected.key.clone() }.into()); }
    let mut next = expected.clone();
    next.key.valid_time = interval;
    next.revision = Revision(expected.revision.0.checked_add(1).ok_or(IdentityFailure::InternalFault)?);
    persist_alias(transaction, &next, Some(expected.revision)).await?;
    let changed = transaction.execute(
        "UPDATE world_source_alias_current SET valid_to=$8::text::timestamptz,revision=$9,valid_to_ns=$11::text::numeric WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 AND namespace=$4 AND native_key=$5 AND incarnation=$6 AND valid_from_ns=$7::text::numeric AND revision=$10",
        &[&next.key.world.tenant_id.as_str(), &next.key.world.world_id.as_str(), &next.key.source_id.as_str(), &next.key.namespace, &next.key.native_key,
          &next.key.incarnation, &nanoseconds(&next.key.valid_time.from)?, &next.key.valid_time.to.as_ref().map(Timestamp::as_str), &revision(next.revision.0)?, &revision(expected.revision.0)?,
          &next.key.valid_time.to.as_ref().map(nanoseconds).transpose()?],
    ).await?;
    transaction.require_changed(changed, super::resource(&next.target))?;
    bump_range(transaction, &next.key).await?;
    super::records::touch_influence(transaction, &[next.target.clone()]).await?;
    invalidate_range(transaction, &next.key, old_generation, now, budget, cancellation).await?;
    emit_alias(transaction, &next, "identity.alias_closed").await?;
    Ok(next)
}

async fn invalidate_range(transaction: &mut WorldTransaction<'_>, key: &SourceKey, generation: Generation, now: &Timestamp, budget: &crate::extensions::invocation::CallBudget, cancellation: &tokio_util::sync::CancellationToken) -> Result<(), IdentityError> {
    crate::facts::support::invalidate_dependencies(transaction,
        &[ReadDependency::AliasRange { digest: range_digest(key)?, generation }], false, budget, cancellation, now).await?;
    Ok(())
}

async fn emit_alias(transaction: &mut WorldTransaction<'_>, alias: &SourceAlias, event: &str) -> Result<(), IdentityError> {
    transaction.emit(crate::store::OutboxEvent {
        event_id: world_protocol::ids::EventId::try_new(uuid::Uuid::new_v4().to_string()).map_err(|_| IdentityFailure::InternalFault)?,
        aggregate_kind: "source_alias".into(), aggregate_id: range_digest(&alias.key)?.to_string(), aggregate_revision: alias.revision.0,
        event_kind: event.into(), payload: encode(alias)?, causation_id: None, origin: "world.identity".into(),
    }).await?;
    Ok(())
}

async fn persist_alias(transaction: &WorldTransaction<'_>, alias: &SourceAlias, previous: Option<Revision>) -> Result<(), IdentityError> {
    let (kind, id) = parts(&alias.target);
    transaction.execute(
        "INSERT INTO world_source_alias_revision(tenant_id,world_id,source_id,namespace,native_key,incarnation,valid_from,valid_to,revision,target_kind,target_id,supersedes_revision,evidence,body,valid_from_ns,valid_to_ns) VALUES($1,$2,$3,$4,$5,$6,$7::text::timestamptz,$8::text::timestamptz,$9,$10,$11,$12,$13,$14,$15::text::numeric,$16::text::numeric)",
        &[&alias.key.world.tenant_id.as_str(), &alias.key.world.world_id.as_str(), &alias.key.source_id.as_str(), &alias.key.namespace, &alias.key.native_key,
          &alias.key.incarnation, &alias.key.valid_time.from.as_str(), &alias.key.valid_time.to.as_ref().map(Timestamp::as_str), &revision(alias.revision.0)?,
          &kind, &id, &previous.map(|revision| revision.0 as i64), &encode(&alias.evidence)?, &encode(alias)?,
          &interval_ns(&alias.key.valid_time)?.0, &interval_ns(&alias.key.valid_time)?.1],
    ).await?;
    Ok(())
}
