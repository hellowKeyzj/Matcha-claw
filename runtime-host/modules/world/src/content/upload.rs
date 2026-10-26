use std::{
    error::Error as StdError,
    fmt,
    io::{self, Read},
};

use sha2::Digest as _;

use tokio_util::sync::CancellationToken;
use world_protocol::{
    api::{
        BeginUpload, MAX_UPLOAD_CHUNK_BYTES, SealUpload, UploadChunk, UploadFailure, UploadKey,
        UploadReceipt, UploadState,
    },
    ids::{ActorId, Revision, TransferId, WorldRef},
    materials::{BlobRef, MaterialFailure},
    time::Timestamp,
};

use super::{
    BlobPin, Content, ContentOwner, Error, PinKind, PreparedBlob, decode, digest_bytes, encode,
    retention, stable_id,
};
use crate::store::{StoreError, WorldSnapshot, WorldStore, WorldTransaction};

pub(crate) struct UploadError {
    failure: UploadFailure,
    source: Option<Error>,
}
impl UploadError {
    fn new(failure: UploadFailure) -> Self {
        Self {
            failure,
            source: None,
        }
    }
    pub(crate) fn failure(&self) -> &UploadFailure {
        &self.failure
    }
}
impl From<Error> for UploadError {
    fn from(source: Error) -> Self {
        let failure = UploadFailure::Storage {
            failure: source
                .reason()
                .cloned()
                .unwrap_or(MaterialFailure::InternalFault),
        };
        Self {
            failure,
            source: Some(source),
        }
    }
}
impl From<StoreError> for UploadError {
    fn from(source: StoreError) -> Self {
        Error::from(source).into()
    }
}
impl fmt::Debug for UploadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("UploadError")
            .field("failure", &self.failure)
            .finish_non_exhaustive()
    }
}
impl fmt::Display for UploadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "world upload {:?}", self.failure)
    }
}
impl StdError for UploadError {
    fn source(&self) -> Option<&(dyn StdError + 'static)> {
        self.source.as_ref().map(|source| source as _)
    }
}

pub(crate) struct PreparedUploadChunk {
    transfer_id: TransferId,
    offset: u64,
    blob: PreparedBlob,
}
pub(crate) struct PreparedUploadSeal {
    transfer_id: TransferId,
    actor: ActorId,
    revision: Revision,
    blob: PreparedBlob,
}

struct Upload {
    id: TransferId,
    actor: ActorId,
    request: BeginUpload,
    receipt: UploadReceipt,
    expired: bool,
    sealed_pin: Option<BlobPin>,
}

impl Content {
    /// Authorization and content/operation writer fences are admitted by the owning command.
    pub(crate) async fn begin_upload(
        &self,
        tx: &WorldTransaction<'_>,
        actor: &ActorId,
        id: TransferId,
        request: &BeginUpload,
    ) -> Result<UploadReceipt, UploadError> {
        self.check_world(tx.world())?;
        if request.name.trim().is_empty()
            || request.name.len() > 1024
            || request.media_type.trim().is_empty()
            || request.media_type.len() > 256
            || request.size > self.blobs.maximum_bytes()
            || request.size > i64::MAX as u64
        {
            return Err(UploadError::new(UploadFailure::AdmissionMismatch));
        }
        let world = tx.world();
        tx.execute(
            "INSERT INTO world_content_upload(tenant_id,world_id,transfer_id,actor_id,state,revision,received,expected_size,expected_digest,name,media_type,expires_at,body) VALUES($1,$2,$3,$4,'receiving',1,0,$5,$6,$7,$8,clock_timestamp()+interval '24 hours',$9) ON CONFLICT DO NOTHING",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str(), &actor.as_str(), &(request.size as i64), &request.digest.as_str(), &request.name, &request.media_type, &encode(request)?],
        ).await?;
        let upload = locked_upload(tx, actor, &id).await?;
        if upload.request != *request {
            return Err(UploadError::new(UploadFailure::AdmissionMismatch));
        }
        Ok(upload.receipt)
    }

    pub(crate) fn prepare_upload_chunk(
        &self,
        chunk: &UploadChunk,
        cancellation: &CancellationToken,
    ) -> Result<PreparedUploadChunk, UploadError> {
        if chunk.bytes.is_empty() || chunk.bytes.len() > MAX_UPLOAD_CHUNK_BYTES {
            return Err(UploadError::new(UploadFailure::ChunkTooLarge));
        }
        if <[u8; 32]>::from(sha2::Sha256::digest(&chunk.bytes)) != digest_bytes(&chunk.digest) {
            return Err(UploadError::new(UploadFailure::ChunkDigestMismatch));
        }
        let blob = self.prepare_blob(
            &mut chunk.bytes.as_slice(),
            Some(&chunk.digest),
            cancellation,
        )?;
        Ok(PreparedUploadChunk {
            transfer_id: chunk.transfer_id.clone(),
            offset: chunk.offset,
            blob,
        })
    }

    pub(crate) fn discard_upload_chunk(&self, chunk: &PreparedUploadChunk) -> Result<(), Error> {
        self.discard_prepared(&chunk.blob)
    }
    pub(crate) fn refresh_upload_chunk(
        &self,
        chunk: &mut PreparedUploadChunk,
    ) -> Result<(), Error> {
        self.refresh_prepared(&mut chunk.blob)
    }

    pub(crate) async fn append_upload_chunk(
        &self,
        tx: &WorldTransaction<'_>,
        actor: &ActorId,
        chunk: &PreparedUploadChunk,
    ) -> Result<UploadReceipt, UploadError> {
        self.check_world(tx.world())?;
        let upload = locked_upload(tx, actor, &chunk.transfer_id).await?;
        require_receiving(&upload)?;
        let world = tx.world();
        let previous = tx.query_opt(
            "SELECT byte_size,blob_digest FROM world_content_upload_chunk WHERE tenant_id=$1 AND world_id=$2 AND transfer_id=$3 AND \"offset\"=$4",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &chunk.transfer_id.as_str(), &checked_i64(chunk.offset)?],
        ).await?;
        if let Some(previous) = previous {
            if previous.get::<_, i64>("byte_size") as u64 != chunk.blob.reference.byte_size
                || previous.get::<_, String>("blob_digest") != chunk.blob.reference.digest.as_str()
            {
                return Err(UploadError::new(UploadFailure::AdmissionMismatch));
            }
            return Ok(upload.receipt);
        }
        if chunk.offset != upload.receipt.received {
            return Err(UploadError::new(UploadFailure::OffsetMismatch {
                expected: upload.receipt.received,
                actual: chunk.offset,
            }));
        }
        let received = chunk
            .offset
            .checked_add(chunk.blob.reference.byte_size)
            .filter(|size| *size <= upload.request.size)
            .ok_or_else(|| UploadError::new(UploadFailure::SizeMismatch))?;
        let count: i64 = tx.query_opt(
            "SELECT count(*) AS count FROM world_content_upload_chunk WHERE tenant_id=$1 AND world_id=$2 AND transfer_id=$3",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &chunk.transfer_id.as_str()],
        ).await?.expect("aggregate returns a row").get("count");
        if count >= 65_536 {
            return Err(UploadError::new(UploadFailure::ChunkTooLarge));
        }
        let pin = self
            .pin_prepared(
                tx,
                &chunk.blob,
                ContentOwner::Upload {
                    transfer_id: chunk.transfer_id.clone(),
                },
                stable_id(&(&chunk.transfer_id, "chunk", chunk.offset))?,
                PinKind::Upload,
            )
            .await?;
        tx.execute(
            "INSERT INTO world_content_upload_chunk(tenant_id,world_id,transfer_id,\"offset\",byte_size,blob_digest,pin) VALUES($1,$2,$3,$4,$5,$6,$7)",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &chunk.transfer_id.as_str(), &checked_i64(chunk.offset)?, &checked_i64(chunk.blob.reference.byte_size)?, &chunk.blob.reference.digest.as_str(), &encode(&pin)?],
        ).await?;
        tx.execute(
            "UPDATE world_content_upload SET received=$4,revision=revision+1 WHERE tenant_id=$1 AND world_id=$2 AND transfer_id=$3",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &chunk.transfer_id.as_str(), &checked_i64(received)?],
        ).await?;
        Ok(locked_upload(tx, actor, &chunk.transfer_id).await?.receipt)
    }

    /// Catalog snapshot closes before any chunk read/hash/copy. Pins are durable, not TTL leases.
    pub(crate) async fn prepare_seal_upload(
        &self,
        store: &WorldStore,
        actor: &ActorId,
        request: &SealUpload,
        cancellation: &CancellationToken,
    ) -> Result<PreparedUploadSeal, UploadError> {
        let _physical = self.blobs.lock().map_err(Error::from)?;
        let actor = actor.clone();
        let requested = request.clone();
        let (upload, chunks) = store
            .snapshot(self.world.clone(), move |snapshot| {
                Box::pin(async move {
                    let upload = snapshot_upload(snapshot, &actor, &requested.transfer_id).await?;
                    require_receiving(&upload)?;
                    if upload.request.size != requested.size
                        || upload.receipt.received != requested.size
                    {
                        return Err(UploadError::new(UploadFailure::SizeMismatch));
                    }
                    if upload.request.digest != requested.digest {
                        return Err(UploadError::new(UploadFailure::DigestMismatch));
                    }
                    let chunks = snapshot_chunks(snapshot, &upload).await?;
                    Ok((upload, chunks))
                })
            })
            .await?;
        let mut reader = ChunkReader {
            content: self,
            chunks: chunks.into_iter(),
            current: io::Cursor::new(Vec::new()),
        };
        let staged = self
            .blobs
            .prepare_locked(
                &mut reader,
                Some(digest_bytes(&request.digest)),
                cancellation,
            )
            .map_err(Error::from)?;
        let blob = self.prepared_blob(staged);
        if blob.reference.byte_size != request.size {
            drop(_physical);
            self.discard_prepared(&blob)?;
            return Err(UploadError::new(UploadFailure::SizeMismatch));
        }
        Ok(PreparedUploadSeal {
            transfer_id: upload.id,
            actor: upload.actor,
            revision: upload.receipt.revision,
            blob,
        })
    }

    pub(crate) fn discard_upload_seal(&self, seal: &PreparedUploadSeal) -> Result<(), Error> {
        self.discard_prepared(&seal.blob)
    }
    pub(crate) fn refresh_upload_seal(&self, seal: &mut PreparedUploadSeal) -> Result<(), Error> {
        self.refresh_prepared(&mut seal.blob)
    }

    pub(crate) async fn seal_upload(
        &self,
        tx: &WorldTransaction<'_>,
        actor: &ActorId,
        seal: &PreparedUploadSeal,
    ) -> Result<UploadReceipt, UploadError> {
        self.check_world(tx.world())?;
        if actor != &seal.actor {
            return Err(UploadError::new(UploadFailure::AdmissionMismatch));
        }
        let upload = locked_upload(tx, actor, &seal.transfer_id).await?;
        if let UploadState::Sealed { blob } = &upload.receipt.state {
            if blob != seal.blob.reference() {
                return Err(UploadError::new(UploadFailure::AdmissionMismatch));
            }
            return Ok(upload.receipt);
        }
        require_receiving(&upload)?;
        if upload.receipt.revision != seal.revision
            || upload.receipt.received != seal.blob.reference.byte_size
            || upload.request.digest != seal.blob.reference.digest
        {
            return Err(UploadError::new(UploadFailure::AdmissionMismatch));
        }
        let pin = self
            .pin_prepared(
                tx,
                &seal.blob,
                ContentOwner::Upload {
                    transfer_id: seal.transfer_id.clone(),
                },
                stable_id(&(&seal.transfer_id, "sealed"))?,
                PinKind::Upload,
            )
            .await?;
        release_chunks(tx, &seal.transfer_id).await?;
        let world = tx.world();
        tx.execute(
            "UPDATE world_content_upload SET state='sealed',sealed_pin=$4,revision=revision+1 WHERE tenant_id=$1 AND world_id=$2 AND transfer_id=$3",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &seal.transfer_id.as_str(), &encode(&pin)?],
        ).await?;
        Ok(locked_upload(tx, actor, &seal.transfer_id).await?.receipt)
    }

    pub(crate) async fn abort_upload(
        &self,
        tx: &WorldTransaction<'_>,
        actor: &ActorId,
        key: &UploadKey,
    ) -> Result<UploadReceipt, UploadError> {
        self.check_world(tx.world())?;
        let upload = locked_upload(tx, actor, &key.transfer_id).await?;
        if matches!(upload.receipt.state, UploadState::Aborted) {
            return Ok(upload.receipt);
        }
        if matches!(upload.receipt.state, UploadState::Sealed { .. }) {
            return Err(UploadError::new(UploadFailure::AlreadySealed));
        }
        release_chunks(tx, &key.transfer_id).await?;
        let world = tx.world();
        tx.execute(
            "UPDATE world_content_upload SET state='aborted',revision=revision+1 WHERE tenant_id=$1 AND world_id=$2 AND transfer_id=$3",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &key.transfer_id.as_str()],
        ).await?;
        Ok(locked_upload(tx, actor, &key.transfer_id).await?.receipt)
    }

    pub(crate) async fn read_upload(
        &self,
        snapshot: &WorldSnapshot<'_>,
        actor: &ActorId,
        key: &UploadKey,
    ) -> Result<UploadReceipt, UploadError> {
        self.check_world(snapshot.world())?;
        Ok(snapshot_upload(snapshot, actor, &key.transfer_id)
            .await?
            .receipt)
    }

    pub(crate) async fn checked_sealed_input(
        &self,
        tx: &WorldTransaction<'_>,
        actor: &ActorId,
        key: &UploadKey,
        blob: &BlobRef,
        name: &str,
        media_type: &str,
    ) -> Result<BlobPin, UploadError> {
        self.check_world(tx.world())?;
        let upload = locked_upload(tx, actor, &key.transfer_id).await?;
        if upload.expired {
            return Err(UploadError::new(UploadFailure::Expired));
        }
        if upload.request.name != name
            || upload.request.media_type != media_type
            || !matches!(&upload.receipt.state, UploadState::Sealed { blob: exact } if exact == blob)
        {
            return Err(UploadError::new(UploadFailure::AdmissionMismatch));
        }
        live_sealed_pin(tx, upload, blob).await
    }

    pub(crate) async fn consume_test_case_uploads(
        &self,
        tx: &WorldTransaction<'_>,
        actor: &ActorId,
        test: &world_protocol::learning::TestCase,
        fixture: &UploadKey,
        expected: &UploadKey,
    ) -> Result<(), UploadError> {
        self.check_world(tx.world())?;
        if &test.world != tx.world() {
            return Err(UploadError::new(UploadFailure::AdmissionMismatch));
        }
        let fixture_pin = self
            .sealed_upload_pin(tx, actor, fixture, &test.fixture)
            .await?;
        let expected_pin = self
            .sealed_upload_pin(tx, actor, expected, &test.expected)
            .await?;
        let owner = ContentOwner::TestCase {
            id: test.id.clone(),
            revision: test.revision,
        };
        for blob in [&test.fixture, &test.expected] {
            retention::retain(
                tx,
                &super::ContentReference::new(owner.clone(), blob.clone())?,
            )
            .await?;
        }
        retention::release_pin(tx, &fixture_pin).await?;
        if expected_pin != fixture_pin {
            retention::release_pin(tx, &expected_pin).await?;
        }
        Ok(())
    }

    pub(crate) async fn sealed_upload_pin(
        &self,
        tx: &WorldTransaction<'_>,
        actor: &ActorId,
        key: &UploadKey,
        blob: &BlobRef,
    ) -> Result<BlobPin, UploadError> {
        self.check_world(tx.world())?;
        let upload = locked_upload(tx, actor, &key.transfer_id).await?;
        live_sealed_pin(tx, upload, blob).await
    }
}

async fn live_sealed_pin(
    tx: &WorldTransaction<'_>,
    upload: Upload,
    blob: &BlobRef,
) -> Result<BlobPin, UploadError> {
    if upload.expired {
        return Err(UploadError::new(UploadFailure::Expired));
    }
    if !matches!(&upload.receipt.state, UploadState::Sealed { blob: exact } if exact == blob) {
        return Err(UploadError::new(UploadFailure::AdmissionMismatch));
    }
    let pin = upload
        .sealed_pin
        .ok_or_else(|| UploadError::new(UploadFailure::AdmissionMismatch))?;
    retention::validate_pin(tx, &pin).await?;
    Ok(pin)
}

async fn locked_upload(
    tx: &WorldTransaction<'_>,
    actor: &ActorId,
    id: &TransferId,
) -> Result<Upload, UploadError> {
    let world = tx.world();
    let row = tx.query_opt(
        "SELECT *,to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS expires,expires_at<=clock_timestamp() AS expired FROM world_content_upload WHERE tenant_id=$1 AND world_id=$2 AND transfer_id=$3 AND actor_id=$4 FOR UPDATE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str(), &actor.as_str()],
    ).await?.ok_or_else(|| UploadError::new(UploadFailure::NotFound))?;
    upload_row(world, id, actor, &row)
}
async fn snapshot_upload(
    snapshot: &WorldSnapshot<'_>,
    actor: &ActorId,
    id: &TransferId,
) -> Result<Upload, UploadError> {
    let world = snapshot.world();
    let row = snapshot.query_opt(
        "SELECT *,to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS expires,expires_at<=clock_timestamp() AS expired FROM world_content_upload WHERE tenant_id=$1 AND world_id=$2 AND transfer_id=$3 AND actor_id=$4",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str(), &actor.as_str()],
    ).await?.ok_or_else(|| UploadError::new(UploadFailure::NotFound))?;
    upload_row(world, id, actor, &row)
}
fn upload_row(
    world: &WorldRef,
    id: &TransferId,
    actor: &ActorId,
    row: &tokio_postgres::Row,
) -> Result<Upload, UploadError> {
    let invalid = || UploadError::new(UploadFailure::AdmissionMismatch);
    let request: BeginUpload = decode(row.get("body"))?;
    let expires: String = row
        .get::<_, Option<String>>("expires")
        .ok_or_else(invalid)?;
    let sealed_pin: Option<BlobPin> = row
        .get::<_, Option<serde_json::Value>>("sealed_pin")
        .map(decode)
        .transpose()?;
    let state = match row.get::<_, String>("state").as_str() {
        "receiving" => UploadState::Receiving,
        "sealed" => UploadState::Sealed {
            blob: sealed_pin.as_ref().ok_or_else(invalid)?.reference().clone(),
        },
        "aborted" => UploadState::Aborted,
        _ => return Err(invalid()),
    };
    if row.get::<_, Option<String>>("name").as_deref() != Some(request.name.as_str())
        || row.get::<_, Option<String>>("media_type").as_deref()
            != Some(request.media_type.as_str())
        || row.get::<_, Option<i64>>("expected_size") != Some(checked_i64(request.size)?)
        || row.get::<_, Option<String>>("expected_digest").as_deref()
            != Some(request.digest.as_str())
    {
        return Err(invalid());
    }
    if sealed_pin.as_ref().is_some_and(|pin| {
        &pin.world != world
            || pin.owner
                != (ContentOwner::Upload {
                    transfer_id: id.clone(),
                })
            || pin.kind != PinKind::Upload
    }) {
        return Err(invalid());
    }
    Ok(Upload {
        id: id.clone(),
        actor: actor.clone(),
        request,
        receipt: UploadReceipt {
            transfer_id: id.clone(),
            revision: Revision(row.get::<_, i64>("revision") as u64),
            received: row.get::<_, i64>("received") as u64,
            state,
            expires_at: Timestamp::try_new(expires).map_err(|_| invalid())?,
        },
        expired: row.get::<_, Option<bool>>("expired").ok_or_else(invalid)?,
        sealed_pin,
    })
}
fn require_receiving(upload: &Upload) -> Result<(), UploadError> {
    if !matches!(upload.receipt.state, UploadState::Receiving) {
        return Err(UploadError::new(UploadFailure::AlreadySealed));
    }
    if upload.expired {
        return Err(UploadError::new(UploadFailure::Expired));
    }
    Ok(())
}
fn checked_i64(value: u64) -> Result<i64, UploadError> {
    i64::try_from(value).map_err(|_| UploadError::new(UploadFailure::SizeMismatch))
}

async fn snapshot_chunks(
    snapshot: &WorldSnapshot<'_>,
    upload: &Upload,
) -> Result<Vec<BlobRef>, UploadError> {
    let world = snapshot.world();
    let owner_id = stable_id(&ContentOwner::Upload {
        transfer_id: upload.id.clone(),
    })?;
    let rows = snapshot.query(
        "SELECT c.\"offset\",c.byte_size,c.blob_digest,c.pin,b.byte_size AS blob_size,b.state,b.generation AS blob_generation,p.generation,p.owner_id,p.kind,p.released_at IS NOT NULL AS released,EXISTS(SELECT 1 FROM world_content_deletion d WHERE d.tenant_id=b.tenant_id AND d.world_id=b.world_id AND d.blob_digest=b.digest) AS barred FROM world_content_upload_chunk c JOIN world_blob b ON b.tenant_id=c.tenant_id AND b.world_id=c.world_id AND b.digest=c.blob_digest LEFT JOIN world_blob_pin p ON p.tenant_id=c.tenant_id AND p.world_id=c.world_id AND p.digest=c.blob_digest AND p.pin_id=c.pin->>'id' WHERE c.tenant_id=$1 AND c.world_id=$2 AND c.transfer_id=$3 ORDER BY c.\"offset\" LIMIT 65537",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &upload.id.as_str()],
    ).await?;
    if rows.len() > 65_536 {
        return Err(UploadError::new(UploadFailure::ChunkTooLarge));
    }
    let mut offset = 0_u64;
    let mut chunks = Vec::with_capacity(rows.len());
    for row in rows {
        let pin: BlobPin = decode(row.get("pin"))?;
        let size = row.get::<_, i64>("byte_size") as u64;
        if &pin.world != world
            || pin.owner
                != (ContentOwner::Upload {
                    transfer_id: upload.id.clone(),
                })
            || pin.kind != PinKind::Upload
            || pin.id != stable_id(&(&upload.id, "chunk", offset))?
            || Some(pin.generation.0 as i64) != row.get::<_, Option<i64>>("generation")
            || row.get::<_, i64>("offset") as u64 != offset
            || size == 0
            || size > MAX_UPLOAD_CHUNK_BYTES as u64
            || pin.reference().byte_size != size
            || row.get::<_, i64>("blob_size") as u64 != size
            || pin.reference().digest.as_str() != row.get::<_, String>("blob_digest")
            || row.get::<_, String>("state") != "live"
            || row.get::<_, Option<bool>>("released") != Some(false)
            || row.get::<_, bool>("barred")
            || row.get::<_, Option<i64>>("generation") != Some(row.get("blob_generation"))
            || row.get::<_, Option<String>>("owner_id").as_deref() != Some(owner_id.as_str())
            || row.get::<_, Option<String>>("kind").as_deref() != Some("upload")
        {
            return Err(UploadError::new(UploadFailure::AdmissionMismatch));
        }
        offset = offset
            .checked_add(size)
            .ok_or_else(|| UploadError::new(UploadFailure::SizeMismatch))?;
        chunks.push(pin.reference().clone());
    }
    if offset != upload.request.size {
        return Err(UploadError::new(UploadFailure::SizeMismatch));
    }
    Ok(chunks)
}
async fn release_chunks(tx: &WorldTransaction<'_>, id: &TransferId) -> Result<(), UploadError> {
    let world = tx.world();
    let rows = tx.query(
        "SELECT pin FROM world_content_upload_chunk WHERE tenant_id=$1 AND world_id=$2 AND transfer_id=$3 ORDER BY blob_digest,\"offset\" LIMIT 65537",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str()],
    ).await?;
    if rows.len() > 65_536 {
        return Err(UploadError::new(UploadFailure::ChunkTooLarge));
    }
    for row in rows {
        retention::release_pin(tx, &decode::<BlobPin>(row.get("pin"))?).await?;
    }
    Ok(())
}
struct ChunkReader<'a> {
    content: &'a Content,
    chunks: std::vec::IntoIter<BlobRef>,
    current: io::Cursor<Vec<u8>>,
}
impl Read for ChunkReader<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        loop {
            let length = self.current.read(buffer)?;
            if length != 0 || buffer.is_empty() {
                return Ok(length);
            }
            let Some(blob) = self.chunks.next() else {
                return Ok(0);
            };
            self.current = io::Cursor::new(
                self.content
                    .blobs
                    .read_locked(&digest_bytes(&blob.digest), blob.byte_size)
                    .map_err(io::Error::other)?,
            );
        }
    }
}
