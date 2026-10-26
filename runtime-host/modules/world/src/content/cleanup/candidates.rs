use serde::{Deserialize, Serialize};
use world_protocol::{
    ids::{ContentId, Digest, WorldRef},
    materials::{BlobRef, MaterialFailure},
};

use super::Recovery;
use crate::{
    content::{DeletionPlan, Error, decode, stable_id},
    store::{WorldSnapshot, WorldTransaction},
};

/// Hints only: every candidate is locked and checked again in its mutation transaction.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CleanupBatch {
    world: WorldRef,
    pub(super) candidates: Vec<Candidate>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Candidate {
    pub blob: BlobRef,
    pub deletion_id: ContentId,
    pub plan: Option<DeletionPlan>,
    pub token: Option<ContentId>,
    pub recovery: Option<Recovery>,
}

impl CleanupBatch {
    pub(crate) fn world(&self) -> &WorldRef {
        &self.world
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.candidates.is_empty()
    }

    pub(crate) fn input_digest(&self) -> Result<Digest, Error> {
        self.validate()?;
        crate::definitions::canonical_digest(self).map_err(|cause| {
            Error::caused(
                MaterialFailure::InputInvalid,
                crate::definitions::DefinitionError::from(cause),
            )
        })
    }

    pub(super) fn validate(&self) -> Result<(), Error> {
        if self.candidates.len() > 32
            || self
                .candidates
                .iter()
                .enumerate()
                .any(|(index, candidate)| {
                    self.candidates[..index].iter().any(|previous| {
                        previous.deletion_id == candidate.deletion_id
                            || previous.blob.digest == candidate.blob.digest
                    }) || candidate.plan.as_ref().is_some_and(|plan| {
                        plan.id != candidate.deletion_id || plan.blob != candidate.blob
                    }) || (candidate.recovery.is_some() && candidate.token.is_none())
                })
        {
            return Err(Error::material(MaterialFailure::InputInvalid));
        }
        Ok(())
    }
}

// No clock predicate: pins are live until explicitly released, and metadata remains a root
// even if its expected Content reference has been damaged or removed.
const AVAILABLE: &str = "SELECT b.digest,b.byte_size,d.deletion_id,d.body,d.claim_token,
    (SELECT entry FROM world_step s CROSS JOIN LATERAL jsonb_array_elements(
        COALESCE(s.body#>'{checkpoint,contentCleanup,entries}','[]'::jsonb)) entry
     WHERE s.tenant_id=b.tenant_id AND s.world_id=b.world_id
       AND s.kind='maintenance.content_cleanup'
       AND entry->>'deletionId'=d.deletion_id AND entry->>'token'=d.claim_token
     ORDER BY (entry->>'started')::boolean DESC,s.run_id,s.step_id LIMIT 1) AS recovery
 FROM world_blob b LEFT JOIN world_content_deletion d
   ON d.tenant_id=b.tenant_id AND d.world_id=b.world_id AND d.blob_digest=b.digest
 WHERE b.tenant_id=$1 AND b.world_id=$2
   AND ((b.state='live' AND d.deletion_id IS NULL)
     OR (d.completed_at IS NULL AND d.remaining=0 AND b.state IN ('live','deleting')))
   AND NOT EXISTS(SELECT 1 FROM world_content_reference r WHERE r.tenant_id=b.tenant_id AND r.world_id=b.world_id AND r.blob_digest=b.digest AND r.released_at IS NULL)
   AND NOT EXISTS(SELECT 1 FROM world_content_hold h WHERE h.tenant_id=b.tenant_id AND h.world_id=b.world_id AND h.blob_digest=b.digest AND h.released_at IS NULL)
   AND NOT EXISTS(SELECT 1 FROM world_blob_pin p WHERE p.tenant_id=b.tenant_id AND p.world_id=b.world_id AND p.digest=b.digest AND p.released_at IS NULL)
   AND NOT EXISTS(SELECT 1 FROM world_source_version v WHERE v.tenant_id=b.tenant_id AND v.world_id=b.world_id AND v.blob_digest=b.digest)
   AND NOT EXISTS(SELECT 1 FROM world_parse_artifact p WHERE p.tenant_id=b.tenant_id AND p.world_id=b.world_id AND p.manifest_digest=b.digest)
   AND NOT EXISTS(SELECT 1 FROM world_archive_manifest a WHERE a.tenant_id=b.tenant_id AND a.world_id=b.world_id AND
       (a.manifest_blob_digest=b.digest OR a.manifest @> jsonb_build_object('blobs',jsonb_build_array(jsonb_build_object('digest',b.digest)))))
 ORDER BY (d.deletion_id IS NULL),b.created_at,b.digest LIMIT $3";

pub(crate) async fn cleanup_candidates(
    snapshot: &WorldSnapshot<'_>,
    maximum: usize,
) -> Result<CleanupBatch, Error> {
    if maximum == 0 || maximum > 32 {
        return Err(Error::material(MaterialFailure::SizeLimit));
    }
    let world = snapshot.world();
    let rows = snapshot
        .query(
            AVAILABLE,
            &[
                &world.tenant_id.as_str(),
                &world.world_id.as_str(),
                &(maximum as i64),
            ],
        )
        .await?;
    let mut candidates = Vec::with_capacity(rows.len());
    for row in rows {
        let blob = BlobRef {
            digest: Digest::try_new(row.get::<_, String>("digest"))
                .map_err(|_| Error::material(MaterialFailure::CorruptContent))?,
            byte_size: u64::try_from(row.get::<_, i64>("byte_size"))
                .map_err(|_| Error::material(MaterialFailure::CorruptContent))?,
        };
        let plan = row
            .get::<_, Option<serde_json::Value>>("body")
            .map(decode::<DeletionPlan>)
            .transpose()?;
        let deletion_id = match row.get::<_, Option<String>>("deletion_id") {
            Some(id) => ContentId::try_new(id)
                .map_err(|_| Error::material(MaterialFailure::CorruptContent))?,
            None => stable_id(&("world.content.unreferenced.v1", world, &blob))?,
        };
        let token = row
            .get::<_, Option<String>>("claim_token")
            .map(ContentId::try_new)
            .transpose()
            .map_err(|_| Error::material(MaterialFailure::CorruptContent))?;
        let recovery = row
            .get::<_, Option<serde_json::Value>>("recovery")
            .map(|value| -> Result<Recovery, Error> {
                let entry: super::Entry = decode(value)?;
                Ok(Recovery {
                    finish: entry.finish,
                    started: entry.started,
                    outcome: entry.outcome,
                })
            })
            .transpose()?;
        candidates.push(Candidate {
            blob,
            deletion_id,
            plan,
            token,
            recovery,
        });
    }
    let batch = CleanupBatch {
        world: world.clone(),
        candidates,
    };
    batch.validate()?;
    Ok(batch)
}

/// Completion is the original deletion's durable outcome, never directory emptiness.
pub(crate) async fn cleanup_batch_finished(
    snapshot: &WorldSnapshot<'_>,
    batch: &CleanupBatch,
) -> Result<bool, Error> {
    batch.validate()?;
    if batch.world() != snapshot.world() {
        return Err(Error::material(MaterialFailure::InputInvalid));
    }
    let world = snapshot.world();
    for candidate in &batch.candidates {
        if snapshot.query_opt(
            "SELECT 1 FROM world_content_deletion d JOIN world_blob b ON b.tenant_id=d.tenant_id AND b.world_id=d.world_id AND b.digest=d.blob_digest WHERE d.tenant_id=$1 AND d.world_id=$2 AND d.deletion_id=$3 AND d.blob_digest=$4 AND b.byte_size=$5 AND d.state='deleted' AND d.completed_at IS NOT NULL AND b.state='deleted'",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &candidate.deletion_id.as_str(),
                &candidate.blob.digest.as_str(), &(candidate.blob.byte_size as i64)],
        ).await?.is_none() {
            return Ok(false);
        }
    }
    Ok(true)
}

pub(super) async fn current_candidate(
    snapshot: &WorldSnapshot<'_>,
    candidate: &Candidate,
) -> Result<Candidate, Error> {
    let world = snapshot.world();
    let mut current = candidate.clone();
    let row = snapshot.query_opt(
        "SELECT d.body,d.claim_token,(SELECT entry FROM world_step s CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.body#>'{checkpoint,contentCleanup,entries}','[]'::jsonb)) entry WHERE s.tenant_id=d.tenant_id AND s.world_id=d.world_id AND s.kind='maintenance.content_cleanup' AND entry->>'deletionId'=d.deletion_id AND entry->>'token'=d.claim_token ORDER BY (entry->>'started')::boolean DESC,s.run_id,s.step_id LIMIT 1) AS recovery FROM world_content_deletion d WHERE d.tenant_id=$1 AND d.world_id=$2 AND d.deletion_id=$3 AND d.blob_digest=$4",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &candidate.deletion_id.as_str(), &candidate.blob.digest.as_str()],
    ).await?;
    if let Some(row) = row {
        let plan: DeletionPlan = decode(row.get("body"))?;
        if plan.id != candidate.deletion_id || plan.blob != candidate.blob {
            return Err(Error::material(MaterialFailure::CorruptContent));
        }
        current.plan = Some(plan);
        current.token = row
            .get::<_, Option<String>>("claim_token")
            .map(ContentId::try_new)
            .transpose()
            .map_err(|_| Error::material(MaterialFailure::CorruptContent))?;
        if let Some(value) = row.get::<_, Option<serde_json::Value>>("recovery") {
            let entry: super::Entry = decode(value)?;
            current.recovery = Some(Recovery {
                finish: entry.finish,
                started: entry.started,
                outcome: entry.outcome,
            });
        }
    }
    Ok(current)
}

pub(super) async fn require_unretained(
    tx: &WorldTransaction<'_>,
    blob: &BlobRef,
) -> Result<(), Error> {
    let world = tx.world();
    let row = tx.query_opt(
        "SELECT byte_size FROM world_blob WHERE tenant_id=$1 AND world_id=$2 AND digest=$3 FOR UPDATE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &blob.digest.as_str()],
    ).await?.ok_or_else(|| Error::material(MaterialFailure::ContentNotFound))?;
    if row.get::<_, i64>("byte_size") as u64 != blob.byte_size {
        return Err(Error::material(MaterialFailure::DigestMismatch));
    }
    let retained = tx
        .query_opt(
            RETAINED,
            &[
                &world.tenant_id.as_str(),
                &world.world_id.as_str(),
                &blob.digest.as_str(),
            ],
        )
        .await?
        .is_some();
    if retained {
        return Err(Error::material(MaterialFailure::RetainedReferences));
    }
    Ok(())
}

pub(in crate::content) async fn require_unretained_snapshot(
    snapshot: &WorldSnapshot<'_>,
    blob: &BlobRef,
) -> Result<(), Error> {
    let world = snapshot.world();
    if snapshot
        .query_opt(
            RETAINED,
            &[
                &world.tenant_id.as_str(),
                &world.world_id.as_str(),
                &blob.digest.as_str(),
            ],
        )
        .await?
        .is_some()
    {
        return Err(Error::material(MaterialFailure::RetainedReferences));
    }
    Ok(())
}

const RETAINED: &str = "SELECT 1 WHERE
 EXISTS(SELECT 1 FROM world_content_reference WHERE tenant_id=$1 AND world_id=$2 AND blob_digest=$3 AND released_at IS NULL)
 OR EXISTS(SELECT 1 FROM world_content_hold WHERE tenant_id=$1 AND world_id=$2 AND blob_digest=$3 AND released_at IS NULL)
 OR EXISTS(SELECT 1 FROM world_blob_pin WHERE tenant_id=$1 AND world_id=$2 AND digest=$3 AND released_at IS NULL)
 OR EXISTS(SELECT 1 FROM world_source_version WHERE tenant_id=$1 AND world_id=$2 AND blob_digest=$3)
 OR EXISTS(SELECT 1 FROM world_parse_artifact WHERE tenant_id=$1 AND world_id=$2 AND manifest_digest=$3)
 OR EXISTS(SELECT 1 FROM world_archive_manifest WHERE tenant_id=$1 AND world_id=$2 AND
   (manifest_blob_digest=$3 OR manifest @> jsonb_build_object('blobs',jsonb_build_array(jsonb_build_object('digest',$3::text)))))";
