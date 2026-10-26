use world_protocol::{authorization::ActualImpact, ids::*, releases::{BranchRef, Release}};
use crate::{authorization, definitions, facts::support::{self, DependencyReader}, sources::sync, store::{WorldSnapshot, WorldTransaction}};
use super::{Error, invalid, number, read::decode_row};
use super::super::derived::{merge, normalize_impact};

pub(crate) async fn branch_derivation_impact(tx: &WorldTransaction<'_>, branch: &BranchRef, model: &Release, scope: &ScopeId) -> Result<ActualImpact, Error> {
    discover(DependencyReader::Transaction(tx), branch, model, scope).await
}
pub(crate) async fn branch_derivation_impact_snapshot(snapshot: &WorldSnapshot<'_>, branch: &BranchRef, model: &Release, scope: &ScopeId) -> Result<ActualImpact, Error> {
    discover(DependencyReader::Snapshot(snapshot), branch, model, scope).await
}
async fn discover(reader: DependencyReader<'_, '_>, branch: &BranchRef, model: &Release, scope: &ScopeId) -> Result<ActualImpact, Error> {
    if reader.world() != &branch.world || model.world != branch.world || model.source_branch.as_ref() != Some(branch) { return Err(invalid()); }
    let digest = definitions::canonical_digest(model)?;
    let now = match reader { DependencyReader::Transaction(tx) => tx.now().await?, DependencyReader::Snapshot(snapshot) => snapshot.now().await? };
    let mut canonical_model = model.clone(); canonical_model.source_branch = None;
    let mut impact = super::super::impact::resource_read_impact(ResourceRef::Branch { id: branch.id.clone() }, Vec::new(), scope, None, Vec::new(), None)?;
    let mut after = String::new(); let mut count = 0;
    let branch_body = match reader { DependencyReader::Transaction(tx) => crate::releases::read_branch_revision(tx, branch).await,
        DependencyReader::Snapshot(snapshot) => crate::releases::read_branch_revision_snapshot(snapshot, branch).await }.map_err(crate::query::QueryError::from)?.ok_or_else(invalid)?;
    loop {
        let rows = reader.query(super::read::HEADS, &[&branch.world.tenant_id.as_str(), &branch.world.world_id.as_str(), &branch.id.as_str(), &number(branch.revision.0)?, &after, &scope.as_str()]).await?;
        if rows.is_empty() { break; }
        for row in rows {
            after = row.get("assertion_id"); count += 1;
            if count > 4096 { return Err(invalid()); }
            let record = decode_row(row)?;
            if record.branch != *branch || record.release_id != model.id || record.model_digest != digest || record.assertion.scope != *scope { return Err(invalid()); }
            merge(&mut impact, record.read_impact()?);
            for witness in &record.witnesses {
                for (binding, _) in &witness.derivation.capture_witness {
                    let capture = match reader { DependencyReader::Transaction(tx) => sync::selected_branch_capture(tx, &branch_body, binding).await,
                        DependencyReader::Snapshot(snapshot) => sync::selected_branch_capture_snapshot(snapshot, &branch_body, binding).await }.map_err(crate::query::QueryError::from)?.ok_or_else(invalid)?;
                    let current = match reader { DependencyReader::Transaction(tx) => capture.read_impact(tx).await,
                        DependencyReader::Snapshot(snapshot) => capture.read_impact_snapshot(snapshot).await }.map_err(crate::query::QueryError::from)?;
                    merge(&mut impact, current);
                }
                let canonical: Vec<_> = witness.derivation.dependencies.iter().filter(|dependency| match dependency {
                    world_protocol::provenance::ReadDependency::Assertion { reference } => !witness.branch_assertions.contains(reference),
                    world_protocol::provenance::ReadDependency::Evidence { reference } => !witness.captured_evidence.contains(reference),
                    world_protocol::provenance::ReadDependency::Identity { .. } => !witness.branch_identities.contains(dependency),
                    world_protocol::provenance::ReadDependency::Source { .. } | world_protocol::provenance::ReadDependency::SourceMapping { .. } => false,
                    _ => true,
                }).cloned().collect();
                let support = record.supports.iter().find(|support| support.reference == witness.support).ok_or_else(invalid)?;
                let current = support::dependency_closure_impact(reader, &canonical, &canonical_model, scope, &support.valid_time, &now).await?;
                if let Some(current) = current { merge(&mut impact, current); }
            }
        }
    }
    normalize_impact(impact)
}
