use serde::{Deserialize, Serialize};
use world_protocol::{
    ids::{
        ActorId, ArtifactId, BranchId, CaseId, ContentId, Digest, EvaluationId, EvidenceId,
        Generation, MigrationId, ParseArtifactId, ReleaseId, Revision, RunId, StateRef, SuiteId,
        TestCaseId, TransferId, WorldRef,
    },
    materials::{BlobRef, MaterialFailure, SourceVersionRef},
};

use super::{Error, PreparedBlob, decode, encode, stable_id};
use crate::store::{OutboxEvent, WorldTransaction};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum ContentOwner {
    SourceVersion { reference: SourceVersionRef },
    ParseArtifact { id: ParseArtifactId },
    Evidence { id: EvidenceId, revision: Revision },
    Artifact { id: ArtifactId },
    Release { id: ReleaseId },
    Run { id: RunId },
    Branch { id: BranchId },
    Evaluation { id: EvaluationId },
    Case { id: CaseId },
    TestCase { id: TestCaseId, revision: Revision },
    Suite { id: SuiteId, revision: Revision },
    Attachment { id: ContentId },
    State { reference: StateRef },
    Migration { id: MigrationId },
    Upload { transfer_id: TransferId },
    Backup { digest: Digest },
}

impl ContentOwner {
    pub(super) fn check_world(&self, world: &WorldRef) -> Result<(), Error> {
        let owner_world = match self {
            Self::SourceVersion { reference } => Some(&reference.world),
            Self::State { reference } => Some(&reference.world),
            _ => None,
        };
        if owner_world.is_some_and(|owner_world| owner_world != world) {
            return Err(Error::material(MaterialFailure::InputInvalid));
        }
        Ok(())
    }

    fn columns(&self) -> Result<(&'static str, String, i64), Error> {
        let (kind, id, revision) = match self {
            Self::SourceVersion { reference } => {
                ("source_version", stable_id(reference)?.to_string(), 0)
            }
            Self::ParseArtifact { id } => ("parse_artifact", id.to_string(), 0),
            Self::Evidence { id, revision } => ("evidence", id.to_string(), revision.0),
            Self::Artifact { id } => ("artifact", id.to_string(), 0),
            Self::Release { id } => ("release", id.to_string(), 0),
            Self::Run { id } => ("run", id.to_string(), 0),
            Self::Branch { id } => ("branch", id.to_string(), 0),
            Self::Evaluation { id } => ("evaluation", id.to_string(), 0),
            Self::Case { id } => ("case", id.to_string(), 0),
            Self::TestCase { id, revision } => ("test_case", id.to_string(), revision.0),
            Self::Suite { id, revision } => ("suite", id.to_string(), revision.0),
            Self::Attachment { id } => ("attachment", id.to_string(), 0),
            Self::State { reference } => ("state", reference.id.to_string(), reference.revision.0),
            Self::Migration { id } => ("migration", id.to_string(), 0),
            Self::Upload { transfer_id } => ("upload", transfer_id.to_string(), 0),
            Self::Backup { digest } => ("backup", digest.to_string(), 0),
        };
        Ok((
            kind,
            id,
            i64::try_from(revision).map_err(|_| Error::material(MaterialFailure::InputInvalid))?,
        ))
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ContentReference {
    id: ContentId,
    pub owner: ContentOwner,
    pub blob: BlobRef,
}
impl ContentReference {
    pub(crate) fn new(owner: ContentOwner, blob: BlobRef) -> Result<Self, Error> {
        let id = stable_id(&(&owner, &blob))?;
        Ok(Self { id, owner, blob })
    }
    pub(crate) fn id(&self) -> &ContentId {
        &self.id
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PinKind {
    Upload,
    Read,
    Recovery,
    Backup,
    Transfer,
}
impl PinKind {
    fn name(self) -> &'static str {
        match self {
            Self::Upload => "upload",
            Self::Read => "read",
            Self::Recovery => "recovery",
            Self::Backup => "backup",
            Self::Transfer => "transfer",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BlobPin {
    pub(super) world: WorldRef,
    pub(super) blob: BlobRef,
    pub(super) id: ContentId,
    pub(super) owner: ContentOwner,
    pub(super) generation: Generation,
    pub(super) kind: PinKind,
}

impl BlobPin {
    pub(crate) fn reference(&self) -> &BlobRef {
        &self.blob
    }

    pub(crate) fn matches_recovery_run(
        &self,
        world: &WorldRef,
        run: &RunId,
        blob: &BlobRef,
        pin_id: &ContentId,
    ) -> bool {
        &self.world == world
            && self.owner == (ContentOwner::Run { id: run.clone() })
            && self.kind == PinKind::Recovery
            && &self.blob == blob
            && &self.id == pin_id
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RetentionHold {
    pub id: ContentId,
    pub blob: BlobRef,
    pub owner: ContentOwner,
    pub kind: HoldKind,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum HoldKind {
    Legal,
    Recovery,
    Backup,
}
impl HoldKind {
    fn name(self) -> &'static str {
        match self {
            Self::Legal => "legal",
            Self::Recovery => "recovery",
            Self::Backup => "backup",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CleanupOwner {
    Content,
    Facts,
    Materials,
    Query,
    Context,
    Compiler,
    Releases,
    Actions,
    Learning,
    Evaluation,
    Attachments,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CleanupTarget {
    pub owner: CleanupOwner,
    pub resource: ContentOwner,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DeletionReason {
    Unreferenced,
    RetentionExpired,
    UserRemoval,
    PrivacyErasure,
}
impl DeletionReason {
    fn name(self) -> &'static str {
        match self {
            Self::Unreferenced => "unreferenced",
            Self::RetentionExpired => "retention_expired",
            Self::UserRemoval => "user_removal",
            Self::PrivacyErasure => "privacy_erasure",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeletionPlan {
    pub id: ContentId,
    pub blob: BlobRef,
    pub actor: ActorId,
    pub reason: DeletionReason,
    pub cleanup_targets: Vec<CleanupTarget>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeletionClaim {
    pub(super) world: WorldRef,
    pub(super) blob: BlobRef,
    deletion_id: ContentId,
    token: ContentId,
    generation: Generation,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DeletionState {
    Barrier,
    Claimed,
    Failed,
    Deleted,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeletionStatus {
    pub plan: DeletionPlan,
    pub state: DeletionState,
    pub revision: Revision,
    pub remaining: u32,
    pub acknowledgements: Vec<CleanupTarget>,
    pub claim_token: Option<ContentId>,
    pub generation: Generation,
    pub failure_code: Option<String>,
    pub failure_stage: Option<String>,
}

/// A snapshot is a recovery hint, never permission to perform physical cleanup.
pub(crate) async fn read_deletion(
    snapshot: &crate::store::WorldSnapshot<'_>,
    id: &ContentId,
) -> Result<DeletionStatus, Error> {
    let world = snapshot.world();
    let row = snapshot.query_opt(
        "SELECT d.body,d.state,d.revision,d.remaining,d.cleanup_acks,d.claim_token,d.failure_code,d.failure_stage,b.generation FROM world_content_deletion d JOIN world_blob b ON b.tenant_id=d.tenant_id AND b.world_id=d.world_id AND b.digest=d.blob_digest WHERE d.tenant_id=$1 AND d.world_id=$2 AND d.deletion_id=$3",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str()],
    ).await?.ok_or_else(|| Error::material(MaterialFailure::ContentNotFound))?;
    deletion_status(&row)
}

/// Bounded startup reconciliation includes Windows tombstones and failed/unknown physical cleanup.
pub(crate) async fn pending_deletions(
    snapshot: &crate::store::WorldSnapshot<'_>,
    maximum: usize,
) -> Result<Vec<DeletionStatus>, Error> {
    if maximum == 0 || maximum > 4096 {
        return Err(Error::material(MaterialFailure::SizeLimit));
    }
    let world = snapshot.world();
    let rows = snapshot.query(
        "SELECT d.body,d.state,d.revision,d.remaining,d.cleanup_acks,d.claim_token,d.failure_code,d.failure_stage,b.generation FROM world_content_deletion d JOIN world_blob b ON b.tenant_id=d.tenant_id AND b.world_id=d.world_id AND b.digest=d.blob_digest WHERE d.tenant_id=$1 AND d.world_id=$2 AND d.completed_at IS NULL ORDER BY d.created_at,d.deletion_id LIMIT $3",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &(maximum as i64)],
    ).await?;
    rows.iter().map(deletion_status).collect()
}

fn deletion_status(row: &tokio_postgres::Row) -> Result<DeletionStatus, Error> {
    let invalid = || Error::material(MaterialFailure::CorruptContent);
    let state = match row.get::<_, String>("state").as_str() {
        "barrier" => DeletionState::Barrier,
        "claimed" => DeletionState::Claimed,
        "failed" => DeletionState::Failed,
        "deleted" => DeletionState::Deleted,
        _ => return Err(invalid()),
    };
    let claim_token = row
        .get::<_, Option<String>>("claim_token")
        .map(ContentId::try_new)
        .transpose()
        .map_err(|_| invalid())?;
    Ok(DeletionStatus {
        plan: decode(row.get("body"))?,
        state,
        revision: Revision(u64::try_from(row.get::<_, i64>("revision")).map_err(|_| invalid())?),
        remaining: u32::try_from(row.get::<_, i32>("remaining")).map_err(|_| invalid())?,
        acknowledgements: decode(row.get("cleanup_acks"))?,
        claim_token,
        generation: Generation(
            u64::try_from(row.get::<_, i64>("generation")).map_err(|_| invalid())?,
        ),
        failure_code: row.get("failure_code"),
        failure_stage: row.get("failure_stage"),
    })
}

pub(super) async fn register_blob(
    content: &super::Content,
    transaction: &WorldTransaction<'_>,
    prepared: &PreparedBlob,
) -> Result<(), Error> {
    if transaction.world() != &prepared.world {
        return Err(Error::material(MaterialFailure::InputInvalid));
    }
    let world = transaction.world();
    let byte_size = i64::try_from(prepared.reference.byte_size)
        .map_err(|_| Error::material(MaterialFailure::SizeLimit))?;
    transaction.execute(
        "INSERT INTO world_blob(tenant_id,world_id,digest,byte_size) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &prepared.reference.digest.as_str(), &byte_size],
    ).await?;
    lock_live_blob(transaction, &prepared.reference).await?;
    content.blobs.publish_prepared(&prepared.staged)?;
    Ok(())
}

pub(super) async fn lock_live_blob(
    transaction: &WorldTransaction<'_>,
    blob: &BlobRef,
) -> Result<Generation, Error> {
    let world = transaction.world();
    let row = transaction.query_opt(
        "SELECT byte_size,state,generation FROM world_blob WHERE tenant_id=$1 AND world_id=$2 AND digest=$3 FOR UPDATE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &blob.digest.as_str()],
    ).await?.ok_or_else(|| Error::material(MaterialFailure::ContentNotFound))?;
    if row.get::<_, i64>("byte_size") as u64 != blob.byte_size {
        return Err(Error::material(MaterialFailure::DigestMismatch));
    }
    if row.get::<_, String>("state") != "live" {
        return Err(Error::material(MaterialFailure::Deleted));
    }
    if transaction.query_opt(
        "SELECT 1 FROM world_content_deletion WHERE tenant_id=$1 AND world_id=$2 AND blob_digest=$3 LIMIT 1",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &blob.digest.as_str()],
    ).await?.is_some() { return Err(Error::material(MaterialFailure::Deleted)); }
    Ok(Generation(row.get::<_, i64>("generation") as u64))
}

pub(crate) async fn retain(
    transaction: &WorldTransaction<'_>,
    reference: &ContentReference,
) -> Result<(), Error> {
    let world = transaction.world();
    reference.owner.check_world(world)?;
    lock_live_blob(transaction, &reference.blob).await?;
    let body = encode(reference)?;
    let (kind, owner_id, revision) = reference.owner.columns()?;
    let existing = transaction.query_opt(
        "SELECT body,released_at IS NOT NULL AS released FROM world_content_reference WHERE tenant_id=$1 AND world_id=$2 AND reference_id=$3",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &reference.id.as_str()],
    ).await?;
    if let Some(existing) = existing {
        if existing.get::<_, bool>("released")
            || existing.get::<_, serde_json::Value>("body") != body
        {
            return Err(Error::material(MaterialFailure::InputInvalid));
        }
        return Ok(());
    }
    transaction.execute(
        "INSERT INTO world_content_reference(tenant_id,world_id,reference_id,referrer_kind,referrer_id,referrer_revision,blob_digest,purpose,body) VALUES($1,$2,$3,$4,$5,$6,$7,'content',$8)",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &reference.id.as_str(), &kind, &owner_id, &revision, &reference.blob.digest.as_str(), &body],
    ).await?;
    Ok(())
}

/// A durable deletion barrier, not a missing file or caller-supplied status, authorizes cleanup.
pub(crate) async fn require_source_deletion(
    transaction: &WorldTransaction<'_>,
    reference: &SourceVersionRef,
) -> Result<(), Error> {
    if transaction.world() != &reference.world {
        return Err(Error::material(MaterialFailure::InputInvalid));
    }
    let world = transaction.world();
    let row = transaction.query_opt(
        "SELECT b.state FROM world_source_version s JOIN world_blob b ON b.tenant_id=s.tenant_id AND b.world_id=s.world_id AND b.digest=s.blob_digest WHERE s.tenant_id=$1 AND s.world_id=$2 AND s.source_id=$3 AND s.version_id=$4 AND EXISTS(SELECT 1 FROM world_content_deletion d WHERE d.tenant_id=b.tenant_id AND d.world_id=b.world_id AND d.blob_digest=b.digest) FOR UPDATE OF b",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &reference.source_id.as_str(), &reference.version_id.as_str()],
    ).await?;
    if row.is_none() {
        return Err(Error::material(MaterialFailure::RetentionDenied));
    }
    Ok(())
}

/// Requires the exact durable cleanup recipient, not only a blob-wide denial of future reads.
pub(crate) async fn require_source_cleanup(
    transaction: &WorldTransaction<'_>,
    reference: &SourceVersionRef,
    target: &CleanupTarget,
) -> Result<ContentId, Error> {
    require_source_deletion(transaction, reference).await?;
    let world = transaction.world();
    let row = transaction.query_opt(
        "SELECT d.deletion_id,d.cleanup_targets FROM world_source_version s JOIN world_content_deletion d ON d.tenant_id=s.tenant_id AND d.world_id=s.world_id AND d.blob_digest=s.blob_digest WHERE s.tenant_id=$1 AND s.world_id=$2 AND s.source_id=$3 AND s.version_id=$4",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &reference.source_id.as_str(), &reference.version_id.as_str()],
    ).await?.ok_or_else(|| Error::material(MaterialFailure::RetentionDenied))?;
    let targets: Vec<CleanupTarget> = decode(row.get("cleanup_targets"))?;
    if !targets.contains(target) {
        return Err(Error::material(MaterialFailure::RetentionDenied));
    }
    ContentId::try_new(row.get::<_, String>("deletion_id"))
        .map_err(|cause| Error::caused(MaterialFailure::CorruptContent, cause))
}

/// Includes all historical revisions sharing the owner's stable identity; domain owners never query content tables.
pub(crate) async fn owner_references(
    transaction: &WorldTransaction<'_>,
    owner: &ContentOwner,
) -> Result<Vec<ContentReference>, Error> {
    let world = transaction.world();
    let (kind, id, _) = owner.columns()?;
    let rows = transaction.query(
        "SELECT body FROM world_content_reference WHERE tenant_id=$1 AND world_id=$2 AND referrer_kind=$3 AND referrer_id=$4 AND released_at IS NULL ORDER BY blob_digest,reference_id LIMIT 65537",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &kind, &id],
    ).await?;
    if rows.len() > 65_536 {
        return Err(Error::material(MaterialFailure::SizeLimit));
    }
    rows.into_iter()
        .map(|row| decode(row.get("body")))
        .collect()
}

/// References can be released behind a deletion barrier; no release may resurrect a record.
pub(crate) async fn release_reference(
    transaction: &WorldTransaction<'_>,
    reference: &ContentReference,
) -> Result<(), Error> {
    let world = transaction.world();
    let changed = transaction.execute(
        "UPDATE world_content_reference SET released_at=COALESCE(released_at,clock_timestamp()) WHERE tenant_id=$1 AND world_id=$2 AND reference_id=$3 AND body=$4",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &reference.id.as_str(), &encode(reference)?],
    ).await?;
    if changed != 1 {
        return Err(Error::material(MaterialFailure::ContentNotFound));
    }
    Ok(())
}

pub(crate) async fn pin(
    transaction: &WorldTransaction<'_>,
    reference: &ContentReference,
    id: ContentId,
    kind: PinKind,
) -> Result<BlobPin, Error> {
    let world = transaction.world();
    let generation = lock_live_blob(transaction, &reference.blob).await?;
    let row = transaction.query_opt(
        "SELECT body FROM world_content_reference WHERE tenant_id=$1 AND world_id=$2 AND reference_id=$3 AND released_at IS NULL FOR UPDATE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &reference.id.as_str()],
    ).await?.ok_or_else(|| Error::material(MaterialFailure::ContentNotFound))?;
    if row.get::<_, serde_json::Value>("body") != encode(reference)? {
        return Err(Error::material(MaterialFailure::InputInvalid));
    }
    pin_registered(
        transaction,
        &reference.blob,
        reference.owner.clone(),
        id,
        kind,
        generation,
    )
    .await
}

pub(super) async fn pin_registered(
    transaction: &WorldTransaction<'_>,
    blob: &BlobRef,
    owner: ContentOwner,
    id: ContentId,
    kind: PinKind,
    generation: Generation,
) -> Result<BlobPin, Error> {
    let world = transaction.world();
    owner.check_world(world)?;
    let pin = BlobPin {
        world: world.clone(),
        blob: blob.clone(),
        id,
        owner,
        generation,
        kind,
    };
    let owner_id = stable_id(&pin.owner)?.to_string();
    let generation = generation.0 as i64;
    transaction.execute(
        "INSERT INTO world_blob_pin(tenant_id,world_id,digest,pin_id,kind,owner_id,generation) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &pin.blob.digest.as_str(), &pin.id.as_str(), &kind.name(), &owner_id, &generation],
    ).await?;
    validate_pin(transaction, &pin).await?;
    Ok(pin)
}

pub(crate) async fn validate_pin(
    transaction: &WorldTransaction<'_>,
    pin: &BlobPin,
) -> Result<(), Error> {
    if transaction.world() != &pin.world {
        return Err(Error::material(MaterialFailure::InputInvalid));
    }
    let world = transaction.world();
    lock_live_blob(transaction, &pin.blob).await?;
    let row = transaction.query_opt(
        "SELECT generation,owner_id,kind FROM world_blob_pin WHERE tenant_id=$1 AND world_id=$2 AND digest=$3 AND pin_id=$4 AND released_at IS NULL FOR UPDATE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &pin.blob.digest.as_str(), &pin.id.as_str()],
    ).await?.ok_or_else(|| Error::material(MaterialFailure::ContentNotFound))?;
    if row.get::<_, i64>("generation") as u64 != pin.generation.0
        || row.get::<_, String>("owner_id") != stable_id(&pin.owner)?.as_str()
        || row.get::<_, String>("kind") != pin.kind.name()
    {
        return Err(Error::material(MaterialFailure::InputInvalid));
    }
    Ok(())
}

pub(super) async fn validate_pin_snapshot(
    snapshot: &crate::store::WorldSnapshot<'_>,
    pin: &BlobPin,
) -> Result<(), Error> {
    if snapshot.world() != &pin.world {
        return Err(Error::material(MaterialFailure::InputInvalid));
    }
    let world = snapshot.world();
    let row = snapshot.query_opt(
        "SELECT b.byte_size,b.state,b.generation AS blob_generation,p.generation,p.owner_id,p.kind,p.released_at IS NOT NULL AS released,EXISTS(SELECT 1 FROM world_content_deletion d WHERE d.tenant_id=b.tenant_id AND d.world_id=b.world_id AND d.blob_digest=b.digest) AS barred FROM world_blob b JOIN world_blob_pin p ON p.tenant_id=b.tenant_id AND p.world_id=b.world_id AND p.digest=b.digest WHERE b.tenant_id=$1 AND b.world_id=$2 AND b.digest=$3 AND p.pin_id=$4",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &pin.blob.digest.as_str(), &pin.id.as_str()],
    ).await?.ok_or_else(|| Error::material(MaterialFailure::ContentNotFound))?;
    if row.get::<_, String>("state") != "live" || row.get::<_, bool>("barred") {
        return Err(Error::material(MaterialFailure::Deleted));
    }
    if row.get::<_, bool>("released") {
        return Err(Error::material(MaterialFailure::ContentNotFound));
    }
    if row.get::<_, i64>("byte_size") as u64 != pin.blob.byte_size
        || row.get::<_, i64>("blob_generation") as u64 != pin.generation.0
        || row.get::<_, i64>("generation") as u64 != pin.generation.0
        || row.get::<_, String>("owner_id") != stable_id(&pin.owner)?.as_str()
        || row.get::<_, String>("kind") != pin.kind.name()
    {
        return Err(Error::material(MaterialFailure::InputInvalid));
    }
    Ok(())
}

pub(crate) async fn release_pin(
    transaction: &WorldTransaction<'_>,
    pin: &BlobPin,
) -> Result<(), Error> {
    if transaction.world() != &pin.world {
        return Err(Error::material(MaterialFailure::InputInvalid));
    }
    let world = transaction.world();
    let changed = transaction.execute(
        "UPDATE world_blob_pin SET released_at=COALESCE(released_at,clock_timestamp()) WHERE tenant_id=$1 AND world_id=$2 AND digest=$3 AND pin_id=$4 AND generation=$5 AND owner_id=$6 AND kind=$7",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &pin.blob.digest.as_str(), &pin.id.as_str(), &(pin.generation.0 as i64), &stable_id(&pin.owner)?.as_str(), &pin.kind.name()],
    ).await?;
    if changed != 1 {
        return Err(Error::material(MaterialFailure::ContentNotFound));
    }
    Ok(())
}

pub(crate) async fn hold(
    transaction: &WorldTransaction<'_>,
    hold: &RetentionHold,
) -> Result<(), Error> {
    hold.owner.check_world(transaction.world())?;
    lock_live_blob(transaction, &hold.blob).await?;
    let world = transaction.world();
    let (owner_kind, owner_id, _) = hold.owner.columns()?;
    let body = encode(hold)?;
    let previous = transaction.query_opt(
        "SELECT body,released_at IS NOT NULL AS released FROM world_content_hold WHERE tenant_id=$1 AND world_id=$2 AND hold_id=$3",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &hold.id.as_str()],
    ).await?;
    if let Some(previous) = previous {
        if previous.get::<_, bool>("released")
            || previous.get::<_, serde_json::Value>("body") != body
        {
            return Err(Error::material(MaterialFailure::InputInvalid));
        }
        return Ok(());
    }
    transaction.execute(
        "INSERT INTO world_content_hold(tenant_id,world_id,hold_id,blob_digest,kind,owner_kind,owner_id,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &hold.id.as_str(), &hold.blob.digest.as_str(), &hold.kind.name(), &owner_kind, &owner_id, &body],
    ).await?;
    Ok(())
}

pub(crate) async fn release_hold(
    transaction: &WorldTransaction<'_>,
    hold: &RetentionHold,
) -> Result<(), Error> {
    let world = transaction.world();
    let changed = transaction.execute(
        "UPDATE world_content_hold SET released_at=COALESCE(released_at,clock_timestamp()) WHERE tenant_id=$1 AND world_id=$2 AND hold_id=$3 AND body=$4",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &hold.id.as_str(), &encode(hold)?],
    ).await?;
    if changed != 1 {
        return Err(Error::material(MaterialFailure::ContentNotFound));
    }
    Ok(())
}

/// Caller has already admitted this plan under current authorization and retention policy.
/// Barrier + outbox notifications commit together; this does not claim bytes were erased.
pub(crate) async fn begin_deletion(
    transaction: &mut WorldTransaction<'_>,
    plan: &DeletionPlan,
) -> Result<(), Error> {
    if plan.cleanup_targets.len() > 4096
        || plan
            .cleanup_targets
            .iter()
            .enumerate()
            .any(|(index, target)| plan.cleanup_targets[..index].contains(target))
    {
        return Err(Error::material(MaterialFailure::InputInvalid));
    }
    let world = transaction.world().clone();
    let body = encode(plan)?;
    let previous = transaction.query_opt(
        "SELECT body FROM world_content_deletion WHERE tenant_id=$1 AND world_id=$2 AND deletion_id=$3",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &plan.id.as_str()],
    ).await?;
    if let Some(previous) = previous {
        if previous.get::<_, serde_json::Value>("body") != body {
            return Err(Error::material(MaterialFailure::InputInvalid));
        }
        return Ok(());
    }
    lock_live_blob(transaction, &plan.blob).await?;
    let held = transaction.query_opt(
        "SELECT 1 FROM world_content_hold WHERE tenant_id=$1 AND world_id=$2 AND blob_digest=$3 AND released_at IS NULL LIMIT 1",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &plan.blob.digest.as_str()],
    ).await?.is_some();
    if held {
        return Err(Error::material(MaterialFailure::RetainedReferences));
    }
    let references = transaction.query(
        "SELECT body FROM world_content_reference WHERE tenant_id=$1 AND world_id=$2 AND blob_digest=$3 AND released_at IS NULL ORDER BY reference_id LIMIT 65537",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &plan.blob.digest.as_str()],
    ).await?;
    if references.len() > 65_536 {
        return Err(Error::material(MaterialFailure::SizeLimit));
    }
    for row in references {
        let reference: ContentReference = decode(row.get("body"))?;
        if !plan.cleanup_targets.iter().any(|target| {
            target.resource == reference.owner
                && (!matches!(
                    reference.owner,
                    ContentOwner::SourceVersion { .. } | ContentOwner::ParseArtifact { .. }
                ) || target.owner == CleanupOwner::Content)
        }) {
            return Err(Error::material(MaterialFailure::RetainedReferences));
        }
    }
    let targets = encode(&plan.cleanup_targets)?;
    transaction.execute(
        "INSERT INTO world_content_deletion(tenant_id,world_id,deletion_id,blob_digest,revision,state,actor_id,reason_code,body,cleanup_targets,cleanup_acks,remaining) VALUES($1,$2,$3,$4,1,'barrier',$5,$6,$7,$8,'[]'::jsonb,$9)",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &plan.id.as_str(), &plan.blob.digest.as_str(), &plan.actor.as_str(), &plan.reason.name(), &body, &targets, &(plan.cleanup_targets.len() as i32)],
    ).await?;
    for (index, target) in plan.cleanup_targets.iter().enumerate() {
        let event_id = world_protocol::ids::EventId::try_new(format!(
            "content-{}-{index}",
            stable_id(&(&plan.id, &plan.blob))?
        ))
        .expect("bounded cleanup event identifier");
        transaction
            .emit(OutboxEvent {
                event_id,
                aggregate_kind: "content_deletion".into(),
                aggregate_id: plan.id.to_string(),
                aggregate_revision: 1,
                event_kind: "content.cleanup_requested".into(),
                payload: encode(&(plan.id.clone(), plan.blob.clone(), target))?,
                causation_id: None,
                origin: "world.content".into(),
            })
            .await?;
    }
    Ok(())
}

/// Retires content-owned source/parse references only after their approved cleanup target is durable.
pub(crate) async fn cleanup_owner(
    transaction: &WorldTransaction<'_>,
    deletion: &ContentId,
    owner: &ContentOwner,
) -> Result<(), Error> {
    if !matches!(
        owner,
        ContentOwner::SourceVersion { .. } | ContentOwner::ParseArtifact { .. }
    ) {
        return Err(Error::material(MaterialFailure::InputInvalid));
    }
    let world = transaction.world();
    let row = transaction.query_opt(
        "SELECT body,cleanup_targets FROM world_content_deletion WHERE tenant_id=$1 AND world_id=$2 AND deletion_id=$3 FOR UPDATE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &deletion.as_str()],
    ).await?.ok_or_else(|| Error::material(MaterialFailure::ContentNotFound))?;
    let plan: DeletionPlan = decode(row.get("body"))?;
    let targets: Vec<CleanupTarget> = decode(row.get("cleanup_targets"))?;
    let target = CleanupTarget {
        owner: CleanupOwner::Content,
        resource: owner.clone(),
    };
    if !targets.contains(&target) {
        return Err(Error::material(MaterialFailure::RetentionDenied));
    }
    let references = owner_references(transaction, owner).await?;
    if references.is_empty() {
        return acknowledge_cleanup(transaction, deletion, &target).await;
    }
    if !references
        .iter()
        .any(|reference| reference.blob == plan.blob)
    {
        return Err(Error::material(MaterialFailure::RetentionDenied));
    }
    for reference in references {
        release_reference(transaction, &reference).await?;
    }
    acknowledge_cleanup(transaction, deletion, &target).await
}

/// Only the acknowledged owner's trusted worker invokes this after clearing its derived data/references.
pub(crate) async fn acknowledge_cleanup(
    transaction: &WorldTransaction<'_>,
    deletion: &ContentId,
    target: &CleanupTarget,
) -> Result<(), Error> {
    let world = transaction.world();
    let row = transaction.query_opt(
        "SELECT blob_digest,cleanup_targets,cleanup_acks,state FROM world_content_deletion WHERE tenant_id=$1 AND world_id=$2 AND deletion_id=$3 FOR UPDATE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &deletion.as_str()],
    ).await?.ok_or_else(|| Error::material(MaterialFailure::ContentNotFound))?;
    let targets: Vec<CleanupTarget> = decode(row.get("cleanup_targets"))?;
    let mut acknowledgements: Vec<CleanupTarget> = decode(row.get("cleanup_acks"))?;
    if !targets.contains(target) {
        return Err(Error::material(MaterialFailure::InputInvalid));
    }
    if acknowledgements.contains(target) {
        return Ok(());
    }
    let digest: String = row.get("blob_digest");
    if owner_references(transaction, &target.resource)
        .await?
        .iter()
        .any(|reference| reference.blob.digest.as_str() == digest)
    {
        return Err(Error::material(MaterialFailure::RetainedReferences));
    }
    acknowledgements.push(target.clone());
    transaction.execute(
        "UPDATE world_content_deletion SET cleanup_acks=$4,remaining=$5,revision=revision+1 WHERE tenant_id=$1 AND world_id=$2 AND deletion_id=$3",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &deletion.as_str(), &encode(&acknowledgements)?, &((targets.len() - acknowledgements.len()) as i32)],
    ).await?;
    Ok(())
}

/// Claims only registered blobs. Never scan/delete unregistered files by mtime or pin expiry.
pub(crate) async fn claim_deletion(
    transaction: &WorldTransaction<'_>,
    deletion: &ContentId,
    token: ContentId,
) -> Result<DeletionClaim, Error> {
    let world = transaction.world();
    let row = transaction.query_opt(
        "SELECT body,state,claim_token,remaining FROM world_content_deletion WHERE tenant_id=$1 AND world_id=$2 AND deletion_id=$3",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &deletion.as_str()],
    ).await?.ok_or_else(|| Error::material(MaterialFailure::ContentNotFound))?;
    let plan: DeletionPlan = decode(row.get("body"))?;
    if row.get::<_, i32>("remaining") != 0 {
        return Err(Error::material(MaterialFailure::RetainedReferences));
    }
    let blob = transaction.query_opt(
        "SELECT state,generation,claim_token FROM world_blob WHERE tenant_id=$1 AND world_id=$2 AND digest=$3 FOR UPDATE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &plan.blob.digest.as_str()],
    ).await?.ok_or_else(|| Error::material(MaterialFailure::ContentNotFound))?;
    let state: String = blob.get("state");
    if state == "deleting" || state == "deleted" {
        if row.get::<_, Option<String>>("claim_token").as_deref() != Some(token.as_str())
            || (state == "deleting"
                && blob.get::<_, Option<String>>("claim_token").as_deref() != Some(token.as_str()))
        {
            return Err(Error::material(MaterialFailure::RetainedReferences));
        }
        return Ok(DeletionClaim {
            world: world.clone(),
            blob: plan.blob,
            deletion_id: deletion.clone(),
            token,
            generation: Generation(blob.get::<_, i64>("generation") as u64),
        });
    }
    if state != "live" {
        return Err(Error::material(MaterialFailure::Deleted));
    }
    let retained = transaction.query_opt(
        "SELECT 1 WHERE EXISTS(SELECT 1 FROM world_content_reference WHERE tenant_id=$1 AND world_id=$2 AND blob_digest=$3 AND released_at IS NULL) OR EXISTS(SELECT 1 FROM world_content_hold WHERE tenant_id=$1 AND world_id=$2 AND blob_digest=$3 AND released_at IS NULL) OR EXISTS(SELECT 1 FROM world_blob_pin WHERE tenant_id=$1 AND world_id=$2 AND digest=$3 AND released_at IS NULL)",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &plan.blob.digest.as_str()],
    ).await?.is_some();
    if retained {
        return Err(Error::material(MaterialFailure::RetainedReferences));
    }
    let generation = blob
        .get::<_, i64>("generation")
        .checked_add(1)
        .ok_or_else(|| Error::material(MaterialFailure::InputInvalid))?;
    transaction.execute(
        "UPDATE world_blob SET state='deleting',generation=$4,claim_token=$5 WHERE tenant_id=$1 AND world_id=$2 AND digest=$3",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &plan.blob.digest.as_str(), &generation, &token.as_str()],
    ).await?;
    transaction.execute(
        "UPDATE world_content_deletion SET state='claimed',claim_token=$4,revision=revision+1 WHERE tenant_id=$1 AND world_id=$2 AND deletion_id=$3 AND remaining=0",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &deletion.as_str(), &token.as_str()],
    ).await?;
    Ok(DeletionClaim {
        world: world.clone(),
        blob: plan.blob,
        deletion_id: deletion.clone(),
        token,
        generation: Generation(generation as u64),
    })
}

pub(super) async fn validate_claim_snapshot(
    snapshot: &crate::store::WorldSnapshot<'_>,
    claim: &DeletionClaim,
) -> Result<(), Error> {
    let world = snapshot.world();
    if world != &claim.world {
        return Err(Error::material(MaterialFailure::InputInvalid));
    }
    let admitted = snapshot.query_opt(
        "SELECT 1 FROM world_storage_head h JOIN world_blob b ON b.tenant_id=h.tenant_id AND b.world_id=h.world_id JOIN world_content_deletion d ON d.tenant_id=b.tenant_id AND d.world_id=b.world_id AND d.blob_digest=b.digest WHERE h.tenant_id=$1 AND h.world_id=$2 AND h.mode='active' AND b.digest=$3 AND b.generation=$4 AND ((b.state='deleting' AND b.claim_token=$5 AND d.state IN ('claimed','failed')) OR (b.state='deleted' AND d.state='deleted')) AND d.deletion_id=$6 AND d.claim_token=$5 AND d.remaining=0",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &claim.blob.digest.as_str(), &(claim.generation.0 as i64), &claim.token.as_str(), &claim.deletion_id.as_str()],
    ).await?;
    if admitted.is_none() {
        return Err(Error::material(MaterialFailure::RetentionDenied));
    }
    Ok(())
}

pub(crate) async fn finish_deletion(
    transaction: &WorldTransaction<'_>,
    cleanup: &super::CleanupResult,
) -> Result<(), Error> {
    let claim = &cleanup.claim;
    if transaction.world() != &claim.world {
        return Err(Error::material(MaterialFailure::InputInvalid));
    }
    let world = transaction.world();
    let generation = claim.generation.0 as i64;
    let row = transaction.query_opt(
        "SELECT state FROM world_blob WHERE tenant_id=$1 AND world_id=$2 AND digest=$3 AND generation=$4 AND (claim_token=$5 OR state='deleted') FOR UPDATE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &claim.blob.digest.as_str(), &generation, &claim.token.as_str()],
    ).await?.ok_or_else(|| Error::material(MaterialFailure::InputInvalid))?;
    if row.get::<_, String>("state") == "deleted" {
        return Ok(());
    }
    if let Err(error) = &cleanup.result {
        let reason = error
            .reason()
            .cloned()
            .unwrap_or(MaterialFailure::CleanupFailed);
        transaction.execute(
            "UPDATE world_content_deletion SET state='failed',failure_code=$4,failure_stage='physical_cleanup',revision=revision+1 WHERE tenant_id=$1 AND world_id=$2 AND deletion_id=$3 AND claim_token=$5",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &claim.deletion_id.as_str(), &format!("{reason:?}"), &claim.token.as_str()],
        ).await?;
        return Ok(());
    }
    transaction.execute(
        "UPDATE world_blob SET state='deleted',claim_token=NULL,deleted_at=clock_timestamp() WHERE tenant_id=$1 AND world_id=$2 AND digest=$3 AND generation=$4 AND claim_token=$5",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &claim.blob.digest.as_str(), &generation, &claim.token.as_str()],
    ).await?;
    let changed = transaction.execute(
        "UPDATE world_content_deletion SET state='deleted',failure_code=NULL,failure_stage=NULL,completed_at=clock_timestamp(),revision=revision+1 WHERE tenant_id=$1 AND world_id=$2 AND deletion_id=$3 AND claim_token=$4 AND remaining=0",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &claim.deletion_id.as_str(), &claim.token.as_str()],
    ).await?;
    if changed != 1 {
        return Err(Error::material(MaterialFailure::RetainedReferences));
    }
    Ok(())
}
