use super::{SyncError, decode, model::Partition};
use crate::{
    authorization::{self, Admission},
    sources::mapping,
    store::WorldTransaction,
};
use world_protocol::{
    api::{BindingCommand, BindingQuery},
    authorization::{AccessMode, ActualImpact},
    sources::SourceCheckpoint,
    time::Timestamp,
};

pub(in crate::sources) async fn recheck_assignment(
    snapshot: &crate::store::WorldSnapshot<'_>, assignment: &super::Assignment,
) -> Result<(), crate::sources::connectors::SourceError> {
    let row = snapshot.query_opt("SELECT body FROM world_source_partition WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 AND partition_key=$4", &[&assignment.world.tenant_id.as_str(), &assignment.world.world_id.as_str(), &assignment.source_id.as_str(), &assignment.partition]).await?.ok_or_else(|| crate::sources::connectors::SourceError::new(world_protocol::sources::SourceFailure::ProtocolViolation, world_protocol::failure::FailureStage::Recover))?;
    let current: Partition = serde_json::from_value(row.get("body"))
        .map_err(|error| crate::sources::connectors::SourceError::caused_by(world_protocol::sources::SourceFailure::ProtocolViolation, world_protocol::failure::FailureStage::Recover, error))?;
    if snapshot.world() != &assignment.world || current.assignment != *assignment || current.state != super::model::PartitionState::Running {
        return Err(crate::sources::connectors::SourceError::new(world_protocol::sources::SourceFailure::ReaderNotStopped, world_protocol::failure::FailureStage::Recover));
    }
    Ok(())
}

pub(crate) async fn command_impact(
    tx: &WorldTransaction<'_>,
    request: &BindingCommand,
    start: bool,
    _now: &Timestamp,
) -> Result<ActualImpact, SyncError> {
    if !start {
        let partition = stop_partition(tx, request).await?;
        return Ok(authorization::actual_impact(
            vec![world_protocol::authorization::AccessScope {
                resources: vec![world_protocol::ids::ResourceRef::Source {
                    id: partition.assignment.source_id.clone(),
                }],
                fields: Vec::new(),
                modes: vec![AccessMode::Manage],
                scope: partition.assignment.scope,
                valid_time: None,
            }],
            Vec::new(),
            Vec::new(),
            Vec::new(),
            vec![partition.assignment.source_id],
        )?);
    }
    let binding = mapping::read_binding(tx, &request.binding)
        .await?
        .ok_or_else(SyncError::protocol)?;
    let mut modes = vec![AccessMode::Manage];
    if start {
        modes.extend([AccessMode::Read, AccessMode::Write]);
    }
    let mut impact = mapping::binding_impact(tx, &binding, modes).await?;
    if start {
        impact = authorization::actual_impact(
            impact.access,
            vec![world_protocol::expression::Effect::SourceRead],
            impact.labels,
            impact.state,
            impact.source_ids,
        )?;
    }
    Ok(impact)
}
pub(super) async fn stop_partition(
    tx: &WorldTransaction<'_>,
    request: &BindingCommand,
) -> Result<Partition, SyncError> {
    if request.binding.world != *tx.world() || request.expected_revision != request.binding.revision
    {
        return Err(SyncError::protocol());
    }
    let w = tx.world();
    let rows = tx.query("SELECT body FROM world_source_partition WHERE tenant_id=$1 AND world_id=$2 AND binding_id=$3 ORDER BY partition_key FOR SHARE", &[&w.tenant_id.as_str(), &w.world_id.as_str(), &request.binding.id.as_str()]).await?;
    if rows.len() != 1 {
        return Err(SyncError::protocol());
    }
    let partition: Partition = decode(rows[0].get("body"))?;
    if partition.assignment.binding != request.binding {
        return Err(SyncError::protocol());
    }
    Ok(partition)
}

pub(crate) async fn segment_parent(
    tx: &WorldTransaction<'_>,
    request: &BindingCommand,
    owner_run: &world_protocol::ids::RunId,
) -> Result<Option<super::SourceParent>, SyncError> {
    let partition = stop_partition(tx, request).await?;
    if !partition.desired_running
        || partition.owner_run.as_ref() != Some(owner_run)
        || partition.state != super::model::PartitionState::Sealed
        || !partition.reader_stopped
        || !partition.ack_stopped
    {
        return Ok(None);
    }
    let run = crate::owner::read_run(tx, owner_run).await?;
    if !crate::owner::terminal_phase(run.phase) {
        return Ok(None);
    }
    Ok(Some(super::SourceParent {
        request: request.clone(),
        assignment: partition.assignment,
        owner_run: owner_run.clone(),
    }))
}

pub(crate) async fn segment_parents(
    snapshot: &crate::store::WorldSnapshot<'_>,
) -> Result<Vec<super::SourceParent>, SyncError> {
    let w = snapshot.world();
    let rows = snapshot.query("SELECT p.body AS partition,r.body AS run,o.body AS operation FROM world_source_partition p JOIN world_run r ON r.tenant_id=p.tenant_id AND r.world_id=p.world_id AND r.run_id=p.body->>'owner_run' JOIN world_operation o ON o.tenant_id=r.tenant_id AND o.world_id=r.world_id AND o.operation_id=r.operation_id WHERE p.tenant_id=$1 AND p.world_id=$2 AND p.state='sealed' AND p.reader_stopped AND p.ack_stopped AND p.body->>'desired_running'='true' ORDER BY p.source_id,p.partition_key", &[&w.tenant_id.as_str(), &w.world_id.as_str()]).await?;
    let mut parents = Vec::new();
    for row in rows {
        let partition: Partition = decode(row.get("partition"))?;
        let run: crate::owner::RunRecord = decode(row.get("run"))?;
        let operation: crate::owner::OperationRecord = decode(row.get("operation"))?;
        if !partition.desired_running
            || partition.state != super::model::PartitionState::Sealed
            || !partition.reader_stopped
            || !partition.ack_stopped
            || partition.owner_run.as_ref() != Some(&run.id)
            || !crate::owner::terminal_phase(run.phase)
            || !crate::owner::terminal_phase(operation.receipt.phase)
            || run.operation.operation_id != operation.receipt.accepted.operation_id
            || operation.receipt.progress.run_id.as_ref() != Some(&run.id)
        {
            continue;
        }
        let world_protocol::api::WorldCommand::StartSync(request) = operation.input.command()?
        else {
            continue;
        };
        if request.binding != partition.assignment.binding
            || request.expected_revision != request.binding.revision
            || request.binding.world != *w
        {
            return Err(SyncError::protocol());
        }
        parents.push(super::SourceParent {
            request: request.clone(),
            assignment: partition.assignment,
            owner_run: run.id,
        });
    }
    Ok(parents)
}

pub(crate) async fn require_segment_parent(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    input: &super::SourceSegment,
) -> Result<(), SyncError> {
    let parent = &input.parent;
    super::authorize(tx, admission, &parent.assignment, AccessMode::Manage).await?;
    let partition = super::partition::locked(tx, &parent.assignment).await?;
    if parent.request.binding != parent.assignment.binding
        || parent.request.expected_revision != parent.assignment.binding.revision
        || partition.owner_run.as_ref() != Some(&parent.owner_run)
        || !partition.desired_running
        || partition.state != super::model::PartitionState::Sealed
        || !partition.reader_stopped
        || !partition.ack_stopped
        || input.run_id == parent.owner_run
        || input.budget.deadline.is_none()
    {
        return Err(SyncError::protocol());
    }
    let run = crate::owner::read_run(tx, &parent.owner_run).await?;
    if !crate::owner::terminal_phase(run.phase) {
        return Err(SyncError::protocol());
    }
    Ok(())
}

pub(crate) async fn require_segment_recovery(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    input: &super::SourceSegment,
) -> Result<(), SyncError> {
    let parent = &input.parent;
    if parent.request.binding != parent.assignment.binding
        || parent.request.expected_revision != parent.assignment.binding.revision
        || input.run_id == parent.owner_run || input.budget.deadline.is_none()
    { return Err(SyncError::protocol()); }
    super::authorize(tx, admission, &parent.assignment, AccessMode::Manage).await?;
    let run = crate::owner::read_run(tx, &input.run_id).await?;
    let operation = crate::owner::read_operation_record(tx, &run.operation.operation_id).await?;
    let row = tx.query_opt("SELECT body FROM world_step WHERE tenant_id=$1 AND world_id=$2 AND run_id=$3 AND kind='sources.service' AND ordinal=0 FOR SHARE", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &input.run_id.as_str()]).await?.ok_or_else(SyncError::protocol)?;
    let step: crate::owner::StepRecord = decode(row.get("body"))?;
    let digest = crate::definitions::canonical_digest(input).map_err(crate::owner::Error::from)?;
    if run.operation.world != *tx.world() || crate::owner::terminal_phase(run.phase)
        || operation.receipt.progress.run_id.as_ref() != Some(&input.run_id)
        || crate::owner::terminal_phase(operation.receipt.phase)
        || !matches!(operation.input.command()?, world_protocol::api::WorldCommand::StartSync(request) if request == &parent.request)
        || step.run_id != input.run_id || step.input_digest != digest
        || step.checkpoint != super::encode(input)?
    { return Err(SyncError::protocol()); }
    let partition = stop_partition(tx, &parent.request).await?;
    let partition = super::partition::locked(tx, &partition.assignment).await?;
    if partition.owner_run.as_ref() == Some(&parent.owner_run) {
        return require_segment_parent(tx, admission, input).await;
    }
    if partition.owner_run.as_ref() != Some(&input.run_id)
        || !partition.assignment.continues(&parent.assignment)
        || partition.assignment.epoch <= parent.assignment.epoch
        || !partition.desired_running
        || !matches!(partition.state, super::model::PartitionState::Running | super::model::PartitionState::Quiescing | super::model::PartitionState::Fenced | super::model::PartitionState::Sealed)
        || (partition.state != super::model::PartitionState::Sealed && (partition.reader_stopped || partition.ack_stopped))
        || (partition.state == super::model::PartitionState::Sealed && (!partition.reader_stopped || !partition.ack_stopped))
    { return Err(SyncError::protocol()); }
    require_native_continuation(tx, &partition, input).await?;
    super::partition::load(tx, &partition.assignment).await?;
    Ok(())
}

pub(super) async fn require_native_continuation(
    tx: &WorldTransaction<'_>, partition: &Partition, input: &super::SourceSegment,
) -> Result<(), SyncError> {
    let Some(commit) = &partition.native_fence else {
        if input.parent.assignment.epoch.0.checked_add(1) == Some(partition.assignment.epoch.0) { return Ok(()); }
        return Err(SyncError::protocol());
    };
    let row = tx.query_opt("SELECT result,input_digest FROM world_commit_receipt WHERE tenant_id=$1 AND world_id=$2 AND commit_id=$3 AND committed_at IS NOT NULL", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &commit.as_str()]).await?.ok_or_else(SyncError::protocol)?;
    let fenced: super::model::FencedEpoch = decode(row.get("result"))?;
    let digest = crate::definitions::canonical_digest(&("world.source.native_fence.v1", input, &fenced.previous, &fenced.assignment, fenced.cleanup_only)).map_err(crate::owner::Error::from)?;
    if digest.as_str() != row.get::<_, String>("input_digest") || fenced.assignment != partition.assignment
        || fenced.owner_run != input.run_id || fenced.previous.owner_run.as_ref() != Some(&input.run_id)
        || !fenced.assignment.continues(&fenced.previous.assignment)
        || fenced.previous.assignment.epoch.0.checked_add(1) != Some(fenced.assignment.epoch.0)
        || !fenced.previous.assignment.continues(&input.parent.assignment)
        || fenced.checkpoint.source.epoch != fenced.assignment.epoch
    { return Err(SyncError::protocol()); }
    Ok(())
}

pub(super) async fn segment_current(
    store: &crate::store::WorldStore, admission: &Admission, input: &super::SourceSegment,
) -> Result<(Partition, super::Checkpoint), SyncError> {
    let admission = admission.clone();
    let input = input.clone();
    store.snapshot(input.parent.assignment.world.clone(), move |snapshot| Box::pin(async move {
        authorization::recheck_read(snapshot, &admission, &snapshot.now().await?).await?;
        let rows = snapshot.query("SELECT body FROM world_source_partition WHERE tenant_id=$1 AND world_id=$2 AND binding_id=$3", &[&snapshot.world().tenant_id.as_str(), &snapshot.world().world_id.as_str(), &input.parent.request.binding.id.as_str()]).await?;
        if rows.len() != 1 { return Err(SyncError::protocol()); }
        let partition: Partition = decode(rows[0].get("body"))?;
        if partition.assignment.binding != input.parent.request.binding
            || !partition.assignment.continues(&input.parent.assignment)
            || !matches!(partition.owner_run.as_ref(), Some(id) if id == &input.run_id || id == &input.parent.owner_run)
        { return Err(SyncError::protocol()); }
        let checkpoint = super::frontier(snapshot, &partition.assignment.binding).await?.into_iter()
            .find(|frontier| frontier.assignment == partition.assignment).ok_or_else(SyncError::protocol)?.checkpoint;
        Ok((partition, checkpoint))
    })).await
}

pub(crate) async fn stop_run_basis(
    tx: &WorldTransaction<'_>,
    request: &BindingCommand,
) -> Result<
    (
        Option<world_protocol::ids::ReleaseId>,
        Option<world_protocol::ids::ActivationLockId>,
    ),
    SyncError,
> {
    let partition = stop_partition(tx, request).await?;
    if partition.state == super::model::PartitionState::Sealed
        && partition.reader_stopped
        && partition.ack_stopped
    {
        return Ok((None, None));
    }
    let id = partition
        .owner_run
        .as_ref()
        .ok_or_else(SyncError::protocol)?;
    let run = crate::owner::read_run(tx, id).await?;
    let (Some(release), Some(lock)) = (run.release_id, run.activation_lock_id) else {
        return Err(SyncError::protocol());
    };
    let row = tx
        .query_opt(
            "SELECT kind,basis FROM world_run WHERE tenant_id=$1 AND world_id=$2 AND run_id=$3",
            &[
                &tx.world().tenant_id.as_str(),
                &tx.world().world_id.as_str(),
                &id.as_str(),
            ],
        )
        .await?
        .ok_or_else(SyncError::protocol)?;
    let command: world_protocol::api::WorldCommand = decode(row.get("basis"))?;
    let matches_request = match &command {
        world_protocol::api::WorldCommand::StartSync(original) => original == request,
        world_protocol::api::WorldCommand::Reconcile(original) => {
            original.bindings.contains(&request.binding)
        }
        _ => false,
    };
    if row.get::<_, String>("kind") != command.operation_name() || !matches_request {
        return Err(SyncError::protocol());
    }
    Ok((Some(release), Some(lock)))
}

pub(crate) async fn status_impact(
    tx: &WorldTransaction<'_>,
    request: &BindingQuery,
    _now: &Timestamp,
) -> Result<ActualImpact, SyncError> {
    let binding = mapping::read_binding(tx, &request.binding)
        .await?
        .ok_or_else(SyncError::protocol)?;
    mapping::binding_impact(tx, &binding, vec![AccessMode::Read]).await
}
pub(crate) async fn status(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    request: &BindingQuery,
    now: &Timestamp,
) -> Result<SourceCheckpoint, SyncError> {
    admission.require_access(&status_impact(tx, request, now).await?)?;
    authorization::recheck(tx, admission, now).await?;
    let w = tx.world();
    let rows = tx.query("SELECT body FROM world_source_partition WHERE tenant_id=$1 AND world_id=$2 AND binding_id=$3 AND binding_revision=$4 ORDER BY partition_key", &[&w.tenant_id.as_str(),&w.world_id.as_str(),&request.binding.id.as_str(),&super::number(request.binding.revision.0)?]).await?;
    // Current native drivers expose exactly one declared resource partition per binding.
    if rows.len() != 1 {
        return Err(SyncError::protocol());
    }
    let p: Partition = decode(rows[0].get("body"))?;
    if p.assignment.binding != request.binding {
        return Err(SyncError::protocol());
    }
    Ok(super::partition::load(tx, &p.assignment).await?.source)
}
