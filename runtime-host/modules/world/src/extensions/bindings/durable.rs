use std::collections::{BTreeMap, BTreeSet};

use serde::{Serialize, de::DeserializeOwned};
use world_protocol::{
    bindings::{ActivationLock, BindingChannel, BindingFailure, BindingHead, BindingHeadCas},
    commit::CommittedRevision,
    ids::{ActivationLockId, Generation, ResourceRef, Revision, WorldRef},
};

use super::{BindingError, BindingGraph};
use crate::{
    extensions::package::{RetentionOwner, require_retained_packages, retain_packages},
    store::{OutboxEvent, WorldSnapshot, WorldTransaction},
};

pub(crate) async fn read_heads(
    snapshot: &WorldSnapshot<'_>,
) -> Result<Vec<(String, Result<BindingHead, BindingFailure>)>, BindingError> {
    let world = snapshot.world();
    let rows = snapshot.query(
        "SELECT channel,generation,revision,activation_lock_id,body FROM world_binding_head WHERE tenant_id=$1 AND world_id=$2 ORDER BY channel",
        &[&world.tenant_id.as_str(), &world.world_id.as_str()],
    ).await?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let channel: String = row.get("channel");
            let head = serde_json::from_value::<BindingHead>(row.get("body"))
                .map_err(|_| BindingFailure::HeadInvalid)
                .and_then(|head| {
                    if head.world != *world
                        || head.channel.as_str() != channel
                        || head.activation_lock_id.as_str()
                            != row.get::<_, String>("activation_lock_id")
                        || head.generation.0 == 0
                        || i64::try_from(head.generation.0).ok() != Some(row.get("generation"))
                        || head.revision.0 == 0
                        || i64::try_from(head.revision.0).ok() != Some(row.get("revision"))
                    {
                        return Err(BindingFailure::HeadInvalid);
                    }
                    Ok(head)
                });
            (channel, head)
        })
        .collect())
}

pub(crate) async fn read_channels(
    snapshot: &WorldSnapshot<'_>,
) -> Result<Vec<(String, Result<BindingChannel, BindingFailure>)>, BindingError> {
    let world = snapshot.world();
    let rows = snapshot.query(
        "SELECT binding_id,channel FROM world_binding_channel WHERE tenant_id=$1 AND world_id=$2 ORDER BY binding_id",
        &[&world.tenant_id.as_str(), &world.world_id.as_str()],
    ).await?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let binding: String = row.get("binding_id");
            let mapping = binding
                .parse::<world_protocol::ids::BindingId>()
                .map_err(|_| BindingFailure::HeadInvalid)
                .and_then(|binding_id| {
                    let channel = row.get::<_, String>("channel").parse().map_err(|_| {
                        BindingFailure::InvalidChannels {
                            binding_id: binding_id.clone(),
                        }
                    })?;
                    Ok(BindingChannel {
                        binding_id,
                        channel,
                    })
                });
            (binding, mapping)
        })
        .collect())
}

pub(crate) async fn read_graph(
    snapshot: &WorldSnapshot<'_>,
    id: &ActivationLockId,
) -> Result<BindingGraph, BindingError> {
    let world = snapshot.world();
    let row = snapshot.query_opt(
        "SELECT content_digest,graph FROM world_activation_lock WHERE tenant_id=$1 AND world_id=$2 AND activation_lock_id=$3",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str()],
    ).await?.ok_or_else(|| BindingFailure::MissingActivationLock { activation_lock_id: id.clone() })?;
    checked_graph(world, id, row.get("content_digest"), row.get("graph"))
}

/// A consistent read-only view, not permission to create an execution reference.
pub(crate) async fn read_active_graph(
    snapshot: &WorldSnapshot<'_>,
    id: &ActivationLockId,
) -> Result<BindingGraph, BindingError> {
    let world = snapshot.world();
    let row = snapshot.query_opt(
        "SELECT state FROM world_activation_lifecycle WHERE tenant_id=$1 AND world_id=$2 AND activation_lock_id=$3",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str()],
    ).await?.ok_or_else(|| BindingFailure::MissingActivationLock { activation_lock_id: id.clone() })?;
    if row.get::<_, String>("state") != "active" {
        return Err(BindingFailure::LockRetiring {
            activation_lock_id: id.clone(),
        }
        .into());
    }
    let graph = read_graph(snapshot, id).await?;
    let packages: BTreeSet<_> = graph
        .lock()
        .nodes
        .iter()
        .map(|node| node.implementation.package_digest.clone())
        .collect();
    crate::extensions::package::require_retained_packages_snapshot(
        snapshot,
        RetentionOwner::ActivationLock(id),
        Revision(0),
        &packages.into_iter().collect::<Vec<_>>(),
    )
    .await?;
    Ok(graph)
}

/// Serializes durable pin creation with retirement of this immutable lock.
pub(crate) async fn read_graph_in_transaction(
    tx: &WorldTransaction<'_>,
    id: &ActivationLockId,
) -> Result<BindingGraph, BindingError> {
    require_active(tx, id).await?;
    let graph = read_graph_history_in_transaction(tx, id).await?;
    let packages: BTreeSet<_> = graph
        .lock()
        .nodes
        .iter()
        .map(|node| node.implementation.package_digest.clone())
        .collect();
    require_retained_packages(
        tx,
        RetentionOwner::ActivationLock(id),
        Revision(0),
        &packages.into_iter().collect::<Vec<_>>(),
    )
    .await?;
    Ok(graph)
}

/// Immutable history only; this grants neither a durable pin nor execution authority.
pub(crate) async fn read_graph_history_in_transaction(
    tx: &WorldTransaction<'_>,
    id: &ActivationLockId,
) -> Result<BindingGraph, BindingError> {
    let world = tx.world();
    let row = tx.query_opt(
        "SELECT content_digest,graph FROM world_activation_lock WHERE tenant_id=$1 AND world_id=$2 AND activation_lock_id=$3 FOR SHARE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str()],
    ).await?.ok_or_else(|| BindingFailure::MissingActivationLock { activation_lock_id: id.clone() })?;
    checked_graph(world, id, row.get("content_digest"), row.get("graph"))
}

pub(crate) async fn read_binding_head(
    tx: &WorldTransaction<'_>,
    channel: &world_protocol::ids::ChannelId,
) -> Result<Option<BindingHead>, BindingError> {
    let world = tx.world();
    tx.query_opt("SELECT generation,revision,activation_lock_id,body FROM world_binding_head WHERE tenant_id=$1 AND world_id=$2 AND channel=$3",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &channel.as_str()]).await?.map(|row| {
        let head: BindingHead = decode(row.get("body"))?;
        if head.world != *world || head.channel != *channel || head.generation.0 == 0 || head.revision.0 == 0
            || i64::try_from(head.generation.0).ok() != Some(row.get("generation"))
            || i64::try_from(head.revision.0).ok() != Some(row.get("revision"))
            || head.activation_lock_id.as_str() != row.get::<_, String>("activation_lock_id") {
            return Err(BindingFailure::HeadInvalid.into());
        }
        Ok(head)
    }).transpose()
}

pub(crate) async fn read_binding_page(
    tx: &WorldTransaction<'_>,
    page: &world_protocol::query::PageRequest,
) -> Result<world_protocol::query::Page<ActivationLock>, BindingError> {
    use world_protocol::{
        api::ApiFailure,
        failure::{FailureStage, Recovery},
        query::QueryFailure,
    };
    let invalid = |failure| {
        BindingError::Operation(crate::owner::Error::new(
            "world.binding_page_invalid",
            FailureStage::Read,
            "绑定图分页参数无效。",
            ApiFailure::Query(failure),
            Recovery::Refresh,
        ))
    };
    if page.limit == 0 || page.limit > 200 {
        return Err(invalid(QueryFailure::InvalidQuery {
            field: world_protocol::failure::FieldPath(vec!["page".into(), "limit".into()]),
        }));
    }
    let after = page.cursor.as_deref().unwrap_or("");
    if page.cursor.is_some() {
        ActivationLockId::try_new(after.to_owned())
            .map_err(|_| invalid(QueryFailure::CursorInvalid))?;
    }
    let world = tx.world();
    let limit = i64::from(page.limit) + 1;
    let mut items = Vec::new();
    for row in tx.query("SELECT activation_lock_id,content_digest,graph FROM world_activation_lock WHERE tenant_id=$1 AND world_id=$2 AND activation_lock_id>$3 ORDER BY activation_lock_id LIMIT $4",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &after, &limit]).await? {
        let id: ActivationLockId = row.get::<_, String>("activation_lock_id").parse().map_err(|_| BindingFailure::LockIdentityConflict)?;
        items.push(checked_graph(world, &id, row.get("content_digest"), row.get("graph"))?.lock().clone());
    }
    let more = items.len() > page.limit as usize;
    items.truncate(page.limit as usize);
    let next_cursor = if more {
        items.last().map(|graph| graph.id.to_string())
    } else {
        None
    };
    Ok(world_protocol::query::Page { items, next_cursor })
}

pub(super) async fn require_active(
    tx: &WorldTransaction<'_>,
    id: &ActivationLockId,
) -> Result<(), BindingError> {
    let world = tx.world();
    let row = tx.query_opt(
        "SELECT state FROM world_activation_lifecycle WHERE tenant_id=$1 AND world_id=$2 AND activation_lock_id=$3 FOR SHARE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str()],
    ).await?.ok_or_else(|| BindingFailure::MissingActivationLock { activation_lock_id: id.clone() })?;
    if row.get::<_, String>("state") != "active" {
        return Err(BindingFailure::LockRetiring {
            activation_lock_id: id.clone(),
        }
        .into());
    }
    Ok(())
}

pub(crate) async fn bootstrap_graph(
    tx: &WorldTransaction<'_>,
    _root: &crate::authorization::AuthorityRoot,
    id: ActivationLockId,
) -> Result<BindingGraph, BindingError> {
    tx.require_provision()?;
    let graph = genesis_graph(tx.world(), id)?;
    append_graph(tx, &graph).await?;
    Ok(graph)
}

pub(crate) fn genesis_graph(
    world: &WorldRef,
    id: ActivationLockId,
) -> Result<BindingGraph, BindingError> {
    let mut lock = ActivationLock {
        world: world.clone(),
        id,
        digest: world_protocol::ids::Digest::try_new(format!("sha256:{}", "0".repeat(64)))
            .expect("fixed digest syntax"),
        nodes: Vec::new(),
        edges: Vec::new(),
        compositions: Vec::new(),
        roots: Vec::new(),
        trusted_roots: Vec::new(),
    };
    lock.digest = world_protocol::bindings::activation_lock_digest(&lock)?;
    Ok(BindingGraph::validate(lock)?)
}

pub(crate) async fn has_install_activation(
    tx: &WorldTransaction<'_>,
    install: &world_protocol::ids::InstallId,
) -> Result<bool, BindingError> {
    let world = tx.world();
    for row in tx.query(
        "SELECT activation_lock_id,content_digest,graph FROM world_activation_lock WHERE tenant_id=$1 AND world_id=$2 ORDER BY activation_lock_id",
        &[&world.tenant_id.as_str(), &world.world_id.as_str()],
    ).await? {
        let id: ActivationLockId = row.get::<_, String>("activation_lock_id").parse()
            .map_err(|_| BindingFailure::LockIdentityConflict)?;
        let graph = checked_graph(world, &id, row.get("content_digest"), row.get("graph"))?;
        if graph.lock().nodes.iter().any(|node| &node.implementation.install_id == install) { return Ok(true); }
    }
    Ok(false)
}

pub(super) fn checked_graph(
    world: &WorldRef,
    id: &ActivationLockId,
    digest: String,
    value: serde_json::Value,
) -> Result<BindingGraph, BindingError> {
    let graph: ActivationLock = decode(value)?;
    if graph.world != *world || graph.id != *id || graph.digest.as_str() != digest {
        return Err(BindingFailure::DigestMismatch.into());
    }
    Ok(BindingGraph::validate(graph)?)
}

/// Appending the immutable graph and pinning every package is part of the same
/// transaction as heads, state migrations, operation completion and the outbox.
pub(super) async fn append_graph(
    tx: &WorldTransaction<'_>,
    graph: &BindingGraph,
) -> Result<(), BindingError> {
    let lock = graph.lock();
    if tx.world() != &lock.world {
        return Err(BindingFailure::HeadInvalid.into());
    }
    let world = tx.world();
    let packages: BTreeSet<_> = lock
        .nodes
        .iter()
        .map(|node| node.implementation.package_digest.clone())
        .collect();
    let ports: Vec<_> = lock
        .nodes
        .iter()
        .map(|node| (&node.id, &node.ports))
        .collect();
    let existing = tx.query_opt(
        "SELECT 1 FROM world_activation_lock WHERE tenant_id=$1 AND world_id=$2 AND activation_lock_id=$3",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &lock.id.as_str()],
    ).await?.is_some();
    if existing {
        require_active(tx, &lock.id).await?;
    }
    tx.execute(
        "INSERT INTO world_activation_lock(tenant_id,world_id,activation_lock_id,content_digest,graph,method_schemas,packages,basis) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &lock.id.as_str(), &lock.digest.as_str(),
          &encode(lock)?, &encode(&ports)?, &encode(&packages)?, &encode(&lock.edges)?],
    ).await?;
    let row = tx.query_opt(
        "SELECT content_digest FROM world_activation_lock WHERE tenant_id=$1 AND world_id=$2 AND activation_lock_id=$3 FOR SHARE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &lock.id.as_str()],
    ).await?.ok_or(BindingFailure::LockIdentityConflict)?;
    if row.get::<_, String>("content_digest") != lock.digest.as_str() {
        return Err(BindingFailure::LockIdentityConflict.into());
    }
    tx.execute(
        "INSERT INTO world_activation_lifecycle(tenant_id,world_id,activation_lock_id,state,revision) VALUES($1,$2,$3,'active',1) ON CONFLICT DO NOTHING",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &lock.id.as_str()],
    ).await?;
    require_active(tx, &lock.id).await?;
    retain_packages(
        tx,
        RetentionOwner::ActivationLock(&lock.id),
        Revision(0),
        &packages.into_iter().collect::<Vec<_>>(),
    )
    .await?;
    Ok(())
}

/// The caller invokes this once, inside one WorldStore transaction. It never
/// commits per head: absent-head insertion and every dependent channel CAS share
/// the graph, migration receipts, operation and outbox atomicity boundary.
pub(super) async fn publish_heads(
    tx: &mut WorldTransaction<'_>,
    graph: &BindingGraph,
    changes: &[BindingHeadCas],
    channels: &[BindingChannel],
) -> Result<Vec<BindingHead>, BindingError> {
    validate_heads(graph, changes, channels)?;
    let world = tx.world().clone();
    let selected: BTreeSet<_> = changes
        .iter()
        .map(|change| change.channel.as_str())
        .collect();
    let previous: BTreeSet<_> = changes
        .iter()
        .filter_map(|change| {
            change
                .expected
                .as_ref()
                .map(|head| head.activation_lock_id.as_str())
        })
        .collect();
    for previous in previous {
        for row in tx.query(
            "SELECT channel FROM world_binding_head WHERE tenant_id=$1 AND world_id=$2 AND activation_lock_id=$3 ORDER BY channel FOR SHARE",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &previous],
        ).await? {
            if !selected.contains(row.get::<_, String>("channel").as_str()) {
                return Err(BindingFailure::HeadInvalid.into());
            }
        }
    }
    let mut ordered: Vec<_> = changes.iter().collect();
    ordered.sort_unstable_by(|left, right| left.channel.cmp(&right.channel));
    let mut heads = Vec::with_capacity(changes.len());
    for change in ordered {
        let current = tx.query_opt(
            "SELECT body FROM world_binding_head WHERE tenant_id=$1 AND world_id=$2 AND channel=$3 FOR UPDATE",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &change.channel.as_str()],
        ).await?.map(|row| decode::<BindingHead>(row.get("body"))).transpose()?;
        if current != change.expected {
            return Err(BindingFailure::HeadConflict {
                expected: change
                    .expected
                    .as_ref()
                    .map_or(Generation(0), |head| head.generation),
                actual: current
                    .as_ref()
                    .map_or(Generation(0), |head| head.generation),
            }
            .into());
        }
        let head = BindingHead {
            world: world.clone(),
            channel: change.channel.clone(),
            activation_lock_id: graph.lock().id.clone(),
            generation: Generation(next(current.as_ref().map_or(0, |head| head.generation.0))?),
            revision: Revision(next(current.as_ref().map_or(0, |head| head.revision.0))?),
        };
        let changed = if let Some(current) = &current {
            tx.execute(
                "UPDATE world_binding_head SET generation=$4,revision=$5,activation_lock_id=$6,body=$7,published_at=clock_timestamp() WHERE tenant_id=$1 AND world_id=$2 AND channel=$3 AND generation=$8 AND revision=$9 AND activation_lock_id=$10",
                &[&world.tenant_id.as_str(), &world.world_id.as_str(), &head.channel.as_str(),
                  &(head.generation.0 as i64), &(head.revision.0 as i64), &head.activation_lock_id.as_str(), &encode(&head)?,
                  &(current.generation.0 as i64), &(current.revision.0 as i64), &current.activation_lock_id.as_str()],
            ).await?
        } else {
            tx.execute(
                "INSERT INTO world_binding_head(tenant_id,world_id,channel,generation,revision,activation_lock_id,body) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING",
                &[&world.tenant_id.as_str(), &world.world_id.as_str(), &head.channel.as_str(),
                  &(head.generation.0 as i64), &(head.revision.0 as i64), &head.activation_lock_id.as_str(), &encode(&head)?],
            ).await?
        };
        if changed != 1 {
            let row = tx.query_opt(
                "SELECT generation FROM world_binding_head WHERE tenant_id=$1 AND world_id=$2 AND channel=$3",
                &[&world.tenant_id.as_str(), &world.world_id.as_str(), &head.channel.as_str()],
            ).await?;
            return Err(BindingFailure::HeadConflict {
                expected: current.map_or(Generation(0), |head| head.generation),
                actual: Generation(row.map_or(0, |row| row.get::<_, i64>("generation") as u64)),
            }
            .into());
        }
        tx.record_revision(CommittedRevision {
            resource: ResourceRef::Head {
                channel: head.channel.clone(),
            },
            revision: head.revision,
        })?;
        heads.push(head);
    }
    let mut mappings: Vec<_> = channels.iter().collect();
    mappings.sort_unstable_by(|left, right| left.binding_id.cmp(&right.binding_id));
    for mapping in mappings {
        let changed = tx.execute(
            "INSERT INTO world_binding_channel(tenant_id,world_id,binding_id,channel) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,world_id,binding_id) DO UPDATE SET channel=EXCLUDED.channel WHERE world_binding_channel.channel=EXCLUDED.channel",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &mapping.binding_id.as_str(), &mapping.channel.as_str()],
        ).await?;
        if changed != 1 {
            return Err(BindingFailure::InvalidChannels {
                binding_id: mapping.binding_id.clone(),
            }
            .into());
        }
    }
    Ok(heads)
}

pub(super) async fn recheck_heads_read(
    snapshot: &WorldSnapshot<'_>,
    graph: &BindingGraph,
    changes: &[BindingHeadCas],
    channels: &[BindingChannel],
) -> Result<(), BindingError> {
    validate_heads(graph, changes, channels)?;
    let world = snapshot.world();
    let lock = graph.lock();
    if let Some(row) = snapshot.query_opt(
        "SELECT a.content_digest,a.graph,l.state FROM world_activation_lock a LEFT JOIN world_activation_lifecycle l USING(tenant_id,world_id,activation_lock_id) WHERE a.tenant_id=$1 AND a.world_id=$2 AND a.activation_lock_id=$3",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &lock.id.as_str()],
    ).await? {
        let existing = checked_graph(world, &lock.id, row.get("content_digest"), row.get("graph"))?;
        if existing.lock().digest != lock.digest {
            return Err(BindingFailure::LockIdentityConflict.into());
        }
        if row.get::<_, Option<String>>("state").as_deref() != Some("active") {
            return Err(BindingFailure::LockRetiring { activation_lock_id: lock.id.clone() }.into());
        }
    }
    let heads = read_heads(snapshot).await?;
    let selected: BTreeSet<_> = changes.iter().map(|change| &change.channel).collect();
    for change in changes {
        let current = heads
            .iter()
            .find(|(channel, _)| channel == change.channel.as_str())
            .map(|(_, head)| head.as_ref().map_err(Clone::clone))
            .transpose()?;
        if current != change.expected.as_ref() {
            return Err(BindingFailure::HeadConflict {
                expected: change
                    .expected
                    .as_ref()
                    .map_or(Generation(0), |head| head.generation),
                actual: current.map_or(Generation(0), |head| head.generation),
            }
            .into());
        }
        if let Some(previous) = &change.expected {
            for row in snapshot.query(
                "SELECT channel FROM world_binding_head WHERE tenant_id=$1 AND world_id=$2 AND activation_lock_id=$3 ORDER BY channel",
                &[&world.tenant_id.as_str(), &world.world_id.as_str(), &previous.activation_lock_id.as_str()],
            ).await? {
                if !selected.iter().any(|channel| channel.as_str() == row.get::<_, String>("channel")) {
                    return Err(BindingFailure::HeadInvalid.into());
                }
            }
        }
    }
    let current = read_channels(snapshot).await?;
    for mapping in channels {
        if let Some((_, existing)) = current
            .iter()
            .find(|(binding, _)| binding == mapping.binding_id.as_str())
        {
            if existing.as_ref().map_err(Clone::clone)? != mapping {
                return Err(BindingFailure::InvalidChannels {
                    binding_id: mapping.binding_id.clone(),
                }
                .into());
            }
        }
    }
    Ok(())
}

pub(super) async fn emit_published(
    tx: &mut WorldTransaction<'_>,
    heads: &[BindingHead],
    event_id: world_protocol::ids::EventId,
) -> Result<(), BindingError> {
    let head = heads.first().ok_or(BindingFailure::HeadInvalid)?;
    tx.emit(OutboxEvent {
        event_id,
        aggregate_kind: "binding".into(),
        aggregate_id: head.activation_lock_id.to_string(),
        aggregate_revision: head.generation.0,
        event_kind: "world.bindings.published".into(),
        payload: encode(&heads)?,
        causation_id: None,
        origin: "world.bindings".into(),
    })
    .await?;
    Ok(())
}

pub(crate) fn validate_heads(
    graph: &BindingGraph,
    changes: &[BindingHeadCas],
    channels: &[BindingChannel],
) -> Result<(), BindingError> {
    if changes.is_empty() {
        return Err(BindingFailure::HeadInvalid.into());
    }
    let mut selected = BTreeSet::new();
    for change in changes {
        if change.world != graph.lock().world
            || change.replacement != graph.lock().id
            || !selected.insert(change.channel.clone())
            || change.expected.as_ref().is_some_and(|head| {
                head.world != change.world
                    || head.channel != change.channel
                    || head.generation.0 == 0
                    || head.generation.0 >= i64::MAX as u64
                    || head.revision.0 == 0
                    || head.revision.0 >= i64::MAX as u64
            })
        {
            return Err(BindingFailure::HeadInvalid.into());
        }
    }
    let mut mappings = BTreeMap::new();
    for mapping in channels {
        if !selected.contains(&mapping.channel)
            || mappings
                .insert(&mapping.binding_id, &mapping.channel)
                .is_some()
        {
            return Err(BindingFailure::InvalidChannels {
                binding_id: mapping.binding_id.clone(),
            }
            .into());
        }
    }
    for node in &graph.lock().nodes {
        if !mappings.contains_key(&node.binding_id) {
            return Err(BindingFailure::InvalidChannels {
                binding_id: node.binding_id.clone(),
            }
            .into());
        }
    }
    if selected
        .iter()
        .any(|channel| !mappings.values().any(|mapped| *mapped == channel))
    {
        return Err(BindingFailure::HeadInvalid.into());
    }
    Ok(())
}

pub(super) fn encode(value: &impl Serialize) -> Result<serde_json::Value, BindingError> {
    serde_json::to_value(value).map_err(|_| BindingFailure::InternalFault.into())
}
pub(super) fn decode<T: DeserializeOwned>(value: serde_json::Value) -> Result<T, BindingError> {
    serde_json::from_value(value).map_err(|_| BindingFailure::InternalFault.into())
}
fn next(value: u64) -> Result<u64, BindingError> {
    value
        .checked_add(1)
        .filter(|value| *value <= i64::MAX as u64)
        .ok_or_else(|| BindingFailure::HeadInvalid.into())
}
