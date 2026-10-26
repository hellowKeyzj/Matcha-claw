use super::{Assignment, Checkpoint, SyncError, authorize, decode, number};
use crate::{
    authorization::Admission,
    extensions::invocation::CallBudget,
    store::{WorldSnapshot, WorldTransaction},
};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;
use world_protocol::{
    authorization::AccessMode,
    budget::BudgetDimension,
    failure::FailureStage,
    ids::*,
    sources::{SourceBasis, SourceFailure, SourcePosition},
    time::Timestamp,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct Frontier {
    pub assignment: Assignment,
    pub partition: String,
    pub checkpoint: Checkpoint,
    pub last_reconciled_at: Option<Timestamp>,
    pub updated_at: Timestamp,
}
/// The private constructor reads the exact durable applied prefix; a DTO offset cannot create it.
pub(crate) struct AppliedAck {
    assignment: Assignment,
    position: SourcePosition,
    sequence: u64,
}
impl AppliedAck {
    pub(crate) fn assignment(&self) -> &Assignment {
        &self.assignment
    }
    pub(crate) fn position(&self) -> &SourcePosition {
        &self.position
    }
    pub(crate) fn sequence(&self) -> u64 {
        self.sequence
    }
}
pub(crate) async fn prepare_ack(
    snapshot: &WorldSnapshot<'_>,
    admission: &Admission,
    a: &Assignment,
) -> Result<Option<AppliedAck>, SyncError> {
    if snapshot.world() != &a.world {
        return Err(SyncError::protocol());
    }
    let now = snapshot.now().await?;
    crate::authorization::recheck_read(snapshot, admission, &now).await?;
    let impact = crate::authorization::actual_impact(
        vec![world_protocol::authorization::AccessScope {
            resources: vec![ResourceRef::Source {
                id: a.source_id.clone(),
            }],
            fields: Vec::new(),
            modes: vec![AccessMode::Read],
            scope: a.scope.clone(),
            valid_time: None,
        }],
        Vec::new(),
        Vec::new(),
        Vec::new(),
        vec![a.source_id.clone()],
    )?;
    admission.require_access(&impact)?;
    let row = snapshot.query_opt("SELECT p.body,c.applied_sequence,c.acknowledged_sequence,c.applied,c.gap FROM world_source_partition p JOIN world_source_checkpoint c USING(tenant_id,world_id,source_id,partition_key) WHERE p.tenant_id=$1 AND p.world_id=$2 AND p.source_id=$3 AND p.partition_key=$4", &[&a.world.tenant_id.as_str(), &a.world.world_id.as_str(), &a.source_id.as_str(), &a.partition]).await?.ok_or_else(SyncError::protocol)?;
    let partition: super::model::Partition = decode(row.get("body"))?;
    if partition.assignment != *a
        || partition.state != super::model::PartitionState::Running
        || row.get::<_, Option<serde_json::Value>>("gap").is_some()
    {
        return Ok(None);
    }
    let (Some(sequence), Some(value)) = (
        row.get::<_, Option<i64>>("applied_sequence"),
        row.get::<_, Option<serde_json::Value>>("applied"),
    ) else {
        return Ok(None);
    };
    if row
        .get::<_, Option<i64>>("acknowledged_sequence")
        .is_some_and(|n| n >= sequence)
    {
        return Ok(None);
    }
    let position: SourcePosition = decode(value)?;
    let row = snapshot.query_opt("SELECT transaction_complete,status,position,body FROM world_source_inbox WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 AND partition_key=$4 AND sequence=$5 ORDER BY partition_epoch DESC LIMIT 1", &[&a.world.tenant_id.as_str(), &a.world.world_id.as_str(), &a.source_id.as_str(), &a.partition, &sequence]).await?.ok_or_else(SyncError::protocol)?;
    if !row.get::<_, bool>("transaction_complete")
        || row.get::<_, String>("status") != "applied"
        || decode::<SourcePosition>(row.get("position"))? != position
    {
        return Err(SyncError::protocol());
    }
    let entry: super::inbox::Entry = decode(row.get("body"))?;
    if entry.input.position != position
        || entry.raw.position != position
        || entry.input.sequence != sequence as u64
        || entry.input.kind != entry.raw.kind
        || entry.input.basis != entry.raw.page.basis
        || !a.continues(&entry.raw.assignment)
    {
        return Err(SyncError::protocol());
    }
    let Some(native) = entry.raw.change_position()? else {
        return Ok(None);
    };
    if native != &position
        || !matches!(
            &entry.raw.kind,
            super::CaptureKind::Changes { complete: true, .. }
        )
    {
        return Err(SyncError::protocol());
    }
    Ok(Some(AppliedAck {
        assignment: a.clone(),
        position,
        sequence: sequence as u64,
    }))
}

pub(crate) async fn frontier(
    snapshot: &WorldSnapshot<'_>,
    binding: &DefinitionRef,
) -> Result<Vec<Frontier>, SyncError> {
    if snapshot.world() != &binding.world {
        return Err(SyncError::protocol());
    }
    let w = snapshot.world();
    let rows = snapshot.query("SELECT p.partition_key,p.body,c.*,to_char(c.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS updated_text,(SELECT to_char(max(r.last_reconciled_at) AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') FROM world_source_reconcile r WHERE r.tenant_id=p.tenant_id AND r.world_id=p.world_id AND r.source_id=p.source_id AND r.partition_key=p.partition_key AND r.phase='complete') AS reconciled_text FROM world_source_partition p JOIN world_source_checkpoint c USING(tenant_id,world_id,source_id,partition_key) WHERE p.tenant_id=$1 AND p.world_id=$2 AND p.binding_id=$3 AND p.binding_revision=$4 ORDER BY p.partition_key", &[&w.tenant_id.as_str(), &w.world_id.as_str(), &binding.id.as_str(), &number(binding.revision.0)?]).await?;
    let mut result = Vec::with_capacity(rows.len());
    for row in rows {
        let p: super::model::Partition = decode(row.get("body"))?;
        let optional = |name| {
            row.get::<_, Option<serde_json::Value>>(name)
                .map(decode)
                .transpose()
        };
        let seq = |name| row.get::<_, Option<i64>>(name).map(|n| n as u64);
        let checkpoint = Checkpoint {
            source: world_protocol::sources::SourceCheckpoint {
                binding: binding.clone(),
                epoch: p.assignment.epoch,
                captured: optional("captured")?,
                applied: optional("applied")?,
                acknowledged: optional("acknowledged")?,
                projected: optional("projected")?,
                gap: row
                    .get::<_, Option<serde_json::Value>>("gap")
                    .map(decode)
                    .transpose()?,
            },
            revision: Revision(row.get::<_, i64>("revision") as u64),
            captured_sequence: seq("captured_sequence"),
            applied_sequence: seq("applied_sequence"),
            acknowledged_sequence: seq("acknowledged_sequence"),
            projected_sequence: seq("projected_sequence"),
        };
        result.push(Frontier {
            assignment: p.assignment.clone(),
            partition: p.assignment.partition,
            checkpoint,
            last_reconciled_at: row
                .get::<_, Option<String>>("reconciled_text")
                .map(Timestamp::try_new)
                .transpose()
                .map_err(|_| SyncError::protocol())?,
            updated_at: Timestamp::try_new(row.get::<_, String>("updated_text"))
                .map_err(|_| SyncError::protocol())?,
        });
    }
    Ok(result)
}
pub(crate) async fn require_after(
    snapshot: &WorldSnapshot<'_>,
    binding: &DefinitionRef,
    position: &SourcePosition,
) -> Result<(), SyncError> {
    let w = snapshot.world();
    if w != &binding.world {
        return Err(SyncError::protocol());
    }
    let row = snapshot.query_opt("SELECT i.sequence,c.projected_sequence,p.source_incarnation,p.binding_id,p.binding_revision,c.gap FROM world_source_inbox i JOIN world_source_checkpoint c USING(tenant_id,world_id,source_id,partition_key) JOIN world_source_partition p USING(tenant_id,world_id,source_id,partition_key) WHERE i.tenant_id=$1 AND i.world_id=$2 AND i.source_id=$3 AND i.partition_key=$4 AND i.position=$5 ORDER BY i.partition_epoch DESC LIMIT 1", &[&w.tenant_id.as_str(), &w.world_id.as_str(), &position.source_id.as_str(), &position.partition, &super::encode(position)?]).await?.ok_or_else(|| super::source_failure(SourceFailure::PositionIncomparable, FailureStage::Read))?;
    if row.get::<_, String>("source_incarnation") != position.incarnation
        || row.get::<_, String>("binding_id") != binding.id.as_str()
        || row.get::<_, i64>("binding_revision") != number(binding.revision.0)?
        || row
            .get::<_, Option<i64>>("projected_sequence")
            .is_none_or(|n| n < row.get::<_, i64>("sequence"))
        || row.get::<_, Option<serde_json::Value>>("gap").is_some()
    {
        return Err(super::source_failure(
            SourceFailure::PositionIncomparable,
            FailureStage::Read,
        ));
    }
    Ok(())
}
/// A completed reconcile establishes coverage; the current applied Inbox supplies the actual basis.
pub(crate) async fn projection_basis(
    snapshot: &WorldSnapshot<'_>,
    frontier: &Frontier,
) -> Result<Option<SourceBasis>, SyncError> {
    let a = &frontier.assignment;
    if snapshot.world() != &a.world || frontier.checkpoint.source.gap.is_some() {
        return Ok(None);
    }
    let Some(sequence) = frontier.checkpoint.applied_sequence else {
        return Ok(None);
    };
    let row = snapshot.query_opt("SELECT p.body,c.applied_sequence,c.applied,c.gap,i.body AS input,i.status,i.transaction_complete FROM world_source_partition p JOIN world_source_checkpoint c USING(tenant_id,world_id,source_id,partition_key) JOIN LATERAL (SELECT i.* FROM world_source_inbox i WHERE i.tenant_id=c.tenant_id AND i.world_id=c.world_id AND i.source_id=c.source_id AND i.partition_key=c.partition_key AND i.partition_epoch<=c.partition_epoch AND i.sequence=c.applied_sequence ORDER BY i.partition_epoch DESC LIMIT 1) i ON true WHERE p.tenant_id=$1 AND p.world_id=$2 AND p.source_id=$3 AND p.partition_key=$4", &[&a.world.tenant_id.as_str(), &a.world.world_id.as_str(), &a.source_id.as_str(), &a.partition]).await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let partition: super::model::Partition = decode(row.get("body"))?;
    let input: super::inbox::Entry = decode(row.get("input"))?;
    if partition.assignment != *a
        || !projection_available(&partition)
        || row.get::<_, Option<i64>>("applied_sequence") != Some(number(sequence)?)
        || row.get::<_, Option<serde_json::Value>>("gap").is_some()
        || row.get::<_, String>("status") != "applied"
        || !row.get::<_, bool>("transaction_complete")
        || frontier.checkpoint.source.applied.as_ref() != Some(&input.input.position)
        || !a.continues(&input.raw.assignment)
        || input.input.basis.gap.is_some()
    {
        return Ok(None);
    }
    let completed = snapshot.query("SELECT r.basis,(SELECT max(i.sequence) FROM world_source_inbox i WHERE i.tenant_id=r.tenant_id AND i.world_id=r.world_id AND i.source_id=r.source_id AND i.partition_key=r.partition_key AND i.body->'input'->'kind'->'Snapshot'->>'run'=r.run_id AND i.status='applied') AS sequence FROM world_source_reconcile r WHERE r.tenant_id=$1 AND r.world_id=$2 AND r.source_id=$3 AND r.partition_key=$4 AND r.phase='complete' ORDER BY r.last_reconciled_at DESC", &[&a.world.tenant_id.as_str(), &a.world.world_id.as_str(), &a.source_id.as_str(), &a.partition]).await?;
    for row in completed {
        let state: super::snapshot::ReconcileState = decode(row.get("basis"))?;
        if a.continues(&state.assignment)
            && state.complete
            && state.consistent
            && state.gap.is_none()
            && state.snapshot.is_some()
            && row
                .get::<_, Option<i64>>("sequence")
                .is_some_and(|n| n <= sequence as i64)
        {
            return Ok(Some(input.input.basis));
        }
    }
    Ok(None)
}

pub(crate) async fn require_after_transaction(
    tx: &WorldTransaction<'_>,
    binding: &DefinitionRef,
    position: &SourcePosition,
) -> Result<(), SyncError> {
    let w = tx.world();
    if w != &binding.world {
        return Err(SyncError::protocol());
    }
    let row = tx.query_opt("SELECT i.sequence,c.projected_sequence,p.source_incarnation,p.binding_id,p.binding_revision,c.gap FROM world_source_inbox i JOIN world_source_checkpoint c USING(tenant_id,world_id,source_id,partition_key) JOIN world_source_partition p USING(tenant_id,world_id,source_id,partition_key) WHERE i.tenant_id=$1 AND i.world_id=$2 AND i.source_id=$3 AND i.partition_key=$4 AND i.position=$5 ORDER BY i.partition_epoch DESC LIMIT 1", &[&w.tenant_id.as_str(), &w.world_id.as_str(), &position.source_id.as_str(), &position.partition, &super::encode(position)?]).await?.ok_or_else(|| super::source_failure(SourceFailure::PositionIncomparable, FailureStage::Read))?;
    if row.get::<_, String>("source_incarnation") != position.incarnation
        || row.get::<_, String>("binding_id") != binding.id.as_str()
        || row.get::<_, i64>("binding_revision") != number(binding.revision.0)?
        || row
            .get::<_, Option<i64>>("projected_sequence")
            .is_none_or(|n| n < row.get::<_, i64>("sequence"))
        || row.get::<_, Option<serde_json::Value>>("gap").is_some()
    {
        return Err(super::source_failure(
            SourceFailure::PositionIncomparable,
            FailureStage::Read,
        ));
    }
    Ok(())
}

/// Only the query owner's complete, authorized scan can publish this frontier.
pub(crate) async fn publish_projection(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    proof: &crate::query::ProjectionProof,
    now: &Timestamp,
) -> Result<Checkpoint, SyncError> {
    let a = proof.assignment();
    tx.require_domain(&WriterDomain::try_new("query").map_err(|_| SyncError::protocol())?)?;
    if proof.world() != tx.world()
        || proof.world() != &a.world
        || proof.decision_id() != &admission.decision().id
    {
        return Err(SyncError::protocol());
    }
    crate::authorization::recheck(tx, admission, now).await?;
    let impact = crate::authorization::actual_impact(
        vec![world_protocol::authorization::AccessScope {
            resources: vec![ResourceRef::Source {
                id: a.source_id.clone(),
            }],
            fields: Vec::new(),
            modes: vec![AccessMode::Read],
            scope: a.scope.clone(),
            valid_time: None,
        }],
        Vec::new(),
        Vec::new(),
        Vec::new(),
        vec![a.source_id.clone()],
    )?;
    admission.require_access(&impact)?;
    let partition = super::partition::locked(tx, a).await?;
    if !projection_available(&partition) {
        return Err(SyncError::protocol());
    }
    let mut checkpoint = super::partition::load(tx, a).await?;
    if checkpoint.applied_sequence != Some(proof.sequence())
        || checkpoint.source.applied.as_ref() != Some(proof.position())
    {
        return Err(SyncError::protocol());
    }
    let row = tx.query_opt("SELECT body,position,status,transaction_complete FROM world_source_inbox WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 AND partition_key=$4 AND sequence=$5 ORDER BY partition_epoch DESC LIMIT 1", &[&a.world.tenant_id.as_str(), &a.world.world_id.as_str(), &a.source_id.as_str(), &a.partition, &number(proof.sequence())?]).await?.ok_or_else(SyncError::protocol)?;
    let input: super::inbox::Entry = decode(row.get("body"))?;
    if row.get::<_, String>("status") != "applied"
        || !row.get::<_, bool>("transaction_complete")
        || decode::<SourcePosition>(row.get("position"))? != *proof.position()
        || input.input.basis.snapshot.as_deref() != proof.snapshot()
    {
        return Err(SyncError::protocol());
    }
    if checkpoint.projected_sequence != Some(proof.sequence()) {
        checkpoint.projected_sequence = Some(proof.sequence());
        checkpoint.source.projected = Some(proof.position().clone());
        super::inbox::save_checkpoint(tx, a, &mut checkpoint, now).await?;
    }
    Ok(checkpoint)
}

/// Source-owner projection entry; query uses its narrower private proof above.
pub(crate) async fn mark_projected(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    a: &Assignment,
    sequence: u64,
    position: &SourcePosition,
) -> Result<Checkpoint, SyncError> {
    let now = authorize(tx, admission, a, AccessMode::Write).await?;
    let _ = super::partition::locked(tx, a).await?;
    let mut checkpoint = super::partition::load(tx, a).await?;
    if Some(sequence) > checkpoint.applied_sequence
        || position.source_id != a.source_id
        || position.partition != a.partition
        || position.incarnation != a.incarnation
    {
        return Err(SyncError::protocol());
    }
    if checkpoint.projected_sequence.is_some_and(|n| n >= sequence) {
        return Ok(checkpoint);
    }
    let row = tx.query_opt("SELECT status,position FROM world_source_inbox WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 AND partition_key=$4 AND sequence=$5 ORDER BY partition_epoch DESC LIMIT 1", &[&a.world.tenant_id.as_str(), &a.world.world_id.as_str(), &a.source_id.as_str(), &a.partition, &number(sequence)?]).await?.ok_or_else(SyncError::protocol)?;
    if row.get::<_, String>("status") != "applied"
        || decode::<SourcePosition>(row.get("position"))? != *position
    {
        return Err(SyncError::protocol());
    }
    checkpoint.projected_sequence = Some(sequence);
    checkpoint.source.projected = Some(position.clone());
    super::inbox::save_checkpoint(tx, a, &mut checkpoint, &now).await?;
    Ok(checkpoint)
}
fn projection_available(partition: &super::model::Partition) -> bool {
    partition.state == super::model::PartitionState::Running
        || partition.state == super::model::PartitionState::Sealed
            && partition.reader_stopped
            && partition.ack_stopped
}

/// A release must cover every actual partition of every affected exact binding.
pub(crate) async fn require_release_ready(
    tx: &WorldTransaction<'_>,
    bases: &[SourceBasis],
) -> Result<(), SyncError> {
    for basis in bases {
        recheck_basis(tx, basis).await?;
        let rows = tx.query("SELECT p.body,c.captured_sequence,c.applied_sequence,c.projected_sequence,c.gap FROM world_source_partition p JOIN world_source_checkpoint c USING(tenant_id,world_id,source_id,partition_key) WHERE p.tenant_id=$1 AND p.world_id=$2 AND p.source_id=$3 ORDER BY p.partition_key FOR SHARE OF p,c", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &basis.source_id.as_str()]).await?;
        if rows.is_empty() {
            return Err(SyncError::protocol());
        }
        for row in rows {
            let p: super::model::Partition = decode(row.get("body"))?;
            let applied = row.get::<_, Option<i64>>("applied_sequence");
            if p.assignment.binding != basis.binding
                || p.assignment.incarnation != basis.incarnation
                || p.assignment.schema != basis.schema
                || p.assignment.mapping.revision != basis.mapping_revision
                || p.assignment.identity_rule != basis.identity_rule
                || !projection_available(&p)
                || row.get::<_, Option<serde_json::Value>>("gap").is_some()
                || applied.is_none()
                || row.get::<_, Option<i64>>("captured_sequence") != applied
                || row.get::<_, Option<i64>>("projected_sequence") != applied
            {
                return Err(SyncError::protocol());
            }
            let completed = tx.query("SELECT basis FROM world_source_reconcile WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 AND partition_key=$4 AND phase='complete'", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &basis.source_id.as_str(), &p.assignment.partition]).await?;
            let mut ready = false;
            for completed in completed {
                let state: super::snapshot::ReconcileState = decode(completed.get("basis"))?;
                if p.assignment.continues(&state.assignment)
                    && state.complete
                    && state.consistent
                    && state.gap.is_none()
                {
                    ready = true;
                }
            }
            if !ready {
                return Err(SyncError::protocol());
            }
        }
    }
    Ok(())
}

#[derive(Serialize)]
struct AppliedInboxBasis {
    epoch: PartitionEpoch,
    sequence: u64,
    input_digest: Digest,
    position: SourcePosition,
    status: String,
    transaction_complete: bool,
    entry: super::inbox::Entry,
}

#[derive(Serialize)]
struct ReconcileBasis {
    run: RunId,
    phase: String,
    basis: super::snapshot::ReconcileState,
    coverage: super::snapshot::ReconcileState,
    last_key: Option<String>,
    last_reconciled_at: Option<Timestamp>,
    failure: Option<serde_json::Value>,
}

/// Missing coverage is sealed too; a ready flag alone cannot identify the observed source frontier.
pub(crate) async fn bindings_projection_basis(
    tx: &WorldTransaction<'_>,
    bindings: &[DefinitionRef],
    budget: &CallBudget,
    cancel: &CancellationToken,
) -> Result<(bool, Digest), SyncError> {
    let mut references = std::collections::BTreeSet::new();
    for reference in bindings {
        projection_step(budget, cancel)?;
        if &reference.world != tx.world() {
            return Err(SyncError::protocol());
        }
        references.insert(reference);
    }
    let w = tx.world();
    let mut ready = true;
    let mut bases = Vec::new();
    for reference in references {
        projection_step(budget, cancel)?;
        let binding = crate::sources::mapping::read_binding(tx, reference).await?;
        projection_step(budget, cancel)?;
        let head = tx.query_opt("SELECT revision FROM world_source_binding_head WHERE tenant_id=$1 AND world_id=$2 AND binding_id=$3 FOR SHARE", &[&w.tenant_id.as_str(), &w.world_id.as_str(), &reference.id.as_str()]).await?
            .map(|row| Revision(row.get::<_, i64>("revision") as u64));
        let authority = if let Some(binding) = &binding {
            projection_step(budget, cancel)?;
            let authority = crate::sources::mapping::read_authority(tx, reference, &binding.body.authority).await?;
            if let Some(authority) = &authority {
                if authority.world != *w || authority.binding != *reference
                    || authority.source_id != binding.body.source_id
                    || authority.incarnation != binding.body.incarnation
                    || authority.authority != binding.body.authority
                    || authority.scope != binding.body.scope
                {
                    return Err(SyncError::protocol());
                }
            }
            authority
        } else {
            None
        };
        let binding_ready = binding.is_some() && head == Some(reference.revision) && authority.is_some();
        ready &= binding_ready;
        projection_step(budget, cancel)?;
        let limit = projection_limit(budget)?;
        let rows = tx.query("SELECT * FROM world_source_partition WHERE tenant_id=$1 AND world_id=$2 AND binding_id=$3 AND binding_revision=$4 ORDER BY source_id,partition_key LIMIT $5 FOR SHARE", &[&w.tenant_id.as_str(), &w.world_id.as_str(), &reference.id.as_str(), &number(reference.revision.0)?, &limit]).await?;
        projection_rows(budget, rows.len())?;
        ready &= !rows.is_empty();
        let mut partitions = Vec::new();
        for row in rows {
            projection_step(budget, cancel)?;
            let partition: super::model::Partition = decode(row.get("body"))?;
            let a = &partition.assignment;
            let state = match partition.state {
                super::model::PartitionState::Running => "running",
                super::model::PartitionState::Quiescing => "quiescing",
                super::model::PartitionState::Sealed => "sealed",
                super::model::PartitionState::Resuming => "resuming",
                super::model::PartitionState::Gap => "gap",
                super::model::PartitionState::Fenced => "fenced",
            };
            if a.world != *w || a.binding != *reference
                || a.source_id.as_str() != row.get::<_, String>("source_id")
                || a.partition != row.get::<_, String>("partition_key")
                || a.incarnation != row.get::<_, String>("source_incarnation")
                || number(a.epoch.0)? != row.get::<_, i64>("partition_epoch")
                || a.format.as_str() != row.get::<_, String>("checkpoint_format")
                || state != row.get::<_, String>("state")
                || number(partition.revision.0)? != row.get::<_, i64>("revision")
                || partition.reader_stopped != row.get::<_, bool>("reader_stopped")
                || partition.ack_stopped != row.get::<_, bool>("ack_stopped")
            {
                return Err(SyncError::protocol());
            }
            if let Some(binding) = &binding {
                if a.source_id != binding.body.source_id || a.incarnation != binding.body.incarnation
                    || a.connection_id != binding.body.connection_id
                    || a.connection_revision != binding.body.connection_revision
                    || a.scope != binding.body.scope || a.schema != binding.body.schema
                    || a.mapping != binding.body.mapping || a.identity_rule != binding.body.identity_rule
                {
                    return Err(SyncError::protocol());
                }
            }
            projection_step(budget, cancel)?;
            let checkpoint = tx.query_opt("SELECT * FROM world_source_checkpoint WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 AND partition_key=$4 FOR SHARE", &[&w.tenant_id.as_str(), &w.world_id.as_str(), &a.source_id.as_str(), &a.partition]).await?
                .map(|row| projection_checkpoint(&row, a)).transpose()?;
            let input = if let Some(checkpoint) = &checkpoint {
                if let Some(sequence) = checkpoint.applied_sequence {
                    projection_step(budget, cancel)?;
                    tx.query_opt("SELECT * FROM world_source_inbox WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 AND partition_key=$4 AND partition_epoch<=$5 AND sequence=$6 ORDER BY partition_epoch DESC LIMIT 1 FOR SHARE", &[&w.tenant_id.as_str(), &w.world_id.as_str(), &a.source_id.as_str(), &a.partition, &number(checkpoint.source.epoch.0)?, &number(sequence)?]).await?
                        .map(|row| projection_input(&row, a)).transpose()?
                } else {
                    None
                }
            } else {
                None
            };
            projection_step(budget, cancel)?;
            let limit = projection_limit(budget)?;
            let rows = tx.query("SELECT run_id,phase,basis,coverage,last_key,to_char(last_reconciled_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS reconciled_text,failure FROM world_source_reconcile WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 AND partition_key=$4 ORDER BY run_id LIMIT $5 FOR SHARE", &[&w.tenant_id.as_str(), &w.world_id.as_str(), &a.source_id.as_str(), &a.partition, &limit]).await?;
            projection_rows(budget, rows.len())?;
            let mut reconciles = Vec::new();
            let mut reconciled = false;
            for row in rows {
                projection_step(budget, cancel)?;
                let reconcile = ReconcileBasis {
                    run: RunId::try_new(row.get::<_, String>("run_id")).map_err(|_| SyncError::protocol())?,
                    phase: row.get("phase"),
                    basis: decode(row.get("basis"))?,
                    coverage: decode(row.get("coverage"))?,
                    last_key: row.get("last_key"),
                    last_reconciled_at: row.get::<_, Option<String>>("reconciled_text")
                        .map(Timestamp::try_new).transpose().map_err(|_| SyncError::protocol())?,
                    failure: row.get("failure"),
                };
                for state in [&reconcile.basis, &reconcile.coverage] {
                    if state.assignment.world != *w || state.assignment.source_id != a.source_id
                        || state.assignment.partition != a.partition
                    {
                        return Err(SyncError::protocol());
                    }
                }
                reconciled |= reconcile.phase == "complete" && a.continues(&reconcile.basis.assignment)
                    && reconcile.basis.complete && reconcile.basis.consistent
                    && reconcile.basis.gap.is_none() && reconcile.basis.snapshot.is_some();
                reconciles.push(reconcile);
            }
            let partition_ready = binding_ready && projection_available(&partition) && reconciled
                && checkpoint.as_ref().is_some_and(|checkpoint| {
                    checkpoint.source.epoch == a.epoch && checkpoint.applied_sequence.is_some()
                        && checkpoint.captured_sequence == checkpoint.applied_sequence
                        && checkpoint.projected_sequence == checkpoint.applied_sequence
                        && checkpoint.source.gap.is_none()
                        && input.as_ref().is_some_and(|input| {
                            input.status == "applied" && input.transaction_complete
                                && input.entry.input.basis.gap.is_none()
                                && checkpoint.source.applied.as_ref() == Some(&input.position)
                        })
                });
            ready &= partition_ready;
            if partition_ready {
                recheck_basis_inner(tx, &input.as_ref().ok_or_else(SyncError::protocol)?.entry.input.basis, Some((budget, cancel))).await?;
            }
            projection_step(budget, cancel)?;
            partitions.push(projection_digest(&(&partition, &checkpoint, &input, &reconciles))?);
        }
        projection_step(budget, cancel)?;
        bases.push(projection_digest(&(reference, &binding, head, &authority, partitions))?);
    }
    projection_step(budget, cancel)?;
    let digest = projection_digest(&("world.source.projection.basis.v1", w, bases))?;
    projection_step(budget, cancel)?;
    Ok((ready, digest))
}

pub(crate) async fn bindings_projection_ready(
    tx: &WorldTransaction<'_>,
    bindings: &[DefinitionRef],
    budget: &CallBudget,
    cancel: &CancellationToken,
) -> Result<bool, SyncError> {
    Ok(bindings_projection_basis(tx, bindings, budget, cancel).await?.0)
}

fn projection_step(budget: &CallBudget, cancel: &CancellationToken) -> Result<(), SyncError> {
    if cancel.is_cancelled() {
        return Err(world_protocol::sources::MappingFailure::Cancelled.into());
    }
    budget.charge(BudgetDimension::Steps, 1)
        .map_err(|error| world_protocol::sources::MappingFailure::BudgetExceeded { dimension: error.dimension })?;
    Ok(())
}

fn projection_limit(budget: &CallBudget) -> Result<i64, SyncError> {
    let remaining = budget.remaining(BudgetDimension::Rows)
        .map_err(|error| world_protocol::sources::MappingFailure::BudgetExceeded { dimension: error.dimension })?;
    Ok(i64::try_from(remaining.saturating_add(1)).unwrap_or(i64::MAX))
}

fn projection_rows(budget: &CallBudget, rows: usize) -> Result<(), SyncError> {
    budget.charge(BudgetDimension::Rows, rows as u64)
        .map_err(|error| world_protocol::sources::MappingFailure::BudgetExceeded { dimension: error.dimension })?;
    Ok(())
}

fn projection_digest(value: &impl Serialize) -> Result<Digest, SyncError> {
    crate::definitions::canonical_digest(value).map_err(|error| SyncError::Mapping(error.into()))
}

fn projection_checkpoint(row: &tokio_postgres::Row, a: &Assignment) -> Result<Checkpoint, SyncError> {
    if row.get::<_, String>("checkpoint_format") != a.format.as_str() {
        return Err(SyncError::protocol());
    }
    let position = |name| row.get::<_, Option<serde_json::Value>>(name).map(decode).transpose();
    let sequence = |name| row.get::<_, Option<i64>>(name)
        .map(|value| u64::try_from(value).map_err(|_| SyncError::protocol())).transpose();
    let checkpoint = Checkpoint {
        source: world_protocol::sources::SourceCheckpoint {
            binding: a.binding.clone(),
            epoch: PartitionEpoch(row.get::<_, i64>("partition_epoch") as u64),
            captured: position("captured")?,
            applied: position("applied")?,
            acknowledged: position("acknowledged")?,
            projected: position("projected")?,
            gap: row.get::<_, Option<serde_json::Value>>("gap").map(decode).transpose()?,
        },
        revision: Revision(row.get::<_, i64>("revision") as u64),
        captured_sequence: sequence("captured_sequence")?,
        applied_sequence: sequence("applied_sequence")?,
        acknowledged_sequence: sequence("acknowledged_sequence")?,
        projected_sequence: sequence("projected_sequence")?,
    };
    if checkpoint.applied_sequence > checkpoint.captured_sequence
        || checkpoint.acknowledged_sequence > checkpoint.applied_sequence
        || checkpoint.projected_sequence > checkpoint.applied_sequence
    {
        return Err(SyncError::protocol());
    }
    Ok(checkpoint)
}

fn projection_input(row: &tokio_postgres::Row, a: &Assignment) -> Result<AppliedInboxBasis, SyncError> {
    let input = AppliedInboxBasis {
        epoch: PartitionEpoch(row.get::<_, i64>("partition_epoch") as u64),
        sequence: u64::try_from(row.get::<_, i64>("sequence")).map_err(|_| SyncError::protocol())?,
        input_digest: Digest::try_new(row.get::<_, String>("input_digest")).map_err(|_| SyncError::protocol())?,
        position: decode(row.get("position"))?,
        status: row.get("status"),
        transaction_complete: row.get("transaction_complete"),
        entry: decode(row.get("body"))?,
    };
    let basis = &input.entry.input.basis;
    if !a.continues(&input.entry.raw.assignment) || basis.binding != a.binding
        || basis.source_id != a.source_id || basis.incarnation != a.incarnation
        || basis.mapping_revision != a.mapping.revision || basis.schema != a.schema
        || basis.identity_rule != a.identity_rule
        || input.position.source_id != a.source_id || input.position.incarnation != a.incarnation
        || input.position.partition != a.partition
        || input.epoch != input.entry.raw.assignment.epoch || input.sequence != input.entry.input.sequence
        || input.entry.input.event_id.as_str() != row.get::<_, String>("event_id")
        || input.position != input.entry.input.position || input.position != input.entry.raw.position
        || input.position.format.as_str() != row.get::<_, String>("checkpoint_format")
        || *basis != input.entry.raw.page.basis
        || basis.position.as_ref().is_some_and(|position| position != &input.position)
    {
        return Err(SyncError::protocol());
    }
    Ok(input)
}

/// The lag clock is a complete reconcile of this assignment, not a partition metadata timestamp.
pub(crate) async fn require_projected_transaction(
    tx: &WorldTransaction<'_>,
    binding: &DefinitionRef,
    max_lag: &world_protocol::time::DurationMs,
    now: &Timestamp,
) -> Result<(), SyncError> {
    let bases = require_bindings_ready(tx, std::slice::from_ref(binding)).await?;
    let w = tx.world();
    let partitions = tx.query("SELECT body FROM world_source_partition WHERE tenant_id=$1 AND world_id=$2 AND binding_id=$3 AND binding_revision=$4 ORDER BY source_id,partition_key FOR SHARE", &[&w.tenant_id.as_str(), &w.world_id.as_str(), &binding.id.as_str(), &number(binding.revision.0)?]).await?;
    for row in partitions {
        let partition: super::model::Partition = decode(row.get("body"))?;
        let a = &partition.assignment;
        let basis = bases
            .iter()
            .find(|basis| basis.source_id == a.source_id && basis.binding == a.binding)
            .ok_or_else(SyncError::protocol)?;
        let rows = tx.query("SELECT basis,to_char(last_reconciled_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS at FROM world_source_reconcile WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 AND partition_key=$4 AND phase='complete' ORDER BY last_reconciled_at DESC FOR SHARE", &[&w.tenant_id.as_str(), &w.world_id.as_str(), &a.source_id.as_str(), &a.partition]).await?;
        let mut last = None;
        for row in rows {
            let state: super::snapshot::ReconcileState = decode(row.get("basis"))?;
            if !a.continues(&state.assignment)
                || !state.complete
                || !state.consistent
                || state.gap.is_some()
                || state.snapshot.is_none()
            {
                continue;
            }
            last = Some(
                row.get::<_, Option<String>>("at")
                    .map(Timestamp::try_new)
                    .transpose()
                    .map_err(|_| SyncError::protocol())?
                    .ok_or_else(SyncError::protocol)?,
            );
            break;
        }
        let at = last.ok_or_else(SyncError::protocol)?;
        let lag =
            ((now.unix_nanos() - at.unix_nanos()).max(0) / 1_000_000).min(u64::MAX as i128) as u64;
        if lag > max_lag.0 {
            return Err(SyncError::Owner(crate::owner::Error::new(
                "world.source_projection_lag",
                FailureStage::Read,
                "来源投影超出允许延迟。",
                world_protocol::api::ApiFailure::Operation(
                    world_protocol::operation::OperationFailure::Query(
                        world_protocol::query::QueryFailure::ProjectionLag {
                            source_id: basis.source_id.clone(),
                            actual: world_protocol::time::DurationMs(lag),
                            maximum: *max_lag,
                        },
                    ),
                ),
                world_protocol::failure::Recovery::RetryRead { after: None },
            )));
        }
    }
    Ok(())
}

/// Rebuild readiness inputs from the current exact assignments, never a caller's available flag.
pub(crate) async fn require_bindings_ready(
    tx: &WorldTransaction<'_>,
    bindings: &[DefinitionRef],
) -> Result<Vec<SourceBasis>, SyncError> {
    let mut bases = Vec::new();
    for binding in bindings {
        if &binding.world != tx.world() {
            return Err(SyncError::protocol());
        }
        let w = tx.world();
        let rows = tx.query("SELECT p.body,i.body AS input FROM world_source_partition p JOIN world_source_checkpoint c USING(tenant_id,world_id,source_id,partition_key) JOIN LATERAL (SELECT i.* FROM world_source_inbox i WHERE i.tenant_id=c.tenant_id AND i.world_id=c.world_id AND i.source_id=c.source_id AND i.partition_key=c.partition_key AND i.partition_epoch<=c.partition_epoch AND i.sequence=c.applied_sequence ORDER BY i.partition_epoch DESC LIMIT 1) i ON true WHERE p.tenant_id=$1 AND p.world_id=$2 AND p.binding_id=$3 AND p.binding_revision=$4 ORDER BY p.source_id,p.partition_key FOR SHARE OF p,c", &[&w.tenant_id.as_str(), &w.world_id.as_str(), &binding.id.as_str(), &number(binding.revision.0)?]).await?;
        if rows.is_empty() {
            return Err(SyncError::protocol());
        }
        for row in rows {
            let partition: super::model::Partition = decode(row.get("body"))?;
            let input: super::inbox::Entry = decode(row.get("input"))?;
            if partition.assignment.binding != *binding
                || !partition.assignment.continues(&input.raw.assignment)
                || input.input.basis.binding != *binding
            {
                return Err(SyncError::protocol());
            }
            bases.push(input.input.basis);
        }
    }
    require_release_ready(tx, &bases).await?;
    Ok(bases)
}

pub(crate) async fn recheck_basis(
    tx: &WorldTransaction<'_>,
    basis: &SourceBasis,
) -> Result<(), SyncError> {
    recheck_basis_inner(tx, basis, None).await
}

async fn recheck_basis_inner(
    tx: &WorldTransaction<'_>,
    basis: &SourceBasis,
    bounded: Option<(&CallBudget, &CancellationToken)>,
) -> Result<(), SyncError> {
    if let Some((budget, cancel)) = bounded {
        projection_step(budget, cancel)?;
    }
    let binding = crate::sources::mapping::read_binding(tx, &basis.binding)
        .await?
        .ok_or_else(SyncError::protocol)?;
    if binding.body.source_id != basis.source_id
        || binding.body.incarnation != basis.incarnation
        || binding.body.mapping.revision != basis.mapping_revision
        || binding.body.authority.revision != basis.authority_revision
        || binding.body.identity_rule != basis.identity_rule
        || binding.body.schema != basis.schema
    {
        return Err(SyncError::protocol());
    }
    let w = tx.world();
    if basis.gap.is_some() {
        return Err(super::source_failure(
            SourceFailure::Gap {
                reason: basis.gap.as_ref().expect("checked gap").reason,
            },
            FailureStage::Validate,
        ));
    }
    if let Some((budget, cancel)) = bounded {
        projection_step(budget, cancel)?;
    }
    let head = tx.query_opt("SELECT revision FROM world_source_binding_head WHERE tenant_id=$1 AND world_id=$2 AND binding_id=$3 FOR SHARE", &[&w.tenant_id.as_str(), &w.world_id.as_str(), &basis.binding.id.as_str()]).await?.ok_or_else(SyncError::protocol)?;
    if head.get::<_, i64>("revision") != number(basis.binding.revision.0)? {
        return Err(SyncError::protocol());
    }
    if let Some(position) = &basis.position {
        if position.source_id != basis.source_id || position.incarnation != basis.incarnation {
            return Err(SyncError::protocol());
        }
        if let Some((budget, cancel)) = bounded {
            projection_step(budget, cancel)?;
        }
        let row = tx.query_opt("SELECT c.applied_sequence,c.gap,p.body,i.sequence,i.transaction_complete,i.status FROM world_source_checkpoint c JOIN world_source_partition p USING(tenant_id,world_id,source_id,partition_key) JOIN world_source_inbox i ON i.tenant_id=c.tenant_id AND i.world_id=c.world_id AND i.source_id=c.source_id AND i.partition_key=c.partition_key AND i.position=$5 WHERE c.tenant_id=$1 AND c.world_id=$2 AND c.source_id=$3 AND c.partition_key=$4 FOR SHARE OF c,p", &[&w.tenant_id.as_str(), &w.world_id.as_str(), &basis.source_id.as_str(), &position.partition, &super::encode(position)?]).await?.ok_or_else(SyncError::protocol)?;
        let p: super::model::Partition = decode(row.get("body"))?;
        if p.assignment.incarnation != basis.incarnation
            || p.assignment.binding != basis.binding
            || !row.get::<_, bool>("transaction_complete")
            || row.get::<_, String>("status") != "applied"
            || row
                .get::<_, Option<i64>>("applied_sequence")
                .is_none_or(|n| n < row.get::<_, i64>("sequence"))
            || row.get::<_, Option<serde_json::Value>>("gap").is_some()
        {
            return Err(SyncError::protocol());
        }
    } else {
        let snapshot = basis.snapshot.as_ref().ok_or_else(SyncError::protocol)?;
        let limit = if let Some((budget, cancel)) = bounded {
            projection_step(budget, cancel)?;
            Some(projection_limit(budget)?)
        } else {
            None
        };
        let rows = tx.query("SELECT r.basis,p.body,c.gap FROM world_source_reconcile r JOIN world_source_partition p USING(tenant_id,world_id,source_id,partition_key) JOIN world_source_checkpoint c USING(tenant_id,world_id,source_id,partition_key) WHERE r.tenant_id=$1 AND r.world_id=$2 AND r.source_id=$3 AND r.phase='complete' AND r.basis->>'snapshot'=$4 AND p.binding_id=$5 AND p.binding_revision=$6 ORDER BY p.partition_key,r.run_id LIMIT $7 FOR SHARE OF r,p,c", &[&w.tenant_id.as_str(), &w.world_id.as_str(), &basis.source_id.as_str(), &snapshot, &basis.binding.id.as_str(), &number(basis.binding.revision.0)?, &limit]).await?;
        if let Some((budget, _)) = bounded {
            projection_rows(budget, rows.len())?;
        }
        let mut found = false;
        for row in rows {
            if let Some((budget, cancel)) = bounded {
                projection_step(budget, cancel)?;
            }
            let state: super::snapshot::ReconcileState = decode(row.get("basis"))?;
            let partition: super::model::Partition = decode(row.get("body"))?;
            if partition.assignment.continues(&state.assignment)
                && state.assignment.incarnation == basis.incarnation
                && state.assignment.binding == basis.binding
                && state.snapshot.as_ref() == Some(snapshot)
                && state.complete
                && state.consistent
                && state.gap.is_none()
                && row.get::<_, Option<serde_json::Value>>("gap").is_none()
            {
                found = true;
            }
        }
        if !found {
            return Err(super::source_failure(
                SourceFailure::Gap {
                    reason: world_protocol::sources::GapReason::IncompleteEnumeration,
                },
                FailureStage::Validate,
            ));
        }
    }
    Ok(())
}
