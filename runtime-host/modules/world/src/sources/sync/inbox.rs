use super::{
    Assignment, CaptureKind, CapturedInput, Checkpoint, PreparedCapture, SyncError, authorize,
    changed, decode, encode,
    model::{ApplyReceipt, CaptureReceipt},
    number, partition,
    trusted::{RawCapture, StoredInput},
};
use crate::{
    authorization::Admission, content::Content, extensions::invocation::CallBudget,
    facts::assertions, sources::mapping, store::WorldTransaction,
};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;
use world_protocol::{
    authorization::AccessMode,
    budget::Budget,
    failure::FailureStage,
    identity::IdentityProposal,
    ids::*,
    sources::{CompiledSourcePlan, SourceFailure, SourcePosition},
};

#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub(super) struct Entry {
    pub input: CapturedInput,
    pub raw: RawCapture,
}

/// Only apply's verified, complete native transaction mints this execution view.
pub(super) struct CompleteInput<'a> {
    input: &'a StoredInput,
    rows: Vec<&'a world_protocol::sources::SourceRow>,
    deletions: Vec<&'a (String, String)>,
}
impl<'a> CompleteInput<'a> {
    pub(super) fn transaction(entries: &'a [StoredInput]) -> Vec<Self> {
        let mut inputs: Vec<_> = entries.iter().map(|input| Self {
            input,
            rows: input.input.rows.iter().collect(),
            deletions: input.input.deletions.iter().collect(),
        }).collect();
        if matches!(&entries[0].input.kind, CaptureKind::Changes { .. }) {
            // A committed transaction exposes only its final row, even across durable chunks.
            let mut later = std::collections::BTreeSet::new();
            for input in inputs.iter_mut().rev() {
                input.rows.reverse();
                input.rows.retain(|row| later.insert(row.native_key.clone()));
                input.rows.reverse();
                for (key, _) in &input.input.input.deletions {
                    later.insert(key.clone());
                }
            }
            let mut deleted = std::collections::BTreeSet::new();
            for input in &mut inputs {
                input.deletions.retain(|(key, _)| deleted.insert(key.clone()));
            }
        }
        inputs
    }
    pub(super) fn input(&self) -> &StoredInput { self.input }
    pub(super) fn rows(&self) -> &[&world_protocol::sources::SourceRow] { &self.rows }
    pub(super) fn deletions(&self) -> &[&(String, String)] { &self.deletions }
}

#[derive(Clone)]
pub(super) struct CapturedPrefix {
    entries: Vec<(Entry, String)>,
    digest: Digest,
}
impl CapturedPrefix {
    pub(super) fn digest(&self) -> &Digest { &self.digest }
    pub(super) fn position(&self) -> &SourcePosition {
        &self.entries.last().expect("complete captured prefix").0.input.position
    }
    pub(super) fn ends_at(&self, event: &EventId, sequence: u64) -> bool {
        self.entries.last().is_some_and(|(entry, _)| {
            entry.input.event_id == *event && entry.input.sequence == sequence
        })
    }
    pub(super) fn snapshot_capture(&self) -> Option<(&Assignment, &RunId, u64, &str)> {
        let (entry, digest) = self.entries.first()?;
        match &entry.input.kind {
            CaptureKind::Snapshot { run, chunk, .. } => Some((&entry.raw.assignment, run, *chunk, digest)),
            CaptureKind::Changes { .. } => None,
        }
    }
    pub(super) async fn next(
        snapshot: &crate::store::WorldSnapshot<'_>, admission: &Admission,
        a: &Assignment, plan: &CompiledSourcePlan, budget: &Budget,
        cancel: &CancellationToken,
    ) -> Result<Option<Self>, SyncError> {
        crate::authorization::recheck_read(snapshot, admission, &snapshot.now().await?).await?;
        if cancel.is_cancelled() { return Err(world_protocol::sources::MappingFailure::Cancelled.into()); }
        let end = snapshot.query_opt("SELECT sequence FROM world_source_inbox WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 AND partition_key=$4 AND status='captured' AND transaction_complete ORDER BY sequence LIMIT 1", &[&a.world.tenant_id.as_str(), &a.world.world_id.as_str(), &a.source_id.as_str(), &a.partition]).await?;
        let Some(end) = end else { return Ok(None); };
        let limit = i64::try_from(budget.max_steps.saturating_add(1)).unwrap_or(i64::MAX);
        let rows = snapshot.query("SELECT * FROM world_source_inbox WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 AND partition_key=$4 AND status='captured' AND sequence<=$5 ORDER BY sequence LIMIT $6", &[&a.world.tenant_id.as_str(), &a.world.world_id.as_str(), &a.source_id.as_str(), &a.partition, &end.get::<_, i64>("sequence"), &limit]).await?;
        if rows.len() as u64 > budget.max_steps {
            return Err(world_protocol::sources::MappingFailure::BudgetExceeded { dimension: world_protocol::budget::BudgetDimension::Steps }.into());
        }
        let mut entries = Vec::with_capacity(rows.len());
        let mut bytes = 0u64;
        for row in rows {
            if cancel.is_cancelled() { return Err(world_protocol::sources::MappingFailure::Cancelled.into()); }
            let entry = captured_entry(&row)?;
            bytes = bytes.saturating_add(serde_json::to_vec(&entry.0).map_err(|cause| SyncError::codec(FailureStage::Decode, cause))?.len() as u64);
            if bytes > budget.max_bytes {
                return Err(world_protocol::sources::MappingFailure::BudgetExceeded { dimension: world_protocol::budget::BudgetDimension::Bytes }.into());
            }
            entries.push(entry);
        }
        validate_complete(&entries)?;
        let pending: Vec<_> = entries.iter().map(|(entry, digest)| (
            entry.input.event_id.as_str(), digest.as_str(), &entry.input.position,
        )).collect();
        let digest = crate::definitions::canonical_digest(&("world.source.apply.v2", &pending, &plan.digest))
            .map_err(|_| SyncError::protocol())?;
        Ok(Some(Self { entries, digest }))
    }
    pub(super) async fn verified(
        &self, tx: &WorldTransaction<'_>, a: &Assignment, checkpoint: &Checkpoint,
    ) -> Result<Vec<StoredInput>, SyncError> {
        let expected = checkpoint.applied_sequence.map_or(Some(0), |n| n.checked_add(1))
            .ok_or_else(SyncError::protocol)?;
        if self.entries.first().map(|entry| entry.0.input.sequence) != Some(expected) {
            return Err(SyncError::protocol());
        }
        let end = self.entries.last().ok_or_else(SyncError::protocol)?.0.input.sequence;
        let rows = tx.query("SELECT * FROM world_source_inbox WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 AND partition_key=$4 AND status='captured' AND sequence<=$5 ORDER BY sequence FOR UPDATE", &[&a.world.tenant_id.as_str(), &a.world.world_id.as_str(), &a.source_id.as_str(), &a.partition, &number(end)?]).await?;
        if rows.len() != self.entries.len() { return Err(SyncError::protocol()); }
        let mut entries = Vec::with_capacity(rows.len());
        for (row, saved) in rows.into_iter().zip(&self.entries) {
            let entry = captured_entry(&row)?;
            if &entry != saved { return Err(SyncError::protocol()); }
            if !a.continues(&entry.0.raw.assignment) {
                return Err(super::source_failure(SourceFailure::CheckpointIncompatible { format: a.format.clone() }, FailureStage::Validate));
            }
            entries.push(StoredInput::verified(tx, entry.0.input, entry.0.raw, &entry.1).await?);
        }
        Ok(entries)
    }
}

fn captured_entry(row: &tokio_postgres::Row) -> Result<(Entry, String), SyncError> {
    let entry: Entry = decode(row.get("body"))?;
    let (transaction, complete) = match &entry.input.kind {
        CaptureKind::Snapshot { .. } => (None, true),
        CaptureKind::Changes { transaction, complete } => (transaction.as_deref(), *complete),
    };
    if entry.input.event_id.as_str() != row.get::<_, String>("event_id")
        || number(entry.input.sequence)? != row.get::<_, i64>("sequence")
        || number(entry.raw.assignment.epoch.0)? != row.get::<_, i64>("partition_epoch")
        || entry.input.position != decode::<SourcePosition>(row.get("position"))?
        || entry.input.position.format.as_str() != row.get::<_, String>("checkpoint_format")
        || row.get::<_, Option<String>>("transaction_id").as_deref() != transaction
        || row.get::<_, bool>("transaction_complete") != complete
        || row.get::<_, String>("status") != "captured"
    { return Err(SyncError::protocol()); }
    Ok((entry, row.get("input_digest")))
}

fn validate_complete(entries: &[(Entry, String)]) -> Result<(), SyncError> {
    let first = &entries.first().ok_or_else(SyncError::protocol)?.0.input;
    let mut sequence = first.sequence;
    for (index, (entry, _)) in entries.iter().enumerate() {
        if entry.input.sequence != sequence { return Err(SyncError::protocol()); }
        sequence = sequence.checked_add(1).ok_or_else(SyncError::protocol)?;
        let last = index + 1 == entries.len();
        match (&first.kind, &entry.input.kind) {
            (CaptureKind::Snapshot { .. }, CaptureKind::Snapshot { .. }) if entries.len() == 1 => {},
            (CaptureKind::Changes { transaction: expected, .. }, CaptureKind::Changes { transaction, complete })
                if transaction == expected && *complete == last && (last || transaction.is_some()) => {},
            _ => return Err(super::source_failure(SourceFailure::IncompleteTransaction, FailureStage::Validate)),
        }
    }
    Ok(())
}

pub(crate) async fn capture(
    tx: &WorldTransaction<'_>,
    content: &Content,
    admission: &Admission,
    assignment: &Assignment,
    prepared: &PreparedCapture,
) -> Result<CaptureReceipt, SyncError> {
    let now = authorize(tx, admission, assignment, AccessMode::Write).await?;
    partition::running(tx, assignment).await?;
    if prepared.raw.assignment != *assignment {
        return Err(SyncError::protocol());
    }
    content
        .register_source_version(tx, &prepared.blob, &prepared.version)
        .await?;
    persist_capture(
        tx,
        assignment,
        &prepared.raw,
        &prepared.version.reference,
        &prepared.digest,
        &prepared.event_id,
        &now,
    )
    .await
}

pub(super) async fn capture_branch(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    assignment: &Assignment,
    capture: &super::BranchCapture,
    run: &RunId,
) -> Result<StoredInput, SyncError> {
    let now = authorize(tx, admission, assignment, AccessMode::Write).await?;
    let partition = partition::locked(tx, assignment).await?;
    if partition.state != super::model::PartitionState::Sealed
        || !partition.reader_stopped
        || !partition.ack_stopped
    {
        return Err(SyncError::protocol());
    }
    let position = match &capture.dto.basis.position {
        Some(position) => position.clone(),
        None => super::trusted::snapshot_position(assignment, run, 0)?,
    };
    let raw = RawCapture {
        assignment: assignment.clone(),
        page: capture.raw.page.clone(),
        deletions: Vec::new(),
        valid_time: capture.raw.valid_time.clone(),
        kind: CaptureKind::Snapshot {
            run: run.clone(),
            chunk: 0,
            complete: capture.dto.complete,
            consistent: capture.dto.consistent,
        },
        position,
        raw_source: super::branch_capture::raw_bytes(&capture.raw)?,
        branch_capture: Some(capture.dto.digest.clone()),
    };
    let event = EventId::try_new(capture.dto.digest.as_str().replace(':', "-"))
        .map_err(|_| SyncError::protocol())?;
    let receipt = persist_capture(
        tx,
        assignment,
        &raw,
        &capture.version.reference,
        &capture.version.blob.digest,
        &event,
        &now,
    )
    .await?;
    let input = CapturedInput {
        event_id: event,
        sequence: receipt.sequence,
        source_version: capture.version.reference.clone(),
        basis: raw.page.basis.clone(),
        valid_time: raw.valid_time.clone(),
        rows: raw.page.rows.clone(),
        deletions: Vec::new(),
        kind: raw.kind.clone(),
        position: raw.position.clone(),
        gap: raw.page.basis.gap.clone(),
    };
    StoredInput::verified(tx, input, raw, capture.version.blob.digest.as_str()).await
}

async fn persist_capture(
    tx: &WorldTransaction<'_>,
    assignment: &Assignment,
    raw: &RawCapture,
    version: &world_protocol::materials::SourceVersionRef,
    digest: &Digest,
    event: &EventId,
    now: &world_protocol::time::Timestamp,
) -> Result<CaptureReceipt, SyncError> {
    let mut checkpoint = partition::load(tx, assignment).await?;
    let duplicate = tx.query_opt("SELECT input_digest,body FROM world_source_inbox WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 AND partition_key=$4 AND event_id=$5", &[&assignment.world.tenant_id.as_str(), &assignment.world.world_id.as_str(), &assignment.source_id.as_str(), &assignment.partition, &event.as_str()]).await?;
    if let Some(row) = duplicate {
        let entry: Entry = decode(row.get("body"))?;
        if entry.raw.position != raw.position
            || entry.raw.page != raw.page
            || entry.raw.deletions != raw.deletions
            || entry.raw.raw_source != raw.raw_source
            || entry.raw.branch_capture != raw.branch_capture
            || entry.raw.valid_time != raw.valid_time
            || entry.raw.kind != raw.kind
            || entry.input.source_version != *version
            || row.get::<_, String>("input_digest") != digest.as_str()
        {
            return Err(SyncError::protocol());
        }
        return Ok(CaptureReceipt {
            event: event.clone(),
            sequence: entry.input.sequence,
            checkpoint,
            duplicate: true,
        });
    }
    let sequence = checkpoint
        .captured_sequence
        .map_or(Some(0), |n| n.checked_add(1))
        .ok_or_else(SyncError::protocol)?;
    let input = CapturedInput {
        event_id: event.clone(),
        sequence,
        source_version: version.clone(),
        basis: raw.page.basis.clone(),
        valid_time: raw.valid_time.clone(),
        rows: raw.page.rows.clone(),
        deletions: raw.deletions.clone(),
        kind: raw.kind.clone(),
        position: raw.position.clone(),
        gap: raw.page.basis.gap.clone(),
    };
    let (transaction, complete) = match &input.kind {
        CaptureKind::Snapshot { .. } => (None, true),
        CaptureKind::Changes {
            transaction,
            complete,
        } => (transaction.clone(), *complete),
    };
    tx.execute("INSERT INTO world_source_inbox(tenant_id,world_id,source_id,partition_key,partition_epoch,event_id,input_digest,sequence,transaction_id,transaction_complete,checkpoint_format,position,body,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'captured')", &[&assignment.world.tenant_id.as_str(), &assignment.world.world_id.as_str(), &assignment.source_id.as_str(), &assignment.partition, &number(assignment.epoch.0)?, &input.event_id.as_str(), &digest.as_str(), &number(sequence)?, &transaction, &complete, &input.position.format.as_str(), &encode(&input.position)?, &encode(&Entry { input: input.clone(), raw: raw.clone() })?]).await?;
    if let CaptureKind::Snapshot { run, .. } = &input.kind {
        super::snapshot::capture_members(tx, assignment, run, &input.rows).await?;
    }
    checkpoint.source.captured = Some(input.position.clone());
    checkpoint.captured_sequence = Some(sequence);
    if input.gap.is_some() {
        checkpoint.source.gap = input.gap.clone();
    }
    save_checkpoint(tx, assignment, &mut checkpoint, &now).await?;
    Ok(CaptureReceipt {
        event: input.event_id,
        sequence,
        checkpoint,
        duplicate: false,
    })
}

pub(super) async fn apply_branch(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    a: &Assignment,
    entry: &StoredInput,
) -> Result<(), SyncError> {
    let now = authorize(tx, admission, a, AccessMode::Write).await?;
    let p = partition::locked(tx, a).await?;
    let mut checkpoint = partition::load(tx, a).await?;
    let expected = checkpoint
        .applied_sequence
        .map_or(Some(0), |n| n.checked_add(1))
        .ok_or_else(SyncError::protocol)?;
    if p.state != super::model::PartitionState::Sealed
        || !p.reader_stopped
        || !p.ack_stopped
        || entry.raw.assignment != *a
        || entry.raw.branch_capture.is_none()
        || !matches!(
            &entry.input.kind,
            CaptureKind::Snapshot {
                complete: true,
                consistent: true,
                ..
            }
        )
        || expected != entry.input.sequence
        || checkpoint.captured_sequence != Some(entry.input.sequence)
    {
        return Err(SyncError::protocol());
    }
    changed(tx.execute("UPDATE world_source_inbox SET status='applied',applied_commit_id=$6,applied_at=clock_timestamp() WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 AND partition_key=$4 AND event_id=$5 AND status='captured' AND partition_epoch=$7 AND sequence=$8", &[&a.world.tenant_id.as_str(), &a.world.world_id.as_str(), &a.source_id.as_str(), &a.partition, &entry.input.event_id.as_str(), &tx.commit_id().as_str(), &number(a.epoch.0)?, &number(entry.input.sequence)?]).await?, a)?;
    checkpoint.source.applied = Some(entry.input.position.clone());
    checkpoint.applied_sequence = Some(entry.input.sequence);
    checkpoint.source.gap = None;
    save_checkpoint(tx, a, &mut checkpoint, &now).await
}

pub(crate) async fn pending(
    tx: &WorldTransaction<'_>,
    assignment: &Assignment,
    limit: u32,
) -> Result<Vec<CapturedInput>, SyncError> {
    if tx.world() != &assignment.world || limit == 0 || limit > 4096 {
        return Err(SyncError::protocol());
    }
    let rows = tx.query("SELECT body FROM world_source_inbox WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 AND partition_key=$4 AND status='captured' ORDER BY sequence LIMIT $5", &[&assignment.world.tenant_id.as_str(), &assignment.world.world_id.as_str(), &assignment.source_id.as_str(), &assignment.partition, &i64::from(limit)]).await?;
    rows.into_iter()
        .map(|row| decode::<Entry>(row.get("body")).map(|e| e.input))
        .collect()
}

pub(super) async fn prepare_identities(
    tx: &WorldTransaction<'_>, admission: &Admission, assignment: &Assignment,
    plan: &CompiledSourcePlan, prefix: &CapturedPrefix, accounting: &CallBudget,
    cancel: &CancellationToken,
) -> Result<Option<crate::identity::PreparedSourceIdentities>, SyncError> {
    let now = authorize(tx, admission, assignment, AccessMode::Write).await?;
    super::identity::lock_datasets(tx, assignment, plan).await?;
    partition::running(tx, assignment).await?;
    let checkpoint = partition::load(tx, assignment).await?;
    let entries = prefix.verified(tx, assignment, &checkpoint).await?;
    if backward_input(tx, assignment, &checkpoint, &entries).await?.is_some() { return Ok(None); }
    super::snapshot::validate_plan(tx, plan).await?;
    super::identity::lock_keys(tx, assignment, &entries, plan).await?;
    let prefix = super::SourceIdentityPrefix::verified(assignment, &entries, plan, prefix.digest())?;
    Ok(Some(crate::identity::prepare_source_identities(
        tx, admission, &prefix, &now, accounting, cancel,
    ).await?))
}

async fn backward_input<'a>(
    tx: &WorldTransaction<'_>, a: &Assignment, checkpoint: &Checkpoint, entries: &'a [StoredInput],
) -> Result<Option<&'a StoredInput>, SyncError> {
    let mut last_time = if let Some(sequence) = checkpoint.applied_sequence {
        let row = tx.query_opt("SELECT body FROM world_source_inbox WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 AND partition_key=$4 AND sequence=$5 AND status='applied' ORDER BY partition_epoch DESC LIMIT 1", &[&a.world.tenant_id.as_str(), &a.world.world_id.as_str(), &a.source_id.as_str(), &a.partition, &number(sequence)?]).await?.ok_or_else(SyncError::protocol)?;
        Some(decode::<Entry>(row.get("body"))?.input.valid_time.from)
    } else { None };
    for entry in entries {
        if last_time.as_ref().is_some_and(|last| &entry.input.valid_time.from < last) {
            return Ok(Some(entry));
        }
        last_time = Some(entry.input.valid_time.from.clone());
    }
    Ok(None)
}

/// Applies only the exact durable prefix prepared before the identity invocation.
pub(super) async fn apply(
    tx: &mut WorldTransaction<'_>,
    content: &Content,
    admission: &Admission,
    assignment: &Assignment,
    plan: &CompiledSourcePlan,
    prefix: &CapturedPrefix,
    prepared: Option<&crate::identity::PreparedSourceIdentities>,
    proposals: &[IdentityProposal],
    budget: &Budget,
    accounting: &CallBudget,
    cancel: &CancellationToken,
) -> Result<ApplyReceipt, SyncError> {
    let now = authorize(tx, admission, assignment, AccessMode::Write).await?;
    super::identity::lock_datasets(tx, assignment, plan).await?;
    partition::running(tx, assignment).await?;
    let mut checkpoint = partition::load(tx, assignment).await?;
    let entries = prefix.verified(tx, assignment, &checkpoint).await?;
    if let Some(entry) = backward_input(tx, assignment, &checkpoint, &entries).await? {
            super::record_state::needs_reconcile(tx, admission, assignment, entry, plan).await?;
            checkpoint.source.gap = Some(world_protocol::sources::SourceGap {
                reason: world_protocol::sources::GapReason::IncompleteEnumeration,
                after: checkpoint.source.applied.clone(),
                before: Some(entry.input.position.clone()),
            });
            save_checkpoint(tx, assignment, &mut checkpoint, &now).await?;
            return Ok(ApplyReceipt {
                events: Vec::new(),
                checkpoint,
                failures: vec![world_protocol::sources::FieldMappingFailure {
                    row: 0,
                    field: None,
                    failure: world_protocol::sources::MappingFailure::RevisionMismatch,
                }],
            });
    }
    let mut events = Vec::with_capacity(entries.len());
    let mut failures = Vec::new();
    super::snapshot::validate_plan(tx, plan).await?;
    super::identity::lock_keys(tx, assignment, &entries, plan).await?;
    let identity_prefix = super::SourceIdentityPrefix::verified(assignment, &entries, plan, prefix.digest())?;
    let prepared = prepared.ok_or_else(SyncError::protocol)?;
    crate::identity::recheck_source_identities(
        tx, admission, &identity_prefix, prepared, &now, accounting, cancel,
    ).await?;
    let complete = CompleteInput::transaction(&entries);
    for deletion in identity_prefix.deletions() {
                super::branch_sources::check(accounting, cancel)?;
                let receipt = crate::identity::resolve_in_transaction(tx, deletion.key(), deletion.scope()).await?;
                let retraction = super::claims::SourceRetraction::from_delete(
                    tx, assignment, deletion, plan, std::slice::from_ref(&receipt),
                ).await?;
                super::claims::retract(tx, content, admission, &retraction, accounting, cancel).await?;
                crate::identity::close_source_aliases(
                    tx, admission, std::slice::from_ref(deletion), &now, accounting, cancel,
                ).await?;
    }
    let actual_identities = crate::identity::accept_source_identities(
        tx, admission, &identity_prefix, prepared, proposals, &now, accounting, cancel,
    ).await?;
    for input in &complete {
            super::branch_sources::check(accounting, cancel)?;
            let entry = input.input();
            // Stored binding/plan bodies remain canonical; wire CompiledSourcePlan cannot grant authority.
            let schema = mapping::read_schema(tx, &entry.input.basis.schema)
                .await?
                .ok_or_else(SyncError::protocol)?;
            let trusted = entry
                .records(
                    tx,
                    input,
                    plan.clone(),
                    schema,
                    actual_identities.clone(),
                    budget.clone(),
                )
                .await?;
            let mapped = mapping::map_records(&trusted, cancel)?;
            super::record_state::available(tx, admission, assignment, entry, input.rows(), plan).await?;
            for evidence in &mapped.result().evidence {
                if let Some(existing) = assertions::read_evidence(tx, &evidence.reference).await? {
                    if existing != *evidence {
                        return Err(SyncError::protocol());
                    }
                } else {
                    assertions::append_evidence(
                        tx,
                        content,
                        None,
                        admission,
                        &assignment.scope,
                        evidence,
                        accounting,
                        cancel,
                    )
                    .await?;
                }
            }
            for index in 0..mapped.result().observations.len() {
                let observation = mapped.observation(index).ok_or_else(SyncError::protocol)?;
                let id = super::claims::assertion_id(assignment, &observation)?;
                let assertions = assertions::admit_mapped_observation(
                    tx,
                    admission,
                    id,
                    &observation,
                    accounting,
                    cancel,
                )
                .await?;
                for assertion in assertions {
                    super::claims::record(tx, assignment, &observation, &assertion).await?;
                }
            }
            failures.extend(mapped.result().failures.iter().cloned());
            changed(tx.execute("UPDATE world_source_inbox SET status='applied',applied_commit_id=$6,applied_at=clock_timestamp() WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 AND partition_key=$4 AND event_id=$5 AND status='captured'", &[&assignment.world.tenant_id.as_str(), &assignment.world.world_id.as_str(), &assignment.source_id.as_str(), &assignment.partition, &entry.input.event_id.as_str(), &tx.commit_id().as_str()]).await?, assignment)?;
            checkpoint.source.applied = Some(entry.input.position.clone());
            checkpoint.applied_sequence = Some(entry.input.sequence);
            events.push(entry.input.event_id.clone());
    }
    if !events.is_empty() {
        save_checkpoint(tx, assignment, &mut checkpoint, &now).await?;
    }
    Ok(ApplyReceipt {
        events,
        checkpoint,
        failures,
    })
}

/// This records a carrier's confirmed external ACK, never an intention to ACK.
pub(crate) async fn acknowledge(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    assignment: &Assignment,
    ack: &crate::sources::connectors::cdc::Acknowledged,
) -> Result<Checkpoint, SyncError> {
    let now = authorize(tx, admission, assignment, AccessMode::Write).await?;
    let _ = partition::locked(tx, assignment).await?;
    let mut checkpoint = partition::load(tx, assignment).await?;
    if ack.assignment() != assignment || Some(ack.sequence()) > checkpoint.applied_sequence {
        return Err(SyncError::protocol());
    }
    if checkpoint
        .acknowledged_sequence
        .is_some_and(|n| n >= ack.sequence())
    {
        return Ok(checkpoint);
    }
    checkpoint.acknowledged_sequence = Some(ack.sequence());
    checkpoint.source.acknowledged = Some(ack.position().clone());
    save_checkpoint(tx, assignment, &mut checkpoint, &now).await?;
    Ok(checkpoint)
}

pub(super) async fn save_checkpoint(
    tx: &WorldTransaction<'_>,
    a: &Assignment,
    checkpoint: &mut Checkpoint,
    now: &world_protocol::time::Timestamp,
) -> Result<(), SyncError> {
    let expected = checkpoint.revision;
    checkpoint.revision = Revision(expected.0.checked_add(1).ok_or_else(SyncError::protocol)?);
    let position = |p: &Option<SourcePosition>| p.as_ref().map(encode).transpose();
    let sequence = |n: Option<u64>| n.map(number).transpose();
    changed(tx.execute("UPDATE world_source_checkpoint SET revision=$6,captured=$7,applied=$8,acknowledged=$9,projected=$10,captured_sequence=$11,applied_sequence=$12,acknowledged_sequence=$13,projected_sequence=$14,gap=$15,updated_at=$16::text::timestamptz WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 AND partition_key=$4 AND partition_epoch=$5 AND revision=$17", &[&a.world.tenant_id.as_str(), &a.world.world_id.as_str(), &a.source_id.as_str(), &a.partition, &number(a.epoch.0)?, &number(checkpoint.revision.0)?, &position(&checkpoint.source.captured)?, &position(&checkpoint.source.applied)?, &position(&checkpoint.source.acknowledged)?, &position(&checkpoint.source.projected)?, &sequence(checkpoint.captured_sequence)?, &sequence(checkpoint.applied_sequence)?, &sequence(checkpoint.acknowledged_sequence)?, &sequence(checkpoint.projected_sequence)?, &checkpoint.source.gap.as_ref().map(encode).transpose()?, &now.as_str(), &number(expected.0)?]).await?, a)
}
