use super::SyncError;
use crate::{identity, sources::mapping, store::WorldTransaction};
use world_protocol::{
    identity::{AliasResolution, IdentityRecord, SourceAlias, SubjectRef},
    ids::*, time::{Timestamp, ValidTime},
};

/// A matching type is insufficient: a selected source must actually resolve an alias to the subject.
pub(crate) async fn reconcile_subject_coverage(
    tx: &WorldTransaction<'_>, bindings: &[DefinitionRef], subjects: &[SubjectRef], now: &Timestamp,
    budget: &crate::extensions::invocation::CallBudget, cancellation: &tokio_util::sync::CancellationToken,
) -> Result<(), SyncError> {
    let mut plans = Vec::with_capacity(bindings.len());
    for reference in bindings {
        let binding = mapping::read_binding(tx, reference).await?.ok_or_else(SyncError::protocol)?;
        plans.push(mapping::compile_binding(tx, binding).await?);
    }
    let datasets = plans.iter().map(|plan| plan.mapping.type_ref.id.clone()).collect::<std::collections::BTreeSet<_>>().into_iter().collect::<Vec<_>>();
    crate::facts::support::lock_ranges(tx, &datasets, &[]).await?;
    let mut receipts = Vec::new();
    for subject in subjects {
        if cancellation.is_cancelled() { return Err(world_protocol::sources::MappingFailure::Cancelled.into()); }
        budget.check().map_err(|error| world_protocol::sources::MappingFailure::BudgetExceeded { dimension: error.dimension })?;
        let identity = identity::get_in_transaction(tx, subject).await?.ok_or(world_protocol::sources::MappingFailure::IdentityUnresolved)?;
        let type_id = match &identity.record { IdentityRecord::Object(record) => &record.type_id, IdentityRecord::Relation(record) => &record.type_id };
        let mut covered = false;
        for plan in &plans {
            if &plan.mapping.type_ref.id != type_id { continue; }
            let w = tx.world();
            let remaining = budget.remaining(world_protocol::budget::BudgetDimension::Rows).map_err(|error| world_protocol::sources::MappingFailure::BudgetExceeded { dimension: error.dimension })?;
            let limit = i64::try_from(remaining.saturating_add(1)).unwrap_or(i64::MAX);
            let rows = tx.query("SELECT r.body FROM world_source_alias_current c JOIN world_source_alias_revision r USING(tenant_id,world_id,source_id,namespace,native_key,incarnation,valid_from_ns,revision) WHERE c.tenant_id=$1 AND c.world_id=$2 AND c.source_id=$3 AND c.namespace=$4 AND numrange(c.valid_from_ns,c.valid_to_ns,'[)') @> $5::text::numeric ORDER BY c.native_key,c.incarnation LIMIT $6", &[&w.tenant_id.as_str(), &w.world_id.as_str(), &plan.binding_body.source_id.as_str(), &plan.binding_body.namespace, &now.unix_nanos().to_string(), &limit]).await?;
            budget.charge(world_protocol::budget::BudgetDimension::Rows, rows.len() as u64).map_err(|error| world_protocol::sources::MappingFailure::BudgetExceeded { dimension: error.dimension })?;
            for row in rows {
                let alias: SourceAlias = super::decode(row.get("body"))?;
                if alias.key.world != *w || alias.key.source_id != plan.binding_body.source_id || alias.key.namespace != plan.binding_body.namespace || !alias.key.valid_time.contains(now) {
                    return Err(SyncError::protocol());
                }
                let mut key = alias.key;
                key.valid_time = ValidTime::try_new(now.clone(), key.valid_time.to.clone()).map_err(|_| SyncError::protocol())?;
                let receipt = identity::resolve_in_transaction(tx, &key, &plan.binding_body.scope).await?;
                if matches!(&receipt.resolution, AliasResolution::Existing { identity: actual, .. } if actual == &identity) {
                    receipts.push(receipt);
                    covered = true;
                    break;
                }
            }
            if covered { break; }
        }
        if !covered { return Err(world_protocol::sources::MappingFailure::IdentityUnresolved.into()); }
    }
    identity::recheck_receipts(tx, &receipts, subjects).await?;
    Ok(())
}
