use super::{
    Assignment, Checkpoint, SyncError, authorize, changed, decode, encode,
    model::{Handoff, Partition, PartitionState},
    number,
};
use crate::{authorization::Admission, sources::mapping, store::WorldTransaction};
use world_protocol::{
    authorization::AccessMode,
    failure::FailureStage,
    ids::*,
    sources::{SourceCheckpoint, SourceFailure},
};

pub(crate) async fn initialize(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    assignment: &Assignment,
    owner_run: &RunId,
    desired_running: bool,
) -> Result<Checkpoint, SyncError> {
    authorize(tx, admission, assignment, AccessMode::Manage).await?;
    validate_assignment(tx, assignment).await?;
    if assignment.epoch != PartitionEpoch(1) {
        return Err(SyncError::protocol());
    }
    let partition = Partition {
        assignment: assignment.clone(),
        owner_run: Some(owner_run.clone()),
        desired_running,
        revision: Revision(1),
        state: PartitionState::Running,
        reader_stopped: false,
        ack_stopped: false,
        native_fence: None,
    };
    let body = encode(&partition)?;
    tx.execute("INSERT INTO world_source_partition(tenant_id,world_id,source_id,partition_key,source_incarnation,binding_id,binding_revision,partition_epoch,state,checkpoint_format,reader_stopped,ack_stopped,revision,body) VALUES($1,$2,$3,$4,$5,$6,$7,1,'running',$8,false,false,1,$9) ON CONFLICT(tenant_id,world_id,source_id,partition_key) DO NOTHING", &[&assignment.world.tenant_id.as_str(), &assignment.world.world_id.as_str(), &assignment.source_id.as_str(), &assignment.partition, &assignment.incarnation, &assignment.binding.id.as_str(), &number(assignment.binding.revision.0)?, &assignment.format.as_str(), &body]).await?;
    let current = locked(tx, assignment).await?;
    if current != partition {
        return Err(SyncError::protocol());
    }
    tx.execute("INSERT INTO world_source_checkpoint(tenant_id,world_id,source_id,partition_key,partition_epoch,revision,checkpoint_format) VALUES($1,$2,$3,$4,1,1,$5) ON CONFLICT(tenant_id,world_id,source_id,partition_key) DO NOTHING", &[&assignment.world.tenant_id.as_str(), &assignment.world.world_id.as_str(), &assignment.source_id.as_str(), &assignment.partition, &assignment.format.as_str()]).await?;
    load(tx, assignment).await
}

pub(crate) async fn load(
    tx: &WorldTransaction<'_>,
    assignment: &Assignment,
) -> Result<Checkpoint, SyncError> {
    if tx.world() != &assignment.world {
        return Err(SyncError::protocol());
    }
    let row = tx.query_opt("SELECT partition_epoch,revision,checkpoint_format,captured,applied,acknowledged,projected,captured_sequence,applied_sequence,acknowledged_sequence,projected_sequence,gap FROM world_source_checkpoint WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 AND partition_key=$4 FOR UPDATE", &[&assignment.world.tenant_id.as_str(), &assignment.world.world_id.as_str(), &assignment.source_id.as_str(), &assignment.partition]).await?.ok_or_else(SyncError::protocol)?;
    let actual = PartitionEpoch(row.get::<_, i64>("partition_epoch") as u64);
    if actual != assignment.epoch {
        return Err(super::source_failure(
            SourceFailure::EpochStale {
                expected: assignment.epoch,
                actual,
            },
            FailureStage::Validate,
        ));
    }
    if row.get::<_, String>("checkpoint_format") != assignment.format.as_str() {
        return Err(super::source_failure(
            SourceFailure::CheckpointIncompatible {
                format: assignment.format.clone(),
            },
            FailureStage::Validate,
        ));
    }
    let position = |name| -> Result<_, SyncError> {
        row.get::<_, Option<serde_json::Value>>(name)
            .map(decode)
            .transpose()
    };
    let sequence = |name| row.get::<_, Option<i64>>(name).map(|n| n as u64);
    let checkpoint = Checkpoint {
        source: SourceCheckpoint {
            binding: assignment.binding.clone(),
            epoch: actual,
            captured: position("captured")?,
            applied: position("applied")?,
            acknowledged: position("acknowledged")?,
            projected: position("projected")?,
            gap: row
                .get::<_, Option<serde_json::Value>>("gap")
                .map(decode)
                .transpose()?,
        },
        revision: Revision(row.get::<_, i64>("revision") as u64),
        captured_sequence: sequence("captured_sequence"),
        applied_sequence: sequence("applied_sequence"),
        acknowledged_sequence: sequence("acknowledged_sequence"),
        projected_sequence: sequence("projected_sequence"),
    };
    if checkpoint.applied_sequence > checkpoint.captured_sequence
        || checkpoint.acknowledged_sequence > checkpoint.applied_sequence
        || checkpoint.projected_sequence > checkpoint.applied_sequence
    {
        return Err(SyncError::protocol());
    }
    Ok(checkpoint)
}

pub(super) async fn locked(
    tx: &WorldTransaction<'_>,
    assignment: &Assignment,
) -> Result<Partition, SyncError> {
    if tx.world() != &assignment.world {
        return Err(SyncError::protocol());
    }
    let row = tx.query_opt("SELECT body FROM world_source_partition WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 AND partition_key=$4 FOR UPDATE", &[&assignment.world.tenant_id.as_str(), &assignment.world.world_id.as_str(), &assignment.source_id.as_str(), &assignment.partition]).await?.ok_or_else(SyncError::protocol)?;
    let partition: Partition = decode(row.get("body"))?;
    if partition.assignment != *assignment {
        return Err(super::source_failure(
            SourceFailure::EpochStale {
                expected: assignment.epoch,
                actual: partition.assignment.epoch,
            },
            FailureStage::Validate,
        ));
    }
    Ok(partition)
}

pub(super) async fn running(
    tx: &WorldTransaction<'_>,
    assignment: &Assignment,
) -> Result<(), SyncError> {
    let partition = locked(tx, assignment).await?;
    if partition.state != PartitionState::Running {
        return Err(super::source_failure(
            SourceFailure::ReaderNotStopped,
            FailureStage::Validate,
        ));
    }
    Ok(())
}

pub(crate) async fn begin_quiesce(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    assignment: &Assignment,
) -> Result<(), SyncError> {
    authorize(tx, admission, assignment, AccessMode::Manage).await?;
    let mut partition = locked(tx, assignment).await?;
    if partition.state == PartitionState::Quiescing {
        return Ok(());
    }
    if partition.state != PartitionState::Running {
        return Err(SyncError::protocol());
    }
    partition.state = PartitionState::Quiescing;
    save(tx, &mut partition).await
}

pub(super) async fn request_stop(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    assignment: &Assignment,
) -> Result<(), SyncError> {
    authorize(tx, admission, assignment, AccessMode::Manage).await?;
    let mut partition = locked(tx, assignment).await?;
    if partition.desired_running {
        partition.desired_running = false;
        save(tx, &mut partition).await?;
    }
    Ok(())
}

/// The token is issued only after both real carrier tasks and their I/O cleanup have joined.
pub(crate) async fn seal(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    stopped: &super::lifecycle::StoppedCarriers,
    next: &Assignment,
    id: RunId,
) -> Result<Handoff, SyncError> {
    let assignment = stopped.assignment();
    let now = authorize(tx, admission, assignment, AccessMode::Manage).await?;
    let mut partition = locked(tx, assignment).await?;
    if partition.state != PartitionState::Quiescing
        || next.world != assignment.world
        || next.source_id != assignment.source_id
        || next.partition != assignment.partition
        || next.epoch.0
            != assignment
                .epoch
                .0
                .checked_add(1)
                .ok_or_else(SyncError::protocol)?
    {
        return Err(SyncError::protocol());
    }
    partition.reader_stopped = true;
    partition.ack_stopped = true;
    partition.state = PartitionState::Sealed;
    save(tx, &mut partition).await?;
    let checkpoint = load(tx, assignment).await?;
    let handoff = Handoff {
        id,
        assignment: assignment.clone(),
        next: next.clone(),
        checkpoint: checkpoint.clone(),
        sealed_at: now,
    };
    let queued_ack = checkpoint
        .source
        .applied
        .as_ref()
        .filter(|_| checkpoint.applied_sequence != checkpoint.acknowledged_sequence);
    tx.execute("INSERT INTO world_source_handoff(tenant_id,world_id,handoff_id,source_id,partition_key,source_epoch,target_epoch,phase,from_binding_id,from_binding_revision,to_binding_id,to_binding_revision,checkpoint,queued_ack,retained_contracts,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,'sealed',$8,$9,$10,$11,$12,$13,$14,$15)", &[&assignment.world.tenant_id.as_str(), &assignment.world.world_id.as_str(), &handoff.id.as_str(), &assignment.source_id.as_str(), &assignment.partition, &number(assignment.epoch.0)?, &number(next.epoch.0)?, &assignment.binding.id.as_str(), &number(assignment.binding.revision.0)?, &next.binding.id.as_str(), &number(next.binding.revision.0)?, &encode(&checkpoint)?, &encode(&queued_ack)?, &encode(&assignment.implementation.contracts)?, &encode(&handoff)?]).await?;
    Ok(handoff)
}

pub(crate) async fn activate(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    id: &RunId,
    next: &Assignment,
) -> Result<Checkpoint, SyncError> {
    authorize(tx, admission, next, AccessMode::Manage).await?;
    validate_assignment(tx, next).await?;
    let row = tx.query_opt("SELECT receipt,phase FROM world_source_handoff WHERE tenant_id=$1 AND world_id=$2 AND handoff_id=$3 FOR UPDATE", &[&next.world.tenant_id.as_str(), &next.world.world_id.as_str(), &id.as_str()]).await?.ok_or_else(SyncError::protocol)?;
    let handoff: Handoff = decode(row.get("receipt"))?;
    if handoff.next != *next || row.get::<_, String>("phase") != "sealed" {
        return Err(SyncError::protocol());
    }
    let mut partition = locked(tx, &handoff.assignment).await?;
    if partition.state != PartitionState::Sealed
        || !partition.reader_stopped
        || !partition.ack_stopped
        || load(tx, &handoff.assignment).await? != handoff.checkpoint
    {
        return Err(SyncError::protocol());
    }
    // A changed incarnation/format needs a new honest snapshot, not an invented cursor conversion.
    if next.format != handoff.assignment.format
        || next.incarnation != handoff.assignment.incarnation
    {
        return Err(super::source_failure(
            SourceFailure::CheckpointIncompatible {
                format: next.format.clone(),
            },
            FailureStage::Validate,
        ));
    }
    partition.assignment = next.clone();
    partition.state = PartitionState::Running;
    partition.reader_stopped = false;
    partition.ack_stopped = false;
    save(tx, &mut partition).await?;
    changed(tx.execute("UPDATE world_source_checkpoint SET partition_epoch=$5,revision=revision+1 WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 AND partition_key=$4 AND partition_epoch=$6", &[&next.world.tenant_id.as_str(), &next.world.world_id.as_str(), &next.source_id.as_str(), &next.partition, &number(next.epoch.0)?, &number(handoff.assignment.epoch.0)?]).await?, next)?;
    tx.execute("UPDATE world_source_handoff SET phase='activated' WHERE tenant_id=$1 AND world_id=$2 AND handoff_id=$3 AND phase='sealed'", &[&next.world.tenant_id.as_str(), &next.world.world_id.as_str(), &id.as_str()]).await?;
    load(tx, next).await
}

pub(super) async fn stopped(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    a: &Assignment,
    stopped: Option<&super::StoppedCarriers>,
) -> Result<Checkpoint, SyncError> {
    authorize(tx, admission, a, AccessMode::Manage).await?;
    if stopped.is_some_and(|proof| proof.assignment() != a) {
        return Err(SyncError::protocol());
    }
    let mut partition = locked(tx, a).await?;
    if partition.state != PartitionState::Quiescing && partition.state != PartitionState::Sealed {
        return Err(SyncError::protocol());
    }
    partition.reader_stopped = true;
    partition.ack_stopped = true;
    partition.state = PartitionState::Sealed;
    save(tx, &mut partition).await?;
    load(tx, a).await
}

/// The caller holds native exclusion through this epoch CAS; no historical join is implied.
pub(super) async fn fence_epoch(
    tx: &WorldTransaction<'_>, admission: &Admission, old: &Partition, next: &Assignment,
    owner_run: &RunId, proof: &crate::sources::connectors::cdc::NativeSourceFence, cleanup_only: bool,
) -> Result<Checkpoint, SyncError> {
    authorize(tx, admission, &old.assignment, AccessMode::Manage).await?;
    validate_assignment(tx, next).await?;
    let current = locked(tx, &old.assignment).await?;
    let checkpoint = load(tx, &old.assignment).await?;
    if current != *old || current.owner_run.as_ref() != Some(owner_run)
        || !matches!(current.state, PartitionState::Running | PartitionState::Quiescing | PartitionState::Fenced)
        || !next.continues(&old.assignment) || next.epoch.0 != old.assignment.epoch.0.checked_add(1).ok_or_else(SyncError::protocol)?
        || !proof.permits(next, checkpoint.source.applied.as_ref())
    { return Err(SyncError::protocol()); }
    let mut partition = current;
    partition.assignment = next.clone();
    partition.state = if cleanup_only { PartitionState::Fenced } else { PartitionState::Running };
    // These flags mean joined, not excluded by the native fence.
    partition.reader_stopped = false;
    partition.ack_stopped = false;
    partition.native_fence = Some(tx.commit_id().clone());
    save(tx, &mut partition).await?;
    changed(tx.execute("UPDATE world_source_checkpoint SET partition_epoch=$5,revision=revision+1 WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 AND partition_key=$4 AND partition_epoch=$6", &[&next.world.tenant_id.as_str(), &next.world.world_id.as_str(), &next.source_id.as_str(), &next.partition, &number(next.epoch.0)?, &number(old.assignment.epoch.0)?]).await?, next)?;
    load(tx, next).await
}

pub(super) async fn restart(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    old: &Partition,
    next: &Assignment,
    owner_run: &RunId,
    desired_running: bool,
) -> Result<Checkpoint, SyncError> {
    authorize(tx, admission, next, AccessMode::Manage).await?;
    validate_assignment(tx, next).await?;
    let current = locked(tx, &old.assignment).await?;
    if &current != old
        || current.state != PartitionState::Sealed
        || !current.reader_stopped
        || !current.ack_stopped
        || next.epoch.0
            != old
                .assignment
                .epoch
                .0
                .checked_add(1)
                .ok_or_else(SyncError::protocol)?
        || next.source_id != old.assignment.source_id
        || next.partition != old.assignment.partition
    {
        return Err(SyncError::protocol());
    }
    let mut partition = current;
    partition.assignment = next.clone();
    partition.owner_run = Some(owner_run.clone());
    partition.desired_running = desired_running;
    partition.native_fence = None;
    partition.state = PartitionState::Running;
    partition.reader_stopped = false;
    partition.ack_stopped = false;
    save(tx, &mut partition).await?;
    let compatible =
        next.format == old.assignment.format && next.incarnation == old.assignment.incarnation;
    if compatible {
        changed(tx.execute("UPDATE world_source_checkpoint SET partition_epoch=$5,revision=revision+1 WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 AND partition_key=$4 AND partition_epoch=$6", &[&next.world.tenant_id.as_str(),&next.world.world_id.as_str(),&next.source_id.as_str(),&next.partition,&number(next.epoch.0)?,&number(old.assignment.epoch.0)?]).await?,next)?;
    } else {
        let gap = world_protocol::sources::SourceGap {
            reason: world_protocol::sources::GapReason::IncompleteEnumeration,
            after: None,
            before: None,
        };
        changed(tx.execute("UPDATE world_source_checkpoint SET partition_epoch=$5,revision=revision+1,checkpoint_format=$7,captured=NULL,applied=NULL,acknowledged=NULL,projected=NULL,captured_sequence=NULL,applied_sequence=NULL,acknowledged_sequence=NULL,projected_sequence=NULL,gap=$8 WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 AND partition_key=$4 AND partition_epoch=$6", &[&next.world.tenant_id.as_str(),&next.world.world_id.as_str(),&next.source_id.as_str(),&next.partition,&number(next.epoch.0)?,&number(old.assignment.epoch.0)?,&next.format.as_str(),&encode(&gap)?]).await?,next)?;
    }
    load(tx, next).await
}

/// A branch capture owns a completed, joined scan, not a live reader or ACK channel.
pub(super) async fn install_branch_capture(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    capture: &super::BranchCapture,
) -> Result<Assignment, SyncError> {
    let mut next = capture.raw.assignment.clone();
    authorize(tx, admission, &next, AccessMode::Manage).await?;
    let w = tx.world();
    let row = tx.query_opt("SELECT body FROM world_source_partition WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 AND partition_key=$4 FOR UPDATE", &[&w.tenant_id.as_str(), &w.world_id.as_str(), &next.source_id.as_str(), &next.partition]).await?;
    match row {
        Some(row) => {
            let mut old: Partition = decode(row.get("body"))?;
            if old.state != PartitionState::Sealed || !old.reader_stopped {
                return Err(super::source_failure(
                    SourceFailure::ReaderNotStopped,
                    FailureStage::Validate,
                ));
            }
            if !old.ack_stopped {
                return Err(super::source_failure(
                    SourceFailure::AckChannelNotStopped,
                    FailureStage::Validate,
                ));
            }
            let checkpoint = load(tx, &old.assignment).await?;
            if checkpoint.captured_sequence != checkpoint.applied_sequence
                || old.assignment.incarnation != next.incarnation
                || old.assignment.format != next.format
                || old.assignment.binding.id != next.binding.id
            {
                return Err(SyncError::protocol());
            }
            let has_claims = tx.query_opt("SELECT 1 FROM world_source_claim WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 AND partition_key=$4 AND binding_id=$5 LIMIT 1", &[&w.tenant_id.as_str(), &w.world_id.as_str(), &next.source_id.as_str(), &next.partition, &next.binding.id.as_str()]).await?.is_some();
            if has_claims && old.assignment.scope != next.scope {
                return Err(world_protocol::sources::MappingFailure::AuthorityMismatch.into());
            }
            next.epoch = PartitionEpoch(
                old.assignment
                    .epoch
                    .0
                    .checked_add(1)
                    .ok_or_else(SyncError::protocol)?,
            );
            let previous_epoch = old.assignment.epoch;
            old.assignment = next.clone();
            old.owner_run = None;
            save(tx, &mut old).await?;
            changed(tx.execute("UPDATE world_source_checkpoint SET partition_epoch=$5,revision=revision+1,projected=NULL,projected_sequence=NULL WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 AND partition_key=$4 AND partition_epoch=$6", &[&w.tenant_id.as_str(), &w.world_id.as_str(), &next.source_id.as_str(), &next.partition, &number(next.epoch.0)?, &number(previous_epoch.0)?]).await?, &next)?;
        }
        None => {
            if next.epoch != PartitionEpoch(1) {
                return Err(SyncError::protocol());
            }
            let partition = Partition {
                assignment: next.clone(),
                owner_run: None,
                desired_running: false,
                revision: Revision(1),
                state: PartitionState::Sealed,
                reader_stopped: true,
                ack_stopped: true,
                native_fence: None,
            };
            tx.execute("INSERT INTO world_source_partition(tenant_id,world_id,source_id,partition_key,source_incarnation,binding_id,binding_revision,partition_epoch,state,checkpoint_format,reader_stopped,ack_stopped,revision,body) VALUES($1,$2,$3,$4,$5,$6,$7,1,'sealed',$8,true,true,1,$9)", &[&w.tenant_id.as_str(), &w.world_id.as_str(), &next.source_id.as_str(), &next.partition, &next.incarnation, &next.binding.id.as_str(), &number(next.binding.revision.0)?, &next.format.as_str(), &encode(&partition)?]).await?;
            tx.execute("INSERT INTO world_source_checkpoint(tenant_id,world_id,source_id,partition_key,partition_epoch,revision,checkpoint_format) VALUES($1,$2,$3,$4,1,1,$5)", &[&w.tenant_id.as_str(), &w.world_id.as_str(), &next.source_id.as_str(), &next.partition, &next.format.as_str()]).await?;
        }
    }
    Ok(next)
}

async fn save(tx: &WorldTransaction<'_>, partition: &mut Partition) -> Result<(), SyncError> {
    let expected = partition.revision;
    partition.revision = Revision(expected.0.checked_add(1).ok_or_else(SyncError::protocol)?);
    let a = &partition.assignment;
    let state = match partition.state {
        PartitionState::Running => "running",
        PartitionState::Quiescing => "quiescing",
        PartitionState::Sealed => "sealed",
        PartitionState::Resuming => "resuming",
        PartitionState::Gap => "gap",
        PartitionState::Fenced => "fenced",
    };
    changed(tx.execute("UPDATE world_source_partition SET source_incarnation=$5,binding_id=$6,binding_revision=$7,partition_epoch=$8,state=$9,checkpoint_format=$10,reader_stopped=$11,ack_stopped=$12,revision=$13,body=$14 WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 AND partition_key=$4 AND revision=$15", &[&a.world.tenant_id.as_str(), &a.world.world_id.as_str(), &a.source_id.as_str(), &a.partition, &a.incarnation, &a.binding.id.as_str(), &number(a.binding.revision.0)?, &number(a.epoch.0)?, &state, &a.format.as_str(), &partition.reader_stopped, &partition.ack_stopped, &number(partition.revision.0)?, &encode(partition)?, &number(expected.0)?]).await?, a)
}

async fn validate_assignment(tx: &WorldTransaction<'_>, a: &Assignment) -> Result<(), SyncError> {
    if a.epoch.0 == 0
        || a.partition.is_empty()
        || a.partition.len() > 256
        || a.incarnation.is_empty()
        || a.binding.world != a.world
    {
        return Err(SyncError::protocol());
    }
    let binding = mapping::read_binding(tx, &a.binding)
        .await?
        .ok_or_else(SyncError::protocol)?;
    let b = binding.body;
    if b.source_id != a.source_id
        || b.incarnation != a.incarnation
        || b.connection_id != a.connection_id
        || b.connection_revision != a.connection_revision
        || b.mapping != a.mapping
        || b.schema != a.schema
        || b.identity_rule != a.identity_rule
        || b.scope != a.scope
    {
        return Err(SyncError::protocol());
    }
    let current = tx.query_opt("SELECT revision FROM world_source_binding_head WHERE tenant_id=$1 AND world_id=$2 AND binding_id=$3 FOR SHARE", &[&a.world.tenant_id.as_str(), &a.world.world_id.as_str(), &a.binding.id.as_str()]).await?.ok_or_else(SyncError::protocol)?;
    if current.get::<_, i64>("revision") != number(a.binding.revision.0)? {
        return Err(SyncError::protocol());
    }
    Ok(())
}
