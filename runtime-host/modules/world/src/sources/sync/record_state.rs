use super::{
    Assignment, SyncError, authorize, changed, decode, encode, number, trusted::StoredInput,
};
use crate::{
    authorization::Admission,
    store::{WorldSnapshot, WorldTransaction},
};
use world_protocol::{
    authorization::AccessMode,
    identity::SourceKey,
    ids::*,
    sources::{
        CompiledSourcePlan, DeleteSemantics, SourceBasis, SourceRecordState, SourceRecordStatus,
    },
};

pub(super) async fn available(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    a: &Assignment,
    input: &StoredInput,
    rows: &[&world_protocol::sources::SourceRow],
    plan: &CompiledSourcePlan,
) -> Result<(), SyncError> {
    for row in rows {
        let key = SourceKey {
            world: a.world.clone(),
            source_id: a.source_id.clone(),
            namespace: plan.binding_body.namespace.clone(),
            native_key: row.native_key.clone(),
            incarnation: row.incarnation.clone(),
            valid_time: input.input.valid_time.clone(),
        };
        save(
            tx,
            admission,
            a,
            key,
            &input.input.basis,
            SourceRecordStatus::Available,
        )
        .await?;
    }
    Ok(())
}

pub(super) async fn deleted(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    a: &Assignment,
    proof: &super::SourceRetraction,
) -> Result<(), SyncError> {
    let status = match proof.semantics() {
        DeleteSemantics::RequireReconcile => SourceRecordStatus::NeedsReconcile,
        DeleteSemantics::MarkUnavailable | DeleteSemantics::WithdrawSourceClaims => {
            SourceRecordStatus::Unavailable
        }
    };
    let key = SourceKey {
        world: a.world.clone(),
        source_id: proof.source().clone(),
        namespace: proof.namespace().into(),
        native_key: proof.native_key().into(),
        incarnation: proof.incarnation().into(),
        valid_time: proof.valid_time().clone(),
    };
    save(tx, admission, a, key, proof.basis(), status).await?;
    Ok(())
}

pub(super) async fn needs_reconcile(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    a: &Assignment,
    input: &StoredInput,
    plan: &CompiledSourcePlan,
) -> Result<(), SyncError> {
    for row in &input.input.rows {
        let key = SourceKey {
            world: a.world.clone(),
            source_id: a.source_id.clone(),
            namespace: plan.binding_body.namespace.clone(),
            native_key: row.native_key.clone(),
            incarnation: row.incarnation.clone(),
            valid_time: input.input.valid_time.clone(),
        };
        save(
            tx,
            admission,
            a,
            key,
            &input.input.basis,
            SourceRecordStatus::NeedsReconcile,
        )
        .await?;
    }
    Ok(())
}

async fn save(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    a: &Assignment,
    key: SourceKey,
    basis: &SourceBasis,
    status: SourceRecordStatus,
) -> Result<(), SyncError> {
    authorize(tx, admission, a, AccessMode::Write).await?;
    super::partition::locked(tx, a).await?;
    if key.world != a.world
        || key.source_id != a.source_id
        || basis.binding != a.binding
        || basis.incarnation != a.incarnation
        || basis.source_id != a.source_id
    {
        return Err(SyncError::protocol());
    }
    let previous = tx.query_opt("SELECT s.body FROM world_source_record_state_head h JOIN world_source_record_state s USING(tenant_id,world_id,source_id,partition_key,namespace,native_key,record_incarnation,scope_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 AND h.source_id=$3 AND h.partition_key=$4 AND h.namespace=$5 AND h.native_key=$6 AND h.record_incarnation=$7 AND h.scope_id=$8 FOR UPDATE OF h", &[&a.world.tenant_id.as_str(), &a.world.world_id.as_str(), &a.source_id.as_str(), &a.partition, &key.namespace, &key.native_key, &key.incarnation, &a.scope.as_str()]).await?.map(|row| decode::<SourceRecordState>(row.get("body"))).transpose()?;
    if let Some(old) = &previous {
        if old.key == key && old.basis == *basis && old.status == status {
            return Ok(());
        }
        if old.key.valid_time.from > key.valid_time.from
            && status != SourceRecordStatus::NeedsReconcile
        {
            return Err(super::source_failure(
                world_protocol::sources::SourceFailure::PositionIncomparable,
                world_protocol::failure::FailureStage::Validate,
            ));
        }
    }
    let revision = Revision(
        previous
            .as_ref()
            .map_or(Some(1), |old| old.revision.0.checked_add(1))
            .ok_or_else(SyncError::protocol)?,
    );
    let state = SourceRecordState {
        key,
        scope: a.scope.clone(),
        revision,
        status,
        basis: basis.clone(),
    };
    let status = match status {
        SourceRecordStatus::Available => "available",
        SourceRecordStatus::Unavailable => "unavailable",
        SourceRecordStatus::NeedsReconcile => "needs_reconcile",
    };
    tx.execute("INSERT INTO world_source_record_state(tenant_id,world_id,source_id,partition_key,namespace,native_key,record_incarnation,scope_id,revision,status,binding_id,binding_revision,valid_from,valid_to,valid_from_ns,valid_to_ns,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::text::timestamptz,$14::text::timestamptz,$15::text::numeric,$16::text::numeric,$17)", &[&a.world.tenant_id.as_str(), &a.world.world_id.as_str(), &a.source_id.as_str(), &a.partition, &state.key.namespace, &state.key.native_key, &state.key.incarnation, &a.scope.as_str(), &number(revision.0)?, &status, &a.binding.id.as_str(), &number(a.binding.revision.0)?, &state.key.valid_time.from.as_str(), &state.key.valid_time.to.as_ref().map(|at| at.as_str()), &state.key.valid_time.from.unix_nanos().to_string(), &state.key.valid_time.to.as_ref().map(|at| at.unix_nanos().to_string()), &encode(&state)?]).await?;
    changed(tx.execute("INSERT INTO world_source_record_state_head(tenant_id,world_id,source_id,partition_key,namespace,native_key,record_incarnation,scope_id,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(tenant_id,world_id,source_id,partition_key,namespace,native_key,record_incarnation,scope_id) DO UPDATE SET revision=excluded.revision WHERE world_source_record_state_head.revision=$10", &[&a.world.tenant_id.as_str(), &a.world.world_id.as_str(), &a.source_id.as_str(), &a.partition, &state.key.namespace, &state.key.native_key, &state.key.incarnation, &a.scope.as_str(), &number(revision.0)?, &number(previous.as_ref().map_or(0, |old| old.revision.0))?]).await?, a)
}

/// Immutable availability history, not an alternative assertion truth store.
pub(crate) async fn read_record_states(
    snapshot: &WorldSnapshot<'_>,
    binding: &DefinitionRef,
) -> Result<Vec<SourceRecordState>, SyncError> {
    if snapshot.world() != &binding.world {
        return Err(SyncError::protocol());
    }
    let rows = snapshot.query("SELECT body FROM world_source_record_state WHERE tenant_id=$1 AND world_id=$2 AND binding_id=$3 ORDER BY source_id,partition_key,namespace,native_key,record_incarnation,scope_id,revision", &[&binding.world.tenant_id.as_str(), &binding.world.world_id.as_str(), &binding.id.as_str()]).await?;
    rows.into_iter()
        .map(|row| decode(row.get("body")))
        .collect()
}
