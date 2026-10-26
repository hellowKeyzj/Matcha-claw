use super::{Assignment, SyncError, trusted::StoredInput};
use world_protocol::{
    identity::SourceKey,
    ids::*,
    provenance::ReadDependency,
    sources::{CompiledSourcePlan, SourceBasis},
};

/// An exact native tombstone from a verified, complete transaction prefix.
pub(crate) struct SourceIdentityDeletion {
    key: SourceKey,
    scope: ScopeId,
    binding: DefinitionRef,
    rule: IdentityRuleRef,
    dependencies: Vec<ReadDependency>,
    basis: SourceBasis,
}
impl SourceIdentityDeletion {
    pub(crate) fn key(&self) -> &SourceKey { &self.key }
    pub(crate) fn scope(&self) -> &ScopeId { &self.scope }
    pub(crate) fn binding(&self) -> &DefinitionRef { &self.binding }
    pub(crate) fn rule(&self) -> &IdentityRuleRef { &self.rule }
    pub(crate) fn dependencies(&self) -> &[ReadDependency] { &self.dependencies }
    pub(super) fn basis(&self) -> &SourceBasis { &self.basis }
}

pub(super) fn deletions(
    a: &Assignment, complete: &super::inbox::CompleteInput<'_>, plan: &CompiledSourcePlan,
) -> Result<Vec<SourceIdentityDeletion>, SyncError> {
    let entry = complete.input();
    if complete.deletions().is_empty() { return Ok(Vec::new()); }
    if !matches!(&entry.input.kind, super::CaptureKind::Changes { .. })
        || !a.continues(&entry.raw.assignment) || plan.binding != a.binding
    { return Err(SyncError::protocol()); }
    let mut keys = std::collections::BTreeSet::new();
    complete.deletions().iter().map(|(native_key, incarnation)| {
        if native_key.is_empty() || incarnation.is_empty() || !keys.insert(native_key) {
            return Err(SyncError::protocol());
        }
        Ok(SourceIdentityDeletion {
            key: SourceKey { world: a.world.clone(), source_id: a.source_id.clone(),
                namespace: plan.binding_body.namespace.clone(), native_key: native_key.clone(),
                incarnation: incarnation.clone(), valid_time: entry.input.valid_time.clone() },
            scope: a.scope.clone(), binding: a.binding.clone(), rule: a.identity_rule.clone(),
            dependencies: vec![ReadDependency::SourceMapping { mapping: a.mapping.clone(),
                identity_rule: a.identity_rule.clone(), authority: plan.authority.authority.clone(),
                binding: a.binding.clone() }, ReadDependency::Source {
                position: entry.input.position.clone(), binding: a.binding.clone() }],
            basis: entry.input.basis.clone(),
        })
    }).collect()
}

/// Reliable key material is attested by an actual captured row, not candidate recall.
pub(crate) struct SourceIdentityRow {
    key: SourceKey,
    type_ref: DefinitionRef,
    scope: ScopeId,
    evidence: Vec<EvidenceRef>,
    dependencies: Vec<ReadDependency>,
    rule: IdentityRuleRef,
    binding: DefinitionRef,
}
impl SourceIdentityRow {
    pub(crate) fn key(&self) -> &SourceKey {
        &self.key
    }
    pub(crate) fn type_ref(&self) -> &DefinitionRef {
        &self.type_ref
    }
    pub(crate) fn scope(&self) -> &ScopeId {
        &self.scope
    }
    pub(crate) fn evidence(&self) -> &[EvidenceRef] {
        &self.evidence
    }
    pub(crate) fn dependencies(&self) -> &[ReadDependency] {
        &self.dependencies
    }
    pub(crate) fn rule(&self) -> &IdentityRuleRef {
        &self.rule
    }
    pub(crate) fn binding(&self) -> &DefinitionRef {
        &self.binding
    }
}
pub(super) async fn lock_datasets(
    tx: &crate::store::WorldTransaction<'_>,
    a: &Assignment,
    plan: &CompiledSourcePlan,
) -> Result<(), SyncError> {
    let rows = tx.query("SELECT body FROM world_source_claim WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 AND partition_key=$4 AND binding_id=$5", &[&a.world.tenant_id.as_str(), &a.world.world_id.as_str(), &a.source_id.as_str(), &a.partition, &a.binding.id.as_str()]).await?;
    let assertions = rows
        .into_iter()
        .map(|row| super::decode::<world_protocol::facts::Assertion>(row.get("body")))
        .collect::<Result<Vec<_>, _>>()?;
    let claims = assertions
        .iter()
        .map(|assertion| (&assertion.claim, &assertion.origin))
        .collect::<Vec<_>>();
    let (actual_datasets, actual_partitions) =
        crate::facts::support::assertion_ranges(tx, &claims).await?;
    let mut datasets = std::collections::BTreeSet::from([
        plan.mapping.type_ref.id.clone(),
        plan.binding.id.clone(),
    ]);
    datasets.extend(actual_datasets);
    datasets.extend(
        plan.mapping
            .fields
            .iter()
            .map(|field| field.property.id.clone()),
    );
    datasets.extend(
        plan.mapping
            .relations
            .iter()
            .map(|relation| relation.relation_type.id.clone()),
    );
    let mut partitions = std::collections::BTreeSet::from([a.partition.clone()]);
    partitions.extend(actual_partitions);
    crate::facts::support::lock_ranges(
        tx,
        &datasets.into_iter().collect::<Vec<_>>(),
        &partitions.into_iter().collect::<Vec<_>>(),
    )
    .await?;
    Ok(())
}

/// Lock the whole prefix before any entry can close or allocate an identity.
pub(super) async fn lock_keys(
    tx: &crate::store::WorldTransaction<'_>, a: &Assignment,
    entries: &[StoredInput], plan: &CompiledSourcePlan,
) -> Result<(), SyncError> {
    let mut keys = Vec::new();
    for entry in entries {
        for (native_key, incarnation) in entry.input.rows.iter()
            .filter(|row| crate::sources::mapping::validate_row_key(plan, &plan.schema, row).is_ok())
            .map(|row| (&row.native_key, &row.incarnation)).chain(entry.input.deletions.iter().map(|(key, incarnation)| (key, incarnation)))
        {
            keys.push(SourceKey { world: a.world.clone(), source_id: a.source_id.clone(),
                namespace: plan.binding_body.namespace.clone(), native_key: native_key.clone(),
                incarnation: incarnation.clone(), valid_time: entry.input.valid_time.clone() });
        }
    }
    keys.sort_by(|a, b| (&a.source_id, &a.namespace, &a.native_key)
        .cmp(&(&b.source_id, &b.namespace, &b.native_key)));
    for key in &keys {
        crate::identity::lock_source_alias_range(tx, &key.source_id, &key.namespace, &key.native_key).await?;
    }
    let mut subjects = Vec::new();
    for key in &keys {
        let receipt = crate::identity::resolve_in_transaction(tx, key, &a.scope).await?;
        subjects.extend(receipt.dependencies.into_iter().filter_map(|dependency| match dependency {
            ReadDependency::Identity { subject, .. } => Some(subject), _ => None,
        }));
    }
    crate::identity::lock_influence(tx, &subjects).await?;
    Ok(())
}

/// One complete durable native transaction, minted only after Inbox/content verification.
pub(crate) struct SourceIdentityPrefix {
    digest: Digest,
    rows: Vec<SourceIdentityRow>,
    deletions: Vec<SourceIdentityDeletion>,
}
impl SourceIdentityPrefix {
    pub(crate) fn digest(&self) -> &Digest { &self.digest }
    pub(crate) fn rows(&self) -> &[SourceIdentityRow] { &self.rows }
    pub(crate) fn deletions(&self) -> &[SourceIdentityDeletion] { &self.deletions }
    pub(super) fn verified(
        a: &Assignment, entries: &[StoredInput], plan: &CompiledSourcePlan, digest: &Digest,
    ) -> Result<Self, SyncError> {
        if entries.is_empty() || plan.binding != a.binding { return Err(SyncError::protocol()); }
        let mut rows = Vec::new();
        let mut deleted = Vec::new();
        for complete in super::inbox::CompleteInput::transaction(entries) {
            deleted.extend(deletions(a, &complete, plan)?);
            let entry = complete.input();
            for row in complete.rows() {
                // Invalid rows remain mapping failures and never allocate identities first.
                if crate::sources::mapping::validate_row_key(plan, &plan.schema, row).is_err() { continue; }
                rows.push(SourceIdentityRow {
                    key: SourceKey { world: a.world.clone(), source_id: a.source_id.clone(),
                        namespace: plan.binding_body.namespace.clone(), native_key: row.native_key.clone(),
                        incarnation: row.incarnation.clone(), valid_time: entry.input.valid_time.clone() },
                    type_ref: plan.mapping.type_ref.clone(), scope: a.scope.clone(), evidence: Vec::new(),
                    dependencies: vec![ReadDependency::SourceMapping { mapping: a.mapping.clone(),
                        identity_rule: a.identity_rule.clone(), authority: plan.authority.authority.clone(),
                        binding: a.binding.clone() }, ReadDependency::Source {
                        position: entry.input.position.clone(), binding: a.binding.clone() }],
                    rule: a.identity_rule.clone(), binding: a.binding.clone(),
                });
            }
        }
        Ok(Self { digest: digest.clone(), rows, deletions: deleted })
    }
}
