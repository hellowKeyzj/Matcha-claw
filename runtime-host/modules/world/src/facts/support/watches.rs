use super::{BATCH_LIMIT, decode, encode, number, reject};
use crate::{
    authorization::{self, Admission},
    store::{RetentionRoots, StoreError, WorldTransaction},
};
use std::collections::{BTreeMap, BTreeSet};
use serde::{Deserialize, Serialize};
use world_protocol::{
    authorization::{AccessMode, AccessScope, ActualImpact},
    commit::CommitFailure,
    expression::{Effect, TimeWindow},
    failure::FailureStage,
    ids::*,
    provenance::{ProvenanceFailure, QueryWatch, ReadDependency, SupportSet, WatchCoverage, WatchPurpose},
    time::Timestamp,
};

pub(crate) async fn watch_retention(
    tx: &WorldTransaction<'_>,
    ids: &[WatchId],
) -> Result<RetentionRoots, StoreError> {
    let mut roots = RetentionRoots::default();
    for id in ids {
        let row = tx
            .query_opt(
                "SELECT body FROM world_watch WHERE tenant_id=$1 AND world_id=$2 AND watch_id=$3",
                &[
                    &tx.world().tenant_id.as_str(),
                    &tx.world().world_id.as_str(),
                    &id.as_str(),
                ],
            )
            .await?
            .ok_or_else(|| reject(ProvenanceFailure::MissingPremise))?;
        let watch: QueryWatch = decode(row.get("body"))?;
        if watch.world != *tx.world() || watch.id != *id {
            return Err(reject(ProvenanceFailure::CrossScope));
        }
        retain_watch(&mut roots, &watch);
    }
    Ok(roots)
}

fn retain_watch(roots: &mut RetentionRoots, watch: &QueryWatch) {
    roots.scopes.push(watch.scope.clone());
    roots.definitions.extend(watch.datasets.clone());
    roots.definitions.extend(crate::definitions::query_references(&watch.query));
    roots.definitions.extend(crate::definitions::expression_references(&watch.selector));
    roots.resources.extend(crate::definitions::query_resources(&watch.query));
    roots.resources.extend(crate::definitions::expression_resources(&watch.selector));
    roots.resources.push(ResourceRef::Watch { id: watch.id.clone() });
    for argument in &watch.arguments {
        crate::facts::assertions::value_resources(&argument.value, &mut roots.resources);
    }
    if let Some(TimeWindow::Sliding { timestamp_property, .. }) = &watch.window {
        roots.definitions.push(timestamp_property.clone());
    }
}

/// A range read and its watch must use this same database transaction.
pub(crate) struct LockedRanges {
    transaction: String,
    ranges: BTreeSet<(DefinitionId, String)>,
    inserted: BTreeSet<(DefinitionId, String)>,
}

pub(crate) async fn lock_ranges(
    tx: &WorldTransaction<'_>,
    datasets: &[DefinitionId],
    partitions: &[String],
) -> Result<LockedRanges, StoreError> {
    let ranges = range_keys(datasets, partitions)?;
    let mut inserted = BTreeSet::new();
    for (dataset, partition) in &ranges {
        let changed = tx.execute("INSERT INTO world_watch_partition(tenant_id,world_id,dataset_id,partition_key) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &dataset.as_str(), &partition]).await?;
        if changed == 1 {
            inserted.insert((dataset.clone(), partition.clone()));
        }
        tx.query_opt("SELECT generation FROM world_watch_partition WHERE tenant_id=$1 AND world_id=$2 AND dataset_id=$3 AND partition_key=$4 FOR UPDATE", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &dataset.as_str(), &partition]).await?;
    }
    let row = tx
        .query_opt("SELECT pg_current_xact_id()::text AS id", &[])
        .await?
        .ok_or_else(|| reject(ProvenanceFailure::InternalFault))?;
    Ok(LockedRanges {
        transaction: row.get("id"),
        ranges,
        inserted,
    })
}

pub(crate) async fn recheck_ranges(
    tx: &WorldTransaction<'_>,
    bases: &[(DefinitionId, Generation)],
) -> Result<LockedRanges, StoreError> {
    let datasets: Vec<_> = bases.iter().map(|(id, _)| id.clone()).collect();
    let locked = lock_ranges(tx, &datasets, &[]).await?;
    for (dataset, expected) in bases {
        let row = tx.query_opt("SELECT generation FROM world_watch_partition WHERE tenant_id=$1 AND world_id=$2 AND dataset_id=$3 AND partition_key=''", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &dataset.as_str()]).await?.ok_or_else(|| reject(ProvenanceFailure::InternalFault))?;
        let actual = row.get::<_, i64>("generation");
        let first = expected.0 == 0
            && actual == 1
            && locked.inserted.contains(&(dataset.clone(), String::new()));
        if !first && (expected.0 == 0 || actual != number(expected.0)?) {
            return Err(StoreError::new(
                CommitFailure::ReadDependencyChanged {
                    resource: ResourceRef::Definition {
                        id: dataset.clone(),
                    },
                },
                FailureStage::Validate,
            ));
        }
    }
    Ok(locked)
}

pub(crate) async fn register_watch(
    tx: &WorldTransaction<'_>,
    locked: &LockedRanges,
    watch: &QueryWatch,
    admission: &Admission,
    proof: Option<crate::query::WatchProof>,
    at: &Timestamp,
) -> Result<(), StoreError> {
    if watch.world != *tx.world() || watch.datasets.is_empty() || watch.generation.0 == 0 {
        return Err(reject(ProvenanceFailure::CrossScope));
    }
    let row = tx
        .query_opt("SELECT pg_current_xact_id()::text AS id", &[])
        .await?
        .ok_or_else(|| reject(ProvenanceFailure::InternalFault))?;
    if row.get::<_, String>("id") != locked.transaction {
        return Err(reject(ProvenanceFailure::MissingPremise));
    }
    let partitions = if watch.partitions.is_empty() {
        vec![String::new()]
    } else {
        watch.partitions.clone()
    };
    for dataset in &watch.datasets {
        if dataset.world != *tx.world()
            || partitions.iter().any(|partition| {
                !locked
                    .ranges
                    .contains(&(dataset.id.clone(), partition.clone()))
            })
        {
            return Err(reject(ProvenanceFailure::CrossScope));
        }
    }
    let impact = authorization::actual_impact(
        vec![AccessScope {
            resources: watch
                .datasets
                .iter()
                .map(|dataset| ResourceRef::Definition {
                    id: dataset.id.clone(),
                })
                .collect(),
            fields: Vec::new(),
            modes: vec![AccessMode::Read],
            scope: watch.scope.clone(),
            valid_time: None,
        }],
        vec![Effect::Pure],
        Vec::new(),
        Vec::new(),
        Vec::new(),
    )
    .map_err(auth_error)?;
    admission.require_access(&impact).map_err(auth_error)?;
    let decision = authorization::recheck(tx, admission, at)
        .await
        .map_err(auth_error)?;
    if decision.policy_epoch != watch.policy_epoch
        || decision.grant_epoch != watch.grant_epoch
        || admission.impact().digest != watch.visibility_digest
    {
        return Err(reject(ProvenanceFailure::UnclosedRange {
            watch_id: watch.id.clone(),
        }));
    }
    if matches!(
        watch.purpose,
        WatchPurpose::NotExists | WatchPurpose::MissingField
    ) && watch.coverage != WatchCoverage::CompleteAuthorizedRange
    {
        return Err(reject(ProvenanceFailure::UnclosedRange {
            watch_id: watch.id.clone(),
        }));
    }
    if watch
        .next_boundary
        .as_ref()
        .is_some_and(|boundary| boundary <= at)
    {
        return Err(reject(ProvenanceFailure::Dirty {
            watches: vec![watch.id.clone()],
        }));
    }
    // Public coverage is not proof; only the query owner's exact same-transaction read is.
    if let Some(proof) = proof {
        proof
            .consume(tx, watch, admission)
            .await
            .map_err(super::query_error)?;
    } else {
        match watch.purpose {
            WatchPurpose::NotExists => {
                return Err(reject(ProvenanceFailure::DependencyMissing {
                    dependency:
                        world_protocol::provenance::ProvenanceDependency::ClosedWorldQueryProof,
                }));
            }
            WatchPurpose::MissingField => {
                return Err(reject(ProvenanceFailure::DependencyMissing {
                    dependency:
                        world_protocol::provenance::ProvenanceDependency::FieldCoverageProof,
                }));
            }
            _ => {}
        }
    }
    let purpose = encode(&watch.purpose)?
        .as_str()
        .ok_or_else(|| reject(ProvenanceFailure::InternalFault))?
        .to_owned();
    let coverage = encode(&watch.coverage)?
        .as_str()
        .ok_or_else(|| reject(ProvenanceFailure::InternalFault))?
        .to_owned();
    let (from, to, from_ns, to_ns) = match &watch.window {
        Some(TimeWindow::Fixed { interval }) => (
            Some(interval.from.as_str()),
            interval.to.as_ref().map(Timestamp::as_str),
            Some(interval.from.unix_nanos().to_string()),
            interval.to.as_ref().map(|at| at.unix_nanos().to_string()),
        ),
        _ => (None, None, None, None),
    };
    let changed = tx.execute(
        "INSERT INTO world_watch(tenant_id,world_id,watch_id,dataset_id,partition_key,scope_id,predicate_digest,purpose,coverage,generation,boundary_at,valid_from,valid_to,body,valid_from_ns,valid_to_ns) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::text::timestamptz,$12::text::timestamptz,$13::text::timestamptz,$14,$15::text::numeric,$16::text::numeric) ON CONFLICT(tenant_id,world_id,watch_id) DO UPDATE SET coverage=EXCLUDED.coverage,boundary_at=EXCLUDED.boundary_at,body=EXCLUDED.body,valid_from=EXCLUDED.valid_from,valid_to=EXCLUDED.valid_to,valid_from_ns=EXCLUDED.valid_from_ns,valid_to_ns=EXCLUDED.valid_to_ns WHERE world_watch.generation=EXCLUDED.generation AND world_watch.predicate_digest=EXCLUDED.predicate_digest AND world_watch.scope_id=EXCLUDED.scope_id",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &watch.id.as_str(), &watch.datasets[0].id.as_str(), &partitions[0], &watch.scope.as_str(), &watch.predicate_digest.as_str(), &purpose, &coverage, &number(watch.generation.0)?, &watch.next_boundary.as_ref().map(Timestamp::as_str), &from, &to, &encode(watch)?, &from_ns, &to_ns],
    ).await?;
    tx.require_changed(
        changed,
        ResourceRef::Watch {
            id: watch.id.clone(),
        },
    )?;
    for dataset in &watch.datasets {
        for partition in &partitions {
            tx.execute("INSERT INTO world_watch_range(tenant_id,world_id,watch_id,dataset_id,partition_key) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &watch.id.as_str(), &dataset.id.as_str(), &partition]).await?;
        }
    }
    Ok(())
}

pub(crate) async fn invalidate_ranges(
    tx: &mut WorldTransaction<'_>,
    datasets: &[DefinitionId],
    partitions: &[String],
    budget: &crate::extensions::invocation::CallBudget,
    cancellation: &tokio_util::sync::CancellationToken,
    at: &Timestamp,
) -> Result<Vec<AssertionRef>, StoreError> {
    if datasets.is_empty() {
        return Ok(Vec::new());
    }
    let locked = lock_ranges(tx, datasets, partitions).await?;
    for (dataset, partition) in &locked.ranges {
        tx.execute("UPDATE world_watch_partition SET generation=generation+1 WHERE tenant_id=$1 AND world_id=$2 AND dataset_id=$3 AND partition_key=$4", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &dataset.as_str(), &partition]).await?;
    }
    let watches = range_watches(tx, &locked.ranges, !partitions.is_empty(), budget, cancellation).await?;
    bump(tx, watches.into_iter().collect(), budget, cancellation, at).await
}

fn range_keys(
    datasets: &[DefinitionId], partitions: &[String],
) -> Result<BTreeSet<(DefinitionId, String)>, StoreError> {
    if datasets.len().saturating_mul(partitions.len().max(1)) > BATCH_LIMIT {
        return Err(super::limit(world_protocol::provenance::ProvenanceLimit::WatchPartitions));
    }
    let mut ranges = BTreeSet::new();
    for dataset in datasets {
        // The dataset-wide guard also covers watches created before a partition first exists.
        ranges.insert((dataset.clone(), String::new()));
        for partition in partitions { ranges.insert((dataset.clone(), partition.clone())); }
    }
    Ok(ranges)
}

async fn range_watches(
    tx: &WorldTransaction<'_>, ranges: &BTreeSet<(DefinitionId, String)>, partitioned: bool,
    budget: &crate::extensions::invocation::CallBudget, cancellation: &tokio_util::sync::CancellationToken,
) -> Result<BTreeSet<WatchId>, StoreError> {
    let mut watches = BTreeSet::new();
    for (dataset, partition) in ranges {
        if partitioned && partition.is_empty() { continue; }
        let mut after = String::new();
        loop {
            super::checkpoint(budget, cancellation)?;
            let rows = tx.query("SELECT DISTINCT watch_id FROM world_watch_range WHERE tenant_id=$1 AND world_id=$2 AND dataset_id=$3 AND ($4='' OR partition_key IN ('',$4)) AND watch_id>$5 ORDER BY watch_id LIMIT 256", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &dataset.as_str(), &partition, &after]).await?;
            if rows.is_empty() { break; }
            for row in rows {
                after = row.get("watch_id");
                watches.insert(WatchId::try_new(after.clone()).map_err(|error| {
                    StoreError::caused_by(CommitFailure::InternalFault, FailureStage::Read, error)
                })?);
                if watches.len() > BATCH_LIMIT { return Err(super::limit(world_protocol::provenance::ProvenanceLimit::WatchPartitions)); }
            }
        }
    }
    Ok(watches)
}

pub(super) async fn derivation_ranges(
    tx: &WorldTransaction<'_>, verified: &crate::authorization::VerifiedInvocation,
    conclusion: &SupportSet, datasets: &[DefinitionId], partitions: &[String],
    own: Option<(&WatchId, Option<&QueryWatch>)>,
    budget: &crate::extensions::invocation::CallBudget, cancellation: &tokio_util::sync::CancellationToken,
) -> Result<(Vec<SupportSet>, Vec<AccessScope>, Digest), StoreError> {
    let ranges = range_keys(datasets, partitions)?;
    let mut candidates = range_watches(tx, &ranges, !partitions.is_empty(), budget, cancellation).await?;
    let mut access = Vec::new();
    let mut bodies = BTreeMap::<WatchId, Option<QueryWatch>>::new();
    if let Some((id, prior)) = own {
        if prior.is_some_and(|watch| watch.world != *tx.world() || watch.id != *id) {
            return Err(reject(ProvenanceFailure::CrossScope));
        }
        // Registration is a real write even before this invocation's row exists.
        access.extend(super::maintenance::derivation_read(tx, verified, conclusion,
            vec![ResourceRef::Watch { id: id.clone() }], Vec::new(), Vec::new()).await?.access);
        access.push(AccessScope { resources: vec![ResourceRef::Watch { id: id.clone() }],
            fields: Vec::new(), modes: vec![AccessMode::Write], scope: conclusion.scope.clone(),
            valid_time: Some(conclusion.valid_time.clone()) });
        bodies.insert(id.clone(), prior.cloned());
        // Replacing a whole watch can affect its old consumers even on an attachment.
        candidates.insert(id.clone());
    }
    let mut seeds = BTreeMap::new();
    for id in candidates {
        super::checkpoint(budget, cancellation)?;
        let scope = tx.query_opt("SELECT scope_id,body->'window'->'interval' AS interval FROM world_watch WHERE tenant_id=$1 AND world_id=$2 AND watch_id=$3", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &id.as_str()]).await?;
        let prior = own.filter(|(own, _)| *own == &id).map(|(_, prior)| prior);
        let current = if let Some(row) = scope {
            let scope = ScopeId::try_new(row.get::<_, String>("scope_id")).map_err(|_| reject(ProvenanceFailure::InternalFault))?;
            let interval: Option<world_protocol::time::ValidTime> = row.get::<_, Option<serde_json::Value>>("interval")
                .map(decode).transpose()?;
            let read = authorization::actual_impact(vec![AccessScope { resources: vec![ResourceRef::Watch { id: id.clone() }],
                fields: Vec::new(), modes: vec![AccessMode::Read], scope: scope.clone(), valid_time: interval.clone() }],
                vec![Effect::Pure], Vec::new(), Vec::new(), Vec::new()).map_err(auth_error)?;
            authorization::check_impact_read(tx, verified, &read, &tx.now().await?).await.map_err(auth_error)?;
            access.extend(read.access);
            let row = tx.query_opt("SELECT generation,body FROM world_watch WHERE tenant_id=$1 AND world_id=$2 AND watch_id=$3 FOR SHARE", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &id.as_str()]).await?.ok_or_else(|| reject(ProvenanceFailure::MissingPremise))?;
            let watch: QueryWatch = decode(row.get("body"))?;
            let actual_interval = match &watch.window { Some(TimeWindow::Fixed { interval }) => Some(interval.clone()), _ => None };
            if watch.world != *tx.world() || watch.id != id || watch.scope != scope
                || actual_interval != interval || number(watch.generation.0)? != row.get::<_, i64>("generation") {
                return Err(reject(ProvenanceFailure::CrossScope));
            }
            Some(watch)
        } else if prior == Some(None) { None } else { return Err(reject(ProvenanceFailure::MissingPremise)); };
        let basis = match prior {
            Some(Some(prior)) => {
                let current = current.as_ref().ok_or_else(|| reject(ProvenanceFailure::MissingPremise))?;
                if current.generation != prior.generation {
                    return Err(reject(ProvenanceFailure::BasisChanged { watch_id: id.clone(),
                        expected: prior.generation, actual: current.generation }));
                }
                if current != prior {
                    return Err(StoreError::new(CommitFailure::ReadDependencyChanged {
                        resource: ResourceRef::Watch { id: id.clone() },
                    }, FailureStage::Prepare));
                }
                Some(current.clone())
            }
            Some(None) if current.is_none() => None,
            Some(None) => return Err(StoreError::new(CommitFailure::ReadDependencyChanged {
                resource: ResourceRef::Watch { id: id.clone() },
            }, FailureStage::Prepare)),
            None => current,
        };
        if let Some(watch) = &basis {
            let interval = match &watch.window { Some(TimeWindow::Fixed { interval }) => Some(interval.clone()), _ => None };
            access.push(AccessScope { resources: vec![ResourceRef::Watch { id: id.clone() }],
                fields: Vec::new(), modes: vec![AccessMode::Write], scope: watch.scope.clone(), valid_time: interval });
        }
        let (consumers, read) = super::maintenance::watch_consumers_read(
            tx, &id, basis.as_ref().map(|watch| watch.generation), Some(verified), budget, cancellation,
        ).await?;
        access.extend(read);
        for support in consumers {
            seeds.insert(support.reference.id.clone(), support);
            if seeds.len() > BATCH_LIMIT { return Err(super::limit(world_protocol::provenance::ProvenanceLimit::AlternativeSupports)); }
        }
        bodies.insert(id, basis);
    }
    let fingerprint = crate::definitions::canonical_digest(&("world.derived-watch-ranges.v1", ranges, bodies))
        .map_err(|error| StoreError::caused_by(CommitFailure::InvalidBatch, FailureStage::Prepare, crate::definitions::DefinitionError::from(error)))?;
    Ok((seeds.into_values().collect(), access, fingerprint))
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct DueWatches {
    watches: Vec<QueryWatch>,
}

pub(crate) async fn select_due(
    tx: &WorldTransaction<'_>,
    budget: &crate::extensions::invocation::CallBudget,
    cancellation: &tokio_util::sync::CancellationToken,
    _at: &Timestamp,
    limit: u32,
) -> Result<Option<DueWatches>, StoreError> {
    tx.require_domain(&WriterDomain::try_new("facts").expect("fixed writer domain"))?;
    let at = &tx.now().await?;
    if limit == 0 || limit > 256 {
        return Err(reject(ProvenanceFailure::InternalFault));
    }
    let mut watches = Vec::new();
    let mut after_time: Option<String> = None;
    let mut after_id = String::new();
    while watches.len() < limit as usize {
        super::checkpoint(budget, cancellation)?;
        let rows = tx.query("SELECT watch_id,boundary_at::text AS candidate_at,body FROM world_watch WHERE tenant_id=$1 AND world_id=$2 AND boundary_at<=$3::text::timestamptz AND ($4::text IS NULL OR (boundary_at,watch_id)>($4::text::timestamptz,$5)) ORDER BY boundary_at,watch_id LIMIT 256 FOR UPDATE SKIP LOCKED", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &at.as_str(), &after_time, &after_id]).await?;
        if rows.is_empty() {
            break;
        }
        for row in rows {
            after_time = Some(row.get("candidate_at"));
            after_id = row.get("watch_id");
            let watch: QueryWatch = decode(row.get("body"))?;
            // PostgreSQL's microsecond timestamp is only a candidate index.
            if watch
                .next_boundary
                .as_ref()
                .is_some_and(|boundary| boundary <= at)
            {
                watches.push(watch);
                if watches.len() == limit as usize {
                    break;
                }
            }
        }
    }
    Ok((!watches.is_empty()).then_some(DueWatches { watches }))
}

pub(crate) async fn due_impact(
    tx: &WorldTransaction<'_>, batch: &DueWatches,
    budget: &crate::extensions::invocation::CallBudget,
    cancellation: &tokio_util::sync::CancellationToken,
) -> Result<ActualImpact, StoreError> {
    if batch.watches.is_empty() || batch.watches.len() > 256 { return Err(reject(ProvenanceFailure::MissingPremise)); }
    let mut seeds = Vec::<SupportSet>::new();
    let mut access = Vec::new();
    for watch in &batch.watches {
        super::checkpoint(budget, cancellation)?;
        if watch.world != *tx.world() { return Err(reject(ProvenanceFailure::CrossScope)); }
        access.push(AccessScope { resources: vec![ResourceRef::Watch { id: watch.id.clone() }], fields: Vec::new(), modes: vec![AccessMode::Write], scope: watch.scope.clone(), valid_time: None });
        let mut after = String::new();
        loop {
            super::checkpoint(budget, cancellation)?;
            let rows = tx.query("SELECT DISTINCT r.support_id,r.body FROM world_support_premise p JOIN world_support_head h ON h.tenant_id=p.tenant_id AND h.world_id=p.world_id AND h.support_id=p.support_id AND h.revision=p.support_revision JOIN world_support_revision r ON r.tenant_id=h.tenant_id AND r.world_id=h.world_id AND r.support_id=h.support_id AND r.revision=h.revision WHERE p.tenant_id=$1 AND p.world_id=$2 AND p.premise_kind='watch' AND p.premise_id=$3 AND p.watch_generation<=$4 AND p.support_id>$5 ORDER BY r.support_id LIMIT 256", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &watch.id.as_str(), &number(watch.generation.0)?, &after]).await?;
            if rows.is_empty() { break; }
            for row in rows {
                after = row.get("support_id");
                if seeds.len() == BATCH_LIMIT { return Err(super::limit(world_protocol::provenance::ProvenanceLimit::AlternativeSupports)); }
                seeds.push(decode(row.get("body"))?);
            }
        }
    }
    let mut impact = authorization::actual_impact(access, vec![Effect::Pure], Vec::new(), Vec::new(), Vec::new()).map_err(auth_error)?;
    if !seeds.is_empty() {
        let consumers = super::maintenance::consumer_impact(tx, seeds, budget, cancellation).await?;
        impact.access.extend(consumers.access);
        impact.effects.extend(consumers.effects);
        impact.labels.extend(consumers.labels);
        impact.state.extend(consumers.state);
        impact.source_ids.extend(consumers.source_ids);
    }
    authorization::actual_impact(impact.access, impact.effects, impact.labels, impact.state, impact.source_ids).map_err(auth_error)
}

pub(crate) async fn expire_due(
    tx: &mut WorldTransaction<'_>, batch: &DueWatches, admission: &Admission,
    budget: &crate::extensions::invocation::CallBudget,
    cancellation: &tokio_util::sync::CancellationToken, _at: &Timestamp,
) -> Result<Vec<AssertionRef>, StoreError> {
    tx.require_domain(&WriterDomain::try_new("facts").expect("fixed writer domain"))?;
    let at = &tx.now().await?;
    authorization::recheck(tx, admission, at).await.map_err(auth_error)?;
    let impact = due_impact(tx, batch, budget, cancellation).await?;
    admission.require_access(&impact).map_err(auth_error)?;
    for watch in &batch.watches {
        super::checkpoint(budget, cancellation)?;
        let row = tx.query_opt("SELECT body FROM world_watch WHERE tenant_id=$1 AND world_id=$2 AND watch_id=$3 FOR UPDATE", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &watch.id.as_str()]).await?.ok_or_else(|| reject(ProvenanceFailure::MissingPremise))?;
        if decode::<QueryWatch>(row.get("body"))? != *watch || !watch.next_boundary.as_ref().is_some_and(|boundary| boundary <= at) {
            return Err(reject(ProvenanceFailure::MissingPremise));
        }
    }
    bump(tx, batch.watches.iter().map(|watch| watch.id.clone()).collect(), budget, cancellation, at).await
}

pub(crate) async fn due_retention(
    tx: &WorldTransaction<'_>, batch: &DueWatches,
) -> Result<RetentionRoots, StoreError> {
    let mut roots = RetentionRoots::default();
    for watch in &batch.watches {
        if watch.world != *tx.world() { return Err(reject(ProvenanceFailure::CrossScope)); }
        retain_watch(&mut roots, watch);
    }
    Ok(roots)
}

async fn bump(
    tx: &mut WorldTransaction<'_>,
    watches: Vec<WatchId>,
    budget: &crate::extensions::invocation::CallBudget,
    cancellation: &tokio_util::sync::CancellationToken,
    at: &Timestamp,
) -> Result<Vec<AssertionRef>, StoreError> {
    let mut dependencies = Vec::new();
    for id in watches {
        super::checkpoint(budget, cancellation)?;
        let row = tx.query_opt("SELECT generation,body FROM world_watch WHERE tenant_id=$1 AND world_id=$2 AND watch_id=$3 FOR UPDATE", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &id.as_str()]).await?.ok_or_else(|| reject(ProvenanceFailure::MissingPremise))?;
        let old = Generation(row.get::<_, i64>("generation") as u64);
        let mut watch: QueryWatch = decode(row.get("body"))?;
        watch.generation = Generation(
            old.0
                .checked_add(1)
                .ok_or_else(|| reject(ProvenanceFailure::InternalFault))?,
        );
        // Keep the exact overdue boundary in the body; retain future boundary candidates.
        let boundary_due = watch
            .next_boundary
            .as_ref()
            .is_some_and(|boundary| boundary <= at);
        tx.execute("UPDATE world_watch SET generation=$4,body=$5,boundary_at=CASE WHEN $6 THEN NULL ELSE boundary_at END WHERE tenant_id=$1 AND world_id=$2 AND watch_id=$3", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &id.as_str(), &number(watch.generation.0)?, &encode(&watch)?, &boundary_due]).await?;
        dependencies.push(ReadDependency::Watch {
            id,
            generation: old,
        });
    }
    super::maintenance::invalidate_dependencies(tx, &dependencies, false, budget, cancellation, at)
        .await
}

pub(super) fn auth_error(error: authorization::AuthError) -> StoreError {
    match error {
        authorization::AuthError::Store(error) => error,
        error => StoreError::caused_by(CommitFailure::InvalidBatch, FailureStage::Validate, error),
    }
}
