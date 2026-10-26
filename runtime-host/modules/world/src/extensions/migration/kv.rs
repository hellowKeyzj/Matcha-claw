use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use world_protocol::{
    authorization::AccessMode,
    commit::{CommittedRevision, WriteFence},
    ids::*,
    process::{StateRead, StateValue, StateWrite},
    state::{StateEpoch, StateFailure},
};

use super::{
    StateError,
    data::{StateLimits, StatePatch, validate_key},
    scope::{READ_ROOT, WRITE_ROOT, decode_current, pinned_node},
};
use crate::{
    authorization::{self, Admission},
    extensions::invocation::InvocationLease,
    store::{CommitRequest, Committed, OutboxEvent, WorldStore, WorldTransaction},
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StateReadReceipt {
    pub epoch: StateEpoch,
    pub value: Option<StateValue>,
}

pub(crate) async fn read_state(
    store: &WorldStore,
    admission: &Admission,
    lease: &InvocationLease,
    node: &NodeId,
    request: &StateRead,
    limits: &StateLimits,
) -> Result<StateReadReceipt, StateError> {
    validate_key(&request.key)?;
    let node = pinned_node(admission, lease, node)?;
    let node_id = node.id.clone();
    let namespace = node
        .state
        .as_ref()
        .expect("checked state binding")
        .namespace
        .clone();
    let limits = *limits;
    let key = request.key.clone();
    let admission = admission.clone();
    let receipt = store
        .snapshot(admission.invocation().world.clone(), move |snapshot| {
            Box::pin(async move {
                let maximum = limits.encoded_limit()?;
                let row = snapshot
                    .query_opt(
                        READ_ROOT,
                        &[
                            &snapshot.world().tenant_id.as_str(),
                            &snapshot.world().world_id.as_str(),
                            &namespace.as_str(),
                            &maximum,
                        ],
                    )
                    .await?
                    .ok_or_else(|| StateFailure::NamespaceMissing { namespace })?;
                crate::extensions::package::require_grants_read(
                    snapshot,
                    &node.implementation,
                    &[world_protocol::package::RequestedAccess::StateRead {
                        namespace: node
                            .state
                            .as_ref()
                            .expect("checked state binding")
                            .namespace
                            .clone(),
                    }],
                )
                .await?;
                let current =
                    decode_current(snapshot.world(), &node, &row, limits, AccessMode::Read)?;
                let value = current.data.entries.get(&key).cloned();
                let impact = current.impact(AccessMode::Read)?;
                let at = snapshot.now().await?;
                authorization::check_state_output_read(
                    snapshot,
                    &admission,
                    &impact,
                    u64::from(value.is_some()),
                    &at,
                )
                .await?;
                Ok::<_, StateError>(StateReadReceipt {
                    epoch: current.epoch,
                    value,
                })
            })
        })
        .await?;
    if lease
        .cancellation(&node_id)
        .is_none_or(|token| token.is_cancelled())
    {
        return Err(StateFailure::Fenced.into());
    }
    Ok(receipt)
}

pub(crate) async fn write_state(
    store: &WorldStore,
    admission: &Admission,
    lease: &InvocationLease,
    node: &NodeId,
    request: &StateWrite,
    commit_id: CommitId,
    limits: &StateLimits,
) -> Result<Committed<StateValue>, StateError> {
    validate_key(&request.key)?;
    let node = pinned_node(admission, lease, node)?;
    let node_id = node.id.clone();
    let namespace = node
        .state
        .as_ref()
        .expect("checked state binding")
        .namespace
        .clone();
    let expected = node.state.as_ref().expect("checked state binding").clone();
    let world = admission.invocation().world.clone();
    let snapshot_node = node.clone();
    let limits = *limits;
    let (storage_epoch, root) = store
        .snapshot(world.clone(), move |snapshot| {
            Box::pin(async move {
                let maximum = limits.encoded_limit()?;
                let row = snapshot
                    .query_opt(
                        READ_ROOT,
                        &[
                            &snapshot.world().tenant_id.as_str(),
                            &snapshot.world().world_id.as_str(),
                            &namespace.as_str(),
                            &maximum,
                        ],
                    )
                    .await?
                    .ok_or_else(|| StateFailure::NamespaceMissing { namespace })?;
                crate::extensions::package::require_grants_read(
                    snapshot,
                    &snapshot_node.implementation,
                    &[world_protocol::package::RequestedAccess::StateWrite {
                        namespace: snapshot_node
                            .state
                            .as_ref()
                            .expect("checked state binding")
                            .namespace
                            .clone(),
                    }],
                )
                .await?;
                let current = decode_current(
                    snapshot.world(),
                    &snapshot_node,
                    &row,
                    limits,
                    AccessMode::Write,
                )?;
                Ok::<_, StateError>((current.storage_epoch, current.epoch.root))
            })
        })
        .await?;
    let mut hash = Sha256::new();
    hash.update(b"matcha.world-state-write/1\n");
    hash.update(serde_json::to_vec(&(
        &world,
        &admission.invocation().id,
        &node.id,
        &expected,
        request,
    ))?);
    let input_digest =
        Digest::try_new(format!("sha256:{:x}", hash.finalize())).expect("SHA256 digest syntax");
    let batch = CommitRequest {
        world,
        commit_id,
        input_digest,
        storage_epoch,
        fences: vec![WriteFence {
            world: expected.root.world.clone(),
            domain: expected.writer_domain.clone(),
            epoch: expected.writer_epoch,
        }],
        watch_basis: Vec::new(),
    }
    .prepare()?;
    let current_admission = admission.clone();
    let admission = admission.clone();
    let request = request.clone();
    let cancellation = lease
        .cancellation(&node.id)
        .ok_or(StateFailure::Fenced)?
        .clone();
    let committed = store
        .transact(batch, move |tx| {
            Box::pin(async move {
                if cancellation.is_cancelled() {
                    return Err(StateFailure::Fenced.into());
                }
                let namespace = &node
                    .state
                    .as_ref()
                    .expect("checked state binding")
                    .namespace;
                let maximum = limits.encoded_limit()?;
                let row = tx
                    .query_opt(
                        WRITE_ROOT,
                        &[
                            &tx.world().tenant_id.as_str(),
                            &tx.world().world_id.as_str(),
                            &namespace.as_str(),
                            &maximum,
                        ],
                    )
                    .await?
                    .ok_or_else(|| StateFailure::NamespaceMissing {
                        namespace: namespace.clone(),
                    })?;
                crate::extensions::package::require_grants(
                    tx,
                    &node.implementation,
                    &[world_protocol::package::RequestedAccess::StateWrite {
                        namespace: namespace.clone(),
                    }],
                )
                .await?;
                let current = decode_current(tx.world(), &node, &row, limits, AccessMode::Write)?;
                if current.epoch.root != root {
                    return Err(StateFailure::RootConflict {
                        expected: root,
                        actual: current.epoch.root,
                    }
                    .into());
                }
                let impact = current.impact(AccessMode::Write)?;
                let at = tx.now().await?;
                let fresh = authorization::refresh_state(tx, &admission, &impact, &at).await?;
                let patch = current
                    .data
                    .propose(current.epoch.root, &request, current.limits)?;
                authorization::check_admitted_output(tx, &fresh, &impact, 1, &at).await?;
                commit_patch(
                    tx,
                    &current.epoch.namespace,
                    current.state_epoch,
                    &current.epoch.schema,
                    patch,
                )
                .await
            })
        })
        .await
        .map_err(StateError::from)?;
    // Replays still require current namespace/authority; a cached receipt is not a grant.
    let node = pinned_node(&current_admission, lease, &node_id)?;
    store
        .snapshot(
            current_admission.invocation().world.clone(),
            move |snapshot| {
                Box::pin(async move {
                    let namespace = &node
                        .state
                        .as_ref()
                        .expect("checked state binding")
                        .namespace;
                    let maximum = limits.encoded_limit()?;
                    let row = snapshot
                        .query_opt(
                            READ_ROOT,
                            &[
                                &snapshot.world().tenant_id.as_str(),
                                &snapshot.world().world_id.as_str(),
                                &namespace.as_str(),
                                &maximum,
                            ],
                        )
                        .await?
                        .ok_or_else(|| StateFailure::NamespaceMissing {
                            namespace: namespace.clone(),
                        })?;
                    crate::extensions::package::require_grants_read(
                        snapshot,
                        &node.implementation,
                        &[world_protocol::package::RequestedAccess::StateWrite {
                            namespace: namespace.clone(),
                        }],
                    )
                    .await?;
                    let current =
                        decode_current(snapshot.world(), &node, &row, limits, AccessMode::Write)?;
                    let at = snapshot.now().await?;
                    authorization::check_state_output_read(
                        snapshot,
                        &current_admission,
                        &current.impact(AccessMode::Write)?,
                        1,
                        &at,
                    )
                    .await?;
                    Ok::<_, StateError>(())
                })
            },
        )
        .await?;
    Ok(committed)
}

async fn commit_patch(
    tx: &mut WorldTransaction<'_>,
    namespace: &StateNamespaceId,
    state_epoch: i64,
    schema: &Digest,
    patch: StatePatch,
) -> Result<StateValue, StateError> {
    let next = patch
        .expected_root
        .revision
        .0
        .checked_add(1)
        .filter(|revision| *revision <= i64::MAX as u64)
        .map(Revision)
        .ok_or(StateFailure::SizeLimit)?;
    let digest = patch.data.digest()?;
    let body = serde_json::to_value(&patch.data)?;
    let world = tx.world().clone();
    tx.execute(
        "INSERT INTO world_state_root(tenant_id,world_id,state_root_id,revision,namespace_id,state_epoch,schema_digest,content_digest,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &patch.expected_root.id.as_str(), &(next.0 as i64), &namespace.as_str(), &state_epoch, &schema.as_str(), &digest.as_str(), &body],
    ).await?;
    let changed = tx.execute(
        "UPDATE world_state_namespace SET state_root_revision=$5,revision=revision+1 WHERE tenant_id=$1 AND world_id=$2 AND namespace_id=$3 AND state_root_id=$4 AND state_root_revision=$6 AND revision<9223372036854775807",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &namespace.as_str(), &patch.expected_root.id.as_str(), &(next.0 as i64), &(patch.expected_root.revision.0 as i64)],
    ).await?;
    if changed != 1 {
        return Err(StateFailure::Fenced.into());
    }
    tx.record_revision(CommittedRevision {
        resource: ResourceRef::State {
            id: patch.expected_root.id.clone(),
        },
        revision: next,
    })?;
    tx.emit(OutboxEvent {
        event_id: EventId::try_new(uuid::Uuid::new_v4().to_string()).expect("UUID identifier"),
        aggregate_kind: "state_root".into(),
        aggregate_id: patch.expected_root.id.to_string(),
        aggregate_revision: next.0,
        event_kind: "world.state.changed".into(),
        payload: serde_json::to_value(StateRef {
            revision: next,
            ..patch.expected_root
        })?,
        causation_id: None,
        origin: "world.state".into(),
    })
    .await?;
    Ok(patch.value)
}
