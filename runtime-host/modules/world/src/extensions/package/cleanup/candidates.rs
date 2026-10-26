use serde::{Deserialize, Serialize};
use world_protocol::{
    authorization::{AccessMode, AccessScope, ActualImpact},
    ids::{Digest, InstallId, ResourceRef, WorldRef},
    package::PackageFailure,
};

use super::{invalid, retained};
use crate::{
    authorization, owner,
    store::{WorldSnapshot, WorldTransaction},
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PackageCleanupBatch {
    world: WorldRef,
    pub(super) candidates: Vec<Candidate>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Candidate {
    pub package: Digest,
    pub transport: Digest,
    pub generation: i64,
    pub token: Option<String>,
    pub installs: Vec<InstallId>,
}

impl PackageCleanupBatch {
    pub(crate) fn world(&self) -> &WorldRef {
        &self.world
    }
    pub(crate) fn is_empty(&self) -> bool {
        self.candidates.is_empty()
    }
    pub(crate) fn input_digest(&self) -> Result<Digest, owner::Error> {
        self.validate()?;
        Ok(crate::definitions::canonical_digest(self)?)
    }
    pub(super) fn validate(&self) -> Result<(), owner::Error> {
        if self.candidates.len() > 32
            || self
                .candidates
                .iter()
                .enumerate()
                .any(|(index, candidate)| {
                    candidate.generation <= 1
                        || candidate.installs.is_empty()
                        || candidate.installs.windows(2).any(|pair| pair[0] >= pair[1])
                        || candidate.token.as_ref().is_some_and(|token| {
                            token.is_empty()
                                || token.len() > 128
                                || token.chars().any(char::is_control)
                        })
                        || self.candidates[..index]
                            .iter()
                            .any(|previous| previous.package == candidate.package)
                })
        {
            return Err(invalid());
        }
        Ok(())
    }
    pub(crate) fn retention_roots(
        &self,
        roots: &mut crate::store::RetentionRoots,
    ) -> Result<(), owner::Error> {
        self.validate()?;
        roots.resources.extend(
            self.candidates
                .iter()
                .flat_map(|candidate| candidate.installs.iter().cloned())
                .map(|id| ResourceRef::Package { id }),
        );
        Ok(())
    }
}

pub(crate) async fn cleanup_candidates(
    snapshot: &WorldSnapshot<'_>,
    maximum: usize,
) -> Result<PackageCleanupBatch, owner::Error> {
    if maximum == 0 || maximum > 32 {
        return Err(invalid());
    }
    let world = snapshot.world();
    let rows = snapshot.query("SELECT g.package_digest,p.transport_digest,g.generation,g.state,g.claim_token,ARRAY(SELECT i.install_id FROM world_package_install i WHERE i.tenant_id=g.tenant_id AND i.world_id=g.world_id AND i.package_digest=g.package_digest ORDER BY i.install_id) AS installs FROM world_package_gc g JOIN world_package p USING(tenant_id,world_id,package_digest) WHERE g.tenant_id=$1 AND g.world_id=$2 AND g.state IN('live','claimed','pending_removal') AND NOT EXISTS(SELECT 1 FROM world_package_install i WHERE i.tenant_id=g.tenant_id AND i.world_id=g.world_id AND i.package_digest=g.package_digest AND i.phase='installed') AND NOT EXISTS(SELECT 1 FROM world_package_retention r WHERE r.tenant_id=g.tenant_id AND r.world_id=g.world_id AND r.package_digest=g.package_digest AND r.released_at IS NULL) ORDER BY (g.state='live'),g.package_digest LIMIT $3",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &(maximum as i64)]).await?;
    let mut candidates = Vec::with_capacity(rows.len());
    for row in rows {
        let generation: i64 = row.get("generation");
        let generation = if row.get::<_, String>("state") == "live" {
            generation.checked_add(1).ok_or_else(invalid)?
        } else {
            generation
        };
        candidates.push(Candidate {
            package: Digest::try_new(row.get::<_, String>("package_digest"))
                .map_err(|_| invalid())?,
            transport: Digest::try_new(row.get::<_, String>("transport_digest"))
                .map_err(|_| invalid())?,
            generation,
            token: row.get("claim_token"),
            installs: row
                .get::<_, Vec<String>>("installs")
                .into_iter()
                .map(|id| InstallId::try_new(id).map_err(|_| invalid()))
                .collect::<Result<_, _>>()?,
        });
    }
    let batch = PackageCleanupBatch {
        world: world.clone(),
        candidates,
    };
    batch.validate()?;
    Ok(batch)
}

pub(crate) async fn cleanup_impact(
    tx: &WorldTransaction<'_>,
    batch: &PackageCleanupBatch,
) -> Result<ActualImpact, owner::Error> {
    batch.validate()?;
    if batch.world() != tx.world() {
        return Err(invalid());
    }
    let mut resources = Vec::new();
    for candidate in &batch.candidates {
        if super::super::authority::package_installs(tx, &candidate.package).await?
            != candidate.installs
        {
            return Err(retained());
        }
        resources.extend(
            candidate
                .installs
                .iter()
                .cloned()
                .map(|id| ResourceRef::Package { id }),
        );
    }
    resources.sort();
    resources.dedup();
    Ok(authorization::actual_impact(
        vec![AccessScope {
            resources,
            fields: Vec::new(),
            modes: vec![AccessMode::Delete],
            scope: owner::management_scope(tx).await?,
            valid_time: None,
        }],
        Vec::new(),
        Vec::new(),
        Vec::new(),
        Vec::new(),
    )?)
}

pub(crate) async fn cleanup_batch_finished(
    snapshot: &WorldSnapshot<'_>,
    batch: &PackageCleanupBatch,
) -> Result<bool, owner::Error> {
    batch.validate()?;
    if batch.world() != snapshot.world() {
        return Err(invalid());
    }
    let world = snapshot.world();
    for candidate in &batch.candidates {
        if snapshot.query_opt("SELECT 1 FROM world_package_gc g JOIN world_package p USING(tenant_id,world_id,package_digest) WHERE g.tenant_id=$1 AND g.world_id=$2 AND g.package_digest=$3 AND p.transport_digest=$4 AND g.generation=$5 AND g.state='removed' AND g.claim_token IS NOT NULL AND ($6::text IS NULL OR g.claim_token=$6) AND EXISTS(SELECT 1 FROM world_step s CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.body#>'{checkpoint,packageCleanup,entries}','[]'::jsonb)) entry JOIN world_commit_receipt c ON c.tenant_id=s.tenant_id AND c.world_id=s.world_id AND c.commit_id=entry#>>'{finish,commit_id}' AND c.input_digest=entry#>>'{finish,input_digest}' WHERE s.tenant_id=g.tenant_id AND s.world_id=g.world_id AND s.kind='maintenance.package_cleanup' AND entry->>'package'=g.package_digest AND entry->>'token'=g.claim_token AND (entry->>'generation')::bigint=g.generation AND c.committed_at IS NOT NULL AND c.result->>'kind'='removed')",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &candidate.package.as_str(), &candidate.transport.as_str(), &candidate.generation, &candidate.token]).await?.is_none() { return Ok(false); }
    }
    Ok(true)
}

pub(super) async fn require_unretained(
    tx: &WorldTransaction<'_>,
    candidate: &Candidate,
) -> Result<(), owner::Error> {
    let world = tx.world();
    if tx.query_opt("SELECT 1 FROM world_package_retention WHERE tenant_id=$1 AND world_id=$2 AND package_digest=$3 AND released_at IS NULL LIMIT 1",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &candidate.package.as_str()]).await?.is_some()
        || tx.query_opt("SELECT 1 FROM world_package_install WHERE tenant_id=$1 AND world_id=$2 AND package_digest=$3 AND phase='installed' LIMIT 1",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &candidate.package.as_str()]).await?.is_some() {
        return Err(super::super::PackageError::new(PackageFailure::RetainedReferences).into());
    }
    Ok(())
}
