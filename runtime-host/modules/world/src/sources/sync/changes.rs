use super::{PreparedCapture, SnapshotRun, SourceCarriers, SyncError};
use crate::store::StoreFuture;
use foundation::execution::OwnedTask;
use std::{sync::Arc, time::Duration};
use tokio::{sync::Notify, time::Instant};
use tokio_util::sync::CancellationToken;
use world_protocol::{ids::*, sources::SourceFailure};

impl SnapshotRun {
    /// Both loops own and join the broker operations they start; COMMIT is never selected away.
    pub(crate) async fn start_changes(
        self: Arc<Self>,
        interval: Duration,
        deadline: Instant,
    ) -> Result<SourceCarriers, SyncError> {
        self.prepare_changes(self.pipeline.cancellation(), deadline)
            .await?;
        let has_ack = self
            .broker
            .has_ack_channel(&self.read, &self.admission)
            .await?;
        let wake = Arc::new(Notify::new());
        let reader_owner = self.clone();
        let reader_wake = wake.clone();
        let (reader, _) = OwnedTask::spawn(move |cancel| async move {
            loop {
                if cancel.is_cancelled() {
                    return Ok(());
                }
                let result = reader_owner.change_once(cancel.clone(), deadline).await;
                match result {
                    Ok(changed) => {
                        if changed {
                            reader_wake.notify_one();
                        }
                    }
                    Err(error) if cancelled(&error, &cancel) => return Ok(()),
                    Err(error) => return Err(error),
                }
                tokio::select! { _ = cancel.cancelled() => return Ok(()), _ = tokio::time::sleep(interval) => {} }
            }
        });
        let ack = if has_ack {
            let ack_owner = self.clone();
            let (ack, _) = OwnedTask::spawn(move |cancel| async move {
                loop {
                    if cancel.is_cancelled() {
                        return Ok(());
                    }
                    match ack_owner.ack_once(cancel.clone(), deadline).await {
                        Ok(()) => {}
                        Err(error) if cancelled(&error, &cancel) => return Ok(()),
                        Err(error) => return Err(error),
                    }
                    tokio::select! { _ = cancel.cancelled() => return Ok(()), _ = wake.notified() => {}, _ = tokio::time::sleep(interval) => {} }
                }
            });
            Some(ack)
        } else {
            None
        };
        Ok(SourceCarriers::new(self.assignment.clone(), reader, ack))
    }
    pub(super) async fn prepare_changes(
        &self,
        cancel: CancellationToken,
        deadline: Instant,
    ) -> Result<(), SyncError> {
        if self.assignment.format.as_str() != "postgres.wal2json.v2" {
            return Ok(());
        }
        let a = self.assignment.clone();
        let admission = self.admission.clone();
        let ready = self.store.snapshot(a.world.clone(), move |snapshot| Box::pin(async move {
            crate::authorization::recheck_read(snapshot, &admission, &snapshot.now().await?).await?;
            let row = snapshot.query_opt("SELECT p.body,c.captured_sequence,c.captured,c.gap,i.body AS input FROM world_source_partition p JOIN world_source_checkpoint c USING(tenant_id,world_id,source_id,partition_key) LEFT JOIN LATERAL (SELECT i.* FROM world_source_inbox i WHERE i.tenant_id=c.tenant_id AND i.world_id=c.world_id AND i.source_id=c.source_id AND i.partition_key=c.partition_key AND i.partition_epoch<=c.partition_epoch AND i.sequence=c.captured_sequence ORDER BY i.partition_epoch DESC LIMIT 1) i ON true WHERE p.tenant_id=$1 AND p.world_id=$2 AND p.source_id=$3 AND p.partition_key=$4 AND c.partition_epoch=$5", &[&a.world.tenant_id.as_str(), &a.world.world_id.as_str(), &a.source_id.as_str(), &a.partition, &super::number(a.epoch.0)?]).await?.ok_or_else(SyncError::protocol)?;
            let partition: super::model::Partition = super::decode(row.get("body"))?;
            if partition.assignment != a || partition.state != super::model::PartitionState::Running {
                return Err(SyncError::protocol());
            }
            let Some(input) = row.get::<_, Option<serde_json::Value>>("input") else {
                if row.get::<_, Option<i64>>("captured_sequence").is_some() || row.get::<_, Option<serde_json::Value>>("captured").is_some() {
                    return Err(SyncError::protocol());
                }
                return Ok(false);
            };
            let entry: super::inbox::Entry = super::decode(input)?;
            if entry.raw.page.basis.position.is_none() {
                return Ok(false);
            }
            if !a.continues(&entry.raw.assignment) {
                return Err(super::source_failure(SourceFailure::CheckpointIncompatible { format: a.format.clone() }, world_protocol::failure::FailureStage::Validate));
            }
            if row.get::<_, Option<serde_json::Value>>("gap").is_some() {
                return Err(super::source_failure(SourceFailure::Gap { reason: world_protocol::sources::GapReason::InterruptedSnapshot }, world_protocol::failure::FailureStage::Read));
            }
            let rows = snapshot.query("SELECT run_id,phase,basis FROM world_source_reconcile WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 AND partition_key=$4 ORDER BY last_reconciled_at DESC NULLS LAST", &[&a.world.tenant_id.as_str(), &a.world.world_id.as_str(), &a.source_id.as_str(), &a.partition]).await?;
            for row in rows {
                let state: super::snapshot::ReconcileState = super::decode(row.get("basis"))?;
                if !a.continues(&state.assignment) { continue; }
                let covered = match &entry.raw.kind {
                    super::CaptureKind::Snapshot { run, complete, consistent, .. } => {
                        run.as_str() == row.get::<_, String>("run_id") && *complete && *consistent
                            && entry.raw.page.basis.snapshot == state.snapshot
                    }
                    super::CaptureKind::Changes { .. } => true,
                };
                if row.get::<_, String>("phase") == "complete" && state.complete && state.consistent
                    && state.snapshot.is_some() && state.gap.is_none() && covered
                {
                    return Ok(true);
                }
            }
            Err(super::source_failure(SourceFailure::Gap { reason: world_protocol::sources::GapReason::InterruptedSnapshot }, world_protocol::failure::FailureStage::Read))
        })).await?;
        if !ready {
            let outcome = self.run(cancel, deadline).await?;
            if !outcome.reconciled
                || !outcome.failures.is_empty()
                || outcome.checkpoint.source.gap.is_some()
            {
                return Err(super::source_failure(
                    SourceFailure::Gap {
                        reason: world_protocol::sources::GapReason::InterruptedSnapshot,
                    },
                    world_protocol::failure::FailureStage::Read,
                ));
            }
        }
        Ok(())
    }

    pub(super) fn start_poll(
        self: Arc<Self>,
        interval: Duration,
        deadline: Instant,
    ) -> SourceCarriers {
        let assignment = self.assignment.clone();
        let (reader, _) = OwnedTask::spawn(move |cancel| async move {
            loop {
                tokio::select! {_=cancel.cancelled()=>return Ok(()),_=tokio::time::sleep(interval)=>{}}
                let run = SnapshotRun {
                    execution: self.execution.clone(),
                    store: self.store.clone(),
                    content: self.content.clone(),
                    broker: self.broker.clone(),
                    assignment: self.assignment.clone(),
                    admission: self.admission.clone(),
                    pipeline: self.pipeline.clone(),
                    identity: self.identity.clone(),
                    plan: self.plan.clone(),
                    read: self.read.clone(),
                    budget: self.budget.clone(),
                    accounting: self.accounting.clone(),
                    storage_epoch: self.storage_epoch,
                    fences: self.fences.clone(),
                    run: RunId::try_new(uuid::Uuid::new_v4().to_string())
                        .map_err(|_| SyncError::protocol())?,
                };
                match run.run(cancel.clone(), deadline).await {
                    Ok(_) => {}
                    Err(error) if cancelled(&error, &cancel) => return Ok(()),
                    Err(error) => return Err(error),
                }
            }
        });
        SourceCarriers::new(assignment, reader, None)
    }
    async fn change_once(
        &self,
        cancel: CancellationToken,
        deadline: Instant,
    ) -> Result<bool, SyncError> {
        let recovered = self.drain_pending(cancel.clone()).await?;
        let mut plan = self.read.clone();
        let a = self.assignment.clone();
        let admission = self.admission.clone();
        let (after, resume_gap) = self.store.snapshot(a.world.clone(), move |snapshot| Box::pin(async move {
            let now = snapshot.now().await?;
            crate::authorization::recheck_read(snapshot, &admission, &now).await?;
            let row = snapshot.query_opt("SELECT p.body AS partition,c.captured_sequence,c.captured,c.gap,i.body AS input FROM world_source_partition p JOIN world_source_checkpoint c USING(tenant_id,world_id,source_id,partition_key) LEFT JOIN LATERAL (SELECT i.* FROM world_source_inbox i WHERE i.tenant_id=c.tenant_id AND i.world_id=c.world_id AND i.source_id=c.source_id AND i.partition_key=c.partition_key AND i.partition_epoch<=c.partition_epoch AND i.sequence=c.captured_sequence ORDER BY i.partition_epoch DESC LIMIT 1) i ON true WHERE p.tenant_id=$1 AND p.world_id=$2 AND p.source_id=$3 AND p.partition_key=$4 AND c.partition_epoch=$5", &[&a.world.tenant_id.as_str(), &a.world.world_id.as_str(), &a.source_id.as_str(), &a.partition, &super::number(a.epoch.0)?]).await?.ok_or_else(SyncError::protocol)?;
            let partition: super::model::Partition = super::decode(row.get("partition"))?;
            if partition.assignment != a || partition.state != super::model::PartitionState::Running { return Err(SyncError::protocol()); }
            let gap = row.get::<_, Option<serde_json::Value>>("gap").map(super::decode::<world_protocol::sources::SourceGap>).transpose()?.map(|gap| gap.reason);
            match (row.get::<_, Option<i64>>("captured_sequence"), row.get::<_, Option<serde_json::Value>>("captured"), row.get::<_, Option<serde_json::Value>>("input")) {
                (None, None, None) => Ok((None, gap)),
                (Some(sequence), Some(position), Some(input)) => {
                    let position: world_protocol::sources::SourcePosition = super::decode(position)?;
                    let entry: super::inbox::Entry = super::decode(input)?;
                    if entry.input.sequence != sequence as u64 || entry.input.position != position
                        || entry.raw.position != position || entry.input.kind != entry.raw.kind
                        || entry.input.basis != entry.raw.page.basis || !a.continues(&entry.raw.assignment)
                    { return Err(SyncError::protocol()); }
                    entry.raw.change_position()?;
                    let native = entry.raw.page.basis.position.clone();
                    let gap = gap.or_else(|| native.is_none().then_some(world_protocol::sources::GapReason::NonReplayable));
                    Ok((native, gap))
                }
                _ => Err(SyncError::protocol()),
            }
        })).await?;
        let resume_gap = resume_gap.or_else(|| {
            matches!(
                self.plan.binding_body.capabilities.change_stream,
                world_protocol::sources::ChangeStreamCapability::NonReplayable
            )
            .then_some(world_protocol::sources::GapReason::NonReplayable)
        });
        if let Some(reason) = resume_gap {
            return self
                .snapshot_gap(
                    reason,
                    super::source_failure(
                        SourceFailure::Gap { reason },
                        world_protocol::failure::FailureStage::Read,
                    ),
                    cancel,
                    deadline,
                )
                .await;
        }
        plan.continuation = after.map(|p| p.cursor);
        let changes = match self
            .broker
            .changes_trusted(
                plan,
                self.assignment.clone(),
                &self.admission,
                cancel.clone(),
                deadline,
                self.accounting.clone(),
            )
            .await
        {
            Ok(changes) => changes,
            Err(error) => {
                let reason = match &error.failure {
                    SourceFailure::PositionExpired => {
                        Some(world_protocol::sources::GapReason::PositionExpired)
                    }
                    SourceFailure::Gap { reason } => Some(*reason),
                    _ => None,
                };
                if let Some(reason) = reason {
                    return self
                        .snapshot_gap(reason, error.into(), cancel, deadline)
                        .await;
                }
                return Err(error.into());
            }
        };
        let captures = PreparedCapture::from_changes(
            &self.content,
            &self.assignment,
            &changes,
            &self.identity,
            &cancel,
        )?;
        let mut captured = false;
        for capture in captures {
            let capture = Arc::new(capture);
            let semantic = crate::definitions::canonical_digest(&(
                "world.source.capture.semantic.v1",
                &capture.raw.position,
                &capture.raw.kind,
                &capture.raw.page.rows,
                &capture.raw.deletions,
            ))
            .map_err(|_| SyncError::protocol())?;
            let batch =
                self.commit_position("changes.capture", &semantic, &capture.raw.position)?;
            let content = self.content.clone();
            let admission = self.admission.clone();
            let a = self.assignment.clone();
            let input = capture.clone();
            self.store
                .transact(batch, move |tx| {
                    Box::pin(
                        async move { super::capture(tx, &content, &admission, &a, &input).await },
                    )
                })
                .await
                .map_err(SyncError::from)?;
            captured = true;
        }
        self.drain_pending(cancel)
            .await
            .map(|applied| recovered || captured || applied)
    }
    fn snapshot_gap<'a>(
        &'a self,
        reason: world_protocol::sources::GapReason,
        failure: SyncError,
        cancel: CancellationToken,
        deadline: Instant,
    ) -> StoreFuture<'a, bool, SyncError> {
        Box::pin(async move {
            let mut run = self.clone();
            run.run =
                RunId::try_new(uuid::Uuid::new_v4().to_string()).map_err(|_| SyncError::protocol())?;
            let digest = crate::definitions::canonical_digest(&(
                "world.source.resume_gap.v1",
                &self.assignment,
                reason,
                &run.run,
            ))
            .map_err(|_| SyncError::protocol())?;
            let batch = run.commit("changes.gap", 0, &digest)?;
            let a = self.assignment.clone();
            let admission = self.admission.clone();
            let gap = self
                .store
                .transact(batch, move |tx| {
                    Box::pin(async move {
                        let now = super::authorize(
                            tx,
                            &admission,
                            &a,
                            world_protocol::authorization::AccessMode::Write,
                        )
                        .await?;
                        super::partition::running(tx, &a).await?;
                        let mut checkpoint = super::load(tx, &a).await?;
                        let gap = world_protocol::sources::SourceGap {
                            reason,
                            after: checkpoint
                                .source
                                .captured
                                .clone()
                                .filter(|position| position.format == a.format),
                            before: None,
                        };
                        checkpoint.source.gap = Some(gap.clone());
                        super::inbox::save_checkpoint(tx, &a, &mut checkpoint, &now).await?;
                        Ok::<_, SyncError>(gap)
                    })
                })
                .await
                .map_err(SyncError::from)?;
            run.run_with_gap(cancel, deadline, Some(gap.value)).await?;
            Err(failure)
        })
    }
    pub(super) fn drain_pending<'a>(
        &'a self, cancel: CancellationToken,
    ) -> StoreFuture<'a, bool, SyncError> {
        Box::pin(async move {
            let mut changed = false;
            loop {
                let Some(prefix) = self.next_prefix(cancel.clone()).await? else {
                    return Ok(changed);
                };
                let request = self.prefix_request(&prefix)?;
                let applied = self.apply_prefix(prefix, request, cancel.clone()).await?;
                if applied.events.is_empty() {
                    return Ok(changed);
                }
                changed = true;
            }
        })
    }
    pub(super) fn prefix_request(
        &self, prefix: &super::inbox::CapturedPrefix,
    ) -> Result<crate::store::CommitRequest, SyncError> {
        if let Some((assignment, run, page, digest)) = prefix.snapshot_capture() {
            let mut snapshot = self.clone();
            snapshot.assignment = assignment.clone();
            snapshot.run = run.clone();
            let digest = Digest::try_new(digest.to_owned()).map_err(|_| SyncError::protocol())?;
            return snapshot.commit_request("apply", page, &digest);
        }
        // The complete prefix, not its first event, identifies a retry after a closing chunk.
        let phase = format!("changes.apply.{}", prefix.digest().as_str());
        self.position_request(&phase, prefix.digest(), prefix.position())
    }
    pub(super) fn next_prefix<'a>(
        &'a self,
        cancel: CancellationToken,
    ) -> StoreFuture<'a, Option<super::inbox::CapturedPrefix>, SyncError> {
        Box::pin(async move {
            self.accounting.check().map_err(|error| world_protocol::sources::MappingFailure::BudgetExceeded { dimension: error.dimension })?;
            let a = self.assignment.clone();
            let admission = self.admission.clone();
            let plan = self.plan.clone();
            let budget = self.budget.clone();
            self.store.snapshot(a.world.clone(), move |snapshot| Box::pin(async move {
                super::inbox::CapturedPrefix::next(snapshot, &admission, &a, &plan, &budget, &cancel).await
            })).await
        })
    }
    pub(super) fn apply_prefix<'a>(
        &'a self,
        prefix: super::inbox::CapturedPrefix,
        request: crate::store::CommitRequest,
        cancel: CancellationToken,
    ) -> StoreFuture<'a, super::model::ApplyReceipt, SyncError> {
        Box::pin(async move {
            // A committed FINAL is authoritative; never redispatch its identity calls on retry.
            if let Some(saved) = self.store.read_commit_optional::<super::model::ApplyReceipt>(
                &request.world, &request.commit_id, &request.input_digest,
            ).await? {
                self.execution.recheck_replay(&saved).await?;
                return Ok(saved.value);
            }
            let prepared_batch = self.position_request(
                &format!("changes.identity.prepare.{}", prefix.digest().as_str()),
                prefix.digest(), prefix.position(),
            )?.prepare()?;
            let a = self.assignment.clone();
            let admission = self.admission.clone();
            let plan = self.plan.clone();
            let input = prefix.clone();
            let accounting = self.accounting.clone();
            let cancellation = cancel.clone();
            let prepared = self.store.transact(prepared_batch, move |tx| Box::pin(async move {
                super::inbox::prepare_identities(tx, &admission, &a, &plan, &input, &accounting, &cancellation).await
            })).await.map_err(SyncError::from)?.value;
            let observed = match &prepared {
                Some(prepared) => Some(self.execution.resolve_source_identities(
                    prefix.digest().clone(), prepared.requests().to_vec(), prepared.receipts().to_vec(),
                ).await?),
                None => None,
            };
            let content = self.content.clone();
            let admission = self.admission.clone();
            let a = self.assignment.clone();
            let plan = self.plan.clone();
            let budget = self.budget.clone();
            let accounting = self.accounting.clone();
            let applied = self.store.transact(request.prepare()?, move |tx| Box::pin(async move {
                let proposals = observed.as_ref().map_or(&[][..], |observed| observed.proposals());
                let receipt = super::inbox::apply(tx, &content, &admission, &a, &plan, &prefix,
                    prepared.as_ref(), proposals, &budget, &accounting, &cancel).await?;
                if !receipt.events.is_empty() {
                    if let Some(observed) = observed { observed.complete(tx, &admission).await?; }
                }
                Ok::<_, SyncError>(receipt)
            })).await.map_err(SyncError::from)?;
            self.execution.recheck_replay(&applied).await?;
            Ok(applied.value)
        })
    }
    async fn ack_once(
        &self,
        cancel: CancellationToken,
        deadline: Instant,
    ) -> Result<(), SyncError> {
        let a = self.assignment.clone();
        let admission = self.admission.clone();
        let proof = self
            .store
            .snapshot(a.world.clone(), move |snapshot| {
                Box::pin(async move { super::prepare_ack(snapshot, &admission, &a).await })
            })
            .await?;
        let Some(proof) = proof else {
            return Ok(());
        };
        let position = proof.position().clone();
        let ack = self
            .broker
            .acknowledge_applied(
                self.read.clone(),
                proof,
                &self.admission,
                cancel,
                deadline,
                self.accounting.clone(),
            )
            .await?;
        let digest = crate::definitions::canonical_digest(&(
            "world.source.ack.v1",
            &self.assignment.source_id,
            &position,
        ))
        .map_err(|_| SyncError::protocol())?;
        let batch = self.commit_position("changes.acknowledged", &digest, &position)?;
        let a = self.assignment.clone();
        let admission = self.admission.clone();
        self.store
            .transact(batch, move |tx| {
                Box::pin(async move { super::acknowledge(tx, &admission, &a, &ack).await })
            })
            .await
            .map_err(SyncError::from)?;
        Ok(())
    }
    fn commit_position(
        &self, phase: &str, digest: &Digest, position: &world_protocol::sources::SourcePosition,
    ) -> Result<crate::store::PreparedBatch, SyncError> {
        Ok(self.position_request(phase, digest, position)?.prepare()?)
    }
    fn position_request(
        &self, phase: &str, digest: &Digest, position: &world_protocol::sources::SourcePosition,
    ) -> Result<crate::store::CommitRequest, SyncError> {
        let id = crate::definitions::canonical_digest(&(
            "world.source.position.commit.v1",
            &self.assignment.world,
            &self.assignment.source_id,
            &self.assignment.partition,
            phase,
            position,
        ))
        .map_err(|_| SyncError::protocol())?;
        Ok(crate::store::CommitRequest {
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
fn cancelled(error: &SyncError, cancel: &CancellationToken) -> bool {
    cancel.is_cancelled()
        && matches!(error, SyncError::Source(error) if error.failure == SourceFailure::Cancelled)
}
