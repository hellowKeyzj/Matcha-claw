use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex},
};

use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use world_protocol::{
    api::PackageConfigView,
    bindings::{BindingChannel, BindingFailure, BindingHead, BindingHeadCas},
    ids::{ActivationLockId, CommitId, WorldRef, WriterDomain},
};

use super::{BindingError, BindingGraph, Bindings, durable, guards};
use crate::{
    authorization::{self, Admission},
    extensions::{
        lifecycle::{
            DrainedWorld, PreparationPorts, PreparedGraph, RecoveryInventory, RestoreRecovery,
            load_recovery, prepare_graph_for_restore, prepare_graph_for_restore_recovery,
        },
        package::Inventory,
    },
    store::{
        ArchiveSnapshot, CommitRequest, CommittedWorldRestore, WorldRestoreIntent, WorldSnapshot,
        WorldTransaction,
    },
};

async fn model_lock(
    snapshot: &WorldSnapshot<'_>,
) -> Result<Option<ActivationLockId>, BindingError> {
    let Some(release_id) = crate::releases::read_active_release_snapshot(snapshot).await? else {
        return Ok(None);
    };
    let release = crate::releases::read_release_snapshot(snapshot, &release_id)
        .await?
        .ok_or(BindingFailure::LockIdentityConflict)?;
    Ok(Some(release.artifact.activation_lock_id))
}

pub(super) async fn active_model_lock(
    snapshot: &WorldSnapshot<'_>,
) -> Result<ActivationLockId, BindingError> {
    model_lock(snapshot).await?.ok_or_else(|| BindingFailure::LockIdentityConflict.into())
}

pub(crate) async fn read_startup_required_activation_locks(
    snapshot: &WorldSnapshot<'_>,
) -> Result<BTreeSet<ActivationLockId>, BindingError> {
    let mut locks = crate::owner::read_restore_required_activation_locks(snapshot).await?;
    locks.extend(model_lock(snapshot).await?);
    Ok(locks)
}

type RestoreSelection = Vec<(Arc<BindingGraph>, Vec<BindingChannel>)>;

pub(super) fn select_restore(
    recovery: &RecoveryInventory,
    locks: BTreeSet<ActivationLockId>,
) -> Result<(RestoreSelection, Vec<BindingChannel>), BindingError> {
    if let Some(failure) = recovery.blocked_heads.values().next() {
        return Err(failure.clone().into());
    }
    let mut selected = Vec::with_capacity(locks.len());
    let mut basis = BTreeMap::new();
    for id in locks {
        let graph = recovery
            .graphs
            .get(&id)
            .ok_or_else(|| BindingFailure::MissingActivationLock {
                activation_lock_id: id.clone(),
            })?
            .as_ref()
            .map_err(Clone::clone)?
            .clone();
        let heads = recovery
            .heads
            .iter()
            .filter(|head| head.activation_lock_id == id)
            .collect::<Vec<_>>();
        let head_channels = heads
            .iter()
            .map(|head| &head.channel)
            .collect::<BTreeSet<_>>();
        let bindings = graph
            .lock()
            .nodes
            .iter()
            .map(|node| &node.binding_id)
            .collect::<BTreeSet<_>>();
        for binding in &bindings {
            if let Some(failure) = recovery.blocked_channels.get(binding.as_str()) {
                return Err(failure.clone().into());
            }
        }
        let channels = recovery
            .channels
            .iter()
            .filter(|mapping| {
                bindings.contains(&mapping.binding_id)
                    && (heads.is_empty() || head_channels.contains(&mapping.channel))
            })
            .cloned()
            .collect::<Vec<_>>();
        for binding in &bindings {
            if !channels
                .iter()
                .any(|mapping| &mapping.binding_id == *binding)
            {
                return Err(BindingFailure::InvalidChannels {
                    binding_id: (*binding).clone(),
                }
                .into());
            }
        }
        if !heads.is_empty() {
            let changes = heads
                .into_iter()
                .map(|head| BindingHeadCas {
                    world: head.world.clone(),
                    channel: head.channel.clone(),
                    expected: Some(head.clone()),
                    replacement: id.clone(),
                })
                .collect::<Vec<_>>();
            durable::validate_heads(&graph, &changes, &channels)?;
        }
        for channel in &channels {
            if basis
                .insert(channel.binding_id.clone(), channel.clone())
                .is_some_and(|previous| previous != *channel)
            {
                return Err(BindingFailure::InvalidChannels {
                    binding_id: channel.binding_id.clone(),
                }
                .into());
            }
        }
        selected.push((graph, channels));
    }
    Ok((selected, basis.into_values().collect()))
}

#[derive(Clone)]
pub(super) struct PreparedGraphBasis {
    pub(super) graph: Arc<BindingGraph>,
    pub(super) configs: Vec<PackageConfigView>,
}

pub(super) async fn recheck_prepared_graphs(
    snapshot: &WorldSnapshot<'_>,
    model_lock: &ActivationLockId,
    run_locks: &BTreeSet<ActivationLockId>,
    heads: &[BindingHead],
    channels: &[BindingChannel],
    graphs: &[PreparedGraphBasis],
) -> Result<(), BindingError> {
    if active_model_lock(snapshot).await? != *model_lock
        || crate::owner::read_restore_required_activation_locks(snapshot).await? != *run_locks
    {
        return Err(BindingFailure::LockIdentityConflict.into());
    }
    let current_heads = durable::read_heads(snapshot).await?;
    if current_heads.len() != heads.len() {
        return Err(BindingFailure::HeadInvalid.into());
    }
    for (_, head) in current_heads {
        if !heads.contains(&head?) {
            return Err(BindingFailure::HeadInvalid.into());
        }
    }
    let mappings = durable::read_channels(snapshot).await?;
    for mapping in channels {
        if !mappings
            .iter()
            .any(|(_, current)| current.as_ref() == Ok(mapping))
        {
            return Err(BindingFailure::InvalidChannels {
                binding_id: mapping.binding_id.clone(),
            }
            .into());
        }
    }
    for graph in graphs {
        let current = durable::read_active_graph(snapshot, &graph.graph.lock().id).await?;
        if current.lock() != graph.graph.lock() {
            return Err(BindingFailure::LockIdentityConflict.into());
        }
        guards::recheck_read(snapshot, &current, &graph.configs).await?;
    }
    Ok(())
}

/// Owns real fresh candidates across the original final commit and its recovery.
#[must_use]
pub(crate) struct PreparedRestore {
    world: WorldRef,
    commit: CommitId,
    intent: CommitId,
    archive_lock: ActivationLockId,
    run_locks: BTreeSet<ActivationLockId>,
    graphs: Vec<PreparedGraphBasis>,
    heads: Vec<BindingHead>,
    channels: Vec<BindingChannel>,
    blocked: BTreeMap<ActivationLockId, crate::extensions::lifecycle::LifecycleError>,
    candidates: Mutex<Option<Vec<PreparedGraph>>>,
}

/// Private construction proves current guards ran in this exact transaction.
pub(crate) struct CheckedRestore {
    transaction: Arc<()>,
    world: WorldRef,
    commit: CommitId,
    lock: ActivationLockId,
}

impl CheckedRestore {
    pub(crate) fn matches(&self, tx: &WorldTransaction<'_>, lock: &ActivationLockId) -> bool {
        self.world == *tx.world()
            && self.commit == *tx.commit_id()
            && &self.lock == lock
            && Arc::ptr_eq(&self.transaction, &tx.transaction_token())
    }
}

impl PreparedRestore {
    pub(crate) fn world(&self) -> &WorldRef {
        &self.world
    }
    pub(crate) fn commit_id(&self) -> &CommitId {
        &self.commit
    }
    pub(crate) fn required_graphs(&self) -> impl Iterator<Item = &Arc<BindingGraph>> {
        self.graphs.iter().map(|prepared| &prepared.graph)
    }
    pub(crate) fn blocked_graphs(
        &self,
    ) -> &BTreeMap<ActivationLockId, crate::extensions::lifecycle::LifecycleError> {
        &self.blocked
    }
    pub(crate) fn into_blocked_graphs(
        self,
    ) -> BTreeMap<ActivationLockId, crate::extensions::lifecycle::LifecycleError> {
        self.blocked
    }

    pub(crate) async fn recheck(
        &self,
        tx: &WorldTransaction<'_>,
        admission: &Admission,
        exact_lock: &ActivationLockId,
    ) -> Result<CheckedRestore, BindingError> {
        if tx.world() != &self.world
            || tx.commit_id() != &self.commit
            || exact_lock != &self.archive_lock
            || admission.invocation().world != *tx.world()
        {
            return Err(BindingFailure::LockIdentityConflict.into());
        }
        tx.require_exclusive_storage()?;
        tx.require_domain(
            &WriterDomain::try_new("bindings").expect("fixed binding writer domain"),
        )?;
        authorization::recheck(tx, admission, &tx.now().await?).await?;
        if crate::owner::restore_required_activation_locks(tx).await? != self.run_locks {
            return Err(BindingFailure::LockIdentityConflict.into());
        }
        let world = tx.world();
        let rows = tx.query(
            "SELECT channel FROM world_binding_head WHERE tenant_id=$1 AND world_id=$2 ORDER BY channel FOR SHARE",
            &[&world.tenant_id.as_str(), &world.world_id.as_str()],
        ).await?;
        if rows.len() != self.heads.len() {
            return Err(BindingFailure::HeadInvalid.into());
        }
        for head in &self.heads {
            if durable::read_binding_head(tx, &head.channel)
                .await?
                .as_ref()
                != Some(head)
            {
                return Err(BindingFailure::HeadInvalid.into());
            }
        }
        for mapping in &self.channels {
            let row = tx.query_opt(
                "SELECT channel FROM world_binding_channel WHERE tenant_id=$1 AND world_id=$2 AND binding_id=$3 FOR SHARE",
                &[&world.tenant_id.as_str(), &world.world_id.as_str(), &mapping.binding_id.as_str()],
            ).await?;
            if row.is_none_or(|row| row.get::<_, String>(0) != mapping.channel.as_str()) {
                return Err(BindingFailure::InvalidChannels {
                    binding_id: mapping.binding_id.clone(),
                }
                .into());
            }
        }
        for prepared in &self.graphs {
            let current = durable::read_graph_in_transaction(tx, &prepared.graph.lock().id).await?;
            if current.lock() != prepared.graph.lock() {
                return Err(BindingFailure::LockIdentityConflict.into());
            }
            admission.require_access(&super::retirement_impact(tx, &current).await?)?;
            guards::recheck(tx, &current, &prepared.configs).await?;
        }
        Ok(CheckedRestore {
            transaction: tx.transaction_token(),
            world: tx.world().clone(),
            commit: tx.commit_id().clone(),
            lock: exact_lock.clone(),
        })
    }
}

impl Bindings {
    pub(crate) async fn restore_exact(&self, prepared: PreparedGraph) -> Result<(), BindingError> {
        let graph = prepared.graph().clone();
        let configs = prepared.configs().to_vec();
        let channels = prepared.channels().to_vec();
        let candidate = Arc::new(Mutex::new(Some(prepared)));
        let publication = candidate.clone();
        let live = self.live.clone();
        let gate = self.gate.clone();
        let result = self.store.snapshot(graph.lock().world.clone(), move |snapshot| {
            Box::pin(async move {
                let id = &graph.lock().id;
                if !read_startup_required_activation_locks(snapshot).await?.contains(id) {
                    return Err(BindingFailure::LockIdentityConflict.into());
                }
                let current = durable::read_active_graph(snapshot, id).await?;
                if current.lock() != graph.lock() {
                    return Err(BindingFailure::LockIdentityConflict.into());
                }
                let mappings = durable::read_channels(snapshot).await?;
                for mapping in &channels {
                    if !mappings.iter().any(|(_, current)| current.as_ref() == Ok(mapping)) {
                        return Err(BindingFailure::InvalidChannels {
                            binding_id: mapping.binding_id.clone(),
                        }.into());
                    }
                }
                guards::recheck_read(snapshot, &current, &configs).await?;
                let heads = channels.iter().map(|mapping| mapping.channel.clone()).collect::<Vec<_>>();
                let domains = graph.lock().nodes.iter().filter_map(|node| node.state.as_ref()
                    .map(|state| state.writer_domain.clone())).collect::<Vec<_>>();
                gate.synchronized(|access| {
                    access.require_lock_open(&graph.lock().world, id)?;
                    access.require_open(&graph.lock().world, &heads, &domains)?;
                    live.publish(access, publication.lock().expect("world startup candidate poisoned")
                        .take().expect("checked startup candidate retained"));
                    Ok::<_, BindingError>(())
                })
            })
        }).await;
        if let Some(prepared) = candidate.lock().expect("world startup candidate poisoned").take() {
            self.reject_candidate(prepared);
        }
        result
    }

    pub(crate) async fn prepare_restore(
        &self,
        snapshot: &ArchiveSnapshot,
        request: &CommitRequest,
        intent: &WorldRestoreIntent<'_>,
        drained: &DrainedWorld,
        inventory: &Arc<Inventory>,
        ports: &PreparationPorts,
        cancellation: &CancellationToken,
        deadline: Instant,
    ) -> Result<PreparedRestore, BindingError> {
        if snapshot.world() != intent.world()
            || snapshot.digest() != intent.archive_digest()
            || request.world != *intent.world()
            || &request.commit_id != intent.final_commit_id()
            || drained.world() != intent.world()
            || drained.commit_id() != intent.commit_id()
            || !self.live.validate_world_drained(drained)
        {
            return Err(BindingFailure::LockIdentityConflict.into());
        }
        request.clone().prepare()?;
        let remaining = self
            .drain_failed_world_until(
                &request.world,
                Instant::now() + ports.execution_policy().cleanup_timeout,
            )
            .await;
        if !remaining.is_empty() {
            return Err(crate::extensions::lifecycle::LifecycleError::Cleanup {
                cause: Box::new(crate::extensions::lifecycle::LifecycleError::Contract(
                    world_protocol::lifecycle::LifecycleFailure::AcquisitionClosed,
                )),
                remaining_resources: remaining
                    .iter()
                    .flat_map(crate::extensions::lifecycle::retained_resources)
                    .collect(),
            }
            .into());
        }
        let recovery = load_recovery(&self.store, request.world.clone()).await?;
        if let Some(failure) = recovery.blocked_heads.values().next() {
            return Err(failure.clone().into());
        }
        let run_locks = self
            .store
            .snapshot(request.world.clone(), |snapshot| {
                Box::pin(async move {
                    crate::owner::read_restore_required_activation_locks(snapshot).await
                })
            })
            .await?;
        let mut locks = snapshot.required_activation_locks();
        locks.extend(run_locks.iter().cloned());
        locks.extend(
            recovery
                .heads
                .iter()
                .map(|head| head.activation_lock_id.clone()),
        );
        let mut blocked = BTreeMap::new();
        for (graph, _) in drained.affected_graphs() {
            if graph.lock().world != request.world {
                return Err(BindingFailure::LockIdentityConflict.into());
            }
            if !locks.contains(&graph.lock().id) {
                let reason = graph
                    .lock()
                    .nodes
                    .iter()
                    .find_map(|node| {
                        recovery.blocked_node(&graph, &node.id).map(|reason| {
                            crate::extensions::lifecycle::LifecycleError::RecoveryBlocked {
                                node: node.id.clone(),
                                reason,
                            }
                        })
                    })
                    .unwrap_or(crate::extensions::lifecycle::LifecycleError::Contract(
                        world_protocol::lifecycle::LifecycleFailure::AcquisitionClosed,
                    ));
                blocked.insert(graph.lock().id.clone(), reason);
            }
        }
        let (selected, channels) = select_restore(&recovery, locks)?;
        let mut candidates = Vec::with_capacity(selected.len());
        for (graph, channels) in selected {
            match prepare_graph_for_restore(
                graph,
                channels,
                &recovery,
                inventory,
                &self.live,
                ports,
                cancellation,
                deadline,
                intent,
                drained,
            )
            .await
            {
                Ok(prepared) => candidates.push(prepared),
                Err(error) => {
                    for candidate in candidates {
                        self.reject_candidate(candidate);
                    }
                    return Err(error.into());
                }
            }
        }
        let graphs = candidates
            .iter()
            .map(|candidate| PreparedGraphBasis {
                graph: candidate.graph().clone(),
                configs: candidate.configs().to_vec(),
            })
            .collect();
        Ok(PreparedRestore {
            world: request.world.clone(),
            commit: request.commit_id.clone(),
            intent: intent.commit_id().clone(),
            archive_lock: snapshot.activation_lock().clone(),
            run_locks,
            graphs,
            heads: recovery.heads,
            channels,
            blocked,
            candidates: Mutex::new(Some(candidates)),
        })
    }

    pub(crate) async fn prepare_restore_recovery(
        &self,
        intent: &WorldRestoreIntent<'_>,
        committed: &CommittedWorldRestore,
        proof: &RestoreRecovery,
        inventory: &Arc<Inventory>,
        ports: &PreparationPorts,
        cancellation: &CancellationToken,
        deadline: Instant,
    ) -> Result<Arc<PreparedRestore>, BindingError> {
        if intent.world() != committed.world()
            || intent.world() != proof.world()
            || intent.commit_id() != committed.intent_commit_id()
            || intent.commit_id() != proof.commit_id()
            || intent.final_commit_id() != committed.commit_id()
            || !self.live.validate_restore_recovery(proof)
        {
            return Err(BindingFailure::LockIdentityConflict.into());
        }
        let remaining = self
            .drain_failed_world_until(intent.world(), deadline)
            .await;
        if !remaining.is_empty() {
            return Err(crate::extensions::lifecycle::LifecycleError::Cleanup {
                cause: Box::new(crate::extensions::lifecycle::LifecycleError::Contract(
                    world_protocol::lifecycle::LifecycleFailure::AcquisitionClosed,
                )),
                remaining_resources: remaining
                    .iter()
                    .flat_map(crate::extensions::lifecycle::retained_resources)
                    .collect(),
            }
            .into());
        }
        let recovery = load_recovery(&self.store, intent.world().clone()).await?;
        let (archive_lock, run_locks) = self
            .store
            .snapshot(intent.world().clone(), |snapshot| {
                Box::pin(async move {
                    Ok::<_, BindingError>((
                        active_model_lock(snapshot).await?,
                        crate::owner::read_restore_required_activation_locks(snapshot).await?,
                    ))
                })
            })
            .await?;
        let mut locks = run_locks.clone();
        locks.insert(archive_lock.clone());
        locks.extend(
            recovery
                .heads
                .iter()
                .map(|head| head.activation_lock_id.clone()),
        );
        let blocked = recovery
            .graphs
            .iter()
            .filter(|(id, _)| !locks.contains(*id))
            .map(|(id, graph)| {
                let reason = match graph {
                    Err(failure) => crate::extensions::lifecycle::LifecycleError::Binding(
                        failure.clone().into(),
                    ),
                    Ok(graph) => graph
                        .lock()
                        .nodes
                        .iter()
                        .find_map(|node| {
                            recovery.blocked_node(graph, &node.id).map(|reason| {
                                crate::extensions::lifecycle::LifecycleError::RecoveryBlocked {
                                    node: node.id.clone(),
                                    reason,
                                }
                            })
                        })
                        .unwrap_or(crate::extensions::lifecycle::LifecycleError::Contract(
                            world_protocol::lifecycle::LifecycleFailure::AcquisitionClosed,
                        )),
                };
                (id.clone(), reason)
            })
            .collect();
        let (selected, channels) = select_restore(&recovery, locks)?;
        let mut candidates = Vec::with_capacity(selected.len());
        for (graph, channels) in selected {
            match prepare_graph_for_restore_recovery(
                graph,
                channels,
                &recovery,
                inventory,
                &self.live,
                ports,
                cancellation,
                deadline,
                proof,
            )
            .await
            {
                Ok(prepared) => candidates.push(prepared),
                Err(error) => {
                    for candidate in candidates {
                        self.reject_candidate(candidate);
                    }
                    return Err(error.into());
                }
            }
        }
        let graphs = candidates
            .iter()
            .map(|candidate| PreparedGraphBasis {
                graph: candidate.graph().clone(),
                configs: candidate.configs().to_vec(),
            })
            .collect();
        Ok(Arc::new(PreparedRestore {
            world: intent.world().clone(),
            commit: committed.commit_id().clone(),
            intent: intent.commit_id().clone(),
            archive_lock,
            run_locks,
            graphs,
            heads: recovery.heads,
            channels,
            blocked,
            candidates: Mutex::new(Some(candidates)),
        }))
    }

    pub(crate) async fn publish_recovered(
        &self,
        committed: &CommittedWorldRestore,
        proof: &Arc<RestoreRecovery>,
        prepared: &Arc<PreparedRestore>,
        inventory: &Inventory,
    ) -> Result<(), BindingError> {
        let result = async {
            if committed.world() != prepared.world()
                || committed.commit_id() != prepared.commit_id()
                || committed.intent_commit_id() != &prepared.intent
                || proof.world() != prepared.world()
                || proof.commit_id() != &prepared.intent
                || !self.live.validate_restore_recovery(proof)
            {
                return Err(BindingFailure::LockIdentityConflict.into());
            }
            let _inventory = inventory.lock_transfer_publication().await;
            let committed = committed.clone();
            let prepared = prepared.clone();
            let proof = proof.clone();
            let live = self.live.clone();
            let gate = self.gate.clone();
            let heads = self.heads.clone();
            self.store
                .snapshot(prepared.world.clone(), move |snapshot| {
                    Box::pin(async move {
                        committed.recheck_read(snapshot).await?;
                        recheck_prepared_graphs(
                            snapshot,
                            &prepared.archive_lock,
                            &prepared.run_locks,
                            &prepared.heads,
                            &prepared.channels,
                            &prepared.graphs,
                        )
                        .await?;
                        gate.synchronized(|access| {
                            let mut candidates = prepared
                                .candidates
                                .lock()
                                .expect("world restored candidates poisoned");
                            if let Some(graphs) = candidates.as_mut() {
                                live.publish_world_restore_recovery(
                                    access, &committed, &proof, graphs, &prepared,
                                )?;
                                let mut heads = heads.lock().expect("world binding heads poisoned");
                                heads.retain(|(world, _), _| world != prepared.world());
                                for head in &prepared.heads {
                                    heads.insert(
                                        (head.world.clone(), head.channel.clone()),
                                        head.clone(),
                                    );
                                }
                                *candidates = None;
                            }
                            Ok::<_, BindingError>(())
                        })
                    })
                })
                .await
        }
        .await;
        if result.is_err() {
            self.reject_restore(prepared);
        }
        result.map_err(|error: BindingError| error.commit_unresolved(&prepared.commit))
    }

    fn reject_restore(&self, prepared: &PreparedRestore) {
        let candidates = prepared
            .candidates
            .lock()
            .expect("world restored candidates poisoned")
            .as_mut()
            .map(std::mem::take)
            .unwrap_or_default();
        for candidate in candidates {
            self.reject_candidate(candidate);
        }
    }

    pub(crate) fn publish_restored(
        &self,
        committed: &CommittedWorldRestore,
        drained: &DrainedWorld,
        prepared: &PreparedRestore,
    ) -> Result<(), BindingError> {
        let result = self.gate.synchronized(|access| {
            if committed.world() != &prepared.world
                || committed.commit_id() != &prepared.commit
                || committed.intent_commit_id() != &prepared.intent
            {
                return Err(BindingFailure::LockIdentityConflict.into());
            }
            let mut candidates = prepared
                .candidates
                .lock()
                .expect("world restored candidates poisoned");
            if let Some(graphs) = candidates.as_mut() {
                self.live
                    .publish_world_restore(access, committed, drained, graphs, prepared)?;
                let mut heads = self.heads.lock().expect("world binding heads poisoned");
                heads.retain(|(world, _), _| world != committed.world());
                for head in &prepared.heads {
                    heads.insert((head.world.clone(), head.channel.clone()), head.clone());
                }
                *candidates = None;
            }
            Ok(())
        });
        result.map_err(|error: BindingError| error.commit_unresolved(&prepared.commit))
    }
}
