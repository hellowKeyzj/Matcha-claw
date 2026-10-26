use super::{
    Assignment, Checkpoint, SnapshotOutcome, SnapshotRun, SourceCarriers, SyncError, SyncIdentity,
    decode, model::Partition,
};
use crate::{
    extensions::invocation::InvocationLease, owner::ExecutionContext,
    sources::connectors::SourceBroker,
    store::StoreFuture,
};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use tokio::{
    sync::{Mutex, Notify},
    time::Instant,
};
use world_protocol::{
    api::BindingCommand,
    failure::FailureStage,
    ids::*,
    operation::OperationResult,
    sources::{SourceFailure, SyncPolicy},
};

#[derive(Default)]
pub(crate) struct SyncOwner {
    sources: Mutex<BTreeMap<DefinitionId, Arc<Source>>>,
}
#[derive(Default)]
struct Source {
    custody: Mutex<Custody>,
    stop: Notify,
}
#[derive(Default)]
struct Custody {
    assignment: Option<Assignment>,
    carriers: Option<SourceCarriers>,
    lease: Option<Arc<InvocationLease>>,
    broker: Option<Arc<SourceBroker>>,
}
impl SyncOwner {
    async fn source(&self, binding: &DefinitionId) -> Arc<Source> {
        self.sources
            .lock()
            .await
            .entry(binding.clone())
            .or_default()
            .clone()
    }
    pub(crate) async fn start(
        &self,
        ctx: ExecutionContext,
        request: BindingCommand,
        broker: Arc<SourceBroker>,
        lease: Arc<InvocationLease>,
    ) -> Result<(), SyncError> {
        let source = self.source(&request.binding.id).await;
        let mut custody = source.custody.lock().await;
        if custody.lease.is_some() {
            lease.finish();
            return Err(super::source_failure(
                SourceFailure::ReaderNotStopped,
                FailureStage::Prepare,
            ));
        }
        let previous = custody.assignment.clone();
        custody.lease = Some(lease);
        custody.broker = Some(broker.clone());
        let result = self.start_in(&ctx, request, broker, &mut custody).await;
        if result.as_ref().err().is_some_and(preparation_resolved)
            && custody.assignment == previous
            && custody.carriers.is_none()
            && custody.broker.as_ref().is_some_and(|b| b.sync_drained())
        {
            if let Some(lease) = custody.lease.take() {
                lease.finish();
            }
            custody.broker = None;
        }
        result
    }
    async fn start_in(
        &self,
        ctx: &ExecutionContext,
        request: BindingCommand,
        broker: Arc<SourceBroker>,
        custody: &mut Custody,
    ) -> Result<(), SyncError> {
        let command = request.clone();
        let (run, policy, digest) = self
            .prepare_run(ctx, request, broker, custody, true, None)
            .await?;
        let assignment = run.assignment.clone();
        let continuous = !matches!(policy, SyncPolicy::OnDemand);
        match policy {
            SyncPolicy::OnDemand | SyncPolicy::Poll { .. } => {
                run.run(ctx.cancellation.clone(), ctx.deadline).await?;
            }
            SyncPolicy::ChangeStream => {
                run.prepare_changes(ctx.cancellation.clone(), ctx.deadline)
                    .await?
            }
            SyncPolicy::Webhook => {}
        }
        self.seal_one_shot(ctx, custody, "source.start.seal", &digest)
            .await?;
        self.complete_start(ctx, command, assignment, digest, continuous).await
    }

    fn complete_start<'a>(
        &'a self,
        ctx: &'a ExecutionContext,
        command: BindingCommand,
        assignment: Assignment,
        digest: Digest,
        continuous: bool,
    ) -> StoreFuture<'a, (), SyncError> {
        Box::pin(async move {
            let a = assignment.clone();
            let usage = ctx.budget.checkpoint_usage();
            ctx.transact(
                "source.start.complete",
                digest,
                &["sources", "packages"],
                move |tx, _, operation, run| {
                    Box::pin(async move {
                        let checkpoint = super::load(tx, &a).await?;
                        let now = tx.now().await?;
                        crate::owner::checkpoint_usage(
                            tx,
                            &run,
                            crate::owner::confirmed_usage(&run.usage, usage)?,
                        )
                        .await?;
                        crate::owner::complete_operation(
                            tx,
                            &operation.receipt.accepted,
                            OperationResult::Sync {
                                binding: a.binding,
                                checkpoint: checkpoint.source,
                            },
                            &now,
                        )
                        .await
                    })
                },
            )
            .await?;
            if continuous {
                ctx.owner
                    .start_source_service(super::SourceParent {
                        request: command,
                        assignment,
                        owner_run: ctx.run.id.clone(),
                    })
                    .await?;
            }
            Ok(())
        })
    }

    fn prepare_run<'a>(
        &'a self,
        ctx: &'a ExecutionContext,
        request: BindingCommand,
        broker: Arc<SourceBroker>,
        custody: &'a mut Custody,
        start: bool,
        segment: Option<super::SourceSegment>,
    ) -> StoreFuture<'a, (Arc<SnapshotRun>, SyncPolicy, Digest), SyncError> {
        Box::pin(async move {
            let prepared = broker
                .prepare_sync(&request.binding, &ctx.admission)
                .await?;
            let binding = prepared.binding().clone();
            if binding.reference.revision != request.expected_revision {
                return Err(SyncError::protocol());
            }
            let digest =
                crate::definitions::canonical_digest(&request).map_err(crate::owner::Error::from)?;
            let desired_running = start && !matches!(binding.body.sync, SyncPolicy::OnDemand);
            let proposed = prepared.assignment(PartitionEpoch(1));
            let a = proposed.clone();
            let b = binding.clone();
            let recovery = segment.clone();
            let initialize_key = format!("source.initialize:{}", request.binding.id);
            let initialized=ctx.transact(&initialize_key,digest.clone(),&["sources"],move |tx,admission,_,run| Box::pin(async move {
                if let Some(input)=&segment { super::require_segment_parent(tx,&admission,input).await?; if input.run_id!=run.id { return Err(SyncError::protocol().into()); } }
                let w=tx.world();
                let row=tx.query_opt("SELECT body FROM world_source_partition WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 AND partition_key=$4 FOR UPDATE", &[&w.tenant_id.as_str(),&w.world_id.as_str(),&a.source_id.as_str(),&a.partition]).await?;
                let (a,checkpoint)=match row {
                    None=>{let checkpoint=super::initialize(tx,&admission,&a,&run.id,desired_running).await?;(a,checkpoint)},
                    Some(row)=>{
                        let old:Partition=decode(row.get("body"))?;
                        let mut next=a;
                        next.epoch=PartitionEpoch(old.assignment.epoch.0.checked_add(1).ok_or_else(SyncError::protocol)?);
                        let desired_running=if start { desired_running } else { old.desired_running };
                        let checkpoint=super::partition::restart(tx,&admission,&old,&next,&run.id,desired_running).await?;
                        (next,checkpoint)
                    }
                };
                let now=tx.now().await?;
                let access=crate::authorization::source_capture_policy(tx,&admission,&b.scope,&b.body.source_id,&b.body.retention,&now).await?;
                let origin=crate::definitions::canonical_digest(&("world.source.origin.v1",&a.world,&a.source_id)).map_err(crate::owner::Error::from)?;
                let origin=OriginFamilyId::try_new(origin.as_str().replace(':',"-")).map_err(|_| SyncError::protocol())?;
                Ok((a,checkpoint,SyncIdentity { origin_family:origin,access,retention:b.body.retention }))
            })).await?;
            let (mut assignment, _, identity) = initialized.value;
            if let Some(input) = &recovery {
                let (current, _) = super::status::segment_current(&ctx.store, &ctx.admission, input).await?;
                if current.owner_run.as_ref() != Some(&ctx.run.id) || !current.assignment.continues(&assignment) {
                    return Err(SyncError::protocol());
                }
                if current.assignment.instance != proposed.instance
                    && current.state != super::model::PartitionState::Sealed
                {
                    let request = ctx.commit_request("source.segment.fence", digest.clone(), &["sources"]).await?;
                    assignment = fence_segment(&ctx.store, &ctx.admission, input, &broker, &request,
                        ctx.deadline, ctx.cancellation.clone(), false).await?.0.assignment;
                } else {
                    assignment = current.assignment;
                }
            }
            custody.assignment = Some(assignment.clone());
            let commit = ctx
                .commit_request(
                    &format!("source.reader:{}", request.binding.id),
                    digest.clone(),
                    &["sources", "identity", "facts", "content"],
                )
                .await?;
            let run = Arc::new(SnapshotRun {
                execution: ctx.clone(),
                store: Arc::new(ctx.store.clone()),
                content: ctx.resources.content.clone(),
                broker,
                assignment: assignment.clone(),
                admission: ctx.admission.clone(),
                pipeline: ctx.pipeline.clone(),
                identity,
                plan: prepared.plan().clone(),
                read: prepared.read().clone(),
                budget: ctx.run.budget.clone(),
                accounting: ctx.budget.clone(),
                storage_epoch: commit.storage_epoch,
                fences: commit.fences,
                run: ctx.run.id.clone(),
            });
            Ok((run, binding.body.sync, digest))
        })
    }

    fn seal_one_shot<'a>(
        &'a self,
        ctx: &'a ExecutionContext,
        custody: &'a mut Custody,
        key: &'a str,
        digest: &'a Digest,
    ) -> StoreFuture<'a, Checkpoint, SyncError> {
        Box::pin(async move {
            if custody.carriers.is_some()
                || !custody
                    .broker
                    .as_ref()
                    .is_some_and(|broker| broker.sync_drained())
            {
                return Err(super::source_failure(
                    SourceFailure::ReaderNotStopped,
                    FailureStage::Drain,
                ));
            }
            let assignment = custody.assignment.clone().ok_or_else(SyncError::protocol)?;
            let key = format!("{key}:{}", assignment.binding.id);
            let checkpoint = ctx
                .transact(
                    &key,
                    digest.clone(),
                    &["sources"],
                    move |tx, admission, _, _| {
                        Box::pin(async move {
                            super::begin_quiesce(tx, &admission, &assignment).await?;
                            Ok(super::partition::stopped(tx, &admission, &assignment, None).await?)
                        })
                    },
                )
                .await?
                .value;
            if let Some(lease) = custody.lease.take() {
                lease.finish();
            }
            custody.broker = None;
            Ok(checkpoint)
        })
    }

    pub(crate) async fn run_segment(
        &self,
        ctx: ExecutionContext,
        input: super::SourceSegment,
        broker: Arc<SourceBroker>,
        lease: Arc<InvocationLease>,
        work_deadline: Instant,
    ) -> Result<Checkpoint, SyncError> {
        let source = self.source(&input.parent.request.binding.id).await;
        let mut custody = source.custody.lock().await;
        if custody.lease.is_some() {
            lease.finish();
            return Err(super::source_failure(
                SourceFailure::ReaderNotStopped,
                FailureStage::Prepare,
            ));
        }
        if input.run_id != ctx.run.id || work_deadline >= ctx.deadline {
            lease.finish();
            return Err(SyncError::protocol());
        }
        let previous = custody.assignment.clone();
        custody.lease = Some(lease);
        custody.broker = Some(broker.clone());
        let prepared = self
            .prepare_run(
                &ctx,
                input.parent.request.clone(),
                broker,
                &mut custody,
                false,
                Some(input.clone()),
            )
            .await;
        let (run, policy, digest) = match prepared {
            Ok(prepared) => prepared,
            Err(error) => {
                if preparation_resolved(&error)
                    && custody.assignment == previous
                    && custody.carriers.is_none()
                    && custody
                        .broker
                        .as_ref()
                        .is_some_and(|broker| broker.sync_drained())
                {
                    if let Some(lease) = custody.lease.take() {
                        lease.finish();
                    }
                    custody.broker = None;
                }
                return Err(error);
            }
        };
        let (current, checkpoint) = super::status::segment_current(&ctx.store, &ctx.admission, &input).await?;
        if current.state == super::model::PartitionState::Sealed && current.reader_stopped && current.ack_stopped {
            if let Some(lease) = custody.lease.take() { lease.finish(); }
            custody.broker = None;
            return Ok(checkpoint);
        }
        let result = async {
            run.drain_pending(ctx.cancellation.clone()).await?;
            custody.carriers = Some(match policy {
                SyncPolicy::Poll { interval } if interval.0 > 0 => run.start_poll(Duration::from_millis(interval.0), ctx.deadline),
                SyncPolicy::ChangeStream | SyncPolicy::Webhook => run.start_changes(Duration::from_secs(1), ctx.deadline).await?,
                _ => return Err(SyncError::protocol()),
            });
            tokio::select! {
                _ = tokio::time::sleep_until(work_deadline) => Ok(()),
                _ = ctx.cancellation.cancelled() => Ok(()),
                _ = source.stop.notified() => Ok(()),
                result = custody.carriers.as_mut().expect("started source carriers").wait_for_exit() => result,
            }
        }.await;
        let assignment = custody.assignment.clone().ok_or_else(SyncError::protocol)?;
        let stopped = match &mut custody.carriers {
            Some(carriers) => Some(carriers.stop(ctx.deadline).await?),
            None => None,
        };
        if !custody
            .broker
            .as_ref()
            .is_some_and(|broker| broker.sync_drained())
        {
            return Err(super::source_failure(
                SourceFailure::ReaderNotStopped,
                FailureStage::Drain,
            ));
        }
        let key = format!("source.segment.seal:{}", assignment.binding.id);
        let checkpoint = ctx
            .transact(&key, digest, &["sources"], move |tx, admission, _, _| {
                Box::pin(async move {
                    super::begin_quiesce(tx, &admission, &assignment).await?;
                    Ok(
                        super::partition::stopped(tx, &admission, &assignment, stopped.as_ref())
                            .await?,
                    )
                })
            })
            .await?
            .value;
        if let Some(lease) = custody.lease.take() {
            lease.finish();
        }
        custody.carriers = None;
        custody.broker = None;
        result?;
        Ok(checkpoint)
    }

    pub(crate) async fn fence_rejected_segment(
        &self, store: &crate::store::WorldStore, admission: &crate::authorization::Admission,
        input: &super::SourceSegment, broker: Arc<SourceBroker>, lease: Arc<InvocationLease>,
        request: &crate::store::CommitRequest, deadline: Instant, cancel: tokio_util::sync::CancellationToken,
    ) -> Result<FencedSourceSegment, SyncError> {
        let source = self.source(&input.parent.request.binding.id).await;
        let custody = source.custody.lock().await;
        if custody.lease.is_some() || custody.carriers.is_some() {
            lease.finish();
            return Err(super::source_failure(SourceFailure::ReaderNotStopped, FailureStage::Recover));
        }
        let result = fence_segment(store, admission, input, &broker, request, deadline, cancel, true).await;
        if broker.sync_drained() { lease.finish(); }
        let (partition, _) = result?;
        Ok(FencedSourceSegment { input: input.clone(), partition })
    }

    pub(crate) async fn reconcile(
        &self,
        ctx: &ExecutionContext,
        request: &BindingCommand,
        broker: Arc<SourceBroker>,
        lease: Arc<InvocationLease>,
    ) -> Result<SnapshotOutcome, SyncError> {
        let source = self.source(&request.binding.id).await;
        let mut custody = source.custody.lock().await;
        if custody.lease.is_some() {
            lease.finish();
            return Err(super::source_failure(
                SourceFailure::ReaderNotStopped,
                FailureStage::Prepare,
            ));
        }
        custody.lease = Some(lease);
        custody.broker = Some(broker.clone());
        let (run, _, digest) = self
            .prepare_run(ctx, request.clone(), broker, &mut custody, false, None)
            .await?;
        let mut outcome = run.run(ctx.cancellation.clone(), ctx.deadline).await?;
        outcome.checkpoint = self
            .seal_one_shot(ctx, &mut custody, "source.reconcile.seal", &digest)
            .await?;
        Ok(outcome)
    }

    pub(crate) async fn stop(
        &self,
        ctx: ExecutionContext,
        request: BindingCommand,
    ) -> Result<(), SyncError> {
        let digest =
            crate::definitions::canonical_digest(&request).map_err(crate::owner::Error::from)?;
        let intent = request.clone();
        ctx.transact(
            "source.stop.intent",
            digest.clone(),
            &["sources"],
            move |tx, admission, _, _| {
                Box::pin(async move {
                    let partition = super::status::stop_partition(tx, &intent).await?;
                    super::partition::request_stop(tx, &admission, &partition.assignment).await?;
                    Ok(())
                })
            },
        )
        .await?;
        let source = self.source(&request.binding.id).await;
        source.stop.notify_one();
        let mut custody = source.custody.lock().await;
        let held = custody.assignment.clone();
        let has_broker = custody.broker.is_some();
        let partition = ctx
            .transact(
                "source.stop.quiesce",
                digest.clone(),
                &["sources"],
                move |tx, admission, _, _| {
                    Box::pin(async move {
                        let partition = super::status::stop_partition(tx, &request).await?;
                        super::authorize(
                            tx,
                            &admission,
                            &partition.assignment,
                            world_protocol::authorization::AccessMode::Manage,
                        )
                        .await?;
                        if partition.state == super::model::PartitionState::Sealed
                            && partition.reader_stopped
                            && partition.ack_stopped
                        {
                            return Ok(partition);
                        }
                        if held.as_ref() != Some(&partition.assignment) || !has_broker {
                            return Err(super::source_failure(
                                SourceFailure::ReaderNotStopped,
                                FailureStage::Drain,
                            )
                            .into());
                        }
                        match partition.state {
                            super::model::PartitionState::Running => {
                                super::begin_quiesce(tx, &admission, &partition.assignment).await?
                            }
                            super::model::PartitionState::Quiescing => {}
                            _ => return Err(SyncError::protocol().into()),
                        }
                        Ok(partition)
                    })
                },
            )
            .await?
            .value;
        let assignment = partition.assignment.clone();
        let already_stopped = partition.state == super::model::PartitionState::Sealed;
        if custody
            .assignment
            .as_ref()
            .is_some_and(|held| held != &assignment)
            && (custody.lease.is_some() || custody.broker.is_some() || custody.carriers.is_some())
        {
            return Err(SyncError::protocol());
        }
        let stopped = match &mut custody.carriers {
            Some(carriers) => Some(carriers.stop(ctx.deadline).await?),
            None => None,
        };
        if !custody.broker.as_ref().is_none_or(|b| b.sync_drained()) {
            return Err(super::source_failure(
                SourceFailure::ReaderNotStopped,
                FailureStage::Drain,
            ));
        }
        let a = assignment;
        ctx.transact(
            "source.stop.complete",
            digest,
            &["sources", "packages"],
            move |tx, admission, operation, _| {
                Box::pin(async move {
                    let checkpoint = if already_stopped {
                        super::authorize(
                            tx,
                            &admission,
                            &a,
                            world_protocol::authorization::AccessMode::Manage,
                        )
                        .await?;
                        let partition = super::partition::locked(tx, &a).await?;
                        if partition.state != super::model::PartitionState::Sealed
                            || !partition.reader_stopped
                            || !partition.ack_stopped
                        {
                            return Err(SyncError::protocol().into());
                        }
                        super::load(tx, &a).await?
                    } else {
                        super::partition::stopped(tx, &admission, &a, stopped.as_ref()).await?
                    };
                    let now = tx.now().await?;
                    crate::owner::complete_operation(
                        tx,
                        &operation.receipt.accepted,
                        OperationResult::Sync {
                            binding: a.binding,
                            checkpoint: checkpoint.source,
                        },
                        &now,
                    )
                    .await
                })
            },
        )
        .await?;
        if let Some(lease) = custody.lease.take() {
            lease.finish();
        }
        custody.broker = None;
        custody.carriers = None;
        Ok(())
    }
    pub(crate) async fn shutdown(&self, deadline: Instant) -> Result<(), SyncError> {
        let sources = self
            .sources
            .lock()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for source in &sources {
            source.stop.notify_one();
        }
        for source in sources {
            let mut custody = source.custody.lock().await;
            if let Some(carriers) = &mut custody.carriers {
                carriers.stop(deadline).await?;
            }
            if !custody.broker.as_ref().is_none_or(|b| b.sync_drained()) {
                return Err(super::source_failure(
                    SourceFailure::ReaderNotStopped,
                    FailureStage::Drain,
                ));
            }
            custody.carriers = None;
            custody.broker = None;
            if let Some(lease) = custody.lease.take() {
                lease.finish();
            }
        }
        Ok(())
    }
}

/// This proves exclusion of old native I/O, never that a historical process joined.
#[derive(Clone)]
pub(crate) struct FencedSourceSegment {
    input: super::SourceSegment,
    partition: Partition,
}
impl FencedSourceSegment {
    pub(crate) async fn recheck(
        &self, tx: &crate::store::WorldTransaction<'_>, run: &crate::owner::RunRecord,
    ) -> Result<(), SyncError> {
        if run.id != self.input.run_id || run.operation.world != *tx.world() { return Err(SyncError::protocol()); }
        let row = tx.query_opt("SELECT body FROM world_step WHERE tenant_id=$1 AND world_id=$2 AND run_id=$3 AND kind='sources.service' AND ordinal=0 FOR SHARE", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &run.id.as_str()]).await?.ok_or_else(SyncError::protocol)?;
        let step: crate::owner::StepRecord = decode(row.get("body"))?;
        if step.run_id != run.id || step.checkpoint != super::encode(&self.input)?
            || step.input_digest != crate::definitions::canonical_digest(&self.input).map_err(crate::owner::Error::from)?
        { return Err(SyncError::protocol()); }
        let current = super::partition::locked(tx, &self.partition.assignment).await?;
        if current != self.partition { return Err(SyncError::protocol()); }
        if current.state == super::model::PartitionState::Sealed && current.reader_stopped && current.ack_stopped {
            if current.owner_run.as_ref() == Some(&self.input.parent.owner_run) {
                if current.assignment != self.input.parent.assignment { return Err(SyncError::protocol()); }
            } else if current.owner_run.as_ref() == Some(&run.id) {
                super::status::require_native_continuation(tx, &current, &self.input).await?;
            } else { return Err(SyncError::protocol()); }
        } else {
            if current.state != super::model::PartitionState::Fenced || current.owner_run.as_ref() != Some(&run.id)
                || current.reader_stopped || current.ack_stopped || current.native_fence.is_none()
            { return Err(SyncError::protocol()); }
            super::status::require_native_continuation(tx, &current, &self.input).await?;
        }
        super::load(tx, &current.assignment).await?;
        Ok(())
    }
}

async fn fence_segment(
    store: &crate::store::WorldStore, admission: &crate::authorization::Admission,
    input: &super::SourceSegment, broker: &SourceBroker, request: &crate::store::CommitRequest,
    deadline: Instant, cancel: tokio_util::sync::CancellationToken, cleanup_only: bool,
) -> Result<(Partition, Checkpoint), SyncError> {
    let (initial, checkpoint) = super::status::segment_current(store, admission, input).await?;
    if initial.state == super::model::PartitionState::Sealed && initial.reader_stopped && initial.ack_stopped {
        return Ok((initial, checkpoint));
    }
    let mut next = broker.renewal_assignment(&initial.assignment);
    let reference = next.binding.clone();
    let binding = store.snapshot(next.world.clone(), move |snapshot| Box::pin(async move {
        crate::sources::mapping::read_binding_snapshot(snapshot, &reference).await?.ok_or_else(SyncError::protocol)
    })).await?;
    let read = world_protocol::sources::SourceReadPlan {
        binding: next.binding.clone(), resource: next.partition.clone(),
        row_symbol: SymbolId::try_new("source_row").map_err(|_| SyncError::protocol())?,
        fields: binding.body.selected_fields.iter().map(ToString::to_string).collect(),
        predicate: None, order: Vec::new(), limit: world_protocol::api::MAX_PAGE_ITEMS,
        continuation: None, as_of: None,
    };
    let fence = Arc::new(Mutex::new(broker.fence_sync_cleanup(admission, &next, &read, cancel.clone(), deadline).await?));
    let result = async {
        let (old, checkpoint) = super::status::segment_current(store, admission, input).await?;
        if old != initial || old.owner_run.as_ref() != Some(&input.run_id) { return Err(SyncError::protocol()); }
        {
            let mut fence = fence.lock().await;
            tokio::select! {
                result = fence.inspect(checkpoint.source.applied.as_ref()) => result?,
                _ = cancel.cancelled() => return Err(super::source_failure(SourceFailure::Cancelled, FailureStage::Recover)),
                _ = tokio::time::sleep_until(deadline) => return Err(super::source_failure(SourceFailure::ReadTimeout, FailureStage::Recover)),
            }
        }
        next.epoch = PartitionEpoch(old.assignment.epoch.0.checked_add(1).ok_or_else(SyncError::protocol)?);
        let digest = crate::definitions::canonical_digest(&("world.source.native_fence.v1", input, &old, &next, cleanup_only)).map_err(crate::owner::Error::from)?;
        let identity = crate::definitions::canonical_digest(&(&input.run_id, "source.native_fence", &next)).map_err(crate::owner::Error::from)?;
        let commit = CommitId::try_new(format!("source-fence-{}", &identity.as_str()[7..])).map_err(|_| SyncError::protocol())?;
        if request.world != next.world { return Err(SyncError::protocol()); }
        let mut request = request.clone();
        request.commit_id = commit;
        request.input_digest = digest;
        let current_admission = admission.clone();
        let current_input = input.clone();
        let proof = fence.clone();
        store.transact(request.prepare()?, move |tx| Box::pin(async move {
            super::require_segment_recovery(tx, &current_admission, &current_input).await?;
            let proof = proof.lock().await;
            let checkpoint = super::partition::fence_epoch(tx, &current_admission, &old, &next, &current_input.run_id, &proof, cleanup_only).await?;
            Ok::<_, SyncError>(super::model::FencedEpoch { previous: old, assignment: next, owner_run: current_input.run_id, checkpoint, cleanup_only })
        })).await?;
        super::status::segment_current(store, admission, input).await
    }.await;
    let fence = Arc::try_unwrap(fence).map_err(|_| SyncError::protocol())?.into_inner();
    match fence.close().await {
        Ok(()) => result,
        Err(cleanup) => Err(SyncError::Cleanup { error: Box::new(result.err().unwrap_or_else(SyncError::protocol)), cleanup }),
    }
}

fn preparation_resolved(error: &SyncError) -> bool {
    match error {
        SyncError::Owner(error) => error.unresolved_phase().is_none(),
        SyncError::Indeterminate(_) | SyncError::Rollback { .. } | SyncError::Cleanup { .. } => {
            false
        }
        SyncError::Store(error) => !matches!(
            error.reason,
            world_protocol::commit::CommitFailure::CommitIndeterminate { .. }
                | world_protocol::commit::CommitFailure::TransferIndeterminate { .. }
                | world_protocol::commit::CommitFailure::RollbackFailed
        ),
        _ => true,
    }
}
