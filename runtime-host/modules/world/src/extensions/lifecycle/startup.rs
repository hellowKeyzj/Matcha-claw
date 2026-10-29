use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use world_protocol::{
    bindings::{BindingFailure, BindingHead},
    ids::*,
};

use super::{
    DrainedGraph, LifecycleError, LiveExtensions, PreparationPorts, RecoveryInventory,
    RetiringGraph, load_recovery, prepare_graph,
};
use crate::{
    extensions::{
        bindings::{self, Bindings},
        invocation::LedgerSnapshot,
        package::Inventory,
    },
    store::WorldStore,
};

pub(crate) struct StartupReport {
    pub restored: Vec<ActivationLockId>,
    pub blocked_graphs: BTreeMap<ActivationLockId, LifecycleError>,
    pub blocked_heads: BTreeMap<String, BindingFailure>,
    pub blocked_channels: BTreeMap<String, BindingFailure>,
    pub retained: Vec<LedgerSnapshot>,
    pub drained_retirements: Vec<DrainedGraph>,
    pub retiring: Vec<RetiringGraph>,
    pub blocked_retirements: BTreeMap<String, BindingFailure>,
}

impl StartupReport {
    fn unresolved_graphs(&mut self) -> BTreeSet<ActivationLockId> {
        let mut unresolved = BTreeSet::new();
        for (id, error) in std::mem::take(&mut self.blocked_graphs) {
            let error = crate::owner::Error::from(error);
            if matches!(
                error.unresolved_phase(),
                Some(
                    world_protocol::operation::OperationPhase::CommitIndeterminate
                        | world_protocol::operation::OperationPhase::EffectIndeterminate
                )
            ) {
                unresolved.insert(id.clone());
            }
            self.blocked_graphs.insert(
                id,
                LifecycleError::Binding(bindings::BindingError::Operation(error)),
            );
        }
        unresolved
    }
}

/// Rebuilds live generations, never persisted Stores, children or invocation authority.
/// A graph is published only after every real endpoint has prepared successfully.
pub(crate) async fn startup(
    store: &WorldStore,
    root: &crate::authorization::AuthorityRoot,
    world: WorldRef,
    inventory: &Arc<Inventory>,
    bindings: &Bindings,
    live: &Arc<LiveExtensions>,
    ports: &PreparationPorts,
    cancellation: CancellationToken,
    deadline: Instant,
) -> Result<StartupReport, LifecycleError> {
    let mut report = StartupReport {
        restored: Vec::new(),
        blocked_graphs: BTreeMap::new(),
        blocked_heads: BTreeMap::new(),
        blocked_channels: BTreeMap::new(),
        retained: Vec::new(),
        drained_retirements: Vec::new(),
        retiring: Vec::new(),
        blocked_retirements: BTreeMap::new(),
    };
    retry_startup(
        store,
        root,
        world,
        inventory,
        bindings,
        live,
        ports,
        cancellation,
        deadline,
        &mut report,
    )
    .await?;
    Ok(report)
}

/// Explicit same-provision retry; the caller retains this report even on error.
pub(crate) async fn retry_startup(
    store: &WorldStore,
    root: &crate::authorization::AuthorityRoot,
    world: WorldRef,
    inventory: &Arc<Inventory>,
    bindings: &Bindings,
    live: &Arc<LiveExtensions>,
    ports: &PreparationPorts,
    cancellation: CancellationToken,
    deadline: Instant,
    report: &mut StartupReport,
) -> Result<(), LifecycleError> {
    let unresolved = report.unresolved_graphs();
    if let Some((intent, committed)) = store.recover_committed_world_restore(root, &world).await? {
        if let Some(proof) = live.begin_restore_recovery(&intent, &committed)? {
            if !unresolved.is_empty() {
                let _ = bindings.drain_failed_world_until(&world, deadline).await;
                report.retained = live.startup_retained(&world);
                return Ok(());
            }
            let restore = intent
                .restore()
                .ok_or(LifecycleError::InvalidPersistedState)?;
            let result = async {
                let prepared = bindings
                    .prepare_restore_recovery(
                        &restore,
                        &committed,
                        &proof,
                        inventory,
                        ports,
                        &cancellation,
                        deadline,
                    )
                    .await?;
                bindings
                    .publish_recovered(&committed, &proof, &prepared, inventory)
                    .await?;
                for graph in prepared.required_graphs() {
                    let id = &graph.lock().id;
                    if !report.restored.contains(id) {
                        report.restored.push(id.clone());
                    }
                    if !unresolved.contains(id) {
                        report.blocked_graphs.remove(id);
                    }
                }
                for (id, error) in Arc::try_unwrap(prepared)
                    .ok()
                    .expect("completed restore snapshot released its preparation")
                    .into_blocked_graphs()
                {
                    if !unresolved.contains(&id) {
                        report.blocked_graphs.insert(id, error);
                    }
                }
                Ok::<_, LifecycleError>(())
            }
            .await;
            if let Err(cause) = result {
                let remaining = bindings.drain_failed_world_until(&world, deadline).await;
                if remaining.is_empty() {
                    return Err(cause);
                }
                return Err(LifecycleError::Cleanup {
                    cause: Box::new(cause),
                    remaining_resources: remaining
                        .iter()
                        .flat_map(super::retained_resources)
                        .collect(),
                });
            }
            let recovery = load_recovery(store, world.clone()).await?;
            report.retained = bindings.drain_failed_world_until(&world, deadline).await;
            recover_retirements(root, &world, bindings, &recovery, deadline, report).await;
            report.retained = live.startup_retained(&world);
            return Ok(());
        }
    }
    let recovery = load_recovery(store, world.clone()).await?;
    report.retained = bindings.drain_failed_world_until(&world, deadline).await;
    let mut selected: BTreeMap<ActivationLockId, Vec<BindingHead>> = BTreeMap::new();
    for head in &recovery.heads {
        selected
            .entry(head.activation_lock_id.clone())
            .or_default()
            .push(head.clone());
    }
    let required = store
        .snapshot(world.clone(), |snapshot| {
            Box::pin(bindings::read_startup_required_activation_locks(snapshot))
        })
        .await?;
    for id in required {
        selected.entry(id).or_default();
    }
    report.blocked_heads = recovery.blocked_heads.clone();
    report.blocked_channels = recovery.blocked_channels.clone();
    recover_retirements(root, &world, bindings, &recovery, deadline, report).await;
    let unresolved = report.unresolved_graphs();
    // A replaced head may release an obsolete failure, never a required run/release
    // pin, a pending retirement or an indeterminate graph holding its original custody.
    report.blocked_graphs.retain(|id, _| selected.contains_key(id) || unresolved.contains(id)
        || recovery.retirements.iter().any(|(retiring, _, _)| retiring == id));
    for (id, heads) in selected {
        if unresolved.contains(&id) {
            continue;
        }
        if report
            .retiring
            .iter()
            .any(|retiring| retiring.lock() == &id)
            || report
                .drained_retirements
                .iter()
                .any(|drained| drained.lock() == &id)
        {
            report.blocked_graphs.insert(
                id.clone(),
                LifecycleError::Binding(
                    BindingFailure::LockRetiring {
                        activation_lock_id: id,
                    }
                    .into(),
                ),
            );
            continue;
        }
        let result = async {
            let graph = recovery
                .graphs
                .get(&id)
                .ok_or_else(|| {
                    LifecycleError::Binding(
                        BindingFailure::MissingActivationLock {
                            activation_lock_id: id.clone(),
                        }
                        .into(),
                    )
                })?
                .as_ref()
                .map_err(|failure| LifecycleError::Binding(failure.clone().into()))?
                .clone();
            if graph.lock().world != world {
                return Err(LifecycleError::InvalidPersistedState);
            }
            let selected_channels = heads
                .iter()
                .map(|head| &head.channel)
                .collect::<BTreeSet<_>>();
            let node_bindings = graph
                .lock()
                .nodes
                .iter()
                .map(|node| &node.binding_id)
                .collect::<BTreeSet<_>>();
            let channels = recovery
                .channels
                .iter()
                .filter(|mapping| {
                    (heads.is_empty() || selected_channels.contains(&mapping.channel))
                        && node_bindings.contains(&mapping.binding_id)
                })
                .cloned()
                .collect::<Vec<_>>();
            if let Some(current) = live.startup_graph(&graph, &channels)? {
                let current_id = id.clone();
                let live = Arc::clone(live);
                store
                    .snapshot(world.clone(), |snapshot| {
                        Box::pin(async move {
                            if heads.is_empty()
                                && !bindings::read_startup_required_activation_locks(snapshot)
                                    .await?
                                    .contains(&current_id)
                            {
                                return Err(LifecycleError::Binding(
                                    BindingFailure::LockIdentityConflict.into(),
                                ));
                            }
                            let durable =
                                bindings::read_active_graph(snapshot, &current_id).await?;
                            if durable.lock() != current.graph.lock() {
                                return Err(LifecycleError::InvalidPersistedState);
                            }
                            let current_heads = bindings::read_heads(snapshot).await?;
                            if heads.iter().any(|head| {
                                !current_heads
                                    .iter()
                                    .any(|(_, current)| current.as_ref() == Ok(head))
                            }) {
                                return Err(LifecycleError::Binding(
                                    BindingFailure::HeadInvalid.into(),
                                ));
                            }
                            let mappings = bindings::read_channels(snapshot).await?;
                            for channel in &channels {
                                if !mappings
                                    .iter()
                                    .any(|(_, current)| current.as_ref() == Ok(channel))
                                {
                                    return Err(LifecycleError::Binding(
                                        BindingFailure::InvalidChannels {
                                            binding_id: channel.binding_id.clone(),
                                        }
                                        .into(),
                                    ));
                                }
                            }
                            bindings::recheck_prepared_graph(snapshot, &durable, &current.configs)
                                .await?;
                            let selected = live
                                .startup_graph(&durable, &channels)?
                                .ok_or(LifecycleError::InvalidPersistedState)?;
                            if !Arc::ptr_eq(&current, &selected) {
                                return Err(LifecycleError::AlreadyPrepared);
                            }
                            Ok::<_, LifecycleError>(())
                        })
                    })
                    .await?;
                return Ok(());
            }
            if report.restored.contains(&id) {
                return Err(LifecycleError::InvalidPersistedState);
            }
            let prepared = prepare_graph(
                graph,
                channels,
                &recovery,
                inventory,
                live,
                ports,
                &cancellation,
                deadline,
            )
            .await?;
            if heads.is_empty() {
                bindings
                    .restore_exact(prepared)
                    .await
                    .map_err(LifecycleError::Binding)
            } else {
                bindings
                    .restore_heads(heads, prepared)
                    .map_err(LifecycleError::Binding)
            }
        }
        .await;
        match result {
            Ok(()) => {
                if !report.restored.contains(&id) {
                    report.restored.push(id.clone());
                }
                report.blocked_graphs.remove(&id);
            }
            Err(error) => {
                report.blocked_graphs.insert(id, error);
            }
        }
    }
    let _ = bindings.drain_failed_world_until(&world, deadline).await;
    report.retained = live.startup_retained(&world);
    Ok(())
}

pub(crate) async fn recover_retirements(
    root: &crate::authorization::AuthorityRoot,
    world: &WorldRef,
    bindings: &Bindings,
    recovery: &RecoveryInventory,
    deadline: Instant,
    report: &mut StartupReport,
) {
    let unresolved = report.unresolved_graphs();
    for retiring in std::mem::take(&mut report.retiring) {
        match retiring.drain_until(deadline).await {
            Ok(drained) => {
                if !unresolved.contains(drained.lock()) {
                    report.blocked_graphs.remove(drained.lock());
                }
                report.drained_retirements.push(drained);
            }
            Err((retiring, remaining)) => {
                report.retiring.push(retiring);
                report.retained.extend(remaining);
            }
        }
    }
    report.blocked_retirements = recovery.blocked_retirements.clone();
    for (id, _, _) in &recovery.retirements {
        if unresolved.contains(id)
            || report.retiring.iter().any(|retiring| retiring.lock() == id)
            || report
                .drained_retirements
                .iter()
                .any(|drained| drained.lock() == id)
        {
            continue;
        }
        match bindings
            .restore_retirement(root, world.clone(), id.clone())
            .await
        {
            Ok(retiring) => match retiring.drain_until(deadline).await {
                Ok(drained) => {
                    report.blocked_graphs.remove(id);
                    report.drained_retirements.push(drained);
                }
                Err((retiring, remaining)) => {
                    report.blocked_graphs.remove(id);
                    report.retiring.push(retiring);
                    report.retained.extend(remaining);
                }
            },
            Err(error) => {
                report.blocked_graphs.insert(id.clone(), error.into());
            }
        }
    }
}
