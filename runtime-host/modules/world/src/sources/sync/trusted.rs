use super::{Assignment, CaptureKind, CapturedInput, SyncError, SyncIdentity};
use crate::{
    content::{Content, PreparedBlob},
    sources::connectors::ReadSourcePage,
    store::WorldTransaction,
};
use serde::{Deserialize, Serialize};
use std::io::Cursor;
use tokio_util::sync::CancellationToken;
use world_protocol::{
    budget::Budget,
    identity::IdentityReceipt,
    ids::*,
    materials::{SourceVersion, SourceVersionRef},
    sources::{
        CompiledSourcePlan, MapRecordsRequest, RecordBatch, SchemaDiscovery, SourcePage,
        SourcePosition,
    },
    time::ValidTime,
};

/// Neither construction nor deserialization is exposed to a guest dispatcher.
pub(crate) struct TrustedRecords {
    request: MapRecordsRequest,
    assignment: Assignment,
    existing: Vec<world_protocol::facts::Assertion>,
}
impl TrustedRecords {
    pub(crate) fn request(&self) -> &MapRecordsRequest {
        &self.request
    }
    pub(crate) fn assignment(&self) -> &Assignment {
        &self.assignment
    }
    pub(crate) fn existing(&self) -> &[world_protocol::facts::Assertion] {
        &self.existing
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(super) struct RawCapture {
    pub assignment: Assignment,
    pub page: SourcePage,
    pub deletions: Vec<(String, String)>,
    pub valid_time: ValidTime,
    pub kind: CaptureKind,
    pub position: SourcePosition,
    pub raw_source: Vec<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_capture: Option<Digest>,
}

impl RawCapture {
    pub(super) fn change_position(&self) -> Result<Option<&SourcePosition>, SyncError> {
        validate_page(&self.assignment, &self.page, &self.kind, &self.position)?;
        Ok(matches!(&self.kind, CaptureKind::Changes { .. }).then_some(&self.position))
    }
}

pub(crate) struct PreparedCapture {
    pub(super) raw: RawCapture,
    pub(super) blob: PreparedBlob,
    pub(super) version: SourceVersion,
    pub(super) digest: Digest,
    pub(super) event_id: EventId,
}
impl PreparedCapture {
    pub(super) fn from_read(
        content: &Content,
        assignment: &Assignment,
        read: &ReadSourcePage,
        identity: &SyncIdentity,
        valid_time: ValidTime,
        kind: CaptureKind,
        position: SourcePosition,
        cancel: &CancellationToken,
    ) -> Result<Self, SyncError> {
        if read.connection().id != assignment.connection_id
            || read.connection().revision != assignment.connection_revision
            || read.connection().world != assignment.world
            || read.implementation() != &assignment.implementation
        {
            return Err(SyncError::protocol());
        }
        Self::prepare(
            content,
            assignment,
            read.page().clone(),
            Vec::new(),
            identity,
            valid_time,
            kind,
            position,
            cancel,
        )
    }

    /// This entry accepts only a native carrier's unforgeable batch witness.
    pub(crate) fn from_changes(
        content: &Content,
        assignment: &Assignment,
        changes: &crate::sources::connectors::cdc::ReadChanges,
        identity: &SyncIdentity,
        cancel: &CancellationToken,
    ) -> Result<Vec<Self>, SyncError> {
        changes.prepare_capture(content, assignment, identity, cancel)
    }

    pub(in crate::sources) fn prepare(
        content: &Content,
        assignment: &Assignment,
        page: SourcePage,
        deletions: Vec<(String, String)>,
        identity: &SyncIdentity,
        valid_time: ValidTime,
        kind: CaptureKind,
        position: SourcePosition,
        cancel: &CancellationToken,
    ) -> Result<Self, SyncError> {
        let raw_source = serde_json::to_vec(&page).map_err(|cause| {
            SyncError::codec(world_protocol::failure::FailureStage::Validate, cause)
        })?;
        Self::prepare_native(
            content, assignment, page, deletions, identity, valid_time, kind, position, raw_source,
            cancel,
        )
    }
    pub(in crate::sources) fn prepare_native(
        content: &Content,
        assignment: &Assignment,
        page: SourcePage,
        deletions: Vec<(String, String)>,
        identity: &SyncIdentity,
        valid_time: ValidTime,
        kind: CaptureKind,
        position: SourcePosition,
        raw_source: Vec<u8>,
        cancel: &CancellationToken,
    ) -> Result<Self, SyncError> {
        validate_page(assignment, &page, &kind, &position)?;
        let raw = RawCapture {
            assignment: assignment.clone(),
            page,
            deletions,
            valid_time,
            kind,
            position,
            raw_source,
            branch_capture: None,
        };
        let bytes = raw_bytes(&raw)?;
        let digest = world_protocol::schema::hash(&bytes).map_err(|cause| {
            SyncError::caused(
                world_protocol::sources::SourceFailure::InternalFault,
                world_protocol::failure::FailureStage::Validate,
                cause,
            )
        })?;
        let blob = content.prepare_blob(&mut Cursor::new(&bytes), Some(&digest), cancel)?;
        // Event identity does not include partition epoch, credentials or implementation generation.
        let event_digest = crate::definitions::canonical_digest(&(
            "world.source.event.v1",
            &assignment.world,
            &assignment.source_id,
            &assignment.partition,
            &assignment.incarnation,
            &raw.position,
            &raw.kind,
            &raw.page.rows,
            &raw.deletions,
        ))
        .map_err(|_| SyncError::protocol())?;
        let event_id = EventId::try_new(event_digest.as_str().replace(':', "-"))
            .map_err(|_| SyncError::protocol())?;
        let version = SourceVersion {
            reference: SourceVersionRef {
                world: assignment.world.clone(),
                source_id: assignment.source_id.clone(),
                version_id: SourceVersionId::try_new(digest.as_str().replace(':', "-"))
                    .map_err(|_| SyncError::protocol())?,
            },
            blob: blob.reference().clone(),
            media_type: "application/vnd.matcha.source-records+json".into(),
            captured_at: raw
                .page
                .basis
                .captured_at
                .clone()
                .unwrap_or_else(|| raw.page.basis.observed_at.clone()),
            supersedes: None,
            origin_family: identity.origin_family.clone(),
            lineage: Vec::new(),
            access: identity.access.clone(),
            retention: identity.retention.clone(),
        };
        Ok(Self {
            raw,
            blob,
            version,
            digest,
            event_id,
        })
    }
}

pub(super) struct StoredInput {
    pub input: CapturedInput,
    pub raw: RawCapture,
    pub version: SourceVersion,
}
impl StoredInput {
    pub(super) async fn verified(
        tx: &WorldTransaction<'_>,
        input: CapturedInput,
        raw: RawCapture,
        digest: &str,
    ) -> Result<Self, SyncError> {
        validate_page(&raw.assignment, &raw.page, &raw.kind, &raw.position)?;
        let bytes = if let Some(capture_digest) = &raw.branch_capture {
            let w = tx.world();
            let row = tx.query_opt("SELECT body,raw FROM world_source_branch_capture WHERE tenant_id=$1 AND world_id=$2 AND capture_digest=$3", &[&w.tenant_id.as_str(), &w.world_id.as_str(), &capture_digest.as_str()]).await?.ok_or_else(SyncError::protocol)?;
            let dto: world_protocol::sources::BranchSourceCapture = super::decode(row.get("body"))?;
            let captured: super::branch_capture::RawBranchCapture = super::decode(row.get("raw"))?;
            let mut expected = captured.assignment.clone();
            expected.epoch = raw.assignment.epoch;
            if dto.digest != *capture_digest
                || super::branch_capture::digest(&dto)? != *capture_digest
                || dto.source_version != input.source_version
                || dto.basis != input.basis
                || captured.page != raw.page
                || captured.valid_time != raw.valid_time
                || expected != raw.assignment
                || !raw.deletions.is_empty()
                || raw.raw_source != super::branch_capture::raw_bytes(&captured)?
            {
                return Err(SyncError::protocol());
            }
            raw.raw_source.clone()
        } else {
            raw_bytes(&raw)?
        };
        let actual = world_protocol::schema::hash(&bytes).map_err(|cause| {
            SyncError::caused(
                world_protocol::sources::SourceFailure::InternalFault,
                world_protocol::failure::FailureStage::Decode,
                cause,
            )
        })?;
        let version =
            crate::content::read_source_version_in_transaction(tx, &input.source_version).await?;
        if actual.as_str() != digest
            || version.blob.digest != actual
            || version.blob.byte_size != bytes.len() as u64
            || raw.page.rows != input.rows
            || raw.deletions != input.deletions
            || raw.page.basis != input.basis
            || raw.position != input.position
            || raw.kind != input.kind
            || raw.valid_time != input.valid_time
        {
            return Err(SyncError::protocol());
        }
        Ok(Self {
            input,
            raw,
            version,
        })
    }
    pub(super) async fn records(
        &self,
        tx: &WorldTransaction<'_>,
        complete: &super::inbox::CompleteInput<'_>,
        plan: CompiledSourcePlan,
        observed_schema: SchemaDiscovery,
        identities: Vec<IdentityReceipt>,
        budget: Budget,
    ) -> Result<TrustedRecords, SyncError> {
        let a = &self.raw.assignment;
        if plan.binding != a.binding
            || plan.binding_body.source_id != a.source_id
            || plan.mapping.reference != a.mapping
            || plan.schema.reference != a.schema
            || observed_schema.reference != self.input.basis.schema
        {
            return Err(SyncError::protocol());
        }
        if !std::ptr::eq(complete.input(), self) {
            return Err(SyncError::protocol());
        }
        let selected = complete.rows();
        let keys: Vec<String> = selected.iter().map(|row| row.native_key.clone()).collect();
        let rows = tx.query("SELECT native_key,record_incarnation,body FROM world_source_claim WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 AND partition_key=$4 AND namespace=$5 AND binding_id=$6 AND native_key=ANY($7) FOR UPDATE", &[&a.world.tenant_id.as_str(), &a.world.world_id.as_str(), &a.source_id.as_str(), &a.partition, &plan.binding_body.namespace, &a.binding.id.as_str(), &keys]).await?;
        let mut existing = Vec::new();
        for row in rows {
            if selected.iter().any(|input| {
                input.native_key == row.get::<_, String>("native_key")
                    && input.incarnation == row.get::<_, String>("record_incarnation")
            }) {
                existing.push(super::decode(row.get("body"))?);
            }
        }
        Ok(TrustedRecords {
            assignment: a.clone(),
            existing,
            request: MapRecordsRequest {
                observed_schema,
                source_version: self.version.clone(),
                batch: RecordBatch {
                    source_id: a.source_id.clone(),
                    incarnation: a.incarnation.clone(),
                    schema: self.input.basis.schema.clone(),
                    rows: selected.iter().map(|row| (*row).clone()).collect(),
                    // Native tombstones are applied from CompleteInput before final rows.
                    deleted_keys: Vec::new(),
                    source_version: self.version.reference.clone(),
                    valid_time: self.input.valid_time.clone(),
                    complete: self.raw.page.complete,
                },
                plan,
                identities,
                basis: self.input.basis.clone(),
                budget,
            },
        })
    }
}

pub(super) fn raw_bytes(raw: &RawCapture) -> Result<Vec<u8>, SyncError> {
    serde_json::to_vec(raw)
        .map_err(|cause| SyncError::codec(world_protocol::failure::FailureStage::Validate, cause))
}
pub(super) fn snapshot_position(
    a: &Assignment,
    run: &RunId,
    chunk: u64,
) -> Result<SourcePosition, SyncError> {
    Ok(SourcePosition {
        source_id: a.source_id.clone(),
        incarnation: a.incarnation.clone(),
        partition: a.partition.clone(),
        format: CheckpointFormatId::try_new("source.snapshot.v1")
            .map_err(|_| SyncError::protocol())?,
        cursor: format!("{run}:{chunk}"),
        transaction: None,
        event_index: Some(chunk),
    })
}

fn validate_page(
    a: &Assignment,
    page: &SourcePage,
    kind: &CaptureKind,
    position: &SourcePosition,
) -> Result<(), SyncError> {
    let b = &page.basis;
    let native = b.position.as_ref() == Some(position) && position.format == a.format;
    let valid_position = match kind {
        CaptureKind::Changes { transaction, .. } => native && transaction == &position.transaction,
        CaptureKind::Snapshot { run, chunk, .. } => {
            if b.position.is_some() {
                native
            } else {
                *position == snapshot_position(a, run, *chunk)?
            }
        }
    };
    if !valid_position
        || b.source_id != a.source_id
        || b.incarnation != a.incarnation
        || b.binding != a.binding
        || b.mapping_revision != a.mapping.revision
        || b.schema != a.schema
        || b.identity_rule != a.identity_rule
        || position.source_id != a.source_id
        || position.incarnation != a.incarnation
        || position.partition != a.partition
        || page
            .rows
            .iter()
            .any(|row| row.native_key.is_empty() || row.incarnation.is_empty())
    {
        return Err(SyncError::protocol());
    }
    Ok(())
}
