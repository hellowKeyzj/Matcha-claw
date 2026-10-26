use std::{
    collections::BTreeSet,
    sync::{Arc, Mutex},
};

use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use world_protocol::{
    bindings::{BindingChannel, BindingFailure, BindingHead},
    ids::{ActivationLockId, WorldRef},
};

use super::{
    BindingError, BindingGraph, Bindings,
    restore::{PreparedGraphBasis, active_model_lock, recheck_prepared_graphs, select_restore},
};
use crate::{
    extensions::{
        lifecycle::{
            LifecycleError, PreparationPorts, PreparedGraph, TransferHydration, load_recovery,
            prepare_graph_for_transfer,
        },
        package::Inventory,
    },
    store::TransferCut,
};

/// Fresh endpoints belong to this exact transfer hydration, never a restored old generation.
#[must_use]
pub(crate) struct PreparedTransfer {
    hydration: Arc<TransferHydration>,
    model_lock: ActivationLockId,
    run_locks: BTreeSet<ActivationLockId>,
    graphs: Vec<PreparedGraphBasis>,
    heads: Vec<BindingHead>,
    channels: Vec<BindingChannel>,
    candidates: Mutex<Option<Vec<PreparedGraph>>>,
}

impl PreparedTransfer {
    pub(crate) fn world(&self) -> &WorldRef {
        self.hydration.world()
    }

    pub(crate) fn cut(&self) -> &TransferCut {
        self.hydration.cut()
    }

    pub(crate) fn required_graphs(&self) -> impl Iterator<Item = &Arc<BindingGraph>> {
        self.graphs.iter().map(|prepared| &prepared.graph)
    }

    pub(crate) fn matches_hydration(&self, hydration: &TransferHydration) -> bool {
        std::ptr::eq(self.hydration.as_ref(), hydration)
    }
}

impl Bindings {
    pub(crate) async fn prepare_transfer(
        &self,
        hydration: &Arc<TransferHydration>,
        inventory: &Arc<Inventory>,
        ports: &PreparationPorts,
        cancellation: &CancellationToken,
        deadline: Instant,
    ) -> Result<Arc<PreparedTransfer>, BindingError> {
        if self.store.identity_receipt().storage_id() != hydration.storage_id()
            || !self.live.validate_transfer_hydration(hydration)
        {
            return Err(BindingFailure::LockIdentityConflict.into());
        }
        let proof = hydration.clone();
        let (model_lock, run_locks) = self
            .store
            .snapshot(hydration.world().clone(), move |snapshot| {
                Box::pin(async move {
                    proof.recheck_read(snapshot).await?;
                    Ok::<_, BindingError>((
                        active_model_lock(snapshot).await?,
                        crate::owner::read_restore_required_activation_locks(snapshot).await?,
                    ))
                })
            })
            .await?;
        let remaining = self
            .drain_failed_world_until(hydration.world(), deadline)
            .await;
        if !remaining.is_empty() {
            return Err(LifecycleError::Cleanup {
                cause: Box::new(LifecycleError::Contract(
                    world_protocol::lifecycle::LifecycleFailure::AcquisitionClosed,
                )),
                remaining_resources: remaining
                    .iter()
                    .flat_map(crate::extensions::lifecycle::retained_resources)
                    .collect(),
            }
            .into());
        }
        let recovery = load_recovery(&self.store, hydration.world().clone()).await?;
        let mut required = run_locks.clone();
        required.insert(model_lock.clone());
        required.extend(
            recovery
                .heads
                .iter()
                .map(|head| head.activation_lock_id.clone()),
        );
        let (selected, channels) = select_restore(&recovery, required)?;
        let mut candidates = Vec::with_capacity(selected.len());
        for (graph, channels) in selected {
            match prepare_graph_for_transfer(
                graph,
                channels,
                &recovery,
                inventory,
                &self.live,
                ports,
                cancellation,
                deadline,
                hydration,
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
        Ok(Arc::new(PreparedTransfer {
            hydration: hydration.clone(),
            model_lock,
            run_locks,
            graphs,
            heads: recovery.heads,
            channels,
            candidates: Mutex::new(Some(candidates)),
        }))
    }

    pub(crate) async fn publish_transferred(
        &self,
        hydration: &Arc<TransferHydration>,
        prepared: &Arc<PreparedTransfer>,
        inventory: &Inventory,
    ) -> Result<(), BindingError> {
        let result = async {
            if !prepared.matches_hydration(hydration)
                || self.store.identity_receipt().storage_id() != hydration.storage_id()
            {
                return Err(BindingFailure::LockIdentityConflict.into());
            }
            let _inventory = inventory.lock_transfer_publication().await;
            let hydration = hydration.clone();
            let prepared = prepared.clone();
            let live = self.live.clone();
            let gate = self.gate.clone();
            let heads = self.heads.clone();
            self.store
                .snapshot(prepared.world().clone(), move |snapshot| {
                    Box::pin(async move {
                        hydration.recheck_read(snapshot).await?;
                        recheck_prepared_graphs(
                            snapshot,
                            &prepared.model_lock,
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
                                .expect("world transfer candidates poisoned");
                            if let Some(graphs) = candidates.as_mut() {
                                live.publish_transfer(access, &hydration, graphs, &prepared)?;
                                let mut heads = heads.lock().expect("world binding heads poisoned");
                                heads.retain(|(world, _), _| world != prepared.world());
                                for head in &prepared.heads {
                                    heads.insert(
                                        (head.world.clone(), head.channel.clone()),
                                        head.clone(),
                                    );
                                }
                                *candidates = None;
                            } else if !live.transfer_applied_in(access, &hydration) {
                                return Err(LifecycleError::Retiring.into());
                            }
                            Ok::<_, BindingError>(())
                        })
                    })
                })
                .await
        }
        .await;
        if result.is_err() {
            let candidates = prepared
                .candidates
                .lock()
                .expect("world transfer candidates poisoned")
                .as_mut()
                .map(std::mem::take)
                .unwrap_or_default();
            for candidate in candidates {
                self.reject_candidate(candidate);
            }
        }
        result
    }
}
