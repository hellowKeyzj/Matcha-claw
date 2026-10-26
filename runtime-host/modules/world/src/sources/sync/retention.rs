use super::{SyncError, decode, inbox::Entry, trusted::StoredInput};
use crate::store::{RetentionRoots, WorldTransaction};
use world_protocol::{
    ids::*,
    provenance::ReadDependency,
    sources::{BranchSourceCapture, SourceBasis, SourcePosition},
};

/// Archives retain captures even when no derivation has consumed their evidence.
pub(crate) async fn archive_source_roots(
    snapshot: &crate::store::WorldSnapshot<'_>,
) -> Result<RetentionRoots, SyncError> {
    let mut roots = RetentionRoots::default();
    let mut after = String::new();
    loop {
        let rows = snapshot.query("SELECT capture_digest,source_id,source_version_id,body,raw FROM world_source_branch_capture WHERE tenant_id=$1 AND world_id=$2 AND capture_digest>$3 ORDER BY capture_digest LIMIT 256", &[&snapshot.world().tenant_id.as_str(), &snapshot.world().world_id.as_str(), &after]).await?;
        let done = rows.len() < 256;
        for row in rows {
            after = row.get("capture_digest");
            let capture: BranchSourceCapture = decode(row.get("body"))?;
            let raw: super::branch_capture::RawBranchCapture = decode(row.get("raw"))?;
            let version = crate::content::read_source_version_metadata_snapshot(snapshot, &capture.source_version).await?;
            let bytes = super::branch_capture::raw_bytes(&raw)?;
            let digest = world_protocol::schema::hash(&bytes).map_err(|_| SyncError::protocol())?;
            if capture.branch.world != *snapshot.world() || capture.binding.world != *snapshot.world()
                || capture.digest.as_str() != after || super::branch_capture::digest(&capture)? != capture.digest
                || capture.source_version.source_id.as_str() != row.get::<_, String>("source_id")
                || capture.source_version.version_id.as_str() != row.get::<_, String>("source_version_id")
                || raw.branch != capture.branch || raw.page.basis != capture.basis
                || raw.compile_digest != capture.compile_digest || raw.model_digest != capture.model_digest
                || raw.plan_digest != capture.plan_digest || version.reference != capture.source_version
                || version.blob.digest != digest || version.blob.byte_size != bytes.len() as u64
            { return Err(SyncError::protocol()); }
            roots.source_versions.push(capture.source_version);
            for evidence in capture.evidence {
                if evidence.reference.world != *snapshot.world() || evidence.locator.source_version.world != *snapshot.world() {
                    return Err(SyncError::protocol());
                }
                roots.source_versions.push(evidence.locator.source_version);
                roots.parse_artifacts.extend(evidence.locator.parse_artifact_id);
            }
        }
        if done { break; }
    }
    let mut after = (String::new(), String::new(), String::new());
    loop {
        let rows = snapshot.query("SELECT source_id,partition_key,event_id,body FROM world_source_inbox WHERE tenant_id=$1 AND world_id=$2 AND (source_id,partition_key,event_id)>($3,$4,$5) ORDER BY source_id,partition_key,event_id LIMIT 256", &[&snapshot.world().tenant_id.as_str(), &snapshot.world().world_id.as_str(), &after.0, &after.1, &after.2]).await?;
        let done = rows.len() < 256;
        for row in rows {
            after = (row.get("source_id"), row.get("partition_key"), row.get("event_id"));
            let entry: Entry = decode(row.get("body"))?;
            if entry.raw.assignment.world != *snapshot.world() || entry.raw.assignment.source_id.as_str() != after.0
                || entry.raw.assignment.partition != after.1 || entry.input.event_id.as_str() != after.2
                || entry.input.source_version.world != *snapshot.world() { return Err(SyncError::protocol()); }
            roots.source_versions.push(entry.input.source_version);
        }
        if done { break; }
    }
    roots.source_versions.sort_by(|left, right| (&left.source_id, &left.version_id).cmp(&(&right.source_id, &right.version_id)));
    roots.source_versions.dedup();
    roots.parse_artifacts.sort(); roots.parse_artifacts.dedup();
    Ok(roots)
}

/// Historical custody is independent from current connection, release and source frontiers.
pub(crate) async fn retained_source_materials(
    tx: &WorldTransaction<'_>,
    bases: &[SourceBasis],
    dependencies: &[ReadDependency],
) -> Result<RetentionRoots, SyncError> {
    let mut roots = RetentionRoots::default();
    for basis in bases {
        if &basis.binding.world != tx.world() || &basis.schema.world != tx.world() {
            return Err(SyncError::protocol());
        }
        roots.definitions.push(basis.binding.clone());
        roots.definitions.extend(basis.field_definitions.clone());
        roots.schemas.push(basis.schema.clone());
        if let Some(position) = &basis.position {
            position_materials(tx, position, &basis.binding, &mut roots).await?;
        }
        if let Some(token) = &basis.snapshot {
            let w = tx.world();
            let rows = tx.query("SELECT body,input_digest FROM world_source_inbox WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 AND body->'input'->'basis'->>'snapshot'=$4", &[&w.tenant_id.as_str(), &w.world_id.as_str(), &basis.source_id.as_str(), &token]).await?;
            for row in rows {
                let entry: Entry = decode(row.get("body"))?;
                if entry.input.basis.binding != basis.binding { continue; }
                retain_input(tx, entry, &row.get::<_, String>("input_digest"), &mut roots).await?;
            }
            let rows = tx.query("SELECT body FROM world_source_branch_capture WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 AND binding_id=$4 AND binding_revision=$5 AND body->'basis'->>'snapshot'=$6", &[&w.tenant_id.as_str(), &w.world_id.as_str(), &basis.source_id.as_str(), &basis.binding.id.as_str(), &super::number(basis.binding.revision.0)?, &token]).await?;
            for row in rows {
                let capture: BranchSourceCapture = decode(row.get("body"))?;
                if capture.binding != basis.binding || capture.basis != *basis || capture.branch.world != *w {
                    return Err(SyncError::protocol());
                }
                roots.branches.push(capture.branch);
                roots.source_versions.push(capture.source_version);
                roots.evidence.extend(capture.evidence.into_iter().map(|evidence| evidence.reference));
            }
        }
    }
    for dependency in dependencies {
        match dependency {
            ReadDependency::Source { position, binding } => position_materials(tx, position, binding, &mut roots).await?,
            ReadDependency::SourceMapping { mapping, binding, .. } => {
                if &mapping.world != tx.world() || &binding.world != tx.world() { return Err(SyncError::protocol()); }
                roots.mappings.push(mapping.clone());
                roots.definitions.push(binding.clone());
            }
            ReadDependency::SourceField { schema, .. } => {
                if &schema.world != tx.world() { return Err(SyncError::protocol()); }
                roots.schemas.push(schema.clone());
            }
            _ => {},
        }
    }
    roots.source_versions.sort_by(|left, right| (&left.source_id, &left.version_id).cmp(&(&right.source_id, &right.version_id))); roots.source_versions.dedup();
    roots.definitions.sort(); roots.definitions.dedup();
    roots.schemas.sort(); roots.schemas.dedup();
    roots.mappings.sort(); roots.mappings.dedup();
    Ok(roots)
}

/// Safety tables are retained by logical deletion and therefore root their own exact materials.
pub(crate) async fn world_deletion_roots(tx: &WorldTransaction<'_>) -> Result<RetentionRoots, SyncError> {
    let mut roots = RetentionRoots::default();
    let w = tx.world();
    for row in tx.query("SELECT body,input_digest FROM world_source_inbox WHERE tenant_id=$1 AND world_id=$2", &[&w.tenant_id.as_str(), &w.world_id.as_str()]).await? {
        retain_input(tx, decode(row.get("body"))?, &row.get::<_, String>("input_digest"), &mut roots).await?;
    }
    for row in tx.query("SELECT body FROM world_source_partition WHERE tenant_id=$1 AND world_id=$2", &[&w.tenant_id.as_str(), &w.world_id.as_str()]).await? {
        let partition: super::model::Partition = decode(row.get("body"))?;
        retain_assignment(tx, &partition.assignment, &mut roots)?;
    }
    for row in tx.query("SELECT basis FROM world_source_reconcile WHERE tenant_id=$1 AND world_id=$2", &[&w.tenant_id.as_str(), &w.world_id.as_str()]).await? {
        let state: super::snapshot::ReconcileState = decode(row.get("basis"))?;
        retain_assignment(tx, &state.assignment, &mut roots)?;
    }
    for row in tx.query("SELECT receipt FROM world_source_handoff WHERE tenant_id=$1 AND world_id=$2", &[&w.tenant_id.as_str(), &w.world_id.as_str()]).await? {
        let handoff: super::model::Handoff = decode(row.get("receipt"))?;
        retain_assignment(tx, &handoff.assignment, &mut roots)?;
        retain_assignment(tx, &handoff.next, &mut roots)?;
    }
    for row in tx.query("SELECT body FROM world_source_claim WHERE tenant_id=$1 AND world_id=$2", &[&w.tenant_id.as_str(), &w.world_id.as_str()]).await? {
        let assertion: world_protocol::facts::Assertion = decode(row.get("body"))?;
        roots.resources.push(ResourceRef::Assertion { id: assertion.reference.id });
        roots.evidence.extend(assertion.evidence);
        roots.scopes.push(assertion.scope);
    }
    for row in tx.query("SELECT branch_id,branch_revision,body FROM world_source_branch_authority WHERE tenant_id=$1 AND world_id=$2", &[&w.tenant_id.as_str(), &w.world_id.as_str()]).await? {
        let authority: world_protocol::facts::SourceAuthority = decode(row.get("body"))?;
        if authority.world != *w { return Err(SyncError::protocol()); }
        roots.branches.push(world_protocol::releases::BranchRef { world: w.clone(), id: BranchId::try_new(row.get::<_, String>("branch_id")).map_err(|_| SyncError::protocol())?, revision: Revision(u64::try_from(row.get::<_, i64>("branch_revision")).map_err(|_| SyncError::protocol())?) });
        roots.definitions.push(authority.binding);
        roots.scopes.push(authority.scope);
        match authority.ownership {
            world_protocol::facts::AuthorityOwnership::Properties { properties } => roots.definitions.extend(properties),
            world_protocol::facts::AuthorityOwnership::RelationRoles { relation_type, .. } => roots.definitions.push(relation_type),
        }
    }
    Ok(roots)
}

fn retain_assignment(tx: &WorldTransaction<'_>, assignment: &super::Assignment, roots: &mut RetentionRoots) -> Result<(), SyncError> {
    if &assignment.world != tx.world() { return Err(SyncError::protocol()); }
    roots.definitions.push(assignment.binding.clone());
    roots.mappings.push(assignment.mapping.clone());
    roots.schemas.push(assignment.schema.clone());
    roots.scopes.push(assignment.scope.clone());
    Ok(())
}

async fn position_materials(
    tx: &WorldTransaction<'_>, position: &SourcePosition, binding: &DefinitionRef, roots: &mut RetentionRoots,
) -> Result<(), SyncError> {
    if &binding.world != tx.world() { return Err(SyncError::protocol()); }
    let w = tx.world();
    let rows = tx.query("SELECT body,input_digest FROM world_source_inbox WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 AND partition_key=$4 AND position=$5", &[&w.tenant_id.as_str(), &w.world_id.as_str(), &position.source_id.as_str(), &position.partition, &super::encode(position)?]).await?;
    for row in rows {
        let entry: Entry = decode(row.get("body"))?;
        if entry.input.basis.binding != *binding { continue; }
        if entry.input.position != *position { return Err(SyncError::protocol()); }
        retain_input(tx, entry, &row.get::<_, String>("input_digest"), roots).await?;
    }
    Ok(())
}

async fn retain_input(tx: &WorldTransaction<'_>, entry: Entry, digest: &str, roots: &mut RetentionRoots) -> Result<(), SyncError> {
    let input = StoredInput::verified(tx, entry.input, entry.raw, digest).await?;
    roots.source_versions.push(input.version.reference);
    roots.definitions.push(input.raw.assignment.binding);
    roots.mappings.push(input.raw.assignment.mapping);
    roots.schemas.push(input.raw.assignment.schema);
    roots.scopes.push(input.raw.assignment.scope);
    Ok(())
}
