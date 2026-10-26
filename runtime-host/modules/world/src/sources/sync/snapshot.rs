use super::{
    Assignment, CaptureKind, Checkpoint, PreparedCapture, SyncError, SyncIdentity, authorize,
    decode, encode, number,
};
use crate::{
    authorization::Admission,
    content::Content,
    extensions::invocation::CallBudget,
    facts::assertions,
    sources::{connectors::SourceBroker, mapping},
    store::{CommitRequest, StoreFuture, WorldStore, WorldTransaction},
};
use foundation::pipeline::PipelineContext;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use world_protocol::{
    authorization::AccessMode,
    budget::Budget,
    definitions::{Definition, DefinitionBody},
    ids::*,
    sources::{
        CompileSourceRequest, CompiledSourcePlan, GapReason, SourceGap, SourceReadPlan, SourceRow,
    },
    time::{Timestamp, ValidTime},
};

#[derive(Clone)]
pub(crate) struct SnapshotRun {
    pub execution: crate::owner::ExecutionContext,
    pub store: Arc<WorldStore>,
    pub content: Arc<Content>,
    pub broker: Arc<SourceBroker>,
    pub assignment: Assignment,
    pub admission: Admission,
    pub pipeline: PipelineContext,
    pub identity: SyncIdentity,
    pub plan: CompiledSourcePlan,
    pub read: SourceReadPlan,
    pub budget: Budget,
    pub accounting: CallBudget,
    pub storage_epoch: WriterEpoch,
    pub fences: Vec<world_protocol::commit::WriteFence>,
    pub run: RunId,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct SnapshotOutcome {
    assignment: Assignment,
    run: RunId,
    basis: world_protocol::sources::SourceBasis,
    pub checkpoint: Checkpoint,
    pub pages: u64,
    pub rows: u64,
    pub failures: Vec<world_protocol::sources::FieldMappingFailure>,
    pub reconciled: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct ReconcileState {
    pub assignment: Assignment,
    pub valid_time: ValidTime,
    pub complete: bool,
    pub consistent: bool,
    pub snapshot: Option<String>,
    pub gap: Option<SourceGap>,
}
#[derive(Clone)]
pub(super) struct CompleteSnapshot {
    run: RunId,
    state: ReconcileState,
}
impl CompleteSnapshot {
    pub(super) fn valid_time(&self) -> &ValidTime {
        &self.state.valid_time
    }
    pub(super) fn basis(&self, plan: &CompiledSourcePlan) -> world_protocol::sources::SourceBasis {
        let a = &self.state.assignment;
        world_protocol::sources::SourceBasis {
            source_id: a.source_id.clone(),
            incarnation: a.incarnation.clone(),
            binding: a.binding.clone(),
            mapping_revision: a.mapping.revision,
            authority_revision: plan.authority.authority.revision,
            schema: a.schema.clone(),
            identity_rule: a.identity_rule.clone(),
            field_definitions: plan
                .field_definitions
                .iter()
                .map(|d| d.reference.clone())
                .collect(),
            position: None,
            snapshot: self.state.snapshot.clone(),
            observed_at: self.state.valid_time.from.clone(),
            captured_at: Some(self.state.valid_time.from.clone()),
            last_reconciled_at: None,
            guarantee: world_protocol::sources::SourceGuarantee::Authoritative,
            gap: self.state.gap.clone(),
        }
    }
    pub(super) async fn require_missing(
        &self,
        tx: &WorldTransaction<'_>,
        a: &Assignment,
        key: &str,
        incarnation: &str,
    ) -> Result<(), SyncError> {
        if self.state.assignment != *a
            || !self.state.complete
            || !self.state.consistent
            || self.state.gap.is_some()
        {
            return Err(SyncError::protocol());
        }
        let row = tx.query_opt("SELECT phase,basis FROM world_source_reconcile WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 AND partition_key=$4 AND run_id=$5 FOR SHARE", &[&a.world.tenant_id.as_str(), &a.world.world_id.as_str(), &a.source_id.as_str(), &a.partition, &self.run.as_str()]).await?.ok_or_else(SyncError::protocol)?;
        let state: ReconcileState = decode(row.get("basis"))?;
        if !matches!(
            row.get::<_, String>("phase").as_str(),
            "capturing" | "complete"
        ) || state.assignment != self.state.assignment
            || state.valid_time != self.state.valid_time
            || state.snapshot != self.state.snapshot
            || !state.complete
            || !state.consistent
            || state.gap.is_some()
        {
            return Err(SyncError::protocol());
        }
        let row = tx.query_opt("SELECT 1 FROM world_source_snapshot_member WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 AND partition_key=$4 AND run_id=$5 AND native_key=$6 AND record_incarnation=$7", &[&a.world.tenant_id.as_str(), &a.world.world_id.as_str(), &a.source_id.as_str(), &a.partition, &self.run.as_str(), &key, &incarnation]).await?;
        if row.is_some() {
            return Err(SyncError::protocol());
        }
        Ok(())
    }
}
/// Reconcile output is accepted only while its exact durable assignment and completed scan remain current.
pub(crate) async fn validate_snapshot_outcome(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    binding: &DefinitionRef,
    outcome: &SnapshotOutcome,
    now: &Timestamp,
) -> Result<(), SyncError> {
    let a = &outcome.assignment;
    if &a.binding != binding
        || !outcome.reconciled
        || !outcome.failures.is_empty()
        || outcome.checkpoint.source.gap.is_some()
        || outcome.basis.gap.is_some()
    {
        return Err(SyncError::protocol());
    }
    authorize(tx, admission, a, AccessMode::Read).await?;
    let partition = super::partition::locked(tx, a).await?;
    if partition.assignment != *a || super::partition::load(tx, a).await? != outcome.checkpoint {
        return Err(SyncError::protocol());
    }
    let row = tx.query_opt("SELECT phase,basis FROM world_source_reconcile WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 AND partition_key=$4 AND run_id=$5 FOR SHARE", &[&a.world.tenant_id.as_str(), &a.world.world_id.as_str(), &a.source_id.as_str(), &a.partition, &outcome.run.as_str()]).await?.ok_or_else(SyncError::protocol)?;
    let state: ReconcileState = decode(row.get("basis"))?;
    if row.get::<_, String>("phase") != "complete"
        || state.assignment != *a
        || !state.complete
        || !state.consistent
        || state.gap.is_some()
        || state.snapshot.is_none()
        || state.snapshot != outcome.basis.snapshot
    {
        return Err(SyncError::protocol());
    }
    super::frontier::recheck_basis(tx, &outcome.basis).await?;
    crate::authorization::recheck(tx, admission, now).await?;
    Ok(())
}

impl SnapshotRun {
    pub(crate) fn run<'a>(
        &'a self,
        cancel: CancellationToken,
        deadline: Instant,
    ) -> StoreFuture<'a, SnapshotOutcome, SyncError> {
        self.run_with_gap(cancel, deadline, None)
    }
    pub(super) fn run_with_gap<'a>(
        &'a self,
        cancel: CancellationToken,
        deadline: Instant,
        continuity_gap: Option<SourceGap>,
    ) -> StoreFuture<'a, SnapshotOutcome, SyncError> {
        Box::pin(async move {
            let mut carrier = self
                .broker
                .open_sync_snapshot(
                    self.read.clone(),
                    self.assignment.clone(),
                    &self.admission,
                    &self.pipeline,
                    cancel.clone(),
                    deadline,
                    self.accounting.clone(),
                )
                .await?;
            let result = self.run_pages(cancel, &mut carrier, continuity_gap).await;
            match carrier.close(deadline).await {
                Ok(()) => result,
                Err(cleanup) => Err(match result {
                    Ok(_) => SyncError::Source(cleanup),
                    Err(error) => SyncError::Cleanup {
                        error: Box::new(error),
                        cleanup,
                    },
                }),
            }
        })
    }
    fn run_pages<'a>(
        &'a self,
        cancel: CancellationToken,
        carrier: &'a mut crate::sources::connectors::cdc::SourceSnapshot,
        continuity_gap: Option<SourceGap>,
    ) -> StoreFuture<'a, SnapshotOutcome, SyncError> {
        Box::pin(async move {
            let mut read = self.read.clone();
            read.continuation = None;
            if read.binding != self.assignment.binding
                || self.plan.binding != read.binding
                || read.resource != self.plan.binding_body.resource
            {
                return Err(SyncError::protocol());
            }
            let mut pages = 0u64;
            let mut rows = 0u64;
            let mut failures = Vec::new();
            let mut final_checkpoint = None;
            let mut final_basis = None;
            let mut reconciled = false;
            let mut snapshot_token = None;
            let mut consistent_scan = true;
            loop {
                if cancel.is_cancelled() || self.pipeline.is_cancelled() {
                    return Err(super::source_failure(
                        world_protocol::sources::SourceFailure::Cancelled,
                        world_protocol::failure::FailureStage::Read,
                    ));
                }
                let read_page = carrier
                    .next_trusted()
                    .await?
                    .ok_or_else(SyncError::protocol)?;
                let page = read_page.page();
                let valid_time = ValidTime::try_new(page.basis.observed_at.clone(), None)
                    .map_err(|_| SyncError::protocol())?;
                if pages == 0 {
                    snapshot_token = page.basis.snapshot.clone();
                }
                consistent_scan &= snapshot_token.is_some()
                    && page.basis.snapshot == snapshot_token
                    && page.basis.gap.is_none();
                let consistent = consistent_scan
                    && self.read.predicate.is_none()
                    && self
                        .read
                        .fields
                        .iter()
                        .map(String::as_str)
                        .collect::<std::collections::BTreeSet<_>>()
                        == self
                            .plan
                            .binding_body
                            .selected_fields
                            .iter()
                            .map(|field| field.as_str())
                            .collect::<std::collections::BTreeSet<_>>();
                let kind = CaptureKind::Snapshot {
                    run: self.run.clone(),
                    chunk: pages,
                    complete: page.complete,
                    consistent,
                };
                let position = match &page.basis.position {
                    Some(position) => position.clone(),
                    None => super::trusted::snapshot_position(&self.assignment, &self.run, pages)?,
                };
                let prepared = Arc::new(PreparedCapture::from_read(
                    &self.content,
                    &self.assignment,
                    &read_page,
                    &self.identity,
                    valid_time.clone(),
                    kind,
                    position,
                    &cancel,
                )?);
                final_basis = Some(page.basis.clone());
                let source_rows = page.rows.clone();
                let continuation = page.continuation.clone();
                let state = ReconcileState {
                    assignment: self.assignment.clone(),
                    valid_time,
                    complete: page.complete && continuation.is_none(),
                    consistent,
                    snapshot: page.basis.snapshot.clone(),
                    gap: page.basis.gap.clone(),
                };
                let captured = self.capture_page(pages, &prepared, &state, &continuity_gap).await?;
                let applied = self
                    .apply_captured_page(pages, &prepared.digest, &captured.value, &cancel, &mut failures)
                    .await?;
                rows = rows
                    .checked_add(source_rows.len() as u64)
                    .ok_or_else(SyncError::protocol)?;
                failures.extend(applied.failures);
                final_checkpoint = Some(applied.checkpoint);
                pages = pages.checked_add(1).ok_or_else(SyncError::protocol)?;
                if let Some(next) = continuation {
                    read.continuation = Some(next);
                    continue;
                }
                // The carrier closes the source transaction and joins its driver before EOF.
                if carrier.next_trusted().await?.is_some() {
                    return Err(SyncError::protocol());
                }
                let completed = self
                    .reconcile_snapshot(pages, &prepared.digest, state, &cancel, &continuity_gap)
                    .await?;
                final_checkpoint = Some(completed.value.0);
                reconciled = completed.value.1;
                break;
            }
            Ok(SnapshotOutcome {
                assignment: self.assignment.clone(),
                run: self.run.clone(),
                basis: final_basis.ok_or_else(SyncError::protocol)?,
                checkpoint: final_checkpoint.ok_or_else(SyncError::protocol)?,
                pages,
                rows,
                failures,
                reconciled,
            })
        })
    }

    fn capture_page<'a>(
        &'a self,
        pages: u64,
        prepared: &'a Arc<PreparedCapture>,
        state: &'a ReconcileState,
        continuity_gap: &'a Option<SourceGap>,
    ) -> StoreFuture<'a, crate::store::Committed<super::model::CaptureReceipt>, SyncError> {
        Box::pin(async move {
            let capture_batch = self.commit("capture", pages, &prepared.digest)?;
            let content = self.content.clone();
            let admission = self.admission.clone();
            let a = self.assignment.clone();
            let input = prepared.clone();
            let state_to_save = state.clone();
            let gap_to_save = continuity_gap.clone();
            let run = self.run.clone();
            self.store.transact(capture_batch, move |tx| Box::pin(async move {
                let mut receipt = super::inbox::capture(tx, &content, &admission, &a, &input).await?;
                if let Some(gap) = gap_to_save {
                    receipt.checkpoint.source.gap = Some(gap);
                    super::inbox::save_checkpoint(tx, &a, &mut receipt.checkpoint, &tx.now().await?).await?;
                }
                tx.execute("INSERT INTO world_source_reconcile(tenant_id,world_id,source_id,partition_key,run_id,phase,basis,coverage,last_key) VALUES($1,$2,$3,$4,$5,'capturing',$6,$7,$8) ON CONFLICT(tenant_id,world_id,source_id,partition_key,run_id) DO UPDATE SET basis=excluded.basis,coverage=excluded.coverage,last_key=excluded.last_key", &[&a.world.tenant_id.as_str(), &a.world.world_id.as_str(), &a.source_id.as_str(), &a.partition, &run.as_str(), &encode(&state_to_save)?, &encode(&state_to_save)?, &input.raw.page.rows.last().map(|r| r.native_key.as_str())]).await?;
                Ok::<_, SyncError>(receipt)
            })).await.map_err(SyncError::from)
        })
    }

    fn apply_captured_page<'a>(
        &'a self,
        pages: u64,
        digest: &'a Digest,
        captured: &'a super::model::CaptureReceipt,
        cancel: &'a CancellationToken,
        failures: &'a mut Vec<world_protocol::sources::FieldMappingFailure>,
    ) -> StoreFuture<'a, super::model::ApplyReceipt, SyncError> {
        Box::pin(async move {
            let apply_request = self.commit_request("apply", pages, digest)?;
            let applied = if let Some(saved) = self.store.read_commit_optional::<super::model::ApplyReceipt>(
                &apply_request.world, &apply_request.commit_id, &apply_request.input_digest,
            ).await? {
                self.execution.recheck_replay(&saved).await?;
                saved.value
            } else {
                loop {
                    let prefix = self.next_prefix(cancel.clone()).await?.ok_or_else(SyncError::protocol)?;
                    let current = prefix.ends_at(&captured.event, captured.sequence);
                    let request = if current { apply_request.clone() } else { self.prefix_request(&prefix)? };
                    let applied = self.apply_prefix(prefix, request, cancel.clone()).await?;
                    if current { break applied; }
                    if applied.events.is_empty() { return Err(SyncError::protocol()); }
                    failures.extend(applied.failures);
                }
            };
            if !applied.events.contains(&captured.event) {
                return Err(super::source_failure(
                    world_protocol::sources::SourceFailure::Gap { reason: GapReason::IncompleteEnumeration },
                    world_protocol::failure::FailureStage::Validate,
                ));
            }
            Ok(applied)
        })
    }

    fn reconcile_snapshot<'a>(
        &'a self,
        pages: u64,
        digest: &'a Digest,
        state: ReconcileState,
        cancel: &'a CancellationToken,
        continuity_gap: &'a Option<SourceGap>,
    ) -> StoreFuture<'a, crate::store::Committed<(Checkpoint, bool)>, SyncError> {
        Box::pin(async move {
            let finish_batch = self.commit("reconcile", pages, digest)?;
            let a = self.assignment.clone();
            let admission = self.admission.clone();
            let run = self.run.clone();
            let content = self.content.clone();
            let plan = self.plan.clone();
            let cancel = cancel.clone();
            let accounting = self.accounting.clone();
            let continuity_gap = continuity_gap.clone();
            self.store.transact(finish_batch, move |tx| Box::pin(async move {
                let now = authorize(tx, &admission, &a, AccessMode::Write).await?;
                super::identity::lock_datasets(tx, &a, &plan).await?;
                let mut checkpoint = super::partition::load(tx, &a).await?;
                let proof = CompleteSnapshot { run: run.clone(), state: state.clone() };
                if state.complete && state.consistent && state.gap.is_none() {
                    let missing = tx.query("SELECT DISTINCT c.native_key,c.record_incarnation FROM world_source_claim c WHERE c.tenant_id=$1 AND c.world_id=$2 AND c.source_id=$3 AND c.partition_key=$4 AND NOT EXISTS(SELECT 1 FROM world_source_snapshot_member m WHERE m.tenant_id=c.tenant_id AND m.world_id=c.world_id AND m.source_id=c.source_id AND m.partition_key=c.partition_key AND m.run_id=$5 AND m.native_key=c.native_key AND m.record_incarnation=c.record_incarnation)", &[&a.world.tenant_id.as_str(), &a.world.world_id.as_str(), &a.source_id.as_str(), &a.partition, &run.as_str()]).await?;
                    for row in missing { let key: String = row.get("native_key"); let incarnation: String = row.get("record_incarnation"); let proof = super::claims::SourceRetraction::from_snapshot(tx, &a, &proof, &key, &incarnation, &plan, &[]).await?; super::claims::retract(tx, &content, &admission, &proof, &accounting, &cancel).await?; }
                    checkpoint.source.gap = continuity_gap;
                } else if checkpoint.source.gap.is_none() { checkpoint.source.gap = Some(SourceGap { reason: GapReason::IncompleteEnumeration, after: checkpoint.source.applied.clone(), before: None }); }
                let phase = if state.complete && state.consistent && state.gap.is_none() { "complete" } else { "partial" };
                tx.execute("UPDATE world_source_reconcile SET phase=$6,last_reconciled_at=$7::text::timestamptz WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 AND partition_key=$4 AND run_id=$5", &[&a.world.tenant_id.as_str(), &a.world.world_id.as_str(), &a.source_id.as_str(), &a.partition, &run.as_str(), &phase, &now.as_str()]).await?;
                super::inbox::save_checkpoint(tx, &a, &mut checkpoint, &now).await?;
                Ok::<_, SyncError>((checkpoint, phase == "complete"))
            })).await.map_err(SyncError::from)
        })
    }

    pub(super) fn commit(
        &self,
        phase: &str,
        page: u64,
        digest: &Digest,
    ) -> Result<crate::store::PreparedBatch, SyncError> {
        Ok(self.commit_request(phase, page, digest)?.prepare()?)
    }
    pub(super) fn commit_request(
        &self, phase: &str, page: u64, digest: &Digest,
    ) -> Result<CommitRequest, SyncError> {
        let id = crate::definitions::canonical_digest(&(
            "world.source.sync.commit.v1",
            &self.assignment.world,
            &self.assignment.source_id,
            &self.assignment.partition,
            &self.assignment.binding,
            self.assignment.epoch,
            &self.run,
            phase,
            page,
        ))
        .map_err(|_| SyncError::protocol())?;
        Ok(CommitRequest {
            world: self.assignment.world.clone(),
            commit_id: CommitId::try_new(id.as_str().replace(':', "-"))
                .map_err(|_| SyncError::protocol())?,
            input_digest: digest.clone(),
            storage_epoch: self.storage_epoch,
            fences: self.fences.clone(),
            watch_basis: Vec::new(),
        })
    }
}

/// Resolves an opaque source snapshot only through its durable capture lineage.
pub(crate) async fn snapshot_materials(
    tx: &WorldTransaction<'_>,
    basis: &world_protocol::sources::SourceBasis,
) -> Result<Vec<world_protocol::materials::SourceVersion>, SyncError> {
    super::frontier::recheck_basis(tx, basis).await?;
    let token = basis.snapshot.as_ref().ok_or_else(SyncError::protocol)?;
    let rows = tx.query("SELECT i.body,i.input_digest FROM world_source_reconcile r JOIN world_source_inbox i USING(tenant_id,world_id,source_id,partition_key) WHERE r.tenant_id=$1 AND r.world_id=$2 AND r.source_id=$3 AND r.phase='complete' AND r.basis->>'snapshot'=$4 AND i.body->'input'->'kind'->'Snapshot'->>'run'=r.run_id AND i.status='applied' AND i.transaction_complete ORDER BY i.partition_key,i.sequence", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &basis.source_id.as_str(), &token]).await?;
    let mut versions = Vec::new();
    for row in rows {
        let entry: super::inbox::Entry = decode(row.get("body"))?;
        if entry.input.basis.binding != basis.binding
            || entry.input.basis.incarnation != basis.incarnation
            || entry.input.basis.snapshot.as_ref() != Some(token)
        {
            return Err(SyncError::protocol());
        }
        let input = super::trusted::StoredInput::verified(
            tx,
            entry.input,
            entry.raw,
            &row.get::<_, String>("input_digest"),
        )
        .await?;
        if !versions
            .iter()
            .any(|version: &world_protocol::materials::SourceVersion| {
                version.reference == input.version.reference
            })
        {
            versions.push(input.version);
        }
    }
    if versions.is_empty() {
        return Err(SyncError::protocol());
    }
    Ok(versions)
}

pub(super) async fn capture_members(
    tx: &WorldTransaction<'_>,
    a: &Assignment,
    run: &RunId,
    rows: &[SourceRow],
) -> Result<(), SyncError> {
    for row in rows {
        tx.execute("INSERT INTO world_source_snapshot_member(tenant_id,world_id,source_id,partition_key,run_id,native_key,record_incarnation) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING", &[&a.world.tenant_id.as_str(), &a.world.world_id.as_str(), &a.source_id.as_str(), &a.partition, &run.as_str(), &row.native_key, &row.incarnation]).await?;
    }
    Ok(())
}
pub(super) async fn branch_complete(
    tx: &WorldTransaction<'_>,
    a: &Assignment,
    run: &RunId,
    capture: &super::BranchCapture,
) -> Result<CompleteSnapshot, SyncError> {
    if !capture.dto.complete
        || !capture.dto.consistent
        || !capture.dto.failures.is_empty()
        || capture.dto.basis.gap.is_some()
    {
        return Err(SyncError::protocol());
    }
    let state = ReconcileState {
        assignment: a.clone(),
        valid_time: capture.raw.valid_time.clone(),
        complete: true,
        consistent: true,
        snapshot: capture.dto.basis.snapshot.clone(),
        gap: None,
    };
    let rows = tx.query("SELECT native_key,record_incarnation FROM world_source_snapshot_member WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 AND partition_key=$4 AND run_id=$5 ORDER BY native_key,record_incarnation", &[&a.world.tenant_id.as_str(), &a.world.world_id.as_str(), &a.source_id.as_str(), &a.partition, &run.as_str()]).await?;
    let members: std::collections::BTreeSet<_> = rows
        .into_iter()
        .map(|row| {
            (
                row.get::<_, String>("native_key"),
                row.get::<_, String>("record_incarnation"),
            )
        })
        .collect();
    let expected: std::collections::BTreeSet<_> = capture
        .raw
        .page
        .rows
        .iter()
        .map(|row| (row.native_key.clone(), row.incarnation.clone()))
        .collect();
    if members != expected || expected.len() != capture.raw.page.rows.len() {
        return Err(SyncError::protocol());
    }
    tx.execute("INSERT INTO world_source_reconcile(tenant_id,world_id,source_id,partition_key,run_id,phase,basis,coverage,last_key) VALUES($1,$2,$3,$4,$5,'capturing',$6,$6,$7)", &[&a.world.tenant_id.as_str(), &a.world.world_id.as_str(), &a.source_id.as_str(), &a.partition, &run.as_str(), &encode(&state)?, &capture.raw.page.rows.last().map(|row| row.native_key.as_str())]).await?;
    Ok(CompleteSnapshot {
        run: run.clone(),
        state,
    })
}

pub(super) async fn validate_plan(
    tx: &WorldTransaction<'_>,
    plan: &CompiledSourcePlan,
) -> Result<(), SyncError> {
    let binding = mapping::read_binding(tx, &plan.binding)
        .await?
        .ok_or_else(SyncError::protocol)?;
    let schema = mapping::read_schema(tx, &plan.schema.reference)
        .await?
        .ok_or_else(SyncError::protocol)?;
    let mapping_body = mapping::read_mapping(tx, &plan.mapping.reference)
        .await?
        .ok_or_else(SyncError::protocol)?;
    let authority = mapping::read_authority(tx, &plan.binding, &plan.authority.authority)
        .await?
        .ok_or_else(SyncError::protocol)?;
    let mut fields = Vec::new();
    let mut relations = Vec::new();
    for field in &plan.field_definitions {
        let d = mapping::published_definition(tx, &field.reference)
            .await?
            .ok_or_else(SyncError::protocol)?;
        let DefinitionBody::Property(body) = d.body else {
            return Err(SyncError::protocol());
        };
        fields.push(Definition {
            reference: d.reference,
            scope: d.scope,
            valid_time: d.valid_time,
            body,
            content_digest: d.content_digest,
            dependencies: d.dependencies,
            evidence: d.evidence,
            previous_ref: d.previous_ref,
            lifecycle: d.lifecycle,
        });
    }
    for relation in &plan.relation_definitions {
        let d = mapping::published_definition(tx, &relation.reference)
            .await?
            .ok_or_else(SyncError::protocol)?;
        let DefinitionBody::RelationType(body) = d.body else {
            return Err(SyncError::protocol());
        };
        relations.push(Definition {
            reference: d.reference,
            scope: d.scope,
            valid_time: d.valid_time,
            body,
            content_digest: d.content_digest,
            dependencies: d.dependencies,
            evidence: d.evidence,
            previous_ref: d.previous_ref,
            lifecycle: d.lifecycle,
        });
    }
    let actual = mapping::compile_plan(CompileSourceRequest {
        binding,
        schema,
        mapping: mapping_body,
        authority,
        field_definitions: fields,
        relation_definitions: relations,
    })?;
    if actual != *plan {
        return Err(SyncError::protocol());
    }
    Ok(())
}
